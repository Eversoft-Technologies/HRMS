from django.db import migrations, models

INDEX_NAME = 'att_event_email_date_idx'


def add_index_if_missing(apps, schema_editor):
    """Add the (email, date) index, unless a database already has it.

    This migration was first numbered 0085. A database that ran it under that
    name (a developer's local MySQL) has the index but no record of 0094, so a
    plain AddIndex failed there with "Duplicate key name". Checking first makes
    the migration safe on both kinds of database.
    """
    model = apps.get_model('api', 'AttendanceEvent')
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        existing = connection.introspection.get_constraints(cursor, model._meta.db_table)
    if INDEX_NAME in existing:
        return
    schema_editor.add_index(model, models.Index(fields=['email', 'date'], name=INDEX_NAME))


def drop_index_if_present(apps, schema_editor):
    model = apps.get_model('api', 'AttendanceEvent')
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        existing = connection.introspection.get_constraints(cursor, model._meta.db_table)
    if INDEX_NAME not in existing:
        return
    schema_editor.remove_index(model, models.Index(fields=['email', 'date'], name=INDEX_NAME))


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0093_phase3_permissions'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            # The model state always gains the index; only the database step is conditional.
            state_operations=[
                migrations.AddIndex(
                    model_name='attendanceevent',
                    index=models.Index(fields=['email', 'date'], name=INDEX_NAME),
                ),
            ],
            database_operations=[
                migrations.RunPython(add_index_if_missing, drop_index_if_present),
            ],
        ),
    ]
