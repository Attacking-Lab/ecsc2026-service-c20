#!/bin/sh
# Closes exploit variant 0 (exploit_fhe): cache AFK responses, replace zero
# batching slots, and freshly encrypt suspicious ciphertexts.
# Runs with the working directory set to the copy of service/.
set -eu

if grep -q '^def configure_evaluation_cache' backend/fhe.py; then
    echo "exploit_fhe patch already applied" >&2
    exit 0
fi

patch -p2 <"$(dirname "$0")/exploit_fhe.patch"
