"""Leave accrual / year-end rollover for cron (api/attendance_ext/leave_accrual.py).

    python manage.py leave_accrual                      # credit everything due up to today
    python manage.py leave_accrual --upto 2026-11-30
    python manage.py leave_accrual --rollover 2026 --dry-run
    python manage.py leave_accrual --rollover 2026 --email a@b.com

Both runs are idempotent. Balances also accrue lazily when read, so the
daily run only keeps the ledger tidy for reports.
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from api.attendance_ext import leave_accrual as la
from api.timeutil import local_today


class Command(BaseCommand):
    help = 'Credit monthly / annual leave grants up to a date, or roll a year over (carry forward, encash, lapse).'

    def add_arguments(self, parser):
        parser.add_argument('--upto', help='YYYY-MM-DD (default today)')
        parser.add_argument('--rollover', type=int, metavar='YEAR', help='close YEAR: carry forward / encash / lapse')
        parser.add_argument('--dry-run', action='store_true', help='compute and print, write nothing')
        parser.add_argument('--email', help='only this employee')

    def handle(self, *args, **o):
        emails = [o['email'].strip().lower()] if o.get('email') else None
        if o.get('rollover'):
            year = o['rollover']
            if not o['dry_run'] and year >= local_today().year:
                raise CommandError(f'{year} has not ended yet (use --dry-run to preview).')
            out = la.year_end_rollover(year, emails=emails, dry_run=o['dry_run'], actor='cron')
            for r in out['rows']:
                if r['status'] == 'nothing':
                    continue
                self.stdout.write(f"{r['email']:<40} {r['type']:<20} {r['status']:<8} cf={r['carryForward']} "
                                  f"encash={r['encash']} ({r['encashAmount']}) lapse={r['lapse']}")
            self.stdout.write(self.style.SUCCESS(
                f"{'[dry run] ' if o['dry_run'] else ''}{year}: {out['employees']} employees, totals {out['totals']}"))
            return
        upto = la._date(o['upto']) if o.get('upto') else local_today()
        if not upto:
            raise CommandError('--upto must be YYYY-MM-DD')
        made = 0
        with transaction.atomic():
            for e in (emails or la.employee_emails(upto.year)):
                made += len(la.accrue(e, upto, actor='cron'))
            if o['dry_run']:
                transaction.set_rollback(True)
        self.stdout.write(self.style.SUCCESS(
            f"{'[dry run] ' if o['dry_run'] else ''}accrued up to {upto}: {made} ledger entries"))
