"""India income tax: dual regime (Sec. 115BAC), editable tax tables, monthly
TDS, employee IT declarations / proofs and HR verification.

Tax tables
----------
``PayrollTaxTable`` rows (country='IN', period=FY '2026-27', kind='regime_new' |
'regime_old') hold::

    {slabs:[{upto, rate}], standard_deduction, rebate_limit, rebate_max,
     rebate_marginal_relief, cess_pct, surcharge:[{above, rate}],
     section_limits:{"80C", "80CCD1B", "80D", "80D_senior", "24b"}}

``seed_tax_tables(fy)`` creates them (idempotently) from DEFAULTS, marked
"Seeded defaults — verify against the current Finance Act". Payroll Admin
(``payroll.tax.manage``) edits them.

TDS (``apply_tds``, run for every employee by the calculation hook)
-------------------------------------------------------------------
INR employees only. Projected annual income =
  this month's recurring taxable earnings x months left in the FY (incl. this one)
  + this month's one-off earnings (ADJ_* adjustments, overtime) - this month's LOP
  + taxable income already paid this FY (earlier Payslip rows),
then standard deduction, and under the OLD regime also professional tax (16(iii),
max 2,500), HRA exemption (Sec 10(13A)), 80C (incl. employee PF), 80CCD(1B), 80D
and 24(b). Declared amounts are used until HR verifies / locks the declaration,
verified amounts afterwards. Annual tax (slabs, 87A rebate with marginal relief,
surcharge with marginal relief, cess) minus TDS already deducted this FY is spread
over the remaining months, never negative, rounded to the rupee.

Regime lock policy
------------------
The employee picks Old or New (default New) for each FY. The choice is frozen when
  * HR locks it (``regime_locked``) or locks the declaration, or
  * an APPROVED or PAID payroll run in that FY already contains the employee
    (TDS has then been finalised on that regime).
HR (``payroll.tax.verify``) can still change / unlock the regime with an audit row.

Proof window
------------
Proofs can be uploaded only between ``tax_proof_window_start`` and
``tax_proof_window_end`` (PayrollSetting, 'MM-DD', default 01-01 .. 02-28) and only
for the current FY. Declarations can be edited at any time while not locked.
"""

import logging
import os
import re
import secrets
from calendar import monthrange
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

from django.db import IntegrityError, transaction

from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import D, NON_TAXABLE_CODES, recompute, set_line
from . import security as sec

logger = logging.getLogger(__name__)

PERM_MANAGE = 'payroll.tax.manage'
PERM_VERIFY = 'payroll.tax.verify'
SEED_NOTE = 'Seeded defaults — verify against the current Finance Act'
KINDS = {'new': 'regime_new', 'old': 'regime_old'}
ZERO = Decimal('0')
ONE = Decimal('1')

BASIC_CODES = {'BASIC_SALARY', 'BASIC'}
HRA_CODES = {'HRA'}
PT_CODES = {'PT', 'PROFESSIONAL_TAX'}
LOP_CODES = {'UNPAID_LEAVE_DEDUCTION'}
ONE_OFF_CODES = {'OVERTIME'}
PT_CAP = Decimal('2500')                # Sec 16(iii)
MAX_AMOUNT = Decimal('100000000')       # 10 crore — sanity cap for any declared amount
MAX_ITEMS = 40
MAX_PROOFS = 60
PROOF_MAX_MB = 5

SECTIONS = {
    '80C': {'label': '80C — PPF, ELSS, LIC, tuition fees, home-loan principal, NSC, 5-yr FD, SSY',
            'limit_key': '80C'},
    '80CCD1B': {'label': '80CCD(1B) — additional NPS contribution', 'limit_key': '80CCD1B'},
    '80D': {'label': '80D — health insurance (self / spouse / children)', 'limit_key': '80D'},
    '80D_parents': {'label': '80D — health insurance (parents)', 'limit_key': '80D'},
    '24b': {'label': '24(b) — interest on housing loan (self-occupied)', 'limit_key': '24b'},
}

DEFAULT_WINDOW = ('01-01', '02-28')


class Bad(Exception):
    """Input validation failure → HTTP 400 with this message."""


# ── dates / FY ────────────────────────────────────────────────────────────
def _today():
    from django.conf import settings
    return timezone.localdate() if settings.USE_TZ else date.today()


_FY_RE = re.compile(r'^(\d{4})-(\d{2})$')


def valid_fy(fy):
    m = _FY_RE.match(str(fy or ''))
    if not m:
        return False
    y = int(m.group(1))
    return 2000 <= y <= 2098 and int(m.group(2)) == (y + 1) % 100


def fy_of(d):
    y = d.year if d.month >= 4 else d.year - 1
    return f'{y}-{(y + 1) % 100:02d}'


def fy_bounds(fy):
    y = int(str(fy)[:4])
    return date(y, 4, 1), date(y + 1, 3, 31)


def months_left(d):
    """Months from d's month to March, inclusive (April → 12, March → 1)."""
    return (3 - d.month) % 12 + 1


def _as_date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], '%Y-%m-%d').date()


def _fy_param(value, default_today=True):
    fy = str(value or '').strip()
    if not fy and default_today:
        return fy_of(_today())
    if not valid_fy(fy):
        raise Bad("Financial year must look like '2026-27'.")
    return fy


# ── tables ────────────────────────────────────────────────────────────────
def default_tables():
    limits = {'80C': 150000, '80CCD1B': 50000, '80D': 25000, '80D_senior': 50000, '24b': 200000}
    surcharge = [{'above': 5000000, 'rate': 10}, {'above': 10000000, 'rate': 15}, {'above': 20000000, 'rate': 25}]
    new = {
        'slabs': [{'upto': 400000, 'rate': 0}, {'upto': 800000, 'rate': 5}, {'upto': 1200000, 'rate': 10},
                  {'upto': 1600000, 'rate': 15}, {'upto': 2000000, 'rate': 20}, {'upto': 2400000, 'rate': 25},
                  {'upto': None, 'rate': 30}],
        'standard_deduction': 75000, 'rebate_limit': 1200000, 'rebate_max': 60000,
        'rebate_marginal_relief': True, 'cess_pct': 4,
        'surcharge': [dict(s) for s in surcharge],          # new regime: capped at 25 %
        'section_limits': dict(limits),
    }
    old = {
        'slabs': [{'upto': 250000, 'rate': 0}, {'upto': 500000, 'rate': 5}, {'upto': 1000000, 'rate': 20},
                  {'upto': None, 'rate': 30}],
        'standard_deduction': 50000, 'rebate_limit': 500000, 'rebate_max': 12500,
        'rebate_marginal_relief': False, 'cess_pct': 4,
        'surcharge': [dict(s) for s in surcharge] + [{'above': 50000000, 'rate': 37}],
        'section_limits': dict(limits),
    }
    return {'regime_new': new, 'regime_old': old}


def seed_tax_tables(fy):
    """Create the IN tables for ``fy`` if missing. Idempotent. Returns {kind: row}."""
    from ..models import PayrollTaxTable
    if not valid_fy(fy):
        raise ValueError('bad FY')
    out = {}
    for kind, data in default_tables().items():
        row = PayrollTaxTable.objects.filter(country='IN', period=fy, kind=kind, region='').first()
        if row is None:
            try:
                with transaction.atomic():
                    row = PayrollTaxTable.objects.create(country='IN', period=fy, kind=kind, region='', data=data,
                                                         notes=SEED_NOTE, updated_by='system')
            except IntegrityError:
                row = PayrollTaxTable.objects.get(country='IN', period=fy, kind=kind, region='')
        out[kind] = row
    return out


