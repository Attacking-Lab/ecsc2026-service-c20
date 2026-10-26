#!/bin/sh
# Regenerate meta/service/NOTICE and checker/NOTICE.
#
# Rebuilds each image's Python environment the way its Dockerfile does (same
# lockfiles, Python 3.12, linux x86_64 wheels), lets pip-notice collect what is
# installed, applies the reviewed decisions in service.json / checker.json via
# resolve.py, and has pip-notice select and generate the file. The service's
# transitive dependencies are not locked, so its NOTICE reflects what resolves
# on the day it is generated, just like the image build.
#
# The checker's git dependencies come from git.atklab.cloud and need working
# credentials for it.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname -- "$(dirname -- "$here")")
pip_notice=pip-notice==0.1.6
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

render() { # <decisions.json> <venv> <NOTICE> [collect args...]
    decisions=$1 venv=$2 out=$3
    shift 3
    uv pip install --quiet --python "$venv/bin/python" "$pip_notice"
    "$venv/bin/pip-notice" collect -o "$work/raw.json" "$@"
    python3 "$here/resolve.py" "$decisions" "$work/raw.json" "$work/fixed.json" "$work/selection.json"
    "$venv/bin/pip-notice" select -s "$work/selection.json" -o "$work/licenses.json" "$work/fixed.json" </dev/null
    "$venv/bin/pip-notice" generate -o "$out" "$work/licenses.json"
}

mkdir "$work/service"
cp "$root/meta/service/frontend/pyproject.toml" "$root/meta/service/frontend/uv.lock" "$work/service/"
cp -r "$root/meta/service/frontend/src" "$work/service/"
(cd "$work/service" && uv sync --quiet --locked --no-dev --python 3.12)
uv pip install --quiet --python "$work/service/.venv/bin/python" -r "$root/meta/service/backend/requirements.txt"
render "$here/service.json" "$work/service/.venv" "$root/meta/service/NOTICE" -i c20-frontend

mkdir "$work/checker"
cp "$root/checker/pyproject.toml" "$root/checker/uv.lock" "$work/checker/"
(cd "$work/checker" && uv sync --quiet --locked --no-dev --no-install-project --python 3.12)
render "$here/checker.json" "$work/checker/.venv" "$root/checker/NOTICE"
