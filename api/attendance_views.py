"""
REST API views for attendance management.
"""
from datetime import datetime, date, timedelta
from django.shortcuts import get_object_or_404
from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.exceptions import ValidationError

from api.timeutil import local_now
from api.models import (
    EmployeeAttendance, Shift, ShiftAssignment, Break, BreakPolicy,
    AttendanceEvent, LateCheckInAlert, LateCheckInPolicy, Overtime,
    OvertimeBalance, OvertimePolicy, WfhRequest, GeoFence, WFHPolicy,
    AttendanceCorrection
)
from api.serializers import (
    ShiftSerializer, BreakSerializer, BreakPolicySerializer,
    LateCheckInAlertSerializer, LateCheckInPolicySerializer,
    OvertimeSerializer, OvertimeBalanceSerializer, OvertimePolicySerializer,
    WFHPolicySerializer
)
from api.services.attendance_service import AttendanceService
from api.services.notification_service import NotificationService
from api.services.overtime_service import OvertimeService
from api.services.geofence_service import GeofenceService


class ShiftViewSet(viewsets.ModelViewSet):
    """ViewSet for managing shifts."""
    queryset = Shift.objects.all()
    serializer_class = ShiftSerializer
    # Identity is carried by the `email` query/body param (consistent with the
    # rest of the API, which is gated by X-User-Email + require_perm rather than
    # a session/JWT). Requiring IsAuthenticated here made these the only
    # endpoints that 401'd the attendance portal — so allow, and scope by email.
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['get'])
    def active(self, request):
        """Get all active shifts."""
        shifts = Shift.objects.filter(is_active=True)
        serializer = self.get_serializer(shifts, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['get'])
    def assignments(self, request, pk=None):
        """Get shift assignments for a shift."""
        shift = self.get_object()
        assignments = shift.assignments.all()
        return Response({
            'shift_id': shift.id,
            'shift_name': shift.name,
            'assignments': [
                {
                    'id': a.id,
                    'email': a.email,
                    'effective_from': a.effective_from,
                    'effective_to': a.effective_to
                }
                for a in assignments
            ]
        })


