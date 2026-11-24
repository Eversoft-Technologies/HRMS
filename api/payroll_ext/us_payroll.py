"""US payroll: W-4, federal / state withholding, FICA, FUTA / SUTA, pay
calendars, W-2 and 1099-NEC.

Calculation hook
----------------
``apply_us(result, ctx)`` runs at the end of ``PayrollService.calculate_employee_pay``
(see api/payroll_ext/__init__.py). It only touches US employees (result
currency USD, or an active EmployeeCompensation in USD) and sets:

  deductions_data              FIT, SIT, SOCSEC, MEDICARE
  employer_contributions_data  ER_SOCSEC, ER_MEDICARE, FUTA, SUTA

FIT follows IRS Pub 15-T "Percentage Method Tables for Automated Payroll
Systems and Withholding on Periodic Payments" (Worksheet 1A, Form W-4 from
2020 or later). Every number used comes from the editable ``PayrollTaxTable``
rows (country='US', period='YYYY'); the seeded rows are defaults that must
be verified against the current IRS / state publications.

Rates in the tables are PERCENT values (6.2 means 6.2 %).

Security
--------
* SSN / TIN are stored only encrypted (``security.seal``) plus the last 4
  digits. Nothing in this module ever decrypts them: every response, form and
  CSV shows the masked value ``***-**-1234`` (truncated TINs are permitted on
  employee / recipient copies). They are never logged or put in audit rows.
* Every endpoint goes through ``security.require``; writes, form generation
  and downloads demand a fresh sign-in.
"""
import copy
import csv
import hashlib
import html
import io
import json
import logging
import re
from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from django.db import transaction
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import D, line_amount, recompute, set_line, taxable_earnings
from . import security

logger = logging.getLogger(__name__)

MANAGE = 'payroll.us.manage'
FILINGS = ('payroll.us.manage', 'payroll.statutory')
VERIFY_NOTE = 'Seeded defaults — verify against current IRS/state publications'

FILING_STATUSES = ('single', 'married_jointly', 'head_of_household')
STATUS_LABELS = {'single': 'Single or Married filing separately', 'married_jointly': 'Married filing jointly',
                 'head_of_household': 'Head of household'}
PERIODS = {'weekly': 52, 'biweekly': 26, 'semimonthly': 24, 'monthly': 12}
FREQ_LABELS = {'weekly': 'Weekly', 'biweekly': 'Bi-weekly', 'semimonthly': 'Semi-monthly', 'monthly': 'Monthly'}
US_STATES = (
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
    'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
    'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
)
TABLE_KINDS = ('federal', 'fica', 'futa', 'state', 'suta')
# Indian statutory lines that make no sense on a US payslip (an employee put
# on an India salary structure but paid in USD). Disable with the payroll
# setting us_strip_india_statutory = 0.
INDIA_DEDUCTIONS = {'PF', 'EPF', 'ESI', 'PROFESSIONAL_TAX', 'PT', 'TDS', 'LWF'}
INDIA_EMPLOYER = {'EMPLOYER_PF', 'EMPLOYER_ESI'}
US_DEDUCTION_CODES = ('FIT', 'SIT', 'SOCSEC', 'MEDICARE')
US_EMPLOYER_CODES = ('ER_SOCSEC', 'ER_MEDICARE', 'FUTA', 'SUTA')
ZERO = Decimal('0')
CENT = Decimal('0.01')


# ═════════════════════════════════════════════════════════════════════════
# Settings
# ═════════════════════════════════════════════════════════════════════════
def today():
    """Business-local date (works with USE_TZ on or off)."""
    from django.conf import settings as dj
    return timezone.localdate() if getattr(dj, 'USE_TZ', False) else date.today()


def get_setting(key, default=''):
    from ..models import PayrollSetting
    try:
        row = PayrollSetting.objects.filter(key=key).first()
    except Exception:
        return default
    return row.value if row and row.value not in (None, '') else default


def set_setting(key, value, description=''):
    from ..models import PayrollSetting
    row, _ = PayrollSetting.objects.get_or_create(key=key, defaults={'description': description[:255]})
    row.value = str(value)
    if description and not row.description:
        row.description = description[:255]
    row.save()
    return row


EMPLOYER_KEYS = {
    'employerName': ('us_employer_name', 'US employer legal name (W-2 box c / 1099 payer)'),
    'employerEin': ('us_employer_ein', 'US employer EIN (W-2 box b / 1099 payer TIN)'),
    'employerAddress': ('us_employer_address', 'US employer address'),
    'stateIds': ('us_employer_state_ids', 'JSON {state: employer state ID} for W-2 box 15'),
    'biweeklyAnchor': ('us_biweekly_anchor', 'Start date of any bi-weekly pay period (YYYY-MM-DD)'),
    'weeklyAnchor': ('us_weekly_anchor', 'Start date of any weekly pay period (YYYY-MM-DD)'),
    'payLagDays': ('us_pay_lag_days', 'Days between period end and pay date'),
    'stripIndiaStatutory': ('us_strip_india_statutory', 'Remove PF/ESI/PT/TDS lines from USD payslips (1/0)'),
    'threshold1099': ('us_1099_threshold', 'Override of the 1099-NEC reporting threshold (USD)'),
}


def _default_anchor(year=None):
    """First Monday of the year."""
    d = date(year or today().year, 1, 1)
    return d + timedelta(days=(7 - d.weekday()) % 7)


def employer_info():
    try:
        state_ids = json.loads(get_setting('us_employer_state_ids', '{}') or '{}')
        if not isinstance(state_ids, dict):
            state_ids = {}
    except ValueError:
        state_ids = {}
    return {
        'employerName': get_setting('us_employer_name', ''),
        'employerEin': get_setting('us_employer_ein', ''),
        'employerAddress': get_setting('us_employer_address', ''),
        'stateIds': {str(k)[:2].upper(): str(v)[:30] for k, v in state_ids.items()},
        'biweeklyAnchor': get_setting('us_biweekly_anchor', _default_anchor().isoformat()),
        'weeklyAnchor': get_setting('us_weekly_anchor', _default_anchor().isoformat()),
        'payLagDays': int(_safe_int(get_setting('us_pay_lag_days', '0'), 0)),
        'stripIndiaStatutory': get_setting('us_strip_india_statutory', '1') != '0',
        'threshold1099': get_setting('us_1099_threshold', ''),
    }


def _safe_int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


# ═════════════════════════════════════════════════════════════════════════
# Validation / masking
# ═════════════════════════════════════════════════════════════════════════
class Invalid(ValueError):
    pass


def normalize_ssn(value):
    """9 digits or None. Accepts 123-45-6789 / 123 45 6789 / 123456789."""
    s = str(value or '').strip()
    if not re.fullmatch(r'\d{3}[- ]?\d{2}[- ]?\d{4}', s):
        return None
    digits = re.sub(r'\D', '', s)
    area, group, serial = digits[:3], digits[3:5], digits[5:]
    if area in ('000', '666') or area[0] == '9' or group == '00' or serial == '0000':
        return None
    return digits


def is_valid_ssn(value):
    return normalize_ssn(value) is not None


_BAD_EIN_PREFIX = {'00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97'}


def normalize_ein(value):
    s = str(value or '').strip()
    if not re.fullmatch(r'\d{2}-?\d{7}', s):
        return None
    digits = s.replace('-', '')
    if digits[:2] in _BAD_EIN_PREFIX:
        return None
    return digits


def mask_tin(last4):
    last4 = re.sub(r'\D', '', str(last4 or ''))[-4:]
    return f'***-**-{last4}' if len(last4) == 4 else ''


def _dec(v, field, lo=ZERO, hi=Decimal('100000000'), places=2):
    if isinstance(v, bool):
        raise Invalid(f'{field} must be a number.')
    if v is None or v == '':
        v = 0
    try:
        d = Decimal(str(v).strip().replace(',', ''))
    except (InvalidOperation, ValueError):
        raise Invalid(f'{field} must be a number.')
    if not d.is_finite():
        raise Invalid(f'{field} must be a number.')
    if d < Decimal(lo) or d > Decimal(hi):
        raise Invalid(f'{field} must be between {lo} and {hi}.')
    return d.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)


def _bool(v, field):
    if isinstance(v, bool):
        return v
    if v in (0, 1, '0', '1', 'true', 'false'):
        return v in (1, '1', 'true')
    raise Invalid(f'{field} must be true or false.')


def _int(v, field, lo, hi):
    if isinstance(v, bool):
        raise Invalid(f'{field} must be a whole number.')
    try:
        i = int(str(v if v not in (None, '') else 0).strip())
    except ValueError:
        raise Invalid(f'{field} must be a whole number.')
    if i < lo or i > hi:
        raise Invalid(f'{field} must be between {lo} and {hi}.')
    return i


def _date(v, field):
    try:
        return date.fromisoformat(str(v or '').strip()[:10])
    except ValueError:
        raise Invalid(f'{field} must be a date (YYYY-MM-DD).')


def _year(v, default=None):
    cur = today().year
    if v in (None, ''):
        return default or cur
    y = _int(v, 'year', 2020, cur + 1)
    return y


_EMAIL_RE = re.compile(r'^[^@\s<>"\']{1,120}@[^@\s<>"\']{1,120}$')


def _email(v, field='email', required=True):
    s = str(v or '').strip().lower()
    if not s and not required:
        return ''
    if not _EMAIL_RE.match(s) or len(s) > 255:
        raise Invalid(f'{field} is not a valid email address.')
    return s


def _text(v, field, max_len, required=False):
    s = str(v or '').strip()
    if required and not s:
        raise Invalid(f'{field} is required.')
    if len(s) > max_len:
        raise Invalid(f'{field} must be at most {max_len} characters.')
    return s


def _body(request):
    data = getattr(request, 'data', None)
    return data if isinstance(data, dict) else {}


def _bad(msg, status=400):
    return Response({'message': str(msg)}, status=status)


def _f(d):
    return float(D(d))


# ═════════════════════════════════════════════════════════════════════════
# Tax tables — seeded defaults
# ═════════════════════════════════════════════════════════════════════════
def _round_dollar(x):
    return Decimal(x).quantize(Decimal('1'), rounding=ROUND_HALF_UP)


