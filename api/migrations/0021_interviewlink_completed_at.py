from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0020_jobformtemplate_masterdataset_jobpost_custom_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='interviewlink',
            name='completed_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