class AttendanceCheckInOutViewSet(viewsets.ViewSet):
    """ViewSet for check-in/out operations."""
    # Identity is carried by the `email` query/body param (consistent with the
    # rest of the API, which is gated by X-User-Email + require_perm rather than
    # a session/JWT). Requiring IsAuthenticated here made these the only
    # endpoints that 401'd the attendance portal — so allow, and scope by email.
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['post'])
    def check_in(self, request):
        """Record employee check-in."""
        email = request.data.get('email')
        employee_name = request.data.get('employeeName')
        latitude = request.data.get('latitude')
        longitude = request.data.get('longitude')
        device = request.data.get('device', 'mobile')
        geofence_id = request.data.get('geofenceId')

        if not email or not employee_name:
            return Response(
                {'error': 'Email and employee name are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        result = AttendanceService.record_check_in(
            email, employee_name, latitude, longitude, device, geofence_id
        )

        if result['success']:
            # Send notification
            if result['status'] == 'late':
                NotificationService.send_late_checkin_alert(
                    email, employee_name, result['late_minutes'],
                    'N/A'  # TODO: Get shift start time
                )

        return Response(result)

    @action(detail=False, methods=['post'])
    def check_out(self, request):
        """Record employee check-out."""
        email = request.data.get('email')
        employee_name = request.data.get('employeeName')
        latitude = request.data.get('latitude')
        longitude = request.data.get('longitude')
        device = request.data.get('device', 'mobile')

        if not email or not employee_name:
            return Response(
                {'error': 'Email and employee name are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        result = AttendanceService.record_check_out(
            email, employee_name, latitude, longitude, device
        )

        return Response(result)

    @action(detail=False, methods=['post'], url_path='device-punch')
    def device_punch(self, request):
        """Record punch from external biometric/RFID hardware device."""
        email = request.data.get('email') or request.data.get('employee_code')
        employee_name = request.data.get('employeeName') or request.data.get('employee_name') or (email.split('@')[0].title() if email else '')
        punch_type = request.data.get('punchType') or request.data.get('punch_type', 'in')
        device_id = request.data.get('deviceId') or request.data.get('device_id', 'biometric_01')

        if not email:
            return Response(
                {'error': 'email or employee_code is required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        result = AttendanceService.record_device_punch(
            email=email,
            employee_name=employee_name,
            punch_type=punch_type,
            device_id=device_id
        )
        return Response(result)

    @action(detail=False, methods=['get'])
    def today(self, request):
        """Get today's attendance for current user."""
        email = request.query_params.get('email')
        if not email:
            return Response(
                {'error': 'Email parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        today = date.today()
        attendance = EmployeeAttendance.objects.filter(
            email=email,
            date=today
        ).first()

        if not attendance:
            return Response({'message': 'No attendance record found'})

        return Response({
            'id': attendance.id,
            'email': attendance.email,
            'employee': attendance.employee_name,
            'date': attendance.date,
            'checkIn': attendance.check_in,
            'checkOut': attendance.check_out,
            'status': attendance.status,
            'workedMinutes': attendance.worked_minutes,
            'breakMinutes': attendance.break_minutes,
            'lateMinutes': attendance.late_minutes,
            'overtimeMinutes': attendance.overtime_minutes,
            'isWfh': attendance.is_wfh,
            'geoVerified': attendance.geo_verified
        })

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Get attendance summary for date range."""
        email = request.query_params.get('email')
        from_date_str = request.query_params.get('fromDate')
        to_date_str = request.query_params.get('toDate')

        if not email or not from_date_str or not to_date_str:
            return Response(
                {'error': 'Email, fromDate, and toDate are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            from_date = datetime.strptime(from_date_str, '%Y-%m-%d').date()
            to_date = datetime.strptime(to_date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': 'Invalid date format. Use YYYY-MM-DD'},
                status=status.HTTP_400_BAD_REQUEST
            )

        summary = AttendanceService.get_attendance_summary(email, from_date, to_date)
        return Response(summary)


class BreakViewSet(viewsets.ViewSet):
    """ViewSet for break management."""
    # Identity is carried by the `email` query/body param (consistent with the
    # rest of the API, which is gated by X-User-Email + require_perm rather than
    # a session/JWT). Requiring IsAuthenticated here made these the only
    # endpoints that 401'd the attendance portal — so allow, and scope by email.
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['post'])
    def start(self, request):
        """Start a break."""
        email = request.data.get('email')
        employee_name = request.data.get('employeeName')
        break_type = request.data.get('breakType', 'meal')
        reason = request.data.get('reason', '')

        if not email or not employee_name:
            return Response(
                {'error': 'Email and employee name are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        result = AttendanceService.start_break(email, employee_name, break_type, reason)
        return Response(result)

    @action(detail=False, methods=['post'])
    def end(self, request):
        """End an active break."""
        email = request.data.get('email')
        break_id = request.data.get('breakId')

        if not email or not break_id:
            return Response(
                {'error': 'Email and breakId are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        result = AttendanceService.end_break(email, break_id)
        return Response(result)

    @action(detail=False, methods=['get'])
    def today(self, request):
        """Get today's breaks for employee."""
        email = request.query_params.get('email')
        if not email:
            return Response(
                {'error': 'Email parameter required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        today = date.today()
        breaks = Break.objects.filter(
            email=email,
            date=today
        ).order_by('-break_start')

        serializer = BreakSerializer(breaks, many=True)
        return Response(serializer.data)


class LateCheckInAlertViewSet(viewsets.ViewSet):
    """ViewSet for late check-in alerts."""
    # Identity is carried by the `email` query/body param (consistent with the
    # rest of the API, which is gated by X-User-Email + require_perm rather than
    # a session/JWT). Requiring IsAuthenticated here made these the only
    # endpoints that 401'd the attendance portal — so allow, and scope by email.
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['get'])
    def list_alerts(self, request):
        """Get late check-in alerts."""
        email = request.query_params.get('email')
        date_str = request.query_params.get('date')
        is_excused = request.query_params.get('isExcused')

        query = LateCheckInAlert.objects.all()

        if email:
            query = query.filter(email=email)

        if date_str:
            try:
                alert_date = datetime.strptime(date_str, '%Y-%m-%d').date()
                query = query.filter(date=alert_date)
            except ValueError:
                pass

        if is_excused is not None:
            query = query.filter(is_excused=is_excused.lower() == 'true')

        serializer = LateCheckInAlertSerializer(query.order_by('-date'), many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['post'])
    def excuse(self, request):
        """Excuse a late check-in."""
        alert_id = request.data.get('alertId')
        excused_by = request.data.get('excusedBy')

        try:
            alert = LateCheckInAlert.objects.get(id=alert_id)
            alert.is_excused = True
            alert.excused_by = excused_by
            alert.excused_at = local_now()
            alert.save()

            # Send notification
            NotificationService.send_notification(
                alert.email,
                'Late Check-In Excused',
                f'Your late check-in on {alert.date} has been excused by {excused_by}',
                'success'
            )

            return Response({'success': True, 'message': 'Alert excused'})
        except LateCheckInAlert.DoesNotExist:
            return Response(
                {'error': 'Alert not found'},
                status=status.HTTP_404_NOT_FOUND
            )


class OvertimeViewSet(viewsets.ViewSet):
    """ViewSet for overtime management."""
    # Identity is carried by the `email` query/body param (consistent with the
    # rest of the API, which is gated by X-User-Email + require_perm rather than
    # a session/JWT). Requiring IsAuthenticated here made these the only
    # endpoints that 401'd the attendance portal — so allow, and scope by email.
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['get'])
    def daily(self, request):
        """Get daily overtime."""
        email = request.query_params.get('email')
        date_str = request.query_params.get('date')

        if not email or not date_str:
            return Response(
                {'error': 'Email and date are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            overtime_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': 'Invalid date format. Use YYYY-MM-DD'},
                status=status.HTTP_400_BAD_REQUEST
            )

        overtime = Overtime.objects.filter(
            email=email,
            date=overtime_date
        ).first()

        if not overtime:
            return Response({'message': 'No overtime record found'})

        serializer = OvertimeSerializer(overtime)
        return Response(serializer.data)

    @action(detail=False, methods=['get'])
    def monthly(self, request):
        """Get monthly overtime summary."""
        email = request.query_params.get('email')
        period = request.query_params.get('period')  # YYYY-MM

        if not email or not period:
            return Response(
                {'error': 'Email and period are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            year, month = period.split('-')
            year, month = int(year), int(month)
        except (ValueError, AttributeError):
            return Response(
                {'error': 'Invalid period format. Use YYYY-MM'},
                status=status.HTTP_400_BAD_REQUEST
            )

        summary = OvertimeService.calculate_monthly_overtime(email, year, month)
        return Response(summary)

    @action(detail=False, methods=['get'])
    def balance(self, request):
        """Get overtime balance."""
        email = request.query_params.get('email')
        period = request.query_params.get('period')  # YYYY-MM

        if not email or not period:
            return Response(
                {'error': 'Email and period are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        balance = OvertimeBalance.objects.filter(
            email=email,
            period=period
        ).first()

        if not balance:
            return Response({'message': 'No overtime balance found'})

        serializer = OvertimeBalanceSerializer(balance)
        return Response(serializer.data)

    @action(detail=False, methods=['post'])
    def approve(self, request):
        """Approve overtime."""
        email = request.data.get('email')
        date_str = request.data.get('date')
        approver_email = request.user.email if request.user else 'admin'

        if not email or not date_str:
            return Response(
                {'error': 'Email and date are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            overtime_date = datetime.strptime(date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': 'Invalid date format. Use YYYY-MM-DD'},
                status=status.HTTP_400_BAD_REQUEST
            )

        success = OvertimeService.approve_overtime(email, overtime_date, approver_email)

        if success:
            return Response({'success': True, 'message': 'Overtime approved'})
        else:
            return Response(
                {'error': 'Overtime not found'},
                status=status.HTTP_404_NOT_FOUND
            )


class AttendanceCorrectionViewSet(viewsets.ViewSet):
    """ViewSet for attendance correction requests."""
    # Identity is carried by the `email` query/body param (consistent with the
    # rest of the API, which is gated by X-User-Email + require_perm rather than
    # a session/JWT). Requiring IsAuthenticated here made these the only
    # endpoints that 401'd the attendance portal — so allow, and scope by email.
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['post'])
    def request_correction(self, request):
        """Submit attendance correction request."""
        email = request.data.get('email')
        attendance_date_str = request.data.get('attendanceDate')
        requested_check_in_str = request.data.get('requestedCheckIn')
        requested_check_out_str = request.data.get('requestedCheckOut')
        reason = request.data.get('reason')

        if not email or not attendance_date_str:
            return Response(
                {'error': 'Email and attendance date are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            attendance_date = datetime.strptime(attendance_date_str, '%Y-%m-%d').date()
            requested_check_in = datetime.strptime(requested_check_in_str, '%Y-%m-%d %H:%M:%S') if requested_check_in_str else None
            requested_check_out = datetime.strptime(requested_check_out_str, '%Y-%m-%d %H:%M:%S') if requested_check_out_str else None
        except ValueError:
            return Response(
                {'error': 'Invalid date/time format'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Get employee name
        attendance = EmployeeAttendance.objects.filter(
            email=email,
            date=attendance_date
        ).first()

        employee_name = attendance.employee_name if attendance else email

        correction = AttendanceCorrection.objects.create(
            email=email,
            employee_name=employee_name,
            attendance_date=attendance_date,
            requested_check_in=requested_check_in,
            requested_check_out=requested_check_out,
            reason=reason or '',
            status='Pending'
        )

        # Send notification to managers/HR
        NotificationService.send_notification(
            'hr@company.com',  # TODO: Get HR email from config
            'Attendance Correction Request',
            f'{employee_name} requested correction for {attendance_date}',
            'info'
        )

        return Response({
            'success': True,
            'correctionId': correction.id,
            'message': 'Correction request submitted'
        })

    @action(detail=False, methods=['post'])
    def approve_correction(self, request):
        """Approve attendance correction."""
        correction_id = request.data.get('correctionId')
        reviewer_note = request.data.get('reviewerNote', '')
        reviewer_email = request.user.email if request.user else 'admin'

        try:
            correction = AttendanceCorrection.objects.get(id=correction_id)
            correction.status = 'Approved'
            correction.reviewer = reviewer_email
            correction.reviewer_note = reviewer_note
            correction.reviewed_at = local_now()
            correction.save()

            # Apply correction to attendance
            attendance = EmployeeAttendance.objects.filter(
                email=correction.email,
                date=correction.attendance_date
            ).first()

            if attendance:
                if correction.requested_check_in:
                    attendance.check_in = correction.requested_check_in
                if correction.requested_check_out:
                    attendance.check_out = correction.requested_check_out
                attendance.save()

            # Send notification
            NotificationService.send_attendance_correction_notification(
                correction.email,
                correction.employee_name,
                str(correction.attendance_date),
                'Approved',
                reviewer_email
            )

            return Response({'success': True, 'message': 'Correction approved'})
        except AttendanceCorrection.DoesNotExist:
            return Response(
                {'error': 'Correction not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=False, methods=['post'])
    def reject_correction(self, request):
        """Reject attendance correction."""
        correction_id = request.data.get('correctionId')
        reviewer_note = request.data.get('reviewerNote', '')
        reviewer_email = request.user.email if request.user else 'admin'

        try:
            correction = AttendanceCorrection.objects.get(id=correction_id)
            correction.status = 'Rejected'
            correction.reviewer = reviewer_email
            correction.reviewer_note = reviewer_note
            correction.reviewed_at = local_now()
            correction.save()

            # Send notification
            NotificationService.send_attendance_correction_notification(
                correction.email,
                correction.employee_name,
                str(correction.attendance_date),
                'Rejected',
                reviewer_email
            )

            return Response({'success': True, 'message': 'Correction rejected'})
        except AttendanceCorrection.DoesNotExist:
            return Response(
                {'error': 'Correction not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=False, methods=['get'])
    def pending(self, request):
        """Get pending corrections."""
        corrections = AttendanceCorrection.objects.filter(
            status='Pending'
        ).order_by('-created_at')

        return Response([
            {
                'id': c.id,
                'email': c.email,
                'employee': c.employee_name,
                'attendanceDate': c.attendance_date,
                'reason': c.reason,
                'requestedCheckIn': c.requested_check_in,
                'requestedCheckOut': c.requested_check_out,
                'createdAt': c.created_at
            }
            for c in corrections
        ])


class WFHRequestViewSet(viewsets.ViewSet):
    """ViewSet for WFH request management."""
    # Identity is carried by the `email` query/body param (consistent with the
    # rest of the API, which is gated by X-User-Email + require_perm rather than
    # a session/JWT). Requiring IsAuthenticated here made these the only
    # endpoints that 401'd the attendance portal — so allow, and scope by email.
    permission_classes = [permissions.AllowAny]

    @action(detail=False, methods=['post'])
    def submit_request(self, request):
        """Submit WFH request."""
        email = request.data.get('email')
        from_date_str = request.data.get('fromDate')
        to_date_str = request.data.get('toDate')
        reason = request.data.get('reason')

        if not email or not from_date_str or not to_date_str:
            return Response(
                {'error': 'Email, fromDate, and toDate are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            from_date = datetime.strptime(from_date_str, '%Y-%m-%d').date()
            to_date = datetime.strptime(to_date_str, '%Y-%m-%d').date()
        except ValueError:
            return Response(
                {'error': 'Invalid date format. Use YYYY-MM-DD'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Get employee name
        attendance = EmployeeAttendance.objects.filter(email=email).first()
        employee_name = attendance.employee_name if attendance else email

        # Calculate days
        days = (to_date - from_date).days + 1

        wfh_request = WfhRequest.objects.create(
            email=email,
            employee_name=employee_name,
            from_date=from_date,
            to_date=to_date,
            days=days,
            reason=reason or '',
            status='Pending'
        )

        # Notify every approver — Super Admins, HR and managers — so admins and
        # other approvers see the new request (imported lazily to avoid a
        # circular import between views.py and attendance_views.py).
        try:
            from api.views import notify_approvers
            notify_approvers(
                'settings.manage',
                'New WFH Request',
                f'{employee_name} requested WFH for {days} day(s) from {from_date} to {to_date}.',
                '/employees/checkin',
            )
        except Exception:
            # Fall back to the single HR mailbox if the approver fan-out fails.
            NotificationService.send_notification(
                'hr@company.com',
                'WFH Request Submitted',
                f'{employee_name} requested WFH for {days} day(s) from {from_date} to {to_date}',
                'info'
            )

        return Response({
            'success': True,
            'wfhRequestId': wfh_request.id,
            'message': 'WFH request submitted'
        })

    @action(detail=False, methods=['post'])
    def approve_request(self, request):
        """Approve WFH request."""
        request_id = request.data.get('requestId')
        approver_email = request.user.email if request.user else 'admin'

        try:
            wfh_request = WfhRequest.objects.get(id=request_id)
            wfh_request.status = 'Approved'
            wfh_request.approver = approver_email
            wfh_request.save()

            # Mark attendance as WFH
            for i in range((wfh_request.to_date - wfh_request.from_date).days + 1):
                current_date = wfh_request.from_date + timedelta(days=i)
                attendance, _ = EmployeeAttendance.objects.get_or_create(
                    email=wfh_request.email,
                    date=current_date,
                    defaults={'employee_name': wfh_request.employee_name}
                )
                attendance.is_wfh = True
                attendance.save()

            # Send notification
            NotificationService.send_wfh_approval_notification(
                wfh_request.email,
                wfh_request.employee_name,
                str(wfh_request.from_date),
                str(wfh_request.to_date),
                True,
                approver_email
            )

            return Response({'success': True, 'message': 'WFH request approved'})
        except WfhRequest.DoesNotExist:
            return Response(
                {'error': 'WFH request not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=False, methods=['post'])
    def reject_request(self, request):
        """Reject WFH request."""
        request_id = request.data.get('requestId')
        approver_email = request.user.email if request.user else 'admin'

        try:
            wfh_request = WfhRequest.objects.get(id=request_id)
            wfh_request.status = 'Rejected'
            wfh_request.approver = approver_email
            wfh_request.save()

            # Send notification
            NotificationService.send_wfh_approval_notification(
                wfh_request.email,
                wfh_request.employee_name,
                str(wfh_request.from_date),
                str(wfh_request.to_date),
                False,
                approver_email
            )

            return Response({'success': True, 'message': 'WFH request rejected'})
        except WfhRequest.DoesNotExist:
            return Response(
                {'error': 'WFH request not found'},
                status=status.HTTP_404_NOT_FOUND
            )
