#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/zkp_lib/docker-compose.yml"

docker compose -f "$compose_file" run --build --rm \
    --user "$(id -u):$(id -g)" builder

artifact="$script_dir/zkp_lib/zkp_lib.so"
cp "$artifact" "$script_dir/service/backend/zkp_lib.so"
cp "$artifact" "$script_dir/../client/zkp_lib.so"
cp "$artifact" "$script_dir/../checker/src/zkp_lib.so"
