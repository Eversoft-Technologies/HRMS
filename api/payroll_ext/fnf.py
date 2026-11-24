"""Full & Final settlement: separations, clearance checklist, F&F computation,
approval (maker-checker), settlement statement and No-Dues certificate.

Everything needs ``payroll.fnf.manage`` (a reporting manager may also clear
the "Manager" items of their own reports). Initiating, clearing, computing,
approving and marking paid need a fresh sign-in; the approver can be neither
the initiator nor the employee. Every action is written to PayrollAuditLog.

Computation (every line carries its formula in ``computation.items``)
-------------------------------------------------------------------
* Salary for the exit month = last drawn monthly gross × payable days / days in
  the month (payable days default to the day-of-month of the last working day).
* Gratuity (Payment of Gratuity Act, 1972): eligible after 5 completed years;
  4 years + 240 days (configurable) counts as 5; death / disablement are
  exempt from the 5-year rule. A final part-year of more than 6 months counts
  as a full year. Amount = 15 × last drawn (basic + DA) × years / 26, capped at
  ₹20,00,000 (``fnf_policy.gratuity_cap``).
* Leave encashment = unused earned-leave days (leave module, this calendar
  year) × basic / divisor (``fnf_policy.leave_encashment_divisor``, 30).
* Notice shortfall recovery = gross / 30 × (required − served) days unless the
  notice was waived / bought out.
* Recoveries: outstanding loan / advance principal, clearance recoveries.
* Additions: approved but unpaid reimbursement claims.
* TDS on F&F = taxable part × rate, where taxable = exit-month salary + leave
  encashment + gratuity above the exemption limit − notice recovery; the rate
  is the employee's average TDS rate this financial year (TDS ÷ gross of their
  payslips) or ``fnf_policy.tds_flat_percent`` (10 %) when there is no history.
  This is a simplification — HR should confirm against the actual tax
  computation before paying.
"""
import calendar
import hashlib
import json
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from django.utils.html import escape
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import D, security
from .ess import (_err, _fmt_amt, _iso, _norm, _today, clean_text, current_fy, encashable_leave_days, fy_range,
                  money, parse_amount, parse_date, parse_int, person_name, refresh_loan, salary_basis, setting_json,
                  _company_name)

GRATUITY_NUM = Decimal('15')
GRATUITY_DEN = Decimal('26')
PERM = 'payroll.fnf.manage'
SEPARATION_TYPES = ('resignation', 'termination', 'retirement', 'death', 'disablement', 'absconding', 'other')
DEFAULT_FNF_POLICY = {
    'gratuity_cap': 2000000,
    'gratuity_min_days_in_fifth_year': 240,
    'gratuity_exempt_limit': 2000000,
    'leave_encashment_divisor': 30,
    'notice_divisor': 30,
    'tds_flat_percent': 10,
    'tds_mode': 'average',          # average | flat
}
DEFAULT_CLEARANCE = [
    ('IT', 'Laptop and equipment returned'),
    ('IT', 'Email and system accounts disabled'),
    ('Finance', 'Advances, loans and dues reconciled'),
    ('HR', 'ID card and documents returned'),
    ('Admin', 'Access card returned'),
    ('Manager', 'Knowledge transfer / handover completed'),
]
DEPARTMENTS = ('IT', 'Finance', 'HR', 'Admin', 'Manager', 'Other')


def fnf_policy():
    p = setting_json('fnf_policy', DEFAULT_FNF_POLICY)
    out = dict(DEFAULT_FNF_POLICY)
    for k in DEFAULT_FNF_POLICY:
        if k in p and k != 'tds_mode':
            try:
                out[k] = float(p[k])
            except (TypeError, ValueError):
                pass
    out['tds_mode'] = 'flat' if str(p.get('tds_mode')).lower() == 'flat' else 'average'
    return out


def _add_years(d, n):
    try:
        return d.replace(year=d.year + n)
    except ValueError:                       # 29 Feb
        return d.replace(year=d.year + n, day=28)


def _add_months(d, n):
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def service_length(doj, last_day, min_days_fifth=240):
    """Continuous service from ``doj`` to ``last_day`` (inclusive).
    fullYears — completed years; remDays — days after the last anniversary;
    creditedYears — fullYears + 1 when the remainder is more than 6 months;
    eligible5 — 5 completed years, or 4 years + ``min_days_fifth`` days."""
    if not doj or not last_day or last_day < doj:
        return {'fullYears': 0, 'remDays': 0, 'creditedYears': 0, 'totalDays': 0, 'eligible5': False}
    end = last_day + timedelta(days=1)                       # exclusive
    years = end.year - doj.year - ((end.month, end.day) < (doj.month, doj.day))
    anniv = _add_years(doj, years)
    rem = (end - anniv).days
    credited = years + (1 if end > _add_months(anniv, 6) else 0)
    eligible = years >= 5 or (years == 4 and rem >= int(min_days_fifth))
    return {'fullYears': years, 'remDays': rem, 'creditedYears': credited, 'totalDays': (end - doj).days,
            'eligible5': eligible}