def get_table(fy, regime):
    """Table data for a regime ('new' | 'old'), seeded when missing; missing keys
    fall back to the defaults so a partial edit can never crash the TDS step."""
    kind = KINDS.get(regime, 'regime_new')
    row = seed_tax_tables(fy)[kind]
    data = dict(default_tables()[kind])
    data.update(row.data or {})
    lim = dict(default_tables()[kind]['section_limits'])
    lim.update((row.data or {}).get('section_limits') or {})
    data['section_limits'] = lim
    return data


# ── pure tax maths ────────────────────────────────────────────────────────
def _dec(v):
    try:
        return Decimal(str(v if v not in (None, '') else 0))
    except (InvalidOperation, ValueError):
        return ZERO


def _r0(v):
    return v.quantize(ONE, rounding=ROUND_HALF_UP)


def _f(v):
    return float(D(v))


def _slab_tax(income, slabs):
    tax, lower, rows = ZERO, ZERO, []
    for s in slabs or []:
        upto = None if s.get('upto') in (None, '') else _dec(s.get('upto'))
        rate = _dec(s.get('rate'))
        top = income if upto is None else min(income, upto)
        band = max(ZERO, top - lower)
        amt = band * rate / 100
        rows.append({'from': _f(lower), 'upto': None if upto is None else _f(upto), 'rate': float(rate),
                     'income': _f(band), 'tax': _f(amt)})
        tax += amt
        if upto is None:
            break
        lower = max(lower, upto)
    return tax, rows


def _surcharge_band(income, surcharge):
    """(rate, threshold, previous_rate) of the highest band ``income`` exceeds."""
    bands = sorted(((_dec(s.get('above')), _dec(s.get('rate'))) for s in (surcharge or [])), key=lambda b: b[0])
    rate, threshold, prev = ZERO, ZERO, ZERO
    for above, r in bands:
        if income > above:
            prev, rate, threshold = rate, r, above
    return rate, threshold, prev


def compute_annual_tax(taxable, regime_table):
    """Annual income tax on ``taxable`` income for one regime table.

    Returns a JSON-safe breakdown: slab rows, slab tax, 87A rebate and marginal
    relief, surcharge (with marginal relief at each threshold), cess, total
    (rounded to the rupee) and effective rate."""
    t = regime_table or {}
    slabs = t.get('slabs') or []
    inc = _r0(max(ZERO, _dec(taxable)))
    slab_tax, rows = _slab_tax(inc, slabs)

    rebate, relief = ZERO, ZERO
    limit, rmax = _dec(t.get('rebate_limit')), _dec(t.get('rebate_max'))
    if limit > 0 and inc <= limit:
        rebate = min(slab_tax, rmax)
    elif limit > 0 and t.get('rebate_marginal_relief'):
        excess = inc - limit
        if slab_tax > excess:                     # tax may not exceed income above the rebate limit
            relief = slab_tax - excess
    after = max(ZERO, slab_tax - rebate - relief)

    rate, threshold, prev = _surcharge_band(inc, t.get('surcharge'))
    surcharge, sur_relief = after * rate / 100, ZERO
    if rate > 0:
        tax_t, _ = _slab_tax(threshold, slabs)
        cap = tax_t * (1 + prev / 100) + (inc - threshold)
        if after + surcharge > cap:
            sur_relief = min(surcharge, after + surcharge - cap)
            surcharge -= sur_relief
    cess_pct = _dec(t.get('cess_pct'))
    cess = (after + surcharge) * cess_pct / 100
    total = _r0(after + surcharge + cess)
    return {
        'taxable': _f(inc), 'slabs': rows, 'slab_tax': _f(slab_tax), 'rebate_87a': _f(rebate),
        'marginal_relief_87a': _f(relief), 'tax_after_rebate': _f(after), 'surcharge_rate': float(rate),
        'surcharge': _f(surcharge), 'surcharge_relief': _f(sur_relief), 'cess_pct': float(cess_pct),
        'cess': _f(cess), 'total': float(total),
        'effective_rate': float(round(total * 100 / inc, 2)) if inc > 0 else 0.0,
    }


# ── declarations → deduction amounts ──────────────────────────────────────
def uses_verified(decl):
    return bool(decl) and decl.status in ('verified', 'locked')


def declared_amounts(decl):
    """Amounts that count for tax: verified once verified/locked, else declared."""
    out = {'80C': ZERO, '80CCD1B': ZERO, '80D': ZERO, '80D_parents': ZERO, '24b': ZERO,
           'senior_self': False, 'senior_parents': False, 'monthly_rent': ZERO, 'metro': False}
    if not decl:
        return out
    ver = uses_verified(decl)
    for it in decl.items or []:
        sec_code = it.get('section')
        if sec_code not in SECTIONS:
            continue
        amt = it.get('verified') if ver else it.get('declared')
        out[sec_code] += max(ZERO, _dec(amt))
        if sec_code == '80D' and it.get('senior'):
            out['senior_self'] = True
        if sec_code == '80D_parents' and it.get('senior'):
            out['senior_parents'] = True
    hra = decl.hra or {}
    rent = hra.get('verified_monthly_rent') if ver else hra.get('monthly_rent')
    out['monthly_rent'] = max(ZERO, _dec(rent))
    out['metro'] = bool(hra.get('metro'))
    return out


def income_breakdown(annual, regime, table, decl=None, months=12):
    """Gross → taxable for one regime. ``annual`` = {gross, basic, hra, pf, pt}."""
    gross = max(ZERO, _dec(annual.get('gross')))
    basic, hra_recv = max(ZERO, _dec(annual.get('basic'))), max(ZERO, _dec(annual.get('hra')))
    pf, pt = max(ZERO, _dec(annual.get('pf'))), max(ZERO, _dec(annual.get('pt')))
    std = min(gross, _dec(table.get('standard_deduction')))
    ded = {'80C': ZERO, '80CCD1B': ZERO, '80D': ZERO, '24b': ZERO}
    hra_ex, pt_ded, rent_annual = ZERO, ZERO, ZERO
    if regime == 'old':
        lim = table.get('section_limits') or {}
        a = declared_amounts(decl)
        pt_ded = min(pt, PT_CAP)
        ded['80C'] = min(_dec(lim.get('80C')), a['80C'] + pf)
        ded['80CCD1B'] = min(_dec(lim.get('80CCD1B')), a['80CCD1B'])
        self_lim = _dec(lim.get('80D_senior' if a['senior_self'] else '80D'))
        par_lim = _dec(lim.get('80D_senior' if a['senior_parents'] else '80D'))
        ded['80D'] = min(self_lim, a['80D']) + min(par_lim, a['80D_parents'])
        ded['24b'] = min(_dec(lim.get('24b')), a['24b'])
        rent_annual = a['monthly_rent'] * max(1, min(12, int(months or 12)))
        if rent_annual > 0 and hra_recv > 0:
            pct = Decimal('0.5') if a['metro'] else Decimal('0.4')
            hra_ex = max(ZERO, min(hra_recv, rent_annual - basic / 10, basic * pct))
    total_ded = std + pt_ded + hra_ex + sum(ded.values())
    taxable = _r0(max(ZERO, gross - total_ded))
    return {
        'regime': regime, 'gross': _f(gross), 'standard_deduction': _f(std), 'professional_tax': _f(pt_ded),
        'hra_exemption': _f(hra_ex), 'rent_annual': _f(rent_annual), 'employee_pf': _f(pf),
        'deductions': {k: _f(v) for k, v in ded.items()}, 'total_deductions': _f(total_ded),
        'taxable': float(taxable),
    }


