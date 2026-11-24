"""Server-side speech-to-text (Deepgram) for interview recordings."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        # Also merges the two 0086 branches (they were both cut from 0085).
        ('api', '0086_employee_directory_entry'),
        ('api', '0086_file_presence_flags'),
    ]

    operations = [
        migrations.AddField(
            model_name='interviewrecording', name='stt_status',
            field=models.CharField(blank=True, db_index=True, default='', max_length=20)),
        migrations.AddField(
            model_name='interviewrecording', name='stt_transcript',
            field=models.TextField(blank=True, null=True)),
        migrations.AddField(
            model_name='interviewrecording', name='stt_segments',
            field=models.JSONField(blank=True, null=True)),
        migrations.AddField(
            model_name='interviewrecording', name='stt_answers',
            field=models.JSONField(blank=True, null=True)),
        migrations.AddField(
            model_name='interviewrecording', name='stt_error',
            field=models.CharField(blank=True, default='', max_length=500)),
        migrations.AddField(
            model_name='interviewrecording', name='stt_at',
            field=models.DateTimeField(blank=True, null=True)),
    ]
