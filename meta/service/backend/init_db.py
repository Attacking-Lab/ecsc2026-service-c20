"""Create the database schema once before web and maintenance processes start."""

from time import sleep

from .database import app, db


def main(attempts=10, delay=1):
    for attempt in range(attempts):
        try:
            with app.app_context():
                db.create_all()
            return
        except Exception:
            if attempt + 1 == attempts:
                raise
            sleep(delay)


if __name__ == "__main__":
    main()
