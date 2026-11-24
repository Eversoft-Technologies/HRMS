"""Day status from hours worked (Attendance policy engine / workstream P).

    classify(att, policy=None, shift=None, leaves=None) -> Result | None
    apply(att, shift=None, policy=None)                 -> Result | None   (sets status / late_minutes, no save)

A CLOSED day (checked in, and the last session checked out) gets one of

    absent    credited minutes <  half_day_minutes
    half-day  credited minutes <  full day, or a very late arrival
              (late by more than late_half_day_after_minutes, when that is > 0)
    late      a full day, but the arrival was later than the grace period
    present   a full day, on time

* worked minutes = EmployeeAttendance.worked_minutes (every session of the
  day, each minus its own breaks — views._recompute_worked).
* credited = worked + the minutes of the day's APPROVED short leaves
  (ShortLeaveRequest), so a two-hour permission does not turn the day into a
  half day. An approved 'late_in' short leave also suppresses "late", an
  approved 'early_out' one suppresses "early out".
* full day = policy.full_day_minutes, or — with use_shift_hours — the shift
  length minus its break (flexible shift: flex_hours_per_day).
  half_day_minutes is capped at the full day.
* grace: the profile's grace_checkin_minutes when a profile applies to the
  employee; with no profile at all (built-in defaults) the shift's own
  grace_minutes, exactly as check-in judged it before this engine existed.
* Flexible shifts are never late / early out (no fixed start or end).
* A day that is still open (a running session, or a check-in with no
  check-out yet) is never classified: classify() returns None and the stored
  status is left as check-in set it. Work-from-home days follow the same
  thresholds as office days.

Entry points: views.attendance_check_out (when the session closes),
regularization.recalculate (after an approved regularization),
short_leave (approval / cancellation re-classifies the day) and
``manage.py recalc_attendance --policy`` (re-evaluate a date range).
"""
import logging
from datetime import datetime, timedelta

from api.models import AttendanceEvent, EmployeeAttendance, ShortLeaveRequest

logger = logging.getLogger(__name__)

STATUSES = ('present', 'late', 'half-day', 'absent')


class Result:
    __slots__ = ('status', 'worked', 'credited', 'short_minutes', 'full', 'half', 'grace', 'late_by', 'late',
                 'late_covered', 'very_late', 'early_by', 'early_out', 'early_covered', 'reason')

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def as_dict(self):
        return {k: getattr(self, k) for k in self.__slots__}


def _views():
    from api import views as v
    return v


def shift_of(att):
    from .missed_punch import shift_of as _so
    return _so(att)


def is_closed(att):
    return bool(att is not None and att.check_in and att.check_out and not _views()._is_checked_in(att))


def approved_short_leaves(email, day):
    return list(ShortLeaveRequest.objects.filter(email__iexact=email, date=day, status='Approved'))


def full_day_minutes(policy, shift):
    full = int(policy.full_day_minutes or 0)
    if policy.use_shift_hours and shift is not None:
        if shift.is_flexible:
            sm = int((shift.flex_hours_per_day or 0) * 60)
        else:
            sm = shift.total_work_minutes()
        if sm > 0:
            full = sm
    return max(full, 1)


def grace_for(policy, shift):
    if getattr(policy, 'source', 'builtin') == 'builtin' and shift is not None:
        return int(shift.grace_minutes or 0)
    return int(policy.grace_checkin_minutes or 0)


def _on_day(day, t, shift):
    """A wall-clock time of the work day ``day`` as a datetime (after midnight
    for the morning part of a night shift)."""
    dt = datetime.combine(day, t)
    if shift is not None and _views()._crosses_midnight(shift) and t < shift.start_time:
        dt += timedelta(days=1)
    return dt


def arrival(att, shift):
    """The check-in that decides punctuality: the first one from
    SHIFT_EARLY_WINDOW before the shift start (same rule as check-in)."""
    v = _views()
    if shift is None or shift.is_flexible:
        return att.check_in
    start = datetime.combine(att.date, shift.start_time)
    first = (AttendanceEvent.objects.filter(email=att.email, date=att.date, event='check-in',
                                            at__gte=start - v.SHIFT_EARLY_WINDOW)
             .order_by('at').values_list('at', flat=True).first())
    if first and att.check_in and att.check_in >= start - v.SHIFT_EARLY_WINDOW:
        return min(first, att.check_in)
    return first or att.check_in