def gratuity(basic_da, doj, last_day, separation_type, pol=None):
    pol = pol or fnf_policy()
    svc = service_length(doj, last_day, pol['gratuity_min_days_in_fifth_year'])
    exempt_rule = separation_type in ('death', 'disablement')
    eligible = svc['eligible5'] or (exempt_rule and svc['totalDays'] > 0)
    years = svc['creditedYears']
    if svc['eligible5'] and years < 5:
        years = 5
    raw = (GRATUITY_NUM * D(basic_da) * years / GRATUITY_DEN).quantize(Decimal('0.01')) if eligible else Decimal('0')
    cap = D(pol['gratuity_cap'])
    amount = min(raw, cap) if cap > 0 else raw
    return {'service': svc, 'eligible': eligible, 'years': years if eligible else 0, 'raw': raw, 'amount': amount,
            'capped': raw > amount, 'cap': cap, 'exemptFromFiveYearRule': exempt_rule}


def average_tds_rate(email, as_of):
    from ..models import Payslip
    start, end = fy_range(current_fy(as_of))
    gross = tds = Decimal('0')
    for ps in Payslip.objects.filter(email__iexact=email, status__in=('approved', 'paid'),
                                     run__period_start__gte=start, run__period_start__lte=end).defer('file_data'):
        gross += D(ps.gross_earnings)
        tds += sum((D(l.get('amount')) for l in (ps.deductions_data or [])
                    if str(l.get('code')).upper() in ('TDS', 'INCOME_TAX', 'TDS_194J')), Decimal('0'))
    if gross <= 0:
        return None
    return (tds / gross * 100).quantize(Decimal('0.01'))


# ── serialisation ─────────────────────────────────────────────────────────
def clearance_dict(c):
    return {'id': c.id, 'department': c.department, 'item': c.item, 'status': c.status,
            'recoveryAmount': money(c.recovery_amount), 'clearedBy': c.cleared_by, 'clearedAt': _iso(c.cleared_at),
            'note': c.note}


def separation_dict(s, full=True, money_view=True):
    comp = s.computation or {}
    out = {'id': s.id, 'email': s.email, 'employeeName': s.employee_name, 'separationType': s.separation_type,
           'resignationDate': _iso(s.resignation_date), 'lastWorkingDay': _iso(s.last_working_day),
           'noticeDaysRequired': s.notice_days_required, 'noticeDaysServed': s.notice_days_served,
           'noticeBuyout': s.notice_buyout, 'reason': s.reason, 'status': s.status, 'createdBy': s.created_by,
           'approvedBy': s.approved_by, 'approvedAt': _iso(s.approved_at), 'createdAt': _iso(s.created_at),
           'paidAt': comp.get('paidAt'), 'paymentReference': comp.get('paymentReference', '')}
    if money_view:
        out['netPayable'] = money(s.net_payable)
    clr = list(s.clearances.all())
    out['clearanceDone'] = sum(1 for c in clr if c.status in ('cleared', 'waived'))
    out['clearanceTotal'] = len(clr)
    if full:
        out['clearances'] = [clearance_dict(c) for c in clr]
        if money_view:
            out['computation'] = {k: v for k, v in comp.items() if k not in ('noDuesHtml',)}
            out['hasStatement'] = bool(s.statement_html)
    return out


# ── computation ───────────────────────────────────────────────────────────
def _inputs_fingerprint(email):
    """What payroll can change under us between compute and payment."""
    from ..models import EmployeeLoan, ExpenseClaim
    loans = sorted((l.id, str(D(l.outstanding))) for l in EmployeeLoan.objects.filter(email__iexact=email, status='active'))
    claims = sorted(ExpenseClaim.objects.filter(email__iexact=email, status='approved', paid_run_id__isnull=True)
                    .values_list('id', flat=True))
    return hashlib.sha256(json.dumps([loans, claims]).encode()).hexdigest()[:16]


