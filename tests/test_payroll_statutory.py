"""Statutory files: EPFO ECR, ESIC, Form 24Q, Form 16 (api/payroll_ext/statutory.py)."""
import base64
import json
import os
from datetime import date
from unittest import mock

from cryptography.fernet import Fernet
from django.test import Client, TestCase

from api.models import (AppUser, EmployeeCompensation, EmployeeTaxDeclaration, PayrollAuditLog, PayrollEntry,
                        PayrollRun, PayrollSetting, Payslip, Role, StatutoryFiling)
from api.payroll_ext import security as sec
from api.payroll_ext import statutory as st
from tests.test_payroll_tax import call, client, make_role

SECRETS = Fernet.generate_key().decode()
UAN1, UAN2 = '100200300400', '100200300401'


def lines(basic, gross, pf, tds=0, extra=None):
    e = [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': basic},
         {'code': 'SPECIAL_ALLOWANCE', 'label': 'Special', 'amount': gross - basic}]
    d = [{'code': 'PF', 'label': 'PF', 'amount': pf}]
    if tds:
        d.append({'code': 'TDS', 'label': 'TDS', 'amount': tds})
    return e, d + (extra or [])


class Base(TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS})
        p.start()
        self.addCleanup(p.stop)
        role = make_role('Statutory Officer', 'payroll.statutory')
        AppUser.objects.create(email='stat@co.com', full_name='Stat', password='x', role='employee', role_ref=role)
        AppUser.objects.create(email='emp@co.com', full_name='Asha Rao', password='x', role='employee')
        AppUser.objects.create(email='emp2@co.com', full_name='Bala K', password='x', role='employee')
        AppUser.objects.create(email='emp3@co.com', full_name='Chitra M', password='x', role='employee')
        self.stat = client('stat@co.com')
        self.stat_stale = client('stat@co.com', fresh=False)
        self.emp = client('emp@co.com')
        EmployeeCompensation.objects.create(email='emp@co.com', uan_number=UAN1, pan_number='ABCDE1234F',
                                            employee_code='E1')
        EmployeeCompensation.objects.create(email='emp2@co.com', uan_number=UAN2, pan_number='BBCDE1234F',
                                            employee_code='E2')
        EmployeeCompensation.objects.create(email='emp3@co.com', uan_number='12345', employee_code='E3')

    def run_for(self, label, start, end, rows, status='approved'):
        run = PayrollRun.objects.create(period_label=label, period_start=start, period_end=end, status=status,
                                        pay_date=end)
        for email, name, basic, gross, pf, tds, lop in rows:
            e, d = lines(basic, gross, pf, tds)
            PayrollEntry.objects.create(run=run, email=email, employee_name=name, gross_earnings=gross,
                                        lop_days=lop, paid_days=30 - lop, earnings_data=e, deductions_data=d)
            Payslip.objects.create(run=run, email=email, employee_name=name, gross_earnings=gross, lop_days=lop,
                                   paid_days=30 - lop, earnings_data=e, deductions_data=d)
        return run

    def nov(self, with_bad=True):
        rows = [('emp@co.com', 'Asha Rao', 15000, 20000, 1800, 0, 2),
                ('emp2@co.com', 'Bala K', 30000, 50000, 3600, 2500, 0)]
        if with_bad:
            rows.append(('emp3@co.com', 'Chitra M', 10000, 18000, 1200, 0, 0))
        return self.run_for('2026-11', date(2026, 11, 1), date(2026, 11, 30), rows)