# ── payslip line helpers ─────────────────────────────────────────────────
def _sum(lines, pred):
    tot = ZERO
    for l in lines or []:
        code = str(l.get('code') or '').upper()
        if pred(code):
            tot += _dec(l.get('amount'))
    return tot


def month_parts(earnings, deductions):
    """Taxable pieces of one month's lines."""
    taxable = _sum(earnings, lambda c: c not in NON_TAXABLE_CODES)
    one_off = _sum(earnings, lambda c: c not in NON_TAXABLE_CODES and (c.startswith('ADJ_') or c in ONE_OFF_CODES))
    lop = _sum(deductions, lambda c: c in LOP_CODES)
    return {
        'recurring': taxable - one_off, 'one_off': one_off - lop, 'taxable': taxable - lop,
        'basic': _sum(earnings, lambda c: c in BASIC_CODES), 'hra': _sum(earnings, lambda c: c in HRA_CODES),
        'pf': _sum(deductions, lambda c: c == 'PF'), 'pt': _sum(deductions, lambda c: c in PT_CODES),
        'tds': _sum(deductions, lambda c: c == 'TDS'),
    }


def fy_actuals(email, fy, before=None, exclude_run_id=None):
    """Sums over the employee's payslips in the FY (run not cancelled); with
    ``before`` only runs starting before that date."""
    from ..models import Payslip
    start, end = fy_bounds(fy)
    qs = Payslip.objects.filter(email__iexact=email, run__period_start__gte=start, run__period_start__lte=end) \
        .exclude(run__status='cancelled').select_related('run')
    if before is not None:
        qs = qs.filter(run__period_start__lt=before)
    if exclude_run_id:
        qs = qs.exclude(run_id=exclude_run_id)
    tot = {k: ZERO for k in ('taxable', 'basic', 'hra', 'pf', 'pt', 'tds')}
    months, quarters = set(), {1: ZERO, 2: ZERO, 3: ZERO, 4: ZERO}
    first = last = None
    for p in qs:
        parts = month_parts(p.earnings_data, p.deductions_data)
        for k in tot:
            tot[k] += parts[k]
        ps = p.run.period_start
        months.add((ps.year, ps.month))
        quarters[quarter_of(ps)] += parts['tds']
        first = ps if first is None or ps < first else first
        pe = p.run.period_end
        last = pe if last is None or pe > last else last
    tot['months'] = len(months)
    tot['quarter_tds'] = quarters
    tot['first'], tot['last'] = first, last
    return tot


def quarter_of(d):
    return {4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 3, 1: 4, 2: 4, 3: 4}[d.month]


def get_declaration(email, fy):
    from ..models import EmployeeTaxDeclaration
    return EmployeeTaxDeclaration.objects.filter(email__iexact=email, fy=fy).first()


def project(result, email, period_start, exclude_run_id=None, decl=None):
    """Annual projection for one month's pay ``result`` (both regimes)."""
    period_start = _as_date(period_start)
    fy = fy_of(period_start)
    n = months_left(period_start)
    cur = month_parts(result.get('earnings_data'), result.get('deductions_data'))
    prior = fy_actuals(email, fy, before=period_start, exclude_run_id=exclude_run_id)
    annual = {
        'gross': prior['taxable'] + cur['recurring'] * n + cur['one_off'],
        'basic': prior['basic'] + cur['basic'] * n, 'hra': prior['hra'] + cur['hra'] * n,
        'pf': prior['pf'] + cur['pf'] * n, 'pt': prior['pt'] + cur['pt'] * n,
    }
    if decl is None:
        decl = get_declaration(email, fy)
    chosen = decl.regime if decl and decl.regime in KINDS else 'new'
    months = prior['months'] + n
    regimes = {}
    for reg in ('new', 'old'):
        table = get_table(fy, reg)
        inc = income_breakdown(annual, reg, table, decl, months=months)
        tax = compute_annual_tax(inc['taxable'], table)
        remaining = max(ZERO, _dec(tax['total']) - prior['tds'])
        regimes[reg] = {'income': inc, 'tax': tax, 'monthly_tds': float(_r0(remaining / n))}
    return {
        'fy': fy, 'months_left': n, 'regime': chosen,
        'declaration_status': decl.status if decl else 'none',
        'uses_verified': uses_verified(decl),
        'this_month': {k: _f(v) for k, v in cur.items()},
        'prior': dict({k: _f(prior[k]) for k in ('taxable', 'basic', 'hra', 'pf', 'pt', 'tds')},
                      months=prior['months']),
        'annual': {k: _f(v) for k, v in annual.items()},
        'tds_paid': _f(prior['tds']), 'regimes': regimes,
        'tds_this_month': regimes[chosen]['monthly_tds'],
    }


def _fix_totals(result):
    """``recompute`` plus: the core service's employer contribution excludes the
    informational GROSS_EARNING row of employer_contributions_data, so CTC is not
    double-counted."""
    recompute(result)
    employer = sum((D(e.get('amount')) for e in (result.get('employer_contributions_data') or [])
                    if str(e.get('code')).upper() != 'GROSS_EARNING'), D(0))
    result['employer_contribution'] = float(employer)
    result['total_ctc'] = float(D(result.get('gross_earnings')) + employer)
    return result


def apply_tds(result, ctx):
    """Calculation hook: replace the TDS deduction with the regime-based monthly TDS."""
    try:
        if str(result.get('currency') or 'INR').upper() != 'INR':
            return result
        email = (ctx.get('email') or result.get('email') or '').lower()
        start = ctx.get('start')
        if not email or not start:
            return result
        proj = project(result, email, start, exclude_run_id=ctx.get('run_id'))
        set_line(result, 'deductions_data', 'TDS', 'TDS / Income Tax', proj['tds_this_month'])
        _fix_totals(result)
    except Exception:
        logger.exception('india_tax.apply_tds failed for %s', ctx.get('email'))
    return result


# ── regime lock / window ──────────────────────────────────────────────────
def regime_lock(email, fy, decl=None):
    """(locked, reason)."""
    from ..models import PayrollEntry
    if decl is None:
        decl = get_declaration(email, fy)
    if decl and (decl.regime_locked or decl.status == 'locked'):
        return True, 'Locked by HR for this financial year.'
    start, end = fy_bounds(fy)
    if PayrollEntry.objects.filter(email__iexact=email, run__period_start__gte=start, run__period_start__lte=end,
                                   run__status__in=('approved', 'paid')).exists():
        return True, 'A payroll for this financial year has already been finalised on this regime.'
    return False, ''


def _setting(key, default):
    from ..models import PayrollSetting
    row = PayrollSetting.objects.filter(key=key).first()
    return (row.value or '').strip() if row and (row.value or '').strip() else default


def _valid_mmdd(v):
    try:
        datetime.strptime('2000-' + str(v), '%Y-%m-%d')
        return bool(re.match(r'^\d{2}-\d{2}$', str(v)))
    except ValueError:
        return False


def proof_window():
    start = _setting('tax_proof_window_start', DEFAULT_WINDOW[0])
    end = _setting('tax_proof_window_end', DEFAULT_WINDOW[1])
    if not _valid_mmdd(start):
        start = DEFAULT_WINDOW[0]
    if not _valid_mmdd(end):
        end = DEFAULT_WINDOW[1]
    today = _today().strftime('%m-%d')
    is_open = (start <= today <= end) if start <= end else (today >= start or today <= end)
    return {'start': start, 'end': end, 'open': is_open, 'current_fy': fy_of(_today())}


