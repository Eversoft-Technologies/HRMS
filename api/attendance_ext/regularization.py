"""Regularization: the employee's fix for an incomplete day, and its approval.

Extends the forgot-punch ticket workflow (AttendanceCorrection) instead of
adding a table: a regularization is an AttendanceCorrection row with
``kind='regularize'``, the requested check-in and/or check-out, a structured
``reason_code`` (+ free-text ``reason``, required for 'other') and an optional
proof image. It routes to the employee's manager (org_views.approver_for) and
can be decided by that manager, by holders of attendance.edit /
attendance.approve_wfh / settings.manage — never by the employee themself.

Approval rewrites the day the same way a live check-out would have:
  * the check-in / check-out events of the trail are moved (or added), so the
    day's timeline and _recompute_worked() agree;
  * worked minutes are recomputed over all sessions (views._recompute_worked),
    overtime / early exit / late from the shift, then the day status from
    the hours under the employee's attendance policy (day_status.py:
    absent / half-day / late / present), and the month's late / early-out
    penalties are re-evaluated (penalties.py — a late it removes drops its
    penalty);
  * the punch issue is cleared and every changed field goes to the attendance
    audit log (source 'regularization').
Payroll reads status / worked minutes from EmployeeAttendance, so an approved
regularization removes a false Loss of Pay by itself.

Filing after the deadline is allowed but reported as late (``late`` in every
DTO), unless the policy's block_after_deadline is on.

ONE missed-punch feature
------------------------
Every AttendanceCorrection row is a "missed punch request", whatever entry
point made it:
  * kind='regularize'        — this module (Check In / Out card, Leave page
                               button, and — since the merge — the old
                               /api/attendance/punch-ticket POST too);
  * kind='forgot_checkin' / 'forgot_checkout' — old forgot-punch tickets
                               (no longer created; existing rows stay valid);
  * kind=''                  — old Leave-page "Missed Clock-Out" corrections.
They share one rule set:
  * one monthly limit (policy ``monthly_limit``, default 3, 0 = none) counting
    every kind filed for days of the same attendance month, rejected ones
    excluded (so a rejected request can be corrected and re-filed);
  * one pending request per day (any kind);
  * the deadline / late flag of the day (``late`` in every DTO);
  * reason code required, proof photo optional;
  * one queue (queue_rows) and one approval path (approve → recalculate):
    a legacy row without requested times gets the shift start / end it
    always implied (legacy_times), then goes through the same code.
"""
import logging
from datetime import datetime, time, timedelta

from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.models import AppUser, AttendanceCorrection, AttendanceEvent, EmployeeAttendance
from api.timeutil import company_date, local_now

from . import missed_punch as mp

logger = logging.getLogger(__name__)

KIND = 'regularize'
LEGACY_KINDS = ('forgot_checkin', 'forgot_checkout')
KIND_LABELS = {
    KIND: 'Regularization',
    'forgot_checkin': 'Missed check-in (ticket)',
    'forgot_checkout': 'Missed check-out (ticket)',
    '': 'Clock-out correction',
}
AUDIT_SOURCES = {KIND: 'regularization', 'forgot_checkin': 'punch_ticket', 'forgot_checkout': 'punch_ticket',
                 '': 'correction'}
REASON_CODES = (
    ('client_meeting', 'Client meeting'),
    ('forgot_badge', 'Forgot ID badge'),
    ('network_issue', 'Network issue'),
    ('field_work', 'Field work'),
    ('system_issue', 'System issue'),
    ('other', 'Other'),
)
REASON_LABELS = dict(REASON_CODES)
REVIEW_PERMS = ('attendance.regularize.approve',)   # + the employee's manager (can_decide)
MAX_PROOF = 8 * 1024 * 1024
FUTURE_SLACK = timedelta(minutes=5)


