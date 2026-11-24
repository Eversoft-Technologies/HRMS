"""Short leave (permission) — arrive late / leave early / step out for up to
``short_leave_max_minutes``, approved by the manager (workstream P).

Rules (the employee's attendance policy profile, api/attendance_ext/policy.py):
  * kind: late_in | early_out | middle, with a from / to time. late_in may
    omit "from" (= the shift start), early_out may omit "to" (= the shift end).
  * minutes = to - from, 1 .. short_leave_max_minutes;
  * at most short_leaves_per_month Pending + Approved requests per calendar
    month (0 = short leave not available under the profile);
  * one Pending / Approved request per day and kind;
  * own requests only; the date may be up to the missed-punch policy's
    max_days_back in the past and 90 days ahead.
Approver: the employee's manager (org_views.approver_for), or a holder of
attendance.edit — never the employee themself.
Approval re-classifies the day when it is already closed (approved minutes
count as worked; late_in / early_out suppress late / early out, see
day_status.py) and re-evaluates that month's penalties, which removes a
penalty the short leave now covers. Cancelling an approved one does the same
in reverse.

    GET  /api/attendance/short-leave?email=&month=YYYY-MM   own list + quota (+ canReview)
    POST /api/attendance/short-leave                        {date, kind, fromTime, toTime, reason}
    GET  /api/attendance/short-leave/queue?status=Pending|all
    POST /api/attendance/short-leave/<id>/decide            {action: approve|reject, reviewerNote}
    POST /api/attendance/short-leave/<id>/cancel
My Team's inbox lists / decides type 'short_leave' through queue_rows() and
/decide (api/team_hub.py).
"""
import logging
from datetime import date, datetime, timedelta

from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.models import AppUser, ShortLeaveRequest
from api.timeutil import company_date, local_now

logger = logging.getLogger(__name__)

KINDS = ('late_in', 'early_out', 'middle')
KIND_LABELS = {'late_in': 'Late arrival', 'early_out': 'Early leaving', 'middle': 'Step out (mid-day)'}
REVIEW_PERMS = ('attendance.regularize.approve',)
LINK = '/employees/checkin'
FUTURE_DAYS = 90


