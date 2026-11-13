"""Send check-out reminders to everyone who is still checked in past their shift.

Nothing is checked out automatically any more: an open session keeps counting
working time until the employee checks out. The same reminders are also sent
whenever the employee's HRMS page polls notifications, so this command is only
needed to reach people who have no HRMS page open. Optional cron, e.g. hourly:
    0 * * * * cd <release> && <venv>/bin/python manage.py checkout_reminders
"""
from django.core.management.base import BaseCommand

from api.models import EmployeeAttendance
from api.timeutil import local_now


class Command(BaseCommand):
    help = 'Remind employees who are still checked in after their shift (never checks anyone out).'

    def handle(self, *args, **opts):
        from api.views import _checkout_reminders
        now = local_now()
        emails = sorted(set(EmployeeAttendance.objects.filter(
            check_in__isnull=False, check_out__isnull=True).values_list('email', flat=True)))
        for email in emails:
            _checkout_reminders(email, now)
        self.stdout.write(f'Checked {len(emails)} employee(s) with open sessions.')
