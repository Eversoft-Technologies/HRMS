"""Create the Employee Chat tables through a migration.

The chat module shipped its schema as three hand-run .sql files. Its models are
``managed = False``, so ``makemigrations`` produces nothing for them — I checked:
the generated migration creates zero tables and silently drops every ForeignKey.
That is why the SQL exists.

The cost is that the schema sits outside the deploy pipeline. `.github/workflows`
runs ``migrate`` in each new release directory and refuses to flip the symlink if
it fails — a good safety net that chat opts out of. So ``migrate`` passes, the
release goes live, and every chat endpoint 500s until somebody remembers to SSH
in and run three files. That has now happened on production repeatedly.

``managed = False`` only stops Django from GENERATING schema operations. It does
not stop a migration from executing DDL, so the same statements run here and the
pipeline takes care of every environment.

Idempotent, because these tables already exist wherever someone ran the SQL by
hand: CREATE TABLE uses IF NOT EXISTS, and columns are added only when absent.
The v2/v3 files did that check with a stored procedure and DELIMITER, which is a
mysql-client directive and cannot travel through Django's cursor — the same
check is done here against information_schema instead.

Reverse is a no-op ON PURPOSE. Rolling this back would drop every message and
meeting in the company, and no rollback is worth that.
"""
from django.db import migrations


TABLES = [
    """
    CREATE TABLE IF NOT EXISTS `chat_rooms` (
      `id`         INT AUTO_INCREMENT PRIMARY KEY,
      `name`       VARCHAR(255)  NOT NULL DEFAULT '',
      `is_group`   TINYINT(1)    NOT NULL DEFAULT 0,
      `created_by` VARCHAR(255)  NOT NULL DEFAULT '',
      `created_at` DATETIME      NULL,
      `is_private` TINYINT(1)    NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS `chat_members` (
      `id`             INT AUTO_INCREMENT PRIMARY KEY,
      `employee_email` VARCHAR(255) NOT NULL,
      `room_id`        INT          NOT NULL,
      `joined_at`      DATETIME     NULL,
      INDEX `chat_members_room_idx`  (`room_id`),
      INDEX `chat_members_email_idx` (`employee_email`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS `chat_messages` (
      `id`           INT AUTO_INCREMENT PRIMARY KEY,
      `sender_email` VARCHAR(255) NOT NULL,
      `sender_name`  VARCHAR(255) NOT NULL DEFAULT '',
      `room_id`      INT          NOT NULL,
      `message`      TEXT         NOT NULL,
      `is_read`      TINYINT(1)   NOT NULL DEFAULT 0,
      `created_at`   DATETIME     NULL,
      INDEX `chat_messages_room_idx` (`room_id`),
      INDEX `chat_messages_room_created_idx` (`room_id`, `created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS `chat_meetings` (
      `id`               INT AUTO_INCREMENT PRIMARY KEY,
      `room_id`          INT          NULL,
      `title`            VARCHAR(255) NOT NULL,
      `description`      TEXT         NULL,
      `scheduled_at`     DATETIME     NOT NULL,
      `duration_minutes` INT          NOT NULL DEFAULT 30,
      `created_by`       VARCHAR(255) NOT NULL DEFAULT '',
      `created_by_name`  VARCHAR(255) NOT NULL DEFAULT '',
      `join_url`         VARCHAR(512) NOT NULL DEFAULT '',
      `attendees`        TEXT         NULL,
      `created_at`       DATETIME     NULL,
      INDEX `chat_meetings_room_idx`  (`room_id`),
      INDEX `chat_meetings_when_idx`  (`scheduled_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
]

#: (table, column, DDL) — the columns chat_migrations_v2/v3 add to the v1 tables.
COLUMNS = [
    ('chat_messages', 'edited', '`edited` TINYINT(1) NOT NULL DEFAULT 0'),
    ('chat_messages', 'edited_at', '`edited_at` DATETIME NULL'),
    ('chat_messages', 'is_deleted', '`is_deleted` TINYINT(1) NOT NULL DEFAULT 0'),
    ('chat_messages', 'attachment_name', '`attachment_name` VARCHAR(255) NULL'),
    ('chat_messages', 'attachment_type', '`attachment_type` VARCHAR(100) NULL'),
    ('chat_messages', 'attachment_data', '`attachment_data` LONGTEXT NULL'),
    ('chat_messages', 'attachment_path', '`attachment_path` VARCHAR(512) NULL'),
    ('chat_members', 'is_admin', '`is_admin` TINYINT(1) NOT NULL DEFAULT 0'),
]


def add_missing_columns(apps, schema_editor):
    """Add each column only where it is absent, so this is safe to re-run and
    safe on databases where the SQL files were already applied by hand."""
    with schema_editor.connection.cursor() as cursor:
        for table, column, ddl in COLUMNS:
            cursor.execute(
                """
                SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = %s AND COLUMN_NAME = %s
                """,
                [table, column],
            )
            if cursor.fetchone()[0] == 0:
                cursor.execute('ALTER TABLE `%s` ADD COLUMN %s' % (table, ddl))


def noop(apps, schema_editor):
    """Deliberately does nothing — see the module docstring."""


class Migration(migrations.Migration):
    dependencies = [('api', '0044_home_geofences')]

    operations = [
        migrations.RunSQL(sql=TABLES, reverse_sql=migrations.RunSQL.noop),
        migrations.RunPython(add_missing_columns, noop),
    ]
