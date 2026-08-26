"""Auto check-out employees who forgot to check out.

For every open attendance record (check-in set, no check-out), stamp the
check-out at 23:59 of that record's own day, mark it auto-checked-out, and
recompute worked minutes. Employees can still raise a ticket to correct it.

By default this closes every day *before* today (so a nightly run just after
midnight closes yesterday, and any older strays too). Pass --date to target one
specific day.

Cron (run a few minutes after midnight, business timezone):
    5 0 * * * cd <release> && <venv>/bin/python manage.py auto_checkout
"""
from datetime import datetime, time, timedelta

from django.core.management.base import BaseCommand

from api.models import EmployeeAttendance
from api.timeutil import local_now, local_today


def _close_record(rec):
    end = datetime.combine(rec.date, time(23, 59, 0))
    if end <= rec.check_in:
        end = rec.check_in + timedelta(minutes=1)
    rec.check_out = end
    worked = int((end - rec.check_in).total_seconds() // 60) - (rec.break_minutes or 0)
    rec.worked_minutes = max(0, worked)
    rec.is_auto_checked_out = True
    rec.auto_checkout_at = local_now()
    rec.save(update_fields=['check_out', 'worked_minutes',
                            'is_auto_checked_out', 'auto_checkout_at'])


class Command(BaseCommand):
    help = 'Auto check-out open attendance records at 23:59 of their day.'

    def add_arguments(self, parser):
        parser.add_argument('--date', type=str, help='Only close this date (YYYY-MM-DD).')
        parser.add_argument('--dry-run', action='store_true', help='Report without saving.')

    def handle(self, *args, **opts):
        qs = EmployeeAttendance.objects.filter(
            check_in__isnull=False, check_out__isnull=True)
        if opts.get('date'):
            try:
                target = datetime.strptime(opts['date'], '%Y-%m-%d').date()
            except ValueError:
                self.stderr.write('Invalid date format. Use YYYY-MM-DD.')
                return
            qs = qs.filter(date=target)
            scope = str(target)
        else:
            qs = qs.filter(date__lt=local_today())
            scope = 'all days before today'

        rows = list(qs)
        if opts.get('dry_run'):
            self.stdout.write(f'Auto check-out (dry-run) for {scope}: {len(rows)} open record(s)')
            for r in rows:
                self.stdout.write(f'  {r.email} — {r.date} checked in at {r.check_in}')
            return

        for r in rows:
            _close_record(r)
        self.stdout.write(f'Auto checked out {len(rows)} record(s) for {scope}:')
        for r in rows:
            self.stdout.write(f'  {r.email} — {r.date} → 23:59')
