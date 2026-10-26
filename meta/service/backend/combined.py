"""Unified ASGI application with no network proxy between its components."""

import os

from a2wsgi import WSGIMiddleware
from flask import Flask
from werkzeug.middleware.dispatcher import DispatcherMiddleware

from c20_frontend.flask_app import frontend

from . import realtime, tokens
from .app import app as c20_app
from .body_buffer import BodyTooLarge, buffer_http_body, replay_body

tokens.install(c20_app)

frontend_app = Flask("c20_frontend")
frontend_app.register_blueprint(frontend)

# Werkzeug adjusts SCRIPT_NAME/PATH_INFO and calls the selected Flask app
# directly. The public API keeps its established /c20 prefix without another
# HTTP server, client, connection pool, or serialization hop.
wsgi_application = DispatcherMiddleware(frontend_app, {"/c20": c20_app})

# Uvicorn owns every client socket. The bounded executor keeps synchronous
# Flask work from blocking Uvicorn's event loop.
_wsgi_asgi = WSGIMiddleware(
    wsgi_application,
    workers=int(os.environ.get("WEB_THREADS", "10")),
)

MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(256 * 1024)))
REQUEST_BODY_TIMEOUT = float(os.environ.get("REQUEST_BODY_TIMEOUT", "10"))


async def _send_body_error(send, status: int, message: str) -> None:
    body = message.encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"text/plain; charset=utf-8"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def application(scope, receive, send):
    """Serve the realtime WebSocket and lifespan on the event loop; everything
    else falls through to the synchronous Flask stack via a2wsgi."""
    kind = scope["type"]
    if kind == "lifespan":
        await realtime.lifespan(scope, receive, send)
        return
    if kind == "websocket":
        if scope.get("path", "").startswith(realtime.PATH_PREFIX):
            await realtime.ws_app(scope, receive, send)
        else:
            await send({"type": "websocket.close", "code": 1000})
        return
    if kind != "http":
        return

    try:
        body = await buffer_http_body(
            scope,
            receive,
            max_bytes=MAX_BODY_BYTES,
            timeout=REQUEST_BODY_TIMEOUT,
        )
    except BodyTooLarge:
        await _send_body_error(send, 413, "Request body too large")
        return
    except TimeoutError:
        await _send_body_error(send, 408, "Request body timed out")
        return

    if body is None:
        return
    await _wsgi_asgi(scope, replay_body(body), send)
