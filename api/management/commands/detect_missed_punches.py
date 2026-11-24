"""Flag incomplete attendance days and notify (missed punches).

Idempotent: a day is flagged once, the employee is told once per day-issue,
and the manager gets one reminder after the regularization deadline passes.
Safe every 15 minutes, e.g. (cPanel cron, server local time):

    */15 * * * * cd <release> && <venv>/bin/python manage.py detect_missed_punches

The same detection also runs for one employee whenever their HRMS page polls
notifications, so it keeps working (more lazily) without cron.

  python manage.py detect_missed_punches                    # look back `lookback_days`
  python manage.py detect_missed_punches --date 2026-11-18  # one day only
  python manage.py detect_missed_punches --dry-run          # report, change nothing
"""
from django.core.management.base import BaseCommand, CommandError

from api.attendance_ext import missed_punch
from api.timeutil import local_now


class Command(BaseCommand):
    help = 'Flag missed punches (missing check-out / check-in, early exit) and notify once.'

    def add_arguments(self, parser):
        parser.add_argument('--date', help='YYYY-MM-DD: check only this work day')
        parser.add_argument('--email', help='Only this employee')
        parser.add_argument('--dry-run', action='store_true', help='Report what would change; write/send nothing')

    def handle(self, *args, **o):
        from api.views import parse_date
        on_date = None
        if o.get('date'):
            on_date = parse_date(o['date'])
            if not on_date:
                raise CommandError('--date must be YYYY-MM-DD.')
        now = local_now()
        pol = missed_punch.policy()
        if not pol.get('enabled'):
            self.stdout.write('Missed-punch detection is disabled in the policy; nothing to do.')
            return
        email = (o.get('email') or '').strip().lower() or None
        results = missed_punch.detect(now=now, email=email, on_date=on_date, dry_run=o['dry_run'])
        mode = 'DRY RUN — ' if o['dry_run'] else ''
        self.stdout.write(f'{mode}{now:%Y-%m-%d %H:%M} missed-punch sweep'
                          + (f' for {on_date}' if on_date else f' (last {pol["lookback_days"]} days)'))
        for att, action in results:
            self.stdout.write(f'  {att.date} {att.email:<40} {action}')
        self.stdout.write(f'{len(results)} action(s).')
