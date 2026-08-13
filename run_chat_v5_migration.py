"""
One-off migration runner for the Employee Chat pin-metadata columns.

Adds `pinned_by`, `pinned_at`, `pin_expires_at` to `chat_messages` using
Django's own database connection (so it reads the exact same .env config the
app uses). Idempotent — safe to run more than once; existing columns are
skipped.

    # from the repo root, with your virtualenv active:
    python run_chat_v5_migration.py
"""
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "hrms_project.settings")
django.setup()

from django.db import connection  # noqa: E402

TABLE = "chat_messages"
COLUMNS = [
    ("pinned_by", "VARCHAR(255) NULL"),
    ("pinned_at", "DATETIME NULL"),
    ("pin_expires_at", "DATETIME NULL"),
]


def column_exists(cursor, table, column):
    cursor.execute(
        """
        SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = %s
          AND COLUMN_NAME = %s
        """,
        [table, column],
    )
    return cursor.fetchone()[0] > 0


def main():
    with connection.cursor() as cursor:
        for name, ddl in COLUMNS:
            if column_exists(cursor, TABLE, name):
                print(f"• {name}: already present — skipped")
                continue
            cursor.execute(f"ALTER TABLE `{TABLE}` ADD COLUMN `{name}` {ddl}")
            print(f"✓ {name}: added")
    print("\nDone. Restart Django and hard-refresh the browser.")


if __name__ == "__main__":
    main()
