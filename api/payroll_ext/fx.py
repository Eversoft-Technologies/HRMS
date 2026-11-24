"""Exchange rates and multi-currency consolidation (CFO dashboard).

``ExchangeRate`` rows say "1 ``currency`` = ``rate`` ``reporting_currency``"
as of a date. ``convert(amount, currency, to, on_date)`` uses the latest rate
on or before the date — directly, inverted, or through one common currency —
and returns None when no rate is known (callers show a missing-rate warning;
nothing is ever silently converted at 1:1).

The reporting currency is the payroll setting ``reporting_currency`` (default
INR). Fetching rates from a public API is optional, OFF by default (setting
``fx_auto_fetch`` = 1 to enable) and uses a fixed HTTPS endpoint from Django
settings (``HRMS_FX_API_URL``) — the URL is never taken from a request.
"""
import logging
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from django.conf import settings
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import security
from .us_payroll import Invalid, _bad, _body, _bool, _date, _err_or, _int, get_setting, set_setting, today

logger = logging.getLogger(__name__)

MANAGE = 'payroll.us.manage'
VIEW = ('payroll.us.manage', 'payroll.view')
DEFAULT_REPORTING = 'INR'
DEFAULT_API = 'https://open.er-api.com/v6/latest/{base}'
FETCH_TIMEOUT = (3, 6)          # connect, read seconds
_CUR_RE = re.compile(r'^[A-Z]{3}$')
COUNTRY_BY_CURRENCY = {'USD': 'United States', 'INR': 'India', 'GBP': 'United Kingdom', 'EUR': 'Eurozone',
                       'CAD': 'Canada', 'AUD': 'Australia', 'SGD': 'Singapore', 'AED': 'United Arab Emirates',
                       'JPY': 'Japan', 'CHF': 'Switzerland', 'NZD': 'New Zealand', 'ZAR': 'South Africa',
                       'MXN': 'Mexico', 'PHP': 'Philippines', 'MYR': 'Malaysia'}
Q6 = Decimal('0.000001')
Q2 = Decimal('0.01')


def reporting_currency():
    v = (get_setting('reporting_currency', DEFAULT_REPORTING) or DEFAULT_REPORTING).upper()
    return v if _CUR_RE.match(v) else DEFAULT_REPORTING


def auto_fetch_enabled():
    return get_setting('fx_auto_fetch', '0') == '1'


def clean_currency(v, field='currency'):
    s = str(v or '').strip().upper()
    if not _CUR_RE.match(s):
        raise Invalid(f'{field} must be a 3-letter ISO currency code.')
    return s


# ── rate lookup ──────────────────────────────────────────────────────────
def rates_on(on_date):
    """{(currency, reporting): (rate, as_of)} — latest row on/before the date per pair."""
    from ..models import ExchangeRate
    out = {}
    for r in ExchangeRate.objects.filter(as_of__lte=on_date).order_by('currency', 'reporting_currency', '-as_of', '-id'):
        key = (r.currency.upper(), r.reporting_currency.upper())
        if key not in out and r.rate and r.rate > 0:
            out[key] = (Decimal(str(r.rate)), r.as_of)
    return out


def find_rate(currency, to, on_date, table=None):
    """(rate, as_of, how) such that amount_in_currency × rate = amount_in_to, or
    (None, None, None). ``how`` is direct | inverse | via XXX."""
    currency, to = currency.upper(), to.upper()
    if currency == to:
        return Decimal('1'), on_date, 'same'
    t = table if table is not None else rates_on(on_date)
    if (currency, to) in t:
        r, d = t[(currency, to)]
        return r, d, 'direct'
    if (to, currency) in t:
        r, d = t[(to, currency)]
        return Decimal('1') / r, d, 'inverse'
    # one hop through a common currency
    edges = defaultdict(dict)
    for (a, b), (r, d) in t.items():
        edges[a][b] = (r, d)
        edges[b][a] = (Decimal('1') / r, d)
    best = None
    for mid, (r1, d1) in edges.get(currency, {}).items():
        if to in edges.get(mid, {}):
            r2, d2 = edges[mid][to]
            asof = min(d1, d2)
            if best is None or asof > best[1]:
                best = (r1 * r2, asof, f'via {mid}')
    return best if best else (None, None, None)