def compute(sep, overrides=None):
    """Build the itemised computation for a separation (does not save)."""
    from ..models import EmployeeLoan, ExpenseClaim, UserProfile
    ov = overrides or {}
    pol = fnf_policy()
    email = _norm(sep.email)
    for l in EmployeeLoan.objects.filter(email__iexact=email, status__in=('active', 'closed')):
        refresh_loan(l)
    basis = salary_basis(email)
    gross = D(ov['lastDrawnGross']) if ov.get('lastDrawnGross') is not None else basis['gross']
    basic = D(ov['lastDrawnBasic']) if ov.get('lastDrawnBasic') is not None else basis['basic']
    da = D(ov['lastDrawnDa']) if ov.get('lastDrawnDa') is not None else basis['da']
    lwd = sep.last_working_day
    p = UserProfile.objects.filter(email__iexact=email).first()
    doj = ov.get('dateOfJoining') or (p.start_date if p else None)
    if not doj:
        from .ess import latest_payslip
        ps = latest_payslip(email)
        doj = ps.doj if ps else None
    items = []

    def add(code, label, kind, amount, formula, **basis_):
        items.append({'code': code, 'label': label, 'type': kind, 'amount': money(amount), 'formula': formula,
                      'basis': {k: (money(v) if isinstance(v, Decimal) else v) for k, v in basis_.items()}})

    # 1. salary for the exit month
    dim = calendar.monthrange(lwd.year, lwd.month)[1]
    payable = Decimal(str(ov['payableDays'])) if ov.get('payableDays') is not None else Decimal(lwd.day)
    salary = (gross * payable / dim).quantize(Decimal('0.01'))
    add('SALARY', f'Salary for {lwd:%B %Y} ({payable} of {dim} days)', 'earning', salary,
        f'{_fmt_amt(gross)} × {payable} / {dim}', monthlyGross=gross, payableDays=float(payable), daysInMonth=dim)

    # 2. gratuity
    g = gratuity(basic + da, doj, lwd, sep.separation_type, pol)
    svc = g['service']
    if g['eligible']:
        f = f'15 × {_fmt_amt(basic + da)} × {g["years"]} / 26'
        if g['capped']:
            f += f' = {_fmt_amt(g["raw"])}, capped at {_fmt_amt(g["cap"])}'
    else:
        f = (f'Not eligible: {svc["fullYears"]} year(s) {svc["remDays"]} day(s) of service, '
             f'needs 5 years (or 4 years + {int(pol["gratuity_min_days_in_fifth_year"])} days)')
    add('GRATUITY', 'Gratuity', 'earning', g['amount'], f, basicPlusDa=basic + da, dateOfJoining=_iso(doj),
        fullYears=svc['fullYears'], remainderDays=svc['remDays'], creditedYears=g['years'], eligible=g['eligible'],
        exemptFromFiveYearRule=g['exemptFromFiveYearRule'], capped=g['capped'])

    # 3. leave encashment
    if ov.get('leaveDays') is not None:
        el_days, el_src = Decimal(str(ov['leaveDays'])), 'entered by HR'
    else:
        el_days, detail = encashable_leave_days(email)
        el_src = 'leave module: ' + (', '.join(f'{d["type"]} {d["remaining"]}' for d in detail) or 'no earned-leave type')
    div = D(pol['leave_encashment_divisor']) or Decimal('30')
    enc = (el_days * basic / div).quantize(Decimal('0.01'))
    add('LEAVE_ENCASH', f'Leave encashment ({el_days} days)', 'earning', enc, f'{el_days} × {_fmt_amt(basic)} / {div:g}',
        days=float(el_days), basic=basic, divisor=float(div), source=el_src)

    # 4. pending approved reimbursements
    claims = list(ExpenseClaim.objects.filter(email__iexact=email, status='approved', paid_run_id__isnull=True)
                  .defer('receipt_data'))
    reimb = sum((D(c.amount) for c in claims), Decimal('0'))
    add('REIMB', f'Approved reimbursements not yet paid ({len(claims)})', 'earning', reimb,
        'Sum of approved, unpaid expense claims', claimIds=[c.id for c in claims])

    # 5. notice shortfall
    shortfall = max(0, int(sep.notice_days_required) - int(sep.notice_days_served))
    waived = bool(sep.notice_buyout or ov.get('waiveNotice') or sep.separation_type in ('death', 'disablement'))
    ndiv = D(pol['notice_divisor']) or Decimal('30')
    notice = Decimal('0') if waived else (gross / ndiv * shortfall).quantize(Decimal('0.01'))
    add('NOTICE_RECOVERY', f'Notice period shortfall ({shortfall} days)', 'deduction', notice,
        'Waived' if (waived and shortfall) else f'{_fmt_amt(gross)} / {ndiv:g} × {shortfall}',
        required=sep.notice_days_required, served=sep.notice_days_served, waived=waived)

    # 6. loans / advances
    loans = list(EmployeeLoan.objects.filter(email__iexact=email, status='active'))
    loan_out = sum((D(l.outstanding) for l in loans), Decimal('0'))
    add('LOAN_RECOVERY', f'Outstanding loans / advances ({len(loans)})', 'deduction', loan_out,
        'Outstanding principal; future interest waived', loanIds=[l.id for l in loans])

    # 7. clearance recoveries
    clr = [c for c in sep.clearances.all() if c.status != 'waived' and D(c.recovery_amount) > 0]
    clr_total = sum((D(c.recovery_amount) for c in clr), Decimal('0'))
    add('CLEARANCE_RECOVERY', 'Clearance recoveries', 'deduction', clr_total,
        ' + '.join(f'{c.department}: {_fmt_amt(c.recovery_amount)}' for c in clr) or 'None',
        itemIds=[c.id for c in clr])

    # 8. TDS
    grat_taxable = max(Decimal('0'), g['amount'] - D(pol['gratuity_exempt_limit']))
    taxable = max(Decimal('0'), salary + enc + grat_taxable - notice)
    if ov.get('tdsRate') is not None:
        rate, rsrc = Decimal(str(ov['tdsRate'])), 'entered by HR'
    else:
        avg = average_tds_rate(email, lwd) if pol['tds_mode'] == 'average' else None
        rate, rsrc = (avg, 'average TDS rate this financial year') if avg is not None else \
            (D(pol['tds_flat_percent']), 'flat F&F rate (no TDS history)')
    tds = (taxable * rate / 100).quantize(Decimal('0.01'))
    add('TDS', f'TDS on F&F @ {rate}%', 'deduction', tds,
        f'({_fmt_amt(salary)} salary + {_fmt_amt(enc)} leave encashment + {_fmt_amt(grat_taxable)} taxable gratuity '
        f'− {_fmt_amt(notice)} notice recovery) × {rate}%', rate=float(rate), rateSource=rsrc, taxable=taxable)

    earnings = sum((D(i['amount']) for i in items if i['type'] == 'earning'), Decimal('0'))
    deductions = sum((D(i['amount']) for i in items if i['type'] == 'deduction'), Decimal('0'))
    net = earnings - deductions
    return {
        'items': items, 'totalEarnings': money(earnings), 'totalDeductions': money(deductions), 'net': money(net),
        'direction': 'payable' if net >= 0 else 'recoverable', 'currency': basis['currency'],
        'salaryBasis': basis['source'], 'policy': pol, 'overrides': {k: (str(v) if isinstance(v, (date, Decimal)) else v)
                                                                    for k, v in ov.items()},
        'fingerprint': _inputs_fingerprint(email), 'computedAt': timezone.now().isoformat(),
    }


