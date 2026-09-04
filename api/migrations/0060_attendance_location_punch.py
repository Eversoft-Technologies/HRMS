"""Create attendance_location_punches for hourly location tracking."""
from django.db import migrations, models


def create_table(apps, schema_editor):
    # Use the real model: inside SeparateDatabaseAndState the RunPython receives
    # the pre-migration state, which does not yet contain this migration's own
    # CreateModel, so apps.get_model(...) would raise LookupError.
    from api.models import AttendanceLocationPunch
    conn = schema_editor.connection
    with conn.cursor() as cursor:
        if 'attendance_location_punches' not in conn.introspection.table_names(cursor):
            schema_editor.create_model(AttendanceLocationPunch)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0059_attendance_ticket_fields'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.CreateModel(
                    name='AttendanceLocationPunch',
                    fields=[
                        ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                        ('email', models.CharField(db_index=True, max_length=255)),
                        ('employee_name', models.CharField(blank=True, default='', max_length=255)),
                        ('date', models.DateField(db_index=True)),
                        ('captured_at', models.DateTimeField(db_index=True)),
                        ('latitude', models.FloatField()),
                        ('longitude', models.FloatField()),
                        ('accuracy', models.FloatField(blank=True, null=True)),
                        ('label', models.CharField(blank=True, default='', max_length=255)),
                        ('source', models.CharField(blank=True, default='web', max_length=20)),
                        ('created_at', models.DateTimeField(auto_now_add=True)),
                    ],
                    options={
                        'db_table': 'attendance_location_punches',
                        'ordering': ['captured_at'],
                    },
                ),
            ],
            database_operations=[
                migrations.RunPython(create_table, noop),
            ],
        ),
    ]