def convert(amount, currency, to, on_date=None, table=None):
    """Converted Decimal (2 dp) or None when no rate is known."""
    on_date = on_date or today()
    rate, _, _ = find_rate(currency, to, on_date, table)
    if rate is None:
        return None
    return (Decimal(str(amount or 0)) * rate).quantize(Q2, rounding=ROUND_HALF_UP)


def rate_out(r):
    return {'id': r.id, 'currency': r.currency, 'reportingCurrency': r.reporting_currency, 'rate': float(r.rate),
            'asOf': r.as_of.isoformat(), 'source': r.source, 'updatedBy': r.updated_by}


def currencies_in_use():
    from ..models import EmployeeCompensation, PayrollEntry
    cur = {c.upper() for c in EmployeeCompensation.objects.values_list('currency', flat=True) if c}
    cur |= {c.upper() for c in PayrollEntry.objects.values_list('currency', flat=True).distinct() if c}
    return sorted(c for c in cur if _CUR_RE.match(c))


# ── public API fetch (optional) ─────────────────────────────────────────
def fetch_rates(actor):
    """Fetch today's rates for the currencies in use into the reporting
    currency. Returns (saved rows, error)."""
    import requests
    from ..models import ExchangeRate
    rep = reporting_currency()
    url_tpl = getattr(settings, 'HRMS_FX_API_URL', DEFAULT_API) or DEFAULT_API
    if not str(url_tpl).startswith('https://'):
        return [], 'The FX API URL must use HTTPS.'
    try:
        resp = requests.get(url_tpl.format(base=rep), timeout=FETCH_TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        logger.warning('FX fetch failed: %s', type(exc).__name__)
        return [], 'Could not reach the exchange-rate service. Enter rates manually.'
    rates = payload.get('rates') if isinstance(payload, dict) else None
    if not isinstance(rates, dict):
        return [], 'The exchange-rate service returned an unexpected response.'
    on = today()
    saved = []
    for cur in currencies_in_use():
        if cur == rep:
            continue
        try:
            per_rep = Decimal(str(rates.get(cur)))
        except (InvalidOperation, TypeError):
            continue
        if not per_rep.is_finite() or per_rep <= 0:
            continue
        rate = (Decimal('1') / per_rep).quantize(Q6, rounding=ROUND_HALF_UP)
        if rate <= 0:
            continue
        row, _ = ExchangeRate.objects.update_or_create(
            currency=cur, reporting_currency=rep, as_of=on,
            defaults={'rate': rate, 'source': 'api', 'updated_by': actor})
        saved.append(row)
    return saved, ''


# ── CFO dashboard ─────────────────────────────────────────────────────────
def _z():
    return {'gross': Decimal('0'), 'employerCost': Decimal('0'), 'net': Decimal('0'), 'emails': set()}


def _fmt(b):
    return {'gross': float(b['gross'].quantize(Q2)), 'employerCost': float(b['employerCost'].quantize(Q2)),
            'net': float(b['net'].quantize(Q2)), 'headcount': len(b['emails'])}


def dashboard(year, rep=None, months=None):
    """Per-month totals by currency plus consolidated totals in ``rep``.

    employerCost = gross + employer contributions (PayrollEntry.total_ctc).
    Amounts in a currency without a rate are left out of the consolidated
    totals and listed in ``warnings``."""
    from ..models import PayrollEntry
    rep = rep or reporting_currency()
    qs = PayrollEntry.objects.select_related('run').exclude(run__status='cancelled') \
        .filter(run__period_end__year=year)
    if months:
        qs = qs.filter(run__period_end__month__in=months)
    by_month = defaultdict(lambda: defaultdict(_z))
    cons_month = defaultdict(_z)
    dept, country, by_cur = defaultdict(_z), defaultdict(_z), defaultdict(_z)
    total = _z()
    missing = defaultdict(set)
    rate_cache, rates_used = {}, {}
    for en in qs.iterator():
        run = en.run
        month = run.period_end.strftime('%Y-%m')
        cur = (en.currency or 'INR').upper()
        gross = Decimal(str(en.gross_earnings or 0))
        cost = Decimal(str(en.total_ctc or 0)) or gross + Decimal(str(en.employer_contribution or 0))
        net = Decimal(str(en.net_pay or 0))
        email = en.email.lower()
        b = by_month[month][cur]
        b['gross'] += gross
        b['employerCost'] += cost
        b['net'] += net
        b['emails'].add(email)
        c = by_cur[cur]
        c['gross'] += gross
        c['employerCost'] += cost
        c['net'] += net
        c['emails'].add(email)
        if run.period_end not in rate_cache:
            rate_cache[run.period_end] = rates_on(run.period_end)
        rate, asof, how = find_rate(cur, rep, run.period_end, rate_cache[run.period_end])
        if rate is None:
            missing[cur].add(month)
            continue
        if cur != rep:
            rates_used[f'{cur}:{month}'] = {'currency': cur, 'month': month, 'rate': float(rate.quantize(Q6)),
                                            'asOf': asof.isoformat(), 'how': how}
        for bucket in (cons_month[month], dept[en.department or 'Unassigned'],
                       country[COUNTRY_BY_CURRENCY.get(cur, cur)], total):
            bucket['gross'] += gross * rate
            bucket['employerCost'] += cost * rate
            bucket['net'] += net * rate
            bucket['emails'].add(email)
    months_out = []
    for m in sorted(by_month):
        months_out.append({'month': m,
                           'byCurrency': [dict(currency=k, **_fmt(v)) for k, v in sorted(by_month[m].items())],
                           'consolidated': _fmt(cons_month[m]),
                           'missing': sorted(k for k, ms in missing.items() if m in ms)})
    warnings = [f'No {cur}→{rep} exchange rate on or before the pay period for {", ".join(sorted(ms))} — '
                f'excluded from consolidated totals.' for cur, ms in sorted(missing.items())]
    return {
        'year': year, 'reportingCurrency': rep, 'months': months_out,
        'byCurrency': [dict(currency=k, **_fmt(v)) for k, v in sorted(by_cur.items())],
        'byDepartment': sorted([dict(department=k, **_fmt(v)) for k, v in dept.items()], key=lambda r: -r['employerCost']),
        'byCountry': sorted([dict(country=k, **_fmt(v)) for k, v in country.items()], key=lambda r: -r['employerCost']),
        'totals': _fmt(total), 'warnings': warnings,
        'missingRates': [{'currency': c, 'months': sorted(ms)} for c, ms in sorted(missing.items())],
        'ratesUsed': sorted(rates_used.values(), key=lambda r: (r['month'], r['currency'])),
        'note': 'Country is derived from the pay currency. Employer cost = gross + employer contributions.',
    }


# ── views ─────────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@_err_or
def fx_rates(request):
    from ..models import ExchangeRate
    if request.method == 'GET':
        email, user, err = security.require(request, VIEW)
        if err:
            return err
        qs = ExchangeRate.objects.all()
        if request.GET.get('currency'):
            qs = qs.filter(currency=clean_currency(request.GET.get('currency')))
        return Response({'reportingCurrency': reporting_currency(), 'autoFetch': auto_fetch_enabled(),
                         'currenciesInUse': currencies_in_use(),
                         'canManage': security.has_perm(user, MANAGE),
                         'rates': [rate_out(r) for r in qs.order_by('-as_of', 'currency')[:500]]})
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    b = _body(request)
    cur = clean_currency(b.get('currency'))
    rep = clean_currency(b.get('reportingCurrency') or reporting_currency(), 'reportingCurrency')
    if cur == rep:
        raise Invalid('The currency and the reporting currency must differ.')
    try:
        rate = Decimal(str(b.get('rate')).strip())
    except (InvalidOperation, ValueError):
        raise Invalid('Rate must be a number.')
    if isinstance(b.get('rate'), bool) or not rate.is_finite() or rate <= 0 or rate > Decimal('1000000000'):
        raise Invalid('Rate must be greater than 0.')
    rate = rate.quantize(Q6, rounding=ROUND_HALF_UP)
    if rate <= 0:
        raise Invalid('Rate is too small (6 decimal places are kept).')
    as_of = _date(b.get('asOf') or today().isoformat(), 'asOf')
    if as_of.year < 2000 or (as_of - today()).days > 31:
        raise Invalid('The rate date is out of range.')
    row, created = ExchangeRate.objects.update_or_create(
        currency=cur, reporting_currency=rep, as_of=as_of,
        defaults={'rate': rate, 'source': 'manual', 'updated_by': email})
    security.audit('fx_rate_saved', 'ExchangeRate', row.id, request, email, security.display_name(user, email),
                   {'currency': cur, 'reporting': rep, 'rate': str(rate), 'asOf': as_of.isoformat(),
                    'created': created})
    return Response(rate_out(row), status=201 if created else 200)


@api_view(['DELETE'])
@_err_or
def fx_rate_detail(request, pk):
    from ..models import ExchangeRate
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    row = ExchangeRate.objects.filter(pk=pk).first()
    if not row:
        return _bad('Rate not found.', 404)
    snap = rate_out(row)
    row.delete()
    security.audit('fx_rate_deleted', 'ExchangeRate', pk, request, email, security.display_name(user, email), snap)
    return Response({'ok': True})


@api_view(['GET', 'PUT'])
@_err_or
def fx_settings(request):
    if request.method == 'GET':
        email, user, err = security.require(request, VIEW)
        if err:
            return err
        return Response({'reportingCurrency': reporting_currency(), 'autoFetch': auto_fetch_enabled()})
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    b = _body(request)
    changes = {}
    if 'reportingCurrency' in b:
        changes['reporting_currency'] = clean_currency(b['reportingCurrency'], 'reportingCurrency')
    if 'autoFetch' in b:
        changes['fx_auto_fetch'] = '1' if _bool(b['autoFetch'], 'autoFetch') else '0'
    for k, v in changes.items():
        set_setting(k, v, {'reporting_currency': 'Currency for consolidated payroll reporting',
                           'fx_auto_fetch': 'Fetch exchange rates from a public API (1/0)'}[k])
    security.audit('fx_settings_updated', 'PayrollSetting', 'fx', request, email, security.display_name(user, email),
                   changes)
    return Response({'reportingCurrency': reporting_currency(), 'autoFetch': auto_fetch_enabled()})


@api_view(['POST'])
@_err_or
def fx_fetch(request):
    email, user, err = security.require(request, MANAGE, fresh=True)
    if err:
        return err
    if not auto_fetch_enabled():
        return _bad('Fetching rates from the internet is switched off. Turn it on in FX settings, or enter rates manually.', 409)
    rows, error = fetch_rates(email)
    if error:
        return _bad(error, 502)
    security.audit('fx_rates_fetched', 'ExchangeRate', 'api', request, email, security.display_name(user, email),
                   {'count': len(rows), 'currencies': [r.currency for r in rows]})
    return Response({'saved': [rate_out(r) for r in rows]})


@api_view(['GET'])
@_err_or
def fx_convert(request):
    email, user, err = security.require(request, VIEW)
    if err:
        return err
    g = request.GET
    try:
        amount = Decimal(str(g.get('amount') or '0'))
    except InvalidOperation:
        raise Invalid('amount must be a number.')
    if not amount.is_finite() or abs(amount) > Decimal('1000000000000'):
        raise Invalid('amount is out of range.')
    cur = clean_currency(g.get('from'), 'from')
    to = clean_currency(g.get('to') or reporting_currency(), 'to')
    on = _date(g.get('date'), 'date') if g.get('date') else today()
    rate, asof, how = find_rate(cur, to, on)
    if rate is None:
        return Response({'amount': float(amount), 'from': cur, 'to': to, 'date': on.isoformat(), 'converted': None,
                         'warning': f'No {cur}→{to} rate on or before {on.isoformat()}.'})
    return Response({'amount': float(amount), 'from': cur, 'to': to, 'date': on.isoformat(),
                     'converted': float((amount * rate).quantize(Q2, rounding=ROUND_HALF_UP)),
                     'rate': float(rate.quantize(Q6)), 'asOf': asof.isoformat(), 'how': how})


@api_view(['GET'])
@_err_or
def fx_dashboard(request):
    email, user, err = security.require(request, VIEW)
    if err:
        return err
    cur_year = today().year
    year = _int(request.GET.get('year') or cur_year, 'year', 2000, cur_year + 1)
    rep = clean_currency(request.GET.get('currency'), 'currency') if request.GET.get('currency') else None
    return Response(dashboard(year, rep))