def _pub15t_rows(std_deduction, adjustment, brackets, step2=False):
    """Annual percentage-method rows [{over, base, rate}] in Pub 15-T layout.

    Standard table: thresholds = (standard deduction − W-4 adjustment) + bracket.
    Step 2 checkbox table: thresholds = (standard deduction + bracket) / 2,
    rounded to whole dollars as the IRS prints them."""
    std = Decimal(str(std_deduction))
    offset = std / 2 if step2 else std - Decimal(str(adjustment))
    offset = _round_dollar(offset)
    rows = [{'over': 0.0, 'base': 0.0, 'rate': 0.0}]
    thr_prev, base, rate_prev = offset, Decimal('0'), None
    rows.append({'over': float(offset), 'base': 0.0, 'rate': float(brackets[0][1])})
    rate_prev = Decimal(str(brackets[0][1]))
    for i in range(len(brackets) - 1):
        upto = Decimal(str(brackets[i][0]))
        thr = _round_dollar((std + upto) / 2) if step2 else offset + upto
        base = (base + (thr - thr_prev) * rate_prev / 100).quantize(CENT, rounding=ROUND_HALF_UP)
        rate_prev = Decimal(str(brackets[i + 1][1]))
        rows.append({'over': float(thr), 'base': float(base), 'rate': float(rate_prev)})
        thr_prev = thr
    return rows


_RATES = (10, 12, 22, 24, 32, 35, 37)
FEDERAL_INPUTS = {
    # Rev. Proc. 2024-40 brackets / standard deduction, used by the 2025 Pub 15-T.
    2025: {
        'standard_deduction': {'single': 15000, 'married_jointly': 30000, 'head_of_household': 22500},
        'standard_adjustment': {'single': 8600, 'married_jointly': 12900, 'head_of_household': 8600},
        'brackets': {
            'single': [11925, 48475, 103350, 197300, 250525, 626350],
            'married_jointly': [23850, 96950, 206700, 394600, 501050, 751600],
            'head_of_household': [17000, 64850, 103350, 197300, 250500, 626350],
        },
    },
    # Rev. Proc. 2025-32 (2026 inflation adjustments, after P.L. 119-21).
    2026: {
        'standard_deduction': {'single': 16100, 'married_jointly': 32200, 'head_of_household': 24150},
        'standard_adjustment': {'single': 8600, 'married_jointly': 12900, 'head_of_household': 8600},
        'brackets': {
            'single': [12400, 50400, 105700, 201775, 256225, 640600],
            'married_jointly': [24800, 100800, 211400, 403550, 512450, 768700],
            'head_of_household': [17700, 67450, 105700, 201750, 256200, 640600],
        },
    },
}


def build_federal(year_inputs):
    tables = {}
    for st in FILING_STATUSES:
        br = [(u, r) for u, r in zip(year_inputs['brackets'][st] + [None], _RATES)]
        std = year_inputs['standard_deduction'][st]
        adj = year_inputs['standard_adjustment'][st]
        tables[st] = {'standard': _pub15t_rows(std, adj, br), 'step2': _pub15t_rows(std, adj, br, step2=True)}
    return {
        'method': 'IRS Pub 15-T percentage method (automated payroll, W-4 2020+)',
        'standard_adjustment': dict(year_inputs['standard_adjustment']),
        'tables': tables,
    }


FICA = {
    2025: {'ss_rate': 6.2, 'ss_wage_base': 176100, 'medicare_rate': 1.45, 'addl_medicare_rate': 0.9,
           'addl_medicare_threshold': 200000},
    2026: {'ss_rate': 6.2, 'ss_wage_base': 184500, 'medicare_rate': 1.45, 'addl_medicare_rate': 0.9,
           'addl_medicare_threshold': 200000},
}
FUTA = {'rate': 0.6, 'wage_base': 7000}


def _br(rows):
    return [{'upto': u, 'rate': r} for u, r in rows]


_STD3 = lambda s, m, h: {'single': s, 'married_jointly': m, 'head_of_household': h}  # noqa: E731

STATES = {
    'TX': {'type': 'none'}, 'FL': {'type': 'none'}, 'WA': {'type': 'none'}, 'NV': {'type': 'none'},
    'PA': {'type': 'flat', 'rate': 3.07, 'std_deduction': _STD3(0, 0, 0), 'allowance_value': 0},
    'IL': {'type': 'flat', 'rate': 4.95, 'std_deduction': _STD3(0, 0, 0), 'allowance_value': 2850},
    'NC': {'type': 'flat', 'rate': 4.25, 'std_deduction': _STD3(12750, 25500, 19125), 'allowance_value': 2500},
    'GA': {'type': 'flat', 'rate': 5.19, 'std_deduction': _STD3(12000, 24000, 12000), 'allowance_value': 4000,
           'note': 'Georgia moved to a single flat rate (HB 1437 / HB 111).'},
    'CA': {'type': 'brackets', 'std_deduction': _STD3(5540, 11080, 11080), 'allowance_value': 0,
           'allowance_credit': 154,
           'brackets': {
               'single': _br([(10756, 1), (25499, 2), (40245, 4), (55866, 6), (70606, 8), (360659, 9.3),
                              (432787, 10.3), (721314, 11.3), (None, 12.3)]),
               'married_jointly': _br([(21512, 1), (50998, 2), (80490, 4), (111732, 6), (141212, 8),
                                       (721318, 9.3), (865574, 10.3), (1442628, 11.3), (None, 12.3)]),
               'head_of_household': _br([(21527, 1), (51000, 2), (65744, 4), (81364, 6), (96107, 8),
                                         (490493, 9.3), (588593, 10.3), (980987, 11.3), (None, 12.3)]),
           }},
    'NY': {'type': 'brackets', 'std_deduction': _STD3(8000, 16050, 11200), 'allowance_value': 1000,
           'brackets': {
               'single': _br([(8500, 4), (11700, 4.5), (13900, 5.25), (80650, 5.5), (215400, 6), (1077550, 6.85),
                              (5000000, 9.65), (25000000, 10.3), (None, 10.9)]),
               'married_jointly': _br([(17150, 4), (23600, 4.5), (27900, 5.25), (161550, 5.5), (323200, 6),
                                       (2155350, 6.85), (5000000, 9.65), (25000000, 10.3), (None, 10.9)]),
               'head_of_household': _br([(12800, 4), (17650, 4.5), (20900, 5.25), (107650, 5.5), (269300, 6),
                                         (1616450, 6.85), (5000000, 9.65), (25000000, 10.3), (None, 10.9)]),
           }},
    'NJ': {'type': 'brackets', 'std_deduction': _STD3(0, 0, 0), 'allowance_value': 1000,
           'brackets': {
               'single': _br([(20000, 1.4), (35000, 1.75), (40000, 3.5), (75000, 5.525), (500000, 6.37),
                              (1000000, 8.97), (None, 10.75)]),
               'married_jointly': _br([(20000, 1.4), (50000, 1.75), (70000, 2.45), (80000, 3.5), (150000, 5.525),
                                       (500000, 6.37), (1000000, 8.97), (None, 10.75)]),
               'head_of_household': _br([(20000, 1.4), (50000, 1.75), (70000, 2.45), (80000, 3.5),
                                         (150000, 5.525), (500000, 6.37), (1000000, 8.97), (None, 10.75)]),
           }},
}
STATE_OVERRIDES = {2026: {'NC': {'rate': 3.99}, 'GA': {'rate': 5.09}}}
# New-employer SUTA rates / taxable wage bases (each employer has its own
# assigned rate — enter it here).
SUTA = {
    'TX': (2.7, 9000), 'FL': (2.7, 7000), 'WA': (1.2, 72800), 'NV': (2.95, 40100), 'PA': (3.822, 10000),
    'IL': (3.95, 13916), 'NC': (1.0, 32600), 'GA': (2.64, 9500), 'CA': (3.4, 7000), 'NY': (4.1, 12800),
    'NJ': (2.8, 43300),
}
SEED_YEARS = (2025, 2026)


def _seed_rows(year):
    """[(kind, region, data)] for one year."""
    fed_year = year if year in FEDERAL_INPUTS else max(FEDERAL_INPUTS)
    rows = [('federal', '', build_federal(FEDERAL_INPUTS[fed_year])),
            ('fica', '', dict(FICA.get(year) or FICA[max(FICA)])),
            ('futa', '', dict(FUTA))]
    for st, data in STATES.items():
        d = json.loads(json.dumps(data))
        d.update(STATE_OVERRIDES.get(year, {}).get(st, {}))
        rows.append(('state', st, d))
    for st, (rate, base) in SUTA.items():
        rows.append(('suta', st, {'rate': rate, 'wage_base': base}))
    return rows


def ensure_seeded(force_year=None):
    """Create the default US rows once (idempotent). Rows are only added when
    no US federal table exists at all, so an admin's deletions stand."""
    from ..models import PayrollTaxTable
    try:
        if force_year is None and PayrollTaxTable.objects.filter(country='US', kind='federal').exists():
            return 0
        made = 0
        years = (force_year,) if force_year else SEED_YEARS
        for y in years:
            for kind, region, data in _seed_rows(y):
                data = dict(data, verified=False, source=VERIFY_NOTE)
                _, created = PayrollTaxTable.objects.get_or_create(
                    country='US', period=str(y), kind=kind, region=region,
                    defaults={'data': data, 'notes': VERIFY_NOTE, 'updated_by': 'system (seed)'})
                made += int(created)
        return made
    except Exception:
        logger.exception('US tax table seeding failed')
        return 0


def get_table(year, kind, region=''):
    """(data, period, row) of the table in force for ``year``: that year's
    row, else the most recent earlier year, else the earliest later one."""
    from ..models import PayrollTaxTable
    qs = PayrollTaxTable.objects.filter(country='US', kind=kind, region=region or '')
    rows = list(qs)
    if not rows:
        return None, None, None
    by_year = sorted(rows, key=lambda r: _safe_int(r.period, 0))
    pick = None
    for r in by_year:
        if _safe_int(r.period, 0) <= year:
            pick = r
    pick = pick or by_year[0]
    return (pick.data or {}), _safe_int(pick.period, 0), pick


# ═════════════════════════════════════════════════════════════════════════
# Table validation (editor)
# ═════════════════════════════════════════════════════════════════════════
def _status_map(v, field, hi):
    if isinstance(v, (int, float, str)) and not isinstance(v, bool):
        d = _dec(v, field, 0, hi)
        return {s: float(d) for s in FILING_STATUSES}
    if not isinstance(v, dict):
        raise Invalid(f'{field} must give an amount per filing status.')
    return {s: float(_dec(v.get(s, 0), f'{field} ({s})', 0, hi)) for s in FILING_STATUSES}


def _fed_rows(rows, field):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
        raise Invalid(f'{field} must have 1 to 20 rows.')
    out, prev = [], None
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            raise Invalid(f'{field} row {i + 1} is invalid.')
        over = _dec(r.get('over'), f'{field} row {i + 1} "over"', 0, 100000000)
        base = _dec(r.get('base'), f'{field} row {i + 1} "base"', 0, 100000000)
        rate = _dec(r.get('rate'), f'{field} row {i + 1} rate', 0, 50, 4)
        if i == 0 and over != 0:
            raise Invalid(f'{field} must start at 0.')
        if prev is not None and over <= prev:
            raise Invalid(f'{field} rows must be in increasing order.')
        prev = over
        out.append({'over': float(over), 'base': float(base), 'rate': float(rate)})
    return out


