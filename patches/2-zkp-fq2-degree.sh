#!/bin/sh
# Closes exploit variant 2 (exploit_zkp_fq2_degree, V2): pin every Fq2 sumcheck's
# round count/degree so a forged shape can no longer collapse the batched claim.
# Independent of V1/V3; defers proofs whose scalar prefix is non-canonical.
# Extends _verify_proof after the V1 patch (patches stack in order).
# Runs with the working directory set to the copy of service/.
set -eu

if grep -q 'def _valid_zkp_fq2_degree' backend/app.py; then
    echo "exploit_zkp_fq2_degree patch already applied" >&2
    exit 0
fi

patch -p2 <"$(dirname "$0")/exploit_zkp_fq2_degree.patch"