# ── input validation helpers ──────────────────────────────────────────────
def _body(request, allowed, required=()):
    data = request.data
    if not isinstance(data, dict):
        raise Bad('Send a JSON object.')
    unknown = sorted(set(data.keys()) - set(allowed))
    if unknown:
        raise Bad('Unknown field(s): ' + ', '.join(str(u)[:40] for u in unknown[:5]))
    for r in required:
        if r not in data:
            raise Bad(f'{r} is required.')
    return data


def _amount(v, field, lo=ZERO, hi=MAX_AMOUNT, allow_none=False):
    if v is None and allow_none:
        return None
    if isinstance(v, bool) or v is None or (isinstance(v, str) and not v.strip()):
        raise Bad(f'{field} must be a number.')
    try:
        d = Decimal(str(v).strip())
    except (InvalidOperation, ValueError):
        raise Bad(f'{field} must be a number.')
    if not d.is_finite() or d < lo or d > hi:
        raise Bad(f'{field} must be between {lo} and {hi}.')
    return d.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def _text(v, field, maxlen):
    if v is None:
        return ''
    if not isinstance(v, str):
        raise Bad(f'{field} must be text.')
    v = re.sub(r'[\x00-\x1f\x7f]', ' ', v).strip()
    if len(v) > maxlen:
        raise Bad(f'{field} is too long (max {maxlen} characters).')
    return v


def _bool(v, field):
    if v in (None, ''):
        return False
    if not isinstance(v, bool):
        raise Bad(f'{field} must be true or false.')
    return v


def _err(e, status=400):
    return Response({'message': str(e)}, status=status)


# ── serializers ───────────────────────────────────────────────────────────
def _iso(v):
    return v.isoformat() if v else None


def _name(email):
    from ..models import AppUser
    u = AppUser.objects.filter(email__iexact=email).first()
    return sec.display_name(u, email)


def proof_meta(p):
    return {'id': p.id, 'item_id': p.item_id, 'section': p.section, 'file_name': p.file_name,
            'mime': p.file_mime, 'size': p.file_size, 'sha256': p.sha256, 'status': p.status,
            'note': p.reviewer_note, 'uploaded_at': _iso(p.uploaded_at)}


def _hra_view(decl):
    h = (decl.hra if decl else None) or {}
    rent = _dec(h.get('monthly_rent'))
    return {'monthly_rent': _f(rent), 'metro': bool(h.get('metro')), 'landlord_name': h.get('landlord_name', ''),
            'landlord_pan': h.get('landlord_pan_masked', ''), 'has_landlord_pan': bool(decl and decl.landlord_pan_enc),
            'verified_monthly_rent': h.get('verified_monthly_rent'),
            'pan_required': rent * 12 > Decimal('100000')}


def decl_payload(decl, email, fy, with_proofs=True):
    locked, reason = regime_lock(email, fy, decl)
    out = {
        'id': decl.id if decl else None, 'email': email, 'employee_name': _name(email), 'fy': fy,
        'regime': (decl.regime if decl else 'new'), 'regime_locked': locked, 'regime_lock_reason': reason,
        'status': decl.status if decl else 'draft', 'items': list(decl.items or []) if decl else [],
        'hra': _hra_view(decl), 'submitted_at': _iso(decl.submitted_at) if decl else None,
        'verified_by': decl.verified_by if decl else '', 'verified_at': _iso(decl.verified_at) if decl else None,
        'reviewer_note': decl.reviewer_note if decl else '', 'updated_at': _iso(decl.updated_at) if decl else None,
    }
    if with_proofs:
        out['proofs'] = [proof_meta(p) for p in decl.proofs.all()] if decl else []
    return out


def _sections_payload(fy):
    lim = get_table(fy, 'old')['section_limits']
    return [{'code': k, 'label': v['label'], 'limit': lim.get(v['limit_key']),
             'senior_limit': lim.get('80D_senior') if k.startswith('80D') else None} for k, v in SECTIONS.items()]


def _my_payload(email, fy, decl):
    win = proof_window()
    out = decl_payload(decl, email, fy)
    locked_decl = bool(decl and decl.status == 'locked')
    out.update({
        'window': win, 'sections': _sections_payload(fy),
        'can_edit': not locked_decl,
        'can_upload': (not locked_decl) and win['open'] and fy == win['current_fy'],
    })
    return out


# ── declaration editing ───────────────────────────────────────────────────
_ITEM_FIELDS = {'id', 'section', 'description', 'declared', 'senior', 'verified'}
_ID_RE = re.compile(r'^[a-z0-9]{1,16}$')


def _apply_items(decl, raw_items):
    if not isinstance(raw_items, list):
        raise Bad('items must be a list.')
    if len(raw_items) > MAX_ITEMS:
        raise Bad(f'At most {MAX_ITEMS} items can be declared.')
    old = {str(it.get('id')): it for it in (decl.items or [])}
    out, seen = [], set()
    for i, raw in enumerate(raw_items, 1):
        if not isinstance(raw, dict):
            raise Bad(f'Item {i} must be an object.')
        unknown = set(raw.keys()) - _ITEM_FIELDS
        if unknown:
            raise Bad(f'Item {i}: unknown field(s) ' + ', '.join(sorted(str(u)[:30] for u in unknown)[:5]))
        section = raw.get('section')
        if section not in SECTIONS:
            raise Bad(f'Item {i}: unknown section.')
        declared = _amount(raw.get('declared'), f'Item {i} amount')
        desc = _text(raw.get('description'), f'Item {i} description', 120)
        senior = _bool(raw.get('senior'), f'Item {i} senior') if section.startswith('80D') else False
        iid = str(raw.get('id') or '')
        prev = old.get(iid) if _ID_RE.match(iid) else None
        if prev is None or iid in seen:
            iid = secrets.token_hex(4)
            prev = None
        seen.add(iid)
        keep_verified = prev is not None and prev.get('section') == section and \
            _dec(prev.get('declared')) == declared and prev.get('verified') is not None
        out.append({'id': iid, 'section': section, 'description': desc, 'declared': float(declared),
                    'senior': senior, 'verified': prev.get('verified') if keep_verified else None})
    decl.items = out


_HRA_FIELDS = {'monthly_rent', 'metro', 'landlord_name', 'landlord_pan', 'has_landlord_pan', 'pan_required',
               'verified_monthly_rent'}


def _apply_hra(decl, raw):
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise Bad('hra must be an object.')
    unknown = set(raw.keys()) - _HRA_FIELDS
    if unknown:
        raise Bad('hra: unknown field(s) ' + ', '.join(sorted(str(u)[:30] for u in unknown)[:5]))
    rent = _amount(raw.get('monthly_rent') or 0, 'Monthly rent', hi=Decimal('2000000'))
    prev = decl.hra or {}
    if rent == 0:
        decl.hra, decl.landlord_pan_enc = {}, ''
        return
    metro = _bool(raw.get('metro'), 'Metro')
    name = _text(raw.get('landlord_name'), 'Landlord name', 120)
    pan_in = raw.get('landlord_pan')
    if pan_in is not None and not isinstance(pan_in, str):
        raise Bad('Landlord PAN must be text.')
    pan_in = (pan_in or '').strip().upper()
    new_hra = {'monthly_rent': float(rent), 'metro': metro, 'landlord_name': name,
               'landlord_pan_masked': prev.get('landlord_pan_masked', '')}
    if pan_in and '•' not in pan_in:
        if not sec.is_valid_pan(pan_in):
            raise Bad('Landlord PAN is not valid (format: AAAAA9999A).')
        try:
            decl.landlord_pan_enc = sec.seal(pan_in)
        except Exception:
            logger.exception('could not encrypt landlord PAN')
            raise Bad('Encryption is not configured on the server; the PAN could not be stored safely.')
        new_hra['landlord_pan_masked'] = sec.mask_pan(pan_in)
    if rent * 12 > Decimal('100000') and not decl.landlord_pan_enc:
        raise Bad("Landlord PAN is required when annual rent exceeds ₹1,00,000.")
    if not name:
        raise Bad('Landlord name is required when you declare rent.')
    same = _dec(prev.get('monthly_rent')) == rent and bool(prev.get('metro')) == metro
    if same and prev.get('verified_monthly_rent') is not None:
        new_hra['verified_monthly_rent'] = prev.get('verified_monthly_rent')
    decl.hra = new_hra


