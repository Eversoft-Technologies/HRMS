"""Late-arrival / early-out penalties (Attendance policy engine / workstream P).

Counting
--------
Per employee and calendar month, an *occurrence* is

  * a closed day whose status is 'late' (day_status: a full day, arrival
    after the grace period, not covered by an approved short leave), and,
    when the profile's ``count_early_outs`` is on,
  * a closed full day (present / late) that ended more than
    ``grace_early_out_minutes`` before the shift end, not covered by an
    approved 'early_out' short leave.

Half days and absences are not counted again: their pay is already cut by the
day status. Occurrences are numbered in date order (late before early out on
the same day); the first ``free_lates_per_month`` are free, every later one
gets one AttendancePenalty row (unique per email / date / kind).

Action (the employee's profile, at the time the penalty is created)
-------------------------------------------------------------------
  half_day_leave  0.5 day is taken from the first leave type in
                  ``penalty_leave_types`` that still has 0.5 day available
                  (ledger balance minus pending requests) through a
                  LeaveLedgerEntry kind='penalty', period=<date ISO>
                  (idempotent via the ledger's unique key) -> status 'applied';
                  no balance anywhere -> status 'lop' (0.5 day Loss of Pay).
  lop_half_day    status 'lop'.
  warning         status 'warned' (notification only).

The employee is told about every new penalty (in-app + e-mail) with the
reason and how to dispute it.

Re-evaluation
-------------
evaluate_month(email, y, m) recomputes the wanted set and reconciles it with
the stored rows. It is cheap and idempotent, and runs after every check-out,
regularization approval and short-leave decision for that month, from
``manage.py attendance_penalties --month YYYY-MM`` and after
``recalc_attendance --policy --apply``. A penalty whose occurrence no longer
exists (a regularization or short leave removed the late) is removed and its
ledger entry deleted — except a LOP penalty already deducted by a pay run,
which stays (payroll history is not rewritten).

Waive
-----
waive(p, actor, note): the employee's manager or a holder of attendance.edit
(never the employee). The ledger entry is deleted (the balance comes back),
status 'waived'. A waived row keeps its occurrence, so re-evaluation never
re-creates it.

Payroll
-------
apply_attendance_penalties(result, ctx) is a payroll calculation hook (add
it to api/payroll_ext/__init__.py STEPS): status 'lop' penalties dated in the
pay period that are unpaid (or paid by this same run) become one deduction
line ATT_PENALTY 'Attendance penalty (LOP)' = sum(days) x daily rate, where
daily rate = monthly gross / calendar days in the period. Monthly gross is
the sum of the result's earnings lines EXCEPT non-taxable reimbursements
(payroll_ext.NON_TAXABLE_CODES), leave encashment (LEAVE_ENC) and one-off
run adjustments (ADJ_*). With ctx['run_id'] the rows are stamped
paid_run_id, so another run never deducts them again (a cancelled / deleted
run releases them).
"""
import calendar
import logging
from datetime import date
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Q

from api.models import AttendancePenalty, EmployeeAttendance
from api.timeutil import company_date, local_now

logger = logging.getLogger(__name__)

KINDS = ('late', 'early_out')
KIND_LABELS = {'late': 'Late arrival', 'early_out': 'Early out'}
STATUS_LABELS = {'applied': 'Leave deducted', 'lop': 'Loss of Pay', 'warned': 'Warning', 'waived': 'Waived'}
HALF = Decimal('0.5')
LEDGER_KIND = 'penalty'
CODE = 'ATT_PENALTY'
LABEL = 'Attendance penalty (LOP)'
LINK = '/employees/attendance'


def _norm(v):
    return str(v or '').strip().lower()


def _ordinal(n):
    suf = 'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
    return f'{n}{suf}'


def period_of(d):
    return f'{d.year:04d}-{d.month:02d}'


