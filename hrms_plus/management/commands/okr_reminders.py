"""Monday nudge: in-app "OKR check-in due" notifications for everyone with a
key result not yet updated this ISO week (one per person per week; safe to
re-run). Also brings task-linked milestone KRs up to date first.

Cron (Mondays 09:00 business time):
    0 9 * * 1  cd /path/to/HRMS && venv/bin/python manage.py okr_reminders
"""
from django.core.management.base import BaseCommand

from hrms_plus import okr


class Command(BaseCommand):
    help = 'Send this week\'s OKR check-in reminders (in-app notifications).'

    def handle(self, *args, **opts):
        moved = okr.refresh_milestones()
        sent = okr.send_checkin_reminders()
        self.stdout.write(f'okr_reminders: {len(sent)} reminder(s) sent for {okr.iso_week()}'
                          f' ({moved} milestone KR(s) refreshed)')
