"""US payroll (api/payroll_ext/us_payroll.py).

Federal withholding expectations are hand-computed from IRS Pub 15-T (2025),
Worksheet 1A + the annual percentage-method tables for automated payroll:

  Single, monthly $5,000          60,000 − 8,600 = 51,400 → 1,192.50 + 12% × (51,400 − 18,325)
                                  = 5,161.50 / 12 = 430.13
  Single, monthly $5,000, Step 2  60,000 (no adjustment), Step 2 table → 8,825.44 + 24% × (60,000 − 59,175)
                                  = 9,023.44 / 12 = 751.95
  Single, monthly $5,000, 4(a) 12,000, 4(b) 3,600, 4(c) 50
                                  72,000 − (3,600 + 8,600) = 59,800 → 5,578.50 + 22% × 4,925 = 6,662 / 12
                                  = 555.17 + 50 = 605.17
  Single, weekly $1,000           52,000 − 8,600 = 43,400 → 1,192.50 + 12% × 25,075 = 4,201.50 / 52 = 80.80
  MFJ, bi-weekly $3,000           78,000 − 12,900 = 65,100 → 2,385 + 12% × 24,150 = 5,283 / 26 = 203.19
  MFJ, bi-weekly $3,000, Step 3 $4,000   (5,283 − 4,000) / 26 = 49.35
  HOH, semi-monthly $4,000        96,000 − 8,600 = 87,400 → 7,442 + 22% × 8,650 = 9,345 / 24 = 389.38
"""
import copy
import os
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest import mock

import jwt
from cryptography.fernet import Fernet
from django.conf import settings
from django.test import Client, TestCase

from api.models import (AppUser, ContractorPayment, EmployeeCompensation, PayComponent, PayrollAuditLog,
                        PayrollEntry, PayrollRun, PayrollTaxTable, Payslip, Permission, Role, RolePermission,
                        StatutoryFiling, UsW4Declaration)
from api.payroll_ext import apply_calculation_hooks
from api.payroll_ext import us_payroll as us

SECRETS = Fernet.generate_key().decode()
SSN = '123-45-6789'


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


def W(**kw):
    d = dict(us.W4_DEFAULTS)
    d.update(kw)
    return d


