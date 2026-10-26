FROM python:3.12-slim AS build

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv

WORKDIR /app

ENV UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

COPY frontend/pyproject.toml frontend/uv.lock ./
COPY frontend/src ./src
RUN uv sync --locked --no-dev
COPY backend/requirements.txt ./backend-requirements.txt
RUN uv pip install --python .venv/bin/python -r backend-requirements.txt

FROM python:3.12-slim

WORKDIR /app

ENV PATH=/app/.venv/bin:$PATH \
    PYTHONPATH=/app \
    C20_WEB_DIR=/app/web \
    C20_PIECES_DIR=/app/vendor/modern-interiors/character-pieces/16x16 \
    C20_ROOM_DIR=/app/vendor/modern-interiors/room \
    C20_ROOMS_FILE=/app/rooms.json \
    C20_ROOM_OVERRIDE=/app/data/room_override.json \
    C20_SECRET_KEY_FILE=/app/data/secret_key \
    C20_URL=http://service:9000

COPY --from=build /app/.venv /app/.venv
COPY backend/__init__.py \
     backend/app.py \
     backend/body_buffer.py \
     backend/cleanup.py \
     backend/combined.py \
     backend/database.py \
     backend/fhe.py \
     backend/init_db.py \
     backend/realtime.py \
     backend/server.py \
     backend/tokens.py \
     backend/zkp_lib.so \
     ./backend/
COPY frontend/src ./src
COPY frontend/web ./web
COPY frontend/vendor ./vendor
COPY frontend/rooms.json ./rooms.json

EXPOSE 9000

CMD ["python", "-m", "backend.server"]
