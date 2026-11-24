"""India tax: regime tables, compute_annual_tax, the TDS hook, declarations,
proofs, HR verification and permissions (api/payroll_ext/india_tax.py)."""
import base64
import json
import os
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest import mock

import jwt
from cryptography.fernet import Fernet
from django.conf import settings
from django.test import Client, TestCase

from api.models import (AppUser, EmployeeCompensation, EmployeeTaxDeclaration, PayrollAuditLog, PayrollEntry,
                        PayrollRun, PayrollTaxTable, Payslip, Permission, Role, RolePermission, TaxProofDocument)
from api.payroll_ext import india_tax as it
from api.payroll_ext import line_amount
from api.payroll_ext import security as sec

SECRETS = Fernet.generate_key().decode()
PDF = base64.b64encode(b'%PDF-1.4\n%test proof\n').decode()
PAN = 'ABCDE1234F'


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


def client(email, fresh=True):
    kw = {'HTTP_X_USER_EMAIL': email}
    if fresh:
        kw['HTTP_AUTHORIZATION'] = 'Bearer ' + token_for(email)
    return Client(**kw)


def call(c, method, url, body=None):
    fn = getattr(c, method.lower())
    if body is None:
        return fn(url)
    return fn(url, data=json.dumps(body), content_type='application/json')


def make_role(name, *codes):
    role = Role.objects.create(name=name)
    for code in codes:
        p, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.create(role=role, permission=p)
    return role


class Base(TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS})
        self.env.start()
        self.addCleanup(self.env.stop)
        verifier = make_role('Tax Verifier', 'payroll.tax.verify')
        admin = make_role('Payroll Admin X', 'payroll.tax.manage', 'payroll.tax.verify')
        AppUser.objects.create(email='emp@co.com', full_name='Emp One', password='x', role='employee')
        AppUser.objects.create(email='emp2@co.com', full_name='Emp Two', password='x', role='employee')
        AppUser.objects.create(email='hr@co.com', full_name='HR', password='x', role='employee', role_ref=verifier)
        AppUser.objects.create(email='padmin@co.com', full_name='PA', password='x', role='employee', role_ref=admin)
        self.emp, self.emp2 = client('emp@co.com'), client('emp2@co.com')
        self.hr, self.padmin = client('hr@co.com'), client('padmin@co.com')

    def today(self, d):
        p = mock.patch('api.payroll_ext.india_tax._today', return_value=d)
        p.start()
        self.addCleanup(p.stop)


