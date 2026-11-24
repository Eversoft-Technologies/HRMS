"""Missed-punch detection.

A work day is *incomplete* when, after it is over,

  * missing_checkout — a session is still open (checked in, never out);
  * missing_checkin  — a check-out is recorded with no check-in at all
                       (a hardware / device punch or an imported trail);
  * early_exit       — the day was closed but well short of the shift
                       (``early_exit_minutes`` >= the policy threshold).
                       Only flagged: the status is not changed.

"Over" means past midnight (company time) for a day shift, and past the shift
end + ``NIGHT_SHIFT_TAIL`` for a shift that crosses midnight — so a running
night shift is never flagged. An automatically checked-out day (left the
geofence) is complete by definition and never flagged as an early exit.

A flagged day carries ``punch_issue``, ``punch_issue_at`` and
``regularize_by`` (now + the deadline). The deadline is the employee's
attendance policy profile ``regularize_within_days`` x 24 h when a profile
applies to them (api/attendance_ext/policy.py; 0 = use this policy), else
this policy's ``deadline_hours`` — see deadline_hours_for(). The employee is told once per
day-issue (in-app + e-mail, ``punch_issue_notified_at``); when the deadline
passes with nothing filed, the manager (or, without one, HR) is reminded once.

The flag clears itself when the day becomes complete, and when a correction
for that day is approved (see regularization.py / mark_resolved).

Entry points:
  detect(now, email=None, on_date=None, dry_run=False)  — cron / command
  detect_for_employee(email, now)                       — cheap, throttled,
                                                          run from request paths
"""
import logging
from datetime import datetime, time, timedelta

from django.db.models import Q

from api.models import (AppUser, AttendanceCorrection, EmployeeAttendance, MasterDataSet, Notification,
                        Shift)
from api.timeutil import company_date, local_now

logger = logging.getLogger(__name__)

POLICY_KEY = 'attendance_missed_punch_policy'
DEFAULT_POLICY = {
    'enabled': True,                       # detection + notifications on/off
    'deadline_hours': 48,                  # regularize within this long of the flag
    'early_exit_enabled': True,
    'early_exit_threshold_minutes': 120,   # flag a day closed this far before the shift end
    'block_after_deadline': False,         # refuse late regularizations (else: allowed, marked late)
    'notify_email': True,                  # e-mail as well as the in-app notification
    'notify_manager_on_expiry': True,      # one reminder to the manager when the deadline passes
    'lookback_days': 7,                    # how far back the detector looks
    'max_days_back': 31,                   # oldest day a regularization may be filed for
    'checkout_grace_minutes': 0,           # extra slack after the end of the work day
    # Missed-punch requests (regularizations + the old forgot-punch tickets +
    # the old Leave-page clock-out corrections) an employee may file per
    # attendance month; rejected ones do not count. 0 = no limit.
    'monthly_limit': 3,
}

ISSUES = ('missing_checkout', 'missing_checkin', 'early_exit')
ISSUE_LABELS = {
    'missing_checkout': 'Missing check-out',
    'missing_checkin': 'Missing check-in',
    'early_exit': 'Early exit',
}
LINK = '/employees/checkin?regularize={date}'
OVERDUE_LINK = '/employees/checkin?regularize-overdue={pk}'
CHECKOUT_MISSING_LINK = '/employees/attendance?checkout-missing={pk}'   # views._checkout_reminders' tag

# detect_for_employee throttle: email -> the `now` it last ran at.
_LAST_RUN = {}
THROTTLE = timedelta(seconds=60)


# ---------------------------------------------------------------------------
# policy
# ---------------------------------------------------------------------------
def policy():
    pol = dict(DEFAULT_POLICY)
    try:
        obj = MasterDataSet.objects.filter(key=POLICY_KEY).first()
        opts = obj.options if obj else None
        if isinstance(opts, dict):
            for k, default in DEFAULT_POLICY.items():
                if k in opts:
                    pol[k] = _coerce(opts[k], default)
    except Exception:
        logger.exception('missed-punch policy unreadable; using defaults')
    return pol


def _coerce(value, default):
    if isinstance(default, bool):
        if isinstance(value, str):
            return value.strip().lower() in ('1', 'true', 'yes', 'on')
        return bool(value)
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return default


def save_policy(values, actor=''):
    pol = policy()
    for k, default in DEFAULT_POLICY.items():
        if k in values:
            pol[k] = _coerce(values[k], default)
    if pol['deadline_hours'] < 1:
        pol['deadline_hours'] = 1
    MasterDataSet.objects.update_or_create(
        key=POLICY_KEY, defaults={'label': 'Missed punch policy', 'options': pol})
    return pol


