"""Bring the legacy ``interview_links`` columns into the Django model.

The Node→Django port left six columns in the table that the model never knew
about. Four of them are ``NOT NULL`` with no DB default, so under MySQL's
STRICT_TRANS_TABLES every ORM ``INSERT`` — i.e. every "create interview" —
failed with (1364) "Field 'final_question_count' doesn't have a default value".

Adding them to the model fixes the insert and restores the question-count /
coding-difficulty round-trip the AI interviewer depends on.

Databases are in one of two states:
  * legacy (created by the old Node server): the columns already exist
  * fresh (created by 0001_initial): the columns do not exist

MySQL 8 has no ``ADD COLUMN IF NOT EXISTS``, so each column is added through a
prepared statement guarded on information_schema. That makes this migration a
no-op on legacy databases and a real ALTER on fresh ones.
"""
from django.db import migrations, models

from ._sqlite_compat import add_column_if_missing


COLUMNS = [
    ('tech_question_count', 'int NOT NULL DEFAULT 3'),
    ('hr_question_count', 'int NOT NULL DEFAULT 3'),
    ('final_question_count', 'int NOT NULL DEFAULT 3'),
    ('coding_difficulty', 'json NULL DEFAULT NULL'),
    ('followup_sent', 'tinyint(1) NOT NULL DEFAULT 0'),
    ('invited_at', 'datetime NULL DEFAULT NULL'),
]


def add_columns(apps, schema_editor):
    for column, definition in COLUMNS:
        add_column_if_missing(schema_editor.connection, 'interview_links', column, definition)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0021_interviewlink_completed_at'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(add_columns, migrations.RunPython.noop),
            ],
            state_operations=[
                migrations.AddField(
                    model_name='interviewlink',
                    name='tech_question_count',
                    field=models.IntegerField(default=3),
                ),
                migrations.AddField(
                    model_name='interviewlink',
                    name='hr_question_count',
                    field=models.IntegerField(default=3),
                ),
                migrations.AddField(
                    model_name='interviewlink',
                    name='final_question_count',
                    field=models.IntegerField(default=3),
                ),
                migrations.AddField(
                    model_name='interviewlink',
                    name='coding_difficulty',
                    field=models.JSONField(blank=True, null=True),
                ),
                migrations.AddField(
                    model_name='interviewlink',
                    name='followup_sent',
                    field=models.BooleanField(default=False),
                ),
                migrations.AddField(
                    model_name='interviewlink',
                    name='invited_at',
                    field=models.DateTimeField(blank=True, null=True),
                ),
            ],
        ),
    ]
