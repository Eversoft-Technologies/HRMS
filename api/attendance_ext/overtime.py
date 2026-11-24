"""Overtime rules and comp-off (attendance policy engine, workstream O).

When a day is closed (check-out, an approved regularization) ``on_day_closed``
evaluates it into one ``OvertimeRecord`` per (employee, date).

Rules (all read from the employee's AttendancePolicyProfile via policy.resolve)
------------------------------------------------------------------------------
* threshold  = policy ``overtime_after_minutes``; when null, the shift's
  (flexible shift: flex_hours_per_day x 60, else shift.overtime_after_minutes,
  540 when unset) -- the same rule check-out always used.
* day type   = 'holiday' (the employee's own holiday calendar, an "off" day),
  else 'weekend' (a weekday outside the company work week, team_hub.work_days),
  else 'working'.  On a weekend / holiday the WHOLE worked time is overtime.
* raw OT     = worked - threshold on a working day, worked on an off day.
* caps       = daily cap first, then the weekly cap (Mon-Sun, across the
  employee's records in date order).  0 = no cap.  The record keeps
  ``overtime_minutes`` (claimable, after both caps) and ``capped_minutes``
  (cut by the caps), so raw = overtime_minutes + capped_minutes.
  Approved records are locked: they consume the week's budget with their
  approved minutes and are never re-capped; Pending / Auto ones are re-capped
  whenever any day of that week is (re-)evaluated or decided.
* status     = 'Auto' (approved automatically, approved_minutes = overtime)
  when the policy does not require approval, else 'Pending' for the
  employee's manager (org_views.approver_for) or anyone with overtime.approve.

Re-evaluation is idempotent.  A Pending / Auto record simply follows the new
worked time.  An Approved or Rejected record is never changed silently: when
the worked minutes (or the day type) changed, it is RE-OPENED -- back to
Pending (Auto when the policy needs no approval), approved minutes cleared,
the previous decision kept in decided_by / decided_at and the reason in
``note`` ("Re-approval needed: ...") -- and the approver is told again.  A day
whose overtime falls to zero loses its record (unless comp-off from it was
already used; then the record stays with 0 minutes).

Payroll
-------
payroll_service sums ``EmployeeAttendance.overtime_minutes`` as OT hours (paid
at 1.5x).  For every evaluated day that column now holds the PAYABLE overtime:

    approved_minutes   when the record is Approved / Auto and earned no comp-off
    0                  when Pending, Rejected, or compensated with comp-off

so payroll pays only approved overtime without any payroll change.  The
computed figures live on the OvertimeRecord.  Other code paths that rewrite
overtime_minutes from the shift (admin attendance edit, recalc_attendance)
are re-synced by ``manage.py overtime_jobs --evaluate``.

Comp-off
--------
A weekend / holiday record that is Approved / Auto, with ``comp_off_enabled``,
earns comp-off on the time actually worked (caps limit paid OT, not comp-off;
a partial approval earns on the approved minutes instead):
``>= comp_off_full_day_minutes`` -> 1 day, ``>= comp_off_half_day_minutes`` ->
0.5 day.  A day that earns comp-off is not also paid as overtime.

The credit is a LeaveLedgerEntry (kind 'comp_off', leave_type = policy
``comp_off_leave_type``, period = the work date ISO, year = its year) --
idempotent through the ledger's unique key.  It expires
``comp_off_expiry_days`` after the work date (0 = never), recorded on the
OvertimeRecord (``comp_off_expires``, the last usable day) and in the note.

Leave type: the first credit of a type the leave policy does not list adds it
to the policy (MasterDataSet 'leave_policy') as ``{"name": "Comp Off",
"days": 0, "carryForwardMax": 365}`` -- no annual grant, balance = comp-off
credits only, carried over the year end so a December credit stays usable in
January -- so the normal Apply Leave flow (balance-checked through the
ledger) works for it.  An admin may edit it later like any other type.

"Used" is detected FIFO: the employee's approved leave of that type (all
years), plus year-end lapse / encash entries of the type, is consumed against
the comp-off credits oldest first (skipping what already expired).
Expiry (``expire`` / ``overtime_jobs --expire``, also run lazily when the
summary is read) writes a 'lapse' entry (period 'cox-<credit id>') for the
unused remainder of each expired credit -- once.  A rejection / re-opening /
re-evaluation that removes the right to a credit reverses only its unused
part: the credit row is deleted when nothing of it was used, or reduced to
the used part.
"""
import logging
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum

