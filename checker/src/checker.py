import asyncio
from base64 import b64decode, b64encode
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from functools import wraps
from hashlib import sha256
from logging import LoggerAdapter
from multiprocessing import get_context
from os import environ, getpid
from random import Random
from re import fullmatch
from secrets import randbelow, token_hex

import zkp_lib
from enochecker3 import (
    ChainDB,
    CheckerTaskMessage,
    DependencyInjector,
    Enochecker,
    ExploitCheckerTaskMessage,
    GetflagCheckerTaskMessage,
    GetnoiseCheckerTaskMessage,
    HavocCheckerTaskMessage,
    MumbleException,
    PutflagCheckerTaskMessage,
    PutnoiseCheckerTaskMessage,
    TaskMetadata,
)
from enochecker3.flows import record_http_flows
from enochecker3.telemetry import instrument_httpx_without_propagation
from enochecker3.utils import FlagSearcher, assert_equals, assert_in
from httpx import AsyncClient
from sealy import *

from fhe_exploit import exploit_fhe as recover_fhe_key
from string_generator import random_safe, random_string
from zkp_exploits import (
    zkp_forge_fq2_sumcheck_degree_hoist,
    zkp_forge_fq2_sumcheck_degree_truncate,
    zkp_forge_fq2_sumcheck_degree_wrap,
    zkp_forge_fq_sumcheck_rounds,
    zkp_forge_merkle_index_count,
)

checker_port = int(environ.get("CHECKER_PORT", "8000"))
service_port = int(environ.get("SERVICE_PORT", "9000"))

checker = Enochecker("C20", service_port)

_crypto_executor = None
_crypto_executor_pid = None


def _get_crypto_executor():
    """Return one post-fork CPU worker without blocking the ASGI event loop."""
    global _crypto_executor, _crypto_executor_pid
    pid = getpid()
    if _crypto_executor is None or _crypto_executor_pid != pid:
        _crypto_executor = ProcessPoolExecutor(
            max_workers=int(environ.get("CRYPTO_EXECUTOR_PROCESSES", "1")),
            mp_context=get_context("spawn"),
        )
        _crypto_executor_pid = pid
    return _crypto_executor


async def _run_cpu(function, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_get_crypto_executor(), function, *args)


def app():
    return checker.app


# The service exposes only the frontend, which reverse-proxies the game service
# under /c20. The built-in AsyncClient injector cannot be wrapped to add that
# prefix -- httpx refuses a client whose context is entered twice -- so this
# mirrors it, instrumentation included.
@checker.register_named_dependency("client")
def get_service_client(task: CheckerTaskMessage, metadata: TaskMetadata) -> AsyncClient:
    client = AsyncClient(
        base_url=f"http://{task.address}:{service_port}/c20", verify=False
    )
    instrument_httpx_without_propagation(client)
    record_http_flows(client, metadata)
    return client


############################################################
# params
############################################################

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
evaluator = BFVEvaluator(ctx)
t = params.get_plain_modulus().get_value()


############################################################
# utils
############################################################


@dataclass
class CheckerPlayer:
    uid: str
    proof: bytes | None
    public_key: bytes
    private_key: bytes


class InvalidResponse(Exception):
    def __init__(self, context: str, endpoint_name: str | None = None):
        super().__init__(context)
        self.context = context
        self.endpoint_name = endpoint_name

    def at_endpoint(self, endpoint_name: str):
        return InvalidResponse(self.context, endpoint_name)


def validate_endpoint_response(endpoint_name: str):
    def inner(f):
        @wraps(f)
        async def wrapper(*args, **kwargs):
            try:
                return await f(*args, **kwargs)
            except InvalidResponse as exc:
                raise exc.at_endpoint(endpoint_name) from exc

        return wrapper

    return inner


def log_checker_exceptions(f):
    @wraps(f)
    async def wrapper(*args, **kwargs):
        task_logger = kwargs.get("logger")
        if not isinstance(task_logger, LoggerAdapter):
            task_logger = next(
                (arg for arg in args if isinstance(arg, LoggerAdapter)), None
            )
        if task_logger is None:
            raise RuntimeError("checker task logger is missing")

        try:
            return await f(*args, **kwargs)
        except InvalidResponse as exc:
            task_logger.exception(
                "%s: %s: invalid response: %s",
                f.__qualname__,
                exc.endpoint_name,
                exc.context,
            )
            endpoint_name = exc.endpoint_name or "service"
            raise MumbleException(f"{endpoint_name}: invalid response") from None
        except MumbleException as exc:
            message = str(exc)
            task_logger.exception("%s: mumble: %s", f.__qualname__, message)
            raise
        except Exception as exc:
            exception_type = type(exc).__name__
            message = str(exc)
            task_logger.exception(
                "%s: unexpected checker error: %s: %s",
                f.__qualname__,
                exception_type,
                message,
            )
            raise

    return wrapper


def gen_proof(public_key: bytes, private_key: bytes) -> bytes:
    return zkp_lib.prove(public_key, private_key)


def generate_identity(generate_proof: bool = True) -> tuple[bytes, bytes, bytes | None]:
    public_key, private_key = generate_keypair()
    proof = gen_proof(public_key, private_key) if generate_proof else None
    return public_key, private_key, proof


def forge_and_verify(forge, public_key: bytes) -> tuple[bytes, bool]:
    proof = forge(public_key)
    return proof, bool(zkp_lib.verify(public_key, proof))


def generate_keypair() -> tuple[bytes, bytes]:
    keygen = KeyGenerator(ctx)
    public_key = keygen.create_public_key()
    private_key = keygen.secret_key()
    return bytes(public_key.as_bytes()), bytes(private_key.as_bytes())


def encode_values(values: list[int]) -> bytes:
    return bytes(encoder.encode_int(values + [0] * (N - len(values))).as_bytes())


def encode_text(text: str) -> bytes:
    return encode_values(list(text.encode()))


def decode_text_pt(plaintext: bytes) -> str:
    decoded = encoder.decode_int(Plaintext.from_bytes(ctx, plaintext))
    out = []
    for value in decoded:
        if value == 0:
            break
        if 0 < value < 256:
            out.append(value)
    return bytes(out).decode(errors="ignore")


def encrypt_pt(public_key_bytes: bytes, plaintext_bytes: bytes) -> bytes:
    public_key = PublicKey.from_bytes(ctx, public_key_bytes)
    plaintext = Plaintext.from_bytes(ctx, plaintext_bytes)
    encryptor = Encryptor(ctx, public_key)
    return bytes(encryptor.encrypt(plaintext).as_bytes())


def encrypt_values(public_key: bytes, values: list[int]) -> bytes:
    return encrypt_pt(public_key, encode_values(values))


def encrypt_text(public_key: bytes, text: str) -> bytes:
    return encrypt_pt(public_key, encode_text(text))