class EcrTests(Base):
    def test_line_format_caps_and_rounding(self):
        run = self.nov(with_bad=False)
        r = call(self.stat, 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id})
        self.assertEqual(r.status_code, 201, r.content)
        f = StatutoryFiling.objects.get(pk=r.json()['filing']['id'])
        got = f.content.strip().split('\n')
        self.assertEqual(got[0], f'{UAN1}#~#Asha Rao#~#20000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#2#~#0')
        self.assertEqual(got[1], f'{UAN2}#~#Bala K#~#50000#~#30000#~#15000#~#15000#~#3600#~#1250#~#2350#~#0#~#0')
        self.assertEqual(len(got[0].split('#~#')), 11)
        self.assertEqual(f.row_count, 2)
        self.assertEqual(f.sha256, sec.sha256_hex(f.content.encode()))
        self.assertNotIn('content', r.json()['filing'])

    def test_invalid_uan_reported_not_silently_filed(self):
        run = self.nov()
        r = call(self.stat, 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(len(r.json()['problems']), 1)
        self.assertIn('Chitra', r.json()['problems'][0]['name'])
        self.assertNotIn('12345', r.content.decode())                # masked
        self.assertEqual(StatutoryFiling.objects.count(), 0)
        r = call(self.stat, 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id, 'allow_partial': True})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(StatutoryFiling.objects.get().row_count, 2)

    def test_permissions_fresh_and_audit(self):
        run = self.nov(with_bad=False)
        self.assertEqual(call(self.emp, 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id}).status_code, 403)
        r = call(self.stat_stale, 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()['code'], 'REAUTH_REQUIRED')
        self.assertEqual(call(Client(), 'GET', '/api/payroll/statutory/filings').status_code, 401)
        fid = call(self.stat, 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id}).json()['filing']['id']
        url = f'/api/payroll/statutory/filings/{fid}/download'
        self.assertEqual(call(self.stat_stale, 'GET', url).status_code, 401)
        self.assertEqual(call(self.emp, 'GET', url).status_code, 403)
        r = call(self.stat, 'GET', url)
        self.assertEqual(r.status_code, 200)
        self.assertIn(UAN1, r.json()['content'])
        self.assertTrue(PayrollAuditLog.objects.filter(action='statutory_generated').exists())
        self.assertTrue(PayrollAuditLog.objects.filter(action='statutory_downloaded').exists())
        logs = json.dumps(list(PayrollAuditLog.objects.values('changes', 'notes')))
        self.assertNotIn(UAN1, logs)
        r = call(self.stat, 'GET', '/api/payroll/statutory/filings')
        self.assertEqual(len(r.json()['results']), 1)
        self.assertNotIn(UAN1, r.content.decode())
        self.assertEqual(call(self.stat, 'POST', '/api/payroll/statutory/ecr', {'run_id': 'x'}).status_code, 400)
        self.assertEqual(call(self.stat, 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id, 'z': 1}).status_code, 400)


class EsicTests(Base):
    def test_eligibility_and_ip_numbers(self):
        run = self.nov()
        r = call(self.stat, 'POST', '/api/payroll/statutory/esic', {'run_id': run.id})
        self.assertEqual(r.status_code, 422)                          # IP numbers missing
        self.assertEqual({p['email'] for p in r.json()['problems']}, {'emp@co.com', 'emp3@co.com'})
        self.assertEqual(call(self.stat, 'PUT', '/api/payroll/statutory/esic-ip',
                              {'email': 'emp@co.com', 'ip_number': '12'}).status_code, 400)
        for em, ip in (('emp@co.com', '1111111111'), ('emp3@co.com', '3333333333')):
            self.assertEqual(call(self.stat, 'PUT', '/api/payroll/statutory/esic-ip',
                                  {'email': em, 'ip_number': ip}).status_code, 200)
        r = call(self.stat, 'POST', '/api/payroll/statutory/esic', {'run_id': run.id})
        self.assertEqual(r.status_code, 201, r.content)
        f = StatutoryFiling.objects.get(kind='ESIC')
        rows = f.content.strip().split('\r\n')
        self.assertEqual(rows[0].split(',')[0], 'IP Number')
        self.assertEqual(rows[1], '1111111111,Asha Rao,28,20000,0,')
        self.assertEqual(len(rows), 3)                                # Bala (50,000) excluded
        self.assertNotIn('Bala', f.content)
        self.assertIn('emp2@co.com', [s['email'] for s in r.json()['skipped']])


class Form24QTests(Base):
    def setUp(self):
        super().setUp()
        self.run_for('2026-06', date(2026, 6, 1), date(2026, 6, 30), [('emp2@co.com', 'Bala K', 30000, 50000, 3600, 1000, 0)])
        self.run_for('2026-10', date(2026, 10, 1), date(2026, 10, 31), [('emp2@co.com', 'Bala K', 30000, 50000, 3600, 2080, 0)])
        self.run_for('2027-01', date(2027, 1, 1), date(2027, 1, 31), [('emp2@co.com', 'Bala K', 30000, 50000, 3600, 3000, 0),
                                                                     ('emp@co.com', 'Asha Rao', 15000, 20000, 1800, 0, 0)])
        self.run_for('2026-11x', date(2026, 11, 1), date(2026, 11, 30),
                     [('emp2@co.com', 'Bala K', 30000, 50000, 3600, 9999, 0)], status='cancelled')

    def test_quarter_selection(self):
        r = call(self.stat, 'POST', '/api/payroll/statutory/24q', {'fy': '2026-27', 'quarter': 3})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()['filings']), 1)
        self.assertIn('FVU', r.json()['fvu_note'])
        f = StatutoryFiling.objects.get(kind='24Q')
        self.assertEqual(f.period, 'Q3-2026-27')
        body = f.content.strip().split('\r\n')
        self.assertEqual(len(body), 2)                                # header + October only
        cols = body[1].split(',')
        self.assertEqual(cols[2], 'BBCDE1234F')
        self.assertEqual(cols[5], '31/10/2026')
        self.assertEqual(cols[8:13], ['2000', '0', '80', '2080', '2080'])
        self.assertEqual(st.quarter_range('2026-27', 4), (date(2027, 1, 1), date(2027, 3, 31)))
        self.assertEqual(call(self.stat, 'POST', '/api/payroll/statutory/24q', {'fy': '2026-27', 'quarter': 5}).status_code, 400)

    def test_q4_has_annexure_ii(self):
        r = call(self.stat, 'POST', '/api/payroll/statutory/24q', {'fy': '2026-27', 'quarter': 4})
        self.assertEqual(r.status_code, 201, r.content)
        names = [f['file_name'] for f in r.json()['filings']]
        self.assertTrue(any('AnnexureII' in n for n in names))
        a2 = StatutoryFiling.objects.get(file_name__contains='AnnexureII')
        self.assertEqual(a2.row_count, 2)                             # both employees with FY payslips
        self.assertIn('Opting out of 115BAC', a2.content)

    def test_annexure_ii_requires_landlord_pan(self):
        EmployeeTaxDeclaration.objects.create(email='emp2@co.com', fy='2026-27', regime='old', status='locked',
                                              hra={'monthly_rent': 40000, 'verified_monthly_rent': 40000})
        r = call(self.stat, 'POST', '/api/payroll/statutory/24q', {'fy': '2026-27', 'quarter': 4})
        self.assertEqual(r.status_code, 422)
        self.assertIn('landlord PAN', r.json()['problems'][0]['issue'])


