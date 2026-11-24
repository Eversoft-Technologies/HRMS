"""Leave accrual engine (Attendance phase 1 / workstream L).

Monthly accrual, proration for new joiners, carry-forward caps and year-end
encashment / lapse, on top of the append-only ``LeaveLedgerEntry`` table.

Policy
------
The leave policy (MasterDataSet ``leave_policy``, edited in Settings ›
General › Leave Policy) keeps its shape ``{"types": [{"name", "days"}],
"enforceBalance"}``. Each type may carry these OPTIONAL keys; a type without
them behaves exactly as before (a flat grant of ``days`` per calendar year):

    accrual          'annual' (default) | 'monthly'
    monthlyRate      days credited per month (default days / 12)
    accrueOn         'start' (1st of the month, default) | 'end' (last day)
    prorateJoiners   bool, default true
    joinCutoffDay    1-31, default 15: joined after this day of the month ->
                     that month is not credited
    carryForwardMax  days carried into next year (null / 0 = none)
    excess           'lapse' (default) | 'encash' — what happens to the rest
    encashMax        days encashed per year (null = all of the excess)
    encashBasis      'basic' (default) | 'gross'
    encashDivisor    days in a pay month for the per-day rate (default 30)
    maxBalance       cap on the balance monthly credits can build up to
    allowNegative    days an employee may take in advance (default 0)

Ledger
------
balance(year) = sum(ledger days of year) - approved leave starting in year.

* monthly types: one 'accrual' entry per month (period 'YYYY-MM'),
  immutable once written; idempotent through the unique key.
* annual types: one grant entry per year — 'opening' (full grant) or
  'prorate' (a joiner in that year: days x remaining months / 12, rounded to
  0.5), period 'YYYY'. This entry mirrors the CURRENT policy: when the admin
  changes the days (or the joining date is set) before the year is rolled
  over, it is updated in place. Every other entry is never changed.
* year_end_rollover(Y): remaining -> 'carry_forward' (+, year Y+1, period
  'Y') capped at carryForwardMax, closed in Y by a matching negative
  'carry_forward' (period 'to-Y+1'); the excess -> 'encash' (capped at
  encashMax, priced) and/or 'lapse' (negative entries in Y, period 'Y').
* 'adjust': manual HR entries (signed, with a note and created_by).

Accrual is lazy — balance reads call ``accrue`` up to today (cheap and
idempotent) — so nothing depends on cron; ``manage.py leave_accrual`` exists
for scheduled runs and the year-end rollover.

Payroll
-------
``apply_leave_encashment(result, ctx)`` is a payroll calculation hook (see
api/payroll_ext/__init__.py STEPS): unpaid encash entries effective on or
before the period end become a taxable ``LEAVE_ENC`` earning.
"""
import calendar
import logging
import secrets
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Q, Sum

from api.timeutil import local_now, local_today

logger = logging.getLogger(__name__)

ACCRUAL_KEYS = ('accrual', 'monthlyRate', 'accrueOn', 'prorateJoiners', 'joinCutoffDay',
                'carryForwardMax', 'excess', 'encashMax', 'encashBasis', 'encashDivisor',
                'maxBalance', 'allowNegative')
DEFAULTS = {'accrual': 'annual', 'accrueOn': 'start', 'prorateJoiners': True, 'joinCutoffDay': 15,
            'carryForwardMax': None, 'excess': 'lapse', 'encashMax': None, 'encashBasis': 'basic',
            'encashDivisor': 30, 'maxBalance': None, 'allowNegative': 0}
GRANT_KINDS = ('opening', 'accrual', 'prorate')
ROLLOVER_OUT_KINDS = ('lapse', 'encash')
ENC_CODE, ENC_LABEL = 'LEAVE_ENC', 'Leave encashment'
LIMIT = 366

ZERO = Decimal('0')


