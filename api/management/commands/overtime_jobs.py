"""Overtime & comp-off jobs (api/attendance_ext/overtime.py).

    python manage.py overtime_jobs --expire                      # lapse expired, unused comp-off
    python manage.py overtime_jobs --evaluate 2026-11-01..2026-11-30 [--email a@b.com]
    python manage.py overtime_jobs --expire --evaluate 2026-11-01..2026-11-30 --dry-run

Suggested cron (server time):
    15 1 * * *  python manage.py overtime_jobs --expire
    30 1 * * *  python manage.py overtime_jobs --evaluate $(date -d yesterday +%F)..$(date -d yesterday +%F)

Both are idempotent. --dry-run does everything in a transaction that is rolled back.
"""
from datetime import datetime

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from api.attendance_ext import overtime as ot
from api.timeutil import local_today


def _d(s):
    try:
        return datetime.strptime(s.strip(), '%Y-%m-%d').date()
    except (AttributeError, ValueError):
        raise CommandError(f'Bad date {s!r}: use YYYY-MM-DD.')


class Command(BaseCommand):
    help = 'Overtime evaluation and comp-off expiry.'

    def add_arguments(self, parser):
        parser.add_argument('--expire', action='store_true', help='Lapse unused comp-off past its expiry date.')
        parser.add_argument('--evaluate', metavar='FROM..TO', help='Re-evaluate closed days in this range.')
        parser.add_argument('--email', help='Only this employee.')
        parser.add_argument('--today', help='Treat this date as today (YYYY-MM-DD) for --expire.')
        parser.add_argument('--dry-run', action='store_true', help='Compute and report, change nothing.')

    def handle(self, *args, **o):
        if not o['expire'] and not o['evaluate']:
            raise CommandError('Nothing to do: pass --expire and/or --evaluate FROM..TO.')
        today = _d(o['today']) if o.get('today') else local_today()
        with transaction.atomic():
            if o['evaluate']:
                parts = o['evaluate'].split('..')
                start = _d(parts[0])
                end = _d(parts[1]) if len(parts) > 1 and parts[1] else start
                if end < start:
                    raise CommandError('The range ends before it starts.')
                out = ot.evaluate_range(start, end, email=o.get('email'))
                self.stdout.write(f"evaluate {start}..{end}: {out['days']} closed day(s), {out['records']} with "
                                  f"overtime ({out['pending']} pending, {out['auto']} auto), comp-off "
                                  f"{out['compOffDays']} day(s), {out['stale']} stale record(s)")
            if o['expire']:
                lapsed = ot.expire(today, email=o.get('email'))
                for r in lapsed:
                    self.stdout.write(f"lapsed {r['days']} day(s) comp-off of {r['date']} for {r['email']}")
                self.stdout.write(f'expire (today {today}): {len(lapsed)} credit(s) lapsed')
            if o['dry_run']:
                transaction.set_rollback(True)
                self.stdout.write('dry run: nothing was saved')
