"""Full & Final settlement (api/payroll_ext/fnf.py): gratuity rules, leave
encashment, notice and loan recovery, maker-checker approval with a fresh
sign-in, statement + No-Dues certificate, mark paid, permissions, audit."""
from datetime import date
from decimal import Decimal

from django.test import Client, TestCase

from api.models import (AppUser, ClearanceItem, EmployeeLoan, ExpenseClaim, LoanInstallment, PayrollAuditLog,
                        PayrollRun, PayrollSetting, Separation)
from api.payroll_ext import fnf
from tests.test_payroll_ess import EssBase, client, make_payslip


class GratuityRuleTests(TestCase):
    def test_four_years_240_days_counts_as_five(self):
        s = fnf.service_length(date(2020, 1, 1), date(2024, 8, 27))        # 4y + 240d
        self.assertEqual((s['fullYears'], s['remDays'], s['eligible5'], s['creditedYears']), (4, 240, True, 5))
        s = fnf.service_length(date(2020, 1, 1), date(2024, 8, 26))        # 4y + 239d
        self.assertFalse(s['eligible5'])

    def test_five_years_and_part_year_rounding(self):
        s = fnf.service_length(date(2019, 1, 1), date(2023, 12, 31))
        self.assertEqual((s['fullYears'], s['eligible5'], s['creditedYears']), (5, True, 5))
        s = fnf.service_length(date(2019, 1, 1), date(2024, 7, 31))        # 5y 7m → 6
        self.assertEqual(s['creditedYears'], 6)
        s = fnf.service_length(date(2019, 1, 1), date(2024, 5, 31))        # 5y 5m → 5
        self.assertEqual(s['creditedYears'], 5)

    def test_amount_cap_and_death_exemption(self):
        g = fnf.gratuity(Decimal('26000'), date(2015, 1, 1), date(2024, 12, 31), 'resignation')
        self.assertEqual((g['years'], g['amount']), (10, Decimal('150000.00')))   # 15 × 26000 × 10 / 26
        g = fnf.gratuity(Decimal('500000'), date(1990, 1, 1), date(2024, 12, 31), 'retirement')
        self.assertTrue(g['capped'])
        self.assertEqual(g['amount'], Decimal('2000000'))
        PayrollSetting.objects.create(key='fnf_policy', value='{"gratuity_cap": 2500000}')
        self.assertEqual(fnf.gratuity(Decimal('500000'), date(1990, 1, 1), date(2024, 12, 31), 'retirement')['amount'],
                         Decimal('2500000'))
        self.assertEqual(fnf.gratuity(Decimal('26000'), date(2022, 1, 1), date(2024, 1, 10), 'resignation')['amount'], 0)
        g = fnf.gratuity(Decimal('26000'), date(2022, 1, 1), date(2024, 1, 10), 'death')
        self.assertTrue(g['eligible'])
        self.assertEqual(g['amount'], Decimal('30000.00'))                 # 2 years


