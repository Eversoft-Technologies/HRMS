# pyrefly: ignore [missing-import]
from django.db import migrations, models

from ._sqlite_compat import is_sqlite, table_exists


# The `app_users` table is also created by database/hrms_system_schema.sql, so on
# an existing production DB it already exists. We therefore split this migration:
#   - database_operations: CREATE TABLE IF NOT EXISTS  -> no-op on existing DBs,
#     creates the table on a brand-new DB. Never errors with "table exists".
#   - state_operations: CreateModel -> teaches Django's migration state about the
#     AppUser model so future migrations and the ORM stay in sync.
CREATE_APP_USERS = """
CREATE TABLE IF NOT EXISTS app_users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  full_name  VARCHAR(255)  NOT NULL,
  email      VARCHAR(255)  NOT NULL,
  password   VARCHAR(255)  NOT NULL,
  initials   VARCHAR(10)   NOT NULL DEFAULT '',
  role       VARCHAR(40)   NOT NULL DEFAULT 'admin',
  status     VARCHAR(20)   NOT NULL DEFAULT 'active',
  created_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_app_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""

SQLITE_CREATE_APP_USERS = """
CREATE TABLE IF NOT EXISTS app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  initials TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (email)
);
"""

# Demo seed admin removed. All users must be created explicitly via the API or admin UI.
SEED_ADMIN = """
SELECT 1;
"""  # No-op query

DROP_APP_USERS = "DROP TABLE IF EXISTS app_users;"


def ensure_app_users(apps, schema_editor):
    connection = schema_editor.connection
    if is_sqlite(connection):
        if not table_exists(connection, 'app_users'):
            with connection.cursor() as cursor:
                cursor.execute(SQLITE_CREATE_APP_USERS)
        return

    with connection.cursor() as cursor:
        cursor.execute(CREATE_APP_USERS)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0001_initial'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(ensure_app_users, reverse_code=migrations.RunPython.noop),
                migrations.RunSQL(sql=SEED_ADMIN, reverse_sql=migrations.RunSQL.noop),
            ],
            state_operations=[
                migrations.CreateModel(
                    name='AppUser',
                    fields=[
                        ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                        ('full_name', models.CharField(max_length=255)),
                        ('email', models.CharField(max_length=255, unique=True)),
                        ('password', models.CharField(max_length=255)),
                        ('initials', models.CharField(blank=True, default='', max_length=10)),
                        ('role', models.CharField(default='admin', max_length=40)),
                        ('status', models.CharField(default='active', max_length=20)),
                        ('created_at', models.DateTimeField(auto_now_add=True)),
                        ('updated_at', models.DateTimeField(auto_now=True)),
                    ],
                    options={
                        'db_table': 'app_users',
                        'ordering': ['id'],
                    },
                ),
            ],
        ),
    ]
