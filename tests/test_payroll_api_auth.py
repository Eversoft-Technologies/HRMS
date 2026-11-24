"""Access control on the core payroll API (api/payroll_views.py).

DRF runs with AllowAny, so these endpoints used to answer anyone. Now:
anonymous → 401, missing permission → 403, an employee may read only their own
compensation / payslips, payroll.view reads, payroll.manage writes, payouts need
payroll.payout.*, and bank-file exports / disbursal need a fresh sign-in.
"""
import os
from datetime import date
from decimal import Decimal
from unittest import mock

from cryptography.fernet import Fernet
from django.test import Client, TestCase

from api.models import (AppUser, EmployeeCompensation, PayrollEntry, PayrollPayment, PayrollRun, Payslip, Role)
from tests.test_payroll_tax import call, client, make_role

KEY = Fernet.generate_key().decode()


class Base(TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': KEY})
        p.start()
        self.addCleanup(p.stop)
        sup = Role.objects.create(name='Super Admin')
        viewer = make_role('Payroll Viewer', 'payroll.view')
        manager = make_role('Payroll Manager X', 'payroll.view', 'payroll.manage')
        preparer = make_role('Payout Preparer', 'payroll.view', 'payroll.manage', 'payroll.payout.prepare')
        releaser = make_role('Payout Releaser', 'payroll.view', 'payroll.manage', 'payroll.payout.release')
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role='admin', role_ref=sup)
        AppUser.objects.create(email='view@co.com', full_name='Viewer', password='x', role='employee', role_ref=viewer)
        AppUser.objects.create(email='pm@co.com', full_name='PM', password='x', role='employee', role_ref=manager)
        AppUser.objects.create(email='prep@co.com', full_name='Prep', password='x', role='employee', role_ref=preparer)
        AppUser.objects.create(email='rel@co.com', full_name='Rel', password='x', role='employee', role_ref=releaser)
        AppUser.objects.create(email='emp@co.com', full_name='Asha Rao', password='x', role='employee')
        AppUser.objects.create(email='emp2@co.com', full_name='Ravi', password='x', role='employee')
        AppUser.objects.create(email='gone@co.com', full_name='Gone', password='x', role='admin', role_ref=sup,
                               status='inactive')

        self.anon = Client()
        self.boss = client('boss@co.com')
        self.view = client('view@co.com')
        self.pm = client('pm@co.com')
        self.pm_stale = client('pm@co.com', fresh=False)
        self.prep = client('prep@co.com')
        self.rel = client('rel@co.com')
        self.rel_stale = client('rel@co.com', fresh=False)
        self.emp = client('emp@co.com')
        self.emp_header_only = client('emp@co.com', fresh=False)

        self.comp = EmployeeCompensation.objects.create(email='emp@co.com', annual_ctc=Decimal('600000'),
                                                        base_amount=Decimal('25000'))
        self.comp2 = EmployeeCompensation.objects.create(email='emp2@co.com', annual_ctc=Decimal('900000'),
                                                         base_amount=Decimal('35000'))
        self.run = PayrollRun.objects.create(period_label='2026-11', period_start=date(2026, 11, 1),
                                             period_end=date(2026, 11, 30), status='approved')
        e = [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': 20000}]
        self.entry = PayrollEntry.objects.create(run=self.run, email='emp@co.com', employee_name='Asha Rao',
                                                 gross_earnings=20000, net_pay=Decimal('20000'), paid_days=30,
                                                 earnings_data=e, deductions_data=[])
        self.slip = Payslip.objects.create(run=self.run, email='emp@co.com', employee_name='Asha Rao',
                                           gross_earnings=20000, net_pay=Decimal('20000'), paid_days=30,
                                           earnings_data=e, deductions_data=[])
        self.slip2 = Payslip.objects.create(run=self.run, email='emp2@co.com', employee_name='Ravi',
                                            gross_earnings=30000, net_pay=Decimal('30000'), paid_days=30,
                                            earnings_data=e, deductions_data=[])
        self.pay = PayrollPayment.objects.create(run=self.run, entry=self.entry, email='emp@co.com',
                                                 employee_name='Asha Rao', amount=Decimal('20000'),
                                                 account_number='50100234567890', ifsc_or_routing='HDFC0001234')

    def assert_denied(self, r, status, code=None):
        self.assertEqual(r.status_code, status, r.content[:300])
        body = r.json()
        self.assertIn('message', body)
        if code:
            self.assertEqual(body.get('code'), code)
        return body


R = '/api/payroll'


class AnonymousTests(Base):
    def test_everything_is_401(self):
        rid, sid, pid = self.run.id, self.slip.id, self.pay.id
        gets = [f'{R}/dashboard', f'{R}/structures', f'{R}/periods', f'{R}/compensations',
                f'{R}/compensations?email=emp@co.com', f'{R}/compensations/{self.comp.id}', f'{R}/components',
                f'{R}/employee-components', f'{R}/runs', f'{R}/runs/{rid}', f'{R}/runs/{rid}/entries',
                f'{R}/runs/{rid}/attendance-summary', f'{R}/runs/{rid}/export-neft-file',
                f'{R}/runs/{rid}/export-bank-file', f'{R}/adjustments', f'{R}/approvals', f'{R}/payments',
                f'{R}/audit-logs', f'{R}/reports/monthly', f'{R}/reports/department', f'{R}/reports/statutory',
                f'{R}/payslips', f'{R}/payslips?email=emp@co.com', f'{R}/payslips/{sid}', f'{R}/payslips/{sid}/pdf',
                f'{R}/settings']
        for url in gets:
            self.assert_denied(self.anon.get(url), 401, 'AUTH_REQUIRED')
        posts = [f'{R}/runs', f'{R}/runs/{rid}/validate', f'{R}/runs/{rid}/submit-approval',
                 f'{R}/runs/{rid}/action-approval', f'{R}/runs/{rid}/approve', f'{R}/runs/{rid}/create-payment-batch',
                 f'{R}/payments/disburse', f'{R}/payments/{pid}/mark-failed', f'{R}/compensations',
                 f'{R}/payslips/{sid}/regenerate', f'{R}/settings', f'{R}/adjustments']
        for url in posts:
            self.assert_denied(call(self.anon, 'POST', url, {}), 401, 'AUTH_REQUIRED')
        self.assert_denied(call(self.anon, 'PATCH', f'{R}/compensations/{self.comp.id}', {'annual_ctc': '1'}), 401)
        self.assert_denied(call(self.anon, 'DELETE', f'{R}/runs/{rid}'), 401)
        self.assertTrue(PayrollRun.objects.filter(pk=rid).exists())
        self.assertEqual(EmployeeCompensation.objects.get(pk=self.comp.id).annual_ctc, Decimal('600000'))

    def test_unknown_and_inactive_callers_are_401(self):
        self.assert_denied(Client(HTTP_X_USER_EMAIL='nobody@co.com').get(f'{R}/runs'), 401)
        self.assert_denied(client('gone@co.com').get(f'{R}/runs'), 401)


class EmployeeSelfServiceTests(Base):
    def test_own_compensation_and_payslips(self):
        r = self.emp.get(f'{R}/compensations?email=emp@co.com')
        self.assertEqual(r.status_code, 200)
        self.assertEqual([c['email'] for c in r.json()], ['emp@co.com'])
        r = self.emp.get(f'{R}/compensations?email=EMP@co.com')   # case-insensitive
        self.assertEqual(r.status_code, 200)
        r = self.emp.get(f'{R}/payslips?email=emp@co.com')
        self.assertEqual(r.status_code, 200)
        self.assertEqual([s['id'] for s in r.json()], [self.slip.id])
        self.assertEqual(r.json()[0]['run_period'], '2026-11')
        self.assertEqual(self.emp.get(f'{R}/payslips/{self.slip.id}').status_code, 200)
        r = self.emp.get(f'{R}/payslips/{self.slip.id}/pdf')
        self.assertEqual(r.status_code, 200)
        self.assertIn('text/html', r['Content-Type'])
        # Header-only identity is enough for one's own data (no fresh sign-in rule here).
        self.assertEqual(self.emp_header_only.get(f'{R}/payslips/{self.slip.id}/pdf').status_code, 200)

    def test_others_data_and_lists_are_403(self):
        for url in (f'{R}/compensations?email=emp2@co.com', f'{R}/compensations', f'{R}/compensations/{self.comp.id}',
                    f'{R}/payslips', f'{R}/payslips?email=emp2@co.com', f'{R}/payslips/{self.slip2.id}',
                    f'{R}/payslips/{self.slip2.id}/pdf', f'{R}/payslips/999999/pdf', f'{R}/runs', f'{R}/runs/{self.run.id}',
                    f'{R}/payments', f'{R}/approvals', f'{R}/audit-logs', f'{R}/dashboard', f'{R}/reports/monthly',
                    f'{R}/employee-components?email=emp@co.com', f'{R}/settings'):
            body = self.assert_denied(self.emp.get(url), 403, 'PERMISSION_DENIED')
            self.assertIn('payroll.view', body['required'], url)

    def test_employee_cannot_write_own_records(self):
        r = call(self.emp, 'PATCH', f'{R}/compensations/{self.comp.id}', {'email': 'emp@co.com', 'annual_ctc': '9999999'})
        body = self.assert_denied(r, 403, 'PERMISSION_DENIED')
        self.assertEqual(body['required'], 'payroll.manage')
        self.assertEqual(EmployeeCompensation.objects.get(pk=self.comp.id).annual_ctc, Decimal('600000'))
        self.assert_denied(call(self.emp, 'POST', f'{R}/payslips/{self.slip.id}/regenerate', {}), 403)

    def test_spoofed_identity_in_query_does_not_help(self):
        # Caller emp2 asking for emp's data with email=emp → still someone else.
        self.assert_denied(client('emp2@co.com').get(f'{R}/payslips?email=emp@co.com'), 403)


class ViewerTests(Base):
    def test_view_can_read_everything(self):
        for url in (f'{R}/runs', f'{R}/runs/{self.run.id}', f'{R}/runs/{self.run.id}/entries', f'{R}/payments',
                    f'{R}/compensations', f'{R}/payslips', f'{R}/payslips/{self.slip2.id}/pdf', f'{R}/dashboard',
                    f'{R}/reports/department', f'{R}/audit-logs', f'{R}/approvals'):
            self.assertEqual(self.view.get(url).status_code, 200, url)
        self.assertEqual(len(self.view.get(f'{R}/payslips').json()), 2)
        self.assertEqual([s['id'] for s in self.view.get(f'{R}/payslips?email=emp2@co.com').json()], [self.slip2.id])

    def test_view_cannot_write_or_export(self):
        body = self.assert_denied(call(self.view, 'PATCH', f'{R}/compensations/{self.comp.id}', {'annual_ctc': '1'}), 403)
        self.assertEqual(body['required'], 'payroll.manage')
        self.assert_denied(call(self.view, 'POST', f'{R}/runs/{self.run.id}/action-approval',
                                {'level': 'super_admin', 'action': 'approve'}), 403)
        self.assert_denied(call(self.view, 'POST', f'{R}/runs/{self.run.id}/validate', {}), 403)
        self.assert_denied(call(self.view, 'DELETE', f'{R}/runs/{self.run.id}'), 403)
        self.assert_denied(self.view.get(f'{R}/runs/{self.run.id}/export-neft-file'), 403)
        self.assertTrue(PayrollRun.objects.filter(pk=self.run.id).exists())


class ManagerTests(Base):
    def test_manage_can_write(self):
        r = call(self.pm, 'PATCH', f'{R}/compensations/{self.comp.id}', {'annual_ctc': '650000.00'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(EmployeeCompensation.objects.get(pk=self.comp.id).annual_ctc, Decimal('650000'))
        r = call(self.pm, 'POST', f'{R}/runs/{self.run.id}/validate', {})
        self.assertEqual(r.status_code, 200, r.content)

    def test_approval_is_payroll_manage(self):
        r = call(self.pm, 'POST', f'{R}/runs/{self.run.id}/action-approval',
                 {'level': 'payroll_executive', 'action': 'approve', 'approver_email': 'pm@co.com'})
        self.assertEqual(r.status_code, 200, r.content)

    def test_neft_export_needs_manage_and_fresh_sign_in(self):
        r = self.pm.get(f'{R}/runs/{self.run.id}/export-neft-file')
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertIn('attachment', r['Content-Disposition'])
        self.assertIn('Bank_Transfer_NEFT_2026-11', r['Content-Disposition'])
        self.assert_denied(self.pm_stale.get(f'{R}/runs/{self.run.id}/export-neft-file'), 401, 'REAUTH_REQUIRED')
        self.assert_denied(self.pm_stale.get(f'{R}/runs/{self.run.id}/export-bank-file'), 401, 'REAUTH_REQUIRED')
        # A token for someone else does not count as a fresh sign-in.
        from tests.test_payroll_tax import token_for
        mixed = Client(HTTP_X_USER_EMAIL='pm@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('boss@co.com'))
        self.assert_denied(mixed.get(f'{R}/runs/{self.run.id}/export-neft-file'), 401, 'REAUTH_REQUIRED')

    def test_manage_alone_cannot_create_batches_or_disburse(self):
        body = self.assert_denied(call(self.pm, 'POST', f'{R}/runs/{self.run.id}/create-payment-batch', {}), 403)
        self.assertIn('payroll.payout.prepare', body['required'])
        body = self.assert_denied(call(self.pm, 'POST', f'{R}/payments/disburse', {'payment_ids': [self.pay.id]}), 403)
        self.assertEqual(body['required'], 'payroll.payout.release')
        self.assert_denied(call(self.pm, 'POST', f'{R}/payments/{self.pay.id}/mark-failed', {}), 403)
        self.assertEqual(PayrollPayment.objects.get(pk=self.pay.id).status, 'pending')


class PayoutTests(Base):
    def test_preparer_creates_batch_and_marks_failed_but_cannot_disburse(self):
        r = call(self.prep, 'POST', f'{R}/runs/{self.run.id}/create-payment-batch', {})
        self.assertNotIn(r.status_code, (401, 403), r.content)
        r = call(self.prep, 'POST', f'{R}/payments/{self.pay.id}/mark-failed', {'failure_reason': 'x'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assert_denied(call(self.prep, 'POST', f'{R}/payments/disburse', {'payment_ids': [self.pay.id]}), 403)

    def test_releaser_disburses_with_fresh_sign_in_only(self):
        self.assert_denied(call(self.rel_stale, 'POST', f'{R}/payments/disburse', {'payment_ids': [self.pay.id]}),
                           401, 'REAUTH_REQUIRED')
        self.assertEqual(PayrollPayment.objects.get(pk=self.pay.id).status, 'pending')
        r = call(self.rel, 'POST', f'{R}/payments/disburse', {'payment_ids': [self.pay.id]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(PayrollPayment.objects.get(pk=self.pay.id).status, 'successful')

    def test_super_admin_passes_everything_with_token(self):
        self.assertEqual(self.boss.get(f'{R}/runs/{self.run.id}/export-neft-file').status_code, 200)
        r = call(self.boss, 'POST', f'{R}/payments/disburse', {'payment_ids': [self.pay.id]})
        self.assertEqual(r.status_code, 200, r.content)
        # ...but still needs the fresh sign-in for money moves.
        self.assert_denied(client('boss@co.com', fresh=False).get(f'{R}/runs/{self.run.id}/export-neft-file'),
                           401, 'REAUTH_REQUIRED')


class ApproverIdentityTests(Base):
    """The approver and their level come from the caller, not the request body."""

    def setUp(self):
        super().setUp()
        self.run.status = 'pending_approval'
        self.run.save(update_fields=['status'])

    def test_body_cannot_spoof_approver_or_claim_finance_level(self):
        from api.models import PayrollApproval
        r = call(self.pm, 'POST', f'{R}/runs/{self.run.id}/action-approval',
                 {'level': 'finance_manager', 'action': 'approve',
                  'approver_email': 'boss@co.com', 'approver_name': 'Boss'})
        self.assertEqual(r.status_code, 200, r.content)
        a = PayrollApproval.objects.filter(run=self.run).order_by('-id').first()
        self.assertEqual(a.approver_email, 'pm@co.com')
        self.assertNotEqual(a.level, 'finance_manager')
        # One approval from a non-finance role does not finalise the run.
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, 'pending_approval')

    def test_super_admin_may_choose_a_level(self):
        from api.models import PayrollApproval
        r = call(self.boss, 'POST', f'{R}/runs/{self.run.id}/action-approval',
                 {'level': 'finance_manager', 'action': 'approve'})
        self.assertEqual(r.status_code, 200, r.content)
        a = PayrollApproval.objects.filter(run=self.run).order_by('-id').first()
        self.assertEqual((a.approver_email, a.level), ('boss@co.com', 'finance_manager'))
