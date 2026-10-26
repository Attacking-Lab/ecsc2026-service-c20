#!/bin/sh
# Generate the shipped service/ from the sources in meta/service.
#
# CI (prepare_service) runs this, then snapshots service/; run it locally the
# same way before `docker compose -f service/compose.yaml up --build`. The
# copy drops the developer-only files, strips every comment and docstring, and
# replaces the browser modules with one minified esbuild bundle (the vendored
# crypto under web/vendor ships untouched, with its licenses).
#
# The CI image only has docker, so python and node run in throwaway
# containers, as the calling user so the output stays theirs.
set -eu

meta=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname -- "$meta")
src=$meta/service
out=$root/service
user="$(id -u):$(id -g)"

rm -rf "$out"
mkdir -p "$out"

# Everything but the developer conveniences, local leftovers (a dev .env holds
# the admin key) and the browser sources (rebuilt below).
(cd "$src" && tar cf - \
    --exclude=./justfile \
    --exclude=./compose.dev.yaml \
    --exclude=./frontend/justfile \
    --exclude=./frontend/README.md \
    --exclude=./frontend/.gitignore \
    --exclude=./frontend/package.json \
    --exclude=./frontend/package-lock.json \
    --exclude=./frontend/node_modules \
    --exclude=./frontend/tests \
    --exclude=./frontend/tools \
    --exclude=./frontend/web \
    --exclude=__pycache__ \
    --exclude='*.pyc' \
    --exclude=.venv \
    --exclude=.ruff_cache \
    --exclude='*.egg-info' \
    --exclude=room_override.json \
    --exclude=.env \
    --exclude=.pytest_cache \
    --exclude=.mypy_cache \
    .) | (cd "$out" && tar xf -)

# The browser files that ship as they are.
mkdir -p "$out/frontend/web"
cp -R "$src/frontend/web/index.html" "$src/frontend/web/favicon.svg" \
    "$src/frontend/web/fonts" "$src/frontend/web/vendor" "$out/frontend/web/"

docker run --rm --user "$user" -v "$root:/w" -w /w python:3.12-alpine \
    python meta/strip_comments.py service

# main.js and everything it imports, minified into main.js plus the lazily
# loaded crypto chunks; ./vendor/* stays external so its modules still find
# their .wasm next to them.
docker run --rm --user "$user" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
    -v "$root:/w" -w /w/meta/service/frontend node:22-alpine sh -c '
    npm ci --no-audit --no-fund --loglevel=error &&
    npx esbuild web/main.js --bundle --splitting --format=esm --minify \
        --legal-comments=none --external:./vendor/* \
        --entry-names=[name] --chunk-names=chunk-[hash] \
        --outdir=/w/service/frontend/web &&
    npx esbuild web/style.css --minify --legal-comments=none \
        --outfile=/w/service/frontend/web/style.css'
