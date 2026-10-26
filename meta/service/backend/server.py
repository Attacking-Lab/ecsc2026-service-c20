"""Initialize the service, run cleanup, and supervise the web workers."""

import logging
import os
import secrets
import signal
from pathlib import Path
from threading import Thread

import uvicorn

from .cleanup import main as run_cleanup
from .database import app as flask_app
from .init_db import main as initialize_database


logger = logging.getLogger(__name__)


def _cleanup_worker() -> None:
    try:
        run_cleanup()
    except Exception:
        logger.exception("Database cleanup stopped unexpectedly")
        os.kill(os.getpid(), signal.SIGTERM)


def _ensure_secret_key() -> None:
    """Sessions (cookies and bearer tokens alike) are signed with SECRET_KEY, so
    a key anyone can guess lets anyone forge a login. Unless the operator sets
    one, generate a random key on first boot and keep it in the data volume, so
    sessions survive restarts. Workers are started after this and inherit it
    through the environment; this process already imported the app, so its
    config is updated too."""
    key = os.environ.get("SECRET_KEY")
    if not key:
        path = Path(os.environ.get("C20_SECRET_KEY_FILE", "/app/data/secret_key"))
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with os.fdopen(
                os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
            ) as f:
                f.write(secrets.token_hex(32))
            logger.info("Generated a new session secret at %s", path)
        except FileExistsError:
            pass
        key = path.read_text().strip()
        if not key:
            raise RuntimeError(f"{path} is empty; delete it to generate a new key")
        os.environ["SECRET_KEY"] = key
    flask_app.config["SECRET_KEY"] = key


def main() -> None:
    _ensure_secret_key()
    initialize_database()

    cleanup_thread = Thread(
        target=_cleanup_worker,
        name="database-cleanup",
        daemon=True,
    )
    cleanup_thread.start()

    reload_enabled = os.environ.get("C20_RELOAD", "").lower() in {
        "1",
        "true",
        "yes",
    }
    workers = 1 if reload_enabled else int(os.environ.get("WEB_CONCURRENCY", "1"))

    uvicorn.run(
        "backend.combined:application",
        host="0.0.0.0",
        port=int(os.environ.get("SERVICE_PORT", "9000")),
        backlog=4096,
        access_log=True,
        reload=reload_enabled,
        workers=workers,
    )


if __name__ == "__main__":
    main()