class Invalid(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _hm(t):
    return t.strftime('%I:%M %p').lstrip('0') if t else ''


def _caller(request):
    from api import permissions
    permissions._CACHE.clear()
    email, user = permissions._get_caller(request)
    if not email or not user or (user.status and user.status != 'active'):
        return None
    return _norm(email)


def is_reviewer(request):
    from api.permissions import check_perm
    return any(check_perm(request, c)[0] for c in REVIEW_PERMS)


def _parse_time(v):
    s = str(v or '').strip()
    if not s:
        return None
    if len(s) > 10 and s[4:5] == '-' and (' ' in s or 'T' in s):      # 'YYYY-MM-DD HH:MM'
        s = s[11:]
    for fmt in ('%H:%M', '%H:%M:%S', '%I:%M %p', '%I:%M%p'):
        try:
            return datetime.strptime(s.upper(), fmt).time()
        except ValueError:
            pass
    raise Invalid(f'"{v}" is not a time. Use HH:MM.')


def _parse_date(v):
    try:
        return datetime.strptime(str(v or '').strip()[:10], '%Y-%m-%d').date()
    except ValueError:
        raise Invalid('Pick a valid date (YYYY-MM-DD).')


def _minutes(a, b):
    m = (datetime.combine(date(2000, 1, 1), b) - datetime.combine(date(2000, 1, 1), a)).total_seconds() // 60
    if m <= 0:
        m += 24 * 60                      # night shift: 23:00 -> 01:00
    return int(m)


def month_usage(email, day, pol):
    used = ShortLeaveRequest.objects.filter(email__iexact=email, date__year=day.year, date__month=day.month,
                                            status__in=('Pending', 'Approved')).count()
    return used, int(pol.short_leaves_per_month or 0)


def quota_json(email, day, pol):
    used, limit = month_usage(email, day, pol)
    return {'used': used, 'limit': limit, 'remaining': max(limit - used, 0), 'month': day.strftime('%B %Y'),
            'maxMinutes': int(pol.short_leave_max_minutes or 0), 'profile': pol.name}


def dto(r):
    return {
        'id': r.id, 'email': r.email, 'employee': r.employee_name or r.email, 'date': r.date.isoformat(),
        'dateLabel': company_date(r.date), 'kind': r.kind, 'kindLabel': KIND_LABELS.get(r.kind, r.kind),
        'fromTime': r.from_time.strftime('%H:%M') if r.from_time else None,
        'toTime': r.to_time.strftime('%H:%M') if r.to_time else None,
        'fromLabel': _hm(r.from_time), 'toLabel': _hm(r.to_time),
        'minutes': r.minutes, 'reason': r.reason or '', 'status': r.status,
        'approver': r.approver_email or '', 'decidedBy': r.decided_by or '',
        'decidedAt': r.decided_at.strftime('%Y-%m-%d %H:%M:%S') if r.decided_at else None,
        'reviewerNote': r.reviewer_note or '',
        'createdAt': r.created_at.strftime('%Y-%m-%d %H:%M:%S') if r.created_at else None,
    }


# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------
def submit(email, body, now=None):
    from api import org_views
    from api.attendance_ext import missed_punch as mp
    from api.models import EmployeeAttendance
    from .policy import resolve
    now = now or local_now()
    email = _norm(email)
    day = _parse_date(body.get('date'))
    kind = _norm(body.get('kind')) or 'early_out'
    if kind not in KINDS:
        raise Invalid('Kind must be late_in, early_out or middle.')
    reason = str(body.get('reason') or '').strip()
    if not reason:
        raise Invalid('Give a reason for the short leave.')
    today = now.date()
    back = int(mp.policy().get('max_days_back') or 31)
    if day < today - timedelta(days=back):
        raise Invalid(f'Short leave can be requested for the last {back} days at most.')
    if day > today + timedelta(days=FUTURE_DAYS):
        raise Invalid(f'Short leave can be requested at most {FUTURE_DAYS} days ahead.')
    pol = resolve(email)
    limit = int(pol.short_leaves_per_month or 0)
    if limit <= 0:
        raise Invalid('Short leave is not available under your attendance policy.', 403)
    probe = EmployeeAttendance.objects.filter(email__iexact=email, date=day).first() \
        or EmployeeAttendance(email=email, date=day)
    shift = mp.shift_of(probe)
    t_from = _parse_time(body.get('fromTime') or body.get('from'))
    t_to = _parse_time(body.get('toTime') or body.get('to'))
    if kind == 'late_in' and t_from is None and shift is not None and not shift.is_flexible:
        t_from = shift.start_time
    if kind == 'early_out' and t_to is None and shift is not None and not shift.is_flexible:
        t_to = shift.end_time
    if t_from is None or t_to is None:
        raise Invalid('Enter the from and to times.')
    minutes = _minutes(t_from, t_to)
    cap = int(pol.short_leave_max_minutes or 0)
    if cap and minutes > cap:
        raise Invalid(f'A short leave can be at most {cap} minutes ({cap // 60}h {cap % 60:02d}m); '
                      f'this one is {minutes} minutes.')
    with transaction.atomic():
        # Lock the employee's rows of the month so two submits cannot both pass the limit.
        list(ShortLeaveRequest.objects.select_for_update().filter(email__iexact=email, date__year=day.year,
                                                                  date__month=day.month))
        if ShortLeaveRequest.objects.filter(email__iexact=email, date=day, kind=kind,
                                            status__in=('Pending', 'Approved')).exists():
            raise Invalid('You already have a short leave of this kind for that day.')
        used, _limit = month_usage(email, day, pol)
        if used >= limit:
            raise Invalid(f'You have used all {limit} short leaves for {day:%B %Y}.', 409)
        user = AppUser.objects.filter(email__iexact=email).first()
        approver = org_views.approver_for(email)
        r = ShortLeaveRequest.objects.create(
            email=email, employee_name=(user.full_name if user else '') or email.split('@')[0],
            date=day, kind=kind, from_time=t_from, to_time=t_to, minutes=minutes, reason=reason[:2000],
            status='Pending', approver_email=approver)
    from api.views import create_notification, notify_approvers
    msg = (f'{r.employee_name} asked for a short leave on {company_date(day)} '
           f'({KIND_LABELS[kind].lower()}, {_hm(t_from)} – {_hm(t_to)}, {minutes} min). Reason: "{reason[:200]}"')
    if approver:
        create_notification(approver, 'Short leave to approve', msg, 'info', '/my-team')
    else:
        notify_approvers('attendance.regularize.approve', 'Short leave to approve', msg, '/my-team')
    return r


# ---------------------------------------------------------------------------
# decide
# ---------------------------------------------------------------------------
def can_decide(request, r):
    """(caller, error_response)."""
    from api import org_views
    caller = _caller(request)
    if not caller:
        return None, _err('Authentication required. Please sign in again.', 401)
    if caller == _norm(r.email):
        return caller, _err('You cannot approve or reject your own short leave.', 403, 'SELF_APPROVAL')
    if is_reviewer(request) or caller == _norm(r.approver_email) or org_views.is_manager_of(caller, r.email):
        return caller, None
    return caller, _err('You are not allowed to decide this short leave.', 403)


def queue_rows(request, status='Pending'):
    from api import org_views
    caller = _caller(request)
    if not caller:
        return []
    qs = ShortLeaveRequest.objects.exclude(email__iexact=caller)
    if status and status.lower() != 'all':
        qs = qs.filter(status=status)
    if not is_reviewer(request):
        qs = qs.filter(Q(approver_email__iexact=caller) | Q(email__in=org_views.reports_of(caller)))
    return list(qs.order_by('date', 'id')[:300])


def _after_change(r, actor, why):
    """Re-classify the day (if closed) and re-evaluate the month's penalties."""
    from . import day_status, penalties
    try:
        day_status.reclassify_day(r.email, r.date, actor, 'short_leave', why)
    except Exception:
        logger.exception('short leave %s: re-classification failed', r.pk)
    penalties.evaluate_for_day(r.email, r.date)


def decide(r, actor, action, note=''):
    from api.views import create_notification
    now = local_now()
    status = 'Approved' if action == 'approve' else 'Rejected'
    n = (ShortLeaveRequest.objects.filter(pk=r.pk, status='Pending')
         .update(status=status, decided_by=actor, decided_at=now, reviewer_note=note))
    r.refresh_from_db()
    if not n:
        raise Invalid(f'This short leave has already been {(r.status or "decided").lower()}.', 409)
    if status == 'Approved':
        _after_change(r, actor, f'Short leave approved ({KIND_LABELS.get(r.kind, r.kind)}, {r.minutes} min)')
        create_notification(r.email, 'Short leave approved',
                            f'Your short leave on {company_date(r.date)} ({_hm(r.from_time)} – {_hm(r.to_time)}) '
                            f'was approved by {actor}.' + (f' Note: {note}' if note else ''), 'success', LINK)
    else:
        create_notification(r.email, 'Short leave rejected',
                            f'Your short leave on {company_date(r.date)} was rejected by {actor}.'
                            + (f' Note: {note}' if note else ''), 'warning', LINK)
    return r


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
def short_leave(request):
    from api import org_views
    from api.permissions import check_perm
    from .policy import resolve
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    now = local_now()
    if request.method == 'POST':
        body = request.data or {}
        email = _norm(body.get('email')) or caller
        if email != caller:
            return _err('You can only request short leave for yourself.', 403)
        try:
            r = submit(email, body, now)
        except Invalid as e:
            return _err(str(e), e.status)
        return Response(dto(r), status=201)
    email = _norm(request.query_params.get('email')) or caller
    if email != caller and not (is_reviewer(request) or check_perm(request, 'attendance.view')[0]
                                or org_views.is_manager_of(caller, email)):
        return _err('You are not allowed to view these short leaves.', 403)
    month = str(request.query_params.get('month') or '').strip()
    try:
        y, m = (int(month[:4]), int(month[5:7])) if month else (now.year, now.month)
        ref = date(y, m, 1)
    except ValueError:
        return _err('month must be YYYY-MM.')
    pol = resolve(email)
    rows = ShortLeaveRequest.objects.filter(email__iexact=email).filter(
        Q(date__year=ref.year, date__month=ref.month) | Q(status='Pending')).order_by('-date', '-id')[:100]
    return Response({'email': email, 'month': f'{ref:%Y-%m}', 'items': [dto(r) for r in rows],
                     'quota': quota_json(email, ref, pol),
                     'kinds': [{'value': k, 'label': KIND_LABELS[k]} for k in KINDS],
                     'canReview': is_reviewer(request) or bool(queue_rows(request))})


@api_view(['GET'])
def short_leave_queue(request):
    if not _caller(request):
        return _err('Authentication required. Please sign in again.', 401)
    rows = queue_rows(request, (request.query_params.get('status') or 'Pending').strip())
    return Response([dto(r) for r in rows])


@api_view(['POST'])
def short_leave_decide(request, pk):
    r = ShortLeaveRequest.objects.filter(pk=pk).first()
    if not r:
        return _err('Short leave not found.', 404)
    caller, denied = can_decide(request, r)
    if denied:
        return denied
    action = _norm((request.data or {}).get('action'))
    note = str((request.data or {}).get('reviewerNote') or (request.data or {}).get('note') or '').strip()[:1000]
    if action not in ('approve', 'reject'):
        return _err('action must be approve or reject')
    try:
        r = decide(r, caller, action, note)
    except Invalid as e:
        return _err(str(e), e.status)
    return Response({'success': True, 'message': f'Short leave {"approved" if action == "approve" else "rejected"}.',
                     'shortLeave': dto(r)})


@api_view(['POST'])
def short_leave_cancel(request, pk):
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    r = ShortLeaveRequest.objects.filter(pk=pk).first()
    if not r:
        return _err('Short leave not found.', 404)
    if _norm(r.email) != caller:
        return _err('You can only cancel your own short leave.', 403)
    if r.status not in ('Pending', 'Approved'):
        return _err(f'This short leave is already {r.status.lower()}.', 409)
    was = r.status
    ShortLeaveRequest.objects.filter(pk=r.pk).update(status='Cancelled', decided_at=local_now())
    r.refresh_from_db()
    if was == 'Approved':
        _after_change(r, caller, 'Approved short leave cancelled')
    return Response({'success': True, 'message': 'Short leave cancelled.', 'shortLeave': dto(r)})
