"""Add pin and reply-thread columns to chat_messages.

The ``develop`` branch extended ChatMessage with:
  - is_pinned / pinned_by / pinned_at / pin_expires_at  (WhatsApp-style pinning)
  - reply_to_id / reply_to_sender / reply_to_text       (threaded replies)

These were never captured in a migration, so the columns are absent from any
database that was set up before this branch.  The table is ``managed = False``,
so we add the columns explicitly here using the same idempotent
``information_schema`` check used in 0045.

Safe to re-run: columns are only ALTERed in when missing.
Reverse is a no-op — dropping message data on rollback is unacceptable.
"""
from django.db import migrations


# (table, column, DDL)
NEW_COLUMNS = [
    # ── Pinning ──────────────────────────────────────────────────────────────
    ('chat_messages', 'is_pinned',
     '`is_pinned` TINYINT(1) NOT NULL DEFAULT 0'),
    ('chat_messages', 'pinned_by',
     '`pinned_by` VARCHAR(255) NULL'),
    ('chat_messages', 'pinned_at',
     '`pinned_at` DATETIME NULL'),
    ('chat_messages', 'pin_expires_at',
     '`pin_expires_at` DATETIME NULL'),
    # ── Reply threading ───────────────────────────────────────────────────────
    ('chat_messages', 'reply_to_id',
     '`reply_to_id` INT NULL'),
    ('chat_messages', 'reply_to_sender',
     '`reply_to_sender` VARCHAR(255) NULL'),
    ('chat_messages', 'reply_to_text',
     '`reply_to_text` VARCHAR(500) NULL'),
]


def add_missing_columns(apps, schema_editor):
    """Add each column only where it is absent — idempotent and safe on DBs
    that were already patched by hand."""
    with schema_editor.connection.cursor() as cursor:
        for table, column, ddl in NEW_COLUMNS:
            cursor.execute(
                """
                SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME   = %s
                   AND COLUMN_NAME  = %s
                """,
                [table, column],
            )
            if cursor.fetchone()[0] == 0:
                cursor.execute(
                    'ALTER TABLE `%s` ADD COLUMN %s' % (table, ddl)
                )


def noop(apps, schema_editor):
    """Reverse is intentionally a no-op — dropping chat data is unacceptable."""


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0051_interview_created_at_business_clock'),
    ]

    operations = [
        migrations.RunPython(add_missing_columns, noop),
    ]
