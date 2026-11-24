"""Employee self-service pay (api/payroll_ext/ess.py): encrypted payslips by
email, expense claims → payroll bridge, loans / advances, Total Rewards.
Outbound email is mocked."""
import base64
import io
import re
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest import mock

import jwt
from django.conf import settings
from django.test import Client, TestCase
from pypdf import PdfReader

from api.models import (AppUser, ChannelDelivery, EmployeeCompensation, EmployeeLoan, ExpenseClaim,
                        LoanInstallment, OnboardingCandidate, PayrollAuditLog, PayrollRun, PayrollSetting,
                        Payslip, Permission, Role, RolePermission, UserProfile)
from api.payroll_ext import NON_TAXABLE_CODES, ess, line_amount

PNG = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'\x00' * 64).decode()
FAKE_PNG = base64.b64encode(b'%PDF-1.4 not a png').decode()


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


def client(email, fresh=True):
    if fresh:
        return Client(HTTP_X_USER_EMAIL=email, HTTP_AUTHORIZATION='Bearer ' + token_for(email))
    return Client(HTTP_X_USER_EMAIL=email)


def make_run(label, start, end, status='approved'):
    return PayrollRun.objects.create(period_label=label, period_start=start, period_end=end, status=status)


def make_payslip(run, email, name='Priya Sharma', basic=25000, hra=10000, bonus=0, reimb=0, net=None, status='approved'):
    earn = [{'code': 'BASIC_SALARY', 'label': 'Basic Salary', 'amount': basic},
            {'code': 'HRA', 'label': 'House Rent Allowance (HRA)', 'amount': hra}]
    if bonus:
        earn.append({'code': 'PERFORMANCE_BONUS', 'label': 'Performance Bonus', 'amount': bonus})
    if reimb:
        earn.append({'code': 'REIMB', 'label': 'Reimbursements (non-taxable)', 'amount': reimb})
    gross = basic + hra + bonus + reimb
    ded = [{'code': 'PF', 'label': 'Provident Fund', 'amount': 1800},
           {'code': 'PROFESSIONAL_TAX', 'label': 'Professional Tax', 'amount': 200}]
    return Payslip.objects.create(
        run=run, email=email, employee_name=name, gross_earnings=gross, total_deductions=2000,
        net_pay=net if net is not None else gross - 2000, earnings_data=earn, deductions_data=ded,
        employer_contributions_data=[{'code': 'GROSS_EARNING', 'label': 'GROSS EARNING', 'amount': gross},
                                     {'code': 'EMPLOYER_PF', 'label': "Employer's PF", 'amount': 1800}],
        status=status, pan_number='ABCDE1234F', doj=date(2019, 4, 1), month_days=30, paid_days=30,
        bank_account_number='123456789012', bank_name='HDFC')


