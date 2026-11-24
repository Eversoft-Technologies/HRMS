"""Employee self-service for payroll: password-protected payslips, expense
claims (paid through payroll), salary advances / loans, Total Rewards.

Security model (see api/payroll_ext/security.py)
-----------------------------------------------
* Every endpoint goes through ``security.require``. Money / approval actions
  (decide, disburse, foreclose, download a payslip file, email payslips) need a
  fresh sign-in (a valid JWT for the same person as X-User-Email).
* Object level: an employee only ever sees their own payslips / claims / loans.
  Anything else answers 404 (we do not confirm that an id exists).
* Approvers: a claim is decided by the employee's linked manager or by someone
  holding ``expense.approve``; a loan by someone holding
  ``payroll.loans.approve``. Nobody decides their own request.
* Receipts are content-checked (``check_upload``) and never sent in lists.
* Payslip PDFs are AES-256 encrypted (pypdf) with a per-employee password; the
  owner password is random and discarded. Email bodies never carry salary
  figures and passwords are never logged or stored.

Calculation hooks (called by PayrollService.calculate_employee_pay)
------------------------------------------------------------------
* ``apply_expenses`` — approved, unpaid claims → earning lines ``REIMB``
  (non-taxable) and ``REIMB_TAX`` (taxable: over-cap excess or a taxable
  category). With a run id the claims are marked paid in that run; re-running
  the same run re-includes them, another run never pays them again.
* ``apply_loans`` — due EMIs of active loans → deduction line ``LOAN_EMI``.
  The EMI never takes net pay below zero: what does not fit is carried forward
  as an extra installment (same period, so the next run picks it up). A re-run
  of the same run first reverts what that run deducted, then re-applies.
"""
import base64
import calendar
import io
import json
import logging
import os
import re
import secrets
import smtplib
import ssl
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

from django.db import transaction
from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import D, recompute, set_line
from . import security

logger = logging.getLogger(__name__)

# ── constants / policy defaults ───────────────────────────────────────────
EXPENSE_CATEGORIES = {
    'travel': 'Travel',
    'client_entertainment': 'Client entertainment',
    'internet': 'Internet',
    'phone': 'Phone',
    'meals': 'Meals',
    'other': 'Other',
}
DEFAULT_EXPENSE_CAPS = {'internet': 1000, 'phone': 1000}          # per employee per calendar month
DEFAULT_EXPENSE_POLICY = {'max_claim_amount': 500000, 'max_age_days': 90, 'receipt_required': True,
                          'taxable_categories': []}
DEFAULT_LOAN_POLICY = {
    'max_advance_multiple_of_net': 1,      # advance ≤ 1 × monthly net pay
    'max_loan_multiple_of_gross': 6,       # loan ≤ 6 × monthly gross
    'max_tenure_months': 24,               # loans
    'max_advance_tenure_months': 3,        # advances
    'interest_rate': 0,                    # annual %, loans only (advances are interest free)
    'method': 'reducing',                  # reducing | flat
    'max_open': 2,                         # requested + approved + active, per employee
    'min_amount': 500,
}
PASSWORD_PATTERNS = ('NAME4_DOBDDMM', 'PAN')
HEALTH_INSURANCE_CODES = ('HEALTH_INSURANCE', 'MEDICAL_INSURANCE', 'GROUP_HEALTH_INSURANCE', 'GMC')
BASIC_CODES = ('BASIC_SALARY', 'BASIC')
DA_CODES = ('DA', 'DEARNESS_ALLOWANCE')
VARIABLE_CODES = ('PERFORMANCE_BONUS', 'BONUS', 'INCENTIVE', 'OVERTIME', 'ARREARS')
REIMB_CODES = ('REIMB', 'REIMB_TAX', 'REIMBURSEMENT', 'EXPENSE_REIMB')
MAX_MONEY = Decimal('100000000')         # 10 crore: hard upper bound for any input amount
SETTLED_IN_FNF = 'fnf'                   # ExpenseClaim.decision_note prefix when paid through F&F


