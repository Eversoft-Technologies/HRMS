"""Individual timesheets and the attendance change history (Phase 3).

Timesheets
----------
People log hours per project / task per day (``TimesheetEntry``). A week
(Monday-start, ``TimesheetWeek``) moves Draft -> Submitted -> Approved /
Rejected. A submitted or approved week is locked; editing any entry of a
rejected week puts it back to Draft. The employee's linked manager decides
(org_views.approver_for), and so can anyone holding ``timesheet.approve`` --
but nobody decides their own week.

Attendance audit
----------------
``log_attendance_change`` writes one ``AttendanceAuditLog`` row per changed
field of an attendance day. The attendance write paths call it as
``before = audit_snapshot(att)`` ... save ... ``log_attendance_change(att,
before, source, actor, reason)``. Both helpers swallow their own errors: an
audit failure must never break the request that changed the attendance.
"""
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from django.db.models import Sum
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import (AppUser, AttendanceAuditLog, EmployeeAttendance, EmployeeTask,
                     TimesheetEntry, TimesheetWeek)
from .permissions import _get_caller, _is_super_admin, _user_has_perm
from .timeutil import local_now, local_today

logger = logging.getLogger(__name__)

APPROVE_PERM = 'timesheet.approve'
AUDIT_PERM = 'attendance.audit'
LOCKED = ('Submitted', 'Approved')
MAX_DAY = Decimal('24')
DT_FMT = '%Y-%m-%d %H:%M:%S'


# ---------------------------------------------------------------------------
# Attendance audit helpers (used by the attendance write paths)
# ---------------------------------------------------------------------------
AUDIT_FIELDS = ('check_in', 'check_out', 'worked_minutes', 'break_minutes', 'overtime_minutes',
                'status', 'note', 'is_wfh', 'auto_checkout_at')


def _audit_str(v):
    if v is None:
        return ''
    if isinstance(v, datetime):
        return v.strftime(DT_FMT)
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, bool):
        return 'Yes' if v else 'No'
    return str(v)


def audit_snapshot(att):
    """The audited fields of ``att`` as strings; None for a row not saved yet."""
    try:
        if att is None or not getattr(att, 'pk', None):
            return None
        return {f: _audit_str(getattr(att, f, None)) for f in AUDIT_FIELDS}
    except Exception:          # never let auditing break the caller
        logger.exception('attendance audit snapshot failed')
        return None


def log_attendance_change(att, before, source='edit', actor='', reason=''):
    """Write one audit row per field that differs between ``before`` (from
    audit_snapshot, or None for a new row) and ``att`` as it is now.
    Returns the number of rows written (0 on any error)."""
    try:
        if att is None or not getattr(att, 'pk', None):
            return 0
        before = before or {}
        now = local_now()
        rows = []
        for f in AUDIT_FIELDS:
            old, new = before.get(f, ''), _audit_str(getattr(att, f, None))
            if old != new:
                rows.append(AttendanceAuditLog(
                    attendance_id=att.pk, email=_norm(att.email), date=att.date, source=source,
                    field=f, old_value=old, new_value=new, actor=str(actor or '')[:255],
                    reason=str(reason or ''), at=now))
        if rows:
            AttendanceAuditLog.objects.bulk_create(rows)
        return len(rows)
    except Exception:
        logger.exception('attendance audit log failed (attendance %s)', getattr(att, 'pk', None))
        return 0


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _caller(request):
    """(email, user, error_response)."""
    email, user = _get_caller(request)
    email = _norm(email)
    if not email or not user:
        return email, user, _err('Authentication required. Please sign in again.', 401, 'AUTH_REQUIRED')
    if (user.status or 'active') != 'active':
        return email, user, _err('Permission denied: account is not active', 403, 'FORBIDDEN')
    return email, user, None


