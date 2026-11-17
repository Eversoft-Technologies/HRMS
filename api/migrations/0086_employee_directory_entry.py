from django.db import migrations, models
import django.db.models.deletion


def create_directory_entries(apps, schema_editor):
    database = schema_editor.connection.alias
    UserProfile = apps.get_model('api', 'UserProfile')
    EmployeeDirectoryEntry = apps.get_model('api', 'EmployeeDirectoryEntry')
    emails = UserProfile.objects.using(database).values_list('email', flat=True)
    EmployeeDirectoryEntry.objects.using(database).bulk_create(
        [EmployeeDirectoryEntry(profile_id=email) for email in emails],
        ignore_conflicts=True,
    )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0085_merge_20261112_2202'),
    ]

    operations = [
        migrations.CreateModel(
            name='EmployeeDirectoryEntry',
            fields=[
                ('profile', models.OneToOneField(
                    db_column='email',
                    on_delete=django.db.models.deletion.CASCADE,
                    primary_key=True,
                    related_name='directory_entry',
                    serialize=False,
                    to='api.userprofile',
                )),
            ],
            options={
                'db_table': 'employee_directory_entries',
            },
        ),
        migrations.RunPython(create_directory_entries, migrations.RunPython.noop),
    ]