# ── pure maths ────────────────────────────────────────────────────────────
class ComputeTaxTests(Base):
    def setUp(self):
        super().setUp()
        self.new = it.get_table('2026-27', 'new')
        self.old = it.get_table('2026-27', 'old')

    def total(self, income, table):
        return it.compute_annual_tax(income, table)['total']

    def test_new_regime_rebate_boundary(self):
        self.assertEqual(self.total(700000, self.new), 0)
        self.assertEqual(self.total(1200000, self.new), 0)
        r = it.compute_annual_tax(1210000, self.new)
        self.assertEqual(r['slab_tax'], 61500)
        self.assertEqual(r['marginal_relief_87a'], 51500)
        self.assertEqual(r['tax_after_rebate'], 10000)
        self.assertEqual(r['cess'], 400)
        self.assertEqual(r['total'], 10400)

    def test_new_regime_slabs_and_cess(self):
        self.assertEqual(self.total(1300000, self.new), 78000)        # 75,000 + 4 % cess
        self.assertEqual(self.total(1600000, self.new), 124800)       # 1,20,000 + 4 %
        r = it.compute_annual_tax(2325000, self.new)
        self.assertEqual(r['slab_tax'], 281250)
        self.assertEqual(r['total'], 292500)

    def test_old_regime(self):
        self.assertEqual(self.total(500000, self.old), 0)              # 87A
        self.assertEqual(self.total(600000, self.old), 33800)
        self.assertEqual(self.total(1000000, self.old), 117000)

    def test_surcharge_and_marginal_relief(self):
        r = it.compute_annual_tax(6000000, self.new)
        self.assertEqual(r['surcharge_rate'], 10)
        self.assertEqual(r['surcharge'], 138000)
        self.assertEqual(r['total'], 1578720)
        r = it.compute_annual_tax(5010000, self.new)                  # just above 50 L
        self.assertEqual(r['surcharge'], 7000)
        self.assertEqual(r['total'], 1133600)
        self.assertEqual(it.compute_annual_tax(60000000, self.old)['surcharge_rate'], 37)
        self.assertEqual(it.compute_annual_tax(60000000, self.old)['total'], 25379250)
        self.assertEqual(it.compute_annual_tax(60000000, self.new)['surcharge_rate'], 25)   # new regime capped

    def test_seed_idempotent_and_marked(self):
        it.seed_tax_tables('2026-27')
        it.seed_tax_tables('2026-27')
        rows = PayrollTaxTable.objects.filter(country='IN', period='2026-27')
        self.assertEqual(rows.count(), 2)
        self.assertTrue(all(r.notes == it.SEED_NOTE for r in rows))
        self.assertEqual(rows.get(kind='regime_new').data['standard_deduction'], 75000)

    def test_old_regime_deductions(self):
        d = EmployeeTaxDeclaration.objects.create(
            email='emp@co.com', fy='2026-27', regime='old',
            items=[{'id': 'a1', 'section': '80C', 'declared': 100000, 'verified': 40000},
                   {'id': 'a2', 'section': '80D', 'declared': 30000, 'verified': 30000}],
            hra={'monthly_rent': 25000, 'metro': True, 'verified_monthly_rent': 10000})
        annual = {'gross': 1200000, 'basic': 600000, 'hra': 240000, 'pf': 72000, 'pt': 2400}
        inc = it.income_breakdown(annual, 'old', self.old, d)
        self.assertEqual(inc['deductions']['80C'], 150000)               # capped incl. PF
        self.assertEqual(inc['deductions']['80D'], 25000)
        self.assertEqual(inc['hra_exemption'], 240000)                    # rent 3L − 10 % basic
        self.assertEqual(inc['taxable'], 732600)
        d.status = 'verified'                                             # verified amounts now count
        inc = it.income_breakdown(annual, 'old', self.old, d)
        self.assertEqual(inc['deductions']['80C'], 112000)
        self.assertEqual(inc['hra_exemption'], 60000)                     # 1.2 L − 60 k
        self.assertEqual(it.income_breakdown(annual, 'new', self.new, d)['taxable'], 1125000)


# ── TDS hook ──────────────────────────────────────────────────────────────
def pay_result(monthly=200000, currency='INR'):
    basic, hra = monthly / 2, monthly / 5
    return {'email': 'emp@co.com', 'currency': currency,
            'earnings_data': [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': basic},
                              {'code': 'HRA', 'label': 'HRA', 'amount': hra},
                              {'code': 'SPECIAL_ALLOWANCE', 'label': 'Special', 'amount': monthly - basic - hra}],
            'deductions_data': [{'code': 'PF', 'label': 'PF', 'amount': 1800},
                                {'code': 'TDS', 'label': 'TDS', 'amount': 999}],
            'employer_contributions_data': [{'code': 'GROSS_EARNING', 'label': 'GROSS', 'amount': monthly},
                                            {'code': 'EMPLOYER_PF', 'label': 'EPF', 'amount': 1800}],
            'gross_earnings': monthly, 'total_deductions': 2799, 'net_pay': monthly - 2799}


