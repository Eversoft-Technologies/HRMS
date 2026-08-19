"""
Management command to auto check-out open punches past midnight/shift cutoff.

Cron example:
    5 0 * * * cd <release> && python manage.py auto_checkout
"""
from datetime import datetime
from django.core.management.base import BaseCommand
from api.services.attendance_service import AttendanceService
from api.timeutil import local_now


class Command(BaseCommand):
    help = 'Auto check-out open attendance records past shift cutoff.'

    def add_arguments(self, parser):
        parser.add_argument('--date', type=str, help='Target date in YYYY-MM-DD format (default: today)')
        parser.add_argument('--dry-run', action='store_true', help='Report what would be checked out without saving')

    def handle(self, *args, **opts):
        now = local_now()
        target_date = now.date()

        if opts['date']:
            try:
                target_date = datetime.strptime(opts['date'], '%Y-%m-%d').date()
            except ValueError:
                self.stderr.write('Invalid date format. Use YYYY-MM-DD.')
                return

        if opts['dry_run']:
            from api.models import EmployeeAttendance
            open_records = EmployeeAttendance.objects.filter(
                date=target_date,
                check_in__isnull=False,
                check_out__isnull=True
            )
            self.stdout.write(f"Auto check-out (dry-run) for {target_date}: {open_records.count()} open records")
            for r in open_records:
                self.stdout.write(f"  {r.email} checked in at {r.check_in}")
        else:
            checked_out = AttendanceService.auto_checkout_open_shifts(for_date=target_date)
            self.stdout.write(f"Auto checked out {len(checked_out)} employee(s) for {target_date}:")
            for email in checked_out:
                self.stdout.write(f"  {email}")
