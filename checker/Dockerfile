FROM ghcr.io/astral-sh/uv:python3.12-trixie

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

ADD pyproject.toml uv.lock .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

ADD src .

EXPOSE 8000

CMD ["uv", "run", "--no-sync", "--no-dev", "gunicorn", "-c", "gunicorn.conf.py", "checker:app()"]