def parse_period(s):
    """'YYYY-MM' -> (y, m); raises ValueError."""
    y, m = str(s or '').strip()[:7].split('-')
    y, m = int(y), int(m)
    if not (1 <= m <= 12 and 2000 <= y <= 2100):
        raise ValueError(s)
    return y, m


# ---------------------------------------------------------------------------
# occurrences
# ---------------------------------------------------------------------------
def occurrences(email, y, m, policy):
    """[(date, kind)] in counting order."""
    from . import day_status as ds
    email = _norm(email)
    first, last = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    out = []
    for att in (EmployeeAttendance.objects.filter(email__iexact=email, date__gte=first, date__lte=last)
                .order_by('date', 'id')):
        if not ds.is_closed(att):
            continue
        st = (att.status or '').lower()
        if st == 'late':
            out.append((att.date, 'late'))
        if policy.count_early_outs and st in ('present', 'late'):
            try:
                r = ds.classify(att, policy=policy)
            except Exception:
                logger.exception('early-out check failed for attendance %s', att.pk)
                r = None
            if r is not None and r.early_out and r.status in ('present', 'late'):
                out.append((att.date, 'early_out'))
    return out


def wanted(email, y, m, policy):
    """{(date, kind): occurrence_number} beyond the free allowance."""
    free = int(policy.free_lates_per_month or 0)
    return {(d, k): n for n, (d, k) in enumerate(occurrences(email, y, m, policy), 1) if n > free}


# ---------------------------------------------------------------------------
# ledger
# ---------------------------------------------------------------------------
def _available(email, leave_type, year):
    """Days of ``leave_type`` that can still be taken (None = not a limited
    type in the leave policy)."""
    from . import leave_accrual as la
    b = la.balance(email, leave_type, year)
    if not b or b.get('unlimited') or b.get('balance') is None:
        return None
    return la.D(b['balance']) - la.D(b.get('pending') or 0)


def _deduct(email, d, leave_types, note):
    """(leave_type, ledger_entry) of the first type with 0.5 day free, else (None, None)."""
    from api.models import LeaveLedgerEntry
    from . import leave_accrual as la
    for lt in leave_types or []:
        lt = str(lt or '').strip()
        if not lt:
            continue
        existing = LeaveLedgerEntry.objects.filter(email=email, leave_type=lt, year=d.year, kind=LEDGER_KIND,
                                                   period=d.isoformat()).first()
        if existing is not None:
            return lt, existing
        try:
            avail = _available(email, lt, d.year)
        except Exception:
            logger.exception('leave balance unavailable for %s / %s', email, lt)
            avail = None
        if avail is None or avail < HALF:
            continue
        row = la._create(email=email, leave_type=lt, year=d.year, kind=LEDGER_KIND, period=d.isoformat(),
                         days=-HALF, effective_date=d, note=note[:255], created_by='system')
        if row is None:
            row = LeaveLedgerEntry.objects.filter(email=email, leave_type=lt, year=d.year, kind=LEDGER_KIND,
                                                  period=d.isoformat()).first()
        if row is not None:
            return lt, row
    return None, None


def _reverse_ledger(p):
    from api.models import LeaveLedgerEntry
    if p.ledger_entry_id:
        n, _ = LeaveLedgerEntry.objects.filter(pk=p.ledger_entry_id, kind=LEDGER_KIND).delete()
        if n:
            logger.info('attendance penalty %s: ledger entry %s reversed (%s %s)', p.pk, p.ledger_entry_id,
                        p.email, p.leave_type)
    p.ledger_entry_id = None


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------
def _create_penalty(email, d, kind, n, policy, notify=True):
    free = int(policy.free_lates_per_month or 0)
    action = policy.penalty_action
    note = (f'{KIND_LABELS[kind]} on {d.isoformat()}: {_ordinal(n)} in {d:%B %Y} '
            f'({free} free)')
    with transaction.atomic():
        try:
            with transaction.atomic():
                p = AttendancePenalty.objects.create(
                    email=email, date=d, period=period_of(d), kind=kind, occurrence=n, action=action,
                    days=Decimal('0'), status='warned', profile_id=policy.profile_id, note=note[:255])
        except IntegrityError:
            return None
        if action == 'warning':
            p.status = 'warned'
        elif action == 'lop_half_day':
            p.status, p.days = 'lop', HALF
        else:
            lt, row = _deduct(email, d, policy.penalty_leave_types, f'Attendance penalty: {note}')
            if row is not None:
                p.status, p.days, p.leave_type, p.ledger_entry_id = 'applied', HALF, lt, row.id
            else:
                p.status, p.days = 'lop', HALF
        p.save(update_fields=['status', 'days', 'leave_type', 'ledger_entry_id'])
    if notify:
        notify_employee(p, policy)
    return p