def _state_brackets(rows, field):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
        raise Invalid(f'{field} must have 1 to 20 brackets.')
    out, prev = [], ZERO
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            raise Invalid(f'{field} bracket {i + 1} is invalid.')
        last = i == len(rows) - 1
        upto = r.get('upto')
        if last:
            if upto not in (None, ''):
                raise Invalid(f'The last bracket of {field} must have no upper limit.')
            u = None
        else:
            u = _dec(upto, f'{field} bracket {i + 1} upper limit', 1, 1000000000)
            if u <= prev:
                raise Invalid(f'{field} brackets must be in increasing order.')
            prev = u
        rate = _dec(r.get('rate'), f'{field} bracket {i + 1} rate', 0, 20, 4)
        out.append({'upto': float(u) if u is not None else None, 'rate': float(rate)})
    return out


def clean_table(kind, data):
    """Validated, normalised copy of ``data`` (unknown keys dropped)."""
    if not isinstance(data, dict):
        raise Invalid('Table data must be an object.')
    if kind == 'federal':
        tables = data.get('tables')
        if not isinstance(tables, dict):
            raise Invalid('Federal tables are missing.')
        out = {'method': _text(data.get('method') or 'IRS Pub 15-T percentage method', 'method', 200),
               'standard_adjustment': _status_map(data.get('standard_adjustment', {}), 'Standard adjustment', 1000000),
               'tables': {}}
        for st in FILING_STATUSES:
            t = tables.get(st)
            if not isinstance(t, dict):
                raise Invalid(f'Federal table for {st} is missing.')
            out['tables'][st] = {'standard': _fed_rows(t.get('standard'), f'{st} standard table'),
                                 'step2': _fed_rows(t.get('step2'), f'{st} Step 2 table')}
        return out
    if kind == 'fica':
        return {'ss_rate': float(_dec(data.get('ss_rate'), 'Social Security rate', 0, 20, 4)),
                'ss_wage_base': float(_dec(data.get('ss_wage_base'), 'Social Security wage base', 0, 10000000)),
                'medicare_rate': float(_dec(data.get('medicare_rate'), 'Medicare rate', 0, 10, 4)),
                'addl_medicare_rate': float(_dec(data.get('addl_medicare_rate'), 'Additional Medicare rate', 0, 10, 4)),
                'addl_medicare_threshold': float(_dec(data.get('addl_medicare_threshold'),
                                                      'Additional Medicare threshold', 0, 100000000))}
    if kind in ('futa', 'suta'):
        return {'rate': float(_dec(data.get('rate'), 'Rate', 0, 20, 4)),
                'wage_base': float(_dec(data.get('wage_base'), 'Wage base', 0, 10000000))}
    if kind == 'state':
        t = data.get('type')
        if t not in ('none', 'flat', 'brackets'):
            raise Invalid('State table type must be none, flat or brackets.')
        out = {'type': t}
        if t == 'none':
            return out
        out['std_deduction'] = _status_map(data.get('std_deduction', 0), 'Standard deduction', 1000000)
        out['allowance_value'] = float(_dec(data.get('allowance_value'), 'Allowance value', 0, 1000000))
        out['allowance_credit'] = float(_dec(data.get('allowance_credit'), 'Allowance credit', 0, 100000))
        if t == 'flat':
            out['rate'] = float(_dec(data.get('rate'), 'Rate', 0, 20, 4))
        else:
            br = data.get('brackets')
            if not isinstance(br, dict):
                raise Invalid('Brackets per filing status are required.')
            out['brackets'] = {}
            for st in FILING_STATUSES:
                rows = br.get(st) or br.get('single')
                out['brackets'][st] = _state_brackets(rows, f'{st} brackets')
        if data.get('note'):
            out['note'] = _text(data.get('note'), 'Note', 300)
        return out
    raise Invalid('Unknown table kind.')


# ═════════════════════════════════════════════════════════════════════════
# Calculations
# ═════════════════════════════════════════════════════════════════════════
W4_DEFAULTS = {'filing_status': 'single', 'multiple_jobs': False, 'dependents_amount': ZERO, 'other_income': ZERO,
               'deductions': ZERO, 'extra_withholding': ZERO, 'exempt': False, 'work_state': '',
               'state_allowances': 0, 'state_extra_withholding': ZERO}


def w4_dict(w4):
    if w4 is None:
        return dict(W4_DEFAULTS)
    if isinstance(w4, dict):
        d = dict(W4_DEFAULTS)
        d.update({k: v for k, v in w4.items() if k in W4_DEFAULTS})
        return d
    return {k: getattr(w4, k, W4_DEFAULTS[k]) for k in W4_DEFAULTS}


def _pct(v):
    return Decimal(str(v or 0)) / Decimal('100')


def _row_tax(rows, amount):
    pick = None
    for r in rows:
        if amount >= Decimal(str(r.get('over') or 0)):
            pick = r
    if not pick:
        return ZERO
    return Decimal(str(pick.get('base') or 0)) + (amount - Decimal(str(pick.get('over') or 0))) * _pct(pick.get('rate'))


def federal_withholding(wages, periods, w4, fed):
    """Pub 15-T Worksheet 1A (percentage method, automated systems, W-4 2020+).
    Returns (amount per period, detail dict)."""
    w = w4_dict(w4)
    if w['exempt']:
        return ZERO, {'exempt': True}
    status = w['filing_status'] if w['filing_status'] in FILING_STATUSES else 'single'
    periods = Decimal(periods)
    annual = Decimal(str(wages)) * periods                                   # 1c
    annual += Decimal(str(w['other_income']))                               # 1d/1e
    adjustment = Decimal(str((fed.get('standard_adjustment') or {}).get(status, 0))) if not w['multiple_jobs'] else ZERO
    reduce = Decimal(str(w['deductions'])) + adjustment                       # 1f + 1g = 1h
    adjusted = max(ZERO, annual - reduce)                                    # 1i
    table = ((fed.get('tables') or {}).get(status) or {}).get('step2' if w['multiple_jobs'] else 'standard') or []
    tentative_annual = _row_tax(table, adjusted)                             # 2a–2g
    per = tentative_annual / periods                                         # 2h
    credit = Decimal(str(w['dependents_amount'])) / periods                  # 3a/3b
    per = max(ZERO, per - credit)                                            # 3c
    per += Decimal(str(w['extra_withholding']))                              # 4a/4b
    return D(per), {'adjustedAnnualWage': _f(adjusted), 'tentativeAnnual': _f(tentative_annual),
                    'filingStatus': status, 'table': 'step2' if w['multiple_jobs'] else 'standard'}


def _std_for(v, status):
    if isinstance(v, dict):
        return Decimal(str(v.get(status, v.get('single', 0)) or 0))
    return Decimal(str(v or 0))


def state_withholding(wages, periods, w4, sdata):
    """Generic annualised state formula: (annual wages − standard deduction −
    allowances × allowance value) through the flat rate / brackets, less
    allowances × allowance credit, de-annualised, plus extra withholding."""
    w = w4_dict(w4)
    t = (sdata or {}).get('type', 'none')
    if t == 'none':
        return ZERO
    status = w['filing_status'] if w['filing_status'] in FILING_STATUSES else 'single'
    periods = Decimal(periods)
    allowances = Decimal(int(w['state_allowances'] or 0))
    annual = Decimal(str(wages)) * periods
    annual -= _std_for(sdata.get('std_deduction'), status)
    annual -= allowances * Decimal(str(sdata.get('allowance_value') or 0))
    annual = max(ZERO, annual)
    if t == 'flat':
        tax = annual * _pct(sdata.get('rate'))
    else:
        brackets = (sdata.get('brackets') or {}).get(status) or (sdata.get('brackets') or {}).get('single') or []
        tax, lower = ZERO, ZERO
        for b in brackets:
            upto = b.get('upto')
            top = Decimal(str(upto)) if upto not in (None, '') else None
            if top is None or annual <= top:
                tax += (annual - lower) * _pct(b.get('rate'))
                break
            tax += (top - lower) * _pct(b.get('rate'))
            lower = top
    tax -= allowances * Decimal(str(sdata.get('allowance_credit') or 0))
    tax = max(ZERO, tax)
    return D(tax / periods + Decimal(str(w['state_extra_withholding'] or 0)))


def _capped(wages, ytd, base):
    """Part of this period's wages that is still under an annual wage base."""
    room = max(ZERO, Decimal(str(base)) - Decimal(str(ytd)))
    return min(Decimal(str(wages)), room)


def compute_withholding(wages, periods, w4, year, ytd_wages=ZERO):
    """All US lines for one pay period. Never raises for missing tables —
    the problem is reported in ``warnings`` instead."""
    ensure_seeded()
    wages = max(ZERO, Decimal(str(wages)))
    ytd = max(ZERO, Decimal(str(ytd_wages or 0)))
    w = w4_dict(w4)
    warnings = []
    out = {k: ZERO for k in ('fit', 'sit', 'socsec', 'medicare', 'er_socsec', 'er_medicare', 'futa', 'suta')}
    detail = {}

    fed, fed_year, _ = get_table(year, 'federal')
    if fed:
        if fed_year != year:
            warnings.append(f'No {year} federal table — using the {fed_year} table.')
        out['fit'], detail['fit'] = federal_withholding(wages, periods, w, fed)
    else:
        warnings.append('No federal withholding table is configured — FIT not withheld.')

    fica, _, _ = get_table(year, 'fica')
    fica = fica or FICA[max(FICA)]
    ss_wages = _capped(wages, ytd, fica.get('ss_wage_base', 0))
    out['socsec'] = D(ss_wages * _pct(fica.get('ss_rate')))
    out['er_socsec'] = out['socsec']
    med = wages * _pct(fica.get('medicare_rate'))
    out['er_medicare'] = D(med)
    threshold = Decimal(str(fica.get('addl_medicare_threshold') or 0))
    over = max(ZERO, ytd + wages - max(threshold, ytd))
    out['medicare'] = D(med + over * _pct(fica.get('addl_medicare_rate')))
    detail['ssWages'] = _f(ss_wages)
    detail['addlMedicareWages'] = _f(over)

    futa, _, _ = get_table(year, 'futa')
    futa = futa or FUTA
    out['futa'] = D(_capped(wages, ytd, futa.get('wage_base', 0)) * _pct(futa.get('rate')))

    state = (w.get('work_state') or '').upper()
    detail['state'] = state
    if not state:
        warnings.append('No work state on the W-4 — state tax (SIT/SUTA) not calculated.')
    else:
        sdata, _, _ = get_table(year, 'state', state)
        if sdata is None:
            warnings.append(f'No state tax table for {state} — SIT set to 0. Add one under US Payroll › Tax tables.')
        else:
            out['sit'] = state_withholding(wages, periods, w, sdata)
        suta, _, _ = get_table(year, 'suta', state)
        if suta is None:
            warnings.append(f'No SUTA rate for {state} — employer SUTA not calculated.')
        else:
            out['suta'] = D(_capped(wages, ytd, suta.get('wage_base', 0)) * _pct(suta.get('rate')))
    return {'amounts': out, 'warnings': warnings, 'detail': detail, 'wages': D(wages), 'ytdWages': D(ytd),
            'periods': int(periods)}