from api.models import EmployeeAttendance, LeaveLedgerEntry, LeaveRequest, OvertimeRecord, Shift
from api.timeutil import local_now, local_today

from . import leave_accrual as la
from . import policy as policy_mod

logger = logging.getLogger(__name__)

STATUSES = ('Pending', 'Approved', 'Rejected', 'Auto')
GRANTED = ('Approved', 'Auto')
LOCKED = ('Approved', 'Rejected')
OFF_DAY_TYPES = ('weekend', 'holiday')
DAY_TYPES = ('working', 'weekend', 'holiday')
EXPIRY_PREFIX = 'cox-'                 # lapse period of an expired credit: 'cox-<ledger id>'
COMP_OFF_CARRY = 365                   # carryForwardMax of the auto-added comp-off leave type
REOPEN_MARK = 'Re-approval needed'
LINK = '/attendance/overtime'
ZERO = Decimal('0')


class Invalid(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _norm(v):
    return str(v or '').strip().lower()


def D(v):
    return la.D(v)


def hm(minutes):
    m = max(int(minutes or 0), 0)
    h, r = divmod(m, 60)
    return f'{h}h {r:02d}m' if h else f'{r}m'


# ═════════════════════════════════════════════════════════════════════════
# Rules
# ═════════════════════════════════════════════════════════════════════════
def shift_threshold(shift):
    if shift is None:
        return 540
    if shift.is_flexible:
        return int((shift.flex_hours_per_day or 8) * 60)
    return int(shift.overtime_after_minutes or 540)


def shift_of(att):
    from api import views as v
    s = Shift.objects.filter(pk=att.shift_id).first() if att.shift_id else None
    return s or v._get_active_shift(att.email, att.date)


def threshold_for(att, pol, shift=None):
    """(minutes, 'policy' | 'shift')."""
    if pol.overtime_after_minutes is not None:
        return int(pol.overtime_after_minutes), 'policy'
    return shift_threshold(shift if shift is not None else shift_of(att)), 'shift'


def day_type(email, day, resolver=None, work_days=None):
    from api.attendance_ext.holidays import HolidayResolver
    if (resolver or HolidayResolver()).is_holiday(email, day):
        return 'holiday'
    if work_days is None:
        from api.team_hub import work_days as wd
        work_days = wd()
    return 'working' if day.weekday() in work_days else 'weekend'


def raw_overtime(worked, dtype, threshold):
    worked = max(int(worked or 0), 0)
    return worked if dtype in OFF_DAY_TYPES else max(worked - int(threshold or 0), 0)


def _cap(v):
    v = int(v or 0)
    return v if v > 0 else None            # 0 = no cap


def week_bounds(day):
    mon = day - timedelta(days=day.weekday())
    return mon, mon + timedelta(days=6)


def payable_minutes(rec):
    """What payroll pays for the day (EmployeeAttendance.overtime_minutes)."""
    if rec is None or rec.status not in GRANTED or D(rec.comp_off_days) > 0:
        return 0
    return int(rec.approved_minutes or 0)


def comp_off_target(rec, pol):
    if rec.day_type not in OFF_DAY_TYPES or not pol.comp_off_enabled or rec.status not in GRANTED:
        return ZERO
    full_approval = (rec.approved_minutes or 0) >= (rec.overtime_minutes or 0)
    basis = (rec.worked_minutes or 0) if full_approval else (rec.approved_minutes or 0)
    full, half = int(pol.comp_off_full_day_minutes or 0), int(pol.comp_off_half_day_minutes or 0)
    if full and basis >= full:
        return Decimal('1')
    if half and basis >= half:
        return Decimal('0.5')
    return ZERO


# ═════════════════════════════════════════════════════════════════════════
# Comp-off ledger
# ═════════════════════════════════════════════════════════════════════════
def ensure_leave_type(name):
    """Add ``name`` to the leave policy as a no-grant type if missing. True when added."""
    from api.models import MasterDataSet
    from api.views import LEAVE_POLICY_KEY, _leave_policy
    name = ' '.join(str(name or '').split())[:60]
    if not name:
        return False
    pol = _leave_policy()
    if any(t['name'].lower() == name.lower() for t in pol['types']):
        return False
    types = list(pol['types']) + [{'name': name, 'days': 0, 'carryForwardMax': COMP_OFF_CARRY}]
    MasterDataSet.objects.update_or_create(
        key=LEAVE_POLICY_KEY, defaults={'label': 'Leave policy',
                                        'options': {'types': types, 'enforceBalance': pol['enforceBalance']}})
    logger.info('leave policy: added comp-off leave type %r', name)
    return True


def _lapsed_map(email, leave_type):
    out = {}
    for period, days in LeaveLedgerEntry.objects.filter(
            email=email, leave_type__iexact=leave_type, kind='lapse',
            period__startswith=EXPIRY_PREFIX).values_list('period', 'days'):
        try:
            out[int(period[len(EXPIRY_PREFIX):])] = out.get(int(period[len(EXPIRY_PREFIX):]), ZERO) - D(days)
        except ValueError:
            continue
    return out


def allocation(email, leave_type):
    """FIFO: (credits, used{id: days}, lapsed{id: days}) for one comp-off type."""
    email = _norm(email)
    credits = list(LeaveLedgerEntry.objects.filter(email=email, leave_type__iexact=leave_type, kind='comp_off',
                                                   days__gt=0).order_by('effective_date', 'id'))
    lapsed = _lapsed_map(email, leave_type)
    pool = D(LeaveRequest.objects.filter(email__iexact=email, type__iexact=leave_type, status='Approved')
             .aggregate(s=Sum('days'))['s'])
    yearly_out = LeaveLedgerEntry.objects.filter(email=email, leave_type__iexact=leave_type,
                                                 kind__in=('lapse', 'encash')) \
        .exclude(period__startswith=EXPIRY_PREFIX).aggregate(s=Sum('days'))['s']
    pool += -D(yearly_out) if yearly_out else ZERO
    used = {}
    for c in credits:
        avail = max(D(c.days) - lapsed.get(c.id, ZERO), ZERO)
        take = min(avail, max(pool, ZERO))
        used[c.id] = take
        pool -= take
    return credits, used, lapsed


def _consumed(entry):
    _, used, lapsed = allocation(entry.email, entry.leave_type)
    return used.get(entry.id, ZERO) + lapsed.get(entry.id, ZERO)


def _find_credit(rec):
    e = LeaveLedgerEntry.objects.filter(pk=rec.comp_off_ledger_id, kind='comp_off').first() \
        if rec.comp_off_ledger_id else None
    return e or LeaveLedgerEntry.objects.filter(email=rec.email, kind='comp_off',
                                                period=rec.date.isoformat()).first()


def expiry_of(rec, pol):
    days = int(pol.comp_off_expiry_days or 0)
    return rec.date + timedelta(days=days) if days > 0 else None


def sync_comp_off(rec, pol, actor='system'):
    """Credit / adjust / reverse the comp-off this record earns. Saves rec."""
    target = comp_off_target(rec, pol)
    entry = _find_credit(rec)
    cur = D(entry.days) if entry else ZERO
    if target > 0:
        typ = entry.leave_type if entry else (pol.comp_off_leave_type or 'Comp Off')
        ensure_leave_type(typ)
        exp = expiry_of(rec, pol)
        what = 'holiday' if rec.day_type == 'holiday' else 'weekly-off'
        note = (f'Comp-off for {what} work on {rec.date.isoformat()} ({hm(rec.worked_minutes)})'
                + (f'; expires {exp.isoformat()}' if exp else ''))[:255]
        if entry is None:
            entry = la._create(email=rec.email, leave_type=typ, year=rec.date.year, kind='comp_off',
                               period=rec.date.isoformat(), days=target, effective_date=rec.date,
                               note=note, created_by=actor) or _find_credit(rec)
        elif cur != target:
            new = target if target > cur else max(target, _consumed(entry))
            LeaveLedgerEntry.objects.filter(pk=entry.pk).update(days=new, note=note)
            entry.days = new
        rec.comp_off_days = D(entry.days) if entry else ZERO
        rec.comp_off_ledger_id = entry.id if entry else None
        rec.comp_off_expires = exp if entry else None
    else:
        if entry is not None:
            consumed = _consumed(entry)
            if consumed <= 0:
                entry.delete()
                entry = None
            elif consumed < cur:
                LeaveLedgerEntry.objects.filter(pk=entry.pk).update(
                    days=consumed, note=(f'{entry.note}; unused part reversed')[:255])
                entry.days = consumed
        rec.comp_off_days = D(entry.days) if entry else ZERO
        rec.comp_off_ledger_id = entry.id if entry else None
        if entry is None:
            rec.comp_off_expires = None
    if rec.pk:
        OvertimeRecord.objects.filter(pk=rec.pk).update(
            comp_off_days=rec.comp_off_days, comp_off_ledger_id=rec.comp_off_ledger_id,
            comp_off_expires=rec.comp_off_expires)
    return rec


def _sync_attendance(email, day, minutes, att=None):
    EmployeeAttendance.objects.filter(email=email, date=day).update(overtime_minutes=int(minutes))
    if att is not None:
        att.overtime_minutes = int(minutes)


def _apply_effects(recs, pol, att=None, actor='system'):
    for r in recs:
        sync_comp_off(r, pol, actor)
        same = att is not None and att.date == r.date and _norm(att.email) == r.email
        _sync_attendance(r.email, r.date, payable_minutes(r), att if same else None)


def balance_rows(email, today=None):
    """Every comp-off credit of the employee with its state, newest first."""
    today = today or local_today()
    email = _norm(email)
    types = set(LeaveLedgerEntry.objects.filter(email=email, kind='comp_off')
                .values_list('leave_type', flat=True))
    recs = {r.comp_off_ledger_id: r for r in OvertimeRecord.objects.filter(email=email,
                                                                            comp_off_ledger_id__isnull=False)}
    rows = []
    for typ in sorted(types):
        credits, used, lapsed = allocation(email, typ)
        for c in credits:
            rec = recs.get(c.id)
            exp = rec.comp_off_expires if rec else None
            u, l = used.get(c.id, ZERO), lapsed.get(c.id, ZERO)
            left = max(D(c.days) - u - l, ZERO)
            if left <= 0:
                state = 'used' if l <= 0 else 'expired'
            elif exp and exp < today:
                state = 'expired'          # not lapsed yet (job not run)
            elif exp and exp <= today + timedelta(days=14):
                state = 'expiring'
            else:
                state = 'active'
            rows.append({'ledgerId': c.id, 'type': c.leave_type, 'date': c.effective_date.isoformat(),
                         'days': la.num(c.days), 'used': la.num(u), 'lapsed': la.num(l), 'remaining': la.num(left),
                         'expires': exp.isoformat() if exp else None, 'state': state,
                         'recordId': rec.id if rec else None, 'dayType': rec.day_type if rec else ''})
    rows.sort(key=lambda r: (r['date'], r['ledgerId']), reverse=True)
    return rows


# ═════════════════════════════════════════════════════════════════════════
# Evaluation
# ═════════════════════════════════════════════════════════════════════════
def _rebalance_week(email, day, pol):
    """Daily cap, then weekly cap across the week's records. Returns the week's records."""
    mon, sun = week_bounds(day)
    recs = list(OvertimeRecord.objects.select_for_update().filter(email=email, date__range=(mon, sun))
                .order_by('date', 'id'))
    dcap, wcap = _cap(pol.overtime_daily_cap_minutes), _cap(pol.overtime_weekly_cap_minutes)
    used = sum(int(r.approved_minutes or 0) for r in recs if r.status == 'Approved')
    for r in recs:
        if r.status in LOCKED:
            continue
        raw = int(r.overtime_minutes or 0) + int(r.capped_minutes or 0)
        eff = min(raw, dcap) if dcap is not None else raw
        if wcap is not None:
            eff = min(eff, max(wcap - used, 0))
        used += eff
        new = (eff, raw - eff, eff if r.status == 'Auto' else 0)
        if (r.overtime_minutes, r.capped_minutes, r.approved_minutes) != new:
            r.overtime_minutes, r.capped_minutes, r.approved_minutes = new
            OvertimeRecord.objects.filter(pk=r.pk).update(overtime_minutes=eff, capped_minutes=raw - eff,
                                                          approved_minutes=new[2], updated_at=local_now())
    return recs


def _notify_pending(rec, reopened=False):
    from api import org_views
    from api.views import notify_approvers
    who = rec.employee_name or rec.email
    what = (f'{who} worked {hm(rec.worked_minutes)} on {rec.date.isoformat()}'
            + (f' ({rec.day_type})' if rec.day_type != 'working' else '')
            + f': {hm(rec.overtime_minutes)} overtime to approve.'
            + (' The worked time changed after an earlier decision.' if reopened else ''))
    title = 'Overtime to re-approve' if reopened else 'Overtime to approve'
    try:
        if rec.approver_email:
            org_views.notify(rec.approver_email, title, what, LINK)
        else:
            notify_approvers('overtime.approve', title, what, LINK)
    except Exception:
        logger.exception('overtime: approver notification failed for %s %s', rec.email, rec.date)


def evaluate_day(att, pol=None, resolver=None, work_days=None, notify=True, actor='system'):
    """Upsert the OvertimeRecord of a closed day; returns it (None when the day has no overtime)."""
    if att is None or not att.check_in or not att.check_out or not att.date:
        return None
    from api import org_views
    email = _norm(att.email)
    pol = pol or policy_mod.resolve(email)
    threshold, _src = threshold_for(att, pol)
    dtype = day_type(email, att.date, resolver, work_days)
    worked = max(int(att.worked_minutes or 0), 0)
    raw = raw_overtime(worked, dtype, threshold)
    fresh_status = 'Pending' if pol.overtime_requires_approval else 'Auto'
    tell, reopened = False, False
    with transaction.atomic():
        rec = OvertimeRecord.objects.select_for_update().filter(email=email, date=att.date).first()
        if rec is None and raw <= 0:
            _sync_attendance(email, att.date, 0, att)
            return None
        if rec is not None and raw <= 0:
            rec.status, rec.approved_minutes = 'Rejected', 0      # strips any comp-off right
            sync_comp_off(rec, pol, actor)
            if D(rec.comp_off_days) > 0:                          # some of it already used: keep the trace
                OvertimeRecord.objects.filter(pk=rec.pk).update(
                    worked_minutes=worked, overtime_minutes=0, capped_minutes=0, approved_minutes=0,
                    day_type=dtype, status='Rejected', updated_at=local_now(),
                    note=(f'{REOPEN_MARK}: no overtime any more ({hm(worked)} worked); '
                          'comp-off already used is kept.'))
            else:
                rec.delete()
            recs = _rebalance_week(email, att.date, pol)
            _apply_effects(recs, pol, actor=actor)
            _sync_attendance(email, att.date, 0, att)
            return None
        if rec is None:
            rec = OvertimeRecord(email=email, date=att.date, status=fresh_status,
                                 approver_email=org_views.approver_for(email) if fresh_status == 'Pending' else '')
            tell = fresh_status == 'Pending'
        elif rec.status in LOCKED:
            if rec.worked_minutes != worked or rec.day_type != dtype:
                was = rec.status.lower()
                rec.note = (f'{REOPEN_MARK}: worked time changed from {hm(rec.worked_minutes)} to {hm(worked)} '
                            f'after it was {was}' + (f' ({hm(rec.approved_minutes)} approved)' if was == 'approved'
                                                     else '') + '.')[:1000]
                rec.status, rec.approved_minutes = fresh_status, 0
                rec.approver_email = org_views.approver_for(email) if fresh_status == 'Pending' else ''
                reopened = tell = fresh_status == 'Pending'
        rec.employee_name = att.employee_name or rec.employee_name or ''
        rec.attendance_id = att.id
        rec.worked_minutes = worked
        rec.day_type = dtype
        rec.profile_id = pol.profile_id
        if rec.status not in LOCKED:
            rec.overtime_minutes, rec.capped_minutes = raw, 0       # caps applied by the week pass
            if rec.status == 'Auto':
                rec.approved_minutes = raw
        rec.save()
        recs = _rebalance_week(email, att.date, pol)
        _apply_effects(recs, pol, att, actor)
        rec = next((r for r in recs if r.pk == rec.pk), rec)
    if tell and notify:
        _notify_pending(rec, reopened)
    return rec


def on_day_closed(att):
    """Hook for check-out / regularization approval. Never raises: a broken
    overtime rule must not break a check-out."""
    try:
        with transaction.atomic():
            return evaluate_day(att)
    except Exception:
        logger.exception('overtime evaluation failed for %s %s', getattr(att, 'email', ''), getattr(att, 'date', ''))
        return None


def evaluate_range(start, end, email=None, actor='system'):
    """Re-evaluate every closed day in [start, end]. Returns counts."""
    from api.attendance_ext.holidays import HolidayResolver
    from api.team_hub import work_days
    res, hol, wd = policy_mod.Resolver(), HolidayResolver(), work_days()
    qs = EmployeeAttendance.objects.filter(date__range=(start, end), check_in__isnull=False,
                                           check_out__isnull=False)
    if email:
        qs = qs.filter(email__iexact=_norm(email))
    out = {'days': 0, 'records': 0, 'pending': 0, 'auto': 0, 'compOffDays': 0.0}
    for att in qs.order_by('email', 'date'):
        rec = evaluate_day(att, res.resolve(_norm(att.email)), hol, wd, notify=False, actor=actor)
        out['days'] += 1
        if rec is not None:
            out['records'] += 1
            out['pending'] += rec.status == 'Pending'
            out['auto'] += rec.status == 'Auto'
            out['compOffDays'] += float(rec.comp_off_days or 0)
    # Records left over for days that no longer exist / are no longer closed.
    stale = OvertimeRecord.objects.filter(date__range=(start, end)).exclude(
        attendance_id__in=qs.values_list('id', flat=True))
    if email:
        stale = stale.filter(email__iexact=_norm(email))
    out['stale'] = stale.count()
    return out


# ═════════════════════════════════════════════════════════════════════════
# Decisions
# ═════════════════════════════════════════════════════════════════════════
def can_decide(caller, user_has_edit, rec):
    from api import org_views
    caller = _norm(caller)
    if not caller or caller == rec.email:
        return False
    return bool(user_has_edit or caller == _norm(rec.approver_email) or org_views.is_manager_of(caller, rec.email))


def decide(rec_id, actor, action, minutes=None, note=''):
    """Approve (in full, or ``minutes``) or reject a Pending record. Raises Invalid.
    Returns (record, emailed)."""
    action = _norm(action)
    if action not in ('approve', 'reject'):
        raise Invalid('action must be approve or reject.')
    note = str(note or '').strip()[:1000]
    with transaction.atomic():
        rec = OvertimeRecord.objects.select_for_update().filter(pk=rec_id).first()
        if rec is None:
            raise Invalid('Overtime record not found.', 404)
        if _norm(actor) == rec.email:
            raise Invalid('You cannot approve or reject your own overtime.', 403)
        if rec.status != 'Pending':
            raise Invalid(f'This overtime is already {rec.status.lower()}.', 409)
        pol = policy_mod.resolve(rec.email)
        if action == 'approve':
            if minutes in (None, ''):
                m = int(rec.overtime_minutes or 0)
            else:
                try:
                    m = int(float(minutes))
                except (TypeError, ValueError):
                    raise Invalid('minutes must be a whole number.')
                if not 0 <= m <= int(rec.overtime_minutes or 0):
                    raise Invalid(f'Approve between 0 and {rec.overtime_minutes} minutes '
                                  f'(the overtime after the daily / weekly caps).')
            rec.status, rec.approved_minutes = 'Approved', m
        else:
            rec.status, rec.approved_minutes = 'Rejected', 0
        rec.decided_by, rec.decided_at = _norm(actor), local_now()
        if note or REOPEN_MARK in (rec.note or ''):
            rec.note = note
        rec.save(update_fields=['status', 'approved_minutes', 'decided_by', 'decided_at', 'note', 'updated_at'])
        recs = _rebalance_week(rec.email, rec.date, pol)
        _apply_effects(recs, pol, actor=_norm(actor))
        rec.refresh_from_db()
    return rec, _tell_employee(rec)


def _tell_employee(rec):
    """In-app + e-mail to the employee. Returns True when the e-mail went out."""
    from api import mailer
    from api.views import create_notification
    approved = rec.status == 'Approved'
    day = rec.date.isoformat()
    if approved:
        part = rec.approved_minutes < rec.overtime_minutes
        msg = (f'Your overtime on {day} was approved' + (' in part' if part else '')
               + f': {hm(rec.approved_minutes)}' + (f' of {hm(rec.overtime_minutes)}' if part else '') + '.')
        if D(rec.comp_off_days) > 0:
            msg += (f' You earned {la.num(rec.comp_off_days)} day comp-off'
                    + (f', usable until {rec.comp_off_expires.isoformat()}' if rec.comp_off_expires else '') + '.')
    else:
        msg = f'Your overtime on {day} ({hm(rec.overtime_minutes)}) was rejected.'
    if rec.note:
        msg += f' Note: {rec.note}'
    title = 'Overtime approved' if approved else 'Overtime rejected'
    try:
        create_notification(rec.email, title, msg, 'success' if approved else 'warning', LINK)
    except Exception:
        logger.exception('overtime: in-app notification failed for %s', rec.email)
    try:
        html = mailer.render_branded(title=title, intro=msg)
        res = mailer.send_email(to=rec.email, subject=f'{title}: {day}', html=html, text=msg)
    except Exception as e:
        logger.exception('overtime: e-mail to %s failed', rec.email)
        res = {'ok': False, 'error': str(e)}
    if not (isinstance(res, dict) and res.get('ok')):
        logger.warning('overtime: e-mail to %s not sent: %s', rec.email, (res or {}).get('error') if isinstance(res, dict) else res)
        return False
    return True


# ═════════════════════════════════════════════════════════════════════════
# Expiry
# ═════════════════════════════════════════════════════════════════════════
def expire(today=None, email=None, actor='system'):
    """Lapse the unused remainder of every comp-off credit past its expiry.
    Idempotent. Returns [{email, date, days}] lapsed now."""
    today = today or local_today()
    qs = OvertimeRecord.objects.filter(comp_off_ledger_id__isnull=False, comp_off_expires__lt=today)
    if email:
        qs = qs.filter(email__iexact=_norm(email))
    cache, out = {}, []
    for rec in qs.order_by('email', 'date'):
        entry = LeaveLedgerEntry.objects.filter(pk=rec.comp_off_ledger_id, kind='comp_off').first()
        if entry is None:
            continue
        key = (entry.email, entry.leave_type.lower())
        if key not in cache:
            cache[key] = allocation(entry.email, entry.leave_type)
        _, used, lapsed = cache[key]
        if lapsed.get(entry.id, ZERO) > 0:
            continue
        left = D(entry.days) - used.get(entry.id, ZERO)
        if left <= 0:
            continue
        year = entry.year
        while year < today.year and la._rolled_over(entry.email, entry.leave_type, year):
            year += 1                      # the balance was carried into the next year
        row = la._create(email=entry.email, leave_type=entry.leave_type, year=year, kind='lapse',
                         period=f'{EXPIRY_PREFIX}{entry.id}'[:20], days=-left, effective_date=rec.comp_off_expires,
                         note=f'comp-off of {rec.date.isoformat()} expired unused on {rec.comp_off_expires.isoformat()}',
                         created_by=actor)
        if row is not None:
            lapsed[entry.id] = left
            out.append({'email': entry.email, 'date': rec.date.isoformat(), 'days': la.num(left)})
    return out


# ═════════════════════════════════════════════════════════════════════════
# Presentation
# ═════════════════════════════════════════════════════════════════════════
def to_dict(rec, caller='', has_edit=False):
    return {
        'id': rec.id, 'email': rec.email, 'employeeName': rec.employee_name or rec.email,
        'date': rec.date.isoformat(), 'attendanceId': rec.attendance_id, 'dayType': rec.day_type,
        'workedMinutes': rec.worked_minutes, 'overtimeMinutes': rec.overtime_minutes,
        'cappedMinutes': rec.capped_minutes, 'rawMinutes': rec.overtime_minutes + rec.capped_minutes,
        'status': rec.status, 'approvedMinutes': rec.approved_minutes, 'payableMinutes': payable_minutes(rec),
        'compOffDays': la.num(rec.comp_off_days), 'compOffExpires': rec.comp_off_expires.isoformat()
        if rec.comp_off_expires else None,
        'approverEmail': rec.approver_email, 'decidedBy': rec.decided_by,
        'decidedAt': rec.decided_at.isoformat() if rec.decided_at else None, 'note': rec.note or '',
        'reopened': rec.status in ('Pending', 'Auto') and REOPEN_MARK in (rec.note or ''),
        'canDecide': rec.status == 'Pending' and can_decide(caller, has_edit, rec),
    }


def summary(email, year, month, today=None):
    today = today or local_today()
    email = _norm(email)
    start = date(year, month, 1)
    end = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1))
    recs = list(OvertimeRecord.objects.filter(email=email, date__range=(start, end)))
    granted = [r for r in recs if r.status in GRANTED]
    rows = balance_rows(email, today)
    remaining = sum((D(r['remaining']) for r in rows if r['state'] in ('active', 'expiring')), ZERO)
    soon = [r for r in rows if r['state'] == 'expiring']
    return {
        'email': email, 'month': f'{year}-{month:02d}',
        'records': len(recs),
        'approvedMinutes': sum(r.approved_minutes for r in granted),
        'approvedHours': round(sum(r.approved_minutes for r in granted) / 60.0, 2),
        'payableMinutes': sum(payable_minutes(r) for r in recs),
        'payableHours': round(sum(payable_minutes(r) for r in recs) / 60.0, 2),
        'pendingMinutes': sum(r.overtime_minutes for r in recs if r.status == 'Pending'),
        'pendingCount': sum(1 for r in recs if r.status == 'Pending'),
        'rejectedCount': sum(1 for r in recs if r.status == 'Rejected'),
        'cappedMinutes': sum(r.capped_minutes for r in recs),
        'compOff': {
            'earned': la.num(sum((D(r.comp_off_days) for r in recs), ZERO)),
            'balance': la.num(remaining),
            'used': la.num(sum((D(r['used']) for r in rows), ZERO)),
            'lapsed': la.num(sum((D(r['lapsed']) for r in rows), ZERO)),
            'expiringSoon': la.num(sum((D(r['remaining']) for r in soon), ZERO)),
            'credits': rows[:50],
        },
    }


def policy_json(pol):
    return {'profileName': pol.name, 'source': pol.source,
            'overtimeAfterMinutes': pol.overtime_after_minutes,
            'dailyCapMinutes': pol.overtime_daily_cap_minutes, 'weeklyCapMinutes': pol.overtime_weekly_cap_minutes,
            'requiresApproval': bool(pol.overtime_requires_approval), 'compOffEnabled': bool(pol.comp_off_enabled),
            'compOffHalfDayMinutes': pol.comp_off_half_day_minutes,
            'compOffFullDayMinutes': pol.comp_off_full_day_minutes,
            'compOffLeaveType': pol.comp_off_leave_type, 'compOffExpiryDays': pol.comp_off_expiry_days}