# ── documents ─────────────────────────────────────────────────────────────
_DOC_CSS = ('body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:32px;font-size:13px}'
            'h1{font-size:18px;text-align:center;margin:0}h2{font-size:15px;text-align:center;margin:6px 0 18px}'
            'table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border:1px solid #888;padding:6px 8px;text-align:left}'
            'th{background:#eef1f5}.r{text-align:right}.muted{color:#555;font-size:11px}.tot td{font-weight:bold;background:#f6f8fa}'
            '.sig{display:flex;justify-content:space-between;margin-top:48px}.sig div{width:45%;border-top:1px solid #333;padding-top:6px}')


def statement_html(sep):
    c = sep.computation or {}
    cur = escape(c.get('currency') or 'INR')
    rows = ''
    for kind, title in (('earning', 'Payable to the employee'), ('deduction', 'Recoveries / deductions')):
        rows += f'<tr><th colspan="3">{title}</th></tr>'
        for i in c.get('items', []):
            if i['type'] == kind:
                rows += (f'<tr><td>{escape(i["label"])}</td><td class="muted">{escape(i["formula"])}</td>'
                         f'<td class="r">{_fmt_amt(i["amount"])}</td></tr>')
    net = D(c.get('net'))
    label = 'Net amount payable to the employee' if net >= 0 else 'Net amount recoverable from the employee'
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>Full &amp; Final Settlement</title>'
            f'<style>{_DOC_CSS}</style></head><body>'
            f'<h1>{escape(_company_name().upper())}</h1><h2>Full &amp; Final Settlement Statement</h2>'
            f'<table><tr><td>Employee</td><td>{escape(sep.employee_name)}</td><td>Email</td><td>{escape(sep.email)}</td></tr>'
            f'<tr><td>Separation type</td><td>{escape(sep.separation_type.title())}</td><td>Resignation date</td>'
            f'<td>{sep.resignation_date:%d-%m-%Y}</td></tr>'
            f'<tr><td>Last working day</td><td>{sep.last_working_day:%d-%m-%Y}</td><td>Notice (required / served)</td>'
            f'<td>{sep.notice_days_required} / {sep.notice_days_served} days</td></tr></table>'
            f'<table><tr><th>Particulars</th><th>Computation</th><th class="r">Amount ({cur})</th></tr>{rows}'
            f'<tr class="tot"><td colspan="2">Total payable</td><td class="r">{_fmt_amt(c.get("totalEarnings"))}</td></tr>'
            f'<tr class="tot"><td colspan="2">Total recoveries</td><td class="r">{_fmt_amt(c.get("totalDeductions"))}</td></tr>'
            f'<tr class="tot"><td colspan="2">{label}</td><td class="r">{cur} {_fmt_amt(abs(net))}</td></tr></table>'
            f'<p class="muted">Salary basis: {escape(str(c.get("salaryBasis", "")))}. Computed {escape(str(c.get("computedAt", ""))[:10])}. '
            f'Approved by {escape(sep.approved_by)} on {sep.approved_at:%d-%m-%Y}.</p>'
            f'<p>I acknowledge receipt of the above amount in full and final settlement of all my dues and have no '
            f'further claims against the company.</p>'
            f'<div class="sig"><div>For {escape(_company_name())}<br>Authorised signatory</div>'
            f'<div>Employee signature<br>{escape(sep.employee_name)}</div></div></body></html>')