class Form16Tests(Base):
    def test_part_b_and_part_a_upload(self):
        self.run_for('2026-04', date(2026, 4, 1), date(2026, 4, 30), [('emp2@co.com', 'Bala K', 30000, 50000, 3600, 1000, 0)])
        r = call(self.stat, 'POST', '/api/payroll/statutory/form16', {'fy': '2026-27', 'email': 'emp2@co.com'})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(any('TAN' in p['issue'] for p in r.json()['problems']))
        f = StatutoryFiling.objects.get(kind='FORM16')
        self.assertIn('PART B', f.content)
        self.assertEqual(f.email, 'emp2@co.com')
        self.assertEqual(call(self.stat, 'PUT', '/api/payroll/statutory/employer', {'tan': 'bad'}).status_code, 400)
        self.assertEqual(call(self.stat, 'PUT', '/api/payroll/statutory/employer', {'tan': 'blra12345b'}).status_code, 200)
        r = call(self.stat, 'POST', '/api/payroll/statutory/form16', {'fy': '2026-27', 'email': 'emp2@co.com'})
        self.assertEqual(r.json()['problems'], [])
        self.assertEqual(call(self.stat, 'POST', '/api/payroll/statutory/form16',
                              {'fy': '2026-27', 'email': 'emp@co.com'}).status_code, 404)
        png = base64.b64encode(b'\x89PNG....').decode()
        bad = {'fy': '2026-27', 'email': 'emp2@co.com', 'file_name': 'a.pdf', 'mime': 'image/png', 'data': png}
        self.assertEqual(call(self.stat, 'POST', '/api/payroll/statutory/form16/part-a', bad).status_code, 400)
        fake = dict(bad, mime='application/pdf')                      # PNG bytes labelled as PDF
        self.assertEqual(call(self.stat, 'POST', '/api/payroll/statutory/form16/part-a', fake).status_code, 400)
        ok = dict(bad, mime='application/pdf', data=base64.b64encode(b'%PDF-1.4 traces').decode())
        r = call(self.stat, 'POST', '/api/payroll/statutory/form16/part-a', ok)
        self.assertEqual(r.status_code, 201)
        # the employee sees (and with a fresh sign-in downloads) only their own forms
        e2 = client('emp2@co.com')
        r = call(e2, 'GET', '/api/me/tax/forms')
        self.assertEqual({x['kind'] for x in r.json()['results']}, {'FORM16', 'FORM16A'})
        fid = r.json()['results'][0]['id']
        self.assertEqual(call(e2, 'GET', f'/api/me/tax/forms/{fid}').status_code, 200)
        self.assertEqual(call(self.emp, 'GET', f'/api/me/tax/forms/{fid}').status_code, 404)
        self.assertEqual(call(client('emp2@co.com', fresh=False), 'GET', f'/api/me/tax/forms/{fid}').status_code, 401)


class EstimateTests(Base):
    def test_employee_estimate_and_hr_preview(self):
        EmployeeCompensation.objects.filter(email='emp2@co.com').update(base_amount=100000, annual_ctc=2400000)
        e2 = client('emp2@co.com')
        r = call(e2, 'GET', '/api/me/tax/estimate?fy=2026-27')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['available'])
        self.assertIn('old', r.json()['regimes'])
        self.assertIn('new', r.json()['regimes'])
        self.assertEqual(call(self.emp, 'GET', '/api/payroll/tax/preview?email=emp2@co.com').status_code, 403)
        hr = client('hrx@co.com')
        AppUser.objects.create(email='hrx@co.com', full_name='HRX', password='x', role='employee',
                               role_ref=make_role('HRX', 'payroll.tax.verify'))
        r = call(hr, 'GET', '/api/payroll/tax/preview?email=emp2@co.com&fy=2026-27')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn('BBCDE1234F', r.content.decode())
