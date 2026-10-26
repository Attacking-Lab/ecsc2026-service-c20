"""Load the browser's crypto output with the service's own libraries.

Reads what tests/seal_interop.test.mjs and tests/zkp_interop.test.mjs produced,
checks sealy and zkp_lib accept it, and writes a reply for
tests/seal_service_reply.test.mjs to decrypt. Run it through the justfile
(`just test-seal-service`).
"""

from __future__ import annotations

import json
import sys
from hashlib import sha256
from pathlib import Path
from random import Random

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "client"))

import zkp_lib
from sealy import (
    BFVEncoder,
    BfvEncryptionParametersBuilder,
    BFVEvaluator,
    Ciphertext,
    CoefficientModulus,
    Context,
    Decryptor,
    DegreeType,
    Encryptor,
    PlainModulus,
    Plaintext,
    PublicKey,
    SecretKey,
    SecurityLevel,
)

N = 2048
TESTS = Path(__file__).resolve().parents[1] / "tests"
FIXTURES = Path(__file__).resolve().parents[1] / "web" / "seal-fixtures.json"

degree, security_level = DegreeType(N), SecurityLevel(128)
params = (
    BfvEncryptionParametersBuilder()
    .with_poly_modulus_degree(degree)
    .with_coefficient_modulus(CoefficientModulus.bfv(degree, security_level))
    .with_plain_modulus(PlainModulus.batching(degree, 16))
    .build()
)
ctx = Context(params, False, security_level)
encoder = BFVEncoder(ctx)


def encode(values: list[int]):
    return encoder.encode_int(values + [0] * (N - len(values)))


def check(label: str, actual: list[int], expected: list[int]) -> None:
    if actual[: len(expected)] != expected:
        raise SystemExit(f"{label}: expected {expected}, got {actual[: len(expected)]}")
    print(f"ok  {label}")


def main() -> None:
    artifacts = json.loads((TESTS / "seal_interop_artifacts.json").read_text())
    fixtures = json.loads(FIXTURES.read_text())
    service_secret_key = SecretKey.from_bytes(
        ctx, bytes.fromhex(fixtures["secret_key"])
    )
    browser_public_key = PublicKey.from_bytes(
        ctx, bytes.fromhex(artifacts["public_key"])
    )
    browser_secret_key = SecretKey.from_bytes(
        ctx, bytes.fromhex(artifacts["secret_key"])
    )

    decryptor = Decryptor(ctx, service_secret_key)
    check(
        "service decrypts a browser whisper",
        encoder.decode_int(
            decryptor.decrypt(
                Ciphertext.from_bytes(
                    ctx, bytes.fromhex(artifacts["ciphertext_for_service_key"])
                )
            )
        ),
        artifacts["values"],
    )
    check(
        "service decodes a browser plaintext",
        encoder.decode_int(
            Plaintext.from_bytes(ctx, bytes.fromhex(artifacts["plaintext"]))
        ),
        artifacts["values"],
    )

    # The service's roll evaluation over the browser-encrypted contributions.
    encryptor = Encryptor(ctx, browser_public_key)
    rolls = artifacts["rolls"]
    ciphertexts = [
        Ciphertext.from_bytes(ctx, bytes.fromhex(ct))
        for ct in artifacts["roll_ciphertexts"]
    ]
    raw_c0, raw_c2 = [bytes.fromhex(ct) for ct in artifacts["roll_ciphertexts"]]
    seed = sha256(sha256(raw_c0).digest() + sha256(raw_c2).digest()).digest()
    rng = Random(seed)
    mask = [rng.randint(1, 20) for _ in range(N)]
    evaluator = BFVEvaluator(ctx)
    evaluated = evaluator.multiply(
        evaluator.multiply_plain(ciphertexts[0], encode(mask)), ciphertexts[1]
    )
    evaluated_values = encoder.decode_int(
        Decryptor(ctx, browser_secret_key).decrypt(evaluated)
    )
    print("ok  service evaluates browser ciphertexts")

    # The login proof the browser made for its own key must verify here.
    zkp_artifacts = json.loads((TESTS / "zkp_interop_artifacts.json").read_text())
    if not zkp_lib.verify(
        bytes.fromhex(zkp_artifacts["public_key"]),
        bytes.fromhex(zkp_artifacts["proof"]),
    ):
        raise SystemExit("service rejects the browser's login proof")
    print("ok  service verifies the browser's login proof")

    (TESTS / "seal_service_reply.json").write_text(
        json.dumps(
            {
                # Ties the reply to the run it answers: a stale one decrypts to
                # noise under the next run's key, so the test skips instead.
                "for_public_key": artifacts["public_key"],
                "values": artifacts["values"],
                "ciphertext": bytes(
                    encryptor.encrypt(encode(artifacts["values"])).as_bytes()
                ).hex(),
                "plaintext_of_browser_ciphertext": bytes(
                    decryptor.decrypt(
                        Ciphertext.from_bytes(
                            ctx, bytes.fromhex(artifacts["ciphertext_for_service_key"])
                        )
                    ).as_bytes()
                ).hex(),
                "evaluated": {
                    "rolls": rolls,
                    "expected": evaluated_values[:3],
                    "ciphertext": bytes(evaluated.as_bytes()).hex(),
                },
            }
        )
    )
    print(f"wrote {TESTS / 'seal_service_reply.json'}")


if __name__ == "__main__":
    main()
