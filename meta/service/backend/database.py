"""Database configuration and models shared by the web and maintenance jobs."""

import os

from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import deferred


app = Flask("c20_backend")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "your_secret_key_here")
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_BODY_BYTES", str(256 * 1024)))
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://user:password@db:5432/flaskdb",
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_size": int(os.environ.get("DB_POOL_SIZE", "1")),
    "max_overflow": int(os.environ.get("DB_MAX_OVERFLOW", "0")),
    "pool_timeout": int(os.environ.get("DB_POOL_TIMEOUT", "10")),
    "pool_recycle": int(os.environ.get("DB_POOL_RECYCLE", "300")),
    "pool_pre_ping": True,
}

db = SQLAlchemy(app)


class Player(db.Model):
    __tablename__ = "players"

    uid = db.Column(db.String(32), primary_key=True)
    public_key = deferred(db.Column(db.LargeBinary, nullable=False))
    private_key = deferred(db.Column(db.LargeBinary, nullable=True))
    timestamp = db.Column(db.DateTime, server_default=db.func.now(), index=True)


class Game(db.Model):
    __tablename__ = "games"

    name = db.Column(db.String(64), primary_key=True)
    description = db.Column(db.Text, nullable=False)
    owner_uid = db.Column(
        db.String(32), db.ForeignKey("players.uid"), nullable=False, index=True
    )
    roll_ciphertext = deferred(db.Column(db.LargeBinary, nullable=False))
    owner_afk = db.Column(db.Boolean, nullable=False, default=False)
    afk_token = db.Column(db.LargeBinary, nullable=True)
    timestamp = db.Column(db.DateTime, server_default=db.func.now(), index=True)


class GamePlayer(db.Model):
    __tablename__ = "game_players"
    __table_args__ = (
        db.UniqueConstraint("game_name", "uid", name="uq_game_players_game_uid"),
        db.Index("ix_game_players_uid_game", "uid", "game_name"),
        db.Index("ix_game_players_game_timestamp_id", "game_name", "timestamp", "id"),
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    game_name = db.Column(
        db.String(64), db.ForeignKey("games.name"), nullable=False, index=True
    )
    uid = db.Column(
        db.String(32), db.ForeignKey("players.uid"), nullable=False, index=True
    )
    private_note = db.Column(db.Text, nullable=False, default="")
    timestamp = db.Column(db.DateTime, server_default=db.func.now(), index=True)


class Message(db.Model):
    __tablename__ = "messages"
    __table_args__ = (
        db.Index("ix_messages_game_kind_id", "game_name", "kind", "id"),
        db.Index("ix_messages_game_recipient_id", "game_name", "recipient_uid", "id"),
        db.Index("ix_messages_game_sender_id", "game_name", "sender_uid", "id"),
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    game_name = db.Column(
        db.String(64), db.ForeignKey("games.name"), nullable=False, index=True
    )
    sender_uid = db.Column(
        db.String(32), db.ForeignKey("players.uid"), nullable=True, index=True
    )
    recipient_uid = db.Column(
        db.String(32), db.ForeignKey("players.uid"), nullable=True, index=True
    )
    kind = db.Column(db.String(32), nullable=False, index=True)
    content = db.Column(db.Text, nullable=False)
    resolved = db.Column(db.Boolean, nullable=False, default=False)
    timestamp = db.Column(db.DateTime, server_default=db.func.now(), index=True)