def _parse_date(s):
    try:
        return datetime.strptime(str(s or '').strip()[:10], '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return None


def _monday(d):
    return d - timedelta(days=d.weekday())


def _fmt_dt(v):
    return v.strftime(DT_FMT) if v else None


def _hours(v):
    return float(v or 0)


def _name_of(email):
    from . import org_views
    card = org_views.person_card(email)
    return card['name'] if card else (email.split('@')[0] if email else '')


def _is_manager(caller, emp):
    from . import org_views
    return bool(caller and emp and caller != _norm(emp) and org_views.is_manager_of(caller, emp))


def _can_view_person(caller, user, email):
    """Own data, or the person's manager, or an approver / auditor."""
    email = _norm(email)
    if email == caller:
        return True
    return (_user_has_perm(user, APPROVE_PERM) or _user_has_perm(user, AUDIT_PERM)
            or _is_manager(caller, email))


def _can_decide(caller, user, wk):
    if _norm(wk.email) == caller:
        return False
    return (_user_has_perm(user, APPROVE_PERM) or _is_manager(caller, wk.email)
            or (wk.approver_email and _norm(wk.approver_email) == caller))


def _entry_dict(e):
    return {
        'id': e.id, 'email': e.email, 'date': e.date.isoformat(), 'project': e.project,
        'taskId': e.task_id, 'taskTitle': e.task_title, 'hours': _hours(e.hours),
        'description': e.description, 'billable': bool(e.billable),
        'createdAt': _fmt_dt(e.created_at), 'updatedAt': _fmt_dt(e.updated_at),
    }


def _week_entries(email, ws):
    return TimesheetEntry.objects.filter(email=email, date__gte=ws, date__lte=ws + timedelta(days=6)) \
        .order_by('date', 'id')


def _week_dict(wk, with_entries=False):
    d = {
        'id': wk.id, 'email': wk.email, 'employeeName': wk.employee_name or _name_of(wk.email),
        'weekStart': wk.week_start.isoformat(), 'weekEnd': (wk.week_start + timedelta(days=6)).isoformat(),
        'status': wk.status, 'totalHours': _hours(wk.total_hours),
        'approverEmail': wk.approver_email, 'submittedAt': _fmt_dt(wk.submitted_at),
        'decidedBy': wk.decided_by, 'decidedAt': _fmt_dt(wk.decided_at), 'decisionNote': wk.decision_note,
    }
    if with_entries:
        d['entries'] = [_entry_dict(e) for e in _week_entries(wk.email, wk.week_start)]
    return d


def _week_total(email, ws):
    return _week_entries(email, ws).aggregate(t=Sum('hours'))['t'] or Decimal('0')


def _get_week(email, ws, create=False):
    wk = TimesheetWeek.objects.filter(email=email, week_start=ws).first()
    if wk is None and create:
        wk = TimesheetWeek.objects.create(email=email, week_start=ws, employee_name=_name_of(email))
    return wk


def _touch_week(email, ws):
    """After an entry change: refresh the total; a Rejected week goes back to Draft."""
    wk = _get_week(email, ws, create=True)
    wk.total_hours = _week_total(email, ws)
    fields = ['total_hours']
    if wk.status == 'Rejected':
        wk.status = 'Draft'
        fields.append('status')
    wk.save(update_fields=fields)
    return wk


def _locked(email, d):
    wk = _get_week(email, _monday(d))
    return bool(wk and wk.status in LOCKED)


def _locked_response(d):
    return _err(f'The week of {_monday(d).isoformat()} is submitted or approved, so its entries '
                f'cannot be changed.', 409, 'WEEK_LOCKED')


def _clean_entry(data, email, exclude_id=None, current=None):
    """(fields dict, error_response) from a POST / PUT body."""
    out = {}
    raw_date = data.get('date')
    if raw_date is None and current is not None:
        d = current.date
    else:
        d = _parse_date(raw_date)
        if not d:
            return None, _err('date is required (YYYY-MM-DD).')
    out['date'] = d

    if 'hours' in data or current is None:
        try:
            h = Decimal(str(data.get('hours'))).quantize(Decimal('0.01'))
        except (InvalidOperation, TypeError, ValueError):
            return None, _err('hours must be a number.')
        if h <= 0 or h > MAX_DAY:
            return None, _err('hours must be more than 0 and at most 24.')
        if (h * 4) != (h * 4).to_integral_value():
            return None, _err('hours must be in steps of 0.25 (15 minutes).')
        out['hours'] = h
    else:
        out['hours'] = current.hours

    if 'project' in data or current is None:
        out['project'] = str(data.get('project') or '').strip()[:255]
    if not (out.get('project', current.project if current else '')):
        return None, _err('project is required.')
    if 'description' in data or current is None:
        out['description'] = str(data.get('description') or '').strip()
    if 'billable' in data or current is None:
        b = data.get('billable', True)
        out['billable'] = b if isinstance(b, bool) else str(b).lower() not in ('false', '0', 'no', '')

    tkey = 'taskId' if 'taskId' in data else ('task_id' if 'task_id' in data else None)
    if tkey or current is None:
        tid = data.get(tkey) if tkey else None
        if tid in (None, '', 0, '0'):
            out['task_id'], out['task_title'] = None, ''
        else:
            try:
                task = EmployeeTask.objects.filter(pk=int(tid)).first()
            except (TypeError, ValueError):
                task = None
            if not task:
                return None, _err('That task was not found.')
            out['task_id'], out['task_title'] = task.id, task.title[:255]

    day_total = TimesheetEntry.objects.filter(email=email, date=d).exclude(pk=exclude_id) \
        .aggregate(t=Sum('hours'))['t'] or Decimal('0')
    if day_total + out['hours'] > MAX_DAY:
        return None, _err(f'That would make {_hours(day_total + out["hours"]):g} hours on {d.isoformat()}; '
                          f'a day cannot have more than 24.', 400, 'DAY_OVER_24')
    return out, None


# ---------------------------------------------------------------------------
# entries
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
def entries(request):
    caller, user, denied = _caller(request)
    if denied:
        return denied
    if request.method == 'GET':
        email = _norm(request.GET.get('email')) or caller
        if not _can_view_person(caller, user, email):
            return _err('You can only see your own timesheet or your team\'s.', 403, 'FORBIDDEN')
        d = _parse_date(request.GET.get('week')) or local_today()
        ws = _monday(d)
        return Response([_entry_dict(e) for e in _week_entries(email, ws)])

    data = request.data or {}
    fields, bad = _clean_entry(data, caller)
    if bad:
        return bad
    if _locked(caller, fields['date']):
        return _locked_response(fields['date'])
    now = local_now()
    e = TimesheetEntry.objects.create(email=caller, created_at=now, updated_at=now, **fields)
    _touch_week(caller, _monday(e.date))
    return Response(_entry_dict(e), status=201)


@api_view(['PUT', 'DELETE'])
def entry_detail(request, pk):
    caller, user, denied = _caller(request)
    if denied:
        return denied
    e = TimesheetEntry.objects.filter(pk=pk).first()
    if not e:
        return _err('Entry not found.', 404)
    if _norm(e.email) != caller:
        return _err('You can only change your own timesheet entries.', 403, 'FORBIDDEN')
    if _locked(caller, e.date):
        return _locked_response(e.date)
    old_ws = _monday(e.date)
    if request.method == 'DELETE':
        e.delete()
        _touch_week(caller, old_ws)
        return Response({'ok': True})

    fields, bad = _clean_entry(request.data or {}, caller, exclude_id=e.pk, current=e)
    if bad:
        return bad
    if fields['date'] != e.date and _locked(caller, fields['date']):
        return _locked_response(fields['date'])
    for k, v in fields.items():
        setattr(e, k, v)
    e.updated_at = local_now()
    e.save()
    _touch_week(caller, old_ws)
    if _monday(e.date) != old_ws:
        _touch_week(caller, _monday(e.date))
    return Response(_entry_dict(e))


# ---------------------------------------------------------------------------
# week
# ---------------------------------------------------------------------------
@api_view(['GET'])
def week(request):
    from . import org_views
    caller, user, denied = _caller(request)
    if denied:
        return denied
    email = _norm(request.GET.get('email')) or caller
    if not _can_view_person(caller, user, email):
        return _err('You can only see your own timesheet or your team\'s.', 403, 'FORBIDDEN')
    ws = _monday(_parse_date(request.GET.get('week')) or local_today())
    we = ws + timedelta(days=6)
    wk = _get_week(email, ws)
    rows = list(_week_entries(email, ws))

    per_day = {}
    for e in rows:
        per_day[e.date] = per_day.get(e.date, Decimal('0')) + (e.hours or 0)
    worked = dict(EmployeeAttendance.objects.filter(email=email, date__gte=ws, date__lte=we)
                  .values_list('date', 'worked_minutes'))
    days = [{'date': (ws + timedelta(days=i)).isoformat(),
             'hours': _hours(per_day.get(ws + timedelta(days=i))),
             'attendanceMinutes': int(worked.get(ws + timedelta(days=i)) or 0)} for i in range(7)]

    appr_email = (wk.approver_email if wk and wk.approver_email else '') or org_views.approver_for(email)
    projects, seen = [], set()
    for p in TimesheetEntry.objects.filter(email=email).exclude(project='') \
            .order_by('-date', '-id').values_list('project', flat=True)[:300]:
        if p.lower() not in seen:
            seen.add(p.lower())
            projects.append(p)
        if len(projects) >= 30:
            break
    tasks = [{'id': t.id, 'title': t.title} for t in
             EmployeeTask.objects.filter(assignee_email__iexact=email).exclude(stage='done').order_by('-id')[:100]]

    return Response({
        'id': wk.id if wk else None,
        'email': email,
        'employeeName': (wk.employee_name if wk and wk.employee_name else '') or _name_of(email),
        'weekStart': ws.isoformat(), 'weekEnd': we.isoformat(),
        'status': wk.status if wk else 'Draft',
        'locked': bool(wk and wk.status in LOCKED),
        'totalHours': _hours(sum((e.hours or 0) for e in rows)),
        'entries': [_entry_dict(e) for e in rows],
        'days': days,
        'approver': {'email': appr_email, 'name': _name_of(appr_email)} if appr_email else None,
        'submittedAt': _fmt_dt(wk.submitted_at) if wk else None,
        'decidedBy': wk.decided_by if wk else '',
        'decidedAt': _fmt_dt(wk.decided_at) if wk else None,
        'decisionNote': wk.decision_note if wk else '',
        'projects': projects,
        'tasks': tasks,
        'me': {
            'email': caller,
            'canApprove': _user_has_perm(user, APPROVE_PERM),
            'canAudit': _user_has_perm(user, AUDIT_PERM),
            'hasReports': bool(org_views.reports_of(caller)),
            'superAdmin': _is_super_admin(user),
        },
    })


def _notify(email, title, message, link, ntype='info'):
    try:
        from .views import create_notification
        create_notification(email, title, message, ntype, link)
    except Exception:
        logger.exception('timesheet notification failed')


@api_view(['POST'])
def submit_week(request):
    from . import org_views
    caller, user, denied = _caller(request)
    if denied:
        return denied
    data = request.data or {}
    ws = _monday(_parse_date(data.get('week') or data.get('weekStart')) or local_today())
    if not _week_entries(caller, ws).exists():
        return _err('Add at least one entry before submitting the week.', 400, 'EMPTY_WEEK')
    wk = _get_week(caller, ws, create=True)
    if wk.status in LOCKED:
        return _err(f'This week is already {wk.status.lower()}.', 409, 'WEEK_LOCKED')
    wk.status = 'Submitted'
    wk.total_hours = _week_total(caller, ws)
    wk.approver_email = org_views.approver_for(caller)
    wk.employee_name = wk.employee_name or _name_of(caller)
    wk.submitted_at = local_now()
    wk.decided_by, wk.decided_at, wk.decision_note = '', None, ''
    wk.save()

    title = 'Timesheet submitted'
    msg = (f'{wk.employee_name} submitted the timesheet for the week of {ws.isoformat()} '
           f'({_hours(wk.total_hours):g} h).')
    if wk.approver_email:
        _notify(wk.approver_email, title, msg, '/timesheets/approvals')
    else:
        for u in AppUser.objects.filter(status='active').exclude(email__iexact=caller):
            if not _is_super_admin(u) and _user_has_perm(u, APPROVE_PERM):
                _notify(u.email, title, msg, '/timesheets/approvals')
    return Response(_week_dict(wk, with_entries=True))


# ---------------------------------------------------------------------------
# approvals
# ---------------------------------------------------------------------------
@api_view(['GET'])
def approvals(request):
    from . import org_views
    caller, user, denied = _caller(request)
    if denied:
        return denied
    can_all = _user_has_perm(user, APPROVE_PERM)
    reports = [_norm(e) for e in org_views.reports_of(caller)]
    qs = TimesheetWeek.objects.exclude(email__iexact=caller)
    if not can_all:
        if not reports and not TimesheetWeek.objects.filter(approver_email__iexact=caller).exists():
            return _err('You have no team timesheets to approve.', 403, 'NOT_APPROVER')
        from django.db.models import Q
        qs = qs.filter(Q(email__in=reports) | Q(approver_email__iexact=caller))
    status = (request.GET.get('status') or 'Submitted').strip()
    if status.lower() != 'all':
        qs = qs.filter(status__iexact=status)
    else:
        qs = qs.exclude(status='Draft')
    qs = qs.order_by('-submitted_at', '-week_start')[:200]
    return Response({
        'canApproveAll': can_all,
        'hasReports': bool(reports),
        'weeks': [_week_dict(w, with_entries=True) for w in qs],
    })


@api_view(['POST'])
def decide_week(request, pk):
    caller, user, denied = _caller(request)
    if denied:
        return denied
    wk = TimesheetWeek.objects.filter(pk=pk).first()
    if not wk:
        return _err('Timesheet week not found.', 404)
    if _norm(wk.email) == caller:
        return _err('You cannot approve or reject your own timesheet.', 403, 'OWN_WEEK')
    if not _can_decide(caller, user, wk):
        return _err(f'Permission denied: {APPROVE_PERM}', 403, 'FORBIDDEN')
    data = request.data or {}
    action = str(data.get('action') or '').strip().lower()
    note = str(data.get('note') or '').strip()
    if action not in ('approve', 'reject'):
        return _err('action must be approve or reject.')
    if wk.status != 'Submitted':
        return _err(f'This week is {wk.status.lower()}, not waiting for a decision.', 409, 'NOT_SUBMITTED')
    if action == 'reject' and not note:
        return _err('Give a reason when rejecting a timesheet.', 400, 'NOTE_REQUIRED')
    wk.status = 'Approved' if action == 'approve' else 'Rejected'
    wk.decided_by = caller
    wk.decided_at = local_now()
    wk.decision_note = note
    wk.save(update_fields=['status', 'decided_by', 'decided_at', 'decision_note'])
    who = _name_of(caller)
    if action == 'approve':
        _notify(wk.email, 'Timesheet approved',
                f'{who} approved your timesheet for the week of {wk.week_start.isoformat()}.'
                + (f' Note: {note}' if note else ''), '/timesheets', 'success')
    else:
        _notify(wk.email, 'Timesheet rejected',
                f'{who} rejected your timesheet for the week of {wk.week_start.isoformat()}: {note}. '
                f'Edit it and submit again.', '/timesheets', 'warning')
    return Response(_week_dict(wk, with_entries=True))


# ---------------------------------------------------------------------------
# attendance audit trail
# ---------------------------------------------------------------------------
def _audit_dict(r):
    return {
        'id': r.id, 'attendanceId': r.attendance_id, 'email': r.email,
        'at': _fmt_dt(r.at), 'date': r.date.isoformat() if r.date else None,
        'source': r.source, 'field': r.field, 'oldValue': r.old_value, 'newValue': r.new_value,
        'actor': r.actor, 'reason': r.reason,
    }


@api_view(['GET'])
def attendance_audit(request):
    caller, user, denied = _caller(request)
    if denied:
        return denied
    qs = AttendanceAuditLog.objects.all()
    att_id = request.GET.get('attendanceId')
    if att_id:
        try:
            att_id = int(att_id)
        except (TypeError, ValueError):
            return _err('attendanceId must be a number.')
        att = EmployeeAttendance.objects.filter(pk=att_id).first()
        first = AttendanceAuditLog.objects.filter(attendance_id=att_id).first()
        email = _norm(att.email if att else (first.email if first else ''))
        qs = qs.filter(attendance_id=att_id)
        if not email:
            return Response([])
    else:
        email = _norm(request.GET.get('email')) or caller
        qs = qs.filter(email=email)
    if email != caller and not (_user_has_perm(user, AUDIT_PERM) or _is_manager(caller, email)):
        return _err('You can only see your own attendance history.', 403, 'FORBIDDEN')
    frm, to = _parse_date(request.GET.get('from')), _parse_date(request.GET.get('to'))
    if frm:
        qs = qs.filter(date__gte=frm)
    if to:
        qs = qs.filter(date__lte=to)
    return Response([_audit_dict(r) for r in qs.order_by('-at', '-id')[:1000]])
