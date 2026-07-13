"""
Django management command to seed initial attendance policies.
Usage: python manage.py seed_attendance_policies
"""
from django.core.management.base import BaseCommand
from api.models import (
    BreakPolicy, LateCheckInPolicy, OvertimePolicy, WFHPolicy
)


class Command(BaseCommand):
    help = 'Seed initial attendance policies'

    def handle(self, *args, **options):
        self.stdout.write('Seeding attendance policies...')

        # Create default Break Policy
        break_policy, created = BreakPolicy.objects.get_or_create(
            name='Default',
            defaults={
                'max_break_minutes_per_day': 60,
                'min_break_minutes': 15,
                'max_break_minutes': 60,
                'is_paid': False,
                'is_active': True
            }
        )
        status = 'created' if created else 'exists'
        self.stdout.write(f'Break Policy (Default): {status}')

        # Create default Late Check-In Policy
        late_policy, created = LateCheckInPolicy.objects.get_or_create(
            name='Default',
            defaults={
                'late_threshold_minutes': 5,
                'escalation_count': 3,
                'is_active': True
            }
        )
        status = 'created' if created else 'exists'
        self.stdout.write(f'Late Check-In Policy (Default): {status}')

        # Create default Overtime Policy
        overtime_policy, created = OvertimePolicy.objects.get_or_create(
            name='Default',
            defaults={
                'overtime_threshold_minutes': 540,  # 9 hours
                'daily_max_overtime_minutes': 180,  # 3 hours
                'weekly_max_overtime_minutes': 600,  # 10 hours
                'is_active': True,
                'requires_approval': True
            }
        )
        status = 'created' if created else 'exists'
        self.stdout.write(f'Overtime Policy (Default): {status}')

        # Create default WFH Policy
        wfh_policy, created = WFHPolicy.objects.get_or_create(
            name='Default',
            defaults={
                'max_wfh_days_per_week': 2,
                'max_wfh_days_per_month': 10,
                'requires_approval': True,
                'min_advance_notice_days': 1,
                'is_active': True
            }
        )
        status = 'created' if created else 'exists'
        self.stdout.write(f'WFH Policy (Default): {status}')

        self.stdout.write(self.style.SUCCESS('Successfully seeded attendance policies!'))
