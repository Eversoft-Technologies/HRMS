"""Record who sent a candidate's follow-up email.

``followup_sent`` has been on this model from the start and nothing ever wrote
to it, so the flag meaning "this candidate has been told their outcome" was
permanently False. The outcome mail also goes out over a shared SMTP mailbox,
which means the sent message itself does not identify the sender either.

Three additive columns, defaulting to ''/NULL, so existing rows stay valid and
simply read as "sent by nobody recorded" rather than being attributed to
whoever scheduled the interview.
"""


from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0049_backfill_interview_creator_from_audit'),
    ]

    operations = [
        migrations.AddField(
            model_name='interviewlink',
            name='followup_sent_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='interviewlink',
            name='followup_sent_by_email',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='interviewlink',
            name='followup_sent_by_name',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
    ]
