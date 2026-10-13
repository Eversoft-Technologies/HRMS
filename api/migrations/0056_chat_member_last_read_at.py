"""Add last_read_at column to chat_members table.

This migration ensures the chat_members.last_read_at column is added to the
underlying database. Since ChatMember is marked `managed = False`, standard
Django schema migrations do not auto-generate alterations for it. This migration
runs an idempotent check against information_schema and executes the DDL if
missing, making it fully compatible with automated deploy pipelines (CI/CD).
"""
from django.db import migrations

from ._sqlite_compat import add_column_if_missing


def add_last_read_at(apps, schema_editor):
    """Add last_read_at column if it does not already exist."""
    add_column_if_missing(
        schema_editor.connection,
        'chat_members',
        'last_read_at',
        '`last_read_at` DATETIME NULL',
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