def no_dues_html(sep):
    rows = ''.join(f'<tr><td>{escape(c.department)}</td><td>{escape(c.item)}</td><td>{escape(c.status.title())}</td>'
                   f'<td>{escape(c.cleared_by)}</td><td>{c.cleared_at:%d-%m-%Y}</td></tr>' if c.cleared_at else
                   f'<tr><td>{escape(c.department)}</td><td>{escape(c.item)}</td><td>{escape(c.status.title())}</td>'
                   f'<td>{escape(c.cleared_by)}</td><td></td></tr>' for c in sep.clearances.all())
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>No Dues Certificate</title>'
            f'<style>{_DOC_CSS}</style></head><body>'
            f'<h1>{escape(_company_name().upper())}</h1><h2>No Dues Clearance Certificate</h2>'
            f'<p>This is to certify that <b>{escape(sep.employee_name)}</b> ({escape(sep.email)}), whose last working day '
            f'was <b>{sep.last_working_day:%d-%m-%Y}</b>, has completed the exit clearance below and has no dues '
            f'outstanding towards the company other than those settled in the Full &amp; Final settlement.</p>'
            f'<table><tr><th>Department</th><th>Item</th><th>Status</th><th>Cleared by</th><th>Date</th></tr>{rows}</table>'
            f'<p class="muted">Issued on {_today():%d-%m-%Y}. Approved by {escape(sep.approved_by)}.</p>'
            f'<div class="sig"><div>For {escape(_company_name())}<br>Authorised signatory</div><div>HR department</div></div>'
            f'</body></html>')


# ── IT asset register (hrms_plus/assets_links.py) ─────────────────────────
def _assets_hook(name, *args):
    """Keep the leaver's IT assets and the IT clearance items in step: one item
    per asset they hold, cleared when the asset comes back. Never blocks F&F."""
    try:
        from hrms_plus import assets_links
    except Exception:
        return None
    try:
        with transaction.atomic():
            return getattr(assets_links, name)(*args)
    except Exception:
        import logging
        logging.getLogger(__name__).exception('IT asset hook %s failed', name)
        return None


# ── endpoints ─────────────────────────────────────────────────────────────
def _sep_or_404(pk, lock=False):
    from ..models import Separation
    qs = Separation.objects.select_for_update() if lock else Separation.objects
    return qs.filter(id=pk).prefetch_related('clearances').first()


@api_view(['GET', 'POST'])
def separations(request):
    from ..models import AppUser, ClearanceItem, Separation, UserProfile
    if request.method == 'GET':
        email, user, denied = security.require(request, None)
        if denied:
            return denied
        status = str(request.GET.get('status') or '').lower()
        qs = Separation.objects.all().prefetch_related('clearances')
        is_hr = security.has_perm(user, PERM)
        if not is_hr:
            from .ess import _reports_of
            reports = _reports_of(email)
            if not reports:
                return _err("You don't have permission to do this. Required: " + PERM, 403, 'PERMISSION_DENIED')
            qs = qs.filter(email__in=reports).exclude(status='cancelled')
        if status:
            qs = qs.filter(status=status)
        return Response({'separations': [separation_dict(s, full=not is_hr, money_view=is_hr) for s in qs[:200]],
                         'canManage': is_hr, 'types': list(SEPARATION_TYPES)})
    email, user, denied = security.require(request, PERM, fresh=True)
    if denied:
        return denied
    body = request.data or {}
    try:
        target = _norm(body.get('email'))
        if not target or not (AppUser.objects.filter(email__iexact=target).exists()
                              or UserProfile.objects.filter(email__iexact=target).exists()):
            raise ValueError('Choose an existing employee.')
        if target == email:
            raise ValueError('You cannot initiate your own separation.')
        stype = str(body.get('separationType') or 'resignation').lower()
        if stype not in SEPARATION_TYPES:
            raise ValueError('Unknown separation type.')
        rdate = parse_date(body.get('resignationDate'), 'Resignation date')
        lwd = parse_date(body.get('lastWorkingDay'), 'Last working day')
        if lwd < rdate:
            raise ValueError('The last working day cannot be before the resignation date.')
        if not (date(2000, 1, 1) <= rdate <= date(2100, 1, 1)) or (lwd - rdate).days > 400:
            raise ValueError('Check the dates.')
        required = parse_int(body.get('noticeDaysRequired', 30), 0, 365, 'Notice days required')
        served_raw = body.get('noticeDaysServed')
        served = parse_int(served_raw, 0, 400, 'Notice days served') if served_raw not in (None, '') \
            else min(required, (lwd - rdate).days)
        reason = clean_text(body.get('reason'), 2000)
    except ValueError as e:
        return _err(str(e))
    if Separation.objects.filter(email__iexact=target).exclude(status__in=('cancelled',)).exists():
        return _err('This employee already has a separation on record.', 409)
    with transaction.atomic():
        s = Separation.objects.create(email=target, employee_name=person_name(target), separation_type=stype,
                                      resignation_date=rdate, last_working_day=lwd, notice_days_required=required,
                                      notice_days_served=served, notice_buyout=bool(body.get('noticeBuyout')),
                                      reason=reason, status='initiated', created_by=email)
        ClearanceItem.objects.bulk_create([ClearanceItem(separation=s, department=d, item=i) for d, i in DEFAULT_CLEARANCE])
        _assets_hook('on_separation_initiated', s, email)     # one IT item per asset held
    security.audit('fnf_initiated', 'Separation', s.id, request, email, security.display_name(user, email),
                   changes={'employee': target, 'type': stype, 'lastWorkingDay': str(lwd)})
    return Response(separation_dict(_sep_or_404(s.id)), status=201)


