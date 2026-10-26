from base64 import b64decode, b64encode
from functools import lru_cache, wraps
import re
import secrets

from flask import jsonify, request, session
from sqlalchemy import func
from sqlalchemy.orm import load_only

from .database import Game, GamePlayer, Message, Player, app, db

from . import zkp_lib
from .fhe import configure_key_store, decrypt, evaluate_ciphertext


GAME_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
MAX_TEXT = 4096


class DatabaseKeyStore:
    def get_public_key(self, uid):
        return _public_key(uid)

    def get_secret_key(self, uid):
        player = db.session.get(Player, uid)
        return bytes(player.private_key)


configure_key_store(DatabaseKeyStore())


@lru_cache(maxsize=128)
def _public_key(uid):
    value = db.session.execute(
        db.select(Player.public_key).where(Player.uid == uid)
    ).scalar_one()
    return bytes(value)


def _verify_proof(public_key, credential):
    try:
        return bool(zkp_lib.verify(public_key, credential))
    except Exception:
        return False


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if "uid" not in session:
            return jsonify({"error": "Authentication required"}), 401
        return f(*args, **kwargs)

    return decorated_function


def _membership(game_name, uid):
    return GamePlayer.query.filter_by(game_name=game_name, uid=uid).first()


def _require_game_member(game_name):
    game = db.session.get(Game, game_name)
    if game is None:
        return None, None, (jsonify({"error": "Game not found"}), 404)

    member = _membership(game.name, session.get("uid"))
    if member is None:
        return game, None, (jsonify({"error": "You are not part of this game"}), 403)

    return game, member, None


def _require_game_owner(game_name):
    game, member, error = _require_game_member(game_name)
    if error is not None:
        return game, member, error
    if game.owner_uid != session.get("uid"):
        return (
            game,
            member,
            (jsonify({"error": "Only the game owner can do this"}), 403),
        )
    return game, member, None


def _player_ref(uid):
    player = db.session.get(Player, uid)
    return {
        "uid": uid,
        "public_key": b64encode(bytes(player.public_key)).decode("ascii")
        if player is not None
        else None,
    }


def _encode_blob(value):
    return b64encode(value).decode("ascii")


def _decode_blob(value):
    if not isinstance(value, str):
        raise ValueError("expected base64 string")
    return b64decode(value, validate=True)


def _text_field_error(value, name):
    if not isinstance(value, str) or value == "":
        return jsonify({"error": f"{name} must be a non-empty string"}), 400
    if len(value) > MAX_TEXT:
        return jsonify({"error": f"{name} must be at most {MAX_TEXT} characters"}), 400
    return None


def _message_dict(message, include_content=True):
    out = {
        "id": message.id,
        "game": message.game_name,
        "sender": message.sender_uid,
        "recipient": message.recipient_uid,
        "kind": message.kind,
        "resolved": message.resolved,
        "timestamp": message.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
    }
    if include_content:
        out["content"] = message.content
    return out


def _public_game_info(game):
    player_count = db.session.execute(
        db.select(func.count(GamePlayer.id)).where(GamePlayer.game_name == game.name)
    ).scalar_one()
    owner = _player_ref(game.owner_uid)
    return {
        "name": game.name,
        "description": game.description,
        "owner": game.owner_uid,
        "owner_public_key": owner["public_key"],
        "owner_afk": game.owner_afk,
        "player_count": player_count,
    }


def _game_players_query(game_name):
    return (
        db.session.query(GamePlayer.uid, Player.public_key)
        .join(Player, Player.uid == GamePlayer.uid)
        .filter(GamePlayer.game_name == game_name)
        .order_by(GamePlayer.timestamp.asc(), GamePlayer.id.asc())
    )


def _slice_query(query, start=None, end=None):
    if start is None and end is None:
        return query.all()
    # Ordinary non-negative slices map directly to LIMIT/OFFSET. Only Python's
    # negative-index semantics require the otherwise expensive COUNT(*).
    if (start is None or start >= 0) and (end is None or end >= 0):
        offset = start or 0
        if end is not None and end <= offset:
            return []
        limited = query.offset(offset)
        return limited.limit(end - offset).all() if end is not None else limited.all()
    start, end, _ = slice(start, end).indices(query.order_by(None).count())
    return query.offset(start).limit(max(0, end - start)).all()


def _rich_game_info(game, member, start=None, end=None):
    info = _public_game_info(game)
    history = _slice_query(
        Message.query.filter_by(game_name=game.name, kind="broadcast")
        .order_by(Message.id.asc()),
        start,
        end,
    )
    counts = dict(
        db.session.query(Message.sender_uid, func.count(Message.id))
        .filter_by(
            game_name=game.name, recipient_uid=session.get("uid"), kind="whisper"
        )
        .group_by(Message.sender_uid)
        .all()
    )

    info.update(
        {
            "private_note": member.private_note,
            "history": [_message_dict(message) for message in history],
            "whisper_counts": [
                {"sender": sender, "count": count}
                for sender, count in sorted(
                    counts.items(), key=lambda item: item[0] or ""
                )
            ],
        }
    )
    return info