class TdsHookTests(Base):
    def test_replaces_tds_and_keeps_totals(self):
        r = it.apply_tds(pay_result(), {'email': 'emp@co.com', 'start': date(2026, 4, 1), 'run_id': None})
        tds = [l for l in r['deductions_data'] if l['code'] == 'TDS']
        self.assertEqual(len(tds), 1)
        self.assertEqual(tds[0]['label'], 'TDS / Income Tax')
        self.assertEqual(tds[0]['amount'], 24375)                     # 2,92,500 / 12
        self.assertEqual(r['total_deductions'], 1800 + 24375)
        self.assertEqual(r['net_pay'], 200000 - 1800 - 24375)
        self.assertEqual(r['employer_contribution'], 1800)
        self.assertEqual(r['total_ctc'], 201800)

    def test_uses_prior_payslips_and_tds_paid(self):
        run = PayrollRun.objects.create(period_label='2026-04', period_start=date(2026, 4, 1),
                                        period_end=date(2026, 4, 30), status='paid')
        prev = pay_result()
        prev['deductions_data'][1]['amount'] = 30000                 # over-deducted in April
        Payslip.objects.create(run=run, email='emp@co.com', earnings_data=prev['earnings_data'],
                               deductions_data=prev['deductions_data'])
        r = it.apply_tds(pay_result(), {'email': 'emp@co.com', 'start': date(2026, 5, 1), 'run_id': 999})
        self.assertEqual(line_amount(r, 'deductions_data', 'TDS'), Decimal('23864'))   # (292500−30000)/11
        cancelled = PayrollRun.objects.create(period_label='x', period_start=date(2026, 4, 1),
                                              period_end=date(2026, 4, 30), status='cancelled')
        Payslip.objects.create(run=cancelled, email='emp@co.com', earnings_data=prev['earnings_data'],
                               deductions_data=prev['deductions_data'])
        r = it.apply_tds(pay_result(), {'email': 'emp@co.com', 'start': date(2026, 5, 1), 'run_id': 999})
        self.assertEqual(line_amount(r, 'deductions_data', 'TDS'), Decimal('23864'))   # cancelled ignored

    def test_zero_tax_removes_line_and_non_inr_skipped(self):
        r = it.apply_tds(pay_result(80000), {'email': 'emp@co.com', 'start': date(2026, 4, 1)})
        self.assertFalse([l for l in r['deductions_data'] if l['code'] == 'TDS'])
        usd = pay_result(currency='USD')
        r = it.apply_tds(usd, {'email': 'emp@co.com', 'start': date(2026, 4, 1)})
        self.assertEqual(line_amount(r, 'deductions_data', 'TDS'), Decimal('999'))

    def test_never_raises(self):
        r = it.apply_tds({'currency': 'INR', 'earnings_data': 'garbage'}, {'email': 'x@co.com', 'start': 'bad'})
        self.assertEqual(r['earnings_data'], 'garbage')

    def test_old_regime_choice_is_used(self):
        EmployeeTaxDeclaration.objects.create(email='emp@co.com', fy='2026-27', regime='old')
        r = it.apply_tds(pay_result(), {'email': 'emp@co.com', 'start': date(2026, 4, 1)})
        p = it.project(pay_result(), 'emp@co.com', date(2026, 4, 1))
        self.assertEqual(p['regime'], 'old')
        self.assertEqual(line_amount(r, 'deductions_data', 'TDS'), Decimal(str(p['regimes']['old']['monthly_tds'])))


