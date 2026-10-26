from hashlib import sha256
from random import Random
from threading import Lock

from sealy import (
    BFVEvaluator,
    BFVEncoder,
    BfvEncryptionParametersBuilder,
    Ciphertext,
    CoefficientModulus,
    Context,
    Decryptor,
    DegreeType,
    PlainModulus,
    SecretKey,
    SecurityLevel,
)


N = 2048

key_store = None

degree = DegreeType(N)
security_level = SecurityLevel(128)

params = (
    BfvEncryptionParametersBuilder()
    .with_poly_modulus_degree(degree)
    .with_coefficient_modulus(CoefficientModulus.bfv(degree, security_level))
    .with_plain_modulus(PlainModulus.batching(degree, 16))
    .build()
)

ctx = Context(params, False, security_level)
encoder = BFVEncoder(ctx)
evaluator = BFVEvaluator(ctx)
fhe_lock = Lock()


def configure_key_store(store):
    global key_store
    key_store = store


def decrypt(uid, ct):
    with fhe_lock:
        ct = Ciphertext.from_bytes(ctx, ct)
        sk = SecretKey.from_bytes(ctx, key_store.get_secret_key(uid))
        decryptor = Decryptor(ctx, sk)
        pt = decryptor.decrypt(ct)
        return bytes(pt.as_bytes())


def evaluate_ciphertext(c0, c2):
    with fhe_lock:
        seed = sha256(sha256(c0).digest() + sha256(c2).digest()).digest()
        rng = Random(seed)
        p1 = encoder.encode_int([rng.randint(1, 20) for _ in range(N)])
        c0 = Ciphertext.from_bytes(ctx, c0)
        c2 = Ciphertext.from_bytes(ctx, c2)
        return bytes(
            evaluator.multiply(evaluator.multiply_plain(c0, p1), c2).as_bytes()
        )