def _summary(decl):
    """Audit-safe summary (no PAN)."""
    totals = {}
    for it in decl.items or []:
        totals[it.get('section')] = totals.get(it.get('section'), 0) + float(it.get('declared') or 0)
    return {'items': len(decl.items or []), 'declared_by_section': totals,
            'monthly_rent': (decl.hra or {}).get('monthly_rent', 0),
            'landlord_pan': (decl.hra or {}).get('landlord_pan_masked', '')}


def _get_or_create_locked(email, fy):
    from ..models import EmployeeTaxDeclaration
    decl = EmployeeTaxDeclaration.objects.select_for_update().filter(email=email, fy=fy).first()
    if decl is None:
        try:
            with transaction.atomic():
                decl = EmployeeTaxDeclaration.objects.create(email=email, fy=fy)
        except IntegrityError:
            decl = EmployeeTaxDeclaration.objects.select_for_update().get(email=email, fy=fy)
    return decl


# ── employee endpoints ────────────────────────────────────────────────────
@api_view(['GET', 'PUT'])
def my_declaration(request):
    email, user, err = sec.require(request, None)
    if err:
        return err
    try:
        if request.method == 'GET':
            fy = _fy_param(request.query_params.get('fy'))
            return Response(_my_payload(email, fy, get_declaration(email, fy)))
        data = _body(request, {'fy', 'items', 'hra'}, required=('fy',))
        fy = _fy_param(data.get('fy'), default_today=False)
        with transaction.atomic():
            decl = _get_or_create_locked(email, fy)
            if decl.status == 'locked':
                return _err('This declaration is locked by HR and can no longer be changed.', 409)
            if 'items' in data:
                _apply_items(decl, data.get('items'))
            if 'hra' in data:
                _apply_hra(decl, data.get('hra'))
            if decl.status in ('submitted', 'verified', 'rejected'):
                decl.status = 'draft'
            decl.updated_at = timezone.now()
            decl.save()
        sec.audit('tax_declaration_saved', 'EmployeeTaxDeclaration', decl.id, request, email,
                  sec.display_name(user, email), changes=_summary(decl))
        return Response(_my_payload(email, fy, decl))
    except Bad as e:
        return _err(e)


@api_view(['POST'])
def my_regime(request):
    email, user, err = sec.require(request, None)
    if err:
        return err
    try:
        data = _body(request, {'fy', 'regime'}, required=('fy', 'regime'))
        fy = _fy_param(data.get('fy'), default_today=False)
        regime = data.get('regime')
        if regime not in KINDS:
            raise Bad("regime must be 'new' or 'old'.")
        with transaction.atomic():
            decl = _get_or_create_locked(email, fy)
            locked, reason = regime_lock(email, fy, decl)
            if locked and decl.regime != regime:
                return _err('Your tax regime for this year can no longer be changed. ' + reason, 409)
            before = decl.regime
            decl.regime = regime
            decl.updated_at = timezone.now()
            decl.save()
        if before != regime:
            sec.audit('tax_regime_changed', 'EmployeeTaxDeclaration', decl.id, request, email,
                      sec.display_name(user, email), changes={'fy': fy, 'from': before, 'to': regime})
        return Response(_my_payload(email, fy, decl))
    except Bad as e:
        return _err(e)


@api_view(['POST'])
def my_submit(request):
    email, user, err = sec.require(request, None)
    if err:
        return err
    try:
        data = _body(request, {'fy'}, required=('fy',))
        fy = _fy_param(data.get('fy'), default_today=False)
        with transaction.atomic():
            decl = _get_or_create_locked(email, fy)
            if decl.status not in ('draft', 'rejected'):
                return _err(f'This declaration is already {decl.status}.', 409)
            rent = _dec((decl.hra or {}).get('monthly_rent'))
            if rent * 12 > Decimal('100000') and not decl.landlord_pan_enc:
                raise Bad("Landlord PAN is required when annual rent exceeds ₹1,00,000.")
            decl.status = 'submitted'
            decl.submitted_at = timezone.now()
            decl.updated_at = timezone.now()
            decl.save()
        sec.audit('tax_declaration_submitted', 'EmployeeTaxDeclaration', decl.id, request, email,
                  sec.display_name(user, email), changes=_summary(decl))
        return Response(_my_payload(email, fy, decl))
    except Bad as e:
        return _err(e)


def _safe_name(v):
    v = os.path.basename(str(v or '').replace('\\', '/'))
    v = re.sub(r'[^A-Za-z0-9._ ()-]', '_', v).strip()[:120]
    return v or 'proof'


@api_view(['POST'])
def my_proofs(request):
    from ..models import TaxProofDocument
    email, user, err = sec.require(request, None)
    if err:
        return err
    try:
        data = _body(request, {'fy', 'item_id', 'file_name', 'mime', 'data'},
                     required=('fy', 'item_id', 'mime', 'data'))
        fy = _fy_param(data.get('fy'), default_today=False)
        win = proof_window()
        if not win['open'] or fy != win['current_fy']:
            return _err(f"Proofs can be submitted only between {win['start']} and {win['end']} (MM-DD) for the "
                        f"current financial year {win['current_fy']}.", 403)
        item_id = str(data.get('item_id') or '')
        with transaction.atomic():
            decl = _get_or_create_locked(email, fy)
            if decl.status in ('locked', 'verified'):
                return _err(f'This declaration is {decl.status}; proofs can no longer be added.', 409)
            if item_id == 'hra':
                if _dec((decl.hra or {}).get('monthly_rent')) <= 0:
                    raise Bad('Declare your rent before uploading rent receipts.')
                section = 'HRA'
            else:
                item = next((it for it in (decl.items or []) if it.get('id') == item_id), None)
                if not item:
                    raise Bad('Save the declared item before uploading its proof.')
                section = item.get('section', '')
            if decl.proofs.count() >= MAX_PROOFS:
                raise Bad(f'At most {MAX_PROOFS} proof files are allowed per year.')
            raw, msg = sec.check_upload(data.get('data'), data.get('mime'), max_mb=PROOF_MAX_MB)
            if raw is None:
                raise Bad(msg)
            import base64
            p = TaxProofDocument.objects.create(
                declaration=decl, item_id=item_id, section=section, file_name=_safe_name(data.get('file_name')),
                file_mime=str(data.get('mime')).lower(), file_size=len(raw), sha256=sec.sha256_hex(raw),
                file_data=base64.b64encode(raw).decode('ascii'), status='pending')
        sec.audit('tax_proof_uploaded', 'TaxProofDocument', p.id, request, email, sec.display_name(user, email),
                  changes={'fy': fy, 'item_id': item_id, 'section': section, 'size': p.file_size, 'sha256': p.sha256})
        return Response(proof_meta(p), status=201)
    except Bad as e:
        return _err(e)


