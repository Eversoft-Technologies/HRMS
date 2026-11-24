"""Indian statutory files: EPFO ECR, ESIC monthly contribution, Form 24Q, Form 16.

Every generated file is stored in ``StatutoryFiling`` (content, sha256,
row_count, generated_by) and can be downloaded again later. Generation and
download need ``payroll.statutory`` AND a fresh sign-in (valid JWT for the
same person). Every generation / download is audited; UAN / PAN never appear in
clear in audit rows, problem lists or API payloads other than the file itself.

Validation: rows that would make a bad file (invalid UAN, missing ESIC IP
number …) are listed as *problems* and the file is NOT produced unless the
caller explicitly passes ``allow_partial: true`` (then those rows are left out
and the problems are returned with the file).

Limits — what must be verified in the real world
------------------------------------------------
* ECR: EPF wages are derived from the employee PF line (PF / 12 %), so they
  equal the PF wage actually used by payroll (incl. a ₹15,000 ceiling if the
  employer applies one). EPS/EDLI wages are capped at ₹15,000. Upload to the
  EPFO unified portal, which performs its own validation.
* ESIC: an Excel-compatible CSV in the portal's column order. The portal's
  bulk upload expects .xls — open the CSV in Excel and "Save as .xls" if the
  portal refuses CSV. Reason code 1 (on leave) is filled for zero-day rows and
  must be reviewed.
* Form 24Q: Annexure I (deductee rows) and, for Q4, Annexure II (salary
  details) are CSV files to be keyed / imported into NSDL's Return
  Preparation Utility (RPU). Challan details (BSR code, challan serial, date
  of deposit) are not known to payroll and must be filled in RPU. **The final
  .fvu file must be generated and validated with NSDL's File Validation
  Utility (FVU) — this module cannot produce an FVU-validated return.**
* Form 16: Part B (salary, deductions, tax computation) is generated here.
  Part A must be downloaded from TRACES and uploaded (PDF) to attach it.
"""
import base64
import csv
import html
import io
import json
import logging
import re
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import security as sec
from . import india_tax as it

logger = logging.getLogger(__name__)

PERM = 'payroll.statutory'
EPS_CEILING = Decimal('15000')
EPS_RATE = Decimal('0.0833')
EPF_RATE = Decimal('0.12')
ESIC_GROSS_LIMIT = Decimal('21000')
ZERO = Decimal('0')
SEP = '#~#'
_UAN_RE = re.compile(r'^\d{12}$')
_IP_RE = re.compile(r'^\d{10}$')
_TAN_RE = re.compile(r'^[A-Z]{4}[0-9]{5}[A-Z]$')
QUARTERS = {1: ((4, 0), (6, 0)), 2: ((7, 0), (9, 0)), 3: ((10, 0), (12, 0)), 4: ((1, 1), (3, 1))}
FVU_NOTE = ('This is input for NSDL\'s Return Preparation Utility (RPU). Add challan details in RPU, then generate '
            'and validate the final .fvu file with NSDL\'s File Validation Utility (FVU) before filing.')


