# Generated for Interview Recording File Storage Architecture

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0066_merge_20260910_1919'),
    ]

    operations = [
        migrations.AddField(
            model_name='interviewrecording',
            name='video_file',
            field=models.CharField(blank=True, max_length=500, null=True),
        ),
        migrations.AddField(
            model_name='interviewrecording',
            name='video_url',
            field=models.CharField(blank=True, max_length=500, null=True),
        ),
        migrations.AddField(
            model_name='interviewrecording',
            name='video_size',
            field=models.BigIntegerField(blank=True, default=0, null=True),
        ),
        migrations.AddField(
            model_name='interviewrecording',
            name='thumbnail_file',
            field=models.CharField(blank=True, max_length=500, null=True),
        ),
    ]