@api_view(['DELETE'])
def my_proof_delete(request, pk):
    from ..models import TaxProofDocument
    email, user, err = sec.require(request, None)
    if err:
        return err
    p = TaxProofDocument.objects.select_related('declaration').filter(pk=pk).first()
    if not p or p.declaration.email.lower() != email:
        return _err('Not found.', 404)
    if p.status != 'pending' or p.declaration.status in ('locked', 'verified'):
        return _err('Only proofs that are still pending review can be removed.', 409)
    p.delete()
    sec.audit('tax_proof_deleted', 'TaxProofDocument', pk, request, email, sec.display_name(user, email))
    return Response({'ok': True})


@api_view(['GET'])
def proof_file(request, pk):
    """Proof download: the owner or a tax verifier only (others get 404)."""
    from ..models import TaxProofDocument
    email, user, err = sec.require(request, None)
    if err:
        return err
    p = TaxProofDocument.objects.select_related('declaration').filter(pk=pk).first()
    if not p:
        return _err('Not found.', 404)
    owner = p.declaration.email.lower() == email
    if not owner and not sec.has_perm(user, PERM_VERIFY):
        return _err('Not found.', 404)
    sec.audit('tax_proof_downloaded', 'TaxProofDocument', p.id, request, email, sec.display_name(user, email),
              changes={'owner': owner})
    return Response({'file_name': p.file_name, 'mime': p.file_mime, 'data': p.file_data, 'sha256': p.sha256})


def _sample_month(fy):
    """A representative month of the FY for estimates."""
    start, end = fy_bounds(fy)
    t = _today()
    d = t if start <= t <= end else (start if t < start else date(end.year, 3, 1))
    return date(d.year, d.month, 1), date(d.year, d.month, monthrange(d.year, d.month)[1])


def estimate_for(email, fy):
    from ..models import EmployeeCompensation
    from ..services.payroll_service import PayrollService
    comp = EmployeeCompensation.objects.filter(email__iexact=email).order_by('-effective_from', '-id').first()
    if not comp:
        return {'available': False, 'reason': 'No salary is set up for this employee yet.'}
    if (comp.currency or 'INR').upper() != 'INR':
        return {'available': False, 'reason': 'Indian income tax applies only to INR salaries.'}
    s, e = _sample_month(fy)
    result = PayrollService.calculate_employee_pay(email, s, e)
    proj = project(result, email, s)
    proj.update({'available': True, 'sample_month': s.strftime('%Y-%m'), 'monthly_gross': result.get('gross_earnings')})
    return proj


@api_view(['GET'])
def my_estimate(request):
    email, user, err = sec.require(request, None)
    if err:
        return err
    try:
        fy = _fy_param(request.query_params.get('fy'))
    except Bad as e:
        return _err(e)
    try:
        return Response(estimate_for(email, fy))
    except Exception:
        logger.exception('tax estimate failed for %s', email)
        return _err('The estimate could not be calculated right now.', 500)


@api_view(['GET'])
def my_forms(request):
    """The employee's own Form 16 (Part B generated, Part A uploaded) — metadata only."""
    from ..models import StatutoryFiling
    email, user, err = sec.require(request, None)
    if err:
        return err
    rows = StatutoryFiling.objects.filter(email__iexact=email, kind__in=('FORM16', 'FORM16A')).order_by('-generated_at')[:50]
    return Response({'results': [{'id': r.id, 'kind': r.kind, 'period': r.period, 'file_name': r.file_name,
                                  'generated_at': _iso(r.generated_at)} for r in rows]})


@api_view(['GET'])
def my_form_file(request, pk):
    from ..models import StatutoryFiling
    email, user, err = sec.require(request, None, fresh=True)
    if err:
        return err
    r = StatutoryFiling.objects.filter(pk=pk, kind__in=('FORM16', 'FORM16A')).first()
    if not r or (r.email or '').lower() != email:
        return _err('Not found.', 404)
    sec.audit('statutory_downloaded', 'StatutoryFiling', r.id, request, email, sec.display_name(user, email),
              changes={'kind': r.kind, 'period': r.period, 'self': True})
    return Response({'file_name': r.file_name, 'mime': r.file_mime, 'content': r.content,
                     'encoding': 'base64' if r.kind == 'FORM16A' else 'text', 'sha256': r.sha256})


# ── HR: tables ────────────────────────────────────────────────────────────
_TABLE_KEYS = {'slabs', 'standard_deduction', 'rebate_limit', 'rebate_max', 'rebate_marginal_relief', 'cess_pct',
               'surcharge', 'section_limits'}
_LIMIT_KEYS = {'80C', '80CCD1B', '80D', '80D_senior', '24b'}
_BIG = Decimal('100000000000')


def _num_out(d):
    return int(d) if d == d.to_integral_value() else float(d)


def validate_table(data):
    if not isinstance(data, dict):
        raise Bad('data must be an object.')
    unknown = set(data.keys()) - _TABLE_KEYS
    if unknown:
        raise Bad('Unknown table field(s): ' + ', '.join(sorted(str(u)[:30] for u in unknown)[:5]))
    missing = _TABLE_KEYS - set(data.keys())
    if missing:
        raise Bad('Missing table field(s): ' + ', '.join(sorted(missing)))
    slabs = data.get('slabs')
    if not isinstance(slabs, list) or not 1 <= len(slabs) <= 15:
        raise Bad('slabs must be a list of 1–15 rows.')
    out_slabs, prev = [], ZERO
    for i, s in enumerate(slabs, 1):
        if not isinstance(s, dict) or set(s.keys()) - {'upto', 'rate'}:
            raise Bad(f'Slab {i} must be {{upto, rate}}.')
        last = i == len(slabs)
        if s.get('upto') is None:
            if not last:
                raise Bad('Only the last slab can be open-ended (upto = null).')
            upto = None
        else:
            if last:
                raise Bad('The last slab must be open-ended (upto = null).')
            upto = _amount(s.get('upto'), f'Slab {i} upto', lo=ONE, hi=_BIG)
            if upto <= prev:
                raise Bad('Slab limits must increase.')
            prev = upto
        rate = _amount(s.get('rate'), f'Slab {i} rate', hi=Decimal('100'))
        out_slabs.append({'upto': None if upto is None else _num_out(upto), 'rate': _num_out(rate)})
    sur = data.get('surcharge')
    if not isinstance(sur, list) or len(sur) > 10:
        raise Bad('surcharge must be a list of at most 10 rows.')
    out_sur, prev = [], ZERO
    for i, s in enumerate(sur, 1):
        if not isinstance(s, dict) or set(s.keys()) - {'above', 'rate'}:
            raise Bad(f'Surcharge row {i} must be {{above, rate}}.')
        above = _amount(s.get('above'), f'Surcharge {i} above', lo=ONE, hi=_BIG)
        if above <= prev:
            raise Bad('Surcharge thresholds must increase.')
        prev = above
        out_sur.append({'above': _num_out(above), 'rate': _num_out(_amount(s.get('rate'), f'Surcharge {i} rate',
                                                                           hi=Decimal('100')))})
    lim = data.get('section_limits')
    if not isinstance(lim, dict) or set(lim.keys()) - _LIMIT_KEYS:
        raise Bad('section_limits may only contain ' + ', '.join(sorted(_LIMIT_KEYS)) + '.')
    out_lim = {k: _num_out(_amount(v, f'Limit {k}', hi=_BIG)) for k, v in lim.items()}
    return {
        'slabs': out_slabs,
        'standard_deduction': _num_out(_amount(data['standard_deduction'], 'Standard deduction', hi=_BIG)),
        'rebate_limit': _num_out(_amount(data['rebate_limit'], 'Rebate limit', hi=_BIG)),
        'rebate_max': _num_out(_amount(data['rebate_max'], 'Rebate max', hi=_BIG)),
        'rebate_marginal_relief': _bool(data.get('rebate_marginal_relief'), 'rebate_marginal_relief'),
        'cess_pct': _num_out(_amount(data['cess_pct'], 'Cess %', hi=Decimal('100'))),
        'surcharge': out_sur, 'section_limits': out_lim,
    }