# ── small helpers ─────────────────────────────────────────────────────────
def _err(message, status=400, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _norm(v):
    return str(v or '').strip().lower()


def _today():
    try:
        from ..timeutil import local_today
        return local_today()
    except Exception:
        return date.today()


def _now():
    return timezone.now()


def _iso(v):
    if not v:
        return None
    return v.isoformat() if hasattr(v, 'isoformat') else str(v)


def money(v):
    return float(D(v))


def parse_amount(v, lo=Decimal('0.01'), hi=MAX_MONEY):
    """Strict money input: a number with at most 2 decimals inside [lo, hi]."""
    if isinstance(v, bool) or v is None or v == '':
        raise ValueError('Enter an amount.')
    s = str(v).strip().replace(',', '')
    if not re.match(r'^\d{1,12}(\.\d{1,2})?$', s):
        raise ValueError('Amounts must be positive numbers with at most 2 decimals.')
    d = Decimal(s)
    if d < lo or d > hi:
        raise ValueError(f'Amount must be between {lo} and {hi}.')
    return d


def parse_int(v, lo, hi, what='Value'):
    try:
        if isinstance(v, bool):
            raise ValueError
        i = int(str(v).strip())
    except (TypeError, ValueError):
        raise ValueError(f'{what} must be a whole number.')
    if i < lo or i > hi:
        raise ValueError(f'{what} must be between {lo} and {hi}.')
    return i


def parse_date(v, what='Date'):
    try:
        return datetime.strptime(str(v or '').strip()[:10], '%Y-%m-%d').date()
    except (TypeError, ValueError):
        raise ValueError(f'{what} must be a date (YYYY-MM-DD).')


def clean_text(v, max_len=1000):
    s = str(v or '')
    s = ''.join(ch for ch in s if ch in '\n\t' or ord(ch) >= 32)
    return s.strip()[:max_len]


def period_of(d):
    return f'{d.year:04d}-{d.month:02d}'


def next_period(p, n=1):
    y, m = int(p[:4]), int(p[5:7])
    m += n
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return f'{y:04d}-{m:02d}'


_PERIOD_RE = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')


def setting_json(key, default):
    """PayrollSetting JSON merged over a default dict (or the raw value when the default is not a dict)."""
    from ..models import PayrollSetting
    row = PayrollSetting.objects.filter(key=key).first()
    val = None
    if row and row.value:
        try:
            val = json.loads(row.value)
        except ValueError:
            val = row.value
    if isinstance(default, dict):
        out = dict(default)
        if isinstance(val, dict):
            out.update(val)
        return out
    return default if val is None else val


def setting_str(key, default=''):
    from ..models import PayrollSetting
    row = PayrollSetting.objects.filter(key=key).first()
    if not row or not row.value:
        return default
    v = row.value.strip()
    try:
        j = json.loads(v)
        if isinstance(j, str):
            return j
    except ValueError:
        pass
    return v


def person_name(email):
    from ..models import AppUser, UserProfile
    p = UserProfile.objects.filter(email__iexact=email).first()
    if p and (p.first_name or p.last_name):
        return f'{(p.first_name or "").strip()} {(p.last_name or "").strip()}'.strip()
    u = AppUser.objects.filter(email__iexact=email).first()
    if u and u.full_name:
        return u.full_name.strip()
    return email.split('@')[0].title()


def latest_payslip(email, statuses=('approved', 'paid')):
    from ..models import Payslip
    return (Payslip.objects.filter(email__iexact=email, status__in=statuses).select_related('run')
            .order_by('-run__period_start', '-id').first())


def current_comp(email):
    from ..models import EmployeeCompensation
    return (EmployeeCompensation.objects.filter(email__iexact=email, status='active')
            .order_by('-effective_from', '-id').first()
            or EmployeeCompensation.objects.filter(email__iexact=email).order_by('-effective_from', '-id').first())


def _sum_codes(lines, codes):
    return sum((D(l.get('amount')) for l in (lines or []) if str(l.get('code')).upper() in codes), Decimal('0'))


def is_regular_earning(code):
    c = str(code or '').upper()
    return not (c in VARIABLE_CODES or c in REIMB_CODES or c.startswith('ADJ_'))


def salary_basis(email):
    """Last drawn monthly figures used by loan limits, Total Rewards and F&F.
    {gross, net, basic, da, currency, source}. Gross = regular earnings of the
    latest approved / paid payslip (no bonus, overtime, reimbursements or
    one-off adjustments); falls back to the active compensation record
    (basic = base_amount, gross = annual CTC / 12, net ≈ gross)."""
    ps = latest_payslip(email)
    comp = current_comp(email)
    if ps:
        earn = ps.earnings_data or []
        gross = sum((D(l.get('amount')) for l in earn if is_regular_earning(l.get('code'))), Decimal('0'))
        basic = _sum_codes(earn, BASIC_CODES)
        if not basic and comp:
            basic = D(comp.base_amount)
        return {'gross': D(gross or ps.gross_earnings), 'net': D(ps.net_pay), 'basic': D(basic),
                'da': D(_sum_codes(earn, DA_CODES)), 'currency': (comp.currency if comp else 'INR') or 'INR',
                'source': f'payslip {ps.run.period_label}', 'payslipId': ps.id}
    if comp:
        gross = D(comp.annual_ctc) / 12 if comp.annual_ctc else D(comp.base_amount) * 2
        return {'gross': D(gross), 'net': D(gross), 'basic': D(comp.base_amount), 'da': Decimal('0'),
                'currency': comp.currency or 'INR', 'source': 'compensation record', 'payslipId': None}
    return {'gross': Decimal('0'), 'net': Decimal('0'), 'basic': Decimal('0'), 'da': Decimal('0'),
            'currency': 'INR', 'source': 'none', 'payslipId': None}


def _company_name():
    try:
        from ..models import CompanyDetail
        c = CompanyDetail.objects.first()
        if c and c.company_name:
            return c.company_name
    except Exception:
        pass
    return 'EverSoft Technologies'


def _reports_of(email):
    from ..org_views import reports_of
    return [_norm(e) for e in reports_of(email)]


def _is_manager_of(manager, employee):
    from ..org_views import is_manager_of
    return is_manager_of(manager, employee)


# ═════════════════════════════════════════════════════════════════════════
# 1. Password-protected payslip PDFs
# ═════════════════════════════════════════════════════════════════════════
def _dob(email):
    """Date of birth on record (onboarding form), or None."""
    try:
        from ..models import OnboardingCandidate
        row = (OnboardingCandidate.objects.filter(email__iexact=email, is_deleted=False, dob__isnull=False)
               .order_by('-id').first())
        return row.dob if row else None
    except Exception:
        return None


from ..fields import is_locked  # noqa: E402


def _pan(payslip):
    pan = (payslip.pan_number or '').strip().upper()
    if not pan:
        comp = current_comp(payslip.email)
        pan = (comp.pan_number or '').strip().upper() if comp else ''
    return pan if security.is_valid_pan(pan) else ''


def password_pattern():
    p = setting_str('payslip_password_pattern', 'NAME4_DOBDDMM').upper()
    return p if p in PASSWORD_PATTERNS else 'NAME4_DOBDDMM'


PATTERN_TEXT = {
    'NAME4_DOBDDMM': 'the first 4 letters of your name in capitals followed by your date of birth as DDMM '
                     '(for example, "Anil" born on 23 August types ANIL2308)',
    'PAN': 'your PAN in capital letters (for example ABCDE1234F)',
}


def payslip_password(payslip):
    """(password, pattern_used) or (None, None) when no data is on record.
    Never log or store the returned password."""
    letters = re.sub(r'[^A-Za-z]', '', payslip.employee_name or person_name(payslip.email)).upper()[:4]
    dob = _dob(payslip.email)
    pan = _pan(payslip)
    name_dob = (letters + dob.strftime('%d%m')) if (letters and dob) else None
    if password_pattern() == 'PAN':
        if pan:
            return pan, 'PAN'
        return (name_dob, 'NAME4_DOBDDMM') if name_dob else (None, None)
    if name_dob:
        return name_dob, 'NAME4_DOBDDMM'
    if pan:
        return pan, 'PAN'
    return None, None


def _fmt_amt(v):
    d = D(v)
    neg = d < 0
    d = abs(d)
    whole, frac = f'{d:.2f}'.split('.')
    # Indian digit grouping: 12,34,567.00
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ','.join(groups + [tail])
    return ('-' if neg else '') + whole + '.' + frac


def render_payslip_pdf(payslip):
    """Plain (unencrypted) payslip PDF bytes rendered with reportlab."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from xml.sax.saxutils import escape as x

    run = payslip.run
    buf = io.BytesIO()
    month = run.period_start.strftime('%B %Y') if run.period_start else run.period_label
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=14 * mm,
                            bottomMargin=14 * mm, title=f'Payslip {month}', author=_company_name(),
                            subject='Payslip', creator='HRMS')
    ss = getSampleStyleSheet()
    h = ParagraphStyle('h', parent=ss['Title'], fontSize=15, leading=18, spaceAfter=2)
    sub = ParagraphStyle('s', parent=ss['Normal'], fontSize=9, textColor=colors.HexColor('#555555'), alignment=1)
    small = ParagraphStyle('sm', parent=ss['Normal'], fontSize=8.5, leading=11)
    story = [Paragraph(x(_company_name().upper()), h),
             Paragraph(x(f'Payslip for the month of {month}'), sub), Spacer(1, 8)]

    comp = current_comp(payslip.email)
    currency = (comp.currency if comp else 'INR') or 'INR'
    acct = '' if is_locked(payslip.bank_account_number) else security.mask_account(payslip.bank_account_number)
    info = [
        ['Employee name', payslip.employee_name or '', 'Employee code', payslip.employee_code or ''],
        ['Designation', payslip.designation or '', 'Date of joining', payslip.doj.strftime('%d-%m-%Y') if payslip.doj else ''],
        ['PAN', security.mask_pan(payslip.pan_number) if payslip.pan_number and not is_locked(payslip.pan_number) else '',
         'UAN', '' if is_locked(payslip.uan_number) else (payslip.uan_number or '')],
        ['Bank', payslip.bank_name or '', 'Account', acct],
        ['Days in month', str(payslip.month_days), 'Paid days', f'{D(payslip.paid_days)}'],
        ['LOP days', f'{D(payslip.lop_days)}', 'Pay period',
         f'{run.period_start:%d-%m-%Y} to {run.period_end:%d-%m-%Y}' if run.period_start else run.period_label],
    ]
    t = Table([[Paragraph(x(str(c)), small) for c in row] for row in info], colWidths=[32 * mm, 54 * mm, 32 * mm, 60 * mm])
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#999999')),
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f1f4f8')),
        ('BACKGROUND', (2, 0), (2, -1), colors.HexColor('#f1f4f8')),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    story += [t, Spacer(1, 10)]

    earn = payslip.earnings_data or []
    ded = payslip.deductions_data or []
    rows = [['Earnings', f'Amount ({currency})', 'Deductions', f'Amount ({currency})']]
    for i in range(max(len(earn), len(ded), 1)):
        e = earn[i] if i < len(earn) else None
        d = ded[i] if i < len(ded) else None
        rows.append([Paragraph(x(str(e.get('label') or e.get('code'))), small) if e else '',
                     _fmt_amt(e.get('amount')) if e else '',
                     Paragraph(x(str(d.get('label') or d.get('code'))), small) if d else '',
                     _fmt_amt(d.get('amount')) if d else ''])
    rows.append(['Gross earnings', _fmt_amt(payslip.gross_earnings), 'Total deductions', _fmt_amt(payslip.total_deductions)])
    t2 = Table(rows, colWidths=[58 * mm, 31 * mm, 58 * mm, 31 * mm])
    t2.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#999999')),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1f3b63')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
        ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#f1f4f8')),
        ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
        ('ALIGN', (3, 0), (3, -1), 'RIGHT'),
        ('FONTSIZE', (0, 0), (-1, -1), 8.5),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    story += [t2, Spacer(1, 8)]
    net = Table([['NET PAY', f'{currency} {_fmt_amt(payslip.net_pay)}']], colWidths=[147 * mm, 31 * mm])
    net.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.8, colors.HexColor('#1f3b63')),
        ('FONTNAME', (0, 0), (-1, -1), 'Helvetica-Bold'),
        ('ALIGN', (1, 0), (1, 0), 'RIGHT'),
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#eaf6ee')),
    ]))
    story.append(net)
    try:
        from ..services.payroll_service import amount_to_words_inr
        if currency == 'INR':
            story += [Spacer(1, 4), Paragraph(x('Net pay in words: ' + amount_to_words_inr(payslip.net_pay)), small)]
    except Exception:
        pass
    contrib = [l for l in (payslip.employer_contributions_data or []) if str(l.get('code')).upper() != 'GROSS_EARNING']
    if contrib:
        story += [Spacer(1, 8), Paragraph('<b>Employer contributions</b>', small)]
        ct = Table([[Paragraph(x(str(l.get('label') or l.get('code'))), small), _fmt_amt(l.get('amount'))] for l in contrib],
                   colWidths=[147 * mm, 31 * mm])
        ct.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#bbbbbb')),
                                ('ALIGN', (1, 0), (1, -1), 'RIGHT'), ('FONTSIZE', (0, 0), (-1, -1), 8.5)]))
        story.append(ct)
    story += [Spacer(1, 14), Paragraph(x('This is a computer-generated payslip and does not require a signature.'), sub)]
    doc.build(story)
    return buf.getvalue()


def encrypt_pdf(raw, user_password):
    """AES-256 encrypt ``raw`` PDF bytes. The owner password is random and
    never stored, so nobody can lift the restrictions."""
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(raw)))
    kwargs = {}
    try:
        from pypdf.constants import UserAccessPermissions as P
        kwargs['permissions_flag'] = P.PRINT | P.PRINT_TO_REPRESENTATION | P.EXTRACT_TEXT_AND_GRAPHICS
    except Exception:
        pass
    writer.encrypt(user_password=user_password, owner_password=secrets.token_urlsafe(32),
                   algorithm='AES-256', **kwargs)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def encrypted_payslip(payslip):
    """(pdf_bytes, pattern) or (None, None) when no password can be derived."""
    pw, pattern = payslip_password(payslip)
    if not pw:
        return None, None
    return encrypt_pdf(render_payslip_pdf(payslip), pw), pattern


def payslip_filename(payslip):
    return f'Payslip_{payslip.run.period_label}_{re.sub(r"[^A-Za-z0-9]+", "_", payslip.email.split("@")[0])}.pdf'


# ── attachment-capable sender (api.mailer.send_email has no attachments) ──
def send_email_with_attachment(to, subject, html, text, filename, content, mime='application/pdf'):
    """Send one email with one attachment using the same configuration as
    api.mailer (Resend API first, SMTP fallback). Returns {'ok', 'error'?}."""
    from .. import mailer
    to = str(to or '').strip()
    if not to:
        return {'ok': False, 'error': 'Recipient email is missing'}
    s = mailer.get_email_settings()
    if not s:
        return {'ok': False, 'error': 'No email configuration found.'}
    if s.get('type') == 'resend':
        res = _send_resend_attachment(s, to, subject, html, text, filename, content)
        if res.get('ok') or not res.get('fallback'):
            return res
        s = mailer.get_smtp_settings()
        if not s:
            return res
    return _send_smtp_attachment(s, to, subject, html, text, filename, content, mime)


def _send_resend_attachment(s, to, subject, html, text, filename, content):
    import requests
    payload = {'from': formataddr((s['from_name'], s['from_email'])), 'to': to, 'subject': subject,
               'html': html, 'text': text,
               'attachments': [{'filename': filename, 'content': base64.b64encode(content).decode('ascii')}]}
    try:
        r = requests.post('https://api.resend.com/emails', json=payload, timeout=30,
                          headers={'Authorization': f"Bearer {s['api_key']}", 'Content-Type': 'application/json'})
        if r.ok:
            return {'ok': True}
        return {'ok': False, 'error': f'Resend API error ({r.status_code})', 'fallback': r.status_code == 403}
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': f'{type(e).__name__}'}


def _send_smtp_attachment(s, to, subject, html, text, filename, content, mime):
    msg = MIMEMultipart('mixed')
    msg['Subject'] = subject
    msg['From'] = formataddr((s['from_name'], s['from_email']))
    msg['To'] = to
    alt = MIMEMultipart('alternative')
    alt.attach(MIMEText(text or '', 'plain', 'utf-8'))
    alt.attach(MIMEText(html or text or '', 'html', 'utf-8'))
    msg.attach(alt)
    part = MIMEApplication(content, _subtype=mime.split('/')[-1])
    part.add_header('Content-Disposition', 'attachment', filename=filename)
    msg.attach(part)
    try:
        ctx = ssl.create_default_context()
        if s.get('secure') or s.get('port') == 465:
            server = smtplib.SMTP_SSL(s['host'], s['port'], timeout=15, context=ctx)
        else:
            server = smtplib.SMTP(s['host'], s['port'], timeout=15)
            server.ehlo()
            try:
                server.starttls(context=ctx)
                server.ehlo()
            except smtplib.SMTPException:
                pass
        if s.get('password'):
            server.login(s['user'], s['password'])
        server.sendmail(s['from_email'], [to], msg.as_string())
        server.quit()
        return {'ok': True}
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': f'{type(e).__name__}'}


def _mask_email(e):
    local, _, dom = (e or '').partition('@')
    return (local[:1] + '***@' + dom) if dom else '***'


def payslip_email_content(payslip, pattern):
    """(subject, html, text). Deliberately free of any salary figure."""
    from .. import mailer
    run = payslip.run
    month = run.period_start.strftime('%B %Y') if run.period_start else run.period_label
    first = (payslip.employee_name or person_name(payslip.email)).split(' ')[0]
    how = ('the first 4 letters of your name in capitals followed by your date of birth as DDMM'
           if pattern == 'NAME4_DOBDDMM' else 'your PAN in capital letters')
    subject = f'Your payslip for {month}'
    intro = (f'Hi {first}, your payslip for {month} is attached as a password-protected PDF. '
             f'To open it, enter {how}.')
    footer = ('For your security the password is never sent by email. If you cannot open the file, '
              'download it from My Pay in HRMS or contact HR.')
    try:
        html = mailer.render_branded(title='Your payslip is ready', intro=intro, footer=footer)
    except Exception:
        html = f'<p>{intro}</p><p>{footer}</p>'
    text = f'{intro}\n\n{footer}'
    return subject, html, text


def email_payslip(payslip, actor='system', force=False):
    """Email one approved/paid payslip as an encrypted PDF. Idempotent: a
    payslip with a 'sent' ChannelDelivery (channel=email, purpose=payslip,
    ref=payslip id) is skipped unless ``force``. Returns a status string:
    sent | already_sent | skipped_no_password | skipped_status | failed."""
    from ..models import ChannelDelivery, Payslip
    if payslip.status not in ('approved', 'paid'):
        return 'skipped_status'
    ref = str(payslip.id)
    with transaction.atomic():
        Payslip.objects.select_for_update().filter(id=payslip.id).first()
        prev = ChannelDelivery.objects.filter(channel='email', purpose='payslip', ref=ref)
        if not force and prev.filter(status='sent').exists():
            return 'already_sent'
        stale = _now() - timedelta(minutes=10)
        if prev.filter(status='queued', created_at__gte=stale).exists():
            return 'already_sent'          # another worker is sending it right now
        row = ChannelDelivery.objects.create(channel='email', purpose='payslip', ref=ref, email=payslip.email,
                                             recipient=_mask_email(payslip.email), status='queued')
    pdf, pattern = encrypted_payslip(payslip)
    if not pdf:
        row.status, row.error = 'failed', 'No date of birth or PAN on record to protect the PDF'
        row.save(update_fields=['status', 'error'])
        return 'skipped_no_password'
    subject, html, text = payslip_email_content(payslip, pattern)
    res = send_email_with_attachment(payslip.email, subject, html, text, payslip_filename(payslip), pdf)
    row.status = 'sent' if res.get('ok') else 'failed'
    row.error = '' if res.get('ok') else str(res.get('error') or 'send failed')[:255]
    row.save(update_fields=['status', 'error'])
    security.audit('payslip_emailed' if res.get('ok') else 'payslip_email_failed', 'Payslip', payslip.id,
                   email=actor, changes={'runId': payslip.run_id, 'to': _mask_email(payslip.email)})
    return 'sent' if res.get('ok') else 'failed'


def email_payslips_for_run(run_id, actor='system', force=False):
    """Email every approved / paid payslip of a run (callable from a
    disbursal flow). Returns counts per outcome."""
    from ..models import Payslip
    out = {'sent': 0, 'already_sent': 0, 'skipped_no_password': 0, 'skipped_status': 0, 'failed': 0}
    for ps in Payslip.objects.filter(run_id=run_id, status__in=('approved', 'paid')).select_related('run'):
        try:
            r = email_payslip(ps, actor=actor, force=force)
        except Exception:
            logger.exception('payslip email failed for payslip %s', ps.id)
            r = 'failed'
        out[r] = out.get(r, 0) + 1
    return out


# ═════════════════════════════════════════════════════════════════════════
# 2. Expense claims
# ═════════════════════════════════════════════════════════════════════════
def expense_caps():
    raw = setting_json('expense_caps', None)
    caps = dict(DEFAULT_EXPENSE_CAPS) if raw is None else {}
    taxable = set()
    if isinstance(raw, dict):
        for k, v in raw.items():
            k = str(k).lower()
            if k not in EXPENSE_CATEGORIES:
                continue
            if isinstance(v, dict):
                if v.get('cap') not in (None, ''):
                    try:
                        caps[k] = Decimal(str(v['cap']))
                    except Exception:
                        pass
                if v.get('taxable'):
                    taxable.add(k)
            elif v not in (None, ''):
                try:
                    caps[k] = Decimal(str(v))
                except Exception:
                    pass
    pol = setting_json('expense_policy', DEFAULT_EXPENSE_POLICY)
    for c in pol.get('taxable_categories') or []:
        if str(c).lower() in EXPENSE_CATEGORIES:
            taxable.add(str(c).lower())
    return {k: D(v) for k, v in caps.items()}, taxable


def _month_bounds(d):
    return d.replace(day=1), d.replace(day=calendar.monthrange(d.year, d.month)[1])


def category_month_total(email, category, d, exclude_id=None, statuses=('submitted', 'approved', 'paid')):
    from ..models import ExpenseClaim
    a, b = _month_bounds(d)
    qs = ExpenseClaim.objects.filter(email__iexact=email, category=category, expense_date__gte=a,
                                     expense_date__lte=b, status__in=statuses)
    if exclude_id:
        qs = qs.exclude(id=exclude_id)
    return sum((D(c.amount) for c in qs), Decimal('0'))


def cap_info(claim):
    caps, taxable_cats = expense_caps()
    cap = caps.get(claim.category)
    if cap is None:
        return {'cap': None, 'overCap': False, 'monthTotal': None, 'taxableCategory': claim.category in taxable_cats}
    total = category_month_total(claim.email, claim.category, claim.expense_date, exclude_id=claim.id) + D(claim.amount)
    return {'cap': money(cap), 'overCap': total > cap, 'monthTotal': money(total),
            'taxableCategory': claim.category in taxable_cats}


def claim_split(claim, caps=None, taxable_cats=None):
    """(non_taxable, taxable) parts of an approved claim. In a capped
    category the claims of that calendar month (approved or paid, ordered by
    date then id) fill the cap first; anything beyond the cap is taxable."""
    from ..models import ExpenseClaim
    if caps is None:
        caps, taxable_cats = expense_caps()
    amt = D(claim.amount)
    if claim.category in (taxable_cats or set()):
        return Decimal('0'), amt
    cap = caps.get(claim.category)
    if cap is None:
        return (Decimal('0'), amt) if claim.taxable else (amt, Decimal('0'))
    a, b = _month_bounds(claim.expense_date)
    earlier = Decimal('0')
    for c in (ExpenseClaim.objects.filter(email__iexact=claim.email, category=claim.category, expense_date__gte=a,
                                          expense_date__lte=b, status__in=('approved', 'paid'))
              .order_by('expense_date', 'id')):
        if c.id == claim.id:
            break
        earlier += D(c.amount)
    room = max(Decimal('0'), cap - earlier)
    non_tax = min(amt, room)
    return non_tax, amt - non_tax


def claim_dict(c, viewer=None, with_cap=True):
    out = {
        'id': c.id, 'email': c.email, 'employeeName': c.employee_name, 'category': c.category,
        'categoryLabel': EXPENSE_CATEGORIES.get(c.category, c.category), 'amount': money(c.amount),
        'currency': c.currency, 'expenseDate': _iso(c.expense_date), 'description': c.description,
        'hasReceipt': bool(c.receipt_name or c.receipt_mime), 'receiptName': c.receipt_name, 'taxable': c.taxable,
        'status': c.status, 'decidedBy': c.decided_by, 'decidedAt': _iso(c.decided_at),
        'decisionNote': c.decision_note, 'paidRunId': c.paid_run_id if (c.paid_run_id or 0) > 0 else None,
        'settledInFnf': c.status == 'paid' and (c.paid_run_id or 0) < 0, 'createdAt': _iso(c.created_at),
    }
    if with_cap:
        out.update(cap_info(c))
    return out


def _can_decide_claim(email, user, claim):
    if _norm(claim.email) == email:
        return False
    if security.has_perm(user, 'expense.approve'):
        return True
    return email == _norm(claim.approver_email) or _is_manager_of(email, claim.email)


def _visible_claim(request, email, user, pk):
    from ..models import ExpenseClaim
    c = ExpenseClaim.objects.filter(id=pk).first()
    if not c:
        return None
    if _norm(c.email) == email or _can_decide_claim(email, user, c):
        return c
    return None


@api_view(['GET', 'POST'])
def my_expenses(request):
    from ..models import ExpenseClaim
    if request.method == 'GET':
        email, user, denied = security.require(request, None)
        if denied:
            return denied
        rows = ExpenseClaim.objects.filter(email__iexact=email).defer('receipt_data')[:300]
        caps, taxable = expense_caps()
        return Response({'claims': [claim_dict(c) for c in rows],
                         'categories': [{'value': k, 'label': v} for k, v in EXPENSE_CATEGORIES.items()],
                         'caps': {k: money(v) for k, v in caps.items()}, 'taxableCategories': sorted(taxable),
                         'policy': setting_json('expense_policy', DEFAULT_EXPENSE_POLICY)})
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    body = request.data or {}
    pol = setting_json('expense_policy', DEFAULT_EXPENSE_POLICY)
    try:
        category = str(body.get('category') or '').strip().lower()
        if category not in EXPENSE_CATEGORIES:
            raise ValueError('Choose a valid expense category.')
        amount = parse_amount(body.get('amount'), hi=min(MAX_MONEY, D(pol.get('max_claim_amount') or MAX_MONEY)))
        exp_date = parse_date(body.get('expenseDate'), 'Expense date')
        today = _today()
        if exp_date > today:
            raise ValueError('The expense date cannot be in the future.')
        max_age = int(pol.get('max_age_days') or 0)
        if max_age and (today - exp_date).days > max_age:
            raise ValueError(f'Claims must be filed within {max_age} days of the expense.')
        description = clean_text(body.get('description'), 1000)
        if len(description) < 3:
            raise ValueError('Describe the expense.')
    except ValueError as e:
        return _err(str(e))
    raw, mime, name = None, '', ''
    if body.get('receiptData'):
        raw, why = security.check_upload(body.get('receiptData'), body.get('receiptMime'), 5)
        if why:
            return _err(why)
        mime = str(body.get('receiptMime')).lower().strip()
        name = os.path.basename(clean_text(body.get('receiptName'), 200).replace('\\', '/')) or 'receipt'
    elif pol.get('receipt_required', True):
        return _err('Attach the receipt (PDF, PNG or JPG, up to 5 MB).')
    comp = current_comp(email)
    from ..org_views import approver_for
    c = ExpenseClaim.objects.create(
        email=email, employee_name=person_name(email), category=category, amount=amount,
        currency=(comp.currency if comp else 'INR') or 'INR', expense_date=exp_date, description=description,
        receipt_name=name[:255], receipt_mime=mime, receipt_data=base64.b64encode(raw).decode('ascii') if raw else '',
        status='submitted', approver_email=approver_for(email))
    security.audit('expense_submitted', 'ExpenseClaim', c.id, request, email, security.display_name(user, email),
                   changes={'category': category, 'amount': str(amount), 'expenseDate': str(exp_date),
                            'receiptSha256': security.sha256_hex(raw) if raw else ''})
    return Response(claim_dict(c), status=201)


@api_view(['GET'])
def expense_receipt(request, pk):
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    c = _visible_claim(request, email, user, pk)
    if not c or not c.receipt_data:
        return _err('Receipt not found', 404)
    security.audit('expense_receipt_viewed', 'ExpenseClaim', c.id, request, email)
    return Response({'name': c.receipt_name, 'mime': c.receipt_mime, 'data': c.receipt_data})


@api_view(['POST'])
def expense_cancel(request, pk):
    from ..models import ExpenseClaim
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    c = ExpenseClaim.objects.filter(id=pk, email__iexact=email).first()
    if not c:
        return _err('Claim not found', 404)
    if c.status != 'submitted':
        return _err('Only a claim that is still awaiting approval can be withdrawn.', 409)
    c.status = 'withdrawn'
    c.save(update_fields=['status'])
    security.audit('expense_withdrawn', 'ExpenseClaim', c.id, request, email)
    return Response(claim_dict(c))


@api_view(['GET'])
def expense_approvals(request):
    """Claims the caller may decide: their reports' (as manager) or all with
    expense.approve. ?status=submitted (default) | approved | rejected | paid | all."""
    from ..models import ExpenseClaim
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    status = str(request.GET.get('status') or 'submitted').lower()
    qs = ExpenseClaim.objects.exclude(email__iexact=email).defer('receipt_data')
    if not security.has_perm(user, 'expense.approve'):
        reports = _reports_of(email)
        qs = qs.filter(Q(email__in=reports) | Q(approver_email__iexact=email)) if reports else qs.filter(approver_email__iexact=email)
    if status != 'all':
        if status not in ('submitted', 'approved', 'rejected', 'paid', 'withdrawn'):
            return _err('Unknown status filter.')
        qs = qs.filter(status=status)
    return Response({'claims': [claim_dict(c) for c in qs[:300]],
                     'canApproveAll': security.has_perm(user, 'expense.approve'),
                     'hasReports': bool(_reports_of(email))})


@api_view(['POST'])
def expense_decide(request, pk):
    from ..models import ExpenseClaim
    email, user, denied = security.require(request, None, fresh=True)
    if denied:
        return denied
    body = request.data or {}
    action = str(body.get('action') or '').lower()
    if action not in ('approve', 'reject'):
        return _err('action must be approve or reject.')
    note = clean_text(body.get('note'), 255)
    with transaction.atomic():
        c = ExpenseClaim.objects.select_for_update().filter(id=pk).first()
        if not c:
            return _err('Claim not found', 404)
        if _norm(c.email) == email:
            return _err('You cannot decide your own claim.', 403, 'SELF_APPROVAL')
        if not _can_decide_claim(email, user, c):
            return _err('Claim not found', 404)
        if c.status != 'submitted':
            return _err(f'This claim is already {c.status}.', 409)
        if action == 'reject' and not note:
            return _err('Give a reason for rejecting the claim.')
        info = cap_info(c)
        c.status = 'approved' if action == 'approve' else 'rejected'
        c.decided_by, c.decided_at, c.decision_note = email, _now(), note
        if action == 'approve':
            if 'taxable' in body:
                c.taxable = bool(body.get('taxable'))
            else:
                c.taxable = bool(info['overCap'] or info['taxableCategory'])
        c.save()
    security.audit('expense_' + ('approved' if action == 'approve' else 'rejected'), 'ExpenseClaim', c.id, request,
                   email, security.display_name(user, email),
                   changes={'amount': str(c.amount), 'employee': c.email, 'overCap': info['overCap'],
                            'taxable': c.taxable}, notes=note)
    return Response(claim_dict(c))


def _dead_run_ids(ids):
    """Run ids (positive) that no longer exist or were cancelled."""
    from ..models import PayrollRun
    ids = {i for i in ids if i and i > 0}
    if not ids:
        return set()
    alive = set(PayrollRun.objects.filter(id__in=ids).exclude(status='cancelled').values_list('id', flat=True))
    return ids - alive


def apply_expenses(result, ctx):
    """Calculation hook: approved claims → REIMB / REIMB_TAX earnings."""
    from ..models import ExpenseClaim
    email, end, run_id = ctx.get('email'), ctx.get('end'), ctx.get('run_id')
    if not email or not end:
        return result
    currency = result.get('currency') or 'INR'
    # Claims marked paid by a run that was since deleted / cancelled go back to 'approved'.
    paid = ExpenseClaim.objects.filter(email__iexact=email, status='paid', paid_run_id__gt=0)
    dead = _dead_run_ids(set(paid.values_list('paid_run_id', flat=True)))
    if dead:
        paid.filter(paid_run_id__in=dead).update(status='approved', paid_run_id=None)
    cond = Q(status='approved', paid_run_id__isnull=True)
    if run_id:
        cond |= Q(status='paid', paid_run_id=run_id)
    claims = list(ExpenseClaim.objects.filter(cond, email__iexact=email, expense_date__lte=end, currency=currency)
                  .defer('receipt_data').order_by('expense_date', 'id'))
    caps, taxable_cats = expense_caps()
    non_tax, tax = Decimal('0'), Decimal('0')
    for c in claims:
        a, b = claim_split(c, caps, taxable_cats)
        non_tax += a
        tax += b
    set_line(result, 'earnings_data', 'REIMB', 'Reimbursements (non-taxable)', non_tax)
    set_line(result, 'earnings_data', 'REIMB_TAX', 'Reimbursements (taxable)', tax)
    if run_id and claims:
        ExpenseClaim.objects.filter(id__in=[c.id for c in claims if c.status == 'approved']).update(
            status='paid', paid_run_id=run_id)
    result['reimbursement_claim_ids'] = [c.id for c in claims]
    return recompute(result)


# ═════════════════════════════════════════════════════════════════════════
# 3. Salary advances & loans
# ═════════════════════════════════════════════════════════════════════════
def loan_policy():
    p = setting_json('loan_policy', DEFAULT_LOAN_POLICY)
    out = dict(DEFAULT_LOAN_POLICY)
    for k, v in p.items():
        if k in DEFAULT_LOAN_POLICY and k != 'method':
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                pass
    out['method'] = 'flat' if str(p.get('method')).lower() == 'flat' else 'reducing'
    return out


def loan_limits(email):
    pol = loan_policy()
    basis = salary_basis(email)
    return {
        'policy': pol,
        'monthlyGross': money(basis['gross']), 'monthlyNet': money(basis['net']), 'basis': basis['source'],
        'currency': basis['currency'],
        'advance': {'maxAmount': money(basis['net'] * D(pol['max_advance_multiple_of_net'])),
                    'maxTenure': int(pol['max_advance_tenure_months']), 'interestRate': 0},
        'loan': {'maxAmount': money(basis['gross'] * D(pol['max_loan_multiple_of_gross'])),
                 'maxTenure': int(pol['max_tenure_months']), 'interestRate': pol['interest_rate'],
                 'method': pol['method']},
    }


def build_schedule(principal, annual_rate, months, first_period, method='reducing'):
    """[{seq, period, principal, interest, amount}] — 2-dp rounding, the last
    installment absorbs every rounding remainder so the principal parts sum to
    exactly ``principal``."""
    P = D(principal)
    n = int(months)
    r = Decimal(str(annual_rate or 0)) / Decimal('1200')
    rows = []
    if r == 0:
        each = (P / n).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        for i in range(n):
            pp = each if i < n - 1 else P - each * (n - 1)
            rows.append((pp, Decimal('0')))
    elif method == 'flat':
        total_int = (P * Decimal(str(annual_rate)) / 100 * n / 12).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        pe = (P / n).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        ie = (total_int / n).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        for i in range(n):
            last = i == n - 1
            rows.append((P - pe * (n - 1) if last else pe, total_int - ie * (n - 1) if last else ie))
    else:
        f = (1 + r) ** n
        emi = (P * r * f / (f - 1)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        bal = P
        for i in range(n):
            interest = (bal * r).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            pp = bal if i == n - 1 else min(bal, emi - interest)
            rows.append((pp, interest))
            bal -= pp
    out, period = [], first_period
    for i, (pp, ip) in enumerate(rows, 1):
        out.append({'seq': i, 'period': period, 'principal': pp, 'interest': ip, 'amount': pp + ip})
        period = next_period(period)
    return out


def refresh_loan(loan):
    """Outstanding principal = scheduled principal parts; closed when nothing is left."""
    sched = loan.installments.filter(status='scheduled')
    outstanding = sum((D(i.principal_part) for i in sched), Decimal('0'))
    loan.outstanding = outstanding
    if loan.status in ('active', 'closed'):
        loan.status = 'active' if sched.exists() else 'closed'
    loan.save(update_fields=['outstanding', 'status'])
    return loan


def loan_dict(l, with_schedule=True):
    out = {
        'id': l.id, 'email': l.email, 'employeeName': l.employee_name, 'kind': l.kind,
        'principal': money(l.principal), 'interestRate': float(l.interest_rate), 'tenureMonths': l.tenure_months,
        'emi': money(l.emi), 'reason': l.reason, 'status': l.status, 'decidedBy': l.decided_by,
        'decidedAt': _iso(l.decided_at), 'decisionNote': l.decision_note, 'disbursedAt': _iso(l.disbursed_at),
        'firstEmiPeriod': l.first_emi_period, 'outstanding': money(l.outstanding), 'createdAt': _iso(l.created_at),
    }
    if with_schedule:
        inst = list(l.installments.all().order_by('seq', 'id'))
        out['schedule'] = [{'id': i.id, 'seq': i.seq, 'period': i.period, 'principal': money(i.principal_part),
                            'interest': money(i.interest_part), 'amount': money(i.amount), 'status': i.status,
                            'runId': i.run_id if i.status != 'scheduled' else None} for i in inst]
        out['repaid'] = money(sum((D(i.amount) for i in inst if i.status in ('deducted', 'prepaid', 'recovered')),
                                  Decimal('0')))
        out['interestTotal'] = money(sum((D(i.interest_part) for i in inst), Decimal('0')))
    return out


@api_view(['GET', 'POST'])
def my_loans(request):
    from ..models import EmployeeLoan
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    if request.method == 'GET':
        loans = EmployeeLoan.objects.filter(email__iexact=email).prefetch_related('installments')[:100]
        return Response({'loans': [loan_dict(l) for l in loans], 'limits': loan_limits(email),
                         'canApprove': security.has_perm(user, 'payroll.loans.approve')})
    body = request.data or {}
    lim = loan_limits(email)
    pol = lim['policy']
    try:
        kind = str(body.get('kind') or '').lower()
        if kind not in ('advance', 'loan'):
            raise ValueError('Choose salary advance or loan.')
        spec = lim[kind]
        if spec['maxAmount'] <= 0:
            raise ValueError('Your salary details are not set up yet, so a request cannot be checked. Contact HR.')
        amount = parse_amount(body.get('amount'), lo=D(pol['min_amount']))
        if amount > D(spec['maxAmount']):
            raise ValueError(f'The most you can request as a {kind} is {_fmt_amt(spec["maxAmount"])}.')
        tenure = parse_int(body.get('tenureMonths'), 1, int(spec['maxTenure']), 'Tenure (months)')
        reason = clean_text(body.get('reason'), 1000)
        if len(reason) < 3:
            raise ValueError('Give a reason for the request.')
    except ValueError as e:
        return _err(str(e))
    open_qs = EmployeeLoan.objects.filter(email__iexact=email, status__in=('requested', 'approved', 'active'))
    if open_qs.count() >= int(pol['max_open']):
        return _err('You already have the maximum number of open loans / advances.', 409)
    if kind == 'advance' and open_qs.filter(kind='advance').exists():
        return _err('You already have an open salary advance.', 409)
    rate = Decimal('0') if kind == 'advance' else D(pol['interest_rate'])
    sched = build_schedule(amount, rate, tenure, next_period(period_of(_today())), pol['method'])
    loan = EmployeeLoan.objects.create(email=email, employee_name=person_name(email), kind=kind, principal=amount,
                                       interest_rate=rate, tenure_months=tenure, emi=sched[0]['amount'],
                                       reason=reason, status='requested', outstanding=Decimal('0'))
    security.audit('loan_requested', 'EmployeeLoan', loan.id, request, email, security.display_name(user, email),
                   changes={'kind': kind, 'amount': str(amount), 'tenure': tenure})
    return Response(loan_dict(loan), status=201)


@api_view(['POST'])
def my_loan_cancel(request, pk):
    from ..models import EmployeeLoan
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    loan = EmployeeLoan.objects.filter(id=pk, email__iexact=email).first()
    if not loan:
        return _err('Loan not found', 404)
    if loan.status != 'requested':
        return _err('Only a pending request can be withdrawn.', 409)
    loan.status = 'withdrawn'
    loan.save(update_fields=['status'])
    security.audit('loan_withdrawn', 'EmployeeLoan', loan.id, request, email)
    return Response(loan_dict(loan))


LOAN_APPROVER = 'payroll.loans.approve'


@api_view(['GET'])
def loans_admin(request):
    from ..models import EmployeeLoan
    email, user, denied = security.require(request, LOAN_APPROVER)
    if denied:
        return denied
    status = str(request.GET.get('status') or 'all').lower()
    qs = EmployeeLoan.objects.all().prefetch_related('installments')
    if status != 'all':
        if status not in ('requested', 'approved', 'active', 'closed', 'rejected', 'withdrawn'):
            return _err('Unknown status filter.')
        qs = qs.filter(status=status)
    out = []
    for l in qs[:300]:
        d = loan_dict(l)
        d['isMine'] = _norm(l.email) == email
        out.append(d)
    return Response({'loans': out})


def _loan_for_action(request, pk, perm=LOAN_APPROVER):
    from ..models import EmployeeLoan
    email, user, denied = security.require(request, perm, fresh=True)
    if denied:
        return None, None, None, denied
    loan = EmployeeLoan.objects.select_for_update().filter(id=pk).first()
    if not loan:
        return None, None, None, _err('Loan not found', 404)
    if _norm(loan.email) == email:
        return None, None, None, _err('You cannot act on your own loan or advance.', 403, 'SELF_APPROVAL')
    return email, user, loan, None


@api_view(['POST'])
def loan_decide(request, pk):
    body = request.data or {}
    action = str(body.get('action') or '').lower()
    if action not in ('approve', 'reject'):
        return _err('action must be approve or reject.')
    note = clean_text(body.get('note'), 255)
    with transaction.atomic():
        email, user, loan, denied = _loan_for_action(request, pk)
        if denied:
            return denied
        if loan.status != 'requested':
            return _err(f'This request is already {loan.status}.', 409)
        if action == 'reject' and not note:
            return _err('Give a reason for rejecting the request.')
        loan.status = 'approved' if action == 'approve' else 'rejected'
        loan.decided_by, loan.decided_at, loan.decision_note, loan.approver_email = email, _now(), note, email
        loan.save()
    security.audit('loan_' + loan.status, 'EmployeeLoan', loan.id, request, email, security.display_name(user, email),
                   changes={'employee': loan.email, 'kind': loan.kind, 'amount': str(loan.principal)}, notes=note)
    return Response(loan_dict(loan))


@api_view(['POST'])
def loan_disburse(request, pk):
    from ..models import LoanInstallment
    body = request.data or {}
    with transaction.atomic():
        email, user, loan, denied = _loan_for_action(request, pk)
        if denied:
            return denied
        if loan.status != 'approved':
            return _err('Only an approved request can be disbursed.', 409)
        first = str(body.get('firstEmiPeriod') or '').strip() or next_period(period_of(_today()))
        if not _PERIOD_RE.match(first) or first < period_of(_today()):
            return _err('First EMI month must be YYYY-MM, this month or later.')
        sched = build_schedule(loan.principal, loan.interest_rate, loan.tenure_months, first, loan_policy()['method'])
        loan.installments.all().delete()
        LoanInstallment.objects.bulk_create([LoanInstallment(loan=loan, seq=s['seq'], period=s['period'],
                                                             principal_part=s['principal'], interest_part=s['interest'],
                                                             amount=s['amount'], status='scheduled') for s in sched])
        loan.status, loan.disbursed_at, loan.first_emi_period = 'active', _now(), first
        loan.emi, loan.outstanding = sched[0]['amount'], D(loan.principal)
        loan.save()
    security.audit('loan_disbursed', 'EmployeeLoan', loan.id, request, email, security.display_name(user, email),
                   changes={'employee': loan.email, 'amount': str(loan.principal), 'firstEmiPeriod': first,
                            'installments': len(sched)}, notes=clean_text(body.get('reference'), 200))
    return Response(loan_dict(loan))


@api_view(['POST'])
def loan_foreclose(request, pk):
    """Prepayment / foreclosure (HR). body: {mode, amount?, period?, note}
    mode 'full'    — the employee repaid the whole outstanding principal outside
                     payroll; future interest is waived; the loan closes.
    mode 'partial' — they repaid ``amount``; the remaining principal is
                     re-scheduled over the remaining installments.
    mode 'payroll' — recover the whole outstanding principal in one EMI in
                     ``period`` (default next month); future interest waived."""
    from ..models import LoanInstallment
    body = request.data or {}
    mode = str(body.get('mode') or 'full').lower()
    if mode not in ('full', 'partial', 'payroll'):
        return _err('mode must be full, partial or payroll.')
    note = clean_text(body.get('note'), 255)
    with transaction.atomic():
        email, user, loan, denied = _loan_for_action(request, pk)
        if denied:
            return denied
        if loan.status != 'active':
            return _err('Only an active loan can be prepaid or foreclosed.', 409)
        sched = list(loan.installments.filter(status='scheduled').order_by('seq', 'id'))
        outstanding = sum((D(i.principal_part) for i in sched), Decimal('0'))
        if not sched or outstanding <= 0:
            refresh_loan(loan)
            return _err('Nothing is outstanding on this loan.', 409)
        next_seq = (loan.installments.order_by('-seq').first().seq or 0) + 1
        if mode == 'full':
            for i in sched:
                i.status = 'prepaid'
                i.interest_part = Decimal('0')
                i.amount = i.principal_part
                i.save()
            paid = outstanding
        elif mode == 'payroll':
            period = str(body.get('period') or '').strip() or next_period(period_of(_today()))
            if not _PERIOD_RE.match(period):
                return _err('period must be YYYY-MM.')
            for i in sched:
                i.delete()
            LoanInstallment.objects.create(loan=loan, seq=next_seq, period=period, principal_part=outstanding,
                                           interest_part=Decimal('0'), amount=outstanding, status='scheduled')
            paid = Decimal('0')
        else:
            try:
                amount = parse_amount(body.get('amount'), hi=outstanding)
            except ValueError as e:
                return _err(str(e))
            if amount >= outstanding:
                return _err('Use a full foreclosure to repay everything.')
            remaining = outstanding - amount
            start = sched[0].period
            n = len(sched)
            for i in sched:
                i.delete()
            LoanInstallment.objects.create(loan=loan, seq=next_seq, period=start, principal_part=amount,
                                           interest_part=Decimal('0'), amount=amount, status='prepaid')
            new = build_schedule(remaining, loan.interest_rate, n, start, loan_policy()['method'])
            LoanInstallment.objects.bulk_create([LoanInstallment(loan=loan, seq=next_seq + s['seq'], period=s['period'],
                                                                 principal_part=s['principal'], interest_part=s['interest'],
                                                                 amount=s['amount'], status='scheduled') for s in new])
            paid = amount
        refresh_loan(loan)
    security.audit('loan_foreclosed' if mode != 'partial' else 'loan_prepaid', 'EmployeeLoan', loan.id, request, email,
                   security.display_name(user, email),
                   changes={'mode': mode, 'paidOutsidePayroll': str(paid), 'outstandingBefore': str(outstanding),
                            'outstandingAfter': str(loan.outstanding)}, notes=note)
    return Response(loan_dict(loan))


def _revert_run_deductions(loans, run_id):
    """Undo what an earlier calculation of ``run_id`` did to these loans."""
    from ..models import LoanInstallment
    for loan in loans:
        carries = list(LoanInstallment.objects.filter(loan=loan, run_id=run_id, status='scheduled'))
        for y in carries:
            x = LoanInstallment.objects.filter(loan=loan, run_id=run_id, status='deducted', seq=y.seq).first()
            if x:
                x.amount = D(x.amount) + D(y.amount)
                x.principal_part = D(x.principal_part) + D(y.principal_part)
                x.interest_part = D(x.interest_part) + D(y.interest_part)
                x.save()
                y.delete()
            else:
                y.run_id = None
                y.save(update_fields=['run_id'])
        LoanInstallment.objects.filter(loan=loan, run_id=run_id, status='deducted').update(status='scheduled', run_id=None)


def apply_loans(result, ctx):
    """Calculation hook: due EMIs → LOAN_EMI deduction (never below zero net)."""
    from ..models import EmployeeLoan, LoanInstallment
    email, start, run_id = ctx.get('email'), ctx.get('start'), ctx.get('run_id')
    if not email or not start:
        return result
    period = period_of(start)
    loans = list(EmployeeLoan.objects.filter(email__iexact=email, status__in=('active', 'closed')))
    if not loans:
        set_line(result, 'deductions_data', 'LOAN_EMI', 'Loan / advance EMI', 0)
        return recompute(result)
    with transaction.atomic():
        # Runs that were deleted / cancelled give their deductions back.
        used = set(LoanInstallment.objects.filter(loan__in=loans, run_id__isnull=False).values_list('run_id', flat=True))
        for dead in _dead_run_ids(used):
            _revert_run_deductions(loans, dead)
        if run_id:
            _revert_run_deductions(loans, run_id)
        for l in loans:
            refresh_loan(l)
        due = list(LoanInstallment.objects.select_for_update()
                   .filter(loan__email__iexact=email, loan__status='active', status='scheduled', period__lte=period)
                   .order_by('period', 'seq', 'id'))
        set_line(result, 'deductions_data', 'LOAN_EMI', 'Loan / advance EMI', 0)
        recompute(result)
        available = D(result.get('net_pay'))
        total = Decimal('0')
        touched = set()
        for inst in due:
            amt = D(inst.amount)
            if available <= 0:
                break
            take = min(amt, available)
            if run_id:
                if take < amt:
                    # Partial: deduct what fits, carry the rest forward (same period, so the
                    # next run collects it). run_id marks it so a re-run can merge it back.
                    rest = amt - take
                    int_take = min(D(inst.interest_part), take)
                    pr_take = take - int_take
                    LoanInstallment.objects.create(loan=inst.loan, seq=inst.seq, period=inst.period,
                                                   principal_part=D(inst.principal_part) - pr_take,
                                                   interest_part=D(inst.interest_part) - int_take, amount=rest,
                                                   status='scheduled', run_id=run_id)
                    inst.amount, inst.principal_part, inst.interest_part = take, pr_take, int_take
                inst.status, inst.run_id = 'deducted', run_id
                inst.save()
                touched.add(inst.loan_id)
            total += take
            available -= take
        for l in loans:
            if l.id in touched:
                refresh_loan(l)
    set_line(result, 'deductions_data', 'LOAN_EMI', 'Loan / advance EMI', total)
    return recompute(result)


# ═════════════════════════════════════════════════════════════════════════
# 4. Total Rewards Statement
# ═════════════════════════════════════════════════════════════════════════
def fy_range(fy):
    """'2026-27' → (2026-04-01, 2027-03-31)."""
    m = re.match(r'^(\d{4})-(\d{2})$', str(fy or ''))
    if not m:
        raise ValueError('fy must look like 2026-27')
    y = int(m.group(1))
    if (y + 1) % 100 != int(m.group(2)):
        raise ValueError('fy must be consecutive years, e.g. 2026-27')
    return date(y, 4, 1), date(y + 1, 3, 31)


def current_fy(d=None):
    d = d or _today()
    y = d.year if d.month >= 4 else d.year - 1
    return f'{y}-{(y + 1) % 100:02d}'


def health_insurance_for(email):
    """{'sumInsured', 'annualPremium', 'source'} from EmployeePayComponent
    (annual premium) or PayrollSetting 'health_insurance' (per grade or flat)."""
    try:
        from ..models import EmployeePayComponent
        epc = (EmployeePayComponent.objects.filter(email__iexact=email, component__code__in=HEALTH_INSURANCE_CODES)
               .select_related('component').order_by('-effective_from', '-id').first())
        if epc and epc.amount:
            return {'sumInsured': None, 'annualPremium': money(epc.amount), 'source': 'pay component'}
    except Exception:
        pass
    cfg = setting_json('health_insurance', {})
    from ..models import UserProfile
    p = UserProfile.objects.filter(email__iexact=email).first()
    grade = (p.level if p else '') or ''
    spec = None
    if isinstance(cfg.get('grades'), dict) and grade in cfg['grades'] and isinstance(cfg['grades'][grade], dict):
        spec = cfg['grades'][grade]
    elif cfg.get('sum_insured') or cfg.get('annual_premium'):
        spec = cfg
    if not spec:
        return {'sumInsured': None, 'annualPremium': 0.0, 'source': 'not configured'}
    try:
        return {'sumInsured': money(spec.get('sum_insured') or 0), 'annualPremium': money(spec.get('annual_premium') or 0),
                'source': f'grade {grade}' if spec is not cfg else 'company policy'}
    except Exception:
        return {'sumInsured': None, 'annualPremium': 0.0, 'source': 'invalid configuration'}


def encashable_leave_days(email):
    """Unused earned leave this calendar year from the leave module (allowance − approved)."""
    try:
        from ..views import _leave_policy, _leave_usage
    except Exception:
        return Decimal('0'), []
    fp = setting_json('fnf_policy', {})
    types = [str(t).lower() for t in (fp.get('encashable_leave_types') or
                                      ['Earned Leave', 'Privilege Leave', 'Annual Leave'])]
    approved, _pending = _leave_usage(email, _today().year)
    total, used_types = Decimal('0'), []
    for t in _leave_policy()['types']:
        if str(t['name']).lower() in types and t.get('days') is not None:
            rem = max(Decimal(str(t['days'])) - Decimal(str(approved.get(t['name'], 0))), Decimal('0'))
            total += rem
            used_types.append({'type': t['name'], 'allowance': t['days'], 'used': approved.get(t['name'], 0),
                               'remaining': float(rem)})
    return total, used_types


def total_rewards(email, fy=None):
    from ..models import PayrollAdjustment, Payslip, UserProfile
    fy = fy or current_fy()
    start, end = fy_range(fy)
    slips = list(Payslip.objects.filter(email__iexact=email, status__in=('approved', 'paid'),
                                        run__period_start__gte=start, run__period_start__lte=end)
                 .select_related('run').order_by('run__period_start'))
    adj_ids = set()
    for ps in slips:
        for l in ps.earnings_data or []:
            c = str(l.get('code') or '')
            if c.startswith('ADJ_') and c[4:].isdigit():
                adj_ids.add(int(c[4:]))
    adj_type = dict(PayrollAdjustment.objects.filter(id__in=adj_ids).values_list('id', 'adjustment_type'))
    base = allow = variable = reimb = employer = Decimal('0')
    allow_lines, employer_lines = {}, {}
    for ps in slips:
        for l in ps.earnings_data or []:
            c, amt = str(l.get('code') or '').upper(), D(l.get('amount'))
            if c in BASIC_CODES or c in DA_CODES:
                base += amt
            elif c in REIMB_CODES:
                reimb += amt
            elif c.startswith('ADJ_'):
                t = (adj_type.get(int(c[4:])) if c[4:].isdigit() else '') or ''
                if t.lower() == 'reimbursement':
                    reimb += amt
                else:
                    variable += amt
            elif c in VARIABLE_CODES:
                variable += amt
            else:
                allow += amt
                key = str(l.get('label') or c)
                allow_lines[key] = allow_lines.get(key, Decimal('0')) + amt
        for l in ps.employer_contributions_data or []:
            c = str(l.get('code') or '').upper()
            if c == 'GROSS_EARNING':
                continue
            amt = D(l.get('amount'))
            employer += amt
            key = str(l.get('label') or c)
            employer_lines[key] = employer_lines.get(key, Decimal('0')) + amt
    basis = salary_basis(email)
    monthly_basic = basis['basic'] + basis['da']
    p = UserProfile.objects.filter(email__iexact=email).first()
    doj = (p.start_date if p else None) or (slips[-1].doj if slips else None)
    as_of = min(_today(), end)
    from .fnf import service_length, GRATUITY_NUM, GRATUITY_DEN
    years = service_length(doj, as_of)['fullYears'] if doj else 0
    accrued = (monthly_basic * GRATUITY_NUM * years / GRATUITY_DEN).quantize(Decimal('0.01'))
    in_year_from = max(start, doj) if doj else start
    days_in_year = max(0, (as_of - in_year_from).days + 1) if as_of >= in_year_from else 0
    year_accrual = (monthly_basic * GRATUITY_NUM / GRATUITY_DEN * Decimal(days_in_year) / Decimal(365)).quantize(Decimal('0.01'))
    health = health_insurance_for(email)
    el_days, el_detail = encashable_leave_days(email)
    divisor = D(setting_json('fnf_policy', {}).get('leave_encashment_divisor') or 30)
    leave_value = (el_days * basis['basic'] / divisor).quantize(Decimal('0.01')) if divisor else Decimal('0')
    comps = [
        {'key': 'base', 'label': 'Base pay (basic + DA)', 'amount': money(base), 'group': 'cash'},
        {'key': 'allowances', 'label': 'Allowances', 'amount': money(allow), 'group': 'cash',
         'detail': [{'label': k, 'amount': money(v)} for k, v in allow_lines.items()]},
        {'key': 'variable', 'label': 'Bonuses, incentives & overtime', 'amount': money(variable), 'group': 'cash'},
        {'key': 'employer', 'label': 'Employer PF / ESI contributions', 'amount': money(employer), 'group': 'benefits',
         'detail': [{'label': k, 'amount': money(v)} for k, v in employer_lines.items()]},
        {'key': 'health', 'label': 'Health insurance (employer premium)', 'amount': health['annualPremium'],
         'group': 'benefits', 'sumInsured': health['sumInsured'], 'source': health['source']},
        {'key': 'gratuity', 'label': 'Gratuity accrued this year', 'amount': money(year_accrual), 'group': 'benefits',
         'formula': f'15/26 × monthly basic+DA {_fmt_amt(monthly_basic)} × {days_in_year}/365 days'},
        {'key': 'leave', 'label': 'Unused earned leave (encashable value)', 'amount': money(leave_value),
         'group': 'benefits', 'formula': f'{el_days} days × basic {_fmt_amt(basis["basic"])} / {divisor}',
         'detail': el_detail},
        {'key': 'reimbursements', 'label': 'Reimbursements', 'amount': money(reimb), 'group': 'other'},
    ]
    total = sum((D(c['amount']) for c in comps), Decimal('0'))
    return {
        'email': email, 'employeeName': person_name(email), 'fy': fy, 'from': _iso(start), 'to': _iso(end),
        'currency': basis['currency'], 'payslipCount': len(slips), 'components': comps, 'total': money(total),
        'cashTotal': money(base + allow + variable),
        'gratuity': {'serviceYears': years, 'dateOfJoining': _iso(doj), 'monthlyBasicDa': money(monthly_basic),
                     'accruedLiability': money(accrued), 'vested': years >= 5,
                     'formula': f'15/26 × {_fmt_amt(monthly_basic)} × {years} completed year(s)'},
        'healthInsurance': health,
    }


@api_view(['GET'])
def my_total_rewards(request):
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    target = _norm(request.GET.get('email')) or email
    if target != email and not security.has_perm(user, 'payroll.manage'):
        return _err('Not found', 404)
    try:
        data = total_rewards(target, request.GET.get('fy') or None)
    except ValueError as e:
        return _err(str(e))
    if target != email:
        security.audit('total_rewards_viewed', 'Employee', target, request, email)
    return Response(data)


# ═════════════════════════════════════════════════════════════════════════
# Payslip endpoints
# ═════════════════════════════════════════════════════════════════════════
def _sent_map(ids):
    from ..models import ChannelDelivery
    out = {}
    for r in ChannelDelivery.objects.filter(channel='email', purpose='payslip', status='sent',
                                            ref__in=[str(i) for i in ids]).order_by('id'):
        out[r.ref] = r.created_at
    return out


@api_view(['GET'])
def my_payslips(request):
    from ..models import Payslip
    email, user, denied = security.require(request, None)
    if denied:
        return denied
    rows = list(Payslip.objects.filter(email__iexact=email, status__in=('approved', 'paid')).select_related('run')
                .defer('file_data').order_by('-run__period_start')[:60])
    sent = _sent_map([p.id for p in rows])
    probe = rows[0] if rows else None
    pw_ok, pattern = (False, None)
    if probe:
        pw, pattern = payslip_password(probe)
        pw_ok = bool(pw)
    return Response({
        'payslips': [{'id': p.id, 'runId': p.run_id, 'period': p.run.period_label,
                      'periodStart': _iso(p.run.period_start), 'periodEnd': _iso(p.run.period_end),
                      'payDate': _iso(p.run.pay_date), 'status': p.status, 'grossEarnings': money(p.gross_earnings),
                      'totalDeductions': money(p.total_deductions), 'netPay': money(p.net_pay),
                      'emailedAt': _iso(sent.get(str(p.id)))} for p in rows],
        'password': {'pattern': pattern or password_pattern(), 'available': pw_ok,
                     'description': PATTERN_TEXT.get(pattern or password_pattern())},
    })


@api_view(['GET'])
def my_payslip_pdf(request, pk):
    """The caller's own payslip as an AES-256 encrypted PDF (fresh sign-in)."""
    from ..models import Payslip
    email, user, denied = security.require(request, None, fresh=True)
    if denied:
        return denied
    ps = Payslip.objects.filter(id=pk, email__iexact=email, status__in=('approved', 'paid')).select_related('run').first()
    if not ps:
        return _err('Payslip not found', 404)
    pdf, pattern = encrypted_payslip(ps)
    if not pdf:
        return _err('Your date of birth / PAN is not on record, so the PDF cannot be protected. Ask HR to update it.',
                    409, 'NO_PASSWORD_DATA')
    security.audit('payslip_downloaded', 'Payslip', ps.id, request, email)
    resp = HttpResponse(pdf, content_type='application/pdf')
    resp['Content-Disposition'] = f'attachment; filename="{payslip_filename(ps)}"'
    resp['Cache-Control'] = 'no-store'
    resp['X-Content-Type-Options'] = 'nosniff'
    return resp


@api_view(['POST'])
def email_run_payslips(request):
    from ..models import PayrollRun
    email, user, denied = security.require(request, 'payroll.manage', fresh=True)
    if denied:
        return denied
    body = request.data or {}
    try:
        run_id = parse_int(body.get('runId'), 1, 2 ** 31 - 1, 'runId')
    except ValueError as e:
        return _err(str(e))
    run = PayrollRun.objects.filter(id=run_id).first()
    if not run:
        return _err('Pay run not found', 404)
    if run.status not in ('approved', 'paid'):
        return _err('Payslips can be emailed once the pay run is approved.', 409)
    force = bool(body.get('resend'))
    res = email_payslips_for_run(run.id, actor=email, force=force)
    security.audit('payslips_emailed_for_run', 'PayrollRun', run.id, request, email, security.display_name(user, email),
                   changes={'result': res, 'resend': force})
    return Response({'runId': run.id, 'period': run.period_label, 'result': res})


@api_view(['GET'])
def email_runs(request):
    """Approved / paid runs with how many payslips were emailed (HR card)."""
    from ..models import ChannelDelivery, Payslip, PayrollRun
    email, user, denied = security.require(request, 'payroll.manage')
    if denied:
        return denied
    out = []
    for run in PayrollRun.objects.filter(status__in=('approved', 'paid')).order_by('-period_start')[:24]:
        ids = [str(i) for i in Payslip.objects.filter(run=run, status__in=('approved', 'paid')).values_list('id', flat=True)]
        sent = ChannelDelivery.objects.filter(channel='email', purpose='payslip', status='sent', ref__in=ids) \
            .values('ref').distinct().count()
        out.append({'id': run.id, 'period': run.period_label, 'status': run.status, 'payslips': len(ids), 'emailed': sent})
    return Response({'runs': out})


# ═════════════════════════════════════════════════════════════════════════
# Policy (read for everyone, change with payroll.manage + fresh sign-in)
# ═════════════════════════════════════════════════════════════════════════
POLICY_KEYS = ('expense_caps', 'expense_policy', 'loan_policy', 'payslip_password_pattern', 'health_insurance',
               'fnf_policy')


def _validate_policy(key, val):
    if key == 'payslip_password_pattern':
        if str(val).upper() not in PASSWORD_PATTERNS:
            raise ValueError('payslip_password_pattern must be NAME4_DOBDDMM or PAN.')
        return str(val).upper()
    if not isinstance(val, dict):
        raise ValueError(f'{key} must be an object.')
    if key == 'expense_caps':
        for k, v in val.items():
            if k not in EXPENSE_CATEGORIES:
                raise ValueError(f'Unknown expense category {k}.')
            cap = v.get('cap') if isinstance(v, dict) else v
            if cap not in (None, ''):
                parse_amount(cap, lo=Decimal('0'))
    else:
        for k, v in val.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool) and (v < 0 or v > 1e9):
                raise ValueError(f'{key}.{k} is out of range.')
    if key == 'loan_policy':
        if 'interest_rate' in val and not 0 <= float(val['interest_rate']) <= 36:
            raise ValueError('interest_rate must be between 0 and 36 %.')
        if 'max_tenure_months' in val and not 1 <= int(val['max_tenure_months']) <= 120:
            raise ValueError('max_tenure_months must be between 1 and 120.')
    return val


