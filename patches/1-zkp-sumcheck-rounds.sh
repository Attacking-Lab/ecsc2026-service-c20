#!/bin/sh
# Closes exploit variant 1 (exploit_zkp_sumcheck_rounds, V1): pin the relation
# sumcheck's round count/degree so a forged count can no longer overwrite the
# relation anchor and authenticate as another player. Leaves V2/V3 exploitable.
# Runs with the working directory set to the copy of service/.
set -eu

if grep -q 'def _valid_zkp_sumcheck_rounds' backend/app.py; then
    echo "exploit_zkp_sumcheck_rounds patch already applied" >&2
    exit 0
fi

patch -p2 <"$(dirname "$0")/exploit_zkp_sumcheck_rounds.patch"