# ── declarations / regime ─────────────────────────────────────────────────
class DeclarationTests(Base):
    URL = '/api/me/tax/declaration'

    def test_default_view_and_validation(self):
        r = call(self.emp, 'GET', self.URL + '?fy=2026-27')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['regime'], 'new')
        self.assertIsNone(r.json()['id'])
        bad = [
            {'fy': '2026-27', 'items': [{'section': '80C', 'declared': -5}]},
            {'fy': '2026-27', 'items': [{'section': '80Z', 'declared': 5}]},
            {'fy': '2026-27', 'items': [{'section': '80C', 'declared': 5, 'hack': 1}]},
            {'fy': '2026-27', 'evil': 1},
            {'fy': '2026-2027'},
            {'fy': '2026-27', 'items': [{'section': '80C', 'declared': True}]},
        ]
        for b in bad:
            self.assertEqual(call(self.emp, 'PUT', self.URL, b).status_code, 400, b)
        self.assertEqual(call(Client(), 'GET', self.URL).status_code, 401)

    def test_landlord_pan_required_validated_and_never_returned(self):
        hra = {'monthly_rent': 10000, 'metro': True, 'landlord_name': 'Mr Landlord'}
        r = call(self.emp, 'PUT', self.URL, {'fy': '2026-27', 'hra': hra})
        self.assertEqual(r.status_code, 400)
        self.assertIn('PAN', r.json()['message'])
        r = call(self.emp, 'PUT', self.URL, {'fy': '2026-27', 'hra': dict(hra, landlord_pan='ABCD1234')})
        self.assertEqual(r.status_code, 400)
        r = call(self.emp, 'PUT', self.URL, {'fy': '2026-27', 'hra': dict(hra, landlord_pan=PAN.lower()),
                                             'items': [{'section': '80C', 'description': 'PPF', 'declared': 50000}]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn(PAN, r.content.decode())
        self.assertEqual(r.json()['hra']['landlord_pan'], sec.mask_pan(PAN))
        d = EmployeeTaxDeclaration.objects.get(email='emp@co.com')
        self.assertNotIn(PAN, d.landlord_pan_enc)
        self.assertEqual(sec.unseal(d.landlord_pan_enc), PAN)
        self.assertNotIn(PAN, json.dumps(d.hra))
        # keep the stored PAN when the masked value is sent back
        r = call(self.emp, 'PUT', self.URL, {'fy': '2026-27', 'hra': r.json()['hra']})
        self.assertEqual(r.status_code, 200, r.content)
        # rent under 1 L/yr needs no PAN
        r = call(self.emp2, 'PUT', self.URL, {'fy': '2026-27', 'hra': {'monthly_rent': 8000, 'landlord_name': 'X'}})
        self.assertEqual(r.status_code, 200)
        logs = json.dumps(list(PayrollAuditLog.objects.values('changes', 'notes')))
        self.assertNotIn(PAN, logs)
        self.assertTrue(PayrollAuditLog.objects.filter(action='tax_declaration_saved').exists())

    def test_regime_change_and_lock(self):
        r = call(self.emp, 'POST', '/api/me/tax/regime', {'fy': '2026-27', 'regime': 'old'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['regime'], 'old')
        self.assertTrue(PayrollAuditLog.objects.filter(action='tax_regime_changed', actor_email='emp@co.com').exists())
        self.assertEqual(call(self.emp, 'POST', '/api/me/tax/regime', {'fy': '2026-27', 'regime': 'x'}).status_code, 400)
        d = EmployeeTaxDeclaration.objects.get(email='emp@co.com')
        r = call(self.hr, 'POST', f'/api/payroll/tax/declarations/{d.id}/regime', {'regime_locked': True})
        self.assertEqual(r.status_code, 200)
        r = call(self.emp, 'POST', '/api/me/tax/regime', {'fy': '2026-27', 'regime': 'new'})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(EmployeeTaxDeclaration.objects.get(pk=d.pk).regime, 'old')
        # employees cannot use the HR endpoint
        r = call(self.emp, 'POST', f'/api/payroll/tax/declarations/{d.id}/regime', {'regime_locked': False})
        self.assertEqual(r.status_code, 403)

    def test_regime_locked_after_approved_run(self):
        run = PayrollRun.objects.create(period_label='2026-04', period_start=date(2026, 4, 1),
                                        period_end=date(2026, 4, 30), status='approved')
        PayrollEntry.objects.create(run=run, email='emp@co.com')
        r = call(self.emp, 'POST', '/api/me/tax/regime', {'fy': '2026-27', 'regime': 'old'})
        self.assertEqual(r.status_code, 409)
        r = call(self.emp, 'POST', '/api/me/tax/regime', {'fy': '2027-28', 'regime': 'old'})
        self.assertEqual(r.status_code, 200)


# ── proofs ────────────────────────────────────────────────────────────────
class ProofTests(Base):
    def setUp(self):
        super().setUp()
        self.today(date(2027, 1, 15))                                    # inside the default Jan–Feb window
        r = call(self.emp, 'PUT', '/api/me/tax/declaration',
                 {'fy': '2026-27', 'items': [{'section': '80C', 'description': 'PPF', 'declared': 50000}]})
        self.item = r.json()['items'][0]['id']

    def up(self, c=None, **kw):
        body = {'fy': '2026-27', 'item_id': self.item, 'file_name': 'ppf.pdf', 'mime': 'application/pdf', 'data': PDF}
        body.update(kw)
        return call(c or self.emp, 'POST', '/api/me/tax/proofs', body)

    def test_type_size_and_item_checks(self):
        self.assertEqual(self.up(mime='text/html').status_code, 400)
        self.assertEqual(self.up(mime='image/png').status_code, 400)                  # content ≠ type
        big = base64.b64encode(b'%PDF' + b'0' * (5 * 1024 * 1024 + 1)).decode()
        self.assertEqual(self.up(data=big).status_code, 400)
        self.assertEqual(self.up(item_id='nope').status_code, 400)
        r = self.up(file_name='../../etc/passwd.pdf')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertNotIn('/', r.json()['file_name'])
        self.assertNotIn('data', r.json())
        p = TaxProofDocument.objects.get()
        self.assertEqual(len(p.sha256), 64)

    def test_outside_window_refused(self):
        self.today(date(2026, 11, 19))
        r = self.up()
        self.assertEqual(r.status_code, 403)
        self.assertEqual(TaxProofDocument.objects.count(), 0)

    def test_window_configurable(self):
        self.assertEqual(call(self.emp, 'PUT', '/api/payroll/tax/window', {'start': '03-01', 'end': '03-31'}).status_code, 403)
        self.assertEqual(call(self.hr, 'PUT', '/api/payroll/tax/window', {'start': '13-01', 'end': '03-31'}).status_code, 400)
        r = call(self.hr, 'PUT', '/api/payroll/tax/window', {'start': '03-01', 'end': '03-31'})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()['open'])
        self.assertEqual(self.up().status_code, 403)

    def test_download_owner_or_verifier_only(self):
        pid = self.up().json()['id']
        url = f'/api/payroll/tax/proofs/{pid}/file'
        self.assertEqual(call(self.emp2, 'GET', url).status_code, 404)
        self.assertEqual(call(self.padmin, 'GET', url).status_code, 200)       # has tax.verify
        r = call(self.emp, 'GET', url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(base64.b64decode(r.json()['data'])[:4], b'%PDF')
        self.assertTrue(PayrollAuditLog.objects.filter(action='tax_proof_downloaded').exists())
        # list payloads never carry file contents
        d = EmployeeTaxDeclaration.objects.get(email='emp@co.com')
        r = call(self.hr, 'GET', f'/api/payroll/tax/declarations/{d.id}')
        self.assertNotIn(PDF, r.content.decode())
        # other employees cannot delete it
        self.assertEqual(call(self.emp2, 'DELETE', f'/api/me/tax/proofs/{pid}').status_code, 404)
        self.assertEqual(call(self.emp, 'DELETE', f'/api/me/tax/proofs/{pid}').status_code, 200)


# ── HR verification ───────────────────────────────────────────────────────
class VerifyTests(Base):
    def setUp(self):
        super().setUp()
        self.today(date(2027, 1, 15))
        r = call(self.emp, 'PUT', '/api/me/tax/declaration',
                 {'fy': '2026-27', 'items': [{'section': '80C', 'description': 'ELSS', 'declared': 60000}]})
        self.item = r.json()['items'][0]['id']
        self.d = EmployeeTaxDeclaration.objects.get(email='emp@co.com')

    def review(self, c, body):
        return call(c, 'POST', f'/api/payroll/tax/declarations/{self.d.id}/review', body)

    def test_flow(self):
        self.assertEqual(self.review(self.hr, {'decision': 'verified'}).status_code, 409)       # not submitted
        self.assertEqual(call(self.emp, 'POST', '/api/me/tax/submit', {'fy': '2026-27'}).status_code, 200)
        self.assertEqual(self.review(self.emp, {'decision': 'verified'}).status_code, 403)
        self.assertEqual(self.review(self.hr, {'items': [{'id': self.item, 'verified': 70000}],
                                               'decision': 'verified'}).status_code, 400)       # > declared
        self.assertEqual(self.review(self.hr, {'decision': 'verified'}).status_code, 400)      # no amount yet
        self.assertEqual(self.review(self.hr, {'items': [{'id': self.item, 'verified': 50000}], 'bogus': 1}).status_code, 400)
        r = self.review(self.hr, {'items': [{'id': self.item, 'verified': 50000}], 'decision': 'verified', 'note': 'ok'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'verified')
        r = call(self.hr, 'POST', f'/api/payroll/tax/declarations/{self.d.id}/lock', {'action': 'lock'})
        self.assertEqual(r.status_code, 200)
        d = EmployeeTaxDeclaration.objects.get(pk=self.d.pk)
        self.assertEqual(d.status, 'locked')
        self.assertTrue(d.regime_locked)
        r = call(self.emp, 'PUT', '/api/me/tax/declaration', {'fy': '2026-27', 'items': []})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(call(self.emp, 'POST', '/api/me/tax/regime', {'fy': '2026-27', 'regime': 'old'}).status_code, 409)
        for a in ('tax_declaration_submitted', 'tax_declaration_reviewed', 'tax_declaration_locked'):
            self.assertTrue(PayrollAuditLog.objects.filter(action=a).exists(), a)

    def test_cannot_verify_own_and_bulk_lock(self):
        EmployeeTaxDeclaration.objects.create(email='hr@co.com', fy='2026-27', status='verified')
        own = EmployeeTaxDeclaration.objects.get(email='hr@co.com')
        r = call(self.hr, 'POST', f'/api/payroll/tax/declarations/{own.id}/review', {'decision': 'rejected'})
        self.assertEqual(r.status_code, 403)
        EmployeeTaxDeclaration.objects.filter(pk=self.d.pk).update(status='verified')
        r = call(self.hr, 'POST', '/api/payroll/tax/declarations/lock-verified', {'fy': '2026-27'})
        self.assertEqual(r.json()['locked'], 1)                                  # own one skipped
        self.assertEqual(EmployeeTaxDeclaration.objects.get(pk=own.pk).status, 'verified')
        self.assertEqual(EmployeeTaxDeclaration.objects.get(pk=self.d.pk).status, 'locked')

    def test_list_permissions(self):
        self.assertEqual(call(self.emp, 'GET', '/api/payroll/tax/declarations?fy=2026-27').status_code, 403)
        r = call(self.hr, 'GET', '/api/payroll/tax/declarations?fy=2026-27')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()['results']), 1)


# ── tables ────────────────────────────────────────────────────────────────
class TableTests(Base):
    def test_get_and_edit(self):
        self.assertEqual(call(self.emp, 'GET', '/api/payroll/tax/tables?fy=2026-27').status_code, 403)
        r = call(self.hr, 'GET', '/api/payroll/tax/tables?fy=2026-27')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['tables']['regime_new']['seeded'])
        self.assertFalse(r.json()['can_edit'])
        data = r.json()['tables']['regime_new']['data']
        data['standard_deduction'] = 80000
        body = {'fy': '2026-27', 'kind': 'regime_new', 'data': data}
        self.assertEqual(call(self.hr, 'PUT', '/api/payroll/tax/tables', body).status_code, 403)
        r = call(self.padmin, 'PUT', '/api/payroll/tax/tables', body)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()['seeded'])
        self.assertEqual(it.get_table('2026-27', 'new')['standard_deduction'], 80000)
        self.assertTrue(PayrollAuditLog.objects.filter(action='tax_table_updated').exists())
        for broken in ({**data, 'slabs': [{'upto': 100, 'rate': 5}]},                         # last not open
                       {**data, 'slabs': [{'upto': 500, 'rate': 5}, {'upto': 100, 'rate': 5}, {'upto': None, 'rate': 1}]},
                       {**data, 'cess_pct': 200}, {**data, 'extra': 1},
                       {**data, 'section_limits': {'80Q': 1}}):
            r = call(self.padmin, 'PUT', '/api/payroll/tax/tables', {'fy': '2026-27', 'kind': 'regime_new', 'data': broken})
            self.assertEqual(r.status_code, 400, broken)