@api_view(['GET', 'PATCH'])
def separation_detail(request, pk):
    if request.method == 'GET':
        email, user, denied = security.require(request, None)
        if denied:
            return denied
        s = _sep_or_404(pk)
        if not s:
            return _err('Not found', 404)
        if security.has_perm(user, PERM):
            return Response(separation_dict(s))
        from .ess import _is_manager_of
        if _is_manager_of(email, s.email) and s.status != 'cancelled':
            return Response(separation_dict(s, money_view=False))
        return _err('Not found', 404)
    email, user, denied = security.require(request, PERM, fresh=True)
    if denied:
        return denied
    body = request.data or {}
    with transaction.atomic():
        s = _sep_or_404(pk, lock=True)
        if not s:
            return _err('Not found', 404)
        if _norm(s.email) == email:
            return _err('You cannot change your own separation.', 403, 'SELF_APPROVAL')
        if s.status in ('approved', 'paid', 'cancelled'):
            return _err(f'This separation is {s.status} and can no longer be changed.', 409)
        changes = {}
        try:
            if 'separationType' in body:
                t = str(body['separationType']).lower()
                if t not in SEPARATION_TYPES:
                    raise ValueError('Unknown separation type.')
                changes['separation_type'] = t
            if 'resignationDate' in body:
                changes['resignation_date'] = parse_date(body['resignationDate'], 'Resignation date')
            if 'lastWorkingDay' in body:
                changes['last_working_day'] = parse_date(body['lastWorkingDay'], 'Last working day')
            if 'noticeDaysRequired' in body:
                changes['notice_days_required'] = parse_int(body['noticeDaysRequired'], 0, 365, 'Notice days required')
            if 'noticeDaysServed' in body:
                changes['notice_days_served'] = parse_int(body['noticeDaysServed'], 0, 400, 'Notice days served')
            if 'noticeBuyout' in body:
                changes['notice_buyout'] = bool(body['noticeBuyout'])
            if 'reason' in body:
                changes['reason'] = clean_text(body['reason'], 2000)
            rd = changes.get('resignation_date', s.resignation_date)
            lw = changes.get('last_working_day', s.last_working_day)
            if lw < rd:
                raise ValueError('The last working day cannot be before the resignation date.')
        except ValueError as e:
            return _err(str(e))
        for k, v in changes.items():
            setattr(s, k, v)
        if s.status == 'computed':
            s.status = 'clearance'          # the computation is stale now
        s.save()
    security.audit('fnf_updated', 'Separation', s.id, request, email, changes={k: str(v) for k, v in changes.items()})
    return Response(separation_dict(_sep_or_404(s.id)))


@api_view(['POST'])
def clearance_add(request, pk):
    from ..models import ClearanceItem
    email, user, denied = security.require(request, PERM, fresh=True)
    if denied:
        return denied
    body = request.data or {}
    s = _sep_or_404(pk)
    if not s:
        return _err('Not found', 404)
    if s.status in ('approved', 'paid', 'cancelled'):
        return _err(f'This separation is {s.status}.', 409)
    dept = str(body.get('department') or '')
    item = clean_text(body.get('item'), 255)
    if dept not in DEPARTMENTS or len(item) < 2:
        return _err('Choose a department and describe the item.')
    try:
        rec = parse_amount(body.get('recoveryAmount') or '0', lo=Decimal('0'))
    except ValueError as e:
        return _err(str(e))
    c = ClearanceItem.objects.create(separation=s, department=dept, item=item, recovery_amount=rec)
    if s.status == 'computed':
        s.status = 'clearance'
        s.save(update_fields=['status'])
    security.audit('fnf_clearance_added', 'Separation', s.id, request, email, changes={'item': item, 'recovery': str(rec)})
    return Response(clearance_dict(c), status=201)