# ═════════════════════════════════════════════════════════════════════════
# Payslip helpers (YTD, W-2)
# ═════════════════════════════════════════════════════════════════════════
def wages_of(lines_holder):
    """Taxable wages of a result / payslip: taxable earnings less unpaid leave."""
    earn = taxable_earnings(lines_holder)
    unpaid = line_amount(lines_holder, 'deductions_data', 'UNPAID_LEAVE_DEDUCTION')
    return max(ZERO, D(earn - unpaid))


def run_date(run):
    return run.pay_date or run.period_end


def _active_comp(email, on=None):
    from django.db.models import Q
    from ..models import EmployeeCompensation
    qs = EmployeeCompensation.objects.filter(email__iexact=email)
    if on:
        c = qs.filter(status='active', effective_from__lte=on).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=on)).order_by('-effective_from', '-id').first()
        if c:
            return c
    return qs.filter(status='active').order_by('-effective_from', '-id').first() or \
        qs.order_by('-effective_from', '-id').first()


def _payslip_currency(ps, cache):
    from ..models import PayrollEntry
    cur = PayrollEntry.objects.filter(run_id=ps.run_id, email__iexact=ps.email).values_list('currency', flat=True).first()
    if cur:
        return cur.upper()
    codes = {str(l.get('code')) for l in (ps.deductions_data or []) if isinstance(l, dict)}
    if codes & set(US_DEDUCTION_CODES):
        return 'USD'
    key = ps.email.lower()
    if key not in cache:
        c = _active_comp(key)
        cache[key] = (c.currency if c else 'INR').upper()
    return cache[key]


def usd_payslips(year, email=None, before=None, exclude_run=None):
    """USD payslips whose pay date falls in ``year`` (cancelled runs skipped)."""
    from ..models import Payslip
    qs = Payslip.objects.select_related('run').exclude(run__status='cancelled').filter(
        run__period_end__gte=date(year - 1, 12, 1), run__period_end__lte=date(year, 12, 31))
    if email:
        qs = qs.filter(email__iexact=email)
    if before:
        qs = qs.filter(run__period_end__lt=before)
    if exclude_run:
        qs = qs.exclude(run_id=exclude_run)
    cache, out = {}, []
    for ps in qs.order_by('run__period_end', 'id'):
        if run_date(ps.run).year != year:
            continue
        if _payslip_currency(ps, cache) != 'USD':
            continue
        out.append(ps)
    return out


def ytd_wages(email, year, before, exclude_run=None):
    return sum((wages_of({'earnings_data': ps.earnings_data, 'deductions_data': ps.deductions_data})
                for ps in usd_payslips(year, email=email, before=before, exclude_run=exclude_run)), ZERO)


def w4_for(email, year):
    """The W-4 in force: that year's, else the most recent earlier one."""
    from ..models import UsW4Declaration
    return UsW4Declaration.objects.filter(email__iexact=email, year__lte=year).order_by('-year').first()


# ═════════════════════════════════════════════════════════════════════════
# The calculation hook
# ═════════════════════════════════════════════════════════════════════════
def _fix_totals(result):
    """Shared ``recompute`` (it already leaves the informational
    GROSS_EARNING row out of the employer total)."""
    return recompute(result)


def apply_us(result, ctx):
    try:
        return _apply_us(copy.deepcopy(result), ctx)
    except Exception:
        logger.exception('US withholding failed for a payslip — left unchanged')
        return result


def _apply_us(result, ctx):
    email = (ctx.get('email') or result.get('email') or '').lower()
    start, end = ctx.get('start'), ctx.get('end')
    comp = _active_comp(email, end) if email else None
    is_us = str(result.get('currency') or '').upper() == 'USD' or bool(comp and str(comp.currency).upper() == 'USD')
    if not is_us or not end:
        return result
    year = end.year
    run_id = ctx.get('run_id')
    if run_id:
        from ..models import PayrollRun
        run = PayrollRun.objects.filter(pk=run_id).first()
        if run:
            year = run_date(run).year
    freq = (comp.pay_frequency if comp else 'monthly') or 'monthly'
    periods = PERIODS.get(freq, 12)

    if get_setting('us_strip_india_statutory', '1') != '0':
        result['deductions_data'] = [l for l in (result.get('deductions_data') or [])
                                     if str(l.get('code')).upper() not in INDIA_DEDUCTIONS]
        result['employer_contributions_data'] = [l for l in (result.get('employer_contributions_data') or [])
                                                 if str(l.get('code')).upper() not in INDIA_EMPLOYER]

    wages = wages_of(result)
    w4 = w4_for(email, year)
    ytd = ytd_wages(email, year, before=start or end, exclude_run=run_id)
    calc = compute_withholding(wages, periods, w4, year, ytd)
    a = calc['amounts']
    state = calc['detail'].get('state') or ''
    warnings = list(calc['warnings'])
    if w4 is None:
        warnings.insert(0, 'No Form W-4 on file — withholding as Single with no adjustments (IRS default).')

    set_line(result, 'deductions_data', 'FIT', 'Federal Income Tax', a['fit'])
    set_line(result, 'deductions_data', 'SIT', f'State Income Tax ({state})' if state else 'State Income Tax', a['sit'])
    set_line(result, 'deductions_data', 'SOCSEC', 'Social Security', a['socsec'])
    set_line(result, 'deductions_data', 'MEDICARE', 'Medicare', a['medicare'])
    key = 'employer_contributions_data'
    set_line(result, key, 'ER_SOCSEC', 'Employer Social Security', a['er_socsec'])
    set_line(result, key, 'ER_MEDICARE', 'Employer Medicare', a['er_medicare'])
    set_line(result, key, 'FUTA', 'FUTA (federal unemployment)', a['futa'])
    set_line(result, key, 'SUTA', f'SUTA ({state})' if state else 'SUTA', a['suta'])
    result['currency'] = 'USD'
    result['us_withholding'] = {k: _f(v) for k, v in a.items()}
    result['us_withholding'].update({'wages': _f(wages), 'ytdWages': _f(ytd), 'periods': periods,
                                     'payFrequency': freq, 'state': state, 'year': year})
    result['us_warnings'] = warnings
    return _fix_totals(result)


# ═════════════════════════════════════════════════════════════════════════
# Pay calendars
# ═════════════════════════════════════════════════════════════════════════
def _anchor(key):
    v = get_setting(key, '')
    try:
        return date.fromisoformat(v) if v else _default_anchor()
    except ValueError:
        return _default_anchor()


def pay_periods(freq, count=6, start_from=None, anchor=None, lag_days=0):
    """The next ``count`` periods of a frequency, starting with the one that
    contains ``start_from`` (default today)."""
    if freq not in PERIODS:
        raise Invalid('Unknown pay frequency.')
    d = start_from or today()
    out = []
    if freq in ('weekly', 'biweekly'):
        step = 7 if freq == 'weekly' else 14
        anchor = anchor or _anchor('us_weekly_anchor' if freq == 'weekly' else 'us_biweekly_anchor')
        k = (d - anchor).days // step
        s = anchor + timedelta(days=k * step)
        for _ in range(count):
            e = s + timedelta(days=step - 1)
            n = (s - date(s.year, 1, 1)).days // step + 1
            out.append((s, e, f"{s.year}-{'W' if step == 7 else 'BW'}{n:02d}"))
            s = e + timedelta(days=1)
    elif freq == 'semimonthly':
        y, m, half = d.year, d.month, 1 if d.day <= 15 else 2
        for _ in range(count):
            if half == 1:
                s, e = date(y, m, 1), date(y, m, 15)
            else:
                s, e = date(y, m, 16), date(y, m, monthrange(y, m)[1])
            out.append((s, e, f'{y}-{m:02d}-H{half}'))
            if half == 2:
                y, m = (y + 1, 1) if m == 12 else (y, m + 1)
            half = 2 if half == 1 else 1
    else:
        y, m = d.year, d.month
        for _ in range(count):
            out.append((date(y, m, 1), date(y, m, monthrange(y, m)[1]), f'{y}-{m:02d}'))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return [{'label': lbl, 'start': s.isoformat(), 'end': e.isoformat(),
             'payDate': (e + timedelta(days=lag_days)).isoformat(), 'days': (e - s).days + 1}
            for s, e, lbl in out]


# ═════════════════════════════════════════════════════════════════════════
# People
# ═════════════════════════════════════════════════════════════════════════
def _name(email):
    from ..models import AppUser, UserProfile
    u = AppUser.objects.filter(email__iexact=email).first()
    if u and (u.full_name or '').strip():
        return u.full_name.strip()
    p = UserProfile.objects.filter(email__iexact=email).first()
    if p and (f'{p.first_name} {p.last_name}').strip():
        return f'{p.first_name} {p.last_name}'.strip()
    return email.split('@')[0]


def us_employee_emails():
    from ..models import EmployeeCompensation, UsW4Declaration
    emails = set(e.lower() for e in EmployeeCompensation.objects.filter(currency__iexact='USD', status='active')
                 .values_list('email', flat=True))
    emails |= set(e.lower() for e in UsW4Declaration.objects.values_list('email', flat=True))
    return sorted(emails)


def w4_out(w, year=None, carried=False):
    if w is None:
        d = w4_dict(None)
        return {'year': year, 'exists': False, 'filingStatus': d['filing_status'], 'multipleJobs': False,
                'dependentsAmount': 0.0, 'otherIncome': 0.0, 'deductions': 0.0, 'extraWithholding': 0.0,
                'exempt': False, 'workState': '', 'stateAllowances': 0, 'stateExtraWithholding': 0.0,
                'ssnMasked': '', 'ssnOnFile': False, 'signedAt': None, 'updatedAt': None, 'carriedFrom': None}
    return {'year': year or w.year, 'exists': not carried, 'carriedFrom': w.year if carried else None,
            'filingStatus': w.filing_status, 'multipleJobs': bool(w.multiple_jobs),
            'dependentsAmount': _f(w.dependents_amount), 'otherIncome': _f(w.other_income),
            'deductions': _f(w.deductions), 'extraWithholding': _f(w.extra_withholding), 'exempt': bool(w.exempt),
            'workState': w.work_state or '', 'stateAllowances': int(w.state_allowances or 0),
            'stateExtraWithholding': _f(w.state_extra_withholding),
            'ssnMasked': mask_tin(w.ssn_last4), 'ssnOnFile': bool(w.ssn_enc),
            'signedAt': w.signed_at.isoformat() if w.signed_at else None,
            'updatedAt': w.updated_at.isoformat() if w.updated_at else None}


