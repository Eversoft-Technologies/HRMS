"""
Notification service for sending alerts via email, SMS, and in-app.
"""
from django.core.mail import send_mail
from django.conf import settings
from api.models import Notification


class NotificationService:
    """Handle sending notifications through various channels."""

    @staticmethod
    def send_notification(recipient_email: str, title: str, message: str,
                         notification_type: str = 'info', link: str = None) -> bool:
        """
        Send in-app notification.
        
        Args:
            recipient_email: Employee email
            title: Notification title
            message: Notification message
            notification_type: 'info'|'warning'|'error'|'success'
            link: Optional link to navigate to
            
        Returns:
            bool: True if created successfully
        """
        try:
            Notification.objects.create(
                recipient=recipient_email,
                title=title,
                message=message,
                notification_type=notification_type,
                link=link or ''
            )
            return True
        except Exception as e:
            print(f"Error creating notification: {e}")
            return False

    @staticmethod
    def send_email(recipient_email: str, subject: str, message: str,
                  html_message: str = None) -> bool:
        """
        Send email notification.
        
        Args:
            recipient_email: Recipient email
            subject: Email subject
            message: Plain text message
            html_message: Optional HTML message
            
        Returns:
            bool: True if sent successfully
        """
        try:
            send_mail(
                subject,
                message,
                settings.DEFAULT_FROM_EMAIL,
                [recipient_email],
                html_message=html_message,
                fail_silently=False
            )
            return True
        except Exception as e:
            print(f"Error sending email: {e}")
            return False

    @staticmethod
    def send_late_checkin_alert(employee_email: str, employee_name: str,
                               late_minutes: int, shift_start_time: str) -> dict:
        """Send alert for late check-in."""
        in_app_sent = NotificationService.send_notification(
            employee_email,
            'Late Check-In Alert',
            f'You checked in {late_minutes} minutes late (Expected: {shift_start_time})',
            'warning'
        )

        email_subject = 'Late Check-In Notification'
        email_body = f"""Dear {employee_name},

You checked in {late_minutes} minutes late on your shift (Expected start: {shift_start_time}).

Please note this may affect your attendance record.

Best regards,
HRMS System"""

        email_sent = NotificationService.send_email(
            employee_email,
            email_subject,
            email_body
        )

        return {
            'in_app_sent': in_app_sent,
            'email_sent': email_sent
        }

    @staticmethod
    def send_break_limit_alert(employee_email: str, employee_name: str,
                              total_break_minutes: int, max_break_minutes: int) -> dict:
        """Send alert for exceeding break limit."""
        in_app_sent = NotificationService.send_notification(
            employee_email,
            'Break Limit Exceeded',
            f'Total break time ({total_break_minutes}m) exceeded daily limit ({max_break_minutes}m)',
            'error'
        )

        email_subject = 'Break Limit Exceeded'
        email_body = f"""Dear {employee_name},

Your total break time ({total_break_minutes} minutes) has exceeded the daily limit ({max_break_minutes} minutes).

Please ensure compliance with break policies.

Best regards,
HRMS System"""

        email_sent = NotificationService.send_email(
            employee_email,
            email_subject,
            email_body
        )

        return {
            'in_app_sent': in_app_sent,
            'email_sent': email_sent
        }

    @staticmethod
    def send_overtime_alert(employee_email: str, employee_name: str,
                           overtime_hours: float, limit_hours: float) -> dict:
        """Send alert for overtime limit exceeded."""
        in_app_sent = NotificationService.send_notification(
            employee_email,
            'Overtime Limit Alert',
            f'Overtime ({overtime_hours:.1f}h) may exceed limit ({limit_hours:.1f}h)',
            'warning'
        )

        email_subject = 'Overtime Limit Alert'
        email_body = f"""Dear {employee_name},

Your overtime ({overtime_hours:.1f} hours) may exceed the configured limit ({limit_hours:.1f} hours).

Please review your work schedule and consider taking time off.

Best regards,
HRMS System"""

        email_sent = NotificationService.send_email(
            employee_email,
            email_subject,
            email_body
        )

        return {
            'in_app_sent': in_app_sent,
            'email_sent': email_sent
        }

    @staticmethod
    def send_wfh_approval_notification(employee_email: str, employee_name: str,
                                       from_date: str, to_date: str,
                                       approved: bool, approver: str = None) -> dict:
        """Send WFH request approval/rejection notification."""
        status = 'Approved' if approved else 'Rejected'
        notification_type = 'success' if approved else 'error'

        title = f'WFH Request {status}'
        message = f'Your work-from-home request ({from_date} to {to_date}) has been {status.lower()}' + (
            f' by {approver}' if approver else ''
        )

        in_app_sent = NotificationService.send_notification(
            employee_email,
            title,
            message,
            notification_type
        )

        email_subject = f'Work-From-Home Request {status}'
        email_body = f"""Dear {employee_name},

Your work-from-home request for {from_date} to {to_date} has been {status.lower()}.

""" + (f"Approved by: {approver}\n\n" if approver else "") + """
Best regards,
HRMS System"""

        email_sent = NotificationService.send_email(
            employee_email,
            email_subject,
            email_body
        )

        return {
            'in_app_sent': in_app_sent,
            'email_sent': email_sent
        }

    @staticmethod
    def send_attendance_correction_notification(employee_email: str, employee_name: str,
                                               correction_date: str, status: str,
                                               reviewer: str = None) -> dict:
        """Send attendance correction status notification."""
        notification_type = 'success' if status == 'Approved' else 'error' if status == 'Rejected' else 'info'

        title = f'Attendance Correction {status}'
        message = f'Your attendance correction for {correction_date} has been {status.lower()}' + (
            f' by {reviewer}' if reviewer else ''
        )

        in_app_sent = NotificationService.send_notification(
            employee_email,
            title,
            message,
            notification_type
        )

        email_subject = f'Attendance Correction {status}'
        email_body = f"""Dear {employee_name},

Your attendance correction request for {correction_date} has been {status.lower()}.

""" + (f"Reviewed by: {reviewer}\n\n" if reviewer else "") + """
Best regards,
HRMS System"""

        email_sent = NotificationService.send_email(
            employee_email,
            email_subject,
            email_body
        )

        return {
            'in_app_sent': in_app_sent,
            'email_sent': email_sent
        }

    @staticmethod
    def get_unread_notifications(recipient_email: str, limit: int = 10) -> list:
        """Get unread notifications for an employee."""
        notifications = Notification.objects.filter(
            recipient=recipient_email,
            is_read=False
        ).order_by('-created_at')[:limit]

        return [
            {
                'id': n.id,
                'title': n.title,
                'message': n.message,
                'type': n.notification_type,
                'link': n.link,
                'created_at': n.created_at.isoformat()
            }
            for n in notifications
        ]

    @staticmethod
    def mark_notification_read(notification_id: int, recipient_email: str) -> bool:
        """Mark a notification as read."""
        try:
            notification = Notification.objects.get(
                id=notification_id,
                recipient=recipient_email
            )
            notification.is_read = True
            notification.save()
            return True
        except Notification.DoesNotExist:
            return False
