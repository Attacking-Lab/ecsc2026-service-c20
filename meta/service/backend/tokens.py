"""Header tokens, so a browser client served by any team can talk to any
team's service.

A cross-site page cannot use the session cookie (browsers neither send nor
accept it there), so the same signed session also travels as a bearer token:
a response that changes the session (login, logout) carries it in TOKEN_HEADER,
and a request with `Authorization: Bearer <token>` is read from it instead of
the cookie. The routes keep using `session` as before, and cookie clients (the
checker, client.py) are unaffected.

CORS allows every origin but never credentials: cookies are not sent across
sites, so a foreign page can only act with a token it was explicitly given,
which is what keeps this free of CSRF.
"""

from flask import Flask
from flask.sessions import SecureCookieSessionInterface
from itsdangerous import BadSignature

TOKEN_HEADER = "X-C20-Token"


class HeaderSessionInterface(SecureCookieSessionInterface):
    def open_session(self, app, request):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return super().open_session(app, request)
        serializer = self.get_signing_serializer(app)
        if serializer is None:
            return None
        max_age = int(app.permanent_session_lifetime.total_seconds())
        try:
            return self.session_class(serializer.loads(auth[7:], max_age=max_age))
        except BadSignature:
            return self.session_class()

    def save_session(self, app, session, response):
        super().save_session(app, session, response)
        if session.modified:
            serializer = self.get_signing_serializer(app)
            response.headers[TOKEN_HEADER] = (
                serializer.dumps(dict(session)) if session else ""
            )


def install(app: Flask) -> None:
    app.session_interface = HeaderSessionInterface()

    @app.after_request
    def allow_any_origin(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Expose-Headers"] = TOKEN_HEADER
        response.headers["Access-Control-Max-Age"] = "600"
        return response
