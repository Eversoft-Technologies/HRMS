"""Realtime broadcasts for the F2F employee-detail popup.

post_save on EmployeeTask / EmployeeAttendance pushes a small event to the
per-employee WebSocket group (emp_<email>), so an open popup updates live
without polling. Best-effort: any failure (no channel layer configured,
serialization) is swallowed so it never affects the request that saved the row.
"""
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import EmployeeTask, EmployeeAttendance, WorkSubmission, LeaveRequest


def _norm(e):
    return str(e or '').strip().lower()


def _group(email):
    # Must match EmployeeStatusConsumer: channel group names allow only
    # [A-Za-z0-9._-], so the email's "@" (and any stray char) becomes "_".
    import re
    return ('emp_' + re.sub(r'[^a-z0-9._-]', '_', _norm(email)))[:95]


def _push(email, msg_type, data):
    if not _norm(email):
        return
    try:
        from channels.layers import get_channel_layer
        from asgiref.sync import async_to_sync
        layer = get_channel_layer()
        if not layer:
            return
        async_to_sync(layer.group_send)(_group(email), {'type': msg_type, 'data': data})
    except Exception:
        pass


@receiver(post_save, sender=EmployeeTask)
def _task_saved(sender, instance, **kwargs):
    # Slim payload (no base64 attachments) so the socket message stays small.
    data = {
        'id': instance.id,
        'title': instance.title,
        'stage': instance.stage,
        'progress': instance.progress,
        'priority': instance.priority,
        'assigneeEmail': instance.assignee_email,
        'rejectReason': instance.reject_reason or '',
        'due': instance.due or '',
    }
    _push(instance.assignee_email, 'task_update', data)


@receiver(post_save, sender=EmployeeAttendance)
def _attendance_saved(sender, instance, **kwargs):
    _push(instance.email, 'attendance_update', {'email': _norm(instance.email), 'date': str(instance.date)})


@receiver(post_save, sender=WorkSubmission)
def _submission_saved(sender, instance, **kwargs):
    data = {
        'id': instance.id,
        'title': instance.title,
        'status': instance.status,
        'type': getattr(instance, 'type', ''),
    }
    _push(instance.email, 'submission_update', data)


@receiver(post_save, sender=LeaveRequest)
def _leave_saved(sender, instance, **kwargs):
    data = {
        'id': instance.id,
        'type': instance.type,
        'status': instance.status,
    }
    _push(instance.email, 'leave_update', data)
