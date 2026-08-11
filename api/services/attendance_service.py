"""
Core attendance service for check-in/out, break tracking, and status calculations.
"""
from datetime import datetime, timedelta, date
from django.utils import timezone
from django.db.models import Q, Sum

from api.models import (
    EmployeeAttendance, Shift, ShiftAssignment, Break, BreakPolicy,
    AttendanceEvent, LateCheckInAlert, LateCheckInPolicy, Overtime,
    WfhRequest, GeoFence
)
from api.services.geofence_service import is_within_geofence
from api.services.overtime_service import OvertimeService


class AttendanceService:
    """Handles check-in/out operations, break tracking, and attendance status."""

    @staticmethod
    def get_current_shift(email: str, check_time: datetime = None) -> Shift:
        """Get active shift for employee at given time."""
        if check_time is None:
            check_time = timezone.now()

        assignment = ShiftAssignment.objects.filter(
            email=email,
            effective_from__lte=check_time.date()
        ).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=check_time.date())
        ).select_related('shift').first()

        if assignment:
            return assignment.shift
        return None

    @staticmethod
    def record_check_in(email: str, employee_name: str, latitude: float = None,
                       longitude: float = None, device: str = 'mobile',
                       geofence_id: int = None) -> dict:
        """
        Record employee check-in.
        
        Returns: {
            'success': bool,
            'message': str,
            'status': 'on_time'|'late'|'error',
            'late_minutes': int,
            'attendance_id': int,
            'geo_verified': bool
        }
        """
        now = timezone.now()
        today = now.date()

        # Get or create today's attendance
        attendance, created = EmployeeAttendance.objects.get_or_create(
            email=email,
            date=today,
            defaults={
                'employee_name': employee_name,
                'check_in': now,
                'device': device,
                'status': 'present'
            }
        )

        if not created and attendance.check_in:
            # Already checked in
            return {
                'success': False,
                'message': 'Already checked in today',
                'status': 'error',
                'late_minutes': 0,
                'attendance_id': attendance.id,
                'geo_verified': attendance.geo_verified
            }

        # Record check-in
        attendance.check_in = now
        attendance.device = device

        # Get shift and validate timing
        shift = AttendanceService.get_current_shift(email, now)
        late_minutes = 0
        geo_verified = False

        if shift:
            attendance.shift_id = shift.id
            
            # Calculate if late
            shift_start = datetime.combine(today, shift.start_time)
            if shift.is_night_shift and shift.end_time < shift.start_time:
                shift_start = datetime.combine(
                    today if now.time() >= shift.start_time else today - timedelta(days=1),
                    shift.start_time
                )
            else:
                shift_start = datetime.combine(today, shift.start_time)

            shift_start = timezone.make_aware(shift_start)
            grace_time = shift_start + timedelta(minutes=shift.grace_minutes)

            if now > grace_time:
                late_minutes = int((now - grace_time).total_seconds() / 60)
                attendance.status = 'late'
                attendance.late_minutes = late_minutes
            else:
                attendance.status = 'present'

        # Verify geofence if location provided
        if latitude and longitude:
            attendance.location_lat = latitude
            attendance.location_lng = longitude

            geo_verified = AttendanceService.verify_geofence(
                latitude, longitude, geofence_id
            )
            attendance.geo_verified = geo_verified

        attendance.save()

        # Create attendance event
        AttendanceEvent.objects.create(
            email=email,
            employee_name=employee_name,
            date=today,
            event='check-in',
            location='Office' if geo_verified else 'Unknown',
            latitude=latitude,
            longitude=longitude,
            geo_fence_id=geofence_id,
            at=now
        )

        # Check for late alert
        if late_minutes > 0:
            AttendanceService.check_and_create_late_alert(
                email, employee_name, today, now, shift, late_minutes
            )

        return {
            'success': True,
            'message': f'Checked in successfully. Late by {late_minutes} minutes' if late_minutes > 0 else 'Checked in on time',
            'status': 'late' if late_minutes > 0 else 'on_time',
            'late_minutes': late_minutes,
            'attendance_id': attendance.id,
            'geo_verified': geo_verified
        }

    @staticmethod
    def record_check_out(email: str, employee_name: str, latitude: float = None,
                        longitude: float = None, device: str = 'mobile') -> dict:
        """
        Record employee check-out and calculate worked time.
        
        Returns: {
            'success': bool,
            'message': str,
            'worked_minutes': int,
            'attendance_id': int
        }
        """
        now = timezone.now()
        today = now.date()

        attendance = EmployeeAttendance.objects.filter(
            email=email,
            date=today
        ).first()

        if not attendance or not attendance.check_in:
            return {
                'success': False,
                'message': 'No check-in found for today',
                'worked_minutes': 0,
                'attendance_id': None
            }

        if attendance.check_out:
            return {
                'success': False,
                'message': 'Already checked out today',
                'worked_minutes': attendance.worked_minutes,
                'attendance_id': attendance.id
            }

        # Calculate worked time
        worked_time = now - attendance.check_in
        worked_minutes = int(worked_time.total_seconds() / 60)

        # Subtract break time
        breaks = Break.objects.filter(
            email=email,
            date=today,
            status='completed'
        ).aggregate(total_break=Sum('break_minutes'))
        
        total_break = breaks.get('total_break', 0) or 0
        net_worked_minutes = max(0, worked_minutes - total_break)

        attendance.check_out = now
        attendance.worked_minutes = net_worked_minutes
        attendance.device = device

        if latitude and longitude:
            attendance.location_lat = latitude
            attendance.location_lng = longitude

        attendance.save()

        # Create attendance event
        AttendanceEvent.objects.create(
            email=email,
            employee_name=employee_name,
            date=today,
            event='check-out',
            location='Office' if attendance.geo_verified else 'Unknown',
            latitude=latitude,
            longitude=longitude,
            at=now
        )

        # Calculate overtime
        if attendance.shift_id:
            overtime_result = OvertimeService.calculate_daily_overtime(email, employee_name, today)
            if overtime_result:
                attendance.overtime_minutes = int(overtime_result.get('overtime_hours', 0) * 60)
                attendance.save()

        return {
            'success': True,
            'message': f'Checked out successfully. Worked {net_worked_minutes // 60}h {net_worked_minutes % 60}m',
            'worked_minutes': net_worked_minutes,
            'attendance_id': attendance.id
        }

    @staticmethod
    def verify_geofence(latitude: float, longitude: float, geofence_id: int = None) -> bool:
        """Verify if coordinates are within an active COMPANY geofence.

        owner_email='' is load-bearing: the table also holds employees'
        registered home fences, and matching against those would verify an
        office check-in from somebody's house.
        """
        geofences = GeoFence.objects.filter(is_active=True, owner_email='')
        
        if geofence_id:
            geofence = geofences.filter(id=geofence_id).first()
            if geofence:
                return is_within_geofence(latitude, longitude, geofence)
        
        # Check any active geofence
        for geofence in geofences:
            if is_within_geofence(latitude, longitude, geofence):
                return True
        
        return False

    @staticmethod
    def start_break(email: str, employee_name: str, break_type: str = 'meal',
                   reason: str = '') -> dict:
        """
        Start a break for employee.
        
        Returns: {'success': bool, 'break_id': int, 'message': str}
        """
        today = date.today()

        # Check if already on break
        active_break = Break.objects.filter(
            email=email,
            date=today,
            status='active'
        ).first()

        if active_break:
            return {
                'success': False,
                'break_id': None,
                'message': 'Already on break'
            }

        # Check break policy
        break_policy = BreakPolicy.objects.filter(is_active=True).first()
        if break_policy:
            total_breaks = Break.objects.filter(
                email=email,
                date=today,
                status='completed'
            ).aggregate(total=Sum('break_minutes'))
            total_break_minutes = total_breaks.get('total', 0) or 0

            if total_break_minutes >= break_policy.max_break_minutes_per_day:
                return {
                    'success': False,
                    'break_id': None,
                    'message': f'Maximum break time ({break_policy.max_break_minutes_per_day}m) exceeded'
                }

        break_record = Break.objects.create(
            email=email,
            employee_name=employee_name,
            date=today,
            break_start=timezone.now(),
            break_type=break_type,
            reason=reason,
            is_paid=break_policy.is_paid if break_policy else False,
            status='active'
        )

        # Create event
        AttendanceEvent.objects.create(
            email=email,
            employee_name=employee_name,
            date=today,
            event='break-start',
            at=timezone.now()
        )

        return {
            'success': True,
            'break_id': break_record.id,
            'message': f'Break started ({break_type})'
        }

    @staticmethod
    def end_break(email: str, break_id: int) -> dict:
        """
        End an active break.
        
        Returns: {'success': bool, 'break_minutes': int, 'message': str}
        """
        try:
            break_record = Break.objects.get(id=break_id, email=email, status='active')
        except Break.DoesNotExist:
            return {
                'success': False,
                'break_minutes': 0,
                'message': 'Break not found'
            }

        now = timezone.now()
        break_record.break_end = now
        break_record.status = 'completed'

        break_duration = now - break_record.break_start
        break_minutes = int(break_duration.total_seconds() / 60)
        break_record.break_minutes = break_minutes

        # Validate against policy
        break_policy = BreakPolicy.objects.filter(is_active=True).first()
        if break_policy:
            if break_minutes < break_policy.min_break_minutes:
                break_record.status = 'active'  # Revert
                break_record.save()
                return {
                    'success': False,
                    'break_minutes': break_minutes,
                    'message': f'Break too short. Minimum: {break_policy.min_break_minutes}m'
                }
            if break_minutes > break_policy.max_break_minutes:
                break_record.status = 'active'
                break_record.save()
                return {
                    'success': False,
                    'break_minutes': break_minutes,
                    'message': f'Break too long. Maximum: {break_policy.max_break_minutes}m'
                }

        break_record.save()

        # Update attendance break_minutes
        attendance = EmployeeAttendance.objects.filter(
            email=email,
            date=break_record.date
        ).first()
        if attendance:
            total_breaks = Break.objects.filter(
                email=email,
                date=break_record.date,
                status='completed'
            ).aggregate(total=Sum('break_minutes'))
            attendance.break_minutes = total_breaks.get('total', 0) or 0
            attendance.save()

        # Create event
        AttendanceEvent.objects.create(
            email=email,
            employee_name=break_record.employee_name,
            date=break_record.date,
            event='break-end',
            at=now
        )

        return {
            'success': True,
            'break_minutes': break_minutes,
            'message': f'Break ended. Duration: {break_minutes}m'
        }

    @staticmethod
    def check_and_create_late_alert(email: str, employee_name: str, today: date,
                                   check_in_time: datetime, shift: Shift, late_minutes: int):
        """Check late policy and create alert if needed."""
        policy = LateCheckInPolicy.objects.filter(is_active=True).first()
        if not policy:
            return

        if late_minutes >= policy.late_threshold_minutes:
            shift_start = datetime.combine(today, shift.start_time)
            shift_start = timezone.make_aware(shift_start)

            alert, created = LateCheckInAlert.objects.get_or_create(
                email=email,
                date=today,
                defaults={
                    'employee_name': employee_name,
                    'late_minutes': late_minutes,
                    'check_in_time': check_in_time,
                    'shift_start_time': shift_start
                }
            )

    @staticmethod
    def get_attendance_summary(email: str, from_date: date, to_date: date) -> dict:
        """Get attendance summary for a date range."""
        attendances = EmployeeAttendance.objects.filter(
            email=email,
            date__gte=from_date,
            date__lte=to_date
        )

        summary = {
            'total_days': (to_date - from_date).days + 1,
            'present': attendances.filter(status='present').count(),
            'late': attendances.filter(status='late').count(),
            'absent': attendances.filter(status='absent').count(),
            'half_day': attendances.filter(status='half-day').count(),
            'total_worked_minutes': attendances.aggregate(total=Sum('worked_minutes'))['total'] or 0,
            'total_break_minutes': attendances.aggregate(total=Sum('break_minutes'))['total'] or 0,
            'total_overtime_minutes': attendances.aggregate(total=Sum('overtime_minutes'))['total'] or 0,
        }

        return summary