class Invalid(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _err(message, status=400):
    from api.views import err
    return err(message, status)


def _norm(v):
    return str(v or '').strip().lower()


def _dt(v):
    return v.strftime('%Y-%m-%d %H:%M:%S') if v else None


def _ampm(v):
    return v.strftime('%I:%M %p').lstrip('0') if v else ''


# ---------------------------------------------------------------------------
# reason codes (shared with the forgot-punch ticket)
# ---------------------------------------------------------------------------
def clean_reason(code, reason, require_code=True):
    """(code, reason) or raise Invalid."""
    code = _norm(code)
    reason = str(reason or '').strip()
    if not code:
        if require_code:
            raise Invalid('Choose a reason (reasonCode): ' + ', '.join(c for c, _ in REASON_CODES) + '.')
    elif code not in REASON_LABELS:
        raise Invalid('Unknown reasonCode "%s". Use one of: %s.' % (code, ', '.join(c for c, _ in REASON_CODES)))
    if code == 'other' and not reason:
        raise Invalid('Describe the reason when you choose "Other".')
    if len(reason) > 2000:
        raise Invalid('The reason is too long (2000 characters at most).')
    return code, reason


def reason_codes_json():
    return [{'code': c, 'label': l} for c, l in REASON_CODES]


# ---------------------------------------------------------------------------
# time parsing / validation
# ---------------------------------------------------------------------------
def _parse(value, day):
    """datetime from 'HH:MM', 'YYYY-MM-DD HH:MM[:SS]' or 'YYYY-MM-DDTHH:MM[:SS]'.
    Returns (datetime, time_only)."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None, microsecond=0), False
    s = str(value or '').strip().replace('T', ' ')
    if not s:
        return None, False
    for fmt in ('%H:%M', '%H:%M:%S'):
        try:
            return datetime.combine(day, datetime.strptime(s, fmt).time()), True
        except ValueError:
            pass
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
        try:
            return datetime.strptime(s[:19], fmt), False
        except ValueError:
            pass
    raise Invalid(f'"{value}" is not a time. Use HH:MM or YYYY-MM-DD HH:MM.')


def resolve_times(att, email, day, raw_in, raw_out, now, shift=None, pol=None):
    """Validate the requested times against the day. Returns
    (req_in, req_out, final_in, final_out); raises Invalid."""
    from api import views as v
    pol = pol or mp.policy()
    probe = att or EmployeeAttendance(email=email, date=day)
    shift = shift or mp.shift_of(probe)
    start = datetime.combine(day, time(0, 0))
    end = mp.day_end(probe, shift, pol)

    req_in, _ = _parse(raw_in, day) if raw_in else (None, False)
    if not req_in and not raw_out:
        raise Invalid('Enter the check-in and/or the check-out time.')

    was_open = bool(att and att.check_in and v._is_checked_in(att))
    cur_in = att.check_in if att else None
    cur_out = att.check_out if (att and att.check_out and not was_open) else None
    fin_in = req_in or cur_in
    if not fin_in:
        raise Invalid('No check-in is recorded for this day — enter your check-in time too.')

    req_out, time_only = _parse(raw_out, day) if raw_out else (None, False)
    if req_out and time_only and req_out <= fin_in and v._crosses_midnight(shift):
        req_out += timedelta(days=1)               # night shift: 02:30 is the next morning
    fin_out = req_out or cur_out
    if not fin_out:
        raise Invalid('No check-out is recorded for this day — enter your check-out time too.')

    if not (start <= fin_in < end):
        raise Invalid(f'The check-in must be within the work day of {company_date(day)}.')
    if fin_out <= fin_in:
        raise Invalid(f'The check-out must be after the check-in ({_ampm(fin_in)}).')
    if fin_out > end:
        raise Invalid(f'The check-out must be within the work day (by {company_date(end)} {_ampm(end)}).')
    if fin_in > now + FUTURE_SLACK or fin_out > now + FUTURE_SLACK:
        raise Invalid('A regularized time cannot be in the future.')
    if req_in and att and att.check_in:
        earlier = v._earlier_sessions(att) or []
        last_out = max((o for _i, o in earlier), default=None)
        if last_out and req_in < last_out:
            raise Invalid(f'The check-in must be after your earlier session ended ({_ampm(last_out)}).')
    return req_in, req_out, fin_in, fin_out


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------
def is_late(corr, att=None, pol=None):
    att = att if att is not None else EmployeeAttendance.objects.filter(
        email=corr.email, date=corr.attendance_date).first()
    probe = att or EmployeeAttendance(email=corr.email, date=corr.attendance_date)
    deadline = mp.deadline_for(probe, pol=pol)
    return bool(corr.created_at and deadline and corr.created_at > deadline), deadline


def dto(c, att=None, pol=None):
    att = att if att is not None else EmployeeAttendance.objects.filter(
        email=c.email, date=c.attendance_date).first()
    late, deadline = is_late(c, att, pol)
    return {
        'id': c.id,
        'email': c.email,
        'employee': c.employee_name or c.email,
        'date': c.attendance_date.isoformat() if c.attendance_date else None,
        'dateLabel': company_date(c.attendance_date),
        'kind': c.kind or '',
        'kindLabel': KIND_LABELS.get(c.kind or '', c.kind or ''),
        'reasonCode': c.reason_code or '',
        'reasonLabel': REASON_LABELS.get(c.reason_code or '', ''),
        'reason': c.reason or '',
        'status': c.status or 'Pending',
        'reviewer': c.reviewer or '',
        'reviewerNote': c.reviewer_note or '',
        'reviewedAt': _dt(c.reviewed_at),
        'createdAt': _dt(c.created_at),
        'requestedCheckIn': _dt(c.requested_check_in),
        'requestedCheckOut': _dt(c.requested_check_out),
        'requestedCheckInLabel': _ampm(c.requested_check_in),
        'requestedCheckOutLabel': _ampm(c.requested_check_out),
        'currentCheckIn': _dt(att.check_in) if att else None,
        'currentCheckOut': _dt(att.check_out) if att else None,
        'issue': (att.punch_issue if att else '') or '',
        'issueLabel': mp.ISSUE_LABELS.get((att.punch_issue if att else '') or '', ''),
        'hasProof': bool(c.proof_image),
        'late': late,
        'deadline': _dt(deadline),
    }


# ---------------------------------------------------------------------------
# one monthly limit, every kind
# ---------------------------------------------------------------------------
def month_usage(email, day, pol=None):
    """(used, limit) for the attendance month of ``day``. Every request kind
    counts; rejected ones do not. limit 0 = unlimited."""
    pol = pol or mp.policy()
    used = (AttendanceCorrection.objects
            .filter(email=email, attendance_date__year=day.year, attendance_date__month=day.month)
            .exclude(status='Rejected').count())
    return used, int(pol.get('monthly_limit') or 0)


def quota_json(email, day, pol=None):
    used, limit = month_usage(email, day, pol)
    return {'used': used, 'limit': limit, 'remaining': (max(limit - used, 0) if limit else None),
            'month': day.strftime('%B %Y')}


def legacy_times(corr, att, shift):
    """Requested (check-in, check-out) for a row that carries no times — an
    old forgot-punch ticket ("set it to the office hours") or a bare
    correction: the shift start for a missing / corrected check-in, the
    shift end for a missing check-out. Times already on the row win."""
    from api import views as v
    req_in, req_out = corr.requested_check_in, corr.requested_check_out
    if req_in or req_out:
        if corr.kind not in LEGACY_KINDS:
            return req_in, req_out
    start = datetime.combine(corr.attendance_date, shift.start_time)
    end = v._shift_end_dt(shift, corr.attendance_date)
    has_in = bool(att and att.check_in)
    open_or_none = not (att and att.check_out) or (has_in and v._is_checked_in(att))
    if not req_in and (corr.kind == 'forgot_checkin' or not has_in):
        req_in = start
    if not req_out and (corr.kind == 'forgot_checkout' or open_or_none):
        req_out = end
    return req_in, req_out


# ---------------------------------------------------------------------------
# permissions
# ---------------------------------------------------------------------------
def _caller(request):
    from api import permissions
    permissions._CACHE.clear()              # per-request role cache, as require_perm does
    email, user = permissions._get_caller(request)
    if not email or not user or (user.status and user.status != 'active'):
        return None
    return _norm(email)


def is_reviewer(request):
    from api.permissions import check_perm
    return any(check_perm(request, code)[0] for code in REVIEW_PERMS)


def can_decide(request, corr):
    """(caller, error_response)."""
    from api import org_views
    caller = _caller(request)
    if not caller:
        return None, _err('Authentication required. Please sign in again.', 401)
    if caller == _norm(corr.email):
        return caller, _err('You cannot approve or reject your own regularization.', 403)
    if is_reviewer(request):
        return caller, None
    if caller == _norm(corr.reviewer_email) or org_views.is_manager_of(caller, corr.email):
        return caller, None
    return caller, _err('You are not allowed to review this regularization.', 403)


def can_view_employee(request, email):
    from api import org_views
    from api.permissions import check_perm
    caller = _caller(request)
    if not caller:
        return None, False
    if caller == _norm(email) or is_reviewer(request) or check_perm(request, 'attendance.view')[0]:
        return caller, True
    return caller, org_views.is_manager_of(caller, email)


def queue_rows(request, status='Pending'):
    """The missed-punch requests (every kind) the caller may decide (never
    their own)."""
    from api import org_views
    caller = _caller(request)
    if not caller:
        return []
    qs = AttendanceCorrection.objects.exclude(email=caller)
    if status and status.lower() != 'all':
        qs = qs.filter(status=status)
    if not is_reviewer(request):
        qs = qs.filter(Q(reviewer_email=caller) | Q(email__in=org_views.reports_of(caller)))
    return list(qs.order_by('-id')[:200])


# ---------------------------------------------------------------------------
# submit / approve / reject
# ---------------------------------------------------------------------------
def submit(email, body, now=None):
    """Create a pending regularization. Returns the correction; raises Invalid."""
    from api import org_views
    from api.views import notify_approvers
    now = now or local_now()
    pol = mp.policy()
    from api.views import parse_date
    day = parse_date(body.get('date') or body.get('attendanceDate'))
    if not day:
        raise Invalid('date is required (YYYY-MM-DD).')
    if day > now.date():
        raise Invalid('You cannot regularize a future day.')
    if day < now.date() - timedelta(days=int(pol['max_days_back'])):
        raise Invalid(f'Days older than {pol["max_days_back"]} days cannot be regularized. Ask HR.')
    code, reason = clean_reason(body.get('reasonCode') or body.get('reason_code'),
                                body.get('reason') or body.get('note'))
    proof = body.get('proofImage') or ''
    if proof and (len(proof) > MAX_PROOF or not str(proof).startswith('data:image/')):
        raise Invalid('The proof must be an image under 8 MB.')

    att = EmployeeAttendance.objects.filter(email=email, date=day).first()
    probe = att or EmployeeAttendance(email=email, date=day)
    shift = mp.shift_of(probe)
    flagged = bool(att and att.punch_issue)
    # A day can be regularized once it is over — or, for a day with a punch,
    # once its shift has ended (forgot to check out at 6 pm, noticed at 9 pm:
    # what the old forgot-punch ticket allowed).
    from api import views as v
    over = now >= mp.day_end(probe, shift, pol)
    if not over and att and (att.check_in or att.check_out):
        over = now >= v._shift_end_dt(shift, day)
    if not flagged and not over:
        raise Invalid('This day is still in progress — check in / out normally, or regularize it once it is over.')
    deadline = mp.deadline_for(probe, now, pol)
    if deadline and now > deadline and pol.get('block_after_deadline'):
        raise Invalid(f'The deadline to regularize this day passed on {company_date(deadline)} '
                      f'{_ampm(deadline)}. Ask HR to correct it.', 403)
    if AttendanceCorrection.objects.filter(email=email, attendance_date=day, status='Pending').exists():
        raise Invalid('You already have a pending request for this day — wait for it to be reviewed.')
    used, limit = month_usage(email, day, pol)
    if limit and used >= limit:
        raise Invalid(f'You have used all {limit} missed-punch requests for {day.strftime("%B %Y")}. '
                      f'Ask HR to correct this day.', 403)
    req_in, req_out, _fi, _fo = resolve_times(att, email, day, body.get('checkIn') or body.get('requestedCheckIn'),
                                              body.get('checkOut') or body.get('requestedCheckOut'), now, shift, pol)

    user = AppUser.objects.filter(email__iexact=email).first()
    name = (att.employee_name if att and att.employee_name else '') or (user.full_name if user else '') or email
    routed_to = org_views.approver_for(email)
    c = AttendanceCorrection.objects.create(
        email=email, employee_name=name, attendance_date=day, kind=KIND,
        requested_check_in=req_in, requested_check_out=req_out,
        reason_code=code, reason=reason, proof_image=proof or None,
        status='Pending', reviewer_email=routed_to)
    # created_at on the business clock, the one deadlines are on ("late" compares the two)
    AttendanceCorrection.objects.filter(pk=c.pk).update(created_at=now)
    c.created_at = now
    late = bool(deadline and now > deadline)
    what = (f'{name} asked to regularize {company_date(day)}'
            + (f' (check-in {_ampm(req_in)})' if req_in else '')
            + (f' (check-out {_ampm(req_out)})' if req_out else '')
            + f'. Reason: {REASON_LABELS[code]}' + (f' — {reason}' if reason else '')
            + ('. Filed after the deadline.' if late else '.'))
    link = '/employees/checkin?regularizations=1'
    if routed_to:
        org_views.notify(routed_to, 'Regularization to approve', what, link)
    else:
        notify_approvers('attendance.regularize.approve', 'Regularization to approve', what, link)
    if late:
        notify_approvers('attendance.regularize.approve', 'Late regularization filed', what, link)
    return c


def _move_or_add(email, name, day, events, old_at, new_at, event, label):
    ev = None
    if old_at is not None:
        ev = (AttendanceEvent.objects.filter(email=email, date=day, event__in=events, at=old_at)
              .order_by('-id').first())
    if ev is not None:
        ev.at = new_at
        ev.location = label
        ev.save(update_fields=['at', 'location'])
    else:
        AttendanceEvent.objects.create(email=email, employee_name=name, date=day, event=event,
                                       location=label, at=new_at)


def recalculate(att, shift):
    """Worked / overtime / early-exit / late / status of a closed day — the
    rules of a live check-in + check-out, over all of the day's sessions."""
    from api import views as v
    worked = v._recompute_worked(att)
    if worked is None:                              # trail does not pair up: whole day as one session
        worked = max(int((att.check_out - att.check_in).total_seconds() // 60) - (att.break_minutes or 0), 0)
    att.worked_minutes = worked
    att.overtime_minutes = v._overtime_for(worked, shift)
    if shift.is_flexible:
        att.early_exit_minutes = max(int((shift.flex_hours_per_day or 8) * 60) - worked, 0)
        att.late_minutes = 0
        att.status = 'present'
        return _classify(att, shift)
    end = v._shift_end_dt(shift, att.date)
    att.early_exit_minutes = max(int((end - att.check_out).total_seconds() // 60), 0) if att.check_out < end else 0
    shift_start = datetime.combine(att.date, shift.start_time)
    first = (AttendanceEvent.objects.filter(email=att.email, date=att.date, event='check-in',
                                            at__gte=shift_start - v.SHIFT_EARLY_WINDOW)
             .order_by('at').values_list('at', flat=True).first())
    first = min(first, att.check_in) if first else att.check_in
    if first > shift_start + timedelta(minutes=shift.grace_minutes or 0):
        att.late_minutes = max(int((first - shift_start).total_seconds() // 60), 0)
        att.status = 'late'
    else:
        att.late_minutes = 0
        att.status = 'present'
    return _classify(att, shift)


def _classify(att, shift):
    """Day status from the hours under the employee's attendance policy
    (day_status.py): absent / half-day / late / present. The late / present
    set above stays if the classification cannot run."""
    try:
        from . import day_status
        day_status.apply(att, shift)
    except Exception:
        logger.exception('day status classification failed for %s %s', att.email, att.date)
    return att


def approve(corr, actor, note='', now=None):
    """Apply an approved regularization to the day. Raises Invalid."""
    from api import views as v
    from api.timesheets import audit_snapshot, log_attendance_change
    now = now or local_now()
    pol = mp.policy()
    with transaction.atomic():
        corr = AttendanceCorrection.objects.select_for_update().get(pk=corr.pk)
        if corr.status != 'Pending':
            raise Invalid('This regularization has already been %s.' % (corr.status or '').lower())
        att = (EmployeeAttendance.objects.select_for_update()
               .filter(email=corr.email, date=corr.attendance_date).first())
        created = att is None
        if created:
            att = EmployeeAttendance.objects.create(email=corr.email, employee_name=corr.employee_name or '',
                                                    date=corr.attendance_date, status='absent')
        before = None if created else audit_snapshot(att)
        shift = mp.shift_of(att)
        raw_in, raw_out = legacy_times(corr, att, shift)
        req_in, req_out, fin_in, fin_out = resolve_times(att, corr.email, corr.attendance_date,
                                                         raw_in, raw_out,
                                                         max(now, corr.created_at or now), shift, pol)
        label = f'Regularized — approved by {actor}'[:120]
        was_open = bool(att.check_in and v._is_checked_in(att))
        if req_in:
            _move_or_add(att.email, att.employee_name, att.date, ('check-in',), att.check_in, req_in,
                         'check-in', label)
            att.check_in = req_in
        if req_out:
            old_out = att.check_out if (att.check_out and not was_open) else None
            _move_or_add(att.email, att.employee_name, att.date, v.CHECKOUT_EVENTS, old_out, req_out,
                         'check-out', label)
            att.check_out = req_out
        if was_open:
            att.presence = ''
            att.presence_at = now
        att.check_in, att.check_out = fin_in, fin_out
        att.shift_id = shift.id
        recalculate(att, shift)
        att.punch_issue = ''
        att.save()
        from .overtime import on_day_closed     # Workstream O: overtime / comp-off for the corrected day (never raises)
        on_day_closed(att)
        reason =f'{REASON_LABELS.get(corr.reason_code, "Regularization")}' + (f': {corr.reason}' if corr.reason else '') \
            + (f' — {note}' if note else '')
        log_attendance_change(att, before, AUDIT_SOURCES.get(corr.kind or '', 'regularization'), actor, reason)
        corr.status = 'Approved'
        corr.reviewer = actor
        corr.reviewer_note = note
        corr.reviewed_at = now
        fields = ['status', 'reviewer', 'reviewer_note', 'reviewed_at']
        if req_in and not corr.requested_check_in:       # a legacy row: keep the times it was given
            corr.requested_check_in = req_in
            fields.append('requested_check_in')
        if req_out and not corr.requested_check_out:
            corr.requested_check_out = req_out
            fields.append('requested_check_out')
        corr.save(update_fields=fields)
    from . import penalties                     # a late the regularization removed drops its penalty
    penalties.evaluate_for_day(corr.email, corr.attendance_date)
    from api.views import create_notification
    create_notification(corr.email, 'Regularization approved',
                        f'Your regularization for {company_date(corr.attendance_date)} was approved by {actor}. '
                        f'Worked time is now {v._fmt_dur(att.worked_minutes or 0)}.'
                        + (f' Note: {note}' if note else ''),
                        'success', '/employees/attendance')
    return corr, att


def reject(corr, actor, note=''):
    now = local_now()
    n = (AttendanceCorrection.objects.filter(pk=corr.pk, status='Pending')
         .update(status='Rejected', reviewer=actor, reviewer_note=note, reviewed_at=now))
    if not n:
        corr.refresh_from_db()
        raise Invalid('This regularization has already been %s.' % (corr.status or '').lower())
    corr.refresh_from_db()
    from api.views import create_notification
    create_notification(corr.email, 'Regularization rejected',
                        f'Your regularization for {company_date(corr.attendance_date)} was rejected by {actor}.'
                        + (f' Note: {note}' if note else '') + ' You can submit a corrected one.',
                        'warning', mp.LINK.format(date=corr.attendance_date.isoformat()))
    return corr


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
def regularization(request):
    """GET  ?email=  → the employee's flagged days (with deadlines), recent
                       regularizations, reason codes and the policy.
    POST {email, date, checkIn?, checkOut?, reasonCode, reason?, proofImage?}
                     → file a regularization (own attendance only)."""
    now = local_now()
    if request.method == 'GET':
        email = _norm(request.query_params.get('email')) or _caller(request) or ''
        caller, ok = can_view_employee(request, email)
        if not caller:
            return _err('Authentication required. Please sign in again.', 401)
        if not ok:
            return _err('You are not allowed to view this attendance.', 403)
        mp.detect_for_employee(email, now)
        pol = mp.policy()
        flagged = list(EmployeeAttendance.objects.filter(email=email).exclude(punch_issue='')
                       .order_by('-date')[:31])
        pending = {c.attendance_date: c for c in AttendanceCorrection.objects.filter(
            email=email, status='Pending', attendance_date__in=[a.date for a in flagged])}
        issues = []
        for a in flagged:
            d = mp.issue_dto(a, now, pol)
            p = pending.get(a.date)
            d['pendingId'] = p.id if p else None
            d['pendingKind'] = (p.kind or '') if p else ''
            issues.append(d)
        mine = AttendanceCorrection.objects.filter(email=email).order_by('-id')[:20]   # every kind: one history
        return Response({
            'email': email,
            'today': now.date().isoformat(),
            'issues': issues,
            'requests': [dto(c, pol=pol) for c in mine],
            'reasonCodes': reason_codes_json(),
            'policy': {'deadlineHours': pol['deadline_hours'], 'blockAfterDeadline': pol['block_after_deadline'],
                       'maxDaysBack': pol['max_days_back'], 'monthlyLimit': pol.get('monthly_limit') or 0},
            'quota': quota_json(email, now.date(), pol),
            'canReview': is_reviewer(request) or bool(queue_rows(request)),
        })

    body = request.data
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    email = _norm(body.get('email')) or caller
    if email != caller:
        return _err('You can only regularize your own attendance.', 403)
    try:
        c = submit(email, body, now)
    except Invalid as e:
        return _err(str(e), e.status)
    return Response(dto(c), status=201)


@api_view(['GET'])
def regularization_queue(request):
    """Pending regularizations the caller may decide (?status=all for history)."""
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    pol = mp.policy()
    rows = queue_rows(request, (request.query_params.get('status') or 'Pending').strip())
    return Response([dto(c, pol=pol) for c in rows])


def decide(request, corr):
    """Shared by /regularization/<pk>/decide and /punch-ticket/<pk>/decide."""
    caller, denied = can_decide(request, corr)
    if denied:
        return denied
    action = str(request.data.get('action') or '').strip().lower()
    note = str(request.data.get('reviewerNote') or request.data.get('note') or '').strip()[:1000]
    if action not in ('approve', 'reject'):
        return _err('action must be approve or reject')
    try:
        if action == 'reject':
            corr = reject(corr, caller, note)
            return Response({'success': True, 'message': 'Regularization rejected.', 'regularization': dto(corr)})
        corr, att = approve(corr, caller, note)
    except Invalid as e:
        return _err(str(e), e.status)
    return Response({'success': True, 'message': 'Regularization approved — attendance recalculated.',
                     'regularization': dto(corr, att),
                     'attendance': {'date': att.date.isoformat(), 'checkIn': _dt(att.check_in),
                                    'checkOut': _dt(att.check_out), 'workedMinutes': att.worked_minutes,
                                    'status': att.status, 'lateMinutes': att.late_minutes,
                                    'punchIssue': att.punch_issue}})


@api_view(['POST'])
def regularization_decide(request, pk):
    corr = AttendanceCorrection.objects.filter(pk=pk).first()          # any kind: one approval path
    if not corr:
        return _err('Regularization not found.', 404)
    return decide(request, corr)


def submit_ticket(email, body, now=None):
    """The old forgot-punch ticket POST, filed as a regularization: same
    record, same rules. kind=forgot_checkin → check-in at the shift start,
    forgot_checkout → check-out at the shift end, unless times are given;
    date defaults to today (what the old ticket always used)."""
    from api import views as v
    now = now or local_now()
    kind = str(body.get('kind') or '').strip()
    data = dict(body.items()) if hasattr(body, 'items') else dict(body)
    day = v.parse_date(data.get('date') or data.get('attendanceDate')) or now.date()
    data['date'] = day.isoformat()
    has_times = data.get('checkIn') or data.get('requestedCheckIn') or data.get('checkOut') or data.get('requestedCheckOut')
    if not has_times:
        if kind not in LEGACY_KINDS:
            raise Invalid('kind must be forgot_checkin or forgot_checkout (or send checkIn / checkOut).')
        att = EmployeeAttendance.objects.filter(email=email, date=day).first()
        shift = mp.shift_of(att or EmployeeAttendance(email=email, date=day))
        if kind == 'forgot_checkin' or not (att and att.check_in):
            data['checkIn'] = _dt(datetime.combine(day, shift.start_time))
        if kind == 'forgot_checkout' or not (att and att.check_out):
            data['checkOut'] = _dt(v._shift_end_dt(shift, day))
    return submit(email, data, now)


@api_view(['GET'])
def punch_issues(request):
    """Flagged days for HR (attendance.view) or a manager (their reports).
    ?status=open (default) | all, ?email=, ?from=, ?to=."""
    from api import org_views
    from api.permissions import check_perm
    from api.views import parse_date
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    qs = EmployeeAttendance.objects.all()
    if not (check_perm(request, 'attendance.view')[0] or is_reviewer(request)):
        reports = org_views.reports_of(caller)
        if not reports:
            return _err('Permission denied: attendance.view', 403)
        qs = qs.filter(email__in=reports)
    p = request.query_params
    if (p.get('status') or 'open').lower() == 'all':
        qs = qs.filter(punch_issue_at__isnull=False)
    else:
        qs = qs.exclude(punch_issue='')
    if p.get('email'):
        qs = qs.filter(email=_norm(p.get('email')))
    if parse_date(p.get('from')):
        qs = qs.filter(date__gte=parse_date(p.get('from')))
    if parse_date(p.get('to')):
        qs = qs.filter(date__lte=parse_date(p.get('to')))
    now, pol = local_now(), mp.policy()
    return Response([mp.issue_dto(a, now, pol) for a in qs.order_by('-date', 'email')[:500]])


@api_view(['GET', 'PUT', 'POST'])
def missed_punch_policy(request):
    """GET → the policy; PUT/POST (attendance.edit) → update it."""
    from api.permissions import check_perm
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    if request.method == 'GET':
        return Response(mp.policy())
    if not (check_perm(request, 'attendance.edit')[0] or check_perm(request, 'settings.manage')[0]):
        return _err('Permission denied: attendance.edit', 403)
    data = request.data if isinstance(request.data, dict) else {}
    return Response(mp.save_policy(data, caller))
