"""Add forgot-punch ticket fields to attendance_corrections.

Adds `kind` and `proof_image` so an employee who forgot to check in/out can
raise a ticket with a reason and a photo of the attendance sheet. Idempotent
against information_schema so it is safe on databases where a column may
already exist, while the state_operations keep Django's model state in sync.
"""
from django.db import migrations, models


TABLE = 'attendance_corrections'
COLUMNS = [
    ('kind', "VARCHAR(20) NOT NULL DEFAULT ''"),
    ('proof_image', 'LONGTEXT NULL'),
]


def add_columns(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        for name, ddl in COLUMNS:
            cursor.execute(
                """
                SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME   = %s
                   AND COLUMN_NAME  = %s
                """,
                [TABLE, name],
            )
            if cursor.fetchone()[0] == 0:
                cursor.execute("ALTER TABLE `%s` ADD COLUMN `%s` %s" % (TABLE, name, ddl))


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0058_merge_20260825_2020'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name='attendancecorrection',
                    name='kind',
                    field=models.CharField(blank=True, default='', max_length=20),
                ),
                migrations.AddField(
                    model_name='attendancecorrection',
                    name='proof_image',
                    field=models.TextField(blank=True, null=True),
                ),
            ],
            database_operations=[
                migrations.RunPython(add_columns, noop),
            ],
        ),
    ]