@api_view(['GET', 'PUT'])
def policy(request):
    from ..models import PayrollSetting
    if request.method == 'GET':
        email, user, denied = security.require(request, None)
        if denied:
            return denied
        caps, taxable = expense_caps()
        return Response({'expenseCaps': {k: money(v) for k, v in caps.items()}, 'taxableCategories': sorted(taxable),
                         'expensePolicy': setting_json('expense_policy', DEFAULT_EXPENSE_POLICY),
                         'loanPolicy': loan_policy(), 'payslipPasswordPattern': password_pattern(),
                         'passwordDescription': PATTERN_TEXT[password_pattern()],
                         'healthInsurance': setting_json('health_insurance', {}),
                         'fnfPolicy': setting_json('fnf_policy', {}),
                         'canManage': security.has_perm(user, 'payroll.manage')})
    email, user, denied = security.require(request, 'payroll.manage', fresh=True)
    if denied:
        return denied
    body = request.data or {}
    changed = {}
    try:
        for key in POLICY_KEYS:
            if key in body:
                changed[key] = _validate_policy(key, body[key])
    except (ValueError, TypeError) as e:
        return _err(str(e))
    if not changed:
        return _err('Nothing to update.')
    for key, val in changed.items():
        PayrollSetting.objects.update_or_create(key=key, defaults={'value': val if isinstance(val, str) else json.dumps(val)})
    security.audit('payroll_ess_policy_updated', 'PayrollSetting', ','.join(changed), request, email,
                   changes={k: v for k, v in changed.items()})
    return Response({'ok': True, 'updated': sorted(changed)})