def _table_payload(row):
    return {'id': row.id, 'kind': row.kind, 'period': row.period, 'data': row.data, 'notes': row.notes,
            'seeded': row.notes == SEED_NOTE, 'updated_by': row.updated_by, 'updated_at': _iso(row.updated_at)}


@api_view(['GET', 'PUT'])
def tax_tables(request):
    from ..models import PayrollTaxTable
    perm = (PERM_MANAGE, PERM_VERIFY) if request.method == 'GET' else PERM_MANAGE
    email, user, err = sec.require(request, perm)
    if err:
        return err
    try:
        if request.method == 'GET':
            fy = _fy_param(request.query_params.get('fy'))
            rows = seed_tax_tables(fy)
            fys = sorted(set(PayrollTaxTable.objects.filter(country='IN').values_list('period', flat=True)) |
                         {fy_of(_today())}, reverse=True)
            return Response({'fy': fy, 'fys': fys, 'can_edit': sec.has_perm(user, PERM_MANAGE),
                             'tables': {k: _table_payload(v) for k, v in rows.items()}})
        body = _body(request, {'fy', 'kind', 'data', 'notes'}, required=('fy', 'kind', 'data'))
        fy = _fy_param(body.get('fy'), default_today=False)
        kind = body.get('kind')
        if kind not in KINDS.values():
            raise Bad("kind must be 'regime_new' or 'regime_old'.")
        clean = validate_table(body.get('data'))
        notes = _text(body.get('notes'), 'Notes', 500)
        with transaction.atomic():
            row = seed_tax_tables(fy)[kind]
            row = PayrollTaxTable.objects.select_for_update().get(pk=row.pk)
            before = row.data
            row.data = clean
            row.notes = notes if notes and notes != SEED_NOTE else f'Edited by {email}'
            row.updated_by = email
            row.updated_at = timezone.now()
            row.save()
        sec.audit('tax_table_updated', 'PayrollTaxTable', row.id, request, email, sec.display_name(user, email),
                  changes={'fy': fy, 'kind': kind, 'before': before, 'after': clean})
        return Response(_table_payload(row))
    except Bad as e:
        return _err(e)


# ── HR: declarations ──────────────────────────────────────────────────────
@api_view(['GET'])
def hr_declarations(request):
    from ..models import EmployeeTaxDeclaration
    email, user, err = sec.require(request, PERM_VERIFY)
    if err:
        return err
    try:
        fy = _fy_param(request.query_params.get('fy'))
    except Bad as e:
        return _err(e)
    status = (request.query_params.get('status') or '').strip()
    q = (request.query_params.get('q') or '').strip()[:80]
    qs = EmployeeTaxDeclaration.objects.filter(fy=fy)
    if status in ('draft', 'submitted', 'verified', 'rejected', 'locked'):
        qs = qs.filter(status=status)
    if q:
        qs = qs.filter(email__icontains=q)
    counts = {}
    for s in EmployeeTaxDeclaration.objects.filter(fy=fy).values_list('status', flat=True):
        counts[s] = counts.get(s, 0) + 1
    rows = []
    for d in qs.order_by('email')[:500]:
        declared = sum(float(it.get('declared') or 0) for it in d.items or [])
        rows.append({'id': d.id, 'email': d.email, 'employee_name': _name(d.email), 'regime': d.regime,
                     'regime_locked': d.regime_locked, 'status': d.status, 'items': len(d.items or []),
                     'declared_total': declared, 'monthly_rent': (d.hra or {}).get('monthly_rent', 0),
                     'proofs': d.proofs.count(), 'pending_proofs': d.proofs.filter(status='pending').count(),
                     'submitted_at': _iso(d.submitted_at), 'updated_at': _iso(d.updated_at)})
    return Response({'fy': fy, 'counts': counts, 'results': rows, 'window': proof_window()})


def _hr_get(pk):
    from ..models import EmployeeTaxDeclaration
    return EmployeeTaxDeclaration.objects.filter(pk=pk).first()


@api_view(['GET'])
def hr_declaration(request, pk):
    email, user, err = sec.require(request, PERM_VERIFY)
    if err:
        return err
    d = _hr_get(pk)
    if not d:
        return _err('Not found.', 404)
    out = decl_payload(d, d.email.lower(), d.fy)
    out['own'] = d.email.lower() == email
    return Response(out)


@api_view(['POST'])
def hr_review(request, pk):
    from ..models import EmployeeTaxDeclaration, TaxProofDocument
    email, user, err = sec.require(request, PERM_VERIFY)
    if err:
        return err
    try:
        data = _body(request, {'items', 'hra_verified_monthly_rent', 'proofs', 'decision', 'note'})
        decision = data.get('decision') or 'save'
        if decision not in ('save', 'verified', 'rejected'):
            raise Bad("decision must be 'save', 'verified' or 'rejected'.")
        note = _text(data.get('note'), 'Note', 1000)
        with transaction.atomic():
            d = EmployeeTaxDeclaration.objects.select_for_update().filter(pk=pk).first()
            if not d:
                return _err('Not found.', 404)
            if d.email.lower() == email:
                return _err('You cannot verify your own tax declaration.', 403)
            if d.status == 'locked':
                return _err('This declaration is locked. Unlock it first.', 409)
            if d.status == 'draft' and decision != 'save':
                return _err('The employee has not submitted this declaration yet.', 409)
            items = [dict(it) for it in (d.items or [])]
            by_id = {it['id']: it for it in items}
            raw_items = data.get('items') or []
            if not isinstance(raw_items, list):
                raise Bad('items must be a list.')
            for r in raw_items:
                if not isinstance(r, dict) or set(r.keys()) - {'id', 'verified'}:
                    raise Bad('Each item must be {id, verified}.')
                it = by_id.get(str(r.get('id')))
                if not it:
                    raise Bad('Unknown item.')
                v = _amount(r.get('verified'), 'Verified amount', allow_none=True)
                if v is not None and v > _dec(it.get('declared')):
                    raise Bad('A verified amount cannot exceed the declared amount.')
                it['verified'] = None if v is None else float(v)
            hra = dict(d.hra or {})
            if 'hra_verified_monthly_rent' in data:
                v = _amount(data.get('hra_verified_monthly_rent'), 'Verified rent', allow_none=True)
                if v is not None and v > _dec(hra.get('monthly_rent')):
                    raise Bad('Verified rent cannot exceed the declared rent.')
                if hra:
                    hra['verified_monthly_rent'] = None if v is None else float(v)
            proof_changes = []
            raw_proofs = data.get('proofs') or []
            if not isinstance(raw_proofs, list):
                raise Bad('proofs must be a list.')
            for r in raw_proofs:
                if not isinstance(r, dict) or set(r.keys()) - {'id', 'status', 'note'}:
                    raise Bad('Each proof must be {id, status, note}.')
                p = TaxProofDocument.objects.filter(pk=r.get('id') if isinstance(r.get('id'), int) else -1,
                                                    declaration=d).first()
                if not p:
                    raise Bad('Unknown proof.')
                st = r.get('status')
                if st not in ('pending', 'accepted', 'rejected'):
                    raise Bad('Proof status must be pending, accepted or rejected.')
                p.status = st
                p.reviewer_note = _text(r.get('note'), 'Proof note', 255)
                p.save(update_fields=['status', 'reviewer_note'])
                proof_changes.append({'id': p.id, 'status': st})
            if decision == 'verified':
                if any(it.get('verified') is None for it in items):
                    raise Bad('Enter a verified amount (0 if not accepted) for every item before verifying.')
                if hra and _dec(hra.get('monthly_rent')) > 0 and hra.get('verified_monthly_rent') is None:
                    raise Bad('Enter the verified monthly rent before verifying.')
            d.items, d.hra = items, hra
            if decision in ('verified', 'rejected'):
                d.status = decision
                d.verified_by, d.verified_at = email, timezone.now()
            if note or decision != 'save':
                d.reviewer_note = note
            d.updated_at = timezone.now()
            d.save()
        sec.audit('tax_declaration_reviewed', 'EmployeeTaxDeclaration', d.id, request, email,
                  sec.display_name(user, email),
                  changes={'employee': d.email, 'fy': d.fy, 'decision': decision, 'proofs': proof_changes,
                           'verified': {it['id']: it.get('verified') for it in items}})
        out = decl_payload(d, d.email.lower(), d.fy)
        out['own'] = False
        return Response(out)
    except Bad as e:
        return _err(e)


