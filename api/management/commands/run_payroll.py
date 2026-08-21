"""
Management command to run automated end-of-month pay runs.

Cron example:
    0 2 25 * * cd <release> && python manage.py run_payroll --auto-approve
"""
from datetime import datetime, date, timedelta
from django.core.management.base import BaseCommand
from api.services.payroll_service import PayrollService
from api.timeutil import local_now


class Command(BaseCommand):
    help = 'Generate automated monthly payroll runs and payslips.'

    def add_arguments(self, parser):
        parser.add_argument('--period', type=str, help='Period label (e.g. 2026-08). Defaults to current YYYY-MM')
        parser.add_argument('--auto-approve', action='store_true', help='Automatically approve and lock the pay run')

    def handle(self, *args, **opts):
        now = local_now()
        period_label = opts['period'] or now.strftime('%Y-%m')

        # Calculate month start and end dates
        try:
            year, month = map(int, period_label.split('-'))
            start_date = date(year, month, 1)
            if month == 12:
                end_date = date(year + 1, 1, 1) - timedelta(days=1)
            else:
                end_date = date(year, month + 1, 1) - timedelta(days=1)
        except Exception as e:
            self.stderr.write(f"Error parsing period label '{period_label}': {e}")
            return

        self.stdout.write(f"Generating payroll run for period {period_label} ({start_date} to {end_date})...")
        run = PayrollService.create_pay_run(
            period_label=period_label,
            period_start=start_date,
            period_end=end_date,
            created_by='System Cron'
        )

        self.stdout.write(self.style.SUCCESS(
            f"Payroll run '{run.period_label}' created in '{run.status}' state: "
            f"{run.employee_count} employees, Gross: ${run.total_gross:,.2f}, "
            f"Deductions: ${run.total_deductions:,.2f}, Net: ${run.total_net:,.2f}"
        ))

        if opts['auto_approve']:
            PayrollService.approve_pay_run(run.id, approved_by='System Auto-Approve')
            self.stdout.write(self.style.SUCCESS(f"Payroll run '{run.period_label}' has been APPROVED and payslips rendered."))
