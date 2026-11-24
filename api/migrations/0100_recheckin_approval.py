"""Re-check-in after an automatic (left-the-office) check-out needs the
manager's approval: columns on employee_attendance (see EmployeeAttendance)."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0099_attendance_policy_engine'),
    ]

    operations = [
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_status',
            field=models.CharField(blank=True, db_index=True, default='', max_length=20),
        ),
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_reason',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_after',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_held_minutes',
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_reviewer',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_reviewed_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='employeeattendance',
            name='recheckin_review_note',
            field=models.TextField(blank=True, default=''),
        ),
    ]