def evaluate_month(email, y, m, policy=None, dry_run=False, notify=True):
    """Reconcile the month's penalties. Returns {'created': [..], 'removed': [..],
    'kept': [..]} (penalty rows; in dry-run the created ones are unsaved)."""
    from .policy import resolve
    email = _norm(email)
    policy = policy or resolve(email)
    want = wanted(email, y, m, policy)
    period = f'{y:04d}-{m:02d}'
    existing = {(p.date, p.kind): p for p in AttendancePenalty.objects.filter(email__iexact=email, period=period)}
    out = {'created': [], 'removed': [], 'kept': []}
    for key, p in existing.items():
        if key in want:
            out['kept'].append(p)
            if p.occurrence != want[key] and not dry_run:
                AttendancePenalty.objects.filter(pk=p.pk).update(occurrence=want[key])
                p.occurrence = want[key]
            continue
        if p.status == 'lop' and p.paid_run_id:
            out['kept'].append(p)             # already deducted by a pay run: history stays
            continue
        out['removed'].append(p)
        if dry_run:
            continue
        with transaction.atomic():
            _reverse_ledger(p)
            AttendancePenalty.objects.filter(pk=p.pk).delete()
        logger.info('attendance penalty removed: %s %s %s (occurrence gone)', email, p.date, p.kind)
        if p.status != 'waived':
            _notify_removed(p)
    for key in sorted(want):
        if key in existing:
            continue
        d, kind = key
        if dry_run:
            out['created'].append(AttendancePenalty(email=email, date=d, period=period, kind=kind,
                                                    occurrence=want[key], action=policy.penalty_action))
            continue
        p = _create_penalty(email, d, kind, want[key], policy, notify=notify)
        if p is not None:
            out['created'].append(p)
    return out


def evaluate_month_safe(email, y, m):
    """evaluate_month for request paths: never raises."""
    try:
        return evaluate_month(email, y, m)
    except Exception:
        logger.exception('attendance penalty evaluation failed for %s %04d-%02d', email, y, m)
        return None


def evaluate_for_day(email, day):
    if email and day:
        return evaluate_month_safe(email, day.year, day.month)
    return None


def month_emails(y, m):
    first, last = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    a = set(_norm(e) for e in EmployeeAttendance.objects.filter(date__gte=first, date__lte=last)
            .values_list('email', flat=True))
    b = set(_norm(e) for e in AttendancePenalty.objects.filter(period=f'{y:04d}-{m:02d}')
            .values_list('email', flat=True))
    return sorted(e for e in (a | b) if e)