@api_view(['POST'])
def hr_lock(request, pk):
    from ..models import EmployeeTaxDeclaration
    email, user, err = sec.require(request, PERM_VERIFY)
    if err:
        return err
    try:
        data = _body(request, {'action'})
        action = data.get('action') or 'lock'
        if action not in ('lock', 'unlock'):
            raise Bad("action must be 'lock' or 'unlock'.")
        with transaction.atomic():
            d = EmployeeTaxDeclaration.objects.select_for_update().filter(pk=pk).first()
            if not d:
                return _err('Not found.', 404)
            if d.email.lower() == email:
                return _err('You cannot lock or unlock your own tax declaration.', 403)
            if action == 'lock':
                if d.status != 'verified':
                    return _err('Only verified declarations can be locked.', 409)
                d.status, d.regime_locked = 'locked', True
            else:
                if d.status != 'locked':
                    return _err('This declaration is not locked.', 409)
                d.status = 'verified'
            d.updated_at = timezone.now()
            d.save()
        sec.audit('tax_declaration_' + ('locked' if action == 'lock' else 'unlocked'), 'EmployeeTaxDeclaration',
                  d.id, request, email, sec.display_name(user, email), changes={'employee': d.email, 'fy': d.fy})
        return Response(decl_payload(d, d.email.lower(), d.fy))
    except Bad as e:
        return _err(e)


@api_view(['POST'])
def hr_lock_verified(request):
    from ..models import EmployeeTaxDeclaration
    email, user, err = sec.require(request, PERM_VERIFY)
    if err:
        return err
    try:
        data = _body(request, {'fy'}, required=('fy',))
        fy = _fy_param(data.get('fy'), default_today=False)
    except Bad as e:
        return _err(e)
    with transaction.atomic():
        ids = list(EmployeeTaxDeclaration.objects.select_for_update().filter(fy=fy, status='verified')
                   .exclude(email__iexact=email).values_list('id', flat=True))
        EmployeeTaxDeclaration.objects.filter(id__in=ids).update(status='locked', regime_locked=True,
                                                                 updated_at=timezone.now())
    sec.audit('tax_declarations_bulk_locked', 'EmployeeTaxDeclaration', fy, request, email,
              sec.display_name(user, email), changes={'fy': fy, 'count': len(ids), 'ids': ids[:500]})
    return Response({'locked': len(ids)})


@api_view(['POST'])
def hr_regime(request, pk):
    from ..models import EmployeeTaxDeclaration
    email, user, err = sec.require(request, PERM_VERIFY)
    if err:
        return err
    try:
        data = _body(request, {'regime', 'regime_locked'})
        with transaction.atomic():
            d = EmployeeTaxDeclaration.objects.select_for_update().filter(pk=pk).first()
            if not d:
                return _err('Not found.', 404)
            if d.email.lower() == email:
                return _err('You cannot change your own regime lock.', 403)
            before = {'regime': d.regime, 'regime_locked': d.regime_locked}
            if 'regime' in data:
                if data['regime'] not in KINDS:
                    raise Bad("regime must be 'new' or 'old'.")
                d.regime = data['regime']
            if 'regime_locked' in data:
                d.regime_locked = _bool(data['regime_locked'], 'regime_locked')
            d.updated_at = timezone.now()
            d.save()
        sec.audit('tax_regime_changed', 'EmployeeTaxDeclaration', d.id, request, email, sec.display_name(user, email),
                  changes={'employee': d.email, 'fy': d.fy, 'before': before,
                           'after': {'regime': d.regime, 'regime_locked': d.regime_locked}, 'by_hr': True})
        return Response(decl_payload(d, d.email.lower(), d.fy))
    except Bad as e:
        return _err(e)


@api_view(['GET', 'PUT'])
def hr_window(request):
    from ..models import PayrollSetting
    email, user, err = sec.require(request, PERM_VERIFY)
    if err:
        return err
    if request.method == 'GET':
        return Response(proof_window())
    try:
        data = _body(request, {'start', 'end'}, required=('start', 'end'))
        start, end = str(data.get('start') or ''), str(data.get('end') or '')
        if not _valid_mmdd(start) or not _valid_mmdd(end):
            raise Bad("Dates must be 'MM-DD', e.g. 01-01 and 02-28.")
    except Bad as e:
        return _err(e)
    before = proof_window()
    for key, val in (('tax_proof_window_start', start), ('tax_proof_window_end', end)):
        PayrollSetting.objects.update_or_create(key=key, defaults={'value': val,
                                                                   'description': 'IT proof window (MM-DD)'})
    sec.audit('tax_proof_window_updated', 'PayrollSetting', 'tax_proof_window', request, email,
              sec.display_name(user, email), changes={'before': [before['start'], before['end']], 'after': [start, end]})
    return Response(proof_window())


@api_view(['GET'])
def hr_employees(request):
    from ..models import EmployeeCompensation
    email, user, err = sec.require(request, (PERM_VERIFY, PERM_MANAGE))
    if err:
        return err
    seen, out = set(), []
    for c in EmployeeCompensation.objects.filter(status='active').order_by('email'):
        e = (c.email or '').strip().lower()
        if e and e not in seen and (c.currency or 'INR').upper() == 'INR':
            seen.add(e)
            out.append({'email': e, 'name': _name(e)})
    return Response({'results': out[:2000]})


@api_view(['GET'])
def hr_preview(request):
    email, user, err = sec.require(request, (PERM_VERIFY, PERM_MANAGE))
    if err:
        return err
    target = (request.query_params.get('email') or '').strip().lower()
    if not target or len(target) > 255 or '@' not in target:
        return _err('Pick an employee.')
    try:
        fy = _fy_param(request.query_params.get('fy'))
    except Bad as e:
        return _err(e)
    try:
        out = estimate_for(target, fy)
    except Exception:
        logger.exception('tax preview failed for %s', target)
        return _err('The preview could not be calculated.', 500)
    out['email'], out['employee_name'] = target, _name(target)
    return Response(out)