def _w4_view(email, year):
    from ..models import UsW4Declaration
    w = UsW4Declaration.objects.filter(email__iexact=email, year=year).first()
    if w:
        return w4_out(w)
    prev = w4_for(email, year)
    return w4_out(prev, year=year, carried=True) if prev else w4_out(None, year=year)


def _employee_warnings(email, year, w, comp):
    warn = []
    if w is None:
        warn.append('No W-4 on file')
    else:
        if not w.ssn_enc:
            warn.append('SSN missing')
        if not w.work_state:
            warn.append('No work state')
        else:
            sdata, _, _ = get_table(year, 'state', w.work_state)
            if sdata is None:
                warn.append(f'No {w.work_state} state table (SIT = 0)')
        if w.exempt and w.year < year:
            warn.append('Exempt claim expired — new W-4 needed')
        if w.year < year:
            warn.append(f'Using {w.year} W-4')
    if comp is None:
        warn.append('No compensation record')
    elif (comp.pay_frequency or 'monthly') not in PERIODS:
        warn.append('Unknown pay frequency')
    return warn


W4_FIELDS = {
    'filingStatus': 'filing_status', 'multipleJobs': 'multiple_jobs', 'dependentsAmount': 'dependents_amount',
    'otherIncome': 'other_income', 'deductions': 'deductions', 'extraWithholding': 'extra_withholding',
    'exempt': 'exempt', 'workState': 'work_state', 'stateAllowances': 'state_allowances',
    'stateExtraWithholding': 'state_extra_withholding',
}


def clean_w4(body, partial_base=None):
    """Validated model-field dict from a request body."""
    base = w4_dict(partial_base)
    out = {}
    fs = body.get('filingStatus', base['filing_status'])
    if fs not in FILING_STATUSES:
        raise Invalid('Filing status must be single, married_jointly or head_of_household.')
    out['filing_status'] = fs
    out['multiple_jobs'] = _bool(body.get('multipleJobs', base['multiple_jobs']), 'Step 2(c) multiple jobs')
    out['dependents_amount'] = _dec(body.get('dependentsAmount', base['dependents_amount']), 'Step 3 dependents amount', 0, 1000000)
    out['other_income'] = _dec(body.get('otherIncome', base['other_income']), 'Step 4(a) other income', 0, 10000000)
    out['deductions'] = _dec(body.get('deductions', base['deductions']), 'Step 4(b) deductions', 0, 10000000)
    out['extra_withholding'] = _dec(body.get('extraWithholding', base['extra_withholding']), 'Step 4(c) extra withholding', 0, 100000)
    out['exempt'] = _bool(body.get('exempt', base['exempt']), 'Exempt')
    ws = str(body.get('workState', base['work_state']) or '').strip().upper()
    if ws and ws not in US_STATES:
        raise Invalid('Work state must be a two-letter US state code.')
    out['work_state'] = ws
    out['state_allowances'] = _int(body.get('stateAllowances', base['state_allowances']), 'State allowances', 0, 99)
    out['state_extra_withholding'] = _dec(body.get('stateExtraWithholding', base['state_extra_withholding']),
                                          'State extra withholding', 0, 100000)
    return out


def save_w4(email, year, body, request, actor, by_employee):
    """Create / update the W-4 for (email, year). Returns (row, error message)."""
    from ..models import UsW4Declaration
    existing = UsW4Declaration.objects.filter(email__iexact=email, year=year).first()
    carried = None if existing else w4_for(email, year)
    try:
        fields = clean_w4(body, existing or carried)
        ssn_raw = body.get('ssn')
        ssn = None
        if ssn_raw not in (None, ''):
            ssn = normalize_ssn(ssn_raw)
            if not ssn:
                raise Invalid('Enter a valid 9-digit Social Security number (e.g. 123-45-6789).')
        has_ssn = bool(ssn or (existing and existing.ssn_enc) or (carried and carried.ssn_enc))
        if by_employee:
            if body.get('certify') is not True:
                raise Invalid('Confirm the declaration (under penalties of perjury) to sign the W-4.')
            if not has_ssn:
                raise Invalid('Your Social Security number is required.')
    except Invalid as e:
        return None, str(e)
    with transaction.atomic():
        row = existing or UsW4Declaration(email=email, year=year)
        before = w4_out(existing) if existing else None
        for k, v in fields.items():
            setattr(row, k, v)
        if ssn:
            row.ssn_enc = security.seal(ssn)
            row.ssn_last4 = ssn[-4:]
        elif not existing and carried and carried.ssn_enc:
            row.ssn_enc, row.ssn_last4 = carried.ssn_enc, carried.ssn_last4
        if by_employee:
            row.signed_at = timezone.now()
        row.updated_at = timezone.now()
        row.save()
    after = w4_out(row)
    changes = {k: {'from': (before or {}).get(k), 'to': after.get(k)} for k in W4_FIELDS
               if (before or {}).get(k) != after.get(k)}
    if ssn:
        changes['ssn'] = 'changed'          # never the value
    security.audit('us_w4_signed' if by_employee else 'us_w4_updated', 'UsW4Declaration', row.id, request,
                   actor, security.display_name(None, actor), changes,
                   f'W-4 {year} for {email}' + (' (self-service)' if by_employee else ' (payroll)'))
    return row, ''


def _estimate_wages(email, periods):
    comp = _active_comp(email)
    if not comp:
        return ZERO
    annual = Decimal(str(comp.annual_ctc or 0)) or Decimal(str(comp.base_amount or 0)) * 12
    return D(annual / Decimal(periods)) if annual else ZERO


def _preview(email, body, year):
    from ..models import UsW4Declaration
    comp = _active_comp(email)
    freq = (body.get('payFrequency') or (comp.pay_frequency if comp else 'monthly') or 'monthly')
    if freq not in PERIODS:
        raise Invalid('Unknown pay frequency.')
    periods = PERIODS[freq]
    wages = body.get('wages')
    wages = _dec(wages, 'Wages per period', 0, 10000000) if wages not in (None, '') else _estimate_wages(email, periods)
    base = UsW4Declaration.objects.filter(email__iexact=email, year=year).first() or w4_for(email, year)
    w4 = clean_w4(body.get('w4') or {}, base) if isinstance(body.get('w4'), dict) else w4_dict(base)
    calc = compute_withholding(wages, periods, w4, year, ZERO)
    a = calc['amounts']
    emp = a['fit'] + a['sit'] + a['socsec'] + a['medicare']
    return {'year': year, 'payFrequency': freq, 'periods': periods, 'wages': _f(wages),
            'lines': {k: _f(v) for k, v in a.items()}, 'employeeTaxes': _f(emp), 'net': _f(max(ZERO, wages - emp)),
            'warnings': calc['warnings'], 'detail': calc['detail'],
            'note': 'Estimate for one pay period with no year-to-date wages; actual payslips also apply wage bases.'}


# ═════════════════════════════════════════════════════════════════════════
# W-2 / 1099-NEC
# ═════════════════════════════════════════════════════════════════════════
def w2_data(year, email=None):
    """{email: boxes} from the year's USD payslips."""
    out = {}
    fica, _, _ = get_table(year, 'fica')
    ss_base = Decimal(str((fica or FICA[max(FICA)]).get('ss_wage_base', 0)))
    drafts = 0
    for ps in usd_payslips(year, email=email):
        e = ps.email.lower()
        b = out.setdefault(e, {'wages': ZERO, 'fit': ZERO, 'ss_tax': ZERO, 'med_tax': ZERO, 'sit': ZERO,
                               'payslips': 0})
        holder = {'earnings_data': ps.earnings_data, 'deductions_data': ps.deductions_data}
        b['wages'] += wages_of(holder)
        b['fit'] += line_amount(holder, 'deductions_data', 'FIT')
        b['ss_tax'] += line_amount(holder, 'deductions_data', 'SOCSEC')
        b['med_tax'] += line_amount(holder, 'deductions_data', 'MEDICARE')
        b['sit'] += line_amount(holder, 'deductions_data', 'SIT')
        b['payslips'] += 1
        if ps.run.status in ('draft', 'processing'):
            drafts += 1
    result = {}
    for e, b in out.items():
        w = w4_for(e, year)
        state = (w.work_state if w else '') or ''
        result[e] = {
            'email': e, 'name': _name(e), 'ssnMasked': mask_tin(w.ssn_last4) if w else '', 'ssnOnFile': bool(w and w.ssn_enc),
            'box1': _f(b['wages']), 'box2': _f(b['fit']), 'box3': _f(min(b['wages'], ss_base)), 'box4': _f(b['ss_tax']),
            'box5': _f(b['wages']), 'box6': _f(b['med_tax']), 'box15': state, 'box16': _f(b['wages'] if state else ZERO),
            'box17': _f(b['sit']), 'payslips': b['payslips'],
        }
    return result, drafts


_W2_NOTICE = ('Generated by HRMS from payroll records. Review every value before use. Filing with the Social '
              'Security Administration requires an EFW2 file or entry in SSA Business Services Online (BSO); '
              'this document is not an official IRS form.')


def _money_s(v):
    return f'{Decimal(str(v or 0)):,.2f}'


def _csv_cell(v):
    s = str(v if v is not None else '')
    return "'" + s if s[:1] in ('=', '+', '-', '@', '\t', '\r') else s


_FORM_CSS = ('body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;background:#fff}'
             'h1{font-size:18px;margin:0 0 4px}.sub{font-size:12px;color:#444;margin-bottom:12px}'
             '.grid{display:grid;grid-template-columns:repeat(4,1fr);border:2px solid #111;max-width:900px}'
             '.box{border:1px solid #111;padding:6px 8px;min-height:44px;font-size:13px}'
             '.box b{display:block;font-size:10px;font-weight:600;color:#333;margin-bottom:4px}'
             '.w2{grid-column:span 2}.w4{grid-column:span 4}.amt{text-align:right;font-family:Consolas,monospace}'
             '.note{max-width:900px;margin-top:12px;font-size:11px;color:#333;border:1px dashed #999;padding:8px}'
             '@media print{.note{border-color:#666}}')


def _box(label, value, cls='', amount=False):
    v = _money_s(value) if amount else html.escape(str(value or ''))
    return f'<div class="box {cls}"><b>{html.escape(label)}</b><div class="{"amt" if amount else ""}">{v}</div></div>'