# ---------------------------------------------------------------------------
# rules
# ---------------------------------------------------------------------------
def shift_of(att):
    from api import views as v
    return (Shift.objects.filter(pk=att.shift_id).first() if att.shift_id else None) \
        or v._get_active_shift(att.email, att.date)


def day_end(att, shift=None, pol=None):
    """When the work day ``att.date`` is over: midnight for a day shift, the
    shift end + NIGHT_SHIFT_TAIL for one crossing midnight."""
    from api import views as v
    shift = shift or shift_of(att)
    pol = pol or policy()
    if v._crosses_midnight(shift):
        end = v._shift_end_dt(shift, att.date) + v.NIGHT_SHIFT_TAIL
    else:
        end = datetime.combine(att.date + timedelta(days=1), time(0, 0))
    return end + timedelta(minutes=pol.get('checkout_grace_minutes') or 0)


def day_start(att):
    return datetime.combine(att.date, time(0, 0))


def _is_auto_closed(att):
    return bool(att.is_auto_checked_out or att.auto_checkout_at)


def _has_checkout_event_without_checkin(att):
    from api import views as v
    from api.models import AttendanceEvent
    evs = set(AttendanceEvent.objects.filter(email=att.email, date=att.date,
                                             event__in=('check-in',) + v.CHECKOUT_EVENTS)
              .values_list('event', flat=True))
    return bool(evs) and 'check-in' not in evs


def evaluate(att, now, shift=None, pol=None):
    """The issue this day has right now ('' when none)."""
    from api import views as v
    pol = pol or policy()
    shift = shift or shift_of(att)
    if now < day_end(att, shift, pol):
        return ''                                  # the day (or night shift) is still running
    if att.check_in and v._is_checked_in(att):
        return 'missing_checkout'
    if not att.check_in:
        if att.check_out or _has_checkout_event_without_checkin(att):
            return 'missing_checkin'
        return ''                                  # no punches: an absence, not a missed punch
    # closed day
    if (pol.get('early_exit_enabled') and not _is_auto_closed(att)
            and (att.status or '') != 'half-day'
            and (att.early_exit_minutes or 0) >= max(int(pol.get('early_exit_threshold_minutes') or 0), 1)):
        return 'early_exit'
    return ''


def _resolved_by_correction(att):
    return AttendanceCorrection.objects.filter(email=att.email, attendance_date=att.date,
                                               status='Approved').exists()


def deadline_hours_for(email, pol=None, resolver=None):
    """Hours an employee has to regularize a flagged day: their attendance
    policy profile's regularize_within_days (when a profile — not the
    built-in defaults — applies and the value is > 0), else deadline_hours."""
    pol = pol or policy()
    try:
        from .policy import Resolver
        p = (resolver or Resolver()).resolve(email)
        days = int(p.regularize_within_days or 0)
        if p.source != 'builtin' and days > 0:
            return days * 24
    except Exception:
        logger.exception('attendance policy unavailable for %s; using deadline_hours', email)
    return int(pol['deadline_hours'])


def deadline_for(att, now=None, pol=None):
    """The regularization deadline of a day: its flag's, else the end of the
    work day + the deadline hours (for a day that was never flagged)."""
    pol = pol or policy()
    if att.regularize_by:
        return att.regularize_by
    return day_end(att, pol=pol) + timedelta(hours=deadline_hours_for(att.email, pol))


# ---------------------------------------------------------------------------
# flag / clear
# ---------------------------------------------------------------------------
def _flag(att, issue, now, pol, resolver=None):
    deadline = now + timedelta(hours=deadline_hours_for(att.email, pol, resolver))
    n = (EmployeeAttendance.objects.filter(pk=att.pk, punch_issue=att.punch_issue)
         .update(punch_issue=issue, punch_issue_at=now, regularize_by=deadline, punch_issue_notified_at=None))
    if n:
        att.punch_issue, att.punch_issue_at, att.regularize_by, att.punch_issue_notified_at = issue, now, deadline, None
    return bool(n)


def _clear(att):
    """Clear the flag. regularize_by / punch_issue_at stay as history (a
    regularization filed after them is reported as late)."""
    n = EmployeeAttendance.objects.filter(pk=att.pk).exclude(punch_issue='').update(punch_issue='')
    att.punch_issue = ''
    return bool(n)


def mark_resolved(att):
    """Called after a correction / regularization for the day was approved."""
    try:
        if att is not None and att.pk:
            _clear(att)
    except Exception:
        logger.exception('could not clear the punch issue of attendance %s', getattr(att, 'pk', None))


