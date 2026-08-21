"""Adds chat_members.last_read_at via Django's DB connection. Run: python run_chat_v6_migration.py"""
import os, django
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "hrms_project.settings")
django.setup()
from django.db import connection  # noqa: E402
with connection.cursor() as c:
    c.execute("""SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='chat_members' AND COLUMN_NAME='last_read_at'""")
    if c.fetchone()[0]:
        print("• last_read_at already present — skipped")
    else:
        c.execute("ALTER TABLE `chat_members` ADD COLUMN `last_read_at` DATETIME NULL")
        print("✓ last_read_at added")
print("Done. Restart Django and hard-refresh.")