class FnfFlowTests(EssBase):
    def setUp(self):
        super().setUp()
        # last drawn: basic 30000 + HRA 30000 = gross 60000; doj 2018-01-01
        run = PayrollRun.objects.create(period_label='2026-11', period_start=date(2026, 11, 1),
                                        period_end=date(2026, 11, 30), status='approved')
        make_payslip(run, self.EMP, basic=30000, hra=30000, net=55000)
        from api.models import UserProfile
        UserProfile.objects.filter(email=self.EMP).update(start_date=date(2018, 1, 1))
        loan = EmployeeLoan.objects.create(email=self.EMP, kind='loan', principal=Decimal('12000'), tenure_months=4,
                                           status='active', outstanding=Decimal('12000'))
        for i in range(4):
            LoanInstallment.objects.create(loan=loan, seq=i + 1, period=f'2027-0{i + 1}', principal_part=3000, amount=3000)
        self.loan = loan
        self.claim = ExpenseClaim.objects.create(email=self.EMP, category='travel', amount=Decimal('2500'),
                                                 expense_date=date(2026, 11, 2), status='approved')

    def initiate(self, who=None, **kw):
        body = {'email': self.EMP, 'separationType': 'resignation', 'resignationDate': '2026-10-16',
                'lastWorkingDay': '2026-11-15', 'noticeDaysRequired': 60, 'noticeDaysServed': 30, 'reason': 'Higher studies'}
        body.update(kw)
        return client(who or self.HR).post('/api/payroll/fnf/separations', body, content_type='application/json')

    def test_full_flow(self):
        self.assertEqual(self.initiate(who=self.EMP).status_code, 403)
        self.assertEqual(client(self.HR, fresh=False).post('/api/payroll/fnf/separations', {},
                                                           content_type='application/json').status_code, 401)
        self.assertEqual(self.initiate(lastWorkingDay='2026-10-01').status_code, 400)
        r = self.initiate()
        self.assertEqual(r.status_code, 201, r.content)
        sid = r.json()['id']
        self.assertEqual(r.json()['clearanceTotal'], 6)
        self.assertEqual(self.initiate().status_code, 409)                                   # one open separation
        base = f'/api/payroll/fnf/separations/{sid}'

        # compute
        c = client(self.HR).post(base + '/compute', {}, content_type='application/json')
        self.assertEqual(c.status_code, 200, c.content)
        items = {i['code']: i for i in c.json()['computation']['items']}
        self.assertEqual(items['SALARY']['amount'], 30000.0)                     # 60000 × 15 / 30
        self.assertEqual(items['GRATUITY']['amount'], 155769.23)                 # 15 × 30000 × 9 / 26
        self.assertEqual(items['GRATUITY']['basis']['creditedYears'], 9)
        self.assertIn('15 ×', items['GRATUITY']['formula'])
        self.assertEqual(items['LEAVE_ENCASH']['amount'], 15000.0)               # 15 EL × 30000 / 30
        self.assertEqual(items['NOTICE_RECOVERY']['amount'], 60000.0)            # 60000 / 30 × 30
        self.assertEqual(items['LOAN_RECOVERY']['amount'], 12000.0)
        self.assertEqual(items['REIMB']['amount'], 2500.0)
        tds = items['TDS']
        taxable = Decimal('30000') + Decimal('15000') - Decimal('60000')
        self.assertEqual(tds['amount'], 0.0 if taxable < 0 else float(taxable * Decimal(str(tds['basis']['rate'])) / 100))
        comp = c.json()['computation']
        self.assertAlmostEqual(comp['net'], comp['totalEarnings'] - comp['totalDeductions'], places=2)

        # approval: clearance must be complete, never by the initiator
        self.assertEqual(client(self.HR2).post(base + '/approve', content_type='application/json').status_code, 409)
        clr = Separation.objects.get(id=sid).clearances.all()
        mgr_item = [x for x in clr if x.department == 'Manager'][0]
        # the employee's manager clears the handover item; a stranger cannot
        self.assertEqual(client(self.OTHER).post(f'{base}/clearances/{mgr_item.id}', {'status': 'cleared'},
                                                 content_type='application/json').status_code, 404)
        self.assertEqual(client(self.EMP).post(f'{base}/clearances/{mgr_item.id}', {'status': 'cleared'},
                                               content_type='application/json').status_code, 404)
        r = client(self.MGR).post(f'{base}/clearances/{mgr_item.id}', {'status': 'cleared', 'note': 'KT done'},
                                  content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        it = [x for x in clr if x.department == 'IT'][0]
        r = client(self.HR2).post(f'{base}/clearances/{it.id}', {'status': 'cleared', 'recoveryAmount': '1500'},
                                  content_type='application/json')
        self.assertEqual(r.status_code, 200)
        for x in clr:
            if x.department not in ('Manager',) and x.id != it.id:
                client(self.HR2).post(f'{base}/clearances/{x.id}', {'status': 'cleared'}, content_type='application/json')
        # computation is stale after clearance changes
        self.assertEqual(client(self.HR2).post(base + '/approve', content_type='application/json').status_code, 409)
        c = client(self.HR).post(base + '/compute', {'overrides': {'tdsRate': 10}}, content_type='application/json')
        items = {i['code']: i for i in c.json()['computation']['items']}
        self.assertEqual(items['CLEARANCE_RECOVERY']['amount'], 1500.0)
        self.assertEqual(items['TDS']['amount'], 0.0)                            # taxable negative → 0
        self.assertEqual(client(self.HR).post(base + '/approve', content_type='application/json').json().get('code'),
                         'MAKER_CHECKER')
        self.assertEqual(client(self.HR2, fresh=False).post(base + '/approve', content_type='application/json').status_code, 401)
        r = client(self.HR2).post(base + '/approve', content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'approved')

        docs = client(self.HR).get(base + '/documents').json()
        self.assertIn('Full &amp; Final Settlement Statement', docs['statementHtml'])
        self.assertIn('1,55,769.23', docs['statementHtml'])
        self.assertIn('No Dues Clearance Certificate', docs['noDuesHtml'])
        self.assertIn('Priya Sharma', docs['noDuesHtml'])
        self.assertEqual(client(self.EMP).get(base + '/documents').status_code, 403)

        # changes after approval are refused
        self.assertEqual(client(self.HR).post(base + '/compute', {}, content_type='application/json').status_code, 409)
        r = client(self.HR).post(base + '/mark-paid', {'reference': 'NEFT123'}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'paid')
        self.loan.refresh_from_db()
        self.assertEqual((self.loan.status, self.loan.outstanding), ('closed', Decimal('0')))
        self.claim.refresh_from_db()
        self.assertEqual((self.claim.status, self.claim.paid_run_id), ('paid', -sid))
        for a in ('fnf_initiated', 'fnf_computed', 'fnf_clearance_cleared', 'fnf_approved', 'fnf_paid'):
            self.assertTrue(PayrollAuditLog.objects.filter(action=a, entity_id=str(sid)).exists(), a)

    def test_notice_waiver_and_overrides(self):
        sid = self.initiate(noticeBuyout=True).json()['id']
        c = client(self.HR).post(f'/api/payroll/fnf/separations/{sid}/compute',
                                 {'overrides': {'leaveDays': 10, 'payableDays': 0}}, content_type='application/json')
        items = {i['code']: i for i in c.json()['computation']['items']}
        self.assertEqual(items['NOTICE_RECOVERY']['amount'], 0.0)
        self.assertEqual(items['LEAVE_ENCASH']['amount'], 10000.0)
        self.assertEqual(items['SALARY']['amount'], 0.0)
        bad = client(self.HR).post(f'/api/payroll/fnf/separations/{sid}/compute', {'overrides': {'tdsRate': 90}},
                                   content_type='application/json')
        self.assertEqual(bad.status_code, 400)

    def test_stale_inputs_block_approval(self):
        sid = self.initiate().json()['id']
        Separation.objects.get(id=sid).clearances.update(status='cleared')
        client(self.HR).post(f'/api/payroll/fnf/separations/{sid}/compute', {}, content_type='application/json')
        ExpenseClaim.objects.create(email=self.EMP, category='meals', amount=100, expense_date=date(2026, 11, 3),
                                    status='approved')
        r = client(self.HR2).post(f'/api/payroll/fnf/separations/{sid}/approve', content_type='application/json')
        self.assertEqual(r.json().get('code'), 'STALE')

    def test_visibility(self):
        sid = self.initiate().json()['id']
        self.assertEqual(client(self.OTHER).get('/api/payroll/fnf/separations').status_code, 403)
        mine = client(self.MGR).get('/api/payroll/fnf/separations').json()
        self.assertEqual([s['id'] for s in mine['separations']], [sid])
        self.assertNotIn('netPayable', mine['separations'][0])
        self.assertNotIn('computation', client(self.MGR).get(f'/api/payroll/fnf/separations/{sid}').json())
        self.assertEqual(client(self.OTHER).get(f'/api/payroll/fnf/separations/{sid}').status_code, 404)
        self.assertEqual(Client().get('/api/payroll/fnf/separations').status_code, 401)
        hr = client(self.HR).get('/api/payroll/fnf/employees').json()['employees']
        self.assertNotIn(self.EMP, [e['email'] for e in hr])                 # already separating
        self.assertNotIn(self.HR, [e['email'] for e in hr])                  # never yourself
        self.assertEqual(self.initiate(email=self.HR).status_code, 400)
