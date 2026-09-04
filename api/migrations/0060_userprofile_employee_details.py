from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0059_attendance_ticket_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='manager',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='level',
            field=models.CharField(blank=True, default='L4', max_length=20),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='employment_type',
            field=models.CharField(blank=True, default='Full-time', max_length=40),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='location',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='annual_ctc',
            field=models.DecimalField(blank=True, decimal_places=2, max_digits=14, null=True),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='start_date',
            field=models.DateField(blank=True, null=True),
        ),
    ]