@api_view(['POST'])
def clearance_update(request, pk, cid):
    from ..models import ClearanceItem
    email, user, denied = security.require(request, None, fresh=True)
    if denied:
        return denied
    body = request.data or {}
    with transaction.atomic():
        s = _sep_or_404(pk, lock=True)
        c = ClearanceItem.objects.filter(id=cid, separation_id=pk).first() if s else None
        if not s or not c:
            return _err('Not found', 404)
        is_hr = security.has_perm(user, PERM)
        from .ess import _is_manager_of
        if not is_hr and not (c.department == 'Manager' and _is_manager_of(email, s.email)):
            return _err('Not found', 404)
        if _norm(s.email) == email:
            return _err('You cannot clear your own exit items.', 403, 'SELF_APPROVAL')
        if s.status in ('approved', 'paid', 'cancelled'):
            return _err(f'This separation is {s.status}.', 409)
        status = str(body.get('status') or c.status).lower()
        if status not in ('pending', 'cleared', 'waived'):
            return _err('status must be pending, cleared or waived.')
        if status == 'waived' and not is_hr:
            return _err('Only HR can waive a clearance item.', 403)
        before = {'status': c.status, 'recovery': str(c.recovery_amount)}
        if 'recoveryAmount' in body:
            if not is_hr:
                return _err('Only HR can set recovery amounts.', 403)
            try:
                c.recovery_amount = parse_amount(body.get('recoveryAmount') or '0', lo=Decimal('0'))
            except ValueError as e:
                return _err(str(e))
        c.status = status
        c.note = clean_text(body.get('note'), 255) if 'note' in body else c.note
        if status in ('cleared', 'waived'):
            c.cleared_by, c.cleared_at = email, timezone.now()
        else:
            c.cleared_by, c.cleared_at = '', None
        c.save()
        if c.department == 'IT':
            _assets_hook('on_clearance_changed', s, c, email)   # cleared asset item = asset returned
        if s.status in ('initiated', 'computed'):
            s.status = 'clearance'
            s.save(update_fields=['status'])
    security.audit('fnf_clearance_' + status, 'Separation', s.id, request, email, security.display_name(user, email),
                   changes={'item': c.item, 'before': before, 'recovery': str(c.recovery_amount)})
    return Response(clearance_dict(c))


def _parse_overrides(body):
    ov = {}
    src = body.get('overrides') or {}
    if not isinstance(src, dict):
        raise ValueError('overrides must be an object.')
    for key in ('lastDrawnGross', 'lastDrawnBasic', 'lastDrawnDa'):
        if src.get(key) not in (None, ''):
            ov[key] = parse_amount(src[key], lo=Decimal('0'))
    if src.get('payableDays') not in (None, ''):
        ov['payableDays'] = parse_int(src['payableDays'], 0, 31, 'Payable days')
    if src.get('leaveDays') not in (None, ''):
        v = Decimal(str(src['leaveDays']))
        if v < 0 or v > 365:
            raise ValueError('Leave days must be between 0 and 365.')
        ov['leaveDays'] = v
    if src.get('tdsRate') not in (None, ''):
        v = Decimal(str(src['tdsRate']))
        if v < 0 or v > 50:
            raise ValueError('TDS rate must be between 0 and 50 %.')
        ov['tdsRate'] = v
    if src.get('dateOfJoining') not in (None, ''):
        ov['dateOfJoining'] = parse_date(src['dateOfJoining'], 'Date of joining')
    if src.get('waiveNotice'):
        ov['waiveNotice'] = True
    return ov


@api_view(['POST'])
def separation_compute(request, pk):
    email, user, denied = security.require(request, PERM, fresh=True)
    if denied:
        return denied
    try:
        ov = _parse_overrides(request.data or {})
    except (ValueError, ArithmeticError) as e:
        return _err(str(e) or 'Invalid override.')
    with transaction.atomic():
        s = _sep_or_404(pk, lock=True)
        if not s:
            return _err('Not found', 404)
        if _norm(s.email) == email:
            return _err('You cannot compute your own settlement.', 403, 'SELF_APPROVAL')
        if s.status in ('approved', 'paid', 'cancelled'):
            return _err(f'This separation is {s.status}.', 409)
        result = compute(s, ov)
        result['computedBy'] = email
        s.computation = result
        s.net_payable = D(result['net'])
        s.status = 'computed'
        s.save(update_fields=['computation', 'net_payable', 'status'])
    security.audit('fnf_computed', 'Separation', s.id, request, email, security.display_name(user, email),
                   changes={'net': result['net'], 'overrides': result['overrides']})
    return Response(separation_dict(_sep_or_404(s.id)))