def render_w2_html(year, b, emp):
    esc = html.escape
    state_id = emp['stateIds'].get(b['box15'], '')
    ein = emp['employerEin']
    ein_s = f'{ein[:2]}-{ein[2:]}' if len(ein) == 9 else ein
    parts = [
        f'<!doctype html><html><head><meta charset="utf-8"><title>W-2 {year} — {esc(b["name"])}</title>'
        f'<style>{_FORM_CSS}</style></head><body>',
        f'<h1>Form W-2 Wage and Tax Statement — {year}</h1>',
        '<div class="sub">Copy B / C — for the employee’s records. SSN truncated as permitted on employee copies.</div>',
        '<div class="grid">',
        _box('a  Employee’s social security number', b['ssnMasked'] or 'NOT ON FILE', 'w2'),
        _box('b  Employer identification number (EIN)', ein_s or 'NOT SET', 'w2'),
        _box('c  Employer’s name and address', f"{emp['employerName']} {emp['employerAddress']}".strip() or 'NOT SET', 'w4'),
        _box('e  Employee’s name', b['name'], 'w2'),
        _box('f  Employee’s address', b.get('address', ''), 'w2'),
        _box('1  Wages, tips, other compensation', b['box1'], 'w2', True),
        _box('2  Federal income tax withheld', b['box2'], 'w2', True),
        _box('3  Social security wages', b['box3'], 'w2', True),
        _box('4  Social security tax withheld', b['box4'], 'w2', True),
        _box('5  Medicare wages and tips', b['box5'], 'w2', True),
        _box('6  Medicare tax withheld', b['box6'], 'w2', True),
        _box('15  State / Employer’s state ID', f"{b['box15']} {state_id}".strip()),
        _box('16  State wages, tips, etc.', b['box16'], '', True),
        _box('17  State income tax', b['box17'], '', True),
        _box('Payslips included', b['payslips']),
        '</div>',
        f'<div class="note">{esc(_W2_NOTICE)}</div></body></html>',
    ]
    return ''.join(parts)


def render_w2_csv(year, rows, emp):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(['record', 'tax_year', 'employer_ein', 'employee_name', 'ssn_masked', 'box1_wages', 'box2_fit',
                'box3_ss_wages', 'box4_ss_tax', 'box5_medicare_wages', 'box6_medicare_tax', 'box15_state',
                'box16_state_wages', 'box17_state_tax'])
    tot = {k: ZERO for k in ('box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box16', 'box17')}
    for b in rows:
        w.writerow(['RW', year, emp['employerEin'], _csv_cell(b['name']), b['ssnMasked'], _money_s(b['box1']).replace(',', ''),
                    *[f"{Decimal(str(b[k])):.2f}" for k in ('box2', 'box3', 'box4', 'box5', 'box6')],
                    b['box15'], f"{Decimal(str(b['box16'])):.2f}", f"{Decimal(str(b['box17'])):.2f}"])
        for k in tot:
            tot[k] += Decimal(str(b[k]))
    w.writerow(['RT', year, emp['employerEin'], f'{len(rows)} employees', '', *[f'{tot[k]:.2f}' for k in
                ('box1', 'box2', 'box3', 'box4', 'box5', 'box6')], '', f"{tot['box16']:.2f}", f"{tot['box17']:.2f}"])
    w.writerow([])
    w.writerow(['NOTE', 'Summary in the shape of EFW2 RW/RT records, SSNs masked. Not an SSA submission file — '
                'file through EFW2 / SSA BSO after review.'])
    return buf.getvalue()


def _store_filing(kind, period, email, file_name, mime, content, rows, actor):
    from ..models import StatutoryFiling
    return StatutoryFiling.objects.create(
        kind=kind, period=str(period), email=email or '', file_name=file_name[:255], file_mime=mime,
        content=content, sha256=hashlib.sha256(content.encode('utf-8')).hexdigest(), row_count=rows,
        generated_by=actor, generated_at=timezone.now())


def _safe_file(s):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', s)[:60] or 'employee'


def generate_w2(year, actor, email=None):
    from ..models import UserProfile
    data, drafts = w2_data(year, email)
    emp = employer_info()
    files = []
    rows = []
    for e in sorted(data):
        b = data[e]
        p = UserProfile.objects.filter(email__iexact=e).first()
        b['address'] = (p.address or '') if p else ''
        rows.append(b)
        content = render_w2_html(year, b, emp)
        f = _store_filing('W2', year, e, f'W2_{year}_{_safe_file(b["name"])}.html', 'text/html', content, 1, actor)
        files.append(f)
    summary = None
    if rows and not email:
        csv_text = render_w2_csv(year, rows, emp)
        summary = _store_filing('W2', year, '', f'W2_{year}_summary.csv', 'text/csv', csv_text, len(rows), actor)
    return {'forms': files, 'summary': summary, 'rows': rows, 'draftPayslips': drafts}


def threshold_1099(year):
    v = get_setting('us_1099_threshold', '')
    if v:
        try:
            return Decimal(v)
        except InvalidOperation:
            pass
    # P.L. 119-21 raised the NEC/MISC threshold from $600 to $2,000 for
    # payments made after 31 Dec 2025 (inflation-indexed after 2026).
    return Decimal('600') if year <= 2025 else Decimal('2000')


def _payee_key(p):
    return (p.payee_email or '').strip().lower() or (p.payee_name or '').strip().lower()


def contractor_summary(year):
    from ..models import ContractorPayment
    groups = {}
    for p in ContractorPayment.objects.filter(paid_on__year=year).order_by('paid_on', 'id'):
        k = _payee_key(p)
        g = groups.setdefault(k, {'key': k, 'payeeName': p.payee_name, 'payeeEmail': p.payee_email,
                                  'tinLast4': '', 'address': '', 'total': ZERO, 'payments': 0})
        g['total'] += Decimal(str(p.amount))
        g['payments'] += 1
        if p.tin_last4:
            g['tinLast4'] = p.tin_last4
        if p.address:
            g['address'] = p.address
    th = threshold_1099(year)
    out = []
    for g in groups.values():
        out.append({'key': g['key'], 'payeeName': g['payeeName'], 'payeeEmail': g['payeeEmail'],
                    'tinMasked': mask_tin(g['tinLast4']), 'tinOnFile': bool(g['tinLast4']), 'address': g['address'],
                    'total': _f(g['total']), 'payments': g['payments'], 'requires1099': g['total'] >= th})
    out.sort(key=lambda r: (-r['total'], r['payeeName'].lower()))
    return out, th


def render_1099_html(year, r, emp):
    esc = html.escape
    ein = emp['employerEin']
    ein_s = f'{ein[:2]}-{ein[2:]}' if len(ein) == 9 else ein
    return ''.join([
        f'<!doctype html><html><head><meta charset="utf-8"><title>1099-NEC {year} — {esc(r["payeeName"])}</title>'
        f'<style>{_FORM_CSS}</style></head><body>',
        f'<h1>Form 1099-NEC Nonemployee Compensation — {year}</h1>',
        '<div class="sub">Copy B — for the recipient. TIN truncated as permitted on recipient copies.</div>',
        '<div class="grid">',
        _box('PAYER’S name and address', f"{emp['employerName']} {emp['employerAddress']}".strip() or 'NOT SET', 'w2'),
        _box('PAYER’S TIN', ein_s or 'NOT SET'),
        _box('RECIPIENT’S TIN', r['tinMasked'] or 'NOT ON FILE'),
        _box('RECIPIENT’S name', r['payeeName'], 'w2'),
        _box('Street address, city, state, ZIP', r['address'], 'w2'),
        _box('1  Nonemployee compensation', r['total'], 'w2', True),
        _box('4  Federal income tax withheld', 0, '', True),
        _box('Payments included', r['payments']),
        '</div>',
        '<div class="note">Generated by HRMS from contractor payment records. Review before use. File Copy A with the '
        'IRS electronically (IRIS / FIRE); this document is not an official IRS form.</div></body></html>',
    ])


def generate_1099(year, actor):
    rows, th = contractor_summary(year)
    emp = employer_info()
    due = [r for r in rows if r['requires1099']]
    files = []
    for r in due:
        content = render_1099_html(year, r, emp)
        files.append(_store_filing('1099NEC', year, r['payeeEmail'] or '',
                                   f'1099NEC_{year}_{_safe_file(r["payeeName"])}.html', 'text/html', content, 1, actor))
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(['tax_year', 'payer_tin', 'recipient_name', 'recipient_tin_masked', 'box1_nonemployee_comp',
                'payments', 'form_required'])
    for r in rows:
        w.writerow([year, emp['employerEin'], _csv_cell(r['payeeName']), r['tinMasked'], f"{Decimal(str(r['total'])):.2f}",
                    r['payments'], 'yes' if r['requires1099'] else f'no (< ${th:,.0f})'])
    w.writerow([])
    w.writerow(['NOTE', 'TINs masked. File 1099-NEC Copy A through IRS IRIS / FIRE after review.'])
    summary = _store_filing('1099NEC', year, '', f'1099NEC_{year}_summary.csv', 'text/csv', buf.getvalue(), len(due), actor)
    return {'forms': files, 'summary': summary, 'rows': rows, 'threshold': float(th)}


def filing_out(f):
    return {'id': f.id, 'kind': f.kind, 'period': f.period, 'email': f.email, 'fileName': f.file_name,
            'mime': f.file_mime, 'rows': f.row_count, 'sha256': f.sha256, 'generatedBy': f.generated_by,
            'generatedAt': f.generated_at.isoformat() if f.generated_at else None}


# ═════════════════════════════════════════════════════════════════════════
# Contractor payments
# ═════════════════════════════════════════════════════════════════════════
def payment_out(p):
    return {'id': p.id, 'payeeName': p.payee_name, 'payeeEmail': p.payee_email, 'tinMasked': mask_tin(p.tin_last4),
            'tinOnFile': bool(p.tin_enc), 'address': p.address, 'amount': _f(p.amount),
            'paidOn': p.paid_on.isoformat() if p.paid_on else None, 'description': p.description,
            'createdBy': p.created_by, 'createdAt': p.created_at.isoformat() if p.created_at else None}


def _clean_tin(body):
    """(digits, kind) or (None, None) when not supplied. Raises Invalid."""
    raw = body.get('tin')
    if raw in (None, ''):
        return None, None
    kind = body.get('tinType') or ('ein' if re.fullmatch(r'\s*\d{2}-\d{7}\s*', str(raw)) else 'ssn')
    if kind == 'ein':
        d = normalize_ein(raw)
        if not d:
            raise Invalid('Enter a valid EIN (12-3456789).')
        return d, 'ein'
    if kind == 'ssn':
        d = normalize_ssn(raw)
        if not d:
            raise Invalid('Enter a valid SSN (123-45-6789).')
        return d, 'ssn'
    raise Invalid('TIN type must be ssn or ein.')