def _r0(v):
    return int(Decimal(str(v or 0)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def _line(lines, code):
    return sum((Decimal(str(l.get('amount') or 0)) for l in (lines or []) if str(l.get('code')).upper() == code), ZERO)


from ..fields import plain  # noqa: E402  (encrypted identifiers, decrypted server-side)


def mask_uan(u):
    s = re.sub(r'\s+', '', str(u or ''))
    return ('•' * max(0, len(s) - 4) + s[-4:]) if s else '(blank)'


def _clean(v, maxlen=85):
    v = re.sub(r'[\x00-\x1f\x7f#~,]', ' ', str(v or ''))
    return re.sub(r'\s+', ' ', v).strip()[:maxlen]


def _comp(email):
    from ..models import EmployeeCompensation
    return EmployeeCompensation.objects.filter(email__iexact=email).order_by('-effective_from', '-id').first()


def _esic_map():
    from ..models import PayrollSetting
    row = PayrollSetting.objects.filter(key='esic_ip_numbers').first()
    try:
        data = json.loads(row.value) if row and row.value else {}
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def _setting(key):
    from ..models import PayrollSetting
    row = PayrollSetting.objects.filter(key=key).first()
    return (row.value or '').strip() if row else ''


def _entries(run):
    from ..models import PayrollEntry, Payslip
    slips = {p.email.lower(): p for p in Payslip.objects.filter(run=run)}
    for e in PayrollEntry.objects.filter(run=run).order_by('employee_name', 'email'):
        yield e, slips.get(e.email.lower())


# ── builders (pure-ish: read the DB, write nothing) ──────────────────────
def build_ecr(run):
    """→ {content, rows, problems, warnings, skipped}. One line per PF member:
    UAN#~#NAME#~#GROSS#~#EPF WAGES#~#EPS WAGES#~#EDLI WAGES#~#EPF (EE)#~#EPS#~#EPF-EPS DIFF#~#NCP DAYS#~#REFUND"""
    lines, problems, warnings, skipped = [], [], [], []
    if run.status not in ('approved', 'paid'):
        warnings.append(f'Run {run.period_label} is "{run.status}", not approved — figures may still change.')
    for e, slip in _entries(run):
        name = _clean(e.employee_name or e.email.split('@')[0])
        if (e.currency or 'INR').upper() != 'INR':
            continue
        ded = slip.deductions_data if slip else e.deductions_data
        ee = _line(ded, 'PF')
        if ee <= 0:
            skipped.append({'email': e.email, 'name': name, 'issue': 'No employee PF deducted — not in ECR.'})
            continue
        comp = _comp(e.email)
        # plain(): decrypted server-side; a missing key raises instead of filing ciphertext.
        uan = re.sub(r'\s+', '', plain(slip.uan_number if slip and slip.uan_number else (comp.uan_number if comp else '')) or '')
        if not _UAN_RE.match(uan):
            problems.append({'email': e.email, 'name': name,
                             'issue': f'UAN {mask_uan(uan)} is missing or not 12 digits.'})
            continue
        ee_r = _r0(ee)
        epf_wages = _r0(ee / EPF_RATE)
        eps_wages = min(epf_wages, int(EPS_CEILING))
        edli_wages = min(epf_wages, int(EPS_CEILING))
        eps = _r0(Decimal(eps_wages) * EPS_RATE)
        diff = max(0, ee_r - eps)
        gross = _r0(slip.gross_earnings if slip else e.gross_earnings)
        ncp = _r0(slip.lop_days if slip else e.lop_days)
        lines.append(SEP.join(str(x) for x in (uan, name, gross, epf_wages, eps_wages, edli_wages, ee_r, eps, diff,
                                               ncp, 0)))
    return {'content': '\n'.join(lines) + ('\n' if lines else ''), 'rows': len(lines), 'problems': problems,
            'warnings': warnings, 'skipped': skipped}


def _esic_ip(email, comp, ipmap):
    for attr in ('esic_ip_number', 'esi_number', 'esic_number'):
        v = getattr(comp, attr, '') if comp else ''
        if v:
            return str(v).strip()
    return str(ipmap.get(email.lower(), '') or '').strip()


def build_esic(run):
    """ESIC monthly contribution rows for employees with gross ≤ ₹21,000."""
    out = io.StringIO()
    w = csv.writer(out, lineterminator='\r\n')
    w.writerow(['IP Number', 'IP Name', 'No. of Days for which wages paid/payable during the month',
                'Total Monthly Wages', 'Reason Code for Zero workings days', 'Last Working Day'])
    rows, problems, warnings, skipped = 0, [], [], []
    ipmap = _esic_map()
    for e, slip in _entries(run):
        if (e.currency or 'INR').upper() != 'INR':
            continue
        gross = Decimal(str(slip.gross_earnings if slip else e.gross_earnings))
        name = _clean(e.employee_name or e.email.split('@')[0])
        if gross > ESIC_GROSS_LIMIT or gross <= 0:
            skipped.append({'email': e.email, 'name': name, 'issue': 'Gross above ₹21,000 or zero — not covered.'})
            continue
        ip = _esic_ip(e.email, _comp(e.email), ipmap)
        if not _IP_RE.match(ip):
            problems.append({'email': e.email, 'name': name,
                             'issue': 'ESIC IP number is missing or not 10 digits. Set it under "ESIC IP numbers".'})
            continue
        days = _r0(slip.paid_days if slip else e.paid_days)
        reason = '0' if days > 0 else '1'
        if days == 0:
            warnings.append(f'{name}: zero paid days — reason code 1 (on leave) used; review before upload.')
        w.writerow([ip, name, days, _r0(gross), reason, ''])
        rows += 1
    return {'content': out.getvalue(), 'rows': rows, 'problems': problems, 'warnings': warnings, 'skipped': skipped}


def quarter_range(fy, q):
    y = int(fy[:4])
    (m1, o1), (m2, o2) = QUARTERS[q]
    s = date(y + o1, m1, 1)
    e = date(y + o2, m2, 30 if m2 in (6, 9) else 31)
    return s, e


def _payslips(start, end):
    from ..models import PayrollEntry, Payslip
    slips = list(Payslip.objects.filter(run__period_start__gte=start, run__period_start__lte=end)
                 .exclude(run__status='cancelled').select_related('run').order_by('run__period_start', 'employee_name'))
    cur = {(e.run_id, e.email.lower()): (e.currency or 'INR').upper()
           for e in PayrollEntry.objects.filter(run_id__in={p.run_id for p in slips})}
    return [p for p in slips if cur.get((p.run_id, p.email.lower()), 'INR') == 'INR']


def _pan_for(slip, comp):
    pan = plain((slip.pan_number if slip and slip.pan_number else (comp.pan_number if comp else '')) or '')
    pan = pan.strip().upper()
    return pan if sec.is_valid_pan(pan) else ''


def build_24q(fy, quarter):
    """Annexure I for the quarter (+ Annexure II for Q4). → dict with both contents."""
    start, end = quarter_range(fy, quarter)
    problems, warnings = [], []
    out = io.StringIO()
    w = csv.writer(out, lineterminator='\r\n')
    w.writerow(['Sr No', 'Employee Reference No', 'PAN of Employee', 'Name of Employee', 'Section Code',
                'Date of Payment/Credit', 'Date of Tax Deduction', 'Amount Paid/Credited', 'TDS', 'Surcharge',
                'Health and Education Cess', 'Total Tax Deducted', 'Total Tax Deposited',
                'Reason for Non/Lower Deduction', 'BSR Code', 'Challan Serial No', 'Date of Deposit'])
    n = 0
    noted = set()
    for p in _payslips(start, end):
        tds = _line(p.deductions_data, 'TDS')
        if tds <= 0:
            continue
        comp = _comp(p.email)
        pan = _pan_for(p, comp)
        name = _clean(p.employee_name or p.email.split('@')[0], 75)
        if not pan and p.email not in noted:
            noted.add(p.email)
            warnings.append(f'{name}: PAN missing or invalid — reported as PANNOTAVBL (Sec 206AA higher rate applies).')
        paid_on = (p.run.pay_date or p.run.period_end).strftime('%d/%m/%Y')
        total = _r0(tds)
        base = _r0(Decimal(total) / Decimal('1.04'))
        n += 1
        w.writerow([n, _clean(p.employee_code, 20), pan or 'PANNOTAVBL', name, '92B', paid_on, paid_on,
                    _r0(p.gross_earnings), base, 0, total - base, total, total, '', '', '', ''])
    res = {'start': start, 'end': end, 'annex1': out.getvalue(), 'annex1_rows': n, 'annex2': '', 'annex2_rows': 0,
           'problems': problems, 'warnings': warnings}
    if quarter == 4:
        a2, rows, probs, warns = build_annexure2(fy)
        res.update({'annex2': a2, 'annex2_rows': rows})
        problems.extend(probs)
        warnings.extend(warns)
    return res


def employee_year(email, fy):
    """Actual FY figures + tax computation used by Annexure II and Form 16."""
    act = it.fy_actuals(email, fy)
    decl = it.get_declaration(email, fy)
    regime = decl.regime if decl and decl.regime in it.KINDS else 'new'
    table = it.get_table(fy, regime)
    annual = {'gross': act['taxable'], 'basic': act['basic'], 'hra': act['hra'], 'pf': act['pf'], 'pt': act['pt']}
    inc = it.income_breakdown(annual, regime, table, decl, months=act['months'] or 12)
    tax = it.compute_annual_tax(inc['taxable'], table)
    return {'actuals': act, 'decl': decl, 'regime': regime, 'income': inc, 'tax': tax}


def _fy_emails(fy):
    s, e = it.fy_bounds(fy)
    seen, out = set(), []
    for p in _payslips(s, e):
        k = p.email.lower()
        if k not in seen:
            seen.add(k)
            out.append(k)
    return out


def build_annexure2(fy):
    out = io.StringIO()
    w = csv.writer(out, lineterminator='\r\n')
    w.writerow(['Sr No', 'PAN of Employee', 'Name of Employee', 'Employee Reference No', 'Category',
                'Period From', 'Period To', 'Opting out of 115BAC (Y/N)', 'Gross Salary 17(1)',
                'HRA Exemption 10(13A)', 'Standard Deduction 16(ia)', 'Professional Tax 16(iii)',
                'Income Chargeable under Salaries', 'Interest on Housing Loan 24(b)', 'Gross Total Income',
                '80C (incl. EPF)', '80CCD(1B)', '80D', 'Total Chapter VI-A', 'Total Taxable Income',
                'Tax on Total Income', 'Rebate 87A (incl. marginal relief)', 'Surcharge', 'Health and Education Cess',
                'Relief u/s 89', 'Net Tax Payable', 'Total TDS Deducted', 'Shortfall(+)/Excess(-)',
                'Rent Paid', 'Landlord PAN', 'Landlord Name'])
    problems, warnings, n = [], [], 0
    for email in _fy_emails(fy):
        y = employee_year(email, fy)
        act, inc, tax, decl = y['actuals'], y['income'], y['tax'], y['decl']
        comp = _comp(email)
        name = _clean(it._name(email), 75)
        pan = _pan_for(None, comp)
        if not pan:
            warnings.append(f'{name}: PAN missing or invalid — reported as PANNOTAVBL.')
        landlord_pan = ''
        if inc['rent_annual'] > 100000:
            try:
                landlord_pan = sec.unseal(decl.landlord_pan_enc) if decl and decl.landlord_pan_enc else ''
            except Exception:
                landlord_pan = ''
            if not landlord_pan:
                problems.append({'email': email, 'name': name,
                                 'issue': 'Rent above ₹1,00,000 but the landlord PAN is missing or unreadable.'})
        d = inc['deductions']
        chargeable = inc['gross'] - inc['hra_exemption'] - inc['standard_deduction'] - inc['professional_tax']
        via = d['80C'] + d['80CCD1B'] + d['80D']
        rebate = tax['rebate_87a'] + tax['marginal_relief_87a']
        tds = float(act['tds'])
        n += 1
        w.writerow([n, pan or 'PANNOTAVBL', name, _clean(comp.employee_code if comp else '', 20), 'G',
                    act['first'].strftime('%d/%m/%Y') if act['first'] else '',
                    act['last'].strftime('%d/%m/%Y') if act['last'] else '',
                    'Y' if y['regime'] == 'old' else 'N', _r0(inc['gross']), _r0(inc['hra_exemption']),
                    _r0(inc['standard_deduction']), _r0(inc['professional_tax']), _r0(max(0, chargeable)),
                    _r0(d['24b']), _r0(max(0, chargeable - d['24b'])), _r0(d['80C']), _r0(d['80CCD1B']),
                    _r0(d['80D']), _r0(via), _r0(inc['taxable']), _r0(tax['slab_tax']), _r0(rebate),
                    _r0(tax['surcharge']), _r0(tax['cess']), 0, _r0(tax['total']), _r0(tds),
                    _r0(tax['total'] - tds), _r0(inc['rent_annual']), landlord_pan,
                    _clean(((decl.hra or {}).get('landlord_name') if decl else '') or '', 75)])
    if n:
        warnings.append('Annexure II category is "G" (general) for everyone — correct it in RPU for women / senior '
                        'citizens (W / S / O).')
    return out.getvalue(), n, problems, warnings


def _money(v):
    return '₹' + f'{float(v or 0):,.2f}'


def build_form16(email, fy):
    """Form 16 Part B as a printable HTML document. → (html, problems)."""
    from ..models import CompanyDetail
    y = employee_year(email, fy)
    act, inc, tax, decl = y['actuals'], y['income'], y['tax'], y['decl']
    co = CompanyDetail.objects.first()
    comp = _comp(email)
    tan = _setting('employer_tan')
    problems = []
    if not _TAN_RE.match(tan):
        problems.append({'email': email, 'name': it._name(email),
                         'issue': 'Employer TAN is not configured (Statutory files › Employer TAN).'})
    pan = _pan_for(None, comp)
    e = html.escape
    ay = f'{int(fy[:4]) + 1}-{(int(fy[:4]) + 2) % 100:02d}'
    d = inc['deductions']
    chargeable = inc['gross'] - inc['hra_exemption'] - inc['standard_deduction'] - inc['professional_tax']
    rows = [
        ('1', 'Gross salary — salary as per Sec 17(1)', inc['gross']),
        ('2', 'Less: exemption u/s 10 — HRA 10(13A)', inc['hra_exemption']),
        ('3', 'Less: standard deduction u/s 16(ia)', inc['standard_deduction']),
        ('4', 'Less: professional tax u/s 16(iii)', inc['professional_tax']),
        ('5', 'Income chargeable under the head "Salaries"', max(0, chargeable)),
        ('6', 'Less: interest on housing loan u/s 24(b)', d['24b']),
        ('7', 'Gross total income', max(0, chargeable - d['24b'])),
        ('8a', 'Deduction u/s 80C (incl. employee PF)', d['80C']),
        ('8b', 'Deduction u/s 80CCD(1B)', d['80CCD1B']),
        ('8c', 'Deduction u/s 80D', d['80D']),
        ('9', 'Total taxable income', inc['taxable']),
        ('10', 'Tax on total income', tax['slab_tax']),
        ('11', 'Rebate u/s 87A (incl. marginal relief)', tax['rebate_87a'] + tax['marginal_relief_87a']),
        ('12', 'Surcharge (after marginal relief)', tax['surcharge']),
        ('13', 'Health and education cess', tax['cess']),
        ('14', 'Relief u/s 89', 0),
        ('15', 'Net tax payable', tax['total']),
        ('16', 'Total tax deducted at source (as per payroll)', act['tds']),
    ]
    trs = ''.join(f'<tr><td>{e(a)}</td><td>{e(b)}</td><td class="n">{e(_money(c))}</td></tr>' for a, b, c in rows)
    q = act['quarter_tds']
    qrows = ''.join(f'<tr><td>Q{k}</td><td class="n">{e(_money(q[k]))}</td></tr>' for k in (1, 2, 3, 4))
    company = (co.legal_name or co.company_name) if co else ''
    addr = ', '.join(x for x in ([co.address_line1, co.address_line2, co.city, co.state, co.pincode] if co else []) if x)
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>Form 16 Part B — {e(fy)}</title>
<style>body{{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:13px}}h1{{font-size:18px;margin:0 0 4px}}
h2{{font-size:14px;margin:18px 0 6px}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #999;padding:5px 8px;text-align:left}}
td.n{{text-align:right;white-space:nowrap}}.note{{background:#fff7e0;border:1px solid #e0c060;padding:8px 10px;margin:10px 0}}
.muted{{color:#555}}@media print{{.note{{break-inside:avoid}}}}</style></head><body>
<h1>FORM No. 16 — PART B (Annexure)</h1>
<div class="muted">Details of salary paid and any other income and tax deducted · Financial year {e(fy)} · Assessment year {e(ay)}</div>
<div class="note"><b>Part A</b> (TDS deposited, challan / BIN details) must be downloaded from TRACES by the employer and
attached. This Part B is prepared from payroll records{' and the verified tax declaration' if it.uses_verified(decl) else ''}.</div>
<table><tr><th>Employer</th><td>{e(company)}<br><span class="muted">{e(addr)}</span></td><th>TAN of employer</th><td>{e(tan or 'not configured')}</td></tr>
<tr><th>Employee</th><td>{e(it._name(email))}<br><span class="muted">{e(comp.employee_code if comp else '')}</span></td><th>PAN of employee</th><td>{e(pan or 'PANNOTAVBL')}</td></tr>
<tr><th>Period with employer</th><td>{e(act['first'].strftime('%d/%m/%Y') if act['first'] else '-')} to {e(act['last'].strftime('%d/%m/%Y') if act['last'] else '-')}</td>
<th>Tax regime</th><td>{'Old regime (opted out of Sec 115BAC)' if y['regime'] == 'old' else 'New regime — Sec 115BAC'}</td></tr></table>
<h2>Computation of income and tax</h2><table><tr><th>#</th><th>Particulars</th><th>Amount</th></tr>{trs}</table>
<h2>Tax deducted by quarter (per payroll)</h2><table><tr><th>Quarter</th><th>TDS</th></tr>{qrows}</table>
<p class="muted">Generated by HRMS payroll on {e(it._today().strftime('%d/%m/%Y'))}. Verify against Part A (TRACES)
before issuing. Figures are rounded to the nearest rupee where the Act requires.</p></body></html>"""
    return doc, problems


# ── storage / payloads ────────────────────────────────────────────────────
def _store(kind, period, file_name, content, rows, actor, run_id=None, email='', mime='text/plain'):
    from ..models import StatutoryFiling
    raw = content.encode('utf-8') if mime != 'application/pdf' else base64.b64decode(content)
    return StatutoryFiling.objects.create(kind=kind, period=period, run_id=run_id, email=email, file_name=file_name,
                                          file_mime=mime, content=content, sha256=sec.sha256_hex(raw), row_count=rows,
                                          generated_by=actor, generated_at=timezone.now())


def filing_meta(f):
    return {'id': f.id, 'kind': f.kind, 'period': f.period, 'run_id': f.run_id, 'email': f.email,
            'file_name': f.file_name, 'mime': f.file_mime, 'sha256': f.sha256, 'row_count': f.row_count,
            'generated_by': f.generated_by, 'generated_at': f.generated_at.isoformat() if f.generated_at else None}


def _err(msg, status=400, **extra):
    body = {'message': str(msg)}
    body.update(extra)
    return Response(body, status=status)


def _body(request, allowed):
    data = request.data
    if not isinstance(data, dict):
        raise it.Bad('Send a JSON object.')
    unknown = set(data.keys()) - set(allowed)
    if unknown:
        raise it.Bad('Unknown field(s): ' + ', '.join(sorted(str(u)[:40] for u in unknown)[:5]))
    return data


def _run(data):
    from ..models import PayrollRun
    rid = data.get('run_id')
    if isinstance(rid, bool) or not isinstance(rid, int):
        raise it.Bad('run_id must be a number.')
    run = PayrollRun.objects.filter(pk=rid).first()
    if not run:
        raise it.Bad('Pay run not found.')
    if run.status == 'cancelled':
        raise it.Bad('This pay run is cancelled.')
    return run


def _blocked(res, allow_partial):
    if res['problems'] and not allow_partial:
        return _err(f"{len(res['problems'])} problem(s) must be fixed first (or generate a partial file that leaves "
                    f"those employees out).", 422, problems=res['problems'], warnings=res['warnings'])
    return None


def _audit_gen(request, email, user, f, extra=None):
    ch = {'kind': f.kind, 'period': f.period, 'rows': f.row_count, 'sha256': f.sha256, 'run_id': f.run_id,
          'employee': f.email}
    ch.update(extra or {})
    sec.audit('statutory_generated', 'StatutoryFiling', f.id, request, email, sec.display_name(user, email), changes=ch)


def _allow_partial(data):
    v = data.get('allow_partial', False)
    if not isinstance(v, bool):
        raise it.Bad('allow_partial must be true or false.')
    return v


# ── views ─────────────────────────────────────────────────────────────────
@api_view(['GET'])
def options(request):
    from ..models import PayrollRun
    email, user, err = sec.require(request, PERM)
    if err:
        return err
    runs = [{'id': r.id, 'period_label': r.period_label, 'status': r.status, 'employee_count': r.employee_count,
             'period_start': r.period_start.isoformat()}
            for r in PayrollRun.objects.exclude(status='cancelled').order_by('-period_start', '-id')[:36]]
    fys = sorted({it.fy_of(r.period_start) for r in PayrollRun.objects.only('period_start')} |
                 {it.fy_of(it._today())}, reverse=True)
    tan = _setting('employer_tan')
    return Response({'runs': runs, 'fys': fys, 'current_fy': it.fy_of(it._today()),
                     'employer_tan': tan, 'tan_configured': bool(_TAN_RE.match(tan)),
                     'esic_ip_count': len(_esic_map()), 'fvu_note': FVU_NOTE})


@api_view(['GET'])
def filings(request):
    from ..models import StatutoryFiling
    email, user, err = sec.require(request, PERM)
    if err:
        return err
    qs = StatutoryFiling.objects.filter(kind__in=('ECR', 'ESIC', '24Q', 'FORM16', 'FORM16A'))
    kind = (request.query_params.get('kind') or '').upper()
    if kind:
        qs = qs.filter(kind=kind)
    period = (request.query_params.get('period') or '').strip()[:20]
    if period:
        qs = qs.filter(period=period)
    return Response({'results': [filing_meta(f) for f in qs.order_by('-generated_at', '-id')[:300]]})


@api_view(['POST'])
def gen_ecr(request):
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    try:
        data = _body(request, {'run_id', 'allow_partial'})
        run, partial = _run(data), _allow_partial(data)
    except it.Bad as e:
        return _err(e)
    res = build_ecr(run)
    blocked = _blocked(res, partial)
    if blocked:
        return blocked
    if not res['rows']:
        return _err('No PF members with a valid UAN in this run — nothing to file.', 422,
                    problems=res['problems'], warnings=res['warnings'])
    f = _store('ECR', run.period_label, f'ECR_{run.period_label}.txt', res['content'], res['rows'], email, run_id=run.id)
    _audit_gen(request, email, user, f, {'excluded': len(res['problems'])})
    return Response({'filing': filing_meta(f), 'problems': res['problems'], 'warnings': res['warnings'],
                     'skipped': res['skipped']}, status=201)


@api_view(['POST'])
def gen_esic(request):
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    try:
        data = _body(request, {'run_id', 'allow_partial'})
        run, partial = _run(data), _allow_partial(data)
    except it.Bad as e:
        return _err(e)
    res = build_esic(run)
    blocked = _blocked(res, partial)
    if blocked:
        return blocked
    if not res['rows']:
        return _err('No ESIC-covered employees (gross ≤ ₹21,000) in this run.', 422,
                    problems=res['problems'], warnings=res['warnings'])
    f = _store('ESIC', run.period_label, f'ESIC_{run.period_label}.csv', res['content'], res['rows'], email,
               run_id=run.id, mime='text/csv')
    _audit_gen(request, email, user, f, {'excluded': len(res['problems'])})
    return Response({'filing': filing_meta(f), 'problems': res['problems'], 'warnings': res['warnings'],
                     'skipped': res['skipped']}, status=201)


@api_view(['POST'])
def gen_24q(request):
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    try:
        data = _body(request, {'fy', 'quarter', 'allow_partial'})
        fy = it._fy_param(data.get('fy'), default_today=False)
        q = data.get('quarter')
        if isinstance(q, bool) or q not in (1, 2, 3, 4):
            raise it.Bad('quarter must be 1, 2, 3 or 4.')
        partial = _allow_partial(data)
    except it.Bad as e:
        return _err(e)
    res = build_24q(fy, q)
    blocked = _blocked(res, partial)
    if blocked:
        return blocked
    period = f'Q{q}-{fy}'
    out = [_store('24Q', period, f'24Q_{period}_AnnexureI.csv', res['annex1'], res['annex1_rows'], email,
                  mime='text/csv')]
    if q == 4:
        out.append(_store('24Q', period, f'24Q_{period}_AnnexureII.csv', res['annex2'], res['annex2_rows'], email,
                          mime='text/csv'))
    for f in out:
        _audit_gen(request, email, user, f)
    return Response({'filings': [filing_meta(f) for f in out], 'problems': res['problems'],
                     'warnings': res['warnings'], 'fvu_note': FVU_NOTE,
                     'quarter': {'start': res['start'].isoformat(), 'end': res['end'].isoformat()}}, status=201)


@api_view(['POST'])
def gen_form16(request):
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    try:
        data = _body(request, {'fy', 'email'})
        fy = it._fy_param(data.get('fy'), default_today=False)
        target = data.get('email')
        if target is not None and (not isinstance(target, str) or '@' not in target or len(target) > 255):
            raise it.Bad('email is not valid.')
    except it.Bad as e:
        return _err(e)
    emails = _fy_emails(fy)
    if target:
        target = target.strip().lower()
        if target not in emails:
            return _err('No payslips for this employee in that financial year.', 404)
        emails = [target]
    if not emails:
        return _err('No payslips in that financial year.', 404)
    made, problems = [], []
    for em in emails[:1000]:
        doc, probs = build_form16(em, fy)
        for p in probs:
            if p['issue'] not in {x['issue'] for x in problems}:
                problems.append({'issue': p['issue']})
        safe = re.sub(r'[^a-z0-9]+', '_', em.split('@')[0])[:40]
        f = _store('FORM16', fy, f'Form16_PartB_{fy}_{safe}.html', doc, 1, email, email=em, mime='text/html')
        _audit_gen(request, email, user, f)
        made.append(filing_meta(f))
    return Response({'filings': made, 'problems': problems,
                     'note': 'Part A comes from TRACES — upload each employee\'s Part A PDF to attach it.'}, status=201)


@api_view(['POST'])
def upload_form16a(request):
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    try:
        data = _body(request, {'fy', 'email', 'file_name', 'mime', 'data'})
        fy = it._fy_param(data.get('fy'), default_today=False)
        target = data.get('email')
        if not isinstance(target, str) or '@' not in target or len(target) > 255:
            raise it.Bad('email is not valid.')
        target = target.strip().lower()
        if str(data.get('mime') or '').lower() != 'application/pdf':
            raise it.Bad('Part A must be the PDF downloaded from TRACES.')
        raw, msg = sec.check_upload(data.get('data'), 'application/pdf', max_mb=5)
        if raw is None:
            raise it.Bad(msg)
    except it.Bad as e:
        return _err(e)
    if target not in _fy_emails(fy):
        return _err('No payslips for this employee in that financial year.', 404)
    safe = re.sub(r'[^a-z0-9]+', '_', target.split('@')[0])[:40]
    f = _store('FORM16A', fy, f'Form16_PartA_{fy}_{safe}.pdf', base64.b64encode(raw).decode('ascii'), 1, email,
               email=target, mime='application/pdf')
    _audit_gen(request, email, user, f, {'uploaded': True, 'size': len(raw)})
    return Response({'filing': filing_meta(f)}, status=201)


@api_view(['GET'])
def download(request, pk):
    from ..models import StatutoryFiling
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    f = StatutoryFiling.objects.filter(pk=pk, kind__in=('ECR', 'ESIC', '24Q', 'FORM16', 'FORM16A')).first()
    if not f:
        return _err('Not found.', 404)
    sec.audit('statutory_downloaded', 'StatutoryFiling', f.id, request, email, sec.display_name(user, email),
              changes={'kind': f.kind, 'period': f.period, 'employee': f.email})
    return Response({'file_name': f.file_name, 'mime': f.file_mime, 'content': f.content, 'sha256': f.sha256,
                     'encoding': 'base64' if f.file_mime == 'application/pdf' else 'text'})


@api_view(['PUT'])
def esic_ip(request):
    from ..models import PayrollSetting
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    try:
        data = _body(request, {'email', 'ip_number'})
        target = data.get('email')
        if not isinstance(target, str) or '@' not in target or len(target) > 255:
            raise it.Bad('email is not valid.')
        ip = str(data.get('ip_number') or '').strip()
        if ip and not _IP_RE.match(ip):
            raise it.Bad('ESIC IP number must be 10 digits.')
    except it.Bad as e:
        return _err(e)
    with transaction.atomic():
        m = _esic_map()
        if ip:
            m[target.strip().lower()] = ip
        else:
            m.pop(target.strip().lower(), None)
        PayrollSetting.objects.update_or_create(key='esic_ip_numbers', defaults={
            'value': json.dumps(m, sort_keys=True), 'description': 'ESIC IP numbers by employee email'})
    sec.audit('esic_ip_updated', 'PayrollSetting', 'esic_ip_numbers', request, email, sec.display_name(user, email),
              changes={'employee': target, 'ip_number': ('••••••' + ip[-4:]) if ip else ''})
    return Response({'ok': True, 'count': len(m)})


@api_view(['PUT'])
def employer(request):
    from ..models import PayrollSetting
    email, user, err = sec.require(request, PERM, fresh=True)
    if err:
        return err
    try:
        data = _body(request, {'tan'})
        tan = str(data.get('tan') or '').strip().upper()
        if not _TAN_RE.match(tan):
            raise it.Bad('TAN must look like ABCD12345E.')
    except it.Bad as e:
        return _err(e)
    PayrollSetting.objects.update_or_create(key='employer_tan', defaults={'value': tan,
                                                                          'description': 'Employer TAN (Form 16 / 24Q)'})
    sec.audit('employer_tan_updated', 'PayrollSetting', 'employer_tan', request, email, sec.display_name(user, email),
              changes={'tan': tan})
    return Response({'employer_tan': tan, 'tan_configured': True})
