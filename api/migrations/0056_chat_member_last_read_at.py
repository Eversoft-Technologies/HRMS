"""Add last_read_at column to chat_members table.

This migration ensures the chat_members.last_read_at column is added to the
underlying database. Since ChatMember is marked `managed = False`, standard
Django schema migrations do not auto-generate alterations for it. This migration
runs an idempotent check against information_schema and executes the DDL if
missing, making it fully compatible with automated deploy pipelines (CI/CD).
"""
from django.db import migrations


def add_last_read_at(apps, schema_editor):
    """Add last_read_at column if it does not already exist."""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME   = 'chat_members'
               AND COLUMN_NAME  = 'last_read_at'
            """
        )
        if cursor.fetchone()[0] == 0:
            cursor.execute(
                "ALTER TABLE `chat_members` ADD COLUMN `last_read_at` DATETIME NULL"
            )


def noop(apps, schema_editor):
    """Reverse is a no-op to preserve read receipt timestamps on rollback."""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0055_hrverification_address_verified_and_more'),
    ]

    operations = [
        migrations.RunPython(add_last_read_at, noop),
    ]