def _apply_payment(p, body, partial):
    def has(k):
        return (k in body) or not partial
    if has('payeeName'):
        p.payee_name = _text(body.get('payeeName'), 'Payee name', 255, required=True)
    if has('payeeEmail'):
        p.payee_email = _email(body.get('payeeEmail'), 'Payee email', required=False)
    if has('address'):
        p.address = _text(body.get('address'), 'Address', 500)
    if has('amount'):
        amt = _dec(body.get('amount'), 'Amount', Decimal('0.01'), 10000000)
        p.amount = amt
    if has('paidOn'):
        d = _date(body.get('paidOn'), 'Paid on')
        if d.year < 2000 or d > today() + timedelta(days=366):
            raise Invalid('Paid on date is out of range.')
        p.paid_on = d
    if has('description'):
        p.description = _text(body.get('description'), 'Description', 255)
    tin, _ = _clean_tin(body)
    return tin


# ═════════════════════════════════════════════════════════════════════════
# Views
# ═════════════════════════════════════════════════════════════════════════
def _err_or(fn):
    """Turn Invalid into a 400 response."""
    def wrapper(request, *a, **kw):
        try:
            return fn(request, *a, **kw)
        except Invalid as e:
            return _bad(e)
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


@api_view(['GET'])
@_err_or
def us_meta(request):
    email, user, err = security.require(request, None)
    if err:
        return err
    ensure_seeded()
    can = security.has_perm(user, MANAGE)
    out = {'canManage': can, 'canFile': security.has_perm(user, FILINGS), 'year': today().year,
           'filingStatuses': [{'value': k, 'label': STATUS_LABELS[k]} for k in FILING_STATUSES],
           'frequencies': [{'value': k, 'label': FREQ_LABELS[k], 'periods': v} for k, v in PERIODS.items()],
           'states': list(US_STATES), 'verifyNote': VERIFY_NOTE}
    if can:
        out['settings'] = employer_info()
    return Response(out)


@api_view(['GET', 'PUT'])
@_err_or
def us_settings(request):
    if request.method == 'GET':
        email, user, err = security.require(request, MANAGE)
        if err:
            return err
        return Response(employer_info())
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    b = _body(request)
    changes = {}
    if 'employerName' in b:
        changes['us_employer_name'] = _text(b['employerName'], 'Employer name', 200)
    if 'employerEin' in b:
        v = str(b['employerEin'] or '').strip()
        if v:
            v = normalize_ein(v)
            if not v:
                raise Invalid('Enter a valid EIN (12-3456789).')
        changes['us_employer_ein'] = v or ''
    if 'employerAddress' in b:
        changes['us_employer_address'] = _text(b['employerAddress'], 'Employer address', 400)
    if 'stateIds' in b:
        sid = b['stateIds'] if isinstance(b['stateIds'], dict) else None
        if sid is None:
            raise Invalid('State IDs must be an object {state: id}.')
        clean = {}
        for k, v in sid.items():
            k = str(k).upper()
            if k not in US_STATES:
                raise Invalid(f'Unknown state {k[:4]}.')
            if v:
                clean[k] = _text(v, f'{k} employer state ID', 30)
        changes['us_employer_state_ids'] = json.dumps(clean, sort_keys=True)
    for key, setting in (('biweeklyAnchor', 'us_biweekly_anchor'), ('weeklyAnchor', 'us_weekly_anchor')):
        if key in b:
            changes[setting] = _date(b[key], key).isoformat()
    if 'payLagDays' in b:
        changes['us_pay_lag_days'] = str(_int(b['payLagDays'], 'Pay lag days', 0, 31))
    if 'stripIndiaStatutory' in b:
        changes['us_strip_india_statutory'] = '1' if _bool(b['stripIndiaStatutory'], 'stripIndiaStatutory') else '0'
    if 'threshold1099' in b:
        v = b['threshold1099']
        changes['us_1099_threshold'] = str(_dec(v, '1099 threshold', 0, 1000000)) if v not in (None, '') else ''
    desc = {v[0]: v[1] for v in EMPLOYER_KEYS.values()}
    for k, v in changes.items():
        set_setting(k, v, desc.get(k, ''))
    security.audit('us_settings_updated', 'PayrollSetting', 'us', request, email, security.display_name(user, email),
                   {k: v for k, v in changes.items()})
    return Response(employer_info())


@api_view(['GET'])
@_err_or
def us_employees(request):
    email, user, err = security.require(request, MANAGE)
    if err:
        return err
    from ..models import UsW4Declaration, UserProfile
    year = _year(request.GET.get('year'))
    ensure_seeded()
    rows = []
    for e in us_employee_emails():
        w = w4_for(e, year)
        comp = _active_comp(e)
        p = UserProfile.objects.filter(email__iexact=e).first()
        exact = UsW4Declaration.objects.filter(email__iexact=e, year=year).exists()
        rows.append({
            'email': e, 'name': _name(e), 'department': (p.department if p else '') or '',
            'currency': (comp.currency if comp else ''), 'payFrequency': (comp.pay_frequency if comp else ''),
            'annualPay': _f(comp.annual_ctc) if comp else 0.0,
            'w4Status': 'current' if exact else ('carried' if w else 'missing'),
            'w4Year': w.year if w else None, 'filingStatus': w.filing_status if w else '',
            'workState': (w.work_state if w else '') or '', 'exempt': bool(w and w.exempt),
            'ssnMasked': mask_tin(w.ssn_last4) if w else '', 'signedAt': w.signed_at.isoformat() if w and w.signed_at else None,
            'warnings': _employee_warnings(e, year, w, comp),
        })
    return Response({'year': year, 'employees': rows})


@api_view(['GET', 'PUT'])
@_err_or
def us_employee_w4(request, email):
    target = _email(email)
    year = _year(request.GET.get('year') or _body(request).get('year'))
    if request.method == 'GET':
        actor, user, err = security.require(request, MANAGE)
        if err:
            return err
        return Response({'email': target, 'name': _name(target), 'w4': _w4_view(target, year)})
    actor, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    row, msg = save_w4(target, year, _body(request), request, actor, by_employee=False)
    if msg:
        return _bad(msg)
    return Response({'email': target, 'name': _name(target), 'w4': w4_out(row)})


@api_view(['POST'])
@_err_or
def us_employee_preview(request, email):
    actor, user, err = security.require(request, MANAGE)
    if err:
        return err
    b = _body(request)
    return Response(_preview(_email(email), b, _year(b.get('year'))))


@api_view(['GET', 'PUT'])
@_err_or
def me_w4(request):
    year = _year(request.GET.get('year') or _body(request).get('year'))
    if request.method == 'GET':
        email, user, err = security.require(request, None)
        if err:
            return err
        return Response({'email': email, 'name': security.display_name(user, email), 'w4': _w4_view(email, year),
                         'states': list(US_STATES)})
    email, user, err = security.require(request, None, fresh=True)
    if err:
        return err
    row, msg = save_w4(email, year, _body(request), request, email, by_employee=True)
    if msg:
        return _bad(msg)
    return Response({'email': email, 'w4': w4_out(row), 'message': 'Your W-4 was signed and saved.'})


@api_view(['POST'])
@_err_or
def me_w4_preview(request):
    email, user, err = security.require(request, None)
    if err:
        return err
    b = _body(request)
    b = {k: b[k] for k in ('w4', 'wages', 'payFrequency') if k in b}
    return Response(_preview(email, b, _year(_body(request).get('year'))))


@api_view(['GET'])
@_err_or
def me_us_forms(request):
    email, user, err = security.require(request, None)
    if err:
        return err
    from ..models import StatutoryFiling
    rows = StatutoryFiling.objects.filter(kind__in=('W2', '1099NEC'), email__iexact=email).order_by('-generated_at', '-id')[:50]
    return Response({'forms': [filing_out(f) for f in rows]})


@api_view(['GET'])
@_err_or
def me_us_form_download(request, pk):
    email, user, err = security.require(request, None, fresh=True)
    if err:
        return err
    from ..models import StatutoryFiling
    f = StatutoryFiling.objects.filter(pk=pk, kind__in=('W2', '1099NEC')).first()
    if not f or (f.email or '').lower() != email:
        return _bad('Form not found.', 404)
    security.audit('us_form_downloaded', 'StatutoryFiling', f.id, request, email, security.display_name(user, email),
                   {'kind': f.kind, 'period': f.period}, 'self-service')
    return Response({'fileName': f.file_name, 'mime': f.file_mime, 'content': f.content})


# ── tax tables ────────────────────────────────────────────────────────────
def table_out(t):
    d = t.data or {}
    return {'id': t.id, 'year': _safe_int(t.period, 0), 'kind': t.kind, 'region': t.region, 'data': d,
            'notes': t.notes, 'verified': bool(d.get('verified')), 'verifiedBy': d.get('verified_by', ''),
            'verifiedAt': d.get('verified_at'), 'updatedBy': t.updated_by,
            'updatedAt': t.updated_at.isoformat() if t.updated_at else None}


@api_view(['GET', 'POST'])
@_err_or
def us_tax_tables(request):
    from ..models import PayrollTaxTable
    if request.method == 'GET':
        email, user, err = security.require(request, MANAGE)
        if err:
            return err
        ensure_seeded()
        years = sorted({_safe_int(p, 0) for p in PayrollTaxTable.objects.filter(country='US')
                        .values_list('period', flat=True)}, reverse=True)
        year = _year(request.GET.get('year'), default=(years[0] if years else None))
        rows = PayrollTaxTable.objects.filter(country='US', period=str(year)).order_by('kind', 'region')
        out = [table_out(t) for t in rows]
        return Response({'year': year, 'years': years, 'tables': out,
                         'unverified': sum(1 for t in out if not t['verified']), 'verifyNote': VERIFY_NOTE})
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    b = _body(request)
    year = _year(b.get('year'))
    kind = b.get('kind')
    if kind not in ('state', 'suta'):
        raise Invalid('Only state and SUTA tables can be added (federal / FICA / FUTA exist per year).')
    region = str(b.get('region') or '').upper()
    if region not in US_STATES:
        raise Invalid('Choose a US state.')
    data = clean_table(kind, b.get('data') or {})
    if PayrollTaxTable.objects.filter(country='US', period=str(year), kind=kind, region=region).exists():
        raise Invalid(f'A {year} {kind} table for {region} already exists — edit it instead.')
    data.update({'verified': False, 'source': 'entered by payroll'})
    t = PayrollTaxTable.objects.create(country='US', period=str(year), kind=kind, region=region, data=data,
                                       notes=_text(b.get('notes'), 'Notes', 1000), updated_by=email,
                                       updated_at=timezone.now())
    security.audit('us_tax_table_created', 'PayrollTaxTable', t.id, request, email, security.display_name(user, email),
                   {'year': year, 'kind': kind, 'region': region, 'data': data})
    return Response(table_out(t), status=201)


