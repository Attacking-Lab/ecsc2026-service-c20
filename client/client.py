import argparse
import pprint
from base64 import b64decode, b64encode
from dataclasses import dataclass, field
from secrets import randbelow
from typing import Any

import requests
import zkp_lib
from sealy import (
    BFVEncoder,
    BfvEncryptionParametersBuilder,
    Ciphertext,
    CoefficientModulus,
    Context,
    Decryptor,
    DegreeType,
    Encryptor,
    KeyGenerator,
    PlainModulus,
    Plaintext,
    PublicKey,
    SecretKey,
    SecurityLevel,
)

N = 2048
BINARY_HEADERS = {"Content-Type": "application/octet-stream"}

params = (
    BfvEncryptionParametersBuilder()
    .with_poly_modulus_degree(DegreeType(N))
    .with_plain_modulus(PlainModulus.batching(DegreeType(N), 16))
    .with_coefficient_modulus(CoefficientModulus.bfv(DegreeType(N), SecurityLevel(128)))
    .build()
)
ctx = Context(params, False, SecurityLevel(128))
encoder = BFVEncoder(ctx)
t = params.get_plain_modulus().get_value()


class ServiceError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        payload: dict[str, Any] | list[Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload


def decode_public_keys(info: dict[str, Any]) -> dict[str, Any]:
    if isinstance(info.get("public_key"), str):
        info["public_key"] = b64decode(info["public_key"])
    for player in info.get("players", []):
        if isinstance(player.get("public_key"), str):
            player["public_key"] = b64decode(player["public_key"])
    return info


def decode_message_blobs(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for message in messages:
        if message.get("kind") in {"whisper", "roll_request"} and isinstance(
            message.get("content"), str
        ):
            message["content"] = b64decode(message["content"], validate=True)
    return messages


class C20Client:
    def __init__(self, base_url: str, timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()

    def _request(
        self, method: str, path: str, expected: set[int], **kwargs
    ) -> dict[str, Any] | list[Any]:
        response = self.session.request(
            method,
            f"{self.base_url}{path}",
            timeout=self.timeout,
            **kwargs,
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise ServiceError(
                f"{method} {path}: non-JSON response {response.status_code}"
            ) from exc

        if response.status_code not in expected:
            raise ServiceError(
                f"{method} {path}: {response.status_code} {payload}",
                status=response.status_code,
                payload=payload,
            )
        return payload

    def register(self, public_key: bytes) -> dict[str, Any]:
        return self._request(
            "POST",
            "/register",
            {201},
            data=public_key,
            headers=BINARY_HEADERS,
        )

    def login(self, uid: str, proof: bytes) -> dict[str, Any]:
        return self._request(
            "POST",
            "/login",
            {200},
            params={"uid": uid},
            data=proof,
            headers=BINARY_HEADERS,
        )

    def logout(self) -> dict[str, Any]:
        return self._request("POST", "/logout", {200})

    def list_games(self) -> list[dict[str, Any]]:
        return self._request("GET", "/games", {200})

    def create_game(
        self, name: str, description: str, ciphertext: bytes
    ) -> dict[str, Any]:
        return decode_public_keys(
            self._request(
                "POST",
                "/games",
                {201},
                json={
                    "name": name,
                    "description": description,
                    "ciphertext": b64encode(ciphertext).decode("ascii"),
                },
            )
        )

    def game_info(self, name: str) -> dict[str, Any]:
        return decode_public_keys(self._request("GET", f"/games/{name}", {200}))

    def join_game(self, name: str) -> dict[str, Any]:
        return decode_public_keys(self._request("POST", f"/games/{name}/join", {200}))

    def player_info(self, uid: str) -> dict[str, Any]:
        return decode_public_keys(self._request("GET", f"/player/{uid}", {200}))

    def player_public_key(self, uid: str) -> bytes:
        return self.player_info(uid)["public_key"]

    def post_note(self, game: str, note: str) -> dict[str, Any]:
        return self._request("POST", f"/games/{game}/note", {201}, json={"note": note})

    def broadcast(self, game: str, text: str) -> dict[str, Any]:
        return self._request(
            "POST", f"/games/{game}/broadcast", {201}, json={"text": text}
        )

    def whisper(
        self,
        game: str,
        ciphertext: bytes,
        recipient_uid: str,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/games/{game}/whisper",
            {201},
            params={"recipient_uid": recipient_uid},
            data=ciphertext,
            headers=BINARY_HEADERS,
        )

    def listen_to_whispers(
        self,
        game: str,
        start: int | None = None,
        end: int | None = None,
    ) -> list[dict[str, Any]]:
        params = {}
        if start is not None:
            params["start"] = start
        if end is not None:
            params["end"] = end
        return decode_message_blobs(
            self._request("GET", f"/games/{game}/whispers", {200}, params=params)
        )

    def roll(self, game: str, ciphertext: bytes) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/games/{game}/roll",
            {201},
            data=ciphertext,
            headers=BINARY_HEADERS,
        )

    def roll_requests(
        self, game: str, include_resolved: bool = False
    ) -> list[dict[str, Any]]:
        return decode_message_blobs(
            self._request(
                "GET",
                f"/games/{game}/rolls",
                {200},
                params={"include_resolved": "1" if include_resolved else "0"},
            )
        )

    def resolve_roll(
        self, game: str, request_id: int, plaintext: bytes
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/games/{game}/rolls/{request_id}/resolve",
            {200},
            data=plaintext,
            headers=BINARY_HEADERS,
        )

    def set_afk(
        self,
        game: str,
        enabled: bool,
        private_key: bytes | None = None,
        rejoin_token: bytes | None = None,
    ) -> dict[str, Any]:
        body = private_key if enabled else rejoin_token
        if not body:
            required = "private key" if enabled else "rejoin token"
            raise ServiceError(f"AFK mode requires a non-empty {required}")
        result = self._request(
            "POST",
            f"/games/{game}/afk",
            {200},
            params={"enabled": "1" if enabled else "0"},
            data=body,
            headers=BINARY_HEADERS,
        )
        if not isinstance(result, dict):
            raise ServiceError("invalid AFK response")
        if isinstance(result.get("rejoin_token"), str):
            result["rejoin_token"] = b64decode(result["rejoin_token"], validate=True)
        return result


@dataclass
class DemoPlayer:
    name: str
    uid: str
    public_key: bytes
    private_key: bytes
    proof: bytes


@dataclass
class ClientState:
    players: dict[str, DemoPlayer] = field(default_factory=dict)
    afk_tokens: dict[str, bytes] = field(default_factory=dict)
    current_player: str | None = None
    game: str | None = None

    def current(self) -> DemoPlayer:
        if self.current_player is None:
            raise ServiceError("no player is logged in through the client state")
        return self.players[self.current_player]


def gen_proof(public_key: bytes, private_key: bytes) -> bytes:
    return zkp_lib.prove(public_key, private_key)


def generate_keypair() -> tuple[bytes, bytes]:
    keygen = KeyGenerator(ctx)
    public_key = keygen.create_public_key()
    private_key = keygen.secret_key()
    return bytes(public_key.as_bytes()), bytes(private_key.as_bytes())


def encode_values(values: list[int]) -> bytes:
    if len(values) > N:
        raise ValueError("too many plaintext slots")
    padded = values + [0] * (N - len(values))
    return bytes(encoder.encode_int(padded).as_bytes())


def decode_pt(plaintext: bytes) -> list[int]:
    return encoder.decode_int(Plaintext.from_bytes(ctx, plaintext))


def encrypt_pt(public_key_bytes: bytes, plaintext_bytes: bytes) -> bytes:
    public_key = PublicKey.from_bytes(ctx, public_key_bytes)
    plaintext = Plaintext.from_bytes(ctx, plaintext_bytes)
    encryptor = Encryptor(ctx, public_key)
    return bytes(encryptor.encrypt(plaintext).as_bytes())


def encrypt_values(public_key: bytes, values: list[int]) -> bytes:
    return encrypt_pt(public_key, encode_values(values))


def decrypt_to_pt(private_key_bytes: bytes, ciphertext_bytes: bytes) -> bytes:
    private_key = SecretKey.from_bytes(ctx, private_key_bytes)
    ciphertext = Ciphertext.from_bytes(ctx, ciphertext_bytes)
    decryptor = Decryptor(ctx, private_key)
    return bytes(decryptor.decrypt(ciphertext).as_bytes())


def decrypt_values(private_key: bytes, ciphertext: bytes) -> list[int]:
    return decode_pt(decrypt_to_pt(private_key, ciphertext))


def assert_prefix(label: str, actual: list[int], expected: list[int]) -> None:
    if actual[: len(expected)] != expected:
        raise ServiceError(
            f"{label}: expected prefix {expected}, got {actual[: len(expected)]}"
        )


def compact(value: Any, max_string: int = 96) -> Any:
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, str):
        if len(value) > max_string:
            return f"{value[:max_string]}...({len(value)} chars)"
        return value
    if isinstance(value, list):
        return [compact(item, max_string) for item in value]
    if isinstance(value, tuple):
        return tuple(compact(item, max_string) for item in value)
    if isinstance(value, dict):
        return {key: compact(item, max_string) for key, item in value.items()}
    return value


def print_result(label: str, value: Any) -> None:
    print(f"\n[{label}]")
    pprint.pp(compact(value))


def register_player(client: C20Client, state: ClientState, name: str) -> DemoPlayer:
    public_key, private_key = generate_keypair()
    proof = gen_proof(public_key, private_key)
    payload = client.register(public_key)
    player = DemoPlayer(
        name=name,
        uid=payload["uid"],
        public_key=public_key,
        private_key=private_key,
        proof=proof,
    )
    state.players[name] = player
    return player


def login_player(client: C20Client, state: ClientState, name: str) -> DemoPlayer:
    player = state.players[name]
    client.login(player.uid, player.proof)
    state.current_player = name
    return player


def latest_whisper_from(
    messages: list[dict[str, Any]], sender_uid: str
) -> dict[str, Any]:
    for message in reversed(messages):
        if message["sender"] == sender_uid:
            return message
    raise ServiceError(f"no whisper from {sender_uid}")


def game_owner(info: dict[str, Any]) -> dict[str, Any]:
    owner_uid = info["owner"]
    for player in info.get("players", []):
        if player["uid"] == owner_uid:
            return player
    raise ServiceError(f"game owner {owner_uid} is missing from the player list")


def pick_game_player(info: dict[str, Any]) -> dict[str, Any]:
    players = info.get("players", [])
    if not players:
        raise ServiceError("the game has no players")
    labels = [
        f"{player['uid']}{' (owner)' if player['uid'] == info['owner'] else ''}"
        for player in players
    ]
    return players[prompt_choice("Pick game member", labels)]


def decode_public_broadcast_plaintext(
    info: dict[str, Any], request_id: int
) -> list[int]:
    marker = f"roll {request_id} "
    for message in reversed(info["history"]):
        if message["content"].startswith(marker):
            plaintext = b64decode(message["content"].split(": ", 1)[1], validate=True)
            return decode_pt(plaintext)
    raise ServiceError(f"no broadcast result for roll {request_id}")


def random_roll_values() -> list[int]:
    return [randbelow(t - 1) + 1 for _ in range(N)]


def resolve_pending_rolls(
    client: C20Client, state: ClientState, game: str
) -> list[dict[str, Any]]:
    owner_uid = game_owner(client.game_info(game))["uid"]
    owner_entry = next(
        (
            (name, player)
            for name, player in state.players.items()
            if player.uid == owner_uid
        ),
        None,
    )
    if owner_entry is None:
        raise ServiceError(f"game owner {owner_uid} is not registered in this client")
    owner_name, owner = owner_entry
    login_player(client, state, owner_name)
    requests_ = client.roll_requests(game)
    resolved = []
    for request_ in requests_:
        plaintext = decrypt_to_pt(owner.private_key, request_["content"])
        resolved.append(client.resolve_roll(game, int(request_["id"]), plaintext))
    return resolved


def run_demo(client: C20Client) -> None:
    state = ClientState()
    public_client = C20Client(client.base_url, client.timeout)

    dm = register_player(client, state, "dm")
    alice = register_player(client, state, "alice")
    bob = register_player(client, state, "bob")
    print_result(
        "registered players",
        {name: player.uid for name, player in state.players.items()},
    )

    try:
        client.login(alice.uid, bob.proof)
    except ServiceError as exc:
        if (
            exc.status != 401
            or not isinstance(exc.payload, dict)
            or exc.payload.get("error") != "Invalid credentials"
        ):
            raise
        print_result("mismatched login proof rejected", str(exc))
    else:
        raise ServiceError("login unexpectedly accepted another player's proof")

    login_player(client, state, "dm")
    game = f"demo-{dm.uid[:8]}"
    c2 = encrypt_values(dm.public_key, random_roll_values())
    created = client.create_game(game, "A small cryptographic dungeon crawl", c2)
    state.game = game
    print_result(
        "create game",
        created,
    )
    print_result("public list games", public_client.list_games())
    print_result("public game info", public_client.game_info(game))

    login_player(client, state, "alice")
    print_result("alice join", client.join_game(game))
    print_result("alice note", client.post_note(game, "Watch the west door."))
    try:
        client.post_note(game, "Move watch to the east door.")
    except ServiceError as exc:
        if (
            exc.status != 409
            or not isinstance(exc.payload, dict)
            or exc.payload.get("error") != "Private note already posted"
        ):
            raise
        print_result("alice second note rejected", str(exc))
    else:
        raise ServiceError("second note post unexpectedly succeeded")
    stored_note = client.game_info(game).get("private_note")
    if stored_note != "Watch the west door.":
        raise ServiceError("private note did not round-trip through game info")
    print_result("alice broadcast", client.broadcast(game, "Alice lights a torch."))
    print_result("alice player info", client.player_info(alice.uid))

    login_player(client, state, "bob")
    print_result("bob join", client.join_game(game))
    game_info = client.game_info(game)

    login_player(client, state, "alice")
    bob_pk = client.player_public_key(bob.uid)
    alice_to_bob = [42, 7, 5]
    ct_for_bob = encrypt_values(bob_pk, alice_to_bob)
    print_result(
        "alice whispers bob", client.whisper(game, ct_for_bob, recipient_uid=bob.uid)
    )

    login_player(client, state, "bob")
    bob_whispers = client.listen_to_whispers(game, start=0, end=1)
    bob_secret = latest_whisper_from(bob_whispers, alice.uid)
    assert_prefix(
        "bob decrypts alice whisper",
        decrypt_values(bob.private_key, bob_secret["content"]),
        alice_to_bob,
    )
    print_result("bob listens", {"decrypted_latest_from_alice": alice_to_bob})

    login_player(client, state, "alice")
    values = [7, 8, 9]
    owner_public_key = game_owner(game_info)["public_key"]
    c0 = encrypt_values(owner_public_key, values)
    roll = client.roll(game, c0)
    print_result("alice contributes a roll", roll)
    print_result("dm resolves roll", resolve_pending_rolls(client, state, game))
    public_result = decode_public_broadcast_plaintext(
        client.game_info(game), int(roll["id"])
    )
    print_result("published roll", public_result[:8])

    login_player(client, state, "dm")
    afk_on = client.set_afk(game, True, private_key=dm.private_key)
    state.afk_tokens[game] = afk_on["rejoin_token"]
    print_result(
        "dm afk on",
        {key: value for key, value in afk_on.items() if key != "rejoin_token"},
    )
    try:
        client.set_afk(game, True, private_key=dm.private_key)
    except ServiceError as exc:
        if (
            exc.status != 409
            or not isinstance(exc.payload, dict)
            or exc.payload.get("error") != "AFK mode is already enabled"
        ):
            raise
        print_result("duplicate AFK activation rejected", str(exc))
    else:
        raise ServiceError("duplicate AFK activation unexpectedly succeeded")

    login_player(client, state, "alice")
    afk_values = [5, 6]
    afk_c0 = encrypt_values(owner_public_key, afk_values)
    afk_roll = client.roll(game, afk_c0)
    print_result("alice rolls while dm is afk", afk_roll)
    afk_result = decode_public_broadcast_plaintext(
        client.game_info(game), int(afk_roll["id"])
    )
    print_result("published afk roll", afk_result[:8])

    login_player(client, state, "dm")
    print_result(
        "dm afk off",
        client.set_afk(game, False, rejoin_token=state.afk_tokens.pop(game)),
    )
    print_result("final rich game info", client.game_info(game))
    print("\nDemo completed successfully.")


def prompt_choice(title: str, choices: list[str]) -> int:
    print(f"\n{title}")
    for idx, choice in enumerate(choices, start=1):
        print(f"  {idx}. {choice}")
    while True:
        raw = input("> ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(choices):
            return int(raw) - 1
        print("Choose one of the listed numbers.")


def pick_player(state: ClientState) -> str:
    names = list(state.players)
    if not names:
        raise ServiceError("no players registered yet")
    return names[prompt_choice("Pick player", names)]


def tui(client: C20Client) -> None:
    state = ClientState()
    actions = [
        "Run full demo",
        "Register player",
        "Login as player",
        "Create game",
        "Join game",
        "Game info",
        "Player info",
        "Post note",
        "Broadcast",
        "Whisper preset vector",
        "Listen to whispers",
        "Contribute roll",
        "Owner resolve pending rolls",
        "Toggle AFK",
        "Logout",
        "Quit",
    ]

    while True:
        current = state.current_player or "none"
        print(f"\nCurrent login: {current}")
        try:
            action = actions[prompt_choice("Action", actions)]
            if action == "Run full demo":
                run_demo(client)
            elif action == "Register player":
                name = (
                    input("Player label> ").strip() or f"player{len(state.players) + 1}"
                )
                player = register_player(client, state, name)
                print_result("registered", player)
            elif action == "Login as player":
                player = login_player(client, state, pick_player(state))
                print_result("logged in", {"name": player.name, "uid": player.uid})
            elif action == "Create game":
                name = input("Game name> ").strip()
                owner = state.current()
                c2 = encrypt_values(owner.public_key, random_roll_values())
                created = client.create_game(name, "Client-created game", c2)
                state.game = name
                print_result("created", created)
            elif action == "Join game":
                game = input("Game name> ").strip() or state.game
                if not game:
                    raise ServiceError("a game name is required")
                joined = client.join_game(game)
                state.game = game
                print_result("joined", joined)
            elif action == "Game info":
                game = input("Game name> ").strip() or state.game
                print_result("game_info", client.game_info(game))
            elif action == "Player info":
                player = state.players[pick_player(state)]
                print_result("player_info", client.player_info(player.uid))
            elif action == "Post note":
                game = input("Game name> ").strip() or state.game
                note = input("Note> ")
                print_result("note", client.post_note(game, note))
            elif action == "Broadcast":
                game = input("Game name> ").strip() or state.game
                text = input("Text> ")
                print_result("broadcast", client.broadcast(game, text))
            elif action == "Whisper preset vector":
                game = input("Game name> ").strip() or state.game
                if not game:
                    raise ServiceError("a game name is required")
                values = [1, 2, 3]
                recipient = pick_game_player(client.game_info(game))
                print_result(
                    "whisper",
                    client.whisper(
                        game,
                        encrypt_values(recipient["public_key"], values),
                        recipient_uid=recipient["uid"],
                    ),
                )
            elif action == "Listen to whispers":
                game = input("Game name> ").strip() or state.game
                messages = client.listen_to_whispers(game)
                print_result("whispers", messages)
            elif action == "Contribute roll":
                game = input("Game name> ").strip() or state.game
                info = client.game_info(game)
                owner = game_owner(info)
                ciphertext = encrypt_values(owner["public_key"], random_roll_values())
                print_result("roll", client.roll(game, ciphertext))
            elif action == "Owner resolve pending rolls":
                game = input("Game name> ").strip() or state.game
                print_result("resolved", resolve_pending_rolls(client, state, game))
            elif action == "Toggle AFK":
                game = input("Game name> ").strip() or state.game
                enabled = input("Enable AFK? [y/N]> ").strip().lower() == "y"
                current = state.current()
                if enabled:
                    owner_uid = client.game_info(game)["owner"]
                    if current.uid != owner_uid:
                        raise ServiceError("only the game owner can enable AFK mode")
                    result = client.set_afk(game, True, private_key=current.private_key)
                    state.afk_tokens[game] = result["rejoin_token"]
                else:
                    token = state.afk_tokens.get(game)
                    if token is None:
                        raise ServiceError("no rejoin token stored for this game")
                    result = client.set_afk(game, False, rejoin_token=token)
                    del state.afk_tokens[game]
                print_result(
                    "afk",
                    {
                        key: value
                        for key, value in result.items()
                        if key != "rejoin_token"
                    },
                )
            elif action == "Logout":
                print_result("logout", client.logout())
                state.current_player = None
            else:
                break
        except (
            ServiceError,
            requests.RequestException,
            KeyError,
            ValueError,
            StopIteration,
        ) as exc:
            print_result("error", exc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Interactive client for the C20 DND service"
    )
    parser.add_argument(
        "--url",
        default="http://localhost:9000/c20",
        help="game API base URL (the published service uses the /c20 proxy)",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="run a full noninteractive functionality demo",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    client = C20Client(args.url)
    if args.demo:
        run_demo(client)
    else:
        tui(client)


if __name__ == "__main__":
    main()