def _add_message(game, sender_uid, kind, content, *, recipient_uid=None, resolved=True):
    message = Message(
        game_name=game.name,
        sender_uid=sender_uid,
        recipient_uid=recipient_uid,
        kind=kind,
        content=content,
        resolved=resolved,
    )
    db.session.add(message)
    db.session.flush()
    return message


def _add_broadcast(game, sender_uid, text):
    return _add_message(game, sender_uid, "broadcast", text)


def _add_whisper(game, sender_uid, recipient_uid, ciphertext):
    return _add_message(
        game,
        sender_uid,
        "whisper",
        _encode_blob(ciphertext),
        recipient_uid=recipient_uid,
    )


def _add_roll_request(game, sender_uid, ciphertext):
    return _add_message(
        game,
        sender_uid,
        "roll_request",
        _encode_blob(ciphertext),
        recipient_uid=game.owner_uid,
        resolved=False,
    )


def _resolve_request(game, request_message, plaintext, resolver_uid):
    if request_message.resolved:
        raise ValueError("request is already resolved")

    request_message.resolved = True
    return _add_broadcast(
        game,
        resolver_uid,
        f"roll {request_message.id} from {request_message.sender_uid}: {_encode_blob(plaintext)}",
    )


def _afk_resolve_request(game, request_message):
    plaintext = decrypt(game.owner_uid, _decode_blob(request_message.content))
    return _resolve_request(game, request_message, plaintext, game.owner_uid)


def _maybe_afk_resolve(game, request_message):
    if not game.owner_afk:
        return None
    owner = db.session.get(Player, game.owner_uid)
    if owner is None or owner.private_key is None:
        return None
    return _afk_resolve_request(game, request_message)


def _pagination_args():
    start_arg = request.args.get("start")
    end_arg = request.args.get("end")
    start = int(start_arg) if start_arg is not None else None
    end = int(end_arg) if end_arg is not None else None
    return start, end


def _paginate(query):
    return _slice_query(query, *_pagination_args())


@app.route("/register", methods=["POST"])
def register():
    public_key = request.get_data(cache=False)
    if not public_key:
        return jsonify({"error": "Public key is required"}), 400

    uid = secrets.token_hex(16)
    player = Player(uid=uid, public_key=public_key)
    db.session.add(player)
    db.session.commit()
    session["uid"] = uid
    return jsonify({"message": "Player registered successfully", "uid": uid}), 201


@app.route("/login", methods=["POST"])
def login():
    uid = request.args.get("uid", "")
    credential = request.get_data(cache=False)
    if re.fullmatch(r"[0-9a-f]{32}", uid) is None:
        return jsonify({"error": "Invalid credentials"}), 401

    player = db.session.get(Player, uid)
    if player is None:
        return jsonify({"error": "Invalid credentials"}), 401

    valid = _verify_proof(bytes(player.public_key), credential)

    if not valid:
        return jsonify({"error": "Invalid credentials"}), 401

    session["uid"] = player.uid
    return jsonify({"message": "Logged in successfully", "uid": player.uid}), 200


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.pop("uid", None)
    return jsonify({"message": "Logged out successfully"}), 200


@app.route("/games", methods=["GET"])
def list_games():
    try:
        games = _paginate(Game.query.order_by(Game.timestamp.asc()))
    except ValueError:
        return jsonify({"error": "start and end must be integers"}), 400
    player_counts = dict(
        db.session.query(GamePlayer.game_name, func.count(GamePlayer.id))
        .filter(GamePlayer.game_name.in_([game.name for game in games]))
        .group_by(GamePlayer.game_name)
        .all()
    )
    out = [
        {
            "name": game.name,
            "description": game.description,
            "owner": game.owner_uid,
            "player_count": player_counts.get(game.name, 0),
        }
        for game in games
    ]
    return jsonify(out), 200