def decrypt_to_pt(private_key_bytes: bytes, ciphertext_bytes: bytes) -> bytes:
    private_key = SecretKey.from_bytes(ctx, private_key_bytes)
    ciphertext = Ciphertext.from_bytes(ctx, ciphertext_bytes)
    decryptor = Decryptor(ctx, private_key)
    return bytes(decryptor.decrypt(ciphertext).as_bytes())


def decrypt_text(private_key: bytes, ciphertext: bytes) -> str:
    return decode_text_pt(decrypt_to_pt(private_key, ciphertext))


def decrypt_whispers(private_key: bytes, whispers: list[dict]) -> list[str]:
    plaintexts = []
    for whisper in whispers:
        try:
            plaintexts.append(decrypt_text(private_key, whisper["content"]))
        except Exception:
            continue
    return plaintexts


def evaluate_ciphertext(c0: bytes, c2: bytes) -> bytes:
    seed = sha256(sha256(c0).digest() + sha256(c2).digest()).digest()
    rng = Random(seed)
    p1 = encoder.encode_int([rng.randint(1, 20) for _ in range(N)])
    ct0 = Ciphertext.from_bytes(ctx, c0)
    ct2 = Ciphertext.from_bytes(ctx, c2)
    return bytes(evaluator.multiply(evaluator.multiply_plain(ct0, p1), ct2).as_bytes())


############################################################
# random data generators
############################################################


def random_description() -> str:
    return random_safe()


def random_game_name() -> str:
    return f"game_{token_hex(16)}"


def random_note() -> str:
    return random_string()


def random_broadcast() -> str:
    return random_string()


def random_whisper() -> str:
    return random_safe()


def random_roll_values() -> list[int]:
    return [randbelow(t - 1) + 1 for _ in range(N)]


############################################################
# content validation helpers
############################################################


def _expect_object(value, context: str) -> dict:
    if not isinstance(value, dict):
        raise InvalidResponse(f"{context}: expected a JSON dict")
    return value


def _expect_list(value, context: str) -> list:
    if not isinstance(value, list):
        raise InvalidResponse(f"{context}: expected a JSON list")
    return value


def _expect_field(obj: dict, field: str, expected_type: type, context: str):
    if field not in obj:
        raise InvalidResponse(f"{context}: missing field '{field}'")
    value = obj[field]
    valid = (
        type(value) is expected_type
        if expected_type in {bool, int}
        else isinstance(value, expected_type)
    )
    if not valid:
        type_name = {
            bool: "boolean",
            dict: "dict",
            int: "integer",
            list: "list",
            str: "string",
        }.get(expected_type, expected_type.__name__)
        raise InvalidResponse(f"{context}: field '{field}' must be a {type_name}")
    return value


def _expect_string_field(
    obj: dict, field: str, context: str, *, allow_empty: bool = True
) -> str:
    value = _expect_field(obj, field, str, context)
    if not allow_empty and not value:
        raise InvalidResponse(f"{context}: field '{field}' must not be empty")
    return value


def _expect_int_field(
    obj: dict, field: str, context: str, *, minimum: int | None = None
) -> int:
    value = _expect_field(obj, field, int, context)
    if minimum is not None and value < minimum:
        raise InvalidResponse(
            f"{context}: field '{field}' must be an integer of at least {minimum}"
        )
    return value


def _expect_bool_field(obj: dict, field: str, context: str) -> bool:
    return _expect_field(obj, field, bool, context)


def _expect_uid_value(value, context: str) -> str:
    if not isinstance(value, str) or fullmatch(r"[0-9a-f]{32}", value) is None:
        raise InvalidResponse(f"{context}: malformed uid")
    return value


def _expect_uid_field(obj: dict, field: str, context: str) -> str:
    if field not in obj:
        raise InvalidResponse(f"{context}: missing field '{field}'")
    return _expect_uid_value(obj[field], f"{context}: field '{field}'")


def _expect_optional_uid_field(obj: dict, field: str, context: str) -> str | None:
    if field not in obj:
        raise InvalidResponse(f"{context}: missing field '{field}'")
    value = obj[field]
    return (
        None
        if value is None
        else _expect_uid_value(value, f"{context}: field '{field}'")
    )


def _expect_base64_field(
    obj: dict, field: str, context: str, *, allow_empty: bool = False
) -> bytes:
    encoded = _expect_string_field(obj, field, context, allow_empty=allow_empty)
    try:
        decoded = b64decode(encoded, validate=True)
    except Exception:
        raise InvalidResponse(
            f"{context}: field '{field}' must be valid base64"
        ) from None
    if not allow_empty and not decoded:
        raise InvalidResponse(
            f"{context}: field '{field}' must decode to non-empty bytes"
        )
    return decoded


def _expect_public_key_field(obj: dict, field: str, context: str) -> bytes:
    public_key = _expect_base64_field(obj, field, context)
    try:
        PublicKey.from_bytes(ctx, public_key)
    except Exception:
        raise InvalidResponse(
            f"{context}: field '{field}' must encode a valid BFV public key"
        ) from None
    return public_key


def _expect_ciphertext_field(obj: dict, field: str, context: str) -> bytes:
    ciphertext = _expect_base64_field(obj, field, context)
    try:
        Ciphertext.from_bytes(ctx, ciphertext)
    except Exception:
        raise InvalidResponse(
            f"{context}: field '{field}' must encode a valid BFV ciphertext"
        ) from None
    return ciphertext


def _validate_equal(actual, expected, msg: str) -> None:
    if actual != expected:
        raise InvalidResponse(msg)