class Base(TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS})
        p.start()
        self.addCleanup(p.stop)
        us.ensure_seeded()
        self.fed = us.get_table(2025, 'federal')[0]

    def make_users(self):
        perm = Permission.objects.create(code='payroll.us.manage', name='Manage US Payroll')
        role = Role.objects.create(name='Payroll Admin')
        RolePermission.objects.create(role=role, permission=perm)
        AppUser.objects.create(email='pay@co.com', full_name='Pay Admin', password='x', role='hr', role_ref=role)
        AppUser.objects.create(email='emp@co.com', full_name='Emma Employee', password='x', role='employee')
        AppUser.objects.create(email='other@co.com', full_name='Otto Other', password='x', role='employee')
        self.admin = Client(HTTP_X_USER_EMAIL='pay@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('pay@co.com'))
        self.admin_stale = Client(HTTP_X_USER_EMAIL='pay@co.com')
        self.emp = Client(HTTP_X_USER_EMAIL='emp@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('emp@co.com'))
        self.emp_stale = Client(HTTP_X_USER_EMAIL='emp@co.com')
        # forged header: token belongs to someone else
        self.forged = Client(HTTP_X_USER_EMAIL='pay@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('emp@co.com'))


# ═════════════════════════════════════════════════════════════════════════
class FederalWithholdingTests(Base):
    def fit(self, wages, freq, **w4):
        return us.federal_withholding(Decimal(wages), us.PERIODS[freq], W(**w4), self.fed)[0]

    def test_single_monthly(self):
        self.assertEqual(self.fit('5000', 'monthly'), Decimal('430.13'))

    def test_single_weekly(self):
        self.assertEqual(self.fit('1000', 'weekly'), Decimal('80.80'))

    def test_married_biweekly_and_step3_credit(self):
        self.assertEqual(self.fit('3000', 'biweekly', filing_status='married_jointly'), Decimal('203.19'))
        self.assertEqual(self.fit('3000', 'biweekly', filing_status='married_jointly',
                                  dependents_amount=Decimal('4000')), Decimal('49.35'))
        # a credit larger than the tax never goes negative
        self.assertEqual(self.fit('3000', 'biweekly', filing_status='married_jointly',
                                  dependents_amount=Decimal('9000')), Decimal('0.00'))

    def test_head_of_household_semimonthly(self):
        self.assertEqual(self.fit('4000', 'semimonthly', filing_status='head_of_household'), Decimal('389.38'))

    def test_step2_checkbox_uses_higher_table(self):
        self.assertEqual(self.fit('5000', 'monthly', multiple_jobs=True), Decimal('751.95'))

    def test_step4_adjustments(self):
        self.assertEqual(self.fit('5000', 'monthly', other_income=Decimal('12000'), deductions=Decimal('3600'),
                                  extra_withholding=Decimal('50')), Decimal('605.17'))

    def test_exempt_and_low_wages(self):
        self.assertEqual(self.fit('5000', 'monthly', exempt=True), Decimal('0'))
        self.assertEqual(self.fit('500', 'monthly'), Decimal('0.00'))

    def test_seeded_tables_match_pub15t_2025(self):
        single = self.fed['tables']['single']['standard']
        self.assertEqual(single[2], {'over': 18325.0, 'base': 1192.5, 'rate': 12.0})
        self.assertEqual(single[-1], {'over': 632750.0, 'base': 188769.75, 'rate': 37.0})
        mfj = self.fed['tables']['married_jointly']['standard']
        self.assertEqual(mfj[-1], {'over': 768700.0, 'base': 202154.5, 'rate': 37.0})
        self.assertEqual(self.fed['tables']['single']['step2'][2], {'over': 13463.0, 'base': 596.3, 'rate': 12.0})
        row = PayrollTaxTable.objects.get(country='US', period='2025', kind='fica')
        self.assertEqual(row.data['ss_wage_base'], 176100)
        self.assertIn('verify', row.notes)
        self.assertFalse(row.data['verified'])

    def test_seed_is_idempotent(self):
        n = PayrollTaxTable.objects.filter(country='US').count()
        self.assertEqual(us.ensure_seeded(), 0)
        self.assertEqual(us.ensure_seeded(force_year=2025), 0)
        self.assertEqual(PayrollTaxTable.objects.filter(country='US').count(), n)


class FicaFutaStateTests(Base):
    def calc(self, wages, ytd=0, freq='monthly', **w4):
        return us.compute_withholding(Decimal(wages), us.PERIODS[freq], W(**w4), 2025, Decimal(ytd))

    def test_social_security_wage_base_cap(self):
        a = self.calc('5000', ytd='175000', work_state='TX')['amounts']
        self.assertEqual(a['socsec'], Decimal('68.20'))            # 6.2% × (176,100 − 175,000)
        self.assertEqual(a['er_socsec'], Decimal('68.20'))
        self.assertEqual(self.calc('5000', ytd='180000', work_state='TX')['amounts']['socsec'], Decimal('0.00'))
        self.assertEqual(self.calc('5000', work_state='TX')['amounts']['socsec'], Decimal('310.00'))

    def test_additional_medicare_above_200k(self):
        a = self.calc('5000', ytd='198000', work_state='TX')['amounts']
        self.assertEqual(a['medicare'], Decimal('99.50'))          # 72.50 + 0.9% × 3,000
        self.assertEqual(a['er_medicare'], Decimal('72.50'))       # employer never pays the additional 0.9%
        self.assertEqual(self.calc('5000', ytd='250000', work_state='TX')['amounts']['medicare'], Decimal('117.50'))

    def test_futa_cap_at_7000(self):
        self.assertEqual(self.calc('5000', work_state='TX')['amounts']['futa'], Decimal('30.00'))
        self.assertEqual(self.calc('5000', ytd='5000', work_state='TX')['amounts']['futa'], Decimal('12.00'))
        self.assertEqual(self.calc('5000', ytd='7000', work_state='TX')['amounts']['futa'], Decimal('0.00'))

    def test_state_none_flat_brackets(self):
        self.assertEqual(self.calc('5000', work_state='TX')['amounts']['sit'], Decimal('0'))
        self.assertEqual(self.calc('5000', work_state='PA')['amounts']['sit'], Decimal('153.50'))   # 3.07% flat
        # IL: (60,000 − 1 × 2,850) × 4.95% / 12
        self.assertEqual(self.calc('5000', work_state='IL', state_allowances=1)['amounts']['sit'], Decimal('235.74'))
        # CA single: 60,000 − 5,540 = 54,460 through the brackets = 1,845.16 / 12
        self.assertEqual(self.calc('5000', work_state='CA')['amounts']['sit'], Decimal('153.76'))
        # one CA allowance = $154 credit
        self.assertEqual(self.calc('5000', work_state='CA', state_allowances=1)['amounts']['sit'], Decimal('140.93'))
        # extra state withholding is added per period
        self.assertEqual(self.calc('5000', work_state='PA', state_extra_withholding=Decimal('10'))['amounts']['sit'],
                         Decimal('163.50'))

    def test_suta_uses_state_wage_base(self):
        a = self.calc('5000', ytd='6000', work_state='TX')['amounts']          # TX 2.7% on 9,000
        self.assertEqual(a['suta'], Decimal('81.00'))

    def test_missing_state_table_warns_and_zero(self):
        res = self.calc('5000', work_state='OH')
        self.assertEqual(res['amounts']['sit'], Decimal('0'))
        self.assertTrue(any('No state tax table for OH' in w for w in res['warnings']))
        res = self.calc('5000')
        self.assertTrue(any('No work state' in w for w in res['warnings']))


class HookTests(Base):
    def setUp(self):
        super().setUp()
        EmployeeCompensation.objects.create(email='us@co.com', currency='USD', pay_frequency='monthly',
                                            base_amount=Decimal('5000'), annual_ctc=Decimal('60000'))
        EmployeeCompensation.objects.create(email='in@co.com', currency='INR', pay_frequency='monthly',
                                            base_amount=Decimal('50000'), annual_ctc=Decimal('600000'))
        UsW4Declaration.objects.create(email='us@co.com', year=2025, filing_status='single', work_state='PA')

    def result(self, email, currency, amount=5000):
        return {'email': email, 'currency': currency,
                'earnings_data': [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': amount},
                                  {'code': 'REIMB', 'label': 'Reimbursement', 'amount': 100}],
                'deductions_data': [{'code': 'PF', 'label': 'PF', 'amount': 600},
                                    {'code': 'LOAN_RECOVERY', 'label': 'Loan', 'amount': 200}],
                'employer_contributions_data': [{'code': 'GROSS_EARNING', 'label': 'GROSS', 'amount': amount + 100},
                                                {'code': 'EMPLOYER_PF', 'label': 'EPF', 'amount': 600}],
                'gross_earnings': amount + 100, 'total_deductions': 800, 'net_pay': amount - 700,
                'employer_contribution': 600, 'total_ctc': amount + 700}

    def ctx(self, email, run_id=None):
        return {'email': email, 'start': date(2025, 3, 1), 'end': date(2025, 3, 31), 'run_id': run_id}

    def test_inr_employee_untouched(self):
        r = self.result('in@co.com', 'INR', 50000)
        before = copy.deepcopy(r)
        out = us.apply_us(r, self.ctx('in@co.com'))
        self.assertEqual(out, before)

    def test_us_employee_lines_and_totals(self):
        out = us.apply_us(self.result('us@co.com', 'USD'), self.ctx('us@co.com'))
        ded = {l['code']: l['amount'] for l in out['deductions_data']}
        er = {l['code']: l['amount'] for l in out['employer_contributions_data']}
        self.assertNotIn('PF', ded)                                  # India statutory stripped
        self.assertNotIn('EMPLOYER_PF', er)
        self.assertEqual(ded['FIT'], 430.13)                         # reimbursement is not taxable
        self.assertEqual(ded['SIT'], 153.50)
        self.assertEqual(ded['SOCSEC'], 310.00)
        self.assertEqual(ded['MEDICARE'], 72.50)
        self.assertEqual(ded['LOAN_RECOVERY'], 200)
        self.assertEqual((er['ER_SOCSEC'], er['ER_MEDICARE'], er['FUTA'], er['SUTA']), (310.0, 72.5, 30.0, 191.1))
        self.assertEqual(out['gross_earnings'], 5100.0)
        self.assertAlmostEqual(out['total_deductions'], 430.13 + 153.50 + 310 + 72.50 + 200, places=2)
        self.assertAlmostEqual(out['net_pay'], out['gross_earnings'] - out['total_deductions'], places=2)
        self.assertAlmostEqual(out['employer_contribution'], 310 + 72.5 + 30 + 191.1, places=2)
        self.assertAlmostEqual(out['total_ctc'], out['gross_earnings'] + out['employer_contribution'], places=2)
        self.assertEqual(out['us_warnings'], [])

    def test_runs_through_hook_chain(self):
        out = apply_calculation_hooks(self.result('us@co.com', 'USD'), 'us@co.com', date(2025, 3, 1),
                                      date(2025, 3, 31))
        self.assertIn('FIT', {l['code'] for l in out['deductions_data']})

    def test_ytd_from_earlier_payslips_caps_social_security(self):
        run = PayrollRun.objects.create(period_label='2025-01', period_start=date(2025, 1, 1),
                                        period_end=date(2025, 1, 31), status='paid')
        PayrollEntry.objects.create(run=run, email='us@co.com', currency='USD')
        Payslip.objects.create(run=run, email='us@co.com',
                               earnings_data=[{'code': 'BONUS', 'label': 'Bonus', 'amount': 173000}],
                               deductions_data=[])
        # a payslip from the previous calendar year does not count
        old = PayrollRun.objects.create(period_label='2024-12', period_start=date(2024, 12, 1),
                                        period_end=date(2024, 12, 31), status='paid')
        PayrollEntry.objects.create(run=old, email='us@co.com', currency='USD')
        Payslip.objects.create(run=old, email='us@co.com',
                               earnings_data=[{'code': 'BONUS', 'label': 'Bonus', 'amount': 50000}])
        out = us.apply_us(self.result('us@co.com', 'USD'), self.ctx('us@co.com'))
        ded = {l['code']: l['amount'] for l in out['deductions_data']}
        self.assertEqual(ded['SOCSEC'], 192.20)                       # 6.2% × (176,100 − 173,000)
        self.assertNotIn('FUTA', {l['code'] for l in out['employer_contributions_data']})  # 7,000 already used
        self.assertEqual(out['us_withholding']['ytdWages'], 173000.0)

    def test_missing_w4_defaults_to_single_with_warning(self):
        EmployeeCompensation.objects.create(email='new@co.com', currency='USD', pay_frequency='biweekly',
                                            base_amount=Decimal('3000'))
        r = self.result('new@co.com', 'USD', 3000)
        out = us.apply_us(r, self.ctx('new@co.com'))
        self.assertTrue(any('No Form W-4' in w for w in out['us_warnings']))
        self.assertTrue(any('No work state' in w for w in out['us_warnings']))
        # single, biweekly 3,000: 78,000 − 8,600 = 69,400 → 5,578.50 + 22% × 14,525 = 8,774 / 26
        self.assertEqual({l['code']: l['amount'] for l in out['deductions_data']}['FIT'], 337.46)

    def test_service_calculation_end_to_end(self):
        from api.services.payroll_service import PayrollService
        PayComponent.objects.get_or_create(code='BASIC_SALARY', defaults={'name': 'Basic', 'component_type': 'earning',
                                                                          'calc_type': 'fixed'})
        calc = PayrollService.calculate_employee_pay('us@co.com', date(2025, 3, 1), date(2025, 3, 31))
        ded = {l['code']: l['amount'] for l in calc['deductions_data']}
        self.assertEqual(calc['currency'], 'USD')
        self.assertEqual(ded.get('SOCSEC'), round(calc['gross_earnings'] * 0.062, 2))
        self.assertIn('FIT', ded)
        inr = PayrollService.calculate_employee_pay('in@co.com', date(2025, 3, 1), date(2025, 3, 31))
        self.assertFalse({'FIT', 'SOCSEC', 'MEDICARE'} & {l['code'] for l in inr['deductions_data']})

    def test_hook_never_raises(self):
        with mock.patch.object(us, 'compute_withholding', side_effect=RuntimeError('boom')):
            r = self.result('us@co.com', 'USD')
            self.assertEqual(us.apply_us(r, self.ctx("us@co.com")), r)


class SsnTests(Base):
    def test_validation(self):
        for good in ('123-45-6789', '123456789', '123 45 6789', '899-01-0001'):
            self.assertTrue(us.is_valid_ssn(good), good)
        for bad in ('000-12-3456', '666-12-3456', '900-12-3456', '999-12-3456', '123-00-4567', '123-45-0000',
                    '12345678', '1234567890', 'abc-de-fghi', '', None, '123-456-789'):
            self.assertFalse(us.is_valid_ssn(bad), bad)
        self.assertEqual(us.mask_tin('6789'), '***-**-6789')

    def test_ein_validation(self):
        self.assertEqual(us.normalize_ein('12-3456789'), '123456789')
        self.assertIsNone(us.normalize_ein('00-3456789'))
        self.assertIsNone(us.normalize_ein('12-345678'))


# ═════════════════════════════════════════════════════════════════════════
class W4ApiTests(Base):
    def setUp(self):
        super().setUp()
        self.make_users()
        EmployeeCompensation.objects.create(email='emp@co.com', currency='USD', pay_frequency='semimonthly',
                                            base_amount=Decimal('4000'), annual_ctc=Decimal('96000'))

    def body(self, **kw):
        b = {'year': 2025, 'filingStatus': 'head_of_household', 'multipleJobs': False, 'dependentsAmount': 2000,
             'otherIncome': 0, 'deductions': 0, 'extraWithholding': 0, 'exempt': False, 'workState': 'CA',
             'stateAllowances': 1, 'stateExtraWithholding': 0, 'ssn': SSN, 'certify': True}
        b.update(kw)
        return b

    def test_self_service_sign_encrypts_ssn_and_masks(self):
        r = self.emp.put('/api/me/w4?year=2025', self.body(), content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn('6789', r.content.decode().replace('***-**-6789', ''))
        self.assertNotIn('123456789', r.content.decode())
        self.assertNotIn('123-45', r.content.decode())
        self.assertEqual(r.json()['w4']['ssnMasked'], '***-**-6789')
        row = UsW4Declaration.objects.get(email='emp@co.com', year=2025)
        self.assertNotIn('123456789', row.ssn_enc)
        self.assertTrue(row.ssn_enc.startswith('enc1:'))
        self.assertEqual(row.ssn_last4, '6789')
        self.assertIsNotNone(row.signed_at)
        from api.payroll_ext.security import unseal
        self.assertEqual(unseal(row.ssn_enc), '123456789')
        # GET never shows it either
        g = self.emp.get('/api/me/w4?year=2025')
        self.assertNotIn('123456789', g.content.decode())
        self.assertEqual(g.json()['w4']['filingStatus'], 'head_of_household')
        # audit row, without the SSN
        log = PayrollAuditLog.objects.get(action='us_w4_signed')
        self.assertEqual(log.changes.get('ssn'), 'changed')
        self.assertNotIn('123456789', str(log.changes))
        self.assertNotIn('6789', str(log.changes).replace('***-**-6789', ''))

    def test_invalid_ssn_and_fields_rejected(self):
        for bad in ({'ssn': '000-12-3456'}, {'ssn': '666-45-6789'}, {'filingStatus': 'married'},
                    {'workState': 'XX'}, {'dependentsAmount': -1}, {'dependentsAmount': 'abc'},
                    {'exempt': 'yes'}, {'stateAllowances': 1000}, {'certify': False}, {'extraWithholding': 'NaN'}):
            r = self.emp.put('/api/me/w4?year=2025', self.body(**bad), content_type='application/json')
            self.assertEqual(r.status_code, 400, bad)
        self.assertFalse(UsW4Declaration.objects.exists())

    def test_ssn_required_for_self_service(self):
        b = self.body()
        b.pop('ssn')
        r = self.emp.put('/api/me/w4?year=2025', b, content_type='application/json')
        self.assertEqual(r.status_code, 400)

    def test_fresh_signin_required(self):
        r = self.emp_stale.put('/api/me/w4?year=2025', self.body(), content_type='application/json')
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()['code'], 'REAUTH_REQUIRED')

    def test_employee_cannot_touch_other_w4_or_admin_endpoints(self):
        self.assertEqual(self.emp.get('/api/payroll/us/employees/other@co.com/w4').status_code, 403)
        self.assertEqual(self.emp.put('/api/payroll/us/employees/other@co.com/w4', self.body(),
                                      content_type='application/json').status_code, 403)
        self.assertEqual(self.emp.get('/api/payroll/us/employees').status_code, 403)
        self.assertEqual(self.emp.get('/api/payroll/us/tax-tables').status_code, 403)
        self.assertEqual(Client().get('/api/me/w4').status_code, 401)
        # me/w4 always targets the caller, whatever the body says
        self.emp.put('/api/me/w4?year=2025', self.body(email='other@co.com'), content_type='application/json')
        self.assertFalse(UsW4Declaration.objects.filter(email='other@co.com').exists())

    def test_payroll_admin_view_and_edit(self):
        self.emp.put('/api/me/w4?year=2025', self.body(), content_type='application/json')
        r = self.admin.get('/api/payroll/us/employees/emp@co.com/w4?year=2025')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['w4']['ssnMasked'], '***-**-6789')
        self.assertEqual(self.admin_stale.put('/api/payroll/us/employees/emp@co.com/w4?year=2025',
                                              {'workState': 'TX'}, content_type='application/json').status_code, 401)
        self.assertEqual(self.forged.put('/api/payroll/us/employees/emp@co.com/w4?year=2025',
                                         {'workState': 'TX'}, content_type='application/json').status_code, 401)
        r = self.admin.put('/api/payroll/us/employees/emp@co.com/w4?year=2025', {'workState': 'TX'},
                           content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        w = r.json()['w4']
        self.assertEqual((w['workState'], w['filingStatus'], w['ssnMasked']), ('TX', 'head_of_household', '***-**-6789'))
        log = PayrollAuditLog.objects.get(action='us_w4_updated')
        self.assertEqual(log.changes['workState'], {'from': 'CA', 'to': 'TX'})
        lst = self.admin.get('/api/payroll/us/employees?year=2025').json()['employees']
        self.assertEqual([e['email'] for e in lst], ['emp@co.com'])
        self.assertNotIn('123456789', str(lst))

    def test_carry_forward_and_preview(self):
        self.emp.put('/api/me/w4?year=2025', self.body(), content_type='application/json')
        g = self.emp.get('/api/me/w4?year=2026').json()['w4']
        self.assertEqual((g['exists'], g['carriedFrom'], g['ssnOnFile']), (False, 2025, True))
        # employee re-signs for 2026 without re-entering the SSN
        b = self.body(year=2026)
        b.pop('ssn')
        r = self.emp.put('/api/me/w4?year=2026', b, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(UsW4Declaration.objects.get(email='emp@co.com', year=2026).ssn_last4, '6789')
        p = self.emp.post('/api/me/w4/preview', {'year': 2025, 'wages': 4000,
                                                  'w4': {'filingStatus': 'head_of_household', 'dependentsAmount': 0,
                                                         'workState': 'TX'}},
                          content_type='application/json').json()
        self.assertEqual(p['lines']['fit'], 389.38)
        self.assertEqual(p['lines']['sit'], 0.0)


class TaxTableApiTests(Base):
    def setUp(self):
        super().setUp()
        self.make_users()

    def test_list_edit_verify_and_audit(self):
        r = self.admin.get('/api/payroll/us/tax-tables?year=2025').json()
        self.assertGreater(r['unverified'], 10)
        fica = next(t for t in r['tables'] if t['kind'] == 'fica')
        data = dict(fica['data'], ss_wage_base=180000)
        self.assertEqual(self.admin_stale.put(f'/api/payroll/us/tax-tables/{fica["id"]}', {'data': data},
                                              content_type='application/json').status_code, 401)
        self.assertEqual(self.emp.put(f'/api/payroll/us/tax-tables/{fica["id"]}', {'data': data},
                                      content_type='application/json').status_code, 403)
        u = self.admin.put(f'/api/payroll/us/tax-tables/{fica["id"]}', {'data': data, 'verified': True},
                           content_type='application/json')
        self.assertEqual(u.status_code, 200, u.content)
        self.assertTrue(u.json()['verified'])
        self.assertEqual(u.json()['verifiedBy'], 'pay@co.com')
        self.assertEqual(us.get_table(2025, 'fica')[0]['ss_wage_base'], 180000.0)
        self.assertTrue(PayrollAuditLog.objects.filter(action='us_tax_table_updated').exists())

    def test_validation_rejects_bad_tables(self):
        r = self.admin.get('/api/payroll/us/tax-tables?year=2025').json()
        fica = next(t for t in r['tables'] if t['kind'] == 'fica')
        bad = dict(fica['data'], ss_rate=150)
        self.assertEqual(self.admin.put(f'/api/payroll/us/tax-tables/{fica["id"]}', {'data': bad},
                                        content_type='application/json').status_code, 400)
        fed = next(t for t in r['tables'] if t['kind'] == 'federal')
        d = copy.deepcopy(fed['data'])
        d['tables']['single']['standard'][3]['over'] = 1          # not increasing
        self.assertEqual(self.admin.put(f'/api/payroll/us/tax-tables/{fed["id"]}', {'data': d},
                                        content_type='application/json').status_code, 400)
        self.assertEqual(self.admin.delete(f'/api/payroll/us/tax-tables/{fed["id"]}').status_code, 400)

    def test_add_state_table_then_sit_applies(self):
        body = {'year': 2025, 'kind': 'state', 'region': 'OH',
                'data': {'type': 'flat', 'rate': 2.75, 'std_deduction': 0, 'allowance_value': 0}}
        r = self.admin.post('/api/payroll/us/tax-tables', body, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        res = us.compute_withholding(Decimal('5000'), 12, W(work_state='OH'), 2025)
        self.assertEqual(res['amounts']['sit'], Decimal('137.50'))
        self.assertEqual(self.admin.post('/api/payroll/us/tax-tables', body,
                                         content_type='application/json').status_code, 400)   # duplicate
        bad = dict(body, region='ZZ')
        self.assertEqual(self.admin.post('/api/payroll/us/tax-tables', bad,
                                         content_type='application/json').status_code, 400)
        bad = dict(body, region='OK', data={'type': 'brackets', 'brackets': {'single': [{'upto': 1000, 'rate': 1}]}})
        self.assertEqual(self.admin.post('/api/payroll/us/tax-tables', bad,
                                         content_type='application/json').status_code, 400)  # last must be open

    def test_pay_calendar(self):
        r = self.admin.get('/api/payroll/us/pay-calendar?count=3&from=2026-01-20')
        self.assertEqual(r.status_code, 200)
        cal = {c['frequency']: c['periods'] for c in r.json()['calendars']}
        self.assertEqual(cal['semimonthly'][0]['start'], '2026-01-16')
        self.assertEqual(cal['semimonthly'][0]['end'], '2026-01-31')
        self.assertEqual(cal['semimonthly'][1]['start'], '2026-02-01')
        self.assertEqual(cal['monthly'][0]['end'], '2026-01-31')
        self.assertEqual(len(cal['biweekly']), 3)
        self.assertEqual(self.emp.get('/api/payroll/us/pay-calendar').status_code, 403)
        p = us.pay_periods('biweekly', 2, date(2026, 1, 20), anchor=date(2026, 1, 5))
        self.assertEqual((p[0]['start'], p[0]['end'], p[1]['start']), ('2026-01-19', '2026-02-01', '2026-02-02'))
        p = us.pay_periods('biweekly', 1, date(2025, 12, 30), anchor=date(2026, 1, 5))   # before the anchor
        self.assertEqual(p[0]['start'], '2025-12-22')


# ═════════════════════════════════════════════════════════════════════════
class W2Tests(Base):
    def setUp(self):
        super().setUp()
        self.make_users()
        UsW4Declaration.objects.create(email='emp@co.com', year=2025, filing_status='single', work_state='PA',
                                       ssn_enc='enc1:dummy', ssn_last4='6789')
        for m in (1, 2):
            run = PayrollRun.objects.create(period_label=f'2025-0{m}', period_start=date(2025, m, 1),
                                            period_end=date(2025, m, 28), status='paid')
            PayrollEntry.objects.create(run=run, email='emp@co.com', currency='USD')
            Payslip.objects.create(run=run, email='emp@co.com', earnings_data=[
                {'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': 5000},
                {'code': 'REIMB', 'label': 'Reimbursement', 'amount': 250}],
                deductions_data=[{'code': 'FIT', 'amount': 430.13}, {'code': 'SIT', 'amount': 153.5},
                                 {'code': 'SOCSEC', 'amount': 310}, {'code': 'MEDICARE', 'amount': 72.5}])
        # an INR payslip for the same year is ignored
        run = PayrollRun.objects.create(period_label='2025-03', period_start=date(2025, 3, 1),
                                        period_end=date(2025, 3, 31), status='paid')
        PayrollEntry.objects.create(run=run, email='emp@co.com', currency='INR')
        Payslip.objects.create(run=run, email='emp@co.com',
                               earnings_data=[{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': 99999}])

    def test_box_totals(self):
        data, _ = us.w2_data(2025)
        b = data['emp@co.com']
        self.assertEqual((b['box1'], b['box2'], b['box3'], b['box4'], b['box5'], b['box6']),
                         (10000.0, 860.26, 10000.0, 620.0, 10000.0, 145.0))
        self.assertEqual((b['box15'], b['box16'], b['box17']), ('PA', 10000.0, 307.0))
        self.assertEqual(b['ssnMasked'], '***-**-6789')

    def test_ss_wages_capped_at_wage_base(self):
        run = PayrollRun.objects.create(period_label='2025-04', period_start=date(2025, 4, 1),
                                        period_end=date(2025, 4, 30), status='paid')
        PayrollEntry.objects.create(run=run, email='emp@co.com', currency='USD')
        Payslip.objects.create(run=run, email='emp@co.com',
                               earnings_data=[{'code': 'BONUS', 'label': 'Bonus', 'amount': 200000}])
        b = us.w2_data(2025)[0]['emp@co.com']
        self.assertEqual((b['box1'], b['box3'], b['box5']), (210000.0, 176100.0, 210000.0))

    def test_generate_requires_fresh_and_permission_and_stores(self):
        self.assertEqual(self.emp.post('/api/payroll/us/w2/generate', {'year': 2025},
                                       content_type='application/json').status_code, 403)
        self.assertEqual(self.admin_stale.post('/api/payroll/us/w2/generate', {'year': 2025},
                                               content_type='application/json').status_code, 401)
        r = self.admin.post('/api/payroll/us/w2/generate', {'year': 2025}, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()['forms']), 1)
        form = StatutoryFiling.objects.get(kind='W2', email='emp@co.com')
        self.assertIn('10,000.00', form.content)
        self.assertIn('***-**-6789', form.content)
        self.assertIn('EFW2', form.content)
        summary = StatutoryFiling.objects.get(kind='W2', email='')
        self.assertIn('RW,2025', summary.content)
        self.assertIn('RT,2025', summary.content)
        self.assertTrue(PayrollAuditLog.objects.filter(action='us_w2_generated').exists())
        # downloads: admin needs a fresh sign-in; the employee only their own
        self.assertEqual(self.admin_stale.get(f'/api/payroll/us/filings/{form.id}/download').status_code, 401)
        d = self.admin.get(f'/api/payroll/us/filings/{form.id}/download')
        self.assertEqual(d.status_code, 200)
        self.assertEqual(self.emp.get(f'/api/payroll/us/filings/{form.id}/download').status_code, 403)
        own = self.emp.get(f'/api/me/us-forms/{form.id}/download')
        self.assertEqual(own.status_code, 200)
        self.assertEqual(self.emp.get(f'/api/me/us-forms/{summary.id}/download').status_code, 404)
        other = Client(HTTP_X_USER_EMAIL='other@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('other@co.com'))
        self.assertEqual(other.get(f'/api/me/us-forms/{form.id}/download').status_code, 404)
        self.assertEqual([f['id'] for f in self.emp.get('/api/me/us-forms').json()['forms']], [form.id])


class ContractorTests(Base):
    def setUp(self):
        super().setUp()
        self.make_users()

    def pay(self, client=None, **kw):
        b = {'payeeName': 'Acme LLC', 'payeeEmail': 'acme@vendor.com', 'tin': '12-3456789', 'tinType': 'ein',
             'address': '1 Main St, Austin TX', 'amount': 400, 'paidOn': '2025-03-10', 'description': 'Design'}
        b.update(kw)
        return (client or self.admin).post('/api/payroll/us/contractors/payments', b, content_type='application/json')

    def test_crud_tin_encrypted_and_masked(self):
        r = self.pay()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['tinMasked'], '***-**-6789')
        self.assertNotIn('3456789', r.content.decode().replace('***-**-6789', ''))
        p = ContractorPayment.objects.get()
        self.assertNotIn('123456789', p.tin_enc)
        self.assertEqual(p.tin_last4, '6789')
        # second payment without a TIN reuses the stored one
        r2 = self.pay(tin='', amount=250, paidOn='2025-06-01')
        self.assertTrue(r2.json()['tinOnFile'])
        u = self.admin.patch(f'/api/payroll/us/contractors/payments/{r2.json()["id"]}', {'amount': 300},
                             content_type='application/json')
        self.assertEqual(u.json()['amount'], 300.0)
        self.assertTrue(PayrollAuditLog.objects.filter(action='us_contractor_payment_created').exists())
        self.assertTrue(PayrollAuditLog.objects.filter(action='us_contractor_payment_updated').exists())
        self.assertNotIn('123456789', str(list(PayrollAuditLog.objects.values_list('changes', flat=True))))
        lst = self.admin.get('/api/payroll/us/contractors/payments?year=2025').json()
        self.assertEqual(lst['summary'][0]['total'], 700.0)
        self.assertEqual(self.admin.delete(f'/api/payroll/us/contractors/payments/{r2.json()["id"]}').status_code, 200)

    def test_validation_and_permissions(self):
        for bad in ({'tin': '00-1234567'}, {'tin': '666-12-3456', 'tinType': 'ssn'}, {'amount': 0},
                    {'amount': 'x'}, {'paidOn': 'yesterday'}, {'payeeName': ''}, {'payeeEmail': 'nope'},
                    {'tinType': 'itin'}):
            self.assertEqual(self.pay(**bad).status_code, 400, bad)
        self.assertEqual(self.pay(client=self.emp).status_code, 403)
        self.assertEqual(self.pay(client=self.admin_stale).status_code, 401)

    def test_1099_threshold_600(self):
        self.pay(amount=400)
        self.pay(amount=200, tin='')                               # Acme: 600 → form required
        self.pay(payeeName='Small Co', payeeEmail='small@vendor.com', tin='587-65-4321', tinType='ssn',
                 amount=599.99)
        summary, th = us.contractor_summary(2025)
        self.assertEqual(th, Decimal('600'))
        req = {r['payeeName']: r['requires1099'] for r in summary}
        self.assertEqual(req, {'Acme LLC': True, 'Small Co': False})
        r = self.admin.post('/api/payroll/us/1099/generate', {'year': 2025}, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()['forms']), 1)
        form = StatutoryFiling.objects.get(kind='1099NEC', email='acme@vendor.com')
        self.assertIn('600.00', form.content)
        self.assertIn('***-**-6789', form.content)
        csv_row = StatutoryFiling.objects.get(kind='1099NEC', file_mime='text/csv')
        self.assertIn('Small Co', csv_row.content)
        self.assertNotIn('587654321', csv_row.content)
        self.assertTrue(PayrollAuditLog.objects.filter(action='us_1099_generated').exists())
        self.assertEqual(self.admin_stale.post('/api/payroll/us/1099/generate', {'year': 2025},
                                               content_type='application/json').status_code, 401)
        # 2026+: the threshold is $2,000 (P.L. 119-21)
        self.assertEqual(us.threshold_1099(2026), Decimal('2000'))

    def test_csv_injection_neutralised(self):
        self.pay(payeeName='=HYPERLINK("x")', payeeEmail='', amount=700)
        us.generate_1099(2025, 'pay@co.com')
        csv_row = StatutoryFiling.objects.get(kind='1099NEC', file_mime='text/csv')
        self.assertIn("'=HYPERLINK", csv_row.content)
        html_form = StatutoryFiling.objects.get(kind='1099NEC', file_mime='text/html')
        self.assertIn('=HYPERLINK(&quot;x&quot;)', html_form.content)