@app.route("/games", methods=["POST"])
@login_required
def create_game():
    data = request.get_json()
    name = data.get("name")
    description = data.get("description")
    ciphertext = data.get("ciphertext")
    uid = session.get("uid")

    if not GAME_NAME_RE.fullmatch(name):
        return jsonify(
            {"error": "Game name may contain letters, digits, underscore, dot and dash"}
        ), 400
    error = _text_field_error(description, "description")
    if error is not None:
        return error
    if db.session.get(Game, name) is not None:
        return jsonify({"error": "Game already exists"}), 409
    try:
        roll_ciphertext = _decode_blob(ciphertext)
    except (TypeError, ValueError):
        return jsonify({"error": "A valid initial roll ciphertext is required"}), 400
    if not roll_ciphertext:
        return jsonify({"error": "A valid initial roll ciphertext is required"}), 400

    game = Game(
        name=name,
        description=description,
        owner_uid=uid,
        roll_ciphertext=roll_ciphertext,
    )
    db.session.add(game)
    db.session.flush()
    db.session.add(GamePlayer(game_name=game.name, uid=uid))
    _add_broadcast(game, uid, f"{uid} created the game")
    db.session.commit()
    return jsonify(_rich_game_info(game, _membership(game.name, uid))), 201


@app.route("/games/<game_name>", methods=["GET"])
def game_info(game_name):
    game = db.session.get(Game, game_name)
    if game is None:
        return jsonify({"error": "Game not found"}), 404

    uid = session.get("uid")
    member = _membership(game.name, uid) if uid else None
    try:
        start, end = _pagination_args()
    except ValueError:
        return jsonify({"error": "start and end must be integers"}), 400
    info = (
        _rich_game_info(game, member, start, end)
        if member
        else _public_game_info(game)
    )
    return jsonify(info), 200


@app.route("/games/<game_name>/players", methods=["GET"])
def game_players(game_name):
    game = db.session.get(Game, game_name)
    if game is None:
        return jsonify({"error": "Game not found"}), 404

    try:
        players = _paginate(_game_players_query(game.name))
    except ValueError:
        return jsonify({"error": "start and end must be integers"}), 400
    return jsonify(
        [
            {
                "uid": uid,
                "public_key": b64encode(bytes(public_key)).decode("ascii"),
            }
            for uid, public_key in players
        ]
    ), 200


@app.route("/games/<game_name>/join", methods=["POST"])
@login_required
def join_game(game_name):
    game = db.session.get(Game, game_name)
    if game is None:
        return jsonify({"error": "Game not found"}), 404
    uid = session.get("uid")
    if _membership(game.name, uid) is not None:
        return jsonify({"message": "Already in game"}), 200

    db.session.add(GamePlayer(game_name=game.name, uid=uid))
    _add_broadcast(game, uid, f"{uid} joined the game")
    db.session.commit()
    return jsonify(
        _rich_game_info(game, _membership(game.name, uid), start=-1)
    ), 200


@app.route("/player/<uid>", methods=["GET"])
def player_info(uid):
    player = db.session.get(Player, uid)
    if player is None:
        return jsonify({"error": "Player not found"}), 404
    games = (
        GamePlayer.query.filter_by(uid=player.uid)
        .options(load_only(GamePlayer.game_name, GamePlayer.timestamp))
        .order_by(GamePlayer.timestamp.asc())
        .all()
    )
    out = {
        "uid": player.uid,
        "public_key": b64encode(bytes(player.public_key)).decode("ascii"),
        "games": [membership.game_name for membership in games],
    }

    return jsonify(out), 200


@app.route("/games/<game_name>/note", methods=["POST"])
@login_required
def post_note(game_name):
    _, member, error = _require_game_member(game_name)
    if error is not None:
        return error

    if member.private_note:
        return jsonify({"error": "Private note already posted"}), 409

    data = request.get_json(silent=True) or {}
    note = data.get("note")
    error = _text_field_error(note, "note")
    if error is not None:
        return error

    member.private_note = note
    db.session.commit()
    return jsonify({"message": "Note posted", "private_note": member.private_note}), 201


@app.route("/games/<game_name>/broadcast", methods=["POST"])
@login_required
def broadcast(game_name):
    game, _, error = _require_game_member(game_name)
    if error is not None:
        return error
    data = request.get_json(silent=True) or {}
    text = data.get("text")
    error = _text_field_error(text, "text")
    if error is not None:
        return error
    message = _add_broadcast(game, session.get("uid"), text)
    db.session.commit()
    return jsonify(_message_dict(message)), 201


@app.route("/games/<game_name>/whisper", methods=["POST"])
@login_required
def whisper(game_name):
    game, _, error = _require_game_member(game_name)
    if error is not None:
        return error

    uid = session.get("uid")
    try:
        ciphertext = request.get_data(cache=False)
        if not ciphertext:
            raise ValueError("Ciphertext is required")
        recipient_uid = request.args.get("recipient_uid")
        recipient = db.session.get(Player, recipient_uid)
        if recipient is None or _membership(game.name, recipient.uid) is None:
            return jsonify({"error": "Recipient is not in this game"}), 404
        message = _add_whisper(game, uid, recipient.uid, ciphertext)
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not process encrypted whisper"}), 400

    return jsonify(_message_dict(message, include_content=False)), 201


