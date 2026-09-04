from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0060_userprofile_employee_details'),
    ]

    operations = [
        # ResumeScore AI fields
        migrations.AddField(
            model_name='resumescore',
            name='ai_summary',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='resumescore',
            name='ai_strengths',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='resumescore',
            name='ai_gaps',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='resumescore',
            name='ai_evaluated',
            field=models.BooleanField(default=False),
        ),
        # InterviewRecording AI fields
        migrations.AddField(
            model_name='interviewrecording',
            name='ai_evaluation',
            field=models.JSONField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='interviewrecording',
            name='executive_summary',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='interviewrecording',
            name='round2_questions',
            field=models.JSONField(blank=True, null=True),
        ),
    ]
