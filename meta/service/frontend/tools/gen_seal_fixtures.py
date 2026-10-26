"""Generate fixtures with the service's own libraries (sealy, zkp_lib) for the JS tests.

Run it through the justfile (`just seal-fixtures`); sealy is not a dependency of
this POC, it is pulled in for this script only, and zkp_lib is imported from the
reference client next door.
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
    CoefficientModulus,
    Context,
    Decryptor,
    DegreeType,
    Encryptor,
    KeyGenerator,
    PlainModulus,
    SecurityLevel,
)

N = 2048
OUT = Path(__file__).resolve().parents[1] / "web" / "seal-fixtures.json"

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


def main() -> None:
    keygen = KeyGenerator(ctx)
    public_key, secret_key = keygen.create_public_key(), keygen.secret_key()
    encryptor = Encryptor(ctx, public_key)

    values = [42, 7, 5]
    plaintext = encode(values)

    # The service's roll evaluation: C0 * P1 * C2.
    evaluator = BFVEvaluator(ctx)
    rolls = [[10, 20, 30], [1, 2, 3]]
    c0, c2 = [encryptor.encrypt(encode(values)) for values in rolls]
    raw_c0, raw_c2 = bytes(c0.as_bytes()), bytes(c2.as_bytes())
    seed = sha256(sha256(raw_c0).digest() + sha256(raw_c2).digest()).digest()
    rng = Random(seed)
    mask = [rng.randint(1, 20) for _ in range(N)]
    evaluated = evaluator.multiply(evaluator.multiply_plain(c0, encode(mask)), c2)
    evaluated_values = encoder.decode_int(Decryptor(ctx, secret_key).decrypt(evaluated))

    OUT.write_text(
        json.dumps(
            {
                "generated_by": "tools/gen_seal_fixtures.py (sealy 0.3.0 / SEAL 4.0.0, zkp_lib)",
                "slot_count": N,
                "values": values,
                "public_key": bytes(public_key.as_bytes()).hex(),
                "secret_key": bytes(secret_key.as_bytes()).hex(),
                "plaintext": bytes(plaintext.as_bytes()).hex(),
                "ciphertext": bytes(encryptor.encrypt(plaintext).as_bytes()).hex(),
                "zkp_proof": zkp_lib.prove(
                    bytes(public_key.as_bytes()), bytes(secret_key.as_bytes())
                ).hex(),
                "evaluated": {
                    "rolls": rolls,
                    "expected": evaluated_values[:3],
                    "ciphertext": bytes(evaluated.as_bytes()).hex(),
                },
            }
        )
    )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