def refresh_row(att, now=None):
    """Re-evaluate one day (e.g. right after a check-out) without notifying."""
    try:
        now = now or local_now()
        pol = policy()
        issue = evaluate(att, now, pol=pol)
        if issue and _resolved_by_correction(att):
            issue = ''
        if not issue and att.punch_issue:
            _clear(att)
    except Exception:
        logger.exception('punch-issue refresh failed for attendance %s', getattr(att, 'pk', None))


# ---------------------------------------------------------------------------
# notifications
# ---------------------------------------------------------------------------
def _fmt_deadline(d):
    return f'{company_date(d)} {d.strftime("%I:%M %p").lstrip("0")}'


def issue_sentence(att):
    day = company_date(att.date)
    if att.punch_issue == 'missing_checkout':
        return f'You forgot to check out on {day}.'
    if att.punch_issue == 'missing_checkin':
        return f'No check-in was recorded on {day}.'
    if att.punch_issue == 'early_exit':
        h, m = divmod(int(att.early_exit_minutes or 0), 60)
        return f'You checked out {h}h {m}m before the end of your shift on {day}.'
    return ''


def _notify_employee(att, now, pol):
    from api import mailer
    from api.views import create_notification
    hours = deadline_hours_for(att.email, pol)
    sentence = issue_sentence(att)
    message = (f'{sentence} Regularize with your manager within {hours} hours '
               f'(by {_fmt_deadline(att.regularize_by)}).')
    # views._checkout_reminders may already have posted its "Check-out missing"
    # note for this row in the same poll: reword that one instead of a second.
    existing = None
    if att.punch_issue == 'missing_checkout':
        existing = Notification.objects.filter(recipient=att.email,
                                               link=CHECKOUT_MISSING_LINK.format(pk=att.pk)).first()
    if existing is not None:
        Notification.objects.filter(pk=existing.pk).update(message=message, is_read=False)
    else:
        create_notification(att.email, ISSUE_LABELS.get(att.punch_issue, 'Attendance needs attention'),
                            message, 'warning', LINK.format(date=att.date.isoformat()))
    if not pol.get('notify_email'):
        return
    try:
        user = AppUser.objects.filter(email__iexact=att.email).first()
        html = mailer.render_branded(
            greeting=(user.full_name if user else '') or att.employee_name or att.email,
            title=ISSUE_LABELS.get(att.punch_issue, 'Attendance needs attention'),
            intro=(f'{sentence} Regularize with your manager within <strong>{hours} hours</strong> '
                   f'so the day is counted correctly.<br><br>Open <strong>Check In / Out</strong> in HRMS '
                   f'and use <strong>Regularize</strong> on the highlighted day.'),
            highlight_html=mailer.render_details_card('Attendance', [
                ('Date', company_date(att.date)),
                ('Check-in', att.check_in.strftime('%I:%M %p').lstrip('0') if att.check_in else '—'),
                ('Check-out', att.check_out.strftime('%I:%M %p').lstrip('0') if att.check_out else '—'),
                ('Regularize by', _fmt_deadline(att.regularize_by)),
            ]),
        )
        mailer.send_email(to=att.email, subject=f'{ISSUE_LABELS.get(att.punch_issue, "Attendance")}: '
                                                f'{company_date(att.date)}',
                          html=html, text=message)
    except Exception:
        logger.exception('missed-punch mail failed for %s', att.email)


def _filed_since_flag(att):
    qs = AttendanceCorrection.objects.filter(email=att.email, attendance_date=att.date)
    if att.punch_issue_at:
        qs = qs.filter(created_at__gte=att.punch_issue_at - timedelta(minutes=1))
    return qs.exclude(status='Rejected').exists()


def _notify_overdue(att, now, pol):
    """One reminder to the manager (else HR) once the deadline passed unfiled."""
    from api import mailer, org_views
    from api.views import create_notification, notify_approvers
    tag = OVERDUE_LINK.format(pk=att.pk)
    if Notification.objects.filter(link=tag).exists():
        return False
    who = att.employee_name or att.email
    msg = (f'{who} did not regularize {ISSUE_LABELS.get(att.punch_issue, "a missed punch").lower()} '
           f'on {company_date(att.date)}; the deadline ({_fmt_deadline(att.regularize_by)}) has passed.')
    manager = org_views.approver_for(att.email)
    if manager:
        create_notification(manager, 'Regularization overdue', msg, 'warning', tag)
        if pol.get('notify_email'):
            try:
                html = mailer.render_branded(title='Regularization overdue', intro=msg)
                mailer.send_email(to=manager, subject=f'Regularization overdue: {who}', html=html, text=msg)
            except Exception:
                logger.exception('overdue mail failed for %s', manager)
    else:
        notify_approvers('attendance.regularize.approve', 'Regularization overdue', msg, tag)
        if not Notification.objects.filter(link=tag).exists():
            # nobody to tell: still stamp it so the sweep does not retry forever
            Notification.objects.create(recipient=att.email, title='Regularization deadline passed',
                                        message=msg, notification_type='warning', link=tag)
    return True