def D(v):
    try:
        return Decimal(str(v if v is not None else 0)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return Decimal('0.00')


def half(v):
    """Round to the nearest 0.5 day."""
    return (D(v) * 2).quantize(Decimal('1'), rounding=ROUND_HALF_UP) / 2


def num(v):
    """A JSON-friendly number: 1.0 -> 1, 1.50 -> 1.5."""
    if v is None:
        return None
    f = float(v)
    return int(f) if f == int(f) else round(f, 2)


def _date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return datetime.strptime(str(v)[:10], '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return None


def _month_end(y, m):
    return date(y, m, calendar.monthrange(y, m)[1])


# ═════════════════════════════════════════════════════════════════════════
# Policy
# ═════════════════════════════════════════════════════════════════════════
def validate_type_settings(name, days, raw):
    """Validate the optional accrual keys of one policy type.

    Returns (settings, error): settings holds only the keys that were given,
    normalised; error is a user-facing message or None."""
    out = {}
    unknown = [k for k in raw if k not in ('name', 'days') and k not in ACCRUAL_KEYS]
    if unknown:
        return None, f'"{name}": unknown setting {unknown[0]!r}.'

    def number(key, lo, hi, allow_null=False, whole=False):
        v = raw.get(key)
        if v in (None, ''):
            if allow_null:
                return None, None
            return None, f'"{name}": {key} is required.'
        if isinstance(v, bool):
            return None, f'"{name}": {key} must be a number.'
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None, f'"{name}": {key} must be a number.'
        if not lo <= f <= hi or (whole and f != int(f)):
            kind = 'a whole number' if whole else 'a number'
            return None, f'"{name}": {key} must be {kind} from {num(lo)} to {num(hi)}.'
        if whole:
            return int(f), None
        f = float(D(f))
        return (int(f) if f == int(f) else f), None

    def choice(key, options):
        v = raw.get(key)
        if v not in options:
            return None, f'"{name}": {key} must be one of {", ".join(options)}.'
        return v, None

    for key, spec in (('accrual', ('annual', 'monthly')), ('accrueOn', ('start', 'end')),
                      ('excess', ('lapse', 'encash')), ('encashBasis', ('basic', 'gross'))):
        if key in raw and raw[key] not in (None, ''):
            v, e = choice(key, spec)
            if e:
                return None, e
            out[key] = v
    if 'prorateJoiners' in raw and raw['prorateJoiners'] is not None:
        if not isinstance(raw['prorateJoiners'], bool):
            return None, f'"{name}": prorateJoiners must be true or false.'
        out['prorateJoiners'] = raw['prorateJoiners']
    for key, lo, hi, allow_null, whole in (('monthlyRate', 0.01, 31, False, False),
                                           ('joinCutoffDay', 1, 31, False, True),
                                           ('carryForwardMax', 0, LIMIT, True, False),
                                           ('encashMax', 0, LIMIT, True, False),
                                           ('encashDivisor', 1, 31, False, False),
                                           ('maxBalance', 0.5, 2 * LIMIT, True, False),
                                           ('allowNegative', 0, LIMIT, False, False)):
        if key not in raw:
            continue
        if raw[key] in (None, '') and not allow_null:
            continue                                   # blank = default
        v, e = number(key, lo, hi, allow_null=allow_null, whole=whole)
        if e:
            return None, e
        out[key] = v
    if days is None:
        if out.get('accrual') == 'monthly':
            return None, f'"{name}" has no limit, so it cannot accrue monthly — set its days per year.'
        return {}, None                                # nothing to accrue / carry for unlimited types
    return out, None


def rule_of(t):
    """A policy type merged with the accrual defaults."""
    r = dict(DEFAULTS)
    for k in ACCRUAL_KEYS:
        if k in t and (t[k] is not None or k in ('carryForwardMax', 'encashMax', 'maxBalance')):
            r[k] = t[k]
    r['name'], r['days'] = t['name'], t.get('days')
    if r['days'] is not None and not r.get('monthlyRate'):
        r['monthlyRate'] = float(D(Decimal(str(r['days'])) / 12))
    return r


def policy():
    from api.views import _leave_policy
    return _leave_policy()


def rules(pol=None):
    pol = pol or policy()
    return [rule_of(t) for t in pol['types']]


def find_rule(leave_type, pol=None):
    for r in rules(pol):
        if r['name'].lower() == str(leave_type or '').lower():
            return r
    return None


# ═════════════════════════════════════════════════════════════════════════
# Schedule
# ═════════════════════════════════════════════════════════════════════════
def joining_date(email):
    from api.models import UserProfile
    return (UserProfile.objects.filter(email__iexact=email).values_list('start_date', flat=True).first())


def schedule(rule, join, year):
    """Grant entries due in ``year`` for one type: [(kind, period, date, days)]."""
    if rule.get('days') is None or (join and join.year > year):
        return []
    days, cutoff = Decimal(str(rule['days'])), int(rule.get('joinCutoffDay') or 15)
    joiner = bool(join and join.year == year and join > date(year, 1, 1))
    if rule.get('accrual') == 'monthly':
        rate, out = D(rule.get('monthlyRate')), []
        for m in range(1, 13):
            first, last = date(year, m, 1), _month_end(year, m)
            if joiner and join > last:
                continue
            in_join_month = joiner and join.month == m
            if in_join_month and join.day > cutoff and rule.get('prorateJoiners', True):
                continue
            if rule.get('accrueOn') == 'end':
                eff = last
            else:
                eff = max(first, join) if in_join_month else first
            out.append(('accrual', f'{year}-{m:02d}', eff, rate))
        return out
    if joiner and rule.get('prorateJoiners', True):
        months = sum(1 for m in range(join.month, 13) if m > join.month or join.day <= cutoff)
        return [('prorate', str(year), join, half(days * months / 12))]
    return [('opening', str(year), max(date(year, 1, 1), join) if joiner else date(year, 1, 1), D(days))]


# ═════════════════════════════════════════════════════════════════════════
# Ledger helpers
# ═════════════════════════════════════════════════════════════════════════
def _entries(email, leave_type, year):
    from api.models import LeaveLedgerEntry
    return LeaveLedgerEntry.objects.filter(email=email, leave_type=leave_type, year=year)


def _sum(qs):
    return D(qs.aggregate(s=Sum('days'))['s'])


def _rolled_over(email, leave_type, year):
    qs = _entries(email, leave_type, year)
    return qs.filter(Q(kind__in=ROLLOVER_OUT_KINDS, period=str(year))
                     | Q(kind='carry_forward', period=f'to-{year + 1}')).exists()


def _create(**kw):
    """Insert a ledger row; None when the unique key already exists."""
    from api.models import LeaveLedgerEntry
    try:
        with transaction.atomic():
            return LeaveLedgerEntry.objects.create(**kw)
    except IntegrityError:
        return None


def _approved_pending(email, year):
    from api.views import _leave_usage
    return _leave_usage(email, year)


def accrue(email, upto_date, pol=None, actor='system'):
    """Credit every grant due for ``email`` in upto_date's year up to that
    date. Idempotent. Returns the entries created (or resynced)."""
    from api.models import LeaveLedgerEntry
    email = (email or '').strip().lower()
    upto = _date(upto_date)
    if not email or not upto:
        return []
    year, join, made = upto.year, joining_date(email), []
    for rule in rules(pol):
        if rule.get('days') is None:
            continue
        typ = rule['name']
        qs = _entries(email, typ, year)
        if rule['accrual'] == 'monthly':
            # Mirror entries of an annual grant this type no longer uses.
            if not _rolled_over(email, typ, year):
                qs.filter(kind__in=('opening', 'prorate')).delete()
            have = set(qs.filter(kind='accrual').values_list('period', flat=True))
            for kind, period, eff, days in schedule(rule, join, year):
                if eff > upto or period in have:
                    continue
                note = ''
                if rule.get('maxBalance') is not None:
                    approved, _ = _approved_pending(email, year)
                    current = _sum(_entries(email, typ, year)) - D(approved.get(typ, 0))
                    room = max(ZERO, D(rule['maxBalance']) - current)
                    if room < days:
                        days, note = room, f'capped at max balance {num(rule["maxBalance"])}'
                row = _create(email=email, leave_type=typ, year=year, kind=kind, period=period, days=days,
                              effective_date=eff, note=note or f'{num(rule["monthlyRate"])} day(s) for {period}',
                              created_by=actor)
                if row:
                    made.append(row)
            continue
        # annual: one grant entry mirroring the policy (minus any monthly
        # credits written while the type accrued monthly this year)
        sched = schedule(rule, join, year)
        if not sched:
            continue
        kind, period, eff, days = sched[0]
        if eff > upto:
            continue
        days = max(ZERO, days - _sum(qs.filter(kind='accrual')))
        existing = list(qs.filter(kind__in=('opening', 'prorate')))
        if existing:
            if _rolled_over(email, typ, year):
                continue
            row = existing[0]
            if (row.kind, D(row.days)) != (kind, days) or len(existing) > 1:
                for extra in existing[1:]:
                    extra.delete()
                LeaveLedgerEntry.objects.filter(pk=row.pk).update(
                    kind=kind, period=period, days=days, effective_date=eff,
                    note=f'resynced to the leave policy ({num(rule["days"])} days/year)')
                row.refresh_from_db()
                made.append(row)
            continue
        row = _create(email=email, leave_type=typ, year=year, kind=kind, period=period, days=days,
                      effective_date=eff, created_by=actor,
                      note=(f'prorated: joined {join.isoformat()}' if kind == 'prorate'
                            else f'{num(rule["days"])} days for {year}'))
        if row:
            made.append(row)
    return made


def _lazy(email, year, today, pol=None):
    if year < today.year:
        accrue(email, date(year, 12, 31), pol)
    elif year == today.year:
        accrue(email, today, pol)


def _projected(rule, email, year, after, upto):
    """Scheduled credits not yet written with after < date <= upto."""
    if upto <= after or upto.year != year:
        return ZERO
    have = set(_entries(email, rule['name'], year).values_list('kind', 'period'))
    return sum((d for k, p, e, d in schedule(rule, joining_date(email), year)
                if after < e <= upto and (k, p) not in have), ZERO)


def _next_accrual(rule, email, year, today):
    if rule.get('days') is None:
        return None
    join = joining_date(email)
    for y in (year, year + 1):
        for k, p, e, d in schedule(rule, join, y):
            if e > today:
                return {'date': e.isoformat(), 'days': num(d)}
    return None


def type_balance(email, rule, year, today=None, approved=None, pending=None):
    """Balance of one type (no lazy accrual — callers do that first)."""
    today = today or local_today()
    typ = rule['name']
    if approved is None:
        approved, pending = _approved_pending(email, year)
    used, waiting = approved.get(typ, 0) or 0, pending.get(typ, 0) or 0
    base = {'type': typ, 'used': num(used), 'pending': num(waiting), 'accrual': rule.get('accrual', 'annual')}
    if rule.get('days') is None:
        base.update({'allowance': None, 'unlimited': True, 'remaining': None, 'balance': None,
                     'accrued': None, 'carriedForward': 0, 'adjusted': 0, 'encashed': 0, 'lapsed': 0,
                     'annual': None, 'nextAccrual': None, 'canApply': None, 'allowNegative': 0})
        return base
    qs = _entries(email, typ, year)
    rows = list(qs.values('kind', 'period', 'days'))
    total = sum((D(r['days']) for r in rows), ZERO)
    outflow = sum((D(r['days']) for r in rows if r['kind'] in ROLLOVER_OUT_KINDS
                   or (r['kind'] == 'carry_forward' and D(r['days']) < 0)), ZERO)
    credited = total - outflow
    bal = total - D(used)
    allow_neg = D(rule.get('allowNegative') or 0)
    base.update({
        'allowance': num(credited), 'unlimited': False,
        'remaining': num(max(credited - D(used), ZERO)),
        'balance': num(bal),
        'accrued': num(sum((D(r['days']) for r in rows if r['kind'] in GRANT_KINDS), ZERO)),
        'carriedForward': num(sum((D(r['days']) for r in rows if r['kind'] == 'carry_forward'
                                   and D(r['days']) > 0), ZERO)),
        'adjusted': num(sum((D(r['days']) for r in rows if r['kind'] in ('adjust', 'comp_off')), ZERO)),
        'encashed': num(-sum((D(r['days']) for r in rows if r['kind'] == 'encash'), ZERO)),
        'lapsed': num(-sum((D(r['days']) for r in rows if r['kind'] == 'lapse'), ZERO)),
        'annual': num(rule['days']),
        'monthlyRate': num(rule['monthlyRate']) if rule.get('accrual') == 'monthly' else None,
        'nextAccrual': _next_accrual(rule, email, year, today) if year >= today.year else None,
        'allowNegative': num(allow_neg),
        'canApply': num(bal - D(waiting) + allow_neg),
    })
    return base


def balances(email, year=None, today=None):
    """Every policy type's balance for ``email`` in ``year`` (lazy accrual)."""
    today = today or local_today()
    year = year or today.year
    email = (email or '').strip().lower()
    pol = policy()
    _lazy(email, year, today, pol)
    approved, pending = _approved_pending(email, year)
    return pol, [type_balance(email, r, year, today, approved, pending) for r in rules(pol)]


def balance(email, leave_type, year=None, today=None):
    _, bl = balances(email, year, today)
    return next((b for b in bl if b['type'].lower() == str(leave_type).lower()), None)


def available_for(email, rule, from_date, today=None):
    """(days that may still be requested for leave starting on from_date,
    days pending) — ledger balance incl. credits due by from_date, minus
    approved and pending leave, plus allowNegative."""
    today = today or local_today()
    email = (email or '').strip().lower()
    year = from_date.year
    _lazy(email, year, today)
    approved, pending = _approved_pending(email, year)
    typ = rule['name']
    total = _sum(_entries(email, typ, year))
    after = today if year == today.year else (date(year - 1, 12, 31) if year > today.year else from_date)
    total += _projected(rule, email, year, after, from_date)
    waiting = D(pending.get(typ, 0))
    left = total - D(approved.get(typ, 0)) - waiting + D(rule.get('allowNegative') or 0)
    return left, waiting


# ═════════════════════════════════════════════════════════════════════════
# Encashment pricing
# ═════════════════════════════════════════════════════════════════════════
def per_day_rate(email, basis='basic', divisor=30, on_date=None):
    """Monthly basic (or gross) ÷ divisor, from EmployeeCompensation, else
    the latest payslip. Decimal('0') when nothing is known."""
    from api.models import EmployeeCompensation, Payslip
    on_date = on_date or local_today()
    comp = (EmployeeCompensation.objects.filter(email__iexact=email, status='active', effective_from__lte=on_date)
            .order_by('-effective_from', '-id').first()
            or EmployeeCompensation.objects.filter(email__iexact=email).order_by('-effective_from', '-id').first())
    monthly = ZERO
    if basis == 'gross':
        if comp and comp.annual_ctc:
            monthly = D(comp.annual_ctc) / 12
        elif comp and comp.base_amount:
            monthly = D(comp.base_amount)
    elif comp and comp.base_amount:
        monthly = D(comp.base_amount)
    if monthly <= 0:
        slip = Payslip.objects.filter(email__iexact=email).order_by('-created_at', '-id').first()
        if slip:
            monthly = D(slip.gross_earnings if basis == 'gross' else slip.base_salary)
    div = D(divisor or 30) or Decimal('30')
    return D(monthly / div) if monthly > 0 else ZERO


# ═════════════════════════════════════════════════════════════════════════
# Year-end rollover
# ═════════════════════════════════════════════════════════════════════════
def employee_emails(year):
    from api.models import AppUser, LeaveLedgerEntry, LeaveRequest
    emails = set(e.strip().lower() for e in AppUser.objects.filter(status='active').values_list('email', flat=True) if e)
    emails |= set(LeaveLedgerEntry.objects.filter(year=year).values_list('email', flat=True))
    emails |= set(LeaveRequest.objects.filter(from_date__year=year, status='Approved').values_list('email', flat=True))
    return sorted(e for e in emails if e and '@' in e)


def year_end_rollover(year, emails=None, dry_run=False, actor='system'):
    """Close ``year`` for each employee and type; see the module docstring.
    Idempotent — a (employee, type) already rolled over is reported 'done'.
    dry_run computes everything inside a transaction that is rolled back."""
    year = int(year)
    out = {'year': year, 'dryRun': bool(dry_run), 'rows': []}
    with transaction.atomic():
        pol = policy()
        for email in (emails or employee_emails(year)):
            email = email.strip().lower()
            accrue(email, date(year, 12, 31), pol, actor=actor)
            approved, _ = _approved_pending(email, year)
            for rule in rules(pol):
                if rule.get('days') is None:
                    continue
                out['rows'].append(_rollover_one(email, rule, year, approved, actor))
        if dry_run:
            transaction.set_rollback(True)
    tot = {'carryForward': ZERO, 'encash': ZERO, 'encashAmount': ZERO, 'lapse': ZERO}
    for r in out['rows']:
        for k in tot:
            tot[k] += D(r.get(k) or 0)
    out['totals'] = {k: num(v) for k, v in tot.items()}
    out['employees'] = len(set(r['email'] for r in out['rows']))
    return out


def _rollover_one(email, rule, year, approved, actor):
    typ = rule['name']
    qs = _entries(email, typ, year)
    row = {'email': email, 'type': typ}
    if _rolled_over(email, typ, year):
        done = {k: D(_sum(qs.filter(kind=k, period=str(year)))) for k in ('encash', 'lapse')}
        cf = _sum(_entries(email, typ, year + 1).filter(kind='carry_forward', period=str(year)))
        amt = qs.filter(kind='encash', period=str(year)).values_list('amount', flat=True).first()
        row.update({'status': 'done', 'remaining': None, 'carryForward': num(cf), 'encash': num(-done['encash']),
                    'encashAmount': num(amt or 0), 'lapse': num(-done['lapse'])})
        return row
    remaining = _sum(qs) - D(approved.get(typ, 0))
    if remaining <= 0:
        row.update({'status': 'nothing', 'remaining': num(remaining), 'carryForward': 0, 'encash': 0,
                    'encashAmount': 0, 'lapse': 0})
        return row
    cap = rule.get('carryForwardMax')
    carry = min(remaining, D(cap)) if cap is not None else ZERO
    excess = remaining - carry
    encash = ZERO
    if rule.get('excess') == 'encash' and excess > 0:
        encash = min(excess, D(rule['encashMax'])) if rule.get('encashMax') is not None else excess
    lapse = excess - encash
    amount = None
    if encash > 0:
        rate = per_day_rate(email, rule.get('encashBasis', 'basic'), rule.get('encashDivisor', 30),
                            date(year, 12, 31))
        amount = D(rate * encash) if rate > 0 else None
    eoy, next_jan = date(year, 12, 31), date(year + 1, 1, 1)
    if carry > 0:
        _create(email=email, leave_type=typ, year=year, kind='carry_forward', period=f'to-{year + 1}',
                days=-carry, effective_date=eoy, created_by=actor, note=f'carried into {year + 1}')
        _create(email=email, leave_type=typ, year=year + 1, kind='carry_forward', period=str(year),
                days=carry, effective_date=next_jan, created_by=actor,
                note=f'carried forward from {year} (cap {num(cap)})')
    if encash > 0:
        # Effective 1 Jan so the January pay run picks it up.
        _create(email=email, leave_type=typ, year=year, kind='encash', period=str(year), days=-encash,
                effective_date=next_jan, amount=amount, created_by=actor,
                note=f'encashed at year end ({rule.get("encashBasis", "basic")} / {num(rule.get("encashDivisor", 30))})')
    if lapse > 0:
        _create(email=email, leave_type=typ, year=year, kind='lapse', period=str(year), days=-lapse,
                effective_date=eoy, created_by=actor, note='lapsed at year end')
    row.update({'status': 'rolled', 'remaining': num(remaining), 'carryForward': num(carry),
                'encash': num(encash), 'encashAmount': num(amount or 0), 'lapse': num(lapse),
                'priced': amount is not None or encash == 0})
    return row


# ═════════════════════════════════════════════════════════════════════════
# Manual adjustment
# ═════════════════════════════════════════════════════════════════════════
def adjust(email, leave_type, days, note, actor, year=None, effective_date=None):
    eff = _date(effective_date) or local_today()
    year = int(year or eff.year)
    period = 'adj-' + local_now().strftime('%y%m%d%H%M%S') + secrets.token_hex(2)
    from api.models import LeaveLedgerEntry
    row = LeaveLedgerEntry.objects.create(email=email.strip().lower(), leave_type=leave_type, year=year,
                                          kind='adjust', period=period[:20], days=D(days),
                                          effective_date=eff, note=str(note)[:255], created_by=actor or '')
    logger.info('leave ledger adjust by %s: %s %s %s days (%s)', actor, email, leave_type, days, note)
    return row


def entry_dict(e):
    return {'id': e.id, 'email': e.email, 'type': e.leave_type, 'year': e.year, 'kind': e.kind,
            'period': e.period, 'days': num(e.days), 'effectiveDate': e.effective_date.isoformat(),
            'note': e.note, 'amount': num(e.amount) if e.amount is not None else None,
            'paidRunId': e.paid_run_id, 'createdBy': e.created_by,
            'createdAt': e.created_at.isoformat() if e.created_at else None}


# ═════════════════════════════════════════════════════════════════════════
# Payroll hook
# ═════════════════════════════════════════════════════════════════════════
def apply_leave_encashment(result, ctx):
    """Payroll calculation hook: unpaid encash entries effective on or before
    the period end -> taxable earning LEAVE_ENC. With a run id they are marked
    paid by that run; re-running the same run re-includes them, another run
    never pays them again (unless the paying run was deleted / cancelled)."""
    from api.models import LeaveLedgerEntry, PayrollRun
    from api.payroll_ext import D as PD, recompute, set_line
    email, end, run_id = (ctx.get('email') or '').lower(), _date(ctx.get('end')), ctx.get('run_id')
    if not email or not end:
        return result
    paid = LeaveLedgerEntry.objects.filter(email=email, kind='encash', paid_run_id__isnull=False)
    ids = set(paid.values_list('paid_run_id', flat=True))
    if ids:
        alive = set(PayrollRun.objects.filter(id__in=ids).exclude(status='cancelled').values_list('id', flat=True))
        dead = ids - alive
        if dead:
            paid.filter(paid_run_id__in=dead).update(paid_run_id=None)
    cond = Q(paid_run_id__isnull=True)
    if run_id:
        cond |= Q(paid_run_id=run_id)
    rows = list(LeaveLedgerEntry.objects.filter(cond, email=email, kind='encash', effective_date__lte=end))
    total = ZERO
    for e in rows:
        if e.amount is None:          # not priced at rollover — price now
            r = find_rule(e.leave_type) or {}
            rate = per_day_rate(email, r.get('encashBasis', 'basic'), r.get('encashDivisor', 30), end)
            if rate <= 0:
                continue
            e.amount = D(rate * abs(D(e.days)))
            LeaveLedgerEntry.objects.filter(pk=e.pk).update(amount=e.amount)
        total += D(e.amount)
    set_line(result, 'earnings_data', ENC_CODE, ENC_LABEL, PD(total))
    if run_id:
        LeaveLedgerEntry.objects.filter(id__in=[e.id for e in rows if e.amount is not None],
                                        paid_run_id__isnull=True).update(paid_run_id=run_id)
    result['leave_encashment_entry_ids'] = [e.id for e in rows if e.amount is not None]
    return recompute(result)
