"""Exchange rates + CFO consolidation (api/payroll_ext/fx.py)."""
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest import mock

import jwt
from django.conf import settings
from django.test import Client, TestCase

from api.models import (AppUser, ExchangeRate, PayrollAuditLog, PayrollEntry, PayrollRun, PayrollSetting, Permission,
                        Role, RolePermission)
from api.payroll_ext import fx


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


def rate(cur, r, d, rep='INR'):
    return ExchangeRate.objects.create(currency=cur, reporting_currency=rep, rate=Decimal(str(r)), as_of=d)


class ConvertTests(TestCase):
    def test_latest_rate_on_or_before(self):
        rate('USD', 83, date(2025, 1, 1))
        rate('USD', 84, date(2025, 2, 1))
        rate('USD', 90, date(2025, 4, 1))                       # future relative to the dates below
        self.assertEqual(fx.convert(100, 'USD', 'INR', date(2025, 1, 15)), Decimal('8300.00'))
        self.assertEqual(fx.convert(100, 'USD', 'INR', date(2025, 2, 1)), Decimal('8400.00'))
        self.assertEqual(fx.convert(100, 'USD', 'INR', date(2025, 3, 31)), Decimal('8400.00'))
        self.assertIsNone(fx.convert(100, 'USD', 'INR', date(2024, 12, 31)))      # no rate yet

    def test_same_inverse_and_cross_rates(self):
        rate('USD', 80, date(2025, 1, 1))
        rate('GBP', 100, date(2025, 1, 1))
        self.assertEqual(fx.convert(5, 'INR', 'INR', date(2025, 1, 2)), Decimal('5.00'))
        self.assertEqual(fx.convert(8000, 'INR', 'USD', date(2025, 1, 2)), Decimal('100.00'))   # inverse
        self.assertEqual(fx.convert(80, 'GBP', 'USD', date(2025, 1, 2)), Decimal('100.00'))     # via INR
        self.assertIsNone(fx.convert(1, 'EUR', 'INR', date(2025, 1, 2)))