async def _json_response(
    response,
    context: str,
    expected_status: set[int],
    expected_type: type,
):
    if response.status_code not in expected_status:
        raise InvalidResponse(
            f"{context}: unexpected HTTP status (expected {expected_status}, got {response.status_code})"
        )

    content_type = (
        response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    if content_type != "application/json":
        raise InvalidResponse(
            f"{context}: expected Content-Type application/json, got {content_type}"
        )

    try:
        data = response.json()
    except Exception:
        raise InvalidResponse(f"{context}: expected a valid JSON body") from None

    if expected_type is dict:
        return _expect_object(data, context)
    if expected_type is list:
        return _expect_list(data, context)
    raise TypeError("unsupported expected JSON type")


async def expect_error_response(
    response,
    endpoint_name: str,
    expected_status: int,
    expected_error: str,
) -> dict:
    context = f"{endpoint_name} error response"
    try:
        data = await _json_response(response, context, {expected_status}, dict)
        error = _expect_string_field(data, "error", context, allow_empty=False)
        _validate_equal(error, expected_error, f"{context}: unexpected error")
        return data
    except InvalidResponse as exc:
        raise exc.at_endpoint(endpoint_name) from exc


def _validate_player_ref(value, context: str) -> dict:
    player = _expect_object(value, context)
    out = dict(player)
    out["uid"] = _expect_uid_field(player, "uid", context)
    out["public_key"] = _expect_public_key_field(player, "public_key", context)
    return out


def _validate_message(
    value,
    context: str,
    *,
    expected_kind: str,
    content: str = "absent",
) -> dict:
    message = _expect_object(value, context)
    out = dict(message)
    out["id"] = _expect_int_field(message, "id", context, minimum=1)
    out["game"] = _expect_string_field(message, "game", context, allow_empty=False)
    out["sender"] = _expect_uid_field(message, "sender", context)
    out["recipient"] = _expect_optional_uid_field(message, "recipient", context)
    kind = _expect_string_field(message, "kind", context, allow_empty=False)
    if kind != expected_kind:
        raise InvalidResponse(f"{context}: field 'kind' must be '{expected_kind}'")
    out["resolved"] = _expect_bool_field(message, "resolved", context)
    _expect_string_field(message, "timestamp", context, allow_empty=False)
    if content == "text":
        out["content"] = _expect_string_field(message, "content", context)
    elif content == "base64":
        out["content"] = _expect_ciphertext_field(message, "content", context)
    elif content != "absent":
        raise ValueError("unsupported message content validator")
    return out


def _validate_game_info(value, context: str) -> dict:
    info = _expect_object(value, context)
    out = dict(info)
    out["name"] = _expect_string_field(info, "name", context, allow_empty=False)
    _expect_string_field(info, "description", context)
    out["owner"] = _expect_uid_field(info, "owner", context)
    out["owner_public_key"] = _expect_public_key_field(
        info, "owner_public_key", context
    )
    out["owner_afk"] = _expect_bool_field(info, "owner_afk", context)
    out["player_count"] = _expect_int_field(info, "player_count", context, minimum=1)

    if "private_note" in info:
        _expect_string_field(info, "private_note", context)
    if "history" in info:
        history = _expect_field(info, "history", list, context)
        out["history"] = [
            _validate_message(
                message,
                f"{context}: history message {index}",
                expected_kind="broadcast",
                content="text",
            )
            for index, message in enumerate(history)
        ]
    if "whisper_counts" in info:
        counts = _expect_field(info, "whisper_counts", list, context)
        for index, count_value in enumerate(counts):
            count_context = f"{context}: whisper count {index}"
            count = _expect_object(count_value, count_context)
            _expect_uid_field(count, "sender", count_context)
            _expect_int_field(count, "count", count_context, minimum=0)
    return out


def _validate_game_listing(value, context: str) -> dict:
    game = _expect_object(value, context)
    out = dict(game)
    out["name"] = _expect_string_field(game, "name", context, allow_empty=False)
    _expect_string_field(game, "description", context)
    out["owner"] = _expect_uid_field(game, "owner", context)
    out["player_count"] = _expect_int_field(game, "player_count", context, minimum=0)
    return out


def _validate_request_result_list(
    values, context: str, *, resolved: bool
) -> list[dict]:
    entries = _expect_list(values, context)
    for index, value in enumerate(entries):
        item_context = f"{context}: item {index}"
        item = _expect_object(value, item_context)
        _expect_int_field(item, "request_id", item_context, minimum=1)
        if resolved:
            _expect_int_field(item, "result_id", item_context, minimum=1)
    return entries


def _validate_roll_result(result: dict, request: dict, context: str) -> bytes:
    _validate_equal(result["game"], request["game"], f"{context}: game mismatch")
    prefix = f"roll {request['id']} from {request['sender']}: "
    if not result["content"].startswith(prefix):
        raise InvalidResponse(f"{context}: prefix mismatch")
    try:
        plaintext = b64decode(result["content"][len(prefix) :], validate=True)
        Plaintext.from_bytes(ctx, plaintext)
    except Exception:
        raise InvalidResponse(f"{context}: malformed plaintext") from None
    return plaintext


############################################################
# endpoint call helpers
############################################################


@validate_endpoint_response("register")
async def do_register(
    client: AsyncClient,
    *,
    generate_proof: bool = True,
    expected_status: int = 201,
    expected_error: str | None = None,
) -> CheckerPlayer | dict:
    public_key, private_key, proof = await _run_cpu(generate_identity, generate_proof)
    response = await client.post(
        "/register",
        content=public_key,
        headers=BINARY_HEADERS,
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "register", expected_status, expected_error
        )
    context = "registration response"
    data = await _json_response(response, context, {expected_status}, dict)
    uid = _expect_uid_field(data, "uid", context)
    _expect_string_field(data, "message", context, allow_empty=False)
    return CheckerPlayer(
        uid=uid,
        proof=proof,
        public_key=public_key,
        private_key=private_key,
    )


@validate_endpoint_response("login")
async def do_login(
    client: AsyncClient,
    uid: str,
    proof: bytes,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    response = await client.post(
        "/login", params={"uid": uid}, content=proof, headers=BINARY_HEADERS
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "login", expected_status, expected_error
        )
    context = "login response"
    data = await _json_response(response, context, {expected_status}, dict)
    response_uid = _expect_uid_field(data, "uid", context)
    _validate_equal(
        response_uid, uid, "login response: field 'uid' did not match the requested uid"
    )
    _expect_string_field(data, "message", context, allow_empty=False)


@validate_endpoint_response("logout")
async def do_logout(
    client: AsyncClient,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    response = await client.post("/logout")
    if expected_error is not None:
        return await expect_error_response(
            response, "logout", expected_status, expected_error
        )
    data = await _json_response(response, "logout response", {expected_status}, dict)
    _expect_string_field(data, "message", "logout response", allow_empty=False)


@validate_endpoint_response("player_info")
async def do_player_info(
    client: AsyncClient,
    uid: str,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    response = await client.get(f"/player/{uid}")
    if expected_error is not None:
        return await expect_error_response(
            response, "player_info", expected_status, expected_error
        )
    context = "player info response"
    info = await _json_response(response, context, {expected_status}, dict)
    out = _validate_player_ref(info, context)
    games = _expect_field(info, "games", list, context)
    out["games"] = []
    for index, game in enumerate(games):
        if not isinstance(game, str) or not game:
            raise InvalidResponse(
                f"{context}: item {index} of field 'games' must be a non-empty string"
            )
        out["games"].append(game)
    _validate_equal(
        out["uid"],
        uid,
        "player info response: field 'uid' did not match the requested uid",
    )
    return out


@validate_endpoint_response("list_games")
async def do_list_games(
    client: AsyncClient,
    start: int | None = None,
    end: int | None = None,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    params = {}
    if start is not None:
        params["start"] = start
    if end is not None:
        params["end"] = end
    response = await client.get("/games", params=params)
    if expected_error is not None:
        return await expect_error_response(
            response, "list_games", expected_status, expected_error
        )
    context = "game list response"
    games = await _json_response(response, context, {expected_status}, list)
    return [
        _validate_game_listing(game, f"{context}: game {index}")
        for index, game in enumerate(games)
    ]


@validate_endpoint_response("create_game")
async def do_create_game(
    client: AsyncClient,
    name: str,
    description: str,
    owner_public_key: bytes,
    roll_ciphertext: bytes | None = None,
    *,
    expected_status: int = 201,
    expected_error: str | None = None,
):
    roll_ciphertext = roll_ciphertext or encrypt_values(
        owner_public_key, random_roll_values()
    )
    response = await client.post(
        "/games",
        json={
            "name": name,
            "description": description,
            "ciphertext": b64encode(roll_ciphertext).decode("ascii"),
        },
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "create_game", expected_status, expected_error
        )
    context = "create game response"
    info = _validate_game_info(
        await _json_response(response, context, {expected_status}, dict), context
    )
    _validate_equal(
        info["name"],
        name,
        "create game response: field 'name' did not match the requested game",
    )
    return info


@validate_endpoint_response("join_game")
async def do_join_game(
    client: AsyncClient,
    name: str,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    response = await client.post(f"/games/{name}/join")
    if expected_error is not None:
        return await expect_error_response(
            response, "join_game", expected_status, expected_error
        )
    context = "join game response"
    info = _validate_game_info(
        await _json_response(response, context, {expected_status}, dict), context
    )
    _validate_equal(
        info["name"],
        name,
        "join game response: field 'name' did not match the requested game",
    )
    return info


@validate_endpoint_response("game_info")
async def do_game_info(
    client: AsyncClient,
    name: str,
    start: int | None = None,
    end: int | None = None,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    params = {}
    if start is not None:
        params["start"] = start
    if end is not None:
        params["end"] = end
    response = await client.get(f"/games/{name}", params=params)
    if expected_error is not None:
        return await expect_error_response(
            response, "game_info", expected_status, expected_error
        )
    context = "game info response"
    info = _validate_game_info(
        await _json_response(response, context, {expected_status}, dict), context
    )
    _validate_equal(
        info["name"],
        name,
        "game info response: field 'name' did not match the requested game",
    )
    return info


@validate_endpoint_response("game_players")
async def do_game_players(
    client: AsyncClient,
    game: str,
    start: int | None = None,
    end: int | None = None,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    params = {}
    if start is not None:
        params["start"] = start
    if end is not None:
        params["end"] = end
    response = await client.get(f"/games/{game}/players", params=params)
    if expected_error is not None:
        return await expect_error_response(
            response, "game_players", expected_status, expected_error
        )
    context = "game player list response"
    players = await _json_response(response, context, {expected_status}, list)
    return [
        _validate_player_ref(player, f"{context}: player {index}")
        for index, player in enumerate(players)
    ]


@validate_endpoint_response("post_note")
async def do_post_note(
    client: AsyncClient,
    game: str,
    note: str,
    *,
    expected_status: int = 201,
    expected_error: str | None = None,
):
    response = await client.post(f"/games/{game}/note", json={"note": note})
    if expected_error is not None:
        return await expect_error_response(
            response, "post_note", expected_status, expected_error
        )
    context = "private note response"
    data = await _json_response(response, context, {expected_status}, dict)
    _expect_string_field(data, "message", context, allow_empty=False)
    stored_note = _expect_string_field(data, "private_note", context)
    _validate_equal(
        stored_note,
        note,
        "private note response: field 'private_note' did not match the submitted note",
    )
    return data


@validate_endpoint_response("broadcast")
async def do_broadcast(
    client: AsyncClient,
    game: str,
    text: str,
    *,
    expected_status: int = 201,
    expected_error: str | None = None,
):
    response = await client.post(f"/games/{game}/broadcast", json={"text": text})
    if expected_error is not None:
        return await expect_error_response(
            response, "broadcast", expected_status, expected_error
        )
    context = "broadcast response"
    message = _validate_message(
        await _json_response(response, context, {expected_status}, dict),
        context,
        expected_kind="broadcast",
        content="text",
    )
    _validate_equal(
        message["game"],
        game,
        "broadcast response: field 'game' did not match the requested game",
    )
    _validate_equal(
        message["content"],
        text,
        "broadcast response: field 'content' did not match the submitted text",
    )
    return message


@validate_endpoint_response("whisper")
async def do_whisper(
    client: AsyncClient,
    game: str,
    ciphertext: bytes,
    recipient_uid: str,
    *,
    expected_status: int = 201,
    expected_error: str | None = None,
):
    response = await client.post(
        f"/games/{game}/whisper",
        params={"recipient_uid": recipient_uid},
        content=ciphertext,
        headers=BINARY_HEADERS,
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "whisper", expected_status, expected_error
        )
    context = "whisper response"
    message = _validate_message(
        await _json_response(response, context, {expected_status}, dict),
        context,
        expected_kind="whisper",
    )
    _validate_equal(
        message["game"],
        game,
        "whisper response: field 'game' did not match the requested game",
    )
    _validate_equal(
        message["recipient"],
        recipient_uid,
        "whisper response: field 'recipient' did not match the requested recipient",
    )
    return message


@validate_endpoint_response("whispers")
async def do_listen_whispers(
    client: AsyncClient,
    game: str,
    start: int | None = None,
    end: int | None = None,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    params = {}
    if start is not None:
        params["start"] = start
    if end is not None:
        params["end"] = end
    response = await client.get(f"/games/{game}/whispers", params=params)
    if expected_error is not None:
        return await expect_error_response(
            response, "whispers", expected_status, expected_error
        )
    context = "whisper list response"
    messages = await _json_response(response, context, {expected_status}, list)
    messages = [
        _validate_message(
            message,
            f"{context}: message {index}",
            expected_kind="whisper",
            content="base64",
        )
        for index, message in enumerate(messages)
    ]
    for message in messages:
        _validate_equal(message["game"], game, f"{context}: game mismatch")
    return messages


@validate_endpoint_response("roll")
async def do_roll(
    client: AsyncClient,
    game: str,
    ciphertext: bytes,
    *,
    expected_status: int = 201,
    expected_error: str | None = None,
):
    response = await client.post(
        f"/games/{game}/roll",
        content=ciphertext,
        headers=BINARY_HEADERS,
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "roll", expected_status, expected_error
        )
    context = "roll response"
    data = await _json_response(response, context, {expected_status}, dict)
    message = _validate_message(data, context, expected_kind="roll_request")
    _validate_equal(
        message["game"],
        game,
        "roll response: field 'game' did not match the requested game",
    )
    immediate = _expect_bool_field(data, "resolved_immediately", context)
    _validate_equal(message["resolved"], immediate, f"{context}: resolution mismatch")
    message["resolved_immediately"] = immediate
    if immediate:
        if "result_message" not in data:
            raise InvalidResponse(f"{context}: missing field 'result_message'")
        message["result_message"] = _validate_message(
            data["result_message"],
            f"{context}: result message",
            expected_kind="broadcast",
            content="text",
        )
        message["result_plaintext"] = _validate_roll_result(
            message["result_message"], message, f"{context}: result message"
        )
    return message


@validate_endpoint_response("roll_requests")
async def do_roll_requests(
    client: AsyncClient,
    game: str,
    include_resolved: bool = False,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    response = await client.get(
        f"/games/{game}/rolls",
        params={"include_resolved": "1" if include_resolved else "0"},
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "roll_requests", expected_status, expected_error
        )
    context = "roll request list response"
    messages = await _json_response(response, context, {expected_status}, list)
    messages = [
        _validate_message(
            message,
            f"{context}: request {index}",
            expected_kind="roll_request",
            content="base64",
        )
        for index, message in enumerate(messages)
    ]
    for message in messages:
        _validate_equal(message["game"], game, f"{context}: game mismatch")
    return messages


@validate_endpoint_response("resolve_roll")
async def do_resolve_roll(
    client: AsyncClient,
    game: str,
    request_id: int,
    plaintext: bytes,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    response = await client.post(
        f"/games/{game}/rolls/{request_id}/resolve",
        content=plaintext,
        headers=BINARY_HEADERS,
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "resolve_roll", expected_status, expected_error
        )
    context = "roll resolution response"
    data = await _json_response(response, context, {expected_status}, dict)
    request = _validate_message(
        _expect_field(data, "request", dict, context),
        f"{context}: request",
        expected_kind="roll_request",
        content="base64",
    )
    result = _validate_message(
        _expect_field(data, "result", dict, context),
        f"{context}: result",
        expected_kind="broadcast",
        content="text",
    )
    _validate_equal(
        request["id"], request_id, "roll resolution response: request id did not match"
    )
    _validate_equal(
        request["game"], game, "roll resolution response: request game did not match"
    )
    _validate_equal(
        result["game"], game, "roll resolution response: result game did not match"
    )
    result_plaintext = _validate_roll_result(result, request, f"{context}: result")
    _validate_equal(
        result_plaintext,
        plaintext,
        "roll resolution response: result plaintext did not match",
    )
    return {
        "request": request,
        "result": result,
        "result_plaintext": result_plaintext,
    }


@validate_endpoint_response("set_afk")
async def do_set_afk(
    client: AsyncClient,
    game: str,
    enabled: bool,
    private_key: bytes | None = None,
    rejoin_token: bytes | None = None,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
):
    response = await client.post(
        f"/games/{game}/afk",
        params={"enabled": "1" if enabled else "0"},
        content=(private_key if enabled else rejoin_token) or b"",
        headers=BINARY_HEADERS,
    )
    if expected_error is not None:
        return await expect_error_response(
            response, "set_afk", expected_status, expected_error
        )
    context = "afk response"
    data = await _json_response(response, context, {expected_status}, dict)
    owner_afk = _expect_bool_field(data, "owner_afk", context)
    _validate_equal(
        owner_afk,
        enabled,
        "afk response: field 'owner_afk' did not match the requested mode",
    )
    _validate_request_result_list(
        _expect_field(data, "resolved", list, context),
        f"{context}: field 'resolved'",
        resolved=True,
    )
    _validate_request_result_list(
        _expect_field(data, "failed", list, context),
        f"{context}: field 'failed'",
        resolved=False,
    )
    if enabled:
        data["rejoin_token"] = _expect_base64_field(data, "rejoin_token", context)
    return data


############################################################
# checker tasks
############################################################


# Flagstore 1
# Putflag:
# - Creates user
# - Stores flag in the private note of the player
# - Checks that note overwriting is rejected (so noone can delete flag)
# Getflag:
# - Normally authenticates as a user, checking that it is possible to log in to the relevant user's account and get flag.
# Noise check tests that player info is accessible.


@checker.putflag(0)
@log_checker_exceptions
async def putflag_auth(
    task: PutflagCheckerTaskMessage,
    db: ChainDB,
    client_owner: AsyncClient,
    client_player: AsyncClient,
    logger: LoggerAdapter,
):
    owner = await do_register(client_owner, generate_proof=False)
    game = random_game_name()
    await do_create_game(client_owner, game, random_description(), owner.public_key)

    player = await do_register(client_player)
    await do_join_game(client_player, game)
    await do_post_note(client_player, game, task.flag)
    await do_post_note(
        client_player,
        game,
        random_note(),
        expected_status=409,
        expected_error="Private note already posted",
    )

    await db.set("creds", (player.uid, player.proof, game, player.public_key))
    return player.uid


@checker.getflag(0)
@log_checker_exceptions
async def getflag_auth(
    task: GetflagCheckerTaskMessage,
    db: ChainDB,
    client_login: AsyncClient,
    client_player_info: AsyncClient,
    logger: LoggerAdapter,
) -> None:
    uid, proof, game, public_key = await db.get("creds")

    info = await do_player_info(client_player_info, uid)
    assert_equals(info["public_key"], public_key, "player_info public key")
    assert_equals(info["uid"], uid, "player_info uid")
    assert_in(game, info["games"], "player_info games")

    await do_login(client_login, uid, proof)
    info = await do_game_info(client_login, game, start=0, end=0)
    assert_equals(info.get("private_note", ""), task.flag, "failed flag out")


# Flagstore 2
# Putflag:
# - Creates 2 users, owner and sender
# - Sends the flag from one user to another via whisper
# - Game owner goes afk to enable the roll oracle
# GetFlag:
# - Logs into the game owner user and reads the whispers, decrypting them and checking for the flag locally.
# Exploit:
# - Uses malicious roll contributions to recover the owner's private key.
# - Generates a valid proof, logs in as the owner, and retrieves the flag.
# - Noise checks test rolling and whispering, which are relevant to the exploit.


@checker.putflag(1)
@log_checker_exceptions
async def putflag_fhe(
    task: PutflagCheckerTaskMessage,
    db: ChainDB,
    client_owner: AsyncClient,
    client_sender: AsyncClient,
    logger: LoggerAdapter,
):
    owner = await do_register(client_owner)
    game = random_game_name()
    c2 = encrypt_values(owner.public_key, random_roll_values())
    await do_create_game(client_owner, game, random_description(), owner.public_key, c2)
    await do_set_afk(client_owner, game, True, owner.private_key)

    await do_register(client_sender, generate_proof=False)
    await do_join_game(client_sender, game)
    await do_whisper(
        client_sender,
        game,
        encrypt_text(owner.public_key, task.flag),
        recipient_uid=owner.uid,
    )

    await db.set("creds", (owner.uid, owner.proof, owner.private_key, game, c2))
    return game


@checker.getflag(1)
@log_checker_exceptions
async def getflag_fhe(
    task: GetflagCheckerTaskMessage,
    db: ChainDB,
    client_owner: AsyncClient,
    client_roller: AsyncClient,
    logger: LoggerAdapter,
) -> None:
    owner_uid, owner_proof, owner_private_key, game, c2 = await db.get("creds")

    await do_register(client_roller, generate_proof=False)
    game_info = await do_join_game(client_roller, game)
    assert_equals(game_info["owner"], owner_uid, "faulty game info")

    c0 = encrypt_values(game_info["owner_public_key"], random_roll_values())
    rolls = await do_roll(client_roller, game, c0)

    assert_equals(rolls["resolved_immediately"], True, "roll resolution failed")

    real_ct = evaluate_ciphertext(c0, c2)
    real_pt = decrypt_to_pt(owner_private_key, real_ct)

    assert_equals(rolls["result_plaintext"], real_pt, "roll result mismatch")

    await do_login(client_owner, owner_uid, owner_proof)
    whispers = await do_listen_whispers(client_owner, game, start=0, end=10)
    plaintexts = decrypt_whispers(owner_private_key, whispers)
    assert_in(task.flag, plaintexts, "failed flag out")


async def try_exploit_fhe(client: AsyncClient, searcher: FlagSearcher, game_uid: str):
    await do_register(client, generate_proof=False)

    game_info = await do_join_game(client, game_uid)

    if not game_info["owner_afk"]:
        raise MumbleException("game owner is not afk")

    async def query_oracle(ciphertext: bytes, game_name: str = game_uid) -> bytes:
        result = await do_roll(client, game_name, ciphertext)
        if not result["resolved_immediately"]:
            raise MumbleException("roll: invalid response")
        return result["result_plaintext"]

    try:
        real_sk = await recover_fhe_key(
            query_oracle,
            game_info["owner_public_key"],
            run_cpu=_run_cpu,
        )
    except Exception as exc:
        raise MumbleException("failed to recover FHE key") from exc

    # This takes around 12 ms in isolation. Keeping it here avoids sending a
    # recovered FHE exploit back through the unrelated ZKP work queue.
    proof = gen_proof(game_info["owner_public_key"], real_sk)
    await do_login(client, game_info["owner"], proof)
    whispers = await do_listen_whispers(client, game_uid, start=0, end=10)
    for whisper in whispers:
        try:
            found = searcher.search_flag(decrypt_text(real_sk, whisper["content"]))
            if found:
                return found
        except Exception:
            continue


async def try_exploit_zkp(
    client: AsyncClient, searcher: FlagSearcher, flag_uid: str, forges
):
    player = await do_player_info(client, flag_uid)
    public_key = player["public_key"]
    for forge in forges:
        proof, valid = await _run_cpu(forge_and_verify, forge, public_key)
        if not valid:
            continue
        try:
            await do_login(client, flag_uid, proof)
            break
        except Exception:
            continue
    else:
        return

    for game in player["games"]:
        info = await do_game_info(client, game)
        if flag := searcher.search_flag(info.get("private_note", "")):
            return flag


@checker.exploit(0, 1)
@log_checker_exceptions
async def exploit_fhe(
    task: ExploitCheckerTaskMessage,
    logger: LoggerAdapter,
    searcher: FlagSearcher,
    client: AsyncClient,
):
    if not task.attack_info:
        return

    return await try_exploit_fhe(client, searcher, task.attack_info)


# V1: proof-controlled scalar sumcheck round count (relation-anchor overwrite).
@checker.exploit(1, 0)
@log_checker_exceptions
async def exploit_zkp_sumcheck_rounds(
    task: ExploitCheckerTaskMessage,
    searcher: FlagSearcher,
    client: AsyncClient,
    logger: LoggerAdapter,
):
    if not task.attack_info:
        return

    return await try_exploit_zkp(
        client, searcher, task.attack_info, (zkp_forge_fq_sumcheck_rounds,)
    )


# V2: proof-controlled Fq2 sumcheck shape; three manifestations of one bug.
@checker.exploit(2, 0)
@log_checker_exceptions
async def exploit_zkp_fq2_degree(
    task: ExploitCheckerTaskMessage,
    searcher: FlagSearcher,
    client: AsyncClient,
    logger: LoggerAdapter,
):
    if not task.attack_info:
        return

    return await try_exploit_zkp(
        client,
        searcher,
        task.attack_info,
        (
            zkp_forge_fq2_sumcheck_degree_truncate,
            zkp_forge_fq2_sumcheck_degree_wrap,
            zkp_forge_fq2_sumcheck_degree_hoist,
        ),
    )


# V3: proof-controlled Merkle opening count (distinct-rank frontier alias).
@checker.exploit(3, 0)
@log_checker_exceptions
async def exploit_zkp_merkle_count(
    task: ExploitCheckerTaskMessage,
    searcher: FlagSearcher,
    client: AsyncClient,
    logger: LoggerAdapter,
):
    if not task.attack_info:
        return

    return await try_exploit_zkp(
        client, searcher, task.attack_info, (zkp_forge_merkle_index_count,)
    )


# Reflects the actions of flag in/out for flagstore 0 (auth).
# Checks the functionality of game creation, joining, and user notes.
# Ensures authentication works as intended, as it's relevant for flagstore 0 (auth).


@checker.putnoise(0)
@log_checker_exceptions
async def putnoise_notes(
    task: PutnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_owner: AsyncClient,
    client_player: AsyncClient,
    db: ChainDB,
) -> None:
    owner = await do_register(client_owner, generate_proof=False)
    game = random_game_name()
    await do_create_game(client_owner, game, random_description(), owner.public_key)

    player = await do_register(client_player)
    await do_join_game(client_player, game)
    note = random_note()
    await do_post_note(client_player, game, note)
    await do_post_note(
        client_player,
        game,
        random_note(),
        expected_status=409,
        expected_error="Private note already posted",
    )

    await db.set("creds", (player.uid, player.proof, game, note, player.public_key))


@checker.getnoise(0)
@log_checker_exceptions
async def getnoise_notes(
    task: GetnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_login: AsyncClient,
    client_player_info: AsyncClient,
    db: ChainDB,
    di: DependencyInjector,
) -> None:
    uid, proof, game, note, public_key = await db.get("creds")

    info = await do_player_info(client_player_info, uid)
    assert_equals(info["public_key"], public_key, "player_info public key")
    assert_equals(info["uid"], uid, "player_info uid")
    assert_in(game, info["games"], "player_info games")

    await do_login(client_login, uid, proof)
    info = await do_game_info(client_login, game)
    assert_equals(info.get("private_note", ""), note, "private note")


# Checks the functionality of game creation, joining and whispers.
# Ensures whispers works as intended, as it's relevant for flagstore 1 (fhe).


@checker.putnoise(1)
@log_checker_exceptions
async def putnoise_whispers(
    task: PutnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_alice: AsyncClient,
    client_bob: AsyncClient,
    db: ChainDB,
) -> None:
    alice = await do_register(client_alice, generate_proof=False)
    game = random_game_name()
    await do_create_game(client_alice, game, random_description(), alice.public_key)

    bob = await do_register(client_bob)
    await do_join_game(client_bob, game)

    texts = []
    for _ in range(randbelow(5) + 1):
        text = random_whisper()
        texts.append(text)

        await do_whisper(
            client_alice,
            game,
            encrypt_text(bob.public_key, text),
            recipient_uid=bob.uid,
        )

    await db.set("creds", (bob.uid, bob.proof, bob.private_key, game, texts))


@checker.getnoise(1)
@log_checker_exceptions
async def getnoise_whispers(
    task: GetnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client: AsyncClient,
    db: ChainDB,
    di: DependencyInjector,
) -> None:
    bob_uid, bob_proof, bob_private_key, game, texts = await db.get("creds")
    await do_login(client, bob_uid, bob_proof)
    whispers = await do_listen_whispers(client, game, start=0, end=2)
    whispers += await do_listen_whispers(client, game, start=2, end=20)
    plaintexts = decrypt_whispers(bob_private_key, whispers)

    for text in texts:
        assert_in(text, plaintexts, "whispered text missing")


# Reflects the actions of flag in/out for flagstore 1 (fhe).
# Checks the functionality of game creation, joining, whispers and afk roll resolution.
# Ensures whispers and afk roll resolution works as intended, as it's relevant for flagstore 1 (fhe).


@checker.putnoise(2)
@log_checker_exceptions
async def putnoise_afk_roll(
    task: PutnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_owner: AsyncClient,
    client_sender: AsyncClient,
    db: ChainDB,
) -> None:
    owner = await do_register(client_owner, generate_proof=False)
    game = random_game_name()
    c2 = encrypt_values(owner.public_key, random_roll_values())

    await do_create_game(client_owner, game, random_description(), owner.public_key, c2)
    await do_set_afk(client_owner, game, True, owner.private_key)

    await do_register(client_sender, generate_proof=False)
    await do_join_game(client_sender, game)
    await do_broadcast(client_sender, game, random_broadcast())

    await db.set("creds", (owner.uid, owner.private_key, game, c2))


@checker.getnoise(2)
@log_checker_exceptions
async def getnoise_afk_roll(
    task: GetnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_whisper: AsyncClient,
    client_roll: AsyncClient,
    db: ChainDB,
    di: DependencyInjector,
) -> None:
    owner_uid, owner_private_key, game, c2 = await db.get("creds")

    await do_register(client_roll, generate_proof=False)
    game_info = await do_join_game(client_roll, game)
    assert_equals(game_info["owner"], owner_uid, "faulty game info")

    c0 = encrypt_values(game_info["owner_public_key"], random_roll_values())
    rolls = await do_roll(client_roll, game, c0)

    if not rolls["resolved_immediately"]:
        raise MumbleException("roll: failed to resolve immediately")

    real_ct = evaluate_ciphertext(c0, c2)
    real_pt = decrypt_to_pt(owner_private_key, real_ct)

    assert_equals(rolls["result_plaintext"], real_pt, "roll result mismatch")


# Checks player info retreival.
# Relevant for authentication.


@checker.putnoise(3)
@log_checker_exceptions
async def putnoise_player_info(
    task: PutnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client: AsyncClient,
    db: ChainDB,
) -> None:
    player = await do_register(client, generate_proof=False)
    await db.set("creds", (player.uid, player.public_key))


@checker.getnoise(3)
@log_checker_exceptions
async def getnoise_player_info(
    task: GetnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client: AsyncClient,
    db: ChainDB,
    di: DependencyInjector,
) -> None:
    uid, public_key = await db.get("creds")
    info = await do_player_info(client, uid)
    assert_equals(info["public_key"], public_key, "player_info public key")


# Checks FHE evaluation and manual roll resolution.


@checker.putnoise(4)
@log_checker_exceptions
async def putnoise_roll_evaluation(
    task: PutnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_owner: AsyncClient,
    client_player: AsyncClient,
    db: ChainDB,
) -> None:
    owner = await do_register(client_owner)

    game = random_game_name()
    c2 = encrypt_values(owner.public_key, random_roll_values())
    await do_create_game(client_owner, game, random_description(), owner.public_key, c2)

    await do_register(client_player, generate_proof=False)
    await do_join_game(client_player, game)
    c0 = encrypt_values(owner.public_key, random_roll_values())
    response = await do_roll(client_player, game, c0)
    request_id = response["id"]

    real_ct = evaluate_ciphertext(c0, c2)

    await db.set(
        "creds",
        (owner.uid, owner.proof, game, owner.private_key, request_id, real_ct),
    )


@checker.getnoise(4)
@log_checker_exceptions
async def getnoise_roll_evaluation(
    task: GetnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client: AsyncClient,
    db: ChainDB,
    di: DependencyInjector,
) -> None:
    uid, proof, game, private_key, request_id, expected = await db.get("creds")
    await do_login(client, uid, proof)
    requests = await do_roll_requests(client, game, include_resolved=True)
    request = next(
        (message for message in requests if message["id"] == request_id),
        None,
    )
    if request is None:
        raise MumbleException("roll_requests: invalid response")

    ciphertext = request["content"]
    assert_equals(ciphertext, expected, "roll evaluation mismatch")

    if not request["resolved"]:
        plaintext = decrypt_to_pt(private_key, ciphertext)
        await do_resolve_roll(client, game, request_id, plaintext)


# Checks AFK token handoff, immediate AFK resolution, and manual resolution after
# the owner returns.


@checker.putnoise(5)
@log_checker_exceptions
async def putnoise_afk_rejoin(
    task: PutnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_owner: AsyncClient,
    client_roller: AsyncClient,
    db: ChainDB,
) -> None:
    owner = await do_register(client_owner)
    game = random_game_name()
    c2 = encrypt_values(owner.public_key, random_roll_values())
    await do_create_game(
        client_owner,
        game,
        random_description(),
        owner.public_key,
        c2,
    )
    afk = await do_set_afk(client_owner, game, True, owner.private_key)
    await do_set_afk(
        client_owner,
        game,
        True,
        owner.private_key,
        expected_status=409,
        expected_error="AFK mode is already enabled",
    )

    roller = await do_register(client_roller)
    await do_join_game(client_roller, game)
    c0 = encrypt_values(owner.public_key, random_roll_values())
    roll = await do_roll(client_roller, game, c0)
    assert_equals(roll["resolved_immediately"], True, "AFK roll was not resolved")

    expected = decrypt_to_pt(owner.private_key, evaluate_ciphertext(c0, c2))
    assert_equals(roll["result_plaintext"], expected, "AFK roll result mismatch")

    await db.set(
        "creds",
        (
            owner.uid,
            owner.proof,
            owner.public_key,
            owner.private_key,
            afk["rejoin_token"],
            roller.uid,
            roller.proof,
            game,
            c2,
            roll["id"],
            expected,
        ),
    )


@checker.getnoise(5)
@log_checker_exceptions
async def getnoise_afk_rejoin(
    task: GetnoiseCheckerTaskMessage,
    logger: LoggerAdapter,
    client_owner: AsyncClient,
    client_roller: AsyncClient,
    db: ChainDB,
    di: DependencyInjector,
) -> None:
    (
        owner_uid,
        owner_proof,
        owner_public_key,
        owner_private_key,
        rejoin_token,
        roller_uid,
        roller_proof,
        game,
        c2,
        afk_request_id,
        afk_expected,
    ) = await db.get("creds")

    await do_login(client_owner, owner_uid, owner_proof)
    info = await do_game_info(client_owner, game)

    if info["owner_afk"] != True:
        afk = await do_set_afk(client_owner, game, True, owner_private_key)
        rejoin_token = afk["rejoin_token"]

    await do_set_afk(
        client_owner,
        game,
        False,
        rejoin_token=rejoin_token,
    )

    await do_login(client_roller, roller_uid, roller_proof)
    c0 = encrypt_values(owner_public_key, random_roll_values())
    manual_roll = await do_roll(client_roller, game, c0)
    assert_equals(
        manual_roll["resolved_immediately"],
        False,
        "non-AFK roll resolved immediately",
    )

    expected_ciphertext = evaluate_ciphertext(c0, c2)
    manual_expected = decrypt_to_pt(owner_private_key, expected_ciphertext)
    requests = await do_roll_requests(client_owner, game)
    request = next(
        (entry for entry in requests if entry["id"] == manual_roll["id"]),
        None,
    )
    if request is None:
        raise MumbleException("roll_requests: invalid response")
    assert_equals(request["content"], expected_ciphertext, "roll evaluation mismatch")
    resolution = await do_resolve_roll(
        client_owner,
        game,
        request["id"],
        manual_expected,
    )
    assert_equals(
        resolution["result_plaintext"],
        manual_expected,
        "manual roll result mismatch",
    )

    info = await do_game_info(client_roller, game)
    checks = (
        (
            {"id": afk_request_id, "sender": roller_uid, "game": game},
            afk_expected,
            "AFK roll result mismatch",
        ),
        (manual_roll, manual_expected, "manual roll result mismatch"),
    )
    for checked_request, expected, message in checks:
        prefix = f"roll {checked_request['id']} from {checked_request['sender']}: "
        result = next(
            (entry for entry in info["history"] if entry["content"].startswith(prefix)),
            None,
        )
        if result is None:
            raise MumbleException("game_info: invalid response")
        assert_equals(
            _validate_roll_result(result, checked_request, "game info roll result"),
            expected,
            message,
        )


async def _havoc_join_random_game(
    client: AsyncClient,
    *,
    expected_status: int = 200,
    expected_error: str | None = None,
) -> dict | None:
    games = await do_list_games(client, start=-20)
    if not games:
        return None
    game = games[randbelow(len(games))]
    return await do_join_game(
        client,
        game["name"],
        expected_status=expected_status,
        expected_error=expected_error,
    )


@checker.havoc(0)
@log_checker_exceptions
async def havoc_whisper_member(
    task: HavocCheckerTaskMessage,
    client: AsyncClient,
    logger: LoggerAdapter,
) -> None:
    actor = await do_register(client, generate_proof=False)
    game = await _havoc_join_random_game(client)
    if game is None:
        return
    # Fetch the most recent membership page, then choose another recent player.
    # The actor has just joined and is normally the final entry in this page.
    if game["player_count"] <= 1:
        return
    page_start = max(0, game["player_count"] - 10)
    recent_players = await do_game_players(
        client,
        game["name"],
        start=page_start,
        end=game["player_count"],
    )
    if not 1 <= len(recent_players) <= 10:
        raise MumbleException("game_players: invalid response")

    assert any(player["uid"] == actor.uid for player in recent_players), (
        "player missing from game_players"
    )
    recipients = [player for player in recent_players if player["uid"] != actor.uid]
    if not recipients:
        return
    recipient = recipients[randbelow(len(recipients))]
    await do_whisper(
        client,
        game["name"],
        encrypt_text(recipient["public_key"], random_whisper()),
        recipient_uid=recipient["uid"],
    )


@checker.havoc(1)
@log_checker_exceptions
async def havoc_roll(
    task: HavocCheckerTaskMessage,
    client: AsyncClient,
    logger: LoggerAdapter,
) -> None:
    await do_register(client, generate_proof=False)
    game = await _havoc_join_random_game(client)
    if game is None:
        return
    await do_roll(
        client,
        game["name"],
        encrypt_values(game["owner_public_key"], random_roll_values()),
    )


@checker.havoc(2)
@log_checker_exceptions
async def havoc_broadcast(
    task: HavocCheckerTaskMessage,
    client: AsyncClient,
    logger: LoggerAdapter,
) -> None:
    await do_register(client, generate_proof=False)
    game = await _havoc_join_random_game(client)
    if game is None:
        return
    await do_broadcast(client, game["name"], random_broadcast())


# Game creation and private notes are covered by putflag 0/1.


@checker.havoc(3)
@log_checker_exceptions
async def havoc_logout_invalidates_session(
    task: HavocCheckerTaskMessage,
    client: AsyncClient,
    logger: LoggerAdapter,
) -> None:
    await do_register(client, generate_proof=False)
    await do_logout(client)
    await _havoc_join_random_game(
        client,
        expected_status=401,
        expected_error="Authentication required",
    )


@checker.havoc(4)
@log_checker_exceptions
async def havoc_invalid_login_proof(
    task: HavocCheckerTaskMessage,
    client: AsyncClient,
    logger: LoggerAdapter,
) -> None:
    player = await do_register(client)
    _, _, foreign_proof = await _run_cpu(generate_identity, True)
    # A valid proof for a different keypair must be rejected: the verifier has
    # to bind the proof to the player's public key. A well-formed foreign proof
    # (not random bytes) keeps this a pure soundness check and never feeds the
    # verifier malformed input.
    await do_login(
        client,
        player.uid,
        foreign_proof,
        expected_status=401,
        expected_error="Invalid credentials",
    )
    await do_login(client, player.uid, player.proof)


############################################################
if __name__ == "__main__":
    checker.run(checker_port)