def base_result(gross=50000, ded=5000):
    r = {'currency': 'INR', 'earnings_data': [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': gross}],
         'deductions_data': [{'code': 'PF', 'label': 'PF', 'amount': ded}], 'employer_contributions_data': []}
    return ess.recompute(r)


class EssBase(TestCase):
    EMP, MGR, HR, HR2, OTHER = 'priya@co.com', 'mgr@co.com', 'hr@co.com', 'hr2@co.com', 'ravi@co.com'

    def setUp(self):
        perms = {c: Permission.objects.create(code=c, name=c) for c in
                 ('payroll.manage', 'payroll.view', 'expense.approve', 'payroll.loans.approve', 'payroll.fnf.manage')}
        hr_role = Role.objects.create(name='Payroll Admin')
        for c in ('payroll.manage', 'expense.approve', 'payroll.loans.approve', 'payroll.fnf.manage'):
            RolePermission.objects.create(role=hr_role, permission=perms[c])
        staff = Role.objects.create(name='Staff')
        RolePermission.objects.create(role=staff, permission=perms['payroll.view'])
        for email, name, role in ((self.EMP, 'Priya Sharma', staff), (self.MGR, 'Manoj Gupta', staff),
                                  (self.HR, 'Hema Rao', hr_role), (self.HR2, 'Harish Iyer', hr_role),
                                  (self.OTHER, 'Ravi Kumar', staff)):
            AppUser.objects.create(email=email, full_name=name, password='x', role='employee', role_ref=role)
        UserProfile.objects.create(email=self.EMP, first_name='Priya', last_name='Sharma', manager_email=self.MGR,
                                   start_date=date(2019, 4, 1), level='L4')
        UserProfile.objects.create(email=self.OTHER, first_name='Ravi', last_name='Kumar', start_date=date(2022, 1, 1))
        OnboardingCandidate.objects.create(email=self.EMP, first_name='Priya', dob=date(1990, 3, 5))
        EmployeeCompensation.objects.create(email=self.EMP, base_amount=Decimal('25000'), annual_ctc=Decimal('600000'),
                                            pan_number='ABCDE1234F', effective_from=date(2019, 4, 1))
        self.run = make_run('2026-10', date(2026, 10, 1), date(2026, 10, 31))
        self.slip = make_payslip(self.run, self.EMP, net=33000)
        self.other_slip = make_payslip(self.run, self.OTHER, name='Ravi Kumar')


# ── payslip PDF / email ───────────────────────────────────────────────────
class PayslipPdfTests(EssBase):
    def test_password_pattern_name4_dob(self):
        self.assertEqual(ess.payslip_password(self.slip), ('PRIY0503', 'NAME4_DOBDDMM'))

    def test_password_falls_back_to_pan_without_dob(self):
        OnboardingCandidate.objects.filter(email=self.EMP).update(dob=None)
        self.assertEqual(ess.payslip_password(self.slip), ('ABCDE1234F', 'PAN'))

    def test_pan_pattern_setting(self):
        PayrollSetting.objects.create(key='payslip_password_pattern', value='PAN')
        self.assertEqual(ess.payslip_password(self.slip), ('ABCDE1234F', 'PAN'))

    def test_pdf_is_aes256_encrypted_and_opens_only_with_password(self):
        pdf, pattern = ess.encrypted_payslip(self.slip)
        self.assertTrue(pdf.startswith(b'%PDF'))
        r = PdfReader(io.BytesIO(pdf))
        self.assertTrue(r.is_encrypted)
        self.assertEqual(int(r.trailer['/Encrypt']['/V']), 5)            # V5 = AES-256
        self.assertFalse(r.decrypt('WRONG123'))
        r2 = PdfReader(io.BytesIO(pdf))
        self.assertTrue(r2.decrypt('PRIY0503'))
        text = r2.pages[0].extract_text()
        self.assertIn('NET PAY', text)
        self.assertIn('Priya Sharma', text)
        self.assertNotIn('123456789012', text)                           # account number masked

    @mock.patch('api.payroll_ext.ess.send_email_with_attachment', return_value={'ok': True})
    def test_email_endpoint_idempotent_and_body_has_no_amounts(self, send):
        hr = client(self.HR)
        r = hr.post('/api/payroll/ess/payslips/email', {'runId': self.run.id}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['result']['sent'], 2)
        self.assertEqual(send.call_count, 2)
        to, subject, html, text, fname, pdf = send.call_args_list[0][0]
        for body in (subject, html, text):
            for amount in ('33000', '33,000', '35000', '35,000', '25,000', '25000'):
                self.assertNotIn(amount, body)
            self.assertNotIn('PRIY0503', body)
            self.assertNotIn('ABCDE1234F', body)
        self.assertIn('first 4 letters of your name', text)
        self.assertTrue(PdfReader(io.BytesIO(pdf)).is_encrypted)
        # second call: nothing re-sent
        r = hr.post('/api/payroll/ess/payslips/email', {'runId': self.run.id}, content_type='application/json')
        self.assertEqual(r.json()['result'], {'sent': 0, 'already_sent': 2, 'skipped_no_password': 0,
                                              'skipped_status': 0, 'failed': 0})
        self.assertEqual(send.call_count, 2)
        self.assertEqual(ChannelDelivery.objects.filter(channel='email', purpose='payslip', status='sent').count(), 2)
        self.assertTrue(PayrollAuditLog.objects.filter(action='payslips_emailed_for_run').exists())

    @mock.patch('api.payroll_ext.ess.send_email_with_attachment', return_value={'ok': True})
    def test_email_needs_manage_and_fresh_signin(self, send):
        r = client(self.EMP).post('/api/payroll/ess/payslips/email', {'runId': self.run.id}, content_type='application/json')
        self.assertEqual(r.status_code, 403)
        r = client(self.HR, fresh=False).post('/api/payroll/ess/payslips/email', {'runId': self.run.id},
                                              content_type='application/json')
        self.assertEqual(r.status_code, 401)
        draft = make_run('2026-11', date(2026, 11, 1), date(2026, 11, 30), status='draft')
        r = client(self.HR).post('/api/payroll/ess/payslips/email', {'runId': draft.id}, content_type='application/json')
        self.assertEqual(r.status_code, 409)
        send.assert_not_called()

    def test_smtp_sender_attaches_pdf(self):
        smtp = {'type': 'smtp', 'host': 'smtp.test', 'port': 587, 'user': 'u', 'password': 'p', 'secure': False,
                'from_name': 'HRMS', 'from_email': 'hr@co.com'}
        with mock.patch('api.mailer.get_email_settings', return_value=smtp), \
                mock.patch('api.payroll_ext.ess.smtplib.SMTP') as S:
            res = ess.send_email_with_attachment('priya@co.com', 'Subj', '<p>x</p>', 'x', 'a.pdf', b'%PDF-1.7 data')
        self.assertTrue(res['ok'])
        raw = S.return_value.sendmail.call_args[0][2]
        self.assertIn('Content-Disposition: attachment; filename="a.pdf"', raw)

    def test_employee_downloads_own_encrypted_pdf_only(self):
        me = client(self.EMP)
        r = me.get(f'/api/me/pay/payslips/{self.slip.id}/pdf')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['Content-Type'], 'application/pdf')
        self.assertTrue(PdfReader(io.BytesIO(r.content)).is_encrypted)
        self.assertEqual(client(self.EMP).get(f'/api/me/pay/payslips/{self.other_slip.id}/pdf').status_code, 404)
        self.assertEqual(client(self.EMP, fresh=False).get(f'/api/me/pay/payslips/{self.slip.id}/pdf').status_code, 401)
        lst = me.get('/api/me/pay/payslips').json()
        self.assertEqual([p['id'] for p in lst['payslips']], [self.slip.id])
        self.assertTrue(lst['password']['available'])
        self.assertNotIn('PRIY0503', str(lst))
        self.assertTrue(PayrollAuditLog.objects.filter(action='payslip_downloaded').exists())


