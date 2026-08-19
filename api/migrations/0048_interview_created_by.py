"""Record who scheduled an interview.

The KPI dashboard has always had a "My View" scope and a per-recruiter
leaderboard, and both were keyed on ``interview_links.interviewer`` — the free
text typed on the scheduling form. That field names whoever will *conduct* the
interview ("HR Team", "Eva AI", a panel), so:

  * ``scope=me`` filtered ``interviewer__iexact=<caller's email>`` and matched
    nothing at all, for everybody. Every recruiter's own dashboard was empty;
  * the leaderboard grouped by whatever string was typed, so one person spelling
    their name three ways became three separate "recruiters".

Two columns, both additive and both defaulting to '', so existing rows stay
valid and keep falling back to ``interviewer`` in the dashboard rather than
disappearing from it.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0047_chat_admin_backfill'),
    ]

    operations = [
        migrations.AddField(
            model_name='interviewlink',
            name='created_by_email',
            field=models.CharField(blank=True, db_index=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='interviewlink',
            name='created_by_name',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
    ]
