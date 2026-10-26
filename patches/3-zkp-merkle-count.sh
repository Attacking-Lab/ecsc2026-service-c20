#!/bin/sh
# Closes exploit variant 3 (exploit_zkp_merkle_count, V3): bound each Merkle
# opening's declared count to the real query set so unauthenticated rows can no
# longer be returned. Independent of V1/V2; defers proofs whose scalar/Fq2
# prefix is non-canonical. Extends _verify_proof after the V1/V2 patches
# (patches stack in order).
# Runs with the working directory set to the copy of service/.
set -eu

if grep -q 'def _valid_zkp_merkle_count' backend/app.py; then
    echo "exploit_zkp_merkle_count patch already applied" >&2
    exit 0
fi

patch -p2 <"$(dirname "$0")/exploit_zkp_merkle_count.patch"