@api_view(['POST'])
def separation_approve(request, pk):
    email, user, denied = security.require(request, PERM, fresh=True)
    if denied:
        return denied
    with transaction.atomic():
        s = _sep_or_404(pk, lock=True)
        if not s:
            return _err('Not found', 404)
        if _norm(s.email) == email:
            return _err('You cannot approve your own settlement.', 403, 'SELF_APPROVAL')
        if _norm(s.created_by) == email:
            return _err('The person who initiated the separation cannot approve its settlement.', 403, 'MAKER_CHECKER')
        if s.status != 'computed':
            return _err('Compute the settlement before approving it.' if s.status in ('initiated', 'clearance')
                        else f'This separation is {s.status}.', 409)
        pending = [c.item for c in s.clearances.all() if c.status not in ('cleared', 'waived')]
        if pending:
            return _err('Clearance is not complete: ' + '; '.join(pending[:5]), 409, 'CLEARANCE_PENDING')
        if (s.computation or {}).get('fingerprint') != _inputs_fingerprint(s.email):
            return _err('Loans or reimbursements changed since the computation. Recompute first.', 409, 'STALE')
        s.status, s.approved_by, s.approved_at = 'approved', email, timezone.now()
        s.statement_html = statement_html(s)
        comp = dict(s.computation or {})
        comp['noDuesHtml'] = no_dues_html(s)
        s.computation = comp
        s.save()
    security.audit('fnf_approved', 'Separation', s.id, request, email, security.display_name(user, email),
                   changes={'net': money(s.net_payable), 'employee': s.email})
    return Response(separation_dict(_sep_or_404(s.id)))


@api_view(['POST'])
def separation_mark_paid(request, pk):
    from ..models import ExpenseClaim, LoanInstallment, EmployeeLoan
    email, user, denied = security.require(request, PERM, fresh=True)
    if denied:
        return denied
    body = request.data or {}
    ref = clean_text(body.get('reference'), 100)
    with transaction.atomic():
        s = _sep_or_404(pk, lock=True)
        if not s:
            return _err('Not found', 404)
        if _norm(s.email) == email:
            return _err('You cannot pay your own settlement.', 403, 'SELF_APPROVAL')
        if s.status != 'approved':
            return _err('Only an approved settlement can be marked paid.', 409)
        comp = dict(s.computation or {})
        if comp.get('fingerprint') != _inputs_fingerprint(s.email):
            return _err('Loans or reimbursements changed since approval. Recompute and approve again.', 409, 'STALE')
        items = {i['code']: i for i in comp.get('items', [])}
        loan_ids = (items.get('LOAN_RECOVERY') or {}).get('basis', {}).get('loanIds') or []
        claim_ids = (items.get('REIMB') or {}).get('basis', {}).get('claimIds') or []
        LoanInstallment.objects.filter(loan_id__in=loan_ids, status='scheduled').update(status='recovered')
        for l in EmployeeLoan.objects.filter(id__in=loan_ids):
            refresh_loan(l)
        ExpenseClaim.objects.filter(id__in=claim_ids, status='approved', paid_run_id__isnull=True) \
            .update(status='paid', paid_run_id=-s.id)
        comp['paidAt'] = timezone.now().isoformat()
        comp['paidBy'] = email
        comp['paymentReference'] = ref
        s.computation = comp
        s.status = 'paid'
        s.save(update_fields=['computation', 'status'])
    security.audit('fnf_paid', 'Separation', s.id, request, email, security.display_name(user, email),
                   changes={'net': money(s.net_payable), 'reference': ref, 'loans': loan_ids, 'claims': claim_ids})
    return Response(separation_dict(_sep_or_404(s.id)))


@api_view(['POST'])
def separation_cancel(request, pk):
    email, user, denied = security.require(request, PERM, fresh=True)
    if denied:
        return denied
    with transaction.atomic():
        s = _sep_or_404(pk, lock=True)
        if not s:
            return _err('Not found', 404)
        if s.status in ('paid', 'cancelled'):
            return _err(f'This separation is {s.status}.', 409)
        s.status = 'cancelled'
        s.save(update_fields=['status'])
        _assets_hook('on_separation_cancelled', s, email)
    security.audit('fnf_cancelled', 'Separation', s.id, request, email, notes=clean_text((request.data or {}).get('note'), 255))
    return Response(separation_dict(_sep_or_404(s.id)))


@api_view(['GET'])
def separation_documents(request, pk):
    email, user, denied = security.require(request, PERM)
    if denied:
        return denied
    s = _sep_or_404(pk)
    if not s:
        return _err('Not found', 404)
    if s.status not in ('approved', 'paid'):
        return _err('The statement and No-Dues certificate are issued once the settlement is approved.', 409)
    security.audit('fnf_documents_viewed', 'Separation', s.id, request, email)
    return Response({'statementHtml': s.statement_html, 'noDuesHtml': (s.computation or {}).get('noDuesHtml', '')})


@api_view(['GET'])
def fnf_employees(request):
    """Employees HR can start a separation for (no salary data)."""
    from ..models import AppUser, Separation
    email, user, denied = security.require(request, PERM)
    if denied:
        return denied
    open_ = set(_norm(e) for e in Separation.objects.exclude(status='cancelled').values_list('email', flat=True))
    out = [{'email': u.email.lower(), 'name': u.full_name or u.email} for u in
           AppUser.objects.filter(status='active').order_by('full_name')
           if u.email and u.email.lower() not in open_ and u.email.lower() != email]
    return Response({'employees': out[:2000]})
