"""
Overtime calculation service for tracking work hours and overtime.
"""
from datetime import datetime, date, timedelta
from django.utils import timezone
from django.db.models import Q, Sum

from api.models import (
    EmployeeAttendance, Shift, ShiftAssignment, Overtime, OvertimePolicy,
    OvertimeBalance, Break
)


class OvertimeService:
    """Handle overtime calculations and balance tracking."""

    @staticmethod
    def calculate_daily_overtime(email: str, employee_name: str, today: date) -> dict:
        """
        Calculate overtime for a single day.
        
        Args:
            email: Employee email
            employee_name: Employee name
            today: Date to calculate for
            
        Returns:
            {'overtime_hours': float, 'overtime_type': str, 'status': str}
        """
        # Get attendance for today
        attendance = EmployeeAttendance.objects.filter(
            email=email,
            date=today
        ).first()

        if not attendance or not attendance.check_in or not attendance.check_out:
            return None

        # Get shift
        shift = ShiftAssignment.objects.filter(
            email=email,
            effective_from__lte=today
        ).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=today)
        ).select_related('shift').first()

        if not shift:
            return None

        # Calculate actual worked time
        worked_time = attendance.check_out - attendance.check_in
        worked_minutes = int(worked_time.total_seconds() / 60)

        # Subtract break time
        breaks = Break.objects.filter(
            email=email,
            date=today,
            status='completed'
        ).aggregate(total=Sum('break_minutes'))
        
        break_minutes = breaks.get('total', 0) or 0
        net_worked_minutes = max(0, worked_minutes - break_minutes)
        net_worked_hours = net_worked_minutes / 60

        # Get shift duration
        shift_obj = shift.shift
        shift_start = datetime.combine(today, shift_obj.start_time)
        shift_end = datetime.combine(today, shift_obj.end_time)

        if shift_obj.is_night_shift and shift_end <= shift_start:
            shift_end += timedelta(days=1)

        shift_minutes = int((shift_end - shift_start).total_seconds() / 60)
        shift_minutes -= shift_obj.break_minutes
        shift_hours = shift_minutes / 60

        # Calculate overtime
        overtime_hours = max(0, net_worked_hours - shift_hours)

        # Determine overtime type
        overtime_type = OvertimeService._get_overtime_type(today)

        # Create or update overtime record
        overtime, created = Overtime.objects.update_or_create(
            email=email,
            date=today,
            defaults={
                'employee_name': employee_name,
                'shift_hours': shift_hours,
                'worked_hours': net_worked_hours,
                'overtime_hours': overtime_hours,
                'overtime_type': overtime_type,
                'status': 'calculated'
            }
        )

        return {
            'overtime_hours': overtime_hours,
            'overtime_type': overtime_type,
            'status': 'calculated',
            'overtime_id': overtime.id
        }

    @staticmethod
    def calculate_weekly_overtime(email: str, start_date: date) -> dict:
        """Calculate total overtime for a week."""
        end_date = start_date + timedelta(days=6)

        overtimes = Overtime.objects.filter(
            email=email,
            date__gte=start_date,
            date__lte=end_date,
            status__in=['calculated', 'approved']
        )

        total_ot = overtimes.aggregate(total=Sum('overtime_hours'))['total'] or 0
        total_worked = overtimes.aggregate(total=Sum('worked_hours'))['total'] or 0

        return {
            'week_start': start_date,
            'week_end': end_date,
            'total_overtime_hours': total_ot,
            'total_worked_hours': total_worked,
            'count': overtimes.count()
        }

    @staticmethod
    def calculate_monthly_overtime(email: str, year: int, month: int) -> dict:
        """Calculate total overtime for a month."""
        from datetime import datetime
        start_date = date(year, month, 1)

        if month == 12:
            end_date = date(year + 1, 1, 1) - timedelta(days=1)
        else:
            end_date = date(year, month + 1, 1) - timedelta(days=1)

        overtimes = Overtime.objects.filter(
            email=email,
            date__gte=start_date,
            date__lte=end_date,
            status__in=['calculated', 'approved']
        )

        total_ot = overtimes.aggregate(total=Sum('overtime_hours'))['total'] or 0
        total_worked = overtimes.aggregate(total=Sum('worked_hours'))['total'] or 0

        # Group by type
        by_type = {}
        for ot in overtimes:
            if ot.overtime_type not in by_type:
                by_type[ot.overtime_type] = 0
            by_type[ot.overtime_type] += ot.overtime_hours

        return {
            'month': f'{year}-{month:02d}',
            'total_overtime_hours': total_ot,
            'total_worked_hours': total_worked,
            'by_type': by_type,
            'count': overtimes.count()
        }

    @staticmethod
    def approve_overtime(email: str, date_obj: date, approver_email: str) -> bool:
        """Approve overtime record."""
        overtime = Overtime.objects.filter(
            email=email,
            date=date_obj
        ).first()

        if overtime:
            overtime.status = 'approved'
            overtime.approver = approver_email
            overtime.approved_at = timezone.now()
            overtime.save()
            return True

        return False

    @staticmethod
    def update_overtime_balance(email: str, employee_name: str, period: str) -> dict:
        """
        Update monthly overtime balance (accumulated OT, comp-off, cash payout).
        
        Args:
            email: Employee email
            employee_name: Employee name
            period: 'YYYY-MM' format
            
        Returns:
            Balance dictionary
        """
        year, month = period.split('-')
        year, month = int(year), int(month)

        # Get all approved overtime for the month
        from datetime import datetime
        start_date = date(year, month, 1)
        if month == 12:
            end_date = date(year + 1, 1, 1) - timedelta(days=1)
        else:
            end_date = date(year, month + 1, 1) - timedelta(days=1)

        overtimes = Overtime.objects.filter(
            email=email,
            date__gte=start_date,
            date__lte=end_date,
            status='approved'
        )

        total_ot_hours = overtimes.aggregate(total=Sum('overtime_hours'))['total'] or 0

        # Split between comp-off and cash payout (50/50 by default)
        comp_off_hours = total_ot_hours / 2
        cash_payout_hours = total_ot_hours / 2

        # Update or create balance
        balance, created = OvertimeBalance.objects.update_or_create(
            email=email,
            period=period,
            defaults={
                'employee_name': employee_name,
                'total_overtime_hours': total_ot_hours,
                'comp_off_hours': comp_off_hours,
                'cash_payout_hours': cash_payout_hours
            }
        )

        return {
            'period': period,
            'total_overtime_hours': total_ot_hours,
            'comp_off_hours': comp_off_hours,
            'cash_payout_hours': cash_payout_hours
        }

    @staticmethod
    def _get_overtime_type(date_obj: date) -> str:
        """Determine overtime type based on day of week."""
        weekday = date_obj.weekday()  # 0=Monday, 6=Sunday
        
        if weekday == 6:  # Sunday
            return 'weekend'
        if weekday == 5:  # Saturday
            return 'weekend'
        
        # TODO: Check if it's a holiday
        return 'regular'

    @staticmethod
    def validate_overtime_policy(email: str, date_obj: date, overtime_hours: float) -> dict:
        """
        Validate overtime against policy limits.
        
        Returns:
            {
                'is_valid': bool,
                'exceeds_daily': bool,
                'exceeds_weekly': bool,
                'exceeds_monthly': bool,
                'message': str
            }
        """
        policy = OvertimePolicy.objects.filter(is_active=True).first()
        if not policy:
            return {'is_valid': True, 'exceeds_daily': False, 'exceeds_weekly': False, 'exceeds_monthly': False}

        result = {
            'is_valid': True,
            'exceeds_daily': False,
            'exceeds_weekly': False,
            'exceeds_monthly': False,
            'message': 'Valid'
        }

        # Check daily limit
        if overtime_hours > (policy.daily_max_overtime_minutes / 60):
            result['is_valid'] = False
            result['exceeds_daily'] = True
            result['message'] = f'Exceeds daily OT limit ({policy.daily_max_overtime_minutes}m)'
            return result

        # Check weekly limit
        week_start = date_obj - timedelta(days=date_obj.weekday())
        weekly_ot = OvertimeService.calculate_weekly_overtime(email, week_start)
        if weekly_ot['total_overtime_hours'] > (policy.weekly_max_overtime_minutes / 60):
            result['is_valid'] = False
            result['exceeds_weekly'] = True
            result['message'] = f'Exceeds weekly OT limit ({policy.weekly_max_overtime_minutes}m)'
            return result

        return result
