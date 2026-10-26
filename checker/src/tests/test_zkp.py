"""End-to-end checks for the login ZKP: an honest proof verifies, and each
documented forgery still produces an accepting proof (the checker's exploit
phase relies on these)."""

import pytest
import zkp_lib

from checker import gen_proof, generate_keypair
from zkp_exploits import (
    zkp_forge_fq2_sumcheck_degree_hoist,
    zkp_forge_fq2_sumcheck_degree_truncate,
    zkp_forge_fq2_sumcheck_degree_wrap,
    zkp_forge_fq_sumcheck_rounds,
    zkp_forge_merkle_index_count,
)

FORGERIES = [
    zkp_forge_fq_sumcheck_rounds,
    zkp_forge_fq2_sumcheck_degree_truncate,
    zkp_forge_fq2_sumcheck_degree_wrap,
    zkp_forge_fq2_sumcheck_degree_hoist,
    zkp_forge_merkle_index_count,
]


def test_honest_proof_verifies() -> None:
    public_key, private_key = generate_keypair()
    proof = gen_proof(public_key, private_key)
    assert zkp_lib.verify(public_key, proof)


def test_forged_proof_without_key_is_rejected() -> None:
    public_key, _ = generate_keypair()
    assert not zkp_lib.verify(public_key, b"\x00" * 4096)


@pytest.mark.parametrize("forge", FORGERIES, ids=lambda f: f.__name__)
def test_forgery_produces_accepting_proof(forge) -> None:
    public_key, _ = generate_keypair()
    proof = forge(public_key)
    assert zkp_lib.verify(public_key, proof)
