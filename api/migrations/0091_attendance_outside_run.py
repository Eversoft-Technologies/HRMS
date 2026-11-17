"""Server-side evidence for automatic check-outs (outside-the-office run)."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0090_us_date_format'),
    ]

    operations = [
        migrations.AddField(
            model_name='employeeattendance', name='outside_since',
            field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(
            model_name='employeeattendance', name='outside_last_at',
            field=models.DateTimeField(blank=True, null=True)),
    ]