def classify(att, policy=None, shift=None, leaves=None):
    """The status this closed day earns under ``policy`` (None while open)."""
    if not is_closed(att):
        return None
    if policy is None:
        from .policy import resolve
        policy = resolve(att.email)
    shift = shift or shift_of(att)
    leaves = approved_short_leaves(att.email, att.date) if leaves is None else leaves
    v = _views()

    worked = max(int(att.worked_minutes or 0), 0)
    short = sum(int(x.minutes or 0) for x in leaves)
    credited = worked + short
    full = full_day_minutes(policy, shift)
    half = min(int(policy.half_day_minutes or 0), full)
    grace = grace_for(policy, shift)

    late_by = early_by = 0
    late = late_cov = very_late = early = early_cov = False
    if shift is not None and not shift.is_flexible:
        start = datetime.combine(att.date, shift.start_time)
        first = arrival(att, shift)
        if first is not None:
            late_by = max(int((first - start).total_seconds() // 60), 0)
        late = late_by > grace
        if late:
            for sl in leaves:
                if sl.kind != 'late_in':
                    continue
                if sl.to_time is None or (first is not None
                                          and first <= _on_day(att.date, sl.to_time, shift) + timedelta(minutes=grace)):
                    late_cov = True
                    break
        lh = int(policy.late_half_day_after_minutes or 0)
        very_late = bool(late and not late_cov and lh > 0 and late_by > lh)
        end = v._shift_end_dt(shift, att.date)
        early_by = max(int((end - att.check_out).total_seconds() // 60), 0) if att.check_out < end else 0
        eg = int(policy.grace_early_out_minutes or 0)
        early = early_by > eg
        if early:
            for sl in leaves:
                if sl.kind != 'early_out':
                    continue
                if sl.from_time is None or att.check_out >= _on_day(att.date, sl.from_time, shift) - timedelta(minutes=eg):
                    early_cov = True
                    break

    if credited < half:
        status, reason = 'absent', f'{_hm(credited)} credited is below the half-day minimum of {_hm(half)}'
    elif credited < full:
        status, reason = 'half-day', f'{_hm(credited)} credited is below a full day of {_hm(full)}'
    elif very_late:
        status, reason = 'half-day', (f'arrived {late_by} min after the shift start (more than '
                                      f'{int(policy.late_half_day_after_minutes)} min counts as a half day)')
    elif late and not late_cov:
        status, reason = 'late', f'arrived {late_by} min after the shift start (grace {grace} min)'
    else:
        status, reason = 'present', 'full day'
    return Result(status=status, worked=worked, credited=credited, short_minutes=short, full=full, half=half,
                  grace=grace, late_by=late_by, late=bool(late and not late_cov), late_covered=late_cov,
                  very_late=very_late, early_by=early_by, early_out=bool(early and not early_cov),
                  early_covered=early_cov, reason=reason)


def _hm(m):
    m = int(m or 0)
    return f'{m // 60}h {m % 60:02d}m'


def apply(att, shift=None, policy=None):
    """Classify and write status / late_minutes onto ``att`` (not saved).
    Returns the Result, or None when the day is open (nothing changed)."""
    res = classify(att, policy=policy, shift=shift)
    if res is None:
        return None
    att.status = res.status
    att.late_minutes = res.late_by if (res.late_by and res.late_by > res.grace and not res.late_covered) else 0
    return res


def reclassify_day(email, day, actor='system', source='policy', reason=''):
    """Re-classify one stored day (e.g. after a short leave decision) and
    audit the change. Returns the attendance row (or None)."""
    from api.timesheets import audit_snapshot, log_attendance_change
    att = EmployeeAttendance.objects.filter(email__iexact=email, date=day).first()
    if att is None or not is_closed(att):
        return att
    before = audit_snapshot(att)
    old = (att.status, att.late_minutes)
    if apply(att) is None:
        return att
    if (att.status, att.late_minutes) != old:
        att.save(update_fields=['status', 'late_minutes', 'updated_at'])
        log_attendance_change(att, before, source, actor, reason or 'Day status re-evaluated')
    return att


# ---------------------------------------------------------------------------
# bulk re-evaluation (manage.py recalc_attendance --policy)
# ---------------------------------------------------------------------------
def reevaluate(d_from, d_to, email=None):
    """[(att, new_status, new_late_minutes, Result)] for closed days in the
    range whose status / late minutes the policy would change."""
    from .policy import Resolver
    res = Resolver()
    qs = (EmployeeAttendance.objects
          .filter(date__gte=d_from, date__lte=d_to, check_in__isnull=False, check_out__isnull=False)
          .order_by('date', 'email'))
    if email:
        qs = qs.filter(email__iexact=email.strip())
    shifts, out = {}, []
    for att in qs:
        if not is_closed(att):
            continue
        key = att.shift_id or ('a', att.email, att.date)
        if key not in shifts:
            shifts[key] = shift_of(att)
        r = classify(att, policy=res.resolve(att.email), shift=shifts[key])
        if r is None:
            continue
        late = r.late_by if (r.late_by and r.late_by > r.grace and not r.late_covered) else 0
        if r.status != (att.status or '') or late != (att.late_minutes or 0):
            out.append((att, r.status, late, r))
    return out


def apply_changes(changes, actor='recalc_attendance'):
    """Write reevaluate() results (audited), then re-evaluate the penalties
    of every (employee, month) touched."""
    from django.db import transaction
    from api.timesheets import audit_snapshot, log_attendance_change
    months = set()
    with transaction.atomic():
        for att, status, late, r in changes:
            before = audit_snapshot(att)
            att.status, att.late_minutes = status, late
            att.save(update_fields=['status', 'late_minutes', 'updated_at'])
            log_attendance_change(att, before, 'policy_recalc', actor, f'Policy re-evaluation: {r.reason}')
            months.add((att.email.lower(), att.date.year, att.date.month))
    from . import penalties
    for email, y, m in sorted(months):
        penalties.evaluate_month_safe(email, y, m)
    return len(changes)