@app.route("/games/<game_name>/whispers", methods=["GET"])
@login_required
def listen_to_whispers(game_name):
    game, _, error = _require_game_member(game_name)
    if error is not None:
        return error

    query = Message.query.filter_by(
        game_name=game.name, recipient_uid=session.get("uid"), kind="whisper"
    ).order_by(Message.timestamp.asc(), Message.id.asc())
    try:
        messages = _paginate(query)
    except ValueError:
        return jsonify({"error": "start and end must be integers"}), 400
    return jsonify([_message_dict(message) for message in messages]), 200


@app.route("/games/<game_name>/roll", methods=["POST"])
@login_required
def roll(game_name):
    game, _, error = _require_game_member(game_name)
    if error is not None:
        return error

    try:
        ciphertext = request.get_data(cache=False)
        if not ciphertext:
            raise ValueError("Ciphertext is required")
        evaluated = evaluate_ciphertext(ciphertext, bytes(game.roll_ciphertext))
        request_message = _add_roll_request(game, session.get("uid"), evaluated)
        result_message = _maybe_afk_resolve(game, request_message)
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not process roll"}), 400

    out = _message_dict(request_message, include_content=False)
    out["resolved_immediately"] = result_message is not None
    if result_message is not None:
        out["result_message"] = _message_dict(result_message)
    return jsonify(out), 201


@app.route("/games/<game_name>/rolls", methods=["GET"])
@login_required
def roll_requests(game_name):
    game, _, error = _require_game_owner(game_name)
    if error is not None:
        return error

    include_resolved = request.args.get("include_resolved", "0") in {"1", "true", "yes"}
    query = Message.query.filter_by(game_name=game.name, kind="roll_request")
    if not include_resolved:
        query = query.filter_by(resolved=False)
    messages = query.order_by(Message.id.asc()).all()
    return jsonify([_message_dict(message) for message in messages]), 200


@app.route("/games/<game_name>/rolls/<int:request_id>/resolve", methods=["POST"])
@login_required
def resolve_roll_request(game_name, request_id):
    game, _, error = _require_game_owner(game_name)
    if error is not None:
        return error

    request_message = Message.query.filter_by(
        id=request_id,
        game_name=game.name,
        kind="roll_request",
    ).first()
    if request_message is None:
        return jsonify({"error": "Roll request not found"}), 404

    try:
        plaintext = request.get_data(cache=False)
        if not plaintext:
            raise ValueError("Plaintext is required")
        result_message = _resolve_request(
            game, request_message, plaintext, session.get("uid")
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    db.session.commit()
    return jsonify(
        {
            "request": _message_dict(request_message),
            "result": _message_dict(result_message),
        }
    ), 200


@app.route("/games/<game_name>/afk", methods=["POST"])
@login_required
def afk_mode(game_name):
    game, _, error = _require_game_owner(game_name)
    if error is not None:
        return error

    enabled = request.args.get("enabled", "0") in {"1", "true", "yes"}
    owner = db.session.get(Player, game.owner_uid)
    resolved = []
    failed = []

    if enabled:
        if game.owner_afk:
            return jsonify({"error": "AFK mode is already enabled"}), 409
        private_key = request.get_data(cache=False)
        if not private_key:
            return jsonify({"error": "Private key is required"}), 400
        owner.private_key = private_key
        game.owner_afk = True
        game.afk_token = secrets.token_bytes(32)
        pending = (
            Message.query.filter_by(
                game_name=game.name, kind="roll_request", resolved=False
            )
            .order_by(Message.id.asc())
            .all()
        )
        for request_message in pending:
            try:
                result_message = _afk_resolve_request(game, request_message)
                resolved.append(
                    {"request_id": request_message.id, "result_id": result_message.id}
                )
            except Exception:
                failed.append({"request_id": request_message.id})
    else:
        if not game.owner_afk:
            return jsonify({"error": "AFK mode is not enabled"}), 409
        afk_token = request.get_data(cache=False)
        if (
            not afk_token
            or game.afk_token is None
            or not secrets.compare_digest(afk_token, bytes(game.afk_token))
        ):
            return jsonify({"error": "Invalid rejoin token"}), 403
        game.owner_afk = False
        game.afk_token = None
        other_afk_game = Game.query.filter(
            Game.owner_uid == game.owner_uid,
            Game.name != game.name,
            Game.owner_afk.is_(True),
        ).first()
        if other_afk_game is None:
            owner.private_key = None

    db.session.commit()
    out = {"owner_afk": game.owner_afk, "resolved": resolved, "failed": failed}
    if enabled:
        out["rejoin_token"] = _encode_blob(bytes(game.afk_token))
    return jsonify(out), 200


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200