@api_view(['PUT', 'DELETE'])
@_err_or
def us_tax_table_detail(request, pk):
    from ..models import PayrollTaxTable
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    t = PayrollTaxTable.objects.filter(pk=pk, country='US').first()
    if not t:
        return _bad('Table not found.', 404)
    if request.method == 'DELETE':
        if t.kind not in ('state', 'suta'):
            raise Invalid('Federal, FICA and FUTA tables cannot be deleted — edit them instead.')
        snap = {'year': t.period, 'kind': t.kind, 'region': t.region, 'data': t.data}
        t.delete()
        security.audit('us_tax_table_deleted', 'PayrollTaxTable', pk, request, email,
                       security.display_name(user, email), snap)
        return Response({'ok': True})
    b = _body(request)
    before = dict(t.data or {})
    data = clean_table(t.kind, b.get('data') if 'data' in b else before)
    verified = _bool(b.get('verified', before.get('verified', False)), 'verified')
    data['source'] = before.get('source', '')
    data['verified'] = verified
    if verified:
        if not before.get('verified') or 'data' in b:
            data['verified_by'], data['verified_at'] = email, timezone.now().isoformat()
        else:
            data['verified_by'], data['verified_at'] = before.get('verified_by', email), before.get('verified_at')
    t.data = data
    if 'notes' in b:
        t.notes = _text(b.get('notes'), 'Notes', 1000)
    t.updated_by = email
    t.updated_at = timezone.now()
    t.save()
    security.audit('us_tax_table_updated', 'PayrollTaxTable', t.id, request, email, security.display_name(user, email),
                   {'year': t.period, 'kind': t.kind, 'region': t.region, 'before': before, 'after': data})
    return Response(table_out(t))


@api_view(['POST'])
@_err_or
def us_tax_tables_copy(request):
    from ..models import PayrollTaxTable
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    b = _body(request)
    src = _year(b.get('fromYear'))
    dst = _int(b.get('toYear'), 'toYear', 2020, today().year + 1)
    made = 0
    for t in PayrollTaxTable.objects.filter(country='US', period=str(src)):
        data = dict(t.data or {})
        data.update({'verified': False, 'source': f'copied from {src} — update for {dst}'})
        data.pop('verified_by', None)
        data.pop('verified_at', None)
        _, created = PayrollTaxTable.objects.get_or_create(
            country='US', period=str(dst), kind=t.kind, region=t.region,
            defaults={'data': data, 'notes': f'Copied from {src}. {VERIFY_NOTE}', 'updated_by': email,
                      'updated_at': timezone.now()})
        made += int(created)
    security.audit('us_tax_tables_copied', 'PayrollTaxTable', f'{src}->{dst}', request, email,
                   security.display_name(user, email), {'from': src, 'to': dst, 'created': made})
    return Response({'created': made, 'year': dst})


# ── pay calendars / runs ──────────────────────────────────────────────────
@api_view(['GET'])
@_err_or
def us_pay_calendar(request):
    email, user, err = security.require(request, MANAGE)
    if err:
        return err
    from ..models import EmployeeCompensation
    count = _int(request.GET.get('count') or 6, 'count', 1, 26)
    start = _date(request.GET.get('from'), 'from') if request.GET.get('from') else None
    freqs = [request.GET.get('frequency')] if request.GET.get('frequency') else list(PERIODS)
    lag = _safe_int(get_setting('us_pay_lag_days', '0'), 0)
    out = []
    for f in freqs:
        if f not in PERIODS:
            raise Invalid('Unknown pay frequency.')
        heads = EmployeeCompensation.objects.filter(currency__iexact='USD', status='active', pay_frequency=f) \
            .values('email').distinct().count()
        out.append({'frequency': f, 'label': FREQ_LABELS[f], 'periodsPerYear': PERIODS[f], 'usEmployees': heads,
                    'periods': pay_periods(f, count, start, lag_days=lag)})
    return Response({'calendars': out, 'anchors': {'biweekly': _anchor('us_biweekly_anchor').isoformat(),
                                                    'weekly': _anchor('us_weekly_anchor').isoformat()},
                     'note': 'Create a run for one of these periods in the payroll wizard.'})


@api_view(['GET'])
@_err_or
def us_run_warnings(request, pk):
    email, user, err = security.require(request, MANAGE)
    if err:
        return err
    from ..models import PayrollEntry, PayrollRun
    run = PayrollRun.objects.filter(pk=pk).first()
    if not run:
        return _bad('Run not found.', 404)
    year = run_date(run).year
    out = []
    for en in PayrollEntry.objects.filter(run=run):
        comp = _active_comp(en.email)
        if (en.currency or '').upper() != 'USD' and not (comp and comp.currency.upper() == 'USD'):
            continue
        w = w4_for(en.email, year)
        warn = _employee_warnings(en.email, year, w, comp)
        if warn:
            out.append({'email': en.email.lower(), 'name': en.employee_name or _name(en.email), 'warnings': warn})
    return Response({'runId': run.id, 'year': year, 'employees': out})


# ── W-2 / 1099 ─────────────────────────────────────────────────────────────
@api_view(['GET'])
@_err_or
def us_w2_preview(request):
    email, user, err = security.require(request, FILINGS)
    if err:
        return err
    year = _year(request.GET.get('year'))
    data, drafts = w2_data(year)
    return Response({'year': year, 'employees': sorted(data.values(), key=lambda r: r['name'].lower()),
                     'draftPayslips': drafts, 'notice': _W2_NOTICE})


@api_view(['POST'])
@_err_or
def us_w2_generate(request):
    email, user, err = security.require(request, FILINGS, fresh=True)
    if err:
        return err
    b = _body(request)
    year = _year(b.get('year'))
    target = _email(b.get('email')) if b.get('email') else None
    res = generate_w2(year, email, target)
    if not res['forms']:
        return _bad(f'No USD payslips found for {year}.')
    security.audit('us_w2_generated', 'StatutoryFiling', res['summary'].id if res['summary'] else res['forms'][0].id,
                   request, email, security.display_name(user, email),
                   {'year': year, 'forms': len(res['forms']), 'employee': target or 'all'})
    return Response({'year': year, 'forms': [filing_out(f) for f in res['forms']],
                     'summary': filing_out(res['summary']) if res['summary'] else None,
                     'draftPayslips': res['draftPayslips'], 'notice': _W2_NOTICE}, status=201)


@api_view(['POST'])
@_err_or
def us_1099_generate(request):
    email, user, err = security.require(request, FILINGS, fresh=True)
    if err:
        return err
    year = _year(_body(request).get('year'))
    res = generate_1099(year, email)
    security.audit('us_1099_generated', 'StatutoryFiling', res['summary'].id, request, email,
                   security.display_name(user, email), {'year': year, 'forms': len(res['forms'])})
    return Response({'year': year, 'forms': [filing_out(f) for f in res['forms']], 'summary': filing_out(res['summary']),
                     'threshold': res['threshold']}, status=201)


@api_view(['GET'])
@_err_or
def us_filings(request):
    email, user, err = security.require(request, FILINGS)
    if err:
        return err
    from ..models import StatutoryFiling
    qs = StatutoryFiling.objects.filter(kind__in=('W2', '1099NEC'))
    kind = request.GET.get('kind')
    if kind:
        if kind not in ('W2', '1099NEC'):
            raise Invalid('kind must be W2 or 1099NEC.')
        qs = qs.filter(kind=kind)
    if request.GET.get('year'):
        qs = qs.filter(period=str(_year(request.GET.get('year'))))
    return Response({'filings': [filing_out(f) for f in qs.order_by('-generated_at', '-id')[:300]]})


@api_view(['GET'])
@_err_or
def us_filing_download(request, pk):
    email, user, err = security.require(request, FILINGS, fresh=True)
    if err:
        return err
    from ..models import StatutoryFiling
    f = StatutoryFiling.objects.filter(pk=pk, kind__in=('W2', '1099NEC')).first()
    if not f:
        return _bad('Filing not found.', 404)
    security.audit('us_form_downloaded', 'StatutoryFiling', f.id, request, email, security.display_name(user, email),
                   {'kind': f.kind, 'period': f.period, 'file': f.file_name})
    return Response({'fileName': f.file_name, 'mime': f.file_mime, 'content': f.content})


@api_view(['GET', 'POST'])
@_err_or
def us_contractor_payments(request):
    from ..models import ContractorPayment
    if request.method == 'GET':
        email, user, err = security.require(request, MANAGE)
        if err:
            return err
        year = _year(request.GET.get('year'))
        qs = ContractorPayment.objects.filter(paid_on__year=year)
        summary, th = contractor_summary(year)
        return Response({'year': year, 'payments': [payment_out(p) for p in qs[:1000]], 'summary': summary,
                         'threshold': float(th)})
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    b = _body(request)
    p = ContractorPayment(created_by=email, created_at=timezone.now())
    tin = _apply_payment(p, b, partial=False)
    if tin:
        p.tin_enc, p.tin_last4 = security.seal(tin), tin[-4:]
    else:
        prev = ContractorPayment.objects.exclude(tin_enc='')
        prev = (prev.filter(payee_email__iexact=p.payee_email) if p.payee_email
                else prev.filter(payee_name__iexact=p.payee_name)).order_by('-id').first()
        if prev:
            p.tin_enc, p.tin_last4 = prev.tin_enc, prev.tin_last4
    p.save()
    security.audit('us_contractor_payment_created', 'ContractorPayment', p.id, request, email,
                   security.display_name(user, email),
                   {'payee': p.payee_name, 'amount': _f(p.amount), 'paidOn': p.paid_on.isoformat(),
                    'tin': 'set' if tin else ('copied' if p.tin_enc else 'missing')})
    return Response(payment_out(p), status=201)


@api_view(['PATCH', 'DELETE'])
@_err_or
def us_contractor_payment_detail(request, pk):
    from ..models import ContractorPayment
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    p = ContractorPayment.objects.filter(pk=pk).first()
    if not p:
        return _bad('Payment not found.', 404)
    if request.method == 'DELETE':
        snap = {'payee': p.payee_name, 'amount': _f(p.amount), 'paidOn': p.paid_on.isoformat()}
        p.delete()
        security.audit('us_contractor_payment_deleted', 'ContractorPayment', pk, request, email,
                       security.display_name(user, email), snap)
        return Response({'ok': True})
    before = payment_out(p)
    tin = _apply_payment(p, _body(request), partial=True)
    if tin:
        p.tin_enc, p.tin_last4 = security.seal(tin), tin[-4:]
    p.save()
    after = payment_out(p)
    changes = {k: {'from': before[k], 'to': after[k]} for k in ('payeeName', 'payeeEmail', 'address', 'amount',
                                                                'paidOn', 'description') if before[k] != after[k]}
    if tin:
        changes['tin'] = 'changed'
    security.audit('us_contractor_payment_updated', 'ContractorPayment', p.id, request, email,
                   security.display_name(user, email), changes)
    return Response(after)