class FxApiTests(TestCase):
    def setUp(self):
        perm = Permission.objects.create(code='payroll.us.manage', name='Manage US Payroll')
        view = Permission.objects.create(code='payroll.view', name='View Payroll')
        admin_role = Role.objects.create(name='Payroll Admin')
        RolePermission.objects.create(role=admin_role, permission=perm)
        viewer_role = Role.objects.create(name='Finance Viewer')
        RolePermission.objects.create(role=viewer_role, permission=view)
        AppUser.objects.create(email='pay@co.com', full_name='Pay', password='x', role='hr', role_ref=admin_role)
        AppUser.objects.create(email='cfo@co.com', full_name='CFO', password='x', role='hr', role_ref=viewer_role)
        AppUser.objects.create(email='emp@co.com', full_name='Emp', password='x', role='employee')
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role='admin')   # legacy super admin
        self.admin = Client(HTTP_X_USER_EMAIL='pay@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('pay@co.com'))
        self.admin_stale = Client(HTTP_X_USER_EMAIL='pay@co.com')
        self.cfo = Client(HTTP_X_USER_EMAIL='cfo@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('cfo@co.com'))
        self.emp = Client(HTTP_X_USER_EMAIL='emp@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('emp@co.com'))
        self.boss = Client(HTTP_X_USER_EMAIL='boss@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('boss@co.com'))

    def entry(self, run, email, cur, gross, ctc, net, dept='Eng'):
        PayrollEntry.objects.create(run=run, email=email, currency=cur, department=dept,
                                    gross_earnings=Decimal(gross), total_ctc=Decimal(ctc), net_pay=Decimal(net))

    def make_runs(self):
        jan = PayrollRun.objects.create(period_label='2025-01', period_start=date(2025, 1, 1),
                                        period_end=date(2025, 1, 31), status='paid')
        feb = PayrollRun.objects.create(period_label='2025-02', period_start=date(2025, 2, 1),
                                        period_end=date(2025, 2, 28), status='paid')
        bad = PayrollRun.objects.create(period_label='2025-02-x', period_start=date(2025, 2, 1),
                                        period_end=date(2025, 2, 28), status='cancelled')
        self.entry(jan, 'a@co.com', 'INR', 100000, 112000, 90000)
        self.entry(jan, 'b@co.com', 'USD', 5000, 5400, 4000, dept='Sales')
        self.entry(feb, 'a@co.com', 'INR', 100000, 112000, 90000)
        self.entry(feb, 'b@co.com', 'USD', 5000, 5400, 4000, dept='Sales')
        self.entry(feb, 'c@co.com', 'GBP', 3000, 3300, 2500)
        self.entry(bad, 'z@co.com', 'INR', 999999, 999999, 999999)

    def test_rate_crud_permissions_fresh_and_audit(self):
        body = {'currency': 'USD', 'rate': '83.25', 'asOf': '2025-01-01'}
        self.assertEqual(self.emp.post('/api/payroll/fx/rates', body, content_type='application/json').status_code, 403)
        self.assertEqual(self.cfo.post('/api/payroll/fx/rates', body, content_type='application/json').status_code, 403)
        self.assertEqual(self.admin_stale.post('/api/payroll/fx/rates', body,
                                               content_type='application/json').status_code, 401)
        r = self.admin.post('/api/payroll/fx/rates', body, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()['reportingCurrency'], r.json()['rate']), ('INR', 83.25))
        # same day = update, not a duplicate
        r2 = self.admin.post('/api/payroll/fx/rates', dict(body, rate='84'), content_type='application/json')
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(ExchangeRate.objects.count(), 1)
        for bad in ({'currency': 'usd1'}, {'rate': '-1'}, {'rate': '0'}, {'rate': 'abc'}, {'rate': 'Infinity'},
                    {'asOf': 'tomorrow'}, {'currency': 'INR'}):
            self.assertEqual(self.admin.post('/api/payroll/fx/rates', dict(body, **bad),
                                             content_type='application/json').status_code, 400, bad)
        self.assertEqual(self.cfo.get('/api/payroll/fx/rates').status_code, 200)
        self.assertEqual(self.emp.get('/api/payroll/fx/rates').status_code, 403)
        rid = r.json()['id']
        self.assertEqual(self.admin_stale.delete(f'/api/payroll/fx/rates/{rid}').status_code, 401)
        self.assertEqual(self.admin.delete(f'/api/payroll/fx/rates/{rid}').status_code, 200)
        actions = set(PayrollAuditLog.objects.values_list('action', flat=True))
        self.assertTrue({'fx_rate_saved', 'fx_rate_deleted'} <= actions)

    def test_settings_and_fetch_off_by_default(self):
        self.assertEqual(self.admin.get('/api/payroll/fx/settings').json(), {'reportingCurrency': 'INR',
                                                                             'autoFetch': False})
        with mock.patch('requests.get') as g:
            r = self.admin.post('/api/payroll/fx/fetch', {}, content_type='application/json')
            self.assertEqual(r.status_code, 409)
            g.assert_not_called()
        self.assertEqual(self.admin.put('/api/payroll/fx/settings', {'reportingCurrency': 'usd'},
                                        content_type='application/json').json()['reportingCurrency'], 'USD')
        self.assertEqual(self.admin.put('/api/payroll/fx/settings', {'reportingCurrency': 'DOLLARS'},
                                        content_type='application/json').status_code, 400)
        self.assertEqual(self.cfo.put('/api/payroll/fx/settings', {'autoFetch': True},
                                      content_type='application/json').status_code, 403)

    def test_fetch_when_enabled_and_network_failure(self):
        PayrollSetting.objects.create(key='fx_auto_fetch', value='1')
        PayrollEntry.objects.create(run=PayrollRun.objects.create(period_label='x', period_start=date(2025, 1, 1),
                                                                  period_end=date(2025, 1, 31)),
                                    email='b@co.com', currency='USD')

        class Resp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'result': 'success', 'rates': {'INR': 1, 'USD': 0.0125, 'GBP': 'bad'}}

        with mock.patch('requests.get', return_value=Resp()) as g:
            r = self.admin.post('/api/payroll/fx/fetch', {}, content_type='application/json')
            self.assertEqual(r.status_code, 200, r.content)
            self.assertIn('timeout', g.call_args.kwargs)
        row = ExchangeRate.objects.get(currency='USD')
        self.assertEqual((row.rate, row.source), (Decimal('80.000000'), 'api'))
        import requests
        with mock.patch('requests.get', side_effect=requests.Timeout()):
            r = self.admin.post('/api/payroll/fx/fetch', {}, content_type='application/json')
            self.assertEqual(r.status_code, 502)

    def test_convert_endpoint_missing_rate_warning(self):
        r = self.cfo.get('/api/payroll/fx/convert?amount=10&from=USD&to=INR&date=2025-01-05').json()
        self.assertIsNone(r['converted'])
        self.assertIn('No USD→INR rate', r['warning'])
        rate('USD', 80, date(2025, 1, 1))
        r = self.cfo.get('/api/payroll/fx/convert?amount=10&from=USD&to=INR&date=2025-01-05').json()
        self.assertEqual(r['converted'], 800.0)

    def test_cfo_dashboard_consolidation_and_missing_rates(self):
        self.make_runs()
        rate('USD', 80, date(2025, 1, 1))
        rate('USD', 85, date(2025, 2, 15))
        self.assertEqual(self.emp.get('/api/payroll/fx/dashboard?year=2025').status_code, 403)
        d = self.cfo.get('/api/payroll/fx/dashboard?year=2025').json()
        self.assertEqual(d['reportingCurrency'], 'INR')
        jan, feb = d['months']
        self.assertEqual(jan['month'], '2025-01')
        self.assertEqual(jan['consolidated']['gross'], 100000 + 5000 * 80)
        self.assertEqual(jan['consolidated']['headcount'], 2)
        # February uses the latest rate on/before 28 Feb (85); GBP has no rate
        self.assertEqual(feb['consolidated']['gross'], 100000 + 5000 * 85)
        self.assertEqual(feb['consolidated']['employerCost'], 112000 + 5400 * 85)
        self.assertEqual(feb['missing'], ['GBP'])
        self.assertTrue(any('GBP' in w for w in d['warnings']))
        by_cur = {c['currency']: c for c in feb['byCurrency']}
        self.assertEqual((by_cur['GBP']['gross'], by_cur['GBP']['headcount']), (3000.0, 1))
        self.assertNotIn('z@co.com', str(d))                      # cancelled run ignored
        self.assertEqual(sum(1 for m in d['months'] for c in m['byCurrency'] if c['gross'] > 900000), 0)
        depts = {r['department']: r for r in d['byDepartment']}
        self.assertEqual(depts['Sales']['gross'], 5000 * 80 + 5000 * 85)
        countries = {r['country'] for r in d['byCountry']}
        self.assertEqual(countries, {'India', 'United States'})
        self.assertEqual(d['totals']['headcount'], 2)
        # a super admin sees it too; reporting currency override
        d2 = self.boss.get('/api/payroll/fx/dashboard?year=2025&currency=USD').json()
        self.assertEqual(d2['months'][0]['consolidated']['gross'], 5000 + 100000 / 80)
