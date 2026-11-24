"""IT asset alerts: warranties / licences ending within 30 days (in-app
notification to every assets.manage holder + one email digest), and
reminders to holders who have not acknowledged an asset after 3 days.

Each expiry is alerted once per asset and end date, so running this more
than once a day is harmless.

cron (daily, 08:30):
    30 8 * * * cd /path/to/HRMS && venv/bin/python manage.py asset_alerts
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from hrms_plus import assets


class Command(BaseCommand):
    help = 'Raise IT asset warranty / licence expiry alerts and acknowledgement reminders.'

    def add_arguments(self, parser):
        parser.add_argument('--no-email', action='store_true', help='In-app notifications only.')

    def handle(self, *args, **opts):
        with transaction.atomic():
            r = assets.run_alerts(send_mail=not opts['no_email'])
        self.stdout.write(f"asset_alerts: {r['alerts']} new expiry alert(s), {r['reminders']} acknowledgement "
                          f"reminder(s), {r['emailed']} digest email(s) sent")
