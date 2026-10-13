"""Add Task Tracker "New Task" form fields to employee_tasks.

Idempotent against information_schema (like 0059_attendance_ticket_fields) so
it is safe to run against a database where a column of the same name was
already added by hand or by a prior experiment, while state_operations keep
Django's model state in sync.
"""
from django.db import migrations, models

from ._sqlite_compat import add_column_if_missing


TABLE = 'employee_tasks'
COLUMNS = [
    ('task_code', "VARCHAR(40) NOT NULL DEFAULT ''"),
    ('team_lead', "VARCHAR(255) NOT NULL DEFAULT ''"),
    ('department', "VARCHAR(120) NOT NULL DEFAULT ''"),
    ('estimated_hours', 'DOUBLE NULL'),
    ('progress', 'INT NOT NULL DEFAULT 0'),
    ('attachment_file_name', "VARCHAR(255) NOT NULL DEFAULT ''"),
    ('attachment_file_mime', "VARCHAR(100) NOT NULL DEFAULT ''"),
    ('attachment_file_data', 'LONGTEXT NULL'),
    ('image_file_name', "VARCHAR(255) NOT NULL DEFAULT ''"),
    ('image_file_mime', "VARCHAR(100) NOT NULL DEFAULT ''"),
    ('image_file_data', 'LONGTEXT NULL'),
    ('reject_reason', 'LONGTEXT NULL'),
]


def add_columns(apps, schema_editor):
    for name, ddl in COLUMNS:
        add_column_if_missing(schema_editor.connection, TABLE, name, ddl)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0062_worksubmission_review_file_data_and_more'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name='employeetask',
                    name='task_code',
                    field=models.CharField(blank=True, default='', max_length=40),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='team_lead',
                    field=models.CharField(blank=True, default='', max_length=255),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='department',
                    field=models.CharField(blank=True, default='', max_length=120),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='estimated_hours',
                    field=models.FloatField(blank=True, null=True),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='progress',
                    field=models.IntegerField(default=0),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='attachment_file_name',
                    field=models.CharField(blank=True, default='', max_length=255),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='attachment_file_mime',
                    field=models.CharField(blank=True, default='', max_length=100),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='attachment_file_data',
                    field=models.TextField(blank=True, default=''),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='image_file_name',
                    field=models.CharField(blank=True, default='', max_length=255),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='image_file_mime',
                    field=models.CharField(blank=True, default='', max_length=100),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='image_file_data',
                    field=models.TextField(blank=True, default=''),
                ),
                migrations.AddField(
                    model_name='employeetask',
                    name='reject_reason',
                    field=models.TextField(blank=True, default=''),
                ),
            ],
            database_operations=[
                migrations.RunPython(add_columns, noop),
            ],
        ),
    ]
