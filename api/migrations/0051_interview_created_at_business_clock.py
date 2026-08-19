"""Stamp interview_links.created_at on the business clock.

``auto_now_add`` fills the column with ``datetime.now()`` — the *host's* local
time — while every report that buckets these rows into days, weeks and custom
windows asks ``local_today()``, which is ``settings.TIME_ZONE``. The two agree
on the deploy host (UTC on both counts) and disagree by hours on any machine
that is not, so an interview scheduled inside that gap was written with
tomorrow's date and vanished from the Today filter on its own report.

Nothing is rewritten: existing rows keep whatever clock stamped them, because
which host wrote each one is not recorded and guessing would move real dates.
Only new rows are affected.
"""


import api.timeutil
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0050_followup_sender'),
    ]

    operations = [
        migrations.AlterField(
            model_name='interviewlink',
            name='created_at',
            field=models.DateTimeField(default=api.timeutil.local_now),
        ),
    ]