# ── expense claims ────────────────────────────────────────────────────────
class ExpenseTests(EssBase):
    def submit(self, who=None, **kw):
        body = {'category': 'travel', 'amount': '1500', 'expenseDate': str(date.today() - timedelta(days=3)),
                'description': 'Cab to client office', 'receiptData': PNG, 'receiptMime': 'image/png',
                'receiptName': 'cab.png'}
        body.update(kw)
        return client(who or self.EMP).post('/api/me/pay/expenses', body, content_type='application/json')

    def test_submit_validates_receipt_and_lists_without_data(self):
        self.assertEqual(self.submit(receiptData=FAKE_PNG).status_code, 400)        # content ≠ type
        self.assertEqual(self.submit(receiptData='').status_code, 400)              # receipt required
        self.assertEqual(self.submit(category='casino').status_code, 400)
        self.assertEqual(self.submit(amount='-5').status_code, 400)
        self.assertEqual(self.submit(expenseDate=str(date.today() + timedelta(days=2))).status_code, 400)
        r = self.submit()
        self.assertEqual(r.status_code, 201, r.content)
        c = ExpenseClaim.objects.get()
        self.assertEqual((c.approver_email, c.status), (self.MGR, 'submitted'))
        lst = client(self.EMP).get('/api/me/pay/expenses')
        self.assertNotIn(PNG[:40], lst.content.decode())
        self.assertTrue(lst.json()['claims'][0]['hasReceipt'])
        self.assertTrue(PayrollAuditLog.objects.filter(action='expense_submitted').exists())
        # receipts: owner and manager yes, others 404
        self.assertEqual(client(self.EMP).get(f'/api/me/pay/expenses/{c.id}/receipt').status_code, 200)
        self.assertEqual(client(self.MGR).get(f'/api/me/pay/expenses/{c.id}/receipt').status_code, 200)
        self.assertEqual(client(self.OTHER).get(f'/api/me/pay/expenses/{c.id}/receipt').status_code, 404)

    def test_manager_approves_self_and_strangers_cannot(self):
        cid = self.submit().json()['id']
        url = f'/api/payroll/ess/expenses/{cid}/decide'
        self.assertEqual(client(self.EMP).post(url, {'action': 'approve'}, content_type='application/json').status_code, 403)
        self.assertEqual(client(self.OTHER).post(url, {'action': 'approve'}, content_type='application/json').status_code, 404)
        self.assertEqual(client(self.MGR, fresh=False).post(url, {'action': 'approve'},
                                                            content_type='application/json').status_code, 401)
        appr = client(self.MGR).get('/api/payroll/ess/expenses/approvals').json()
        self.assertEqual([c['id'] for c in appr['claims']], [cid])
        self.assertEqual(client(self.OTHER).get('/api/payroll/ess/expenses/approvals').json()['claims'], [])
        r = client(self.MGR).post(url, {'action': 'approve', 'note': 'ok'}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'approved')
        self.assertEqual(client(self.HR).post(url, {'action': 'reject', 'note': 'x'},
                                              content_type='application/json').status_code, 409)
        self.assertTrue(PayrollAuditLog.objects.filter(action='expense_approved', actor_email=self.MGR).exists())

    def test_hr_with_expense_approve_cannot_approve_own_claim(self):
        cid = self.submit(who=self.HR).json()['id']
        r = client(self.HR).post(f'/api/payroll/ess/expenses/{cid}/decide', {'action': 'approve'},
                                 content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(client(self.HR2).post(f'/api/payroll/ess/expenses/{cid}/decide', {'action': 'approve'},
                                               content_type='application/json').status_code, 200)

    def test_cap_flag_and_taxable_split(self):
        r = self.submit(category='internet', amount='1200')
        self.assertTrue(r.json()['overCap'])
        self.assertEqual(r.json()['cap'], 1000.0)
        cid = r.json()['id']
        client(self.MGR).post(f'/api/payroll/ess/expenses/{cid}/decide', {'action': 'approve'}, content_type='application/json')
        self.assertTrue(ExpenseClaim.objects.get(id=cid).taxable)
        res = ess.apply_expenses(base_result(), {'email': self.EMP, 'end': date.today(), 'run_id': None})
        lines = {l['code']: l['amount'] for l in res['earnings_data']}
        self.assertEqual((lines['REIMB'], lines['REIMB_TAX']), (1000.0, 200.0))
        self.assertEqual(res['gross_earnings'], 51200.0)

    def test_bridge_pays_once_per_run(self):
        cid = self.submit(amount='1500').json()['id']
        client(self.MGR).post(f'/api/payroll/ess/expenses/{cid}/decide', {'action': 'approve'}, content_type='application/json')
        run1 = make_run('2026-11', date(2026, 11, 1), date(2099, 11, 30), status='draft')
        ctx1 = {'email': self.EMP, 'start': date(2026, 11, 1), 'end': date(2099, 11, 30), 'run_id': run1.id}
        r1 = ess.apply_expenses(base_result(), ctx1)
        self.assertEqual(line_amount(r1, 'earnings_data', 'REIMB'), Decimal('1500'))
        self.assertEqual((ExpenseClaim.objects.get(id=cid).status, ExpenseClaim.objects.get(id=cid).paid_run_id),
                         ('paid', run1.id))
        # recalculating the same run keeps it (no loss, no double)
        r1b = ess.apply_expenses(base_result(), ctx1)
        self.assertEqual(line_amount(r1b, 'earnings_data', 'REIMB'), Decimal('1500'))
        # another run never pays it again
        run2 = make_run('2026-12', date(2026, 12, 1), date(2099, 12, 31), status='draft')
        r2 = ess.apply_expenses(base_result(), dict(ctx1, run_id=run2.id))
        self.assertEqual(line_amount(r2, 'earnings_data', 'REIMB'), Decimal('0'))
        # a cancelled run releases its claims for the next run
        run1.status = 'cancelled'
        run1.save()
        r3 = ess.apply_expenses(base_result(), dict(ctx1, run_id=run2.id))
        self.assertEqual(line_amount(r3, 'earnings_data', 'REIMB'), Decimal('1500'))
        self.assertEqual(ExpenseClaim.objects.get(id=cid).paid_run_id, run2.id)

    def test_hook_runs_inside_payroll_calculation(self):
        cid = self.submit(amount='700').json()['id']
        client(self.MGR).post(f'/api/payroll/ess/expenses/{cid}/decide', {'action': 'approve'}, content_type='application/json')
        from api.services.payroll_service import PayrollService
        res = PayrollService.calculate_employee_pay(self.EMP, date(2026, 11, 1), date(2099, 11, 30))
        self.assertEqual(line_amount(res, 'earnings_data', 'REIMB'), Decimal('700'))
        self.assertIn('REIMB', NON_TAXABLE_CODES)


# ── loans & advances ──────────────────────────────────────────────────────
class LoanTests(EssBase):
    def request(self, who=None, **kw):
        body = {'kind': 'loan', 'amount': '60000', 'tenureMonths': 6, 'reason': 'Medical expenses'}
        body.update(kw)
        return client(who or self.EMP).post('/api/me/pay/loans', body, content_type='application/json')

    def test_policy_limits(self):
        lim = client(self.EMP).get('/api/me/pay/loans').json()['limits']
        self.assertEqual(lim['monthlyGross'], 35000.0)
        self.assertEqual(lim['advance']['maxAmount'], 33000.0)          # 1 × net
        self.assertEqual(lim['loan']['maxAmount'], 210000.0)            # 6 × gross
        self.assertEqual(self.request(amount='250000').status_code, 400)
        self.assertEqual(self.request(kind='advance', amount='40000', tenureMonths=1).status_code, 400)
        self.assertEqual(self.request(tenureMonths=25).status_code, 400)
        self.assertEqual(self.request(kind='gift').status_code, 400)
        self.assertEqual(self.request().status_code, 201)

    def test_schedule_sums(self):
        s = ess.build_schedule(Decimal('10000'), 0, 3, '2026-12')
        self.assertEqual([x['amount'] for x in s], [Decimal('3333.33'), Decimal('3333.33'), Decimal('3333.34')])
        self.assertEqual([x['period'] for x in s], ['2026-12', '2027-01', '2027-02'])
        for method in ('reducing', 'flat'):
            s = ess.build_schedule(Decimal('100000'), Decimal('12'), 12, '2027-01', method)
            self.assertEqual(sum(x['principal'] for x in s), Decimal('100000'))
            self.assertEqual(sum(x['amount'] for x in s), sum(x['principal'] + x['interest'] for x in s))
            self.assertGreater(sum(x['interest'] for x in s), 0)
        flat = ess.build_schedule(Decimal('100000'), Decimal('12'), 12, '2027-01', 'flat')
        self.assertEqual(sum(x['interest'] for x in flat), Decimal('12000.00'))
        red = ess.build_schedule(Decimal('100000'), Decimal('12'), 12, '2027-01', 'reducing')
        self.assertEqual(red[0]['amount'], Decimal('8884.88'))          # standard EMI @1 %/month

    def test_approval_by_another_person_with_fresh_signin(self):
        lid = self.request().json()['id']
        url = f'/api/payroll/ess/loans/{lid}/decide'
        self.assertEqual(client(self.MGR).post(url, {'action': 'approve'}, content_type='application/json').status_code, 403)
        self.assertEqual(client(self.HR, fresh=False).post(url, {'action': 'approve'},
                                                           content_type='application/json').status_code, 401)
        r = client(self.HR).post(url, {'action': 'approve'}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        # HR's own loan: refused even with the permission
        own = EmployeeLoan.objects.create(email=self.HR, kind='advance', principal=Decimal('1000'), status='requested')
        self.assertEqual(client(self.HR).post(f'/api/payroll/ess/loans/{own.id}/decide', {'action': 'approve'},
                                              content_type='application/json').status_code, 403)
        d = client(self.HR2).post(f'/api/payroll/ess/loans/{lid}/disburse', {'firstEmiPeriod': '2099-01'},
                                  content_type='application/json')
        self.assertEqual(d.status_code, 200, d.content)
        loan = d.json()
        self.assertEqual(loan['status'], 'active')
        self.assertEqual(len(loan['schedule']), 6)
        self.assertEqual(sum(Decimal(str(x['principal'])) for x in loan['schedule']), Decimal('60000'))
        self.assertEqual(loan['schedule'][0]['period'], '2099-01')
        for a in ('loan_requested', 'loan_approved', 'loan_disbursed'):
            self.assertTrue(PayrollAuditLog.objects.filter(action=a).exists(), a)

    def _active_loan(self, amount='6000', tenure=3, first='2099-01', kind='loan'):
        loan = EmployeeLoan.objects.create(email=self.EMP, kind=kind, principal=Decimal(amount), tenure_months=tenure,
                                           status='active', outstanding=Decimal(amount), first_emi_period=first)
        for s in ess.build_schedule(Decimal(amount), 0, tenure, first):
            LoanInstallment.objects.create(loan=loan, seq=s['seq'], period=s['period'], principal_part=s['principal'],
                                           interest_part=s['interest'], amount=s['amount'])
        return loan

    def test_hook_deducts_once_per_run_and_closes(self):
        loan = self._active_loan()
        run = make_run('2099-01', date(2099, 1, 1), date(2099, 1, 31), status='draft')
        ctx = {'email': self.EMP, 'start': date(2099, 1, 1), 'end': date(2099, 1, 31), 'run_id': run.id}
        r = ess.apply_loans(base_result(), ctx)
        self.assertEqual(line_amount(r, 'deductions_data', 'LOAN_EMI'), Decimal('2000'))
        self.assertEqual(r['net_pay'], 43000.0)
        r = ess.apply_loans(base_result(), ctx)                     # re-run: same, not doubled
        self.assertEqual(line_amount(r, 'deductions_data', 'LOAN_EMI'), Decimal('2000'))
        self.assertEqual(LoanInstallment.objects.filter(loan=loan, status='deducted').count(), 1)
        loan.refresh_from_db()
        self.assertEqual(loan.outstanding, Decimal('4000'))
        # preview (no run) does not mark anything
        ess.apply_loans(base_result(), dict(ctx, start=date(2099, 2, 1), run_id=None))
        self.assertEqual(LoanInstallment.objects.filter(loan=loan, status='deducted').count(), 1)
        for m in (2, 3):
            rr = make_run(f'2099-0{m}', date(2099, m, 1), date(2099, m, 28), status='draft')
            ess.apply_loans(base_result(), {'email': self.EMP, 'start': date(2099, m, 1), 'end': date(2099, m, 28),
                                            'run_id': rr.id})
        loan.refresh_from_db()
        self.assertEqual((loan.status, loan.outstanding), ('closed', Decimal('0')))

    def test_emi_never_makes_net_negative(self):
        loan = self._active_loan(amount='15000', tenure=3)          # EMI 5000
        run = make_run('2099-01', date(2099, 1, 1), date(2099, 1, 31), status='draft')
        ctx = {'email': self.EMP, 'start': date(2099, 1, 1), 'end': date(2099, 1, 31), 'run_id': run.id}
        r = ess.apply_loans(base_result(gross=6000, ded=5000), ctx)  # only 1000 net available
        self.assertEqual(line_amount(r, 'deductions_data', 'LOAN_EMI'), Decimal('1000'))
        self.assertEqual(r['net_pay'], 0.0)
        carry = LoanInstallment.objects.filter(loan=loan, status='scheduled', period='2099-01')
        self.assertEqual([c.amount for c in carry], [Decimal('4000.00')])
        r = ess.apply_loans(base_result(gross=6000, ded=5000), ctx)  # re-run merges and re-splits
        self.assertEqual(LoanInstallment.objects.filter(loan=loan).count(), 4)
        run2 = make_run('2099-02', date(2099, 2, 1), date(2099, 2, 28), status='draft')
        r2 = ess.apply_loans(base_result(), {'email': self.EMP, 'start': date(2099, 2, 1), 'end': date(2099, 2, 28),
                                             'run_id': run2.id})
        self.assertEqual(line_amount(r2, 'deductions_data', 'LOAN_EMI'), Decimal('9000'))   # carry 4000 + 5000
        loan.refresh_from_db()
        self.assertEqual(loan.outstanding, Decimal('5000'))

    def test_foreclosure(self):
        loan = self._active_loan(amount='9000', tenure=3)
        url = f'/api/payroll/ess/loans/{loan.id}/foreclose'
        self.assertEqual(client(self.EMP).post(url, {'mode': 'full'}, content_type='application/json').status_code, 403)
        r = client(self.HR).post(url, {'mode': 'partial', 'amount': '3000'}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['outstanding'], 6000.0)
        r = client(self.HR).post(url, {'mode': 'full', 'note': 'repaid by cheque'}, content_type='application/json')
        self.assertEqual((r.json()['status'], r.json()['outstanding']), ('closed', 0.0))
        self.assertTrue(PayrollAuditLog.objects.filter(action='loan_foreclosed').exists())


# ── total rewards ─────────────────────────────────────────────────────────
class TotalRewardsTests(EssBase):
    def test_breakdown_and_gratuity_accrual(self):
        PayrollSetting.objects.create(key='health_insurance', value='{"sum_insured": 500000, "annual_premium": 12000}')
        run2 = make_run('2026-09', date(2026, 9, 1), date(2026, 9, 30))
        make_payslip(run2, self.EMP, bonus=5000, reimb=1000)
        data = client(self.EMP).get('/api/me/pay/total-rewards?fy=2026-27').json()
        comp = {c['key']: c['amount'] for c in data['components']}
        self.assertEqual(comp['base'], 50000.0)                       # 2 × 25000
        self.assertEqual(comp['allowances'], 20000.0)
        self.assertEqual(comp['variable'], 5000.0)
        self.assertEqual(comp['reimbursements'], 1000.0)
        self.assertEqual(comp['employer'], 3600.0)
        self.assertEqual(comp['health'], 12000.0)
        g = data['gratuity']
        svc_years = g['serviceYears']
        self.assertGreaterEqual(svc_years, 7)
        self.assertEqual(g['accruedLiability'], float((Decimal('25000') * 15 * svc_years / 26).quantize(Decimal('0.01'))))
        self.assertTrue(g['vested'])
        self.assertAlmostEqual(data['total'], sum(comp.values()), places=2)
        self.assertEqual(comp['leave'], 12500.0)                      # 15 EL days × 25000 / 30

    def test_ownership(self):
        self.assertEqual(client(self.OTHER).get(f'/api/me/pay/total-rewards?email={self.EMP}').status_code, 404)
        self.assertEqual(client(self.HR).get(f'/api/me/pay/total-rewards?email={self.EMP}').status_code, 200)
        self.assertEqual(client(self.EMP).get('/api/me/pay/total-rewards?fy=2026-99').status_code, 400)
        self.assertEqual(Client().get('/api/me/pay/total-rewards').status_code, 401)

    def test_policy_update_requires_manage_and_fresh(self):
        body = {'expense_caps': {'internet': 1500}}
        self.assertEqual(client(self.EMP).put('/api/payroll/ess/policy', body, content_type='application/json').status_code, 403)
        self.assertEqual(client(self.HR, fresh=False).put('/api/payroll/ess/policy', body,
                                                          content_type='application/json').status_code, 401)
        self.assertEqual(client(self.HR).put('/api/payroll/ess/policy', {'expense_caps': {'casino': 1}},
                                             content_type='application/json').status_code, 400)
        self.assertEqual(client(self.HR).put('/api/payroll/ess/policy', body, content_type='application/json').status_code, 200)
        self.assertEqual(client(self.EMP).get('/api/payroll/ess/policy').json()['expenseCaps']['internet'], 1500.0)
