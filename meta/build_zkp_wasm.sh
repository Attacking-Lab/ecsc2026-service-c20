#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/zkp_lib/docker-compose.yml"

docker compose -f "$compose_file" run --build --rm \
    --user "$(id -u):$(id -g)" wasm-builder

vendor_dir="$script_dir/service/frontend/web/vendor/zkp"
mkdir -p "$vendor_dir"
cp "$script_dir/zkp_lib/zkp_lib.mjs" "$script_dir/zkp_lib/zkp_lib.wasm" "$vendor_dir"