# ---------------------------------------------------------------------------
# waive
# ---------------------------------------------------------------------------
class Refused(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def waive(p, actor, note):
    note = str(note or '').strip()
    if not note:
        raise Refused('Give a reason for waiving this penalty.')
    with transaction.atomic():
        p = AttendancePenalty.objects.select_for_update().get(pk=p.pk)
        if p.status == 'waived':
            raise Refused('This penalty has already been waived.', 409)
        if p.status == 'lop' and p.paid_run_id:
            raise Refused(f'This Loss of Pay was already deducted by pay run #{p.paid_run_id}; '
                          f'correct it with a payroll adjustment instead.', 409)
        _reverse_ledger(p)
        p.status = 'waived'
        p.waived_by = str(actor or '')[:255]
        p.waived_at = local_now()
        p.note = (f'Waived: {note}')[:255]
        p.save(update_fields=['status', 'ledger_entry_id', 'waived_by', 'waived_at', 'note'])
    logger.info('attendance penalty %s waived by %s: %s', p.pk, actor, note)
    try:
        from api.views import create_notification
        create_notification(p.email, 'Attendance penalty waived',
                            f'The {KIND_LABELS.get(p.kind, "attendance").lower()} penalty for '
                            f'{company_date(p.date)} was waived by {actor}. Note: {note}',
                            'success', LINK)
    except Exception:
        logger.exception('waive notification failed for penalty %s', p.pk)
    return p


# ---------------------------------------------------------------------------
# notifications
# ---------------------------------------------------------------------------
def outcome_sentence(p):
    if p.status == 'applied':
        return f'0.5 day was deducted from your {p.leave_type} balance.'
    if p.status == 'lop':
        return '0.5 day will be deducted as Loss of Pay in payroll.'
    if p.status == 'waived':
        return 'It was waived.'
    return 'This is a warning only; nothing was deducted.'


DISPUTE = ('If this is wrong, file a Missed punch / Regularize request or a short leave for that day on the '
           'Check In / Out page (the penalty is removed automatically once it is approved), or ask your '
           'manager to waive it.')


def notify_employee(p, policy=None):
    from api import mailer
    from api.models import AppUser
    from api.views import create_notification
    free = int(getattr(policy, 'free_lates_per_month', 0) or 0) if policy is not None else None
    what = KIND_LABELS.get(p.kind, 'Attendance').lower()
    allowance = f' ({free} per month are allowed)' if free is not None else ''
    sentence = (f'Your {what} on {company_date(p.date)} was your {_ordinal(p.occurrence)} '
                f'{"late arrival / early out" if getattr(policy, "count_early_outs", False) else what} '
                f'in {p.date:%B %Y}{allowance}. {outcome_sentence(p)}')
    try:
        create_notification(p.email, 'Attendance penalty', f'{sentence} {DISPUTE}', 'warning', LINK)
    except Exception:
        logger.exception('penalty notification failed for %s', p.email)
    try:
        user = AppUser.objects.filter(email__iexact=p.email).first()
        html = mailer.render_branded(
            greeting=(user.full_name if user else '') or p.email,
            title='Attendance penalty',
            intro=f'{sentence}<br><br>{DISPUTE}',
            highlight_html=mailer.render_details_card('Penalty', [
                ('Date', company_date(p.date)),
                ('Reason', f'{KIND_LABELS.get(p.kind, p.kind)} — {_ordinal(p.occurrence)} this month'),
                ('Outcome', STATUS_LABELS.get(p.status, p.status)),
                ('Leave type', p.leave_type or ''),
            ]),
        )
        res = mailer.send_email(to=p.email, subject=f'Attendance penalty: {company_date(p.date)}',
                                html=html, text=f'{sentence} {DISPUTE}')
        if not (isinstance(res, dict) and res.get('ok')):
            logger.warning('penalty mail to %s not sent: %s', p.email,
                           (res or {}).get('error') if isinstance(res, dict) else res)
    except Exception:
        logger.exception('penalty mail failed for %s', p.email)


def _notify_removed(p):
    try:
        from api.views import create_notification
        create_notification(p.email, 'Attendance penalty removed',
                            f'The {KIND_LABELS.get(p.kind, "attendance").lower()} penalty for '
                            f'{company_date(p.date)} was removed: the day no longer counts against you.'
                            + (' The leave was credited back.' if p.status == 'applied' else ''),
                            'success', LINK)
    except Exception:
        logger.exception('penalty removal notification failed for %s', p.email)


# ---------------------------------------------------------------------------
# DTO
# ---------------------------------------------------------------------------
def dto(p, names=None):
    return {
        'id': p.id, 'email': p.email, 'employee': (names or {}).get(_norm(p.email)) or p.email,
        'date': p.date.isoformat(), 'period': p.period, 'kind': p.kind,
        'kindLabel': KIND_LABELS.get(p.kind, p.kind), 'occurrence': p.occurrence, 'action': p.action,
        'days': float(p.days or 0), 'leaveType': p.leave_type or '', 'status': p.status,
        'statusLabel': STATUS_LABELS.get(p.status, p.status), 'paidRunId': p.paid_run_id,
        'waivedBy': p.waived_by or '', 'waivedAt': p.waived_at.strftime('%Y-%m-%d %H:%M:%S') if p.waived_at else None,
        'note': p.note or '', 'profileId': p.profile_id,
        'createdAt': p.created_at.strftime('%Y-%m-%d %H:%M:%S') if p.created_at else None,
    }


def short_label(p):
    """One line for the attendance history 'detail'."""
    k = KIND_LABELS.get(p.kind, 'Attendance')
    if p.status == 'applied':
        return f'{k} penalty: 0.5 day {p.leave_type}'
    if p.status == 'lop':
        return f'{k} penalty: 0.5 day LOP'
    if p.status == 'waived':
        return f'{k} penalty waived'
    return f'{k} warning'


# ---------------------------------------------------------------------------
# payroll hook
# ---------------------------------------------------------------------------
EXCLUDED_EARNINGS = {'LEAVE_ENC'}


def _monthly_gross(result):
    from api.payroll_ext import D as PD, NON_TAXABLE_CODES
    total = Decimal('0')
    for e in result.get('earnings_data') or []:
        code = str(e.get('code') or '').upper()
        if code in NON_TAXABLE_CODES or code in EXCLUDED_EARNINGS or code.startswith('ADJ_') or code == CODE:
            continue
        total += PD(e.get('amount'))
    return total


def apply_attendance_penalties(result, ctx):
    from api.models import PayrollRun
    from api.payroll_ext import D as PD, recompute, set_line
    email, start, end, run_id = _norm(ctx.get('email')), ctx.get('start'), ctx.get('end'), ctx.get('run_id')
    if not email or not start or not end:
        return result
    if isinstance(start, str):
        start = date.fromisoformat(start[:10])
    if isinstance(end, str):
        end = date.fromisoformat(end[:10])
    base = AttendancePenalty.objects.filter(email__iexact=email, status='lop')
    paid = base.filter(paid_run_id__isnull=False)
    ids = set(paid.values_list('paid_run_id', flat=True))
    if ids:
        alive = set(PayrollRun.objects.filter(id__in=ids).exclude(status='cancelled').values_list('id', flat=True))
        dead = ids - alive
        if dead:
            paid.filter(paid_run_id__in=dead).update(paid_run_id=None)
    cond = Q(paid_run_id__isnull=True)
    if run_id:
        cond |= Q(paid_run_id=run_id)
    rows = list(base.filter(cond, date__gte=start, date__lte=end))
    days_in_period = (end - start).days + 1
    gross = _monthly_gross(result)
    days = sum((Decimal(str(p.days or 0)) for p in rows), Decimal('0'))
    amount = PD(gross / Decimal(days_in_period) * days) if (rows and days_in_period > 0 and gross > 0) else PD(0)
    set_line(result, 'deductions_data', CODE, LABEL, amount)
    if run_id and rows and amount > 0:
        AttendancePenalty.objects.filter(id__in=[p.id for p in rows], paid_run_id__isnull=True).update(paid_run_id=run_id)
    result['attendance_penalty_ids'] = [p.id for p in rows] if amount > 0 else []
    return recompute(result)