# ---------------------------------------------------------------------------
# sweep
# ---------------------------------------------------------------------------
def _candidates(now, email=None, on_date=None, pol=None):
    pol = pol or policy()
    qs = EmployeeAttendance.objects.all()
    if on_date:
        qs = qs.filter(date=on_date)
    else:
        qs = qs.filter(date__gte=now.date() - timedelta(days=max(int(pol['lookback_days']), 1)),
                       date__lte=now.date())
    if email:
        qs = qs.filter(email=email)
    return qs.filter(Q(check_in__isnull=False) | Q(check_out__isnull=False) | ~Q(punch_issue=''))


def detect(now=None, email=None, on_date=None, dry_run=False):
    """Flag / clear / notify. Returns a list of (att, action) where action is
    one of flagged:<issue> | cleared | notified | overdue."""
    now = now or local_now()
    pol = policy()
    out = []
    if not pol.get('enabled'):
        return out
    shifts = {}
    from .policy import Resolver
    resolver = Resolver()
    for att in _candidates(now, email, on_date, pol).order_by('date', 'id'):
        try:
            key = att.shift_id or ('a', att.email, att.date)
            if key not in shifts:
                shifts[key] = shift_of(att)
            issue = evaluate(att, now, shifts[key], pol)
            if issue and _resolved_by_correction(att):
                issue = ''
            if issue != (att.punch_issue or ''):
                if dry_run:
                    out.append((att, f'flagged:{issue}' if issue else 'cleared'))
                    continue
                if issue:
                    if _flag(att, issue, now, pol, resolver):
                        out.append((att, f'flagged:{issue}'))
                elif _clear(att):
                    out.append((att, 'cleared'))
            if not att.punch_issue or dry_run:
                continue
            if att.punch_issue_notified_at is None:
                # Claim the notification first so two concurrent sweeps never both send it.
                if EmployeeAttendance.objects.filter(pk=att.pk, punch_issue_notified_at__isnull=True) \
                        .update(punch_issue_notified_at=now):
                    att.punch_issue_notified_at = now
                    _notify_employee(att, now, pol)
                    out.append((att, 'notified'))
            if (pol.get('notify_manager_on_expiry') and att.regularize_by and now >= att.regularize_by
                    and not _filed_since_flag(att)):
                if _notify_overdue(att, now, pol):
                    out.append((att, 'overdue'))
        except Exception:
            logger.exception('missed-punch check failed for attendance %s', att.pk)
    return out


def detect_for_employee(email, now=None):
    """The request-path variant: one employee, at most once a minute."""
    now = now or local_now()
    email = str(email or '').strip().lower()
    if not email:
        return []
    last = _LAST_RUN.get(email)
    if last is not None and timedelta(0) <= now - last < THROTTLE:
        return []
    _LAST_RUN[email] = now
    try:
        return detect(now=now, email=email)
    except Exception:
        logger.exception('missed-punch detection failed for %s', email)
        return []


def issue_dto(att, now=None, pol=None):
    now = now or local_now()
    pol = pol or policy()
    deadline = deadline_for(att, now, pol)
    secs = int((deadline - now).total_seconds()) if deadline else None
    return {
        'id': att.id,
        'email': att.email,
        'employee': att.employee_name or att.email,
        'date': att.date.isoformat(),
        'dateLabel': company_date(att.date),
        'issue': att.punch_issue or '',
        'issueLabel': ISSUE_LABELS.get(att.punch_issue or '', ''),
        'message': issue_sentence(att),
        'flaggedAt': att.punch_issue_at.strftime('%Y-%m-%d %H:%M:%S') if att.punch_issue_at else None,
        'regularizeBy': deadline.strftime('%Y-%m-%d %H:%M:%S') if deadline else None,
        'regularizeByLabel': _fmt_deadline(deadline) if deadline else '',
        'secondsLeft': secs,
        'overdue': bool(secs is not None and secs < 0),
        'checkIn': att.check_in.strftime('%Y-%m-%d %H:%M:%S') if att.check_in else None,
        'checkOut': att.check_out.strftime('%Y-%m-%d %H:%M:%S') if att.check_out else None,
        'status': att.status or '',
        'workedMinutes': att.worked_minutes or 0,
        'earlyExitMinutes': att.early_exit_minutes or 0,
    }
