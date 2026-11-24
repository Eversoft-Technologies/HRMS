"""Create the sample holiday calendars (idempotent).

    python manage.py seed_holiday_calendars

Creates 'India (default)' (IN, national holidays, default calendar) and
'United States' (US, national holidays). Existing calendars with those names
are left exactly as they are. Nothing is created automatically on migrate:
until a calendar exists, /api/holidays and attendance/payroll behave as before.
"""
from django.core.management.base import BaseCommand

from api.models import HolidayCalendar

SAMPLES = [
    {'name': 'India (default)', 'country': 'IN', 'region': 'India', 'is_default': True},
    {'name': 'United States', 'country': 'US', 'region': 'United States', 'is_default': False},
]


class Command(BaseCommand):
    help = "Create sample 'India (default)' and 'United States' holiday calendars."

    def handle(self, *args, **opts):
        has_default = HolidayCalendar.objects.filter(is_default=True).exists()
        for spec in SAMPLES:
            if HolidayCalendar.objects.filter(name__iexact=spec['name']).exists():
                self.stdout.write(f"exists: {spec['name']}")
                continue
            HolidayCalendar.objects.create(
                name=spec['name'], country=spec['country'], region=spec['region'],
                include_national=True, locations=[],
                # Never steal "default" from a calendar an admin already chose.
                is_default=spec['is_default'] and not has_default,
                is_active=True, created_by='seed_holiday_calendars',
            )
            self.stdout.write(f"created: {spec['name']}")
