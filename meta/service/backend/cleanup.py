"""Database expiration loop for the service supervisor or a standalone run."""

from datetime import datetime, timedelta
import os
from time import sleep

from sqlalchemy import or_, text

from .database import Game, GamePlayer, Message, Player, app, db


def delete_old_entries():
    cutoff = datetime.now() - timedelta(
        seconds=int(os.environ.get("CLEANUP_TTL", "300"))
    )
    with app.app_context():
        try:
            elected = db.session.execute(
                text("SELECT pg_try_advisory_xact_lock(20192620)")
            ).scalar_one()
            if not elected:
                db.session.rollback()
                return

            player_uids = [
                uid
                for (uid,) in db.session.query(Player.uid)
                .filter(Player.timestamp < cutoff)
                .order_by(Player.uid)
                .with_for_update()
                .all()
            ]
            game_names = [
                name
                for (name,) in db.session.query(Game.name)
                .filter(or_(Game.timestamp < cutoff, Game.owner_uid.in_(player_uids)))
                .order_by(Game.name)
                .with_for_update()
                .all()
            ]
            db.session.query(Message).filter(
                or_(
                    Message.timestamp < cutoff,
                    Message.game_name.in_(game_names),
                    Message.sender_uid.in_(player_uids),
                    Message.recipient_uid.in_(player_uids),
                )
            ).delete(synchronize_session=False)
            db.session.query(GamePlayer).filter(
                or_(
                    GamePlayer.timestamp < cutoff,
                    GamePlayer.game_name.in_(game_names),
                    GamePlayer.uid.in_(player_uids),
                )
            ).delete(synchronize_session=False)
            db.session.query(Game).filter(Game.name.in_(game_names)).delete(
                synchronize_session=False
            )
            db.session.query(Player).filter(Player.uid.in_(player_uids)).delete(
                synchronize_session=False
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise


def main():
    interval = int(os.environ.get("CLEANUP_INTERVAL", "60"))
    while True:
        sleep(interval)
        delete_old_entries()


if __name__ == "__main__":
    main()
