"""Evaluate late / early-out penalties for a month (api/attendance_ext/penalties.py).

  python manage.py attendance_penalties --month 2026-11            # write + notify
  python manage.py attendance_penalties --month 2026-11 --dry-run  # show only
  python manage.py attendance_penalties --month 2026-11 --email a@x.com

Idempotent: re-running creates nothing twice (unique email/date/kind) and
removes penalties whose late / early out no longer exists. The same
evaluation runs by itself after each check-out, regularization approval and
short-leave decision.
"""
from django.core.management.base import BaseCommand, CommandError

from api.attendance_ext import penalties as pen
from api.timeutil import local_today


class Command(BaseCommand):
    help = 'Evaluate attendance penalties (late arrivals / early outs beyond the free allowance) for a month.'

    def add_arguments(self, parser):
        parser.add_argument('--month', help='YYYY-MM (default: this month)')
        parser.add_argument('--email', help='Only this employee')
        parser.add_argument('--dry-run', action='store_true', help='Show what would change; write nothing')

    def handle(self, *args, **o):
        month = o['month'] or local_today().strftime('%Y-%m')
        try:
            y, m = pen.parse_period(month)
        except ValueError:
            raise CommandError('--month must be YYYY-MM.')
        emails = [o['email'].strip().lower()] if o['email'] else pen.month_emails(y, m)
        dry = o['dry_run']
        self.stdout.write(f'{"DRY RUN — nothing is written" if dry else "APPLY"} · {y:04d}-{m:02d} · '
                          f'{len(emails)} employee(s)')
        created = removed = kept = 0
        for e in emails:
            r = pen.evaluate_month(e, y, m, dry_run=dry)
            for p in r['created']:
                self.stdout.write(f'  + {p.date} {e:<36} {p.kind:<9} #{p.occurrence} {p.action}'
                                  + ('' if dry else f' -> {p.status}' + (f' ({p.leave_type})' if p.leave_type else '')))
            for p in r['removed']:
                self.stdout.write(f'  - {p.date} {e:<36} {p.kind:<9} (no longer an occurrence)')
            created += len(r['created'])
            removed += len(r['removed'])
            kept += len(r['kept'])
        self.stdout.write(f'{created} {"would be " if dry else ""}created, {removed} {"would be " if dry else ""}'
                          f'removed, {kept} unchanged')
