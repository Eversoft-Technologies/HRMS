"""Encryption at rest + masking of sensitive identifiers (api/fields.py,
api/sensitive.py, manage.py encrypt_sensitive_fields)."""
import base64
import io
import json
import os
from datetime import date
from decimal import Decimal
from unittest import mock

from cryptography.fernet import Fernet
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test import TestCase

from api import fields as F
from api.models import (AppUser, BenchSalesProfile, EmployeeCompensation, OnboardingCandidate, PayrollAuditLog,
                        PayrollEntry, PayrollInformation, PayrollPayment, PayrollRun, Payslip, Role)
from api.secret_box import SecretsNotConfigured
from api.sensitive import is_masked_input, mask
from api.services.payroll_service import PayrollService
from tests.test_payroll_tax import call, client, make_role

KEY = Fernet.generate_key().decode()
PAN, UAN, PF, ACC = 'ABCDE1234F', '100200300400', 'TN/MAS/0012345/000/0000123', '50100234567890'
PASSPORT = 'N1234567'


def raw_get(model, pk, col):
    with connection.cursor() as cur:
        cur.execute(f'SELECT {connection.ops.quote_name(col)} FROM {connection.ops.quote_name(model._meta.db_table)} '
                    f'WHERE id = %s', [pk])
        return cur.fetchone()[0]


def raw_set(model, pk, col, value):
    with connection.cursor() as cur:
        cur.execute(f'UPDATE {connection.ops.quote_name(model._meta.db_table)} SET {connection.ops.quote_name(col)} = %s '
                    f'WHERE id = %s', [value, pk])


def run_cmd(*args):
    out = io.StringIO()
    call_command('encrypt_sensitive_fields', *args, stdout=out)
    return out.getvalue()


class Base(TestCase):
    def setUp(self):
        p = mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': KEY})
        p.start()
        self.addCleanup(p.stop)
        F._warned.clear()
        sup = Role.objects.create(name='Super Admin')
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role='admin', role_ref=sup)
        mgr = make_role('Payroll Manager', 'payroll.manage', 'payroll.view')
        AppUser.objects.create(email='pm@co.com', full_name='Pay Manager', password='x', role='employee', role_ref=mgr)
        stat = make_role('Statutory', 'payroll.statutory')
        AppUser.objects.create(email='stat@co.com', full_name='Stat', password='x', role='employee', role_ref=stat)
        AppUser.objects.create(email='emp@co.com', full_name='Asha Rao', password='x', role='employee')
        self.boss = client('boss@co.com')
        self.pm = client('pm@co.com')
        self.pm_stale = client('pm@co.com', fresh=False)
        self.emp = client('emp@co.com')
        self.comp = EmployeeCompensation.objects.create(
            email='emp@co.com', pan_number=PAN, uan_number=UAN, pf_account_number=PF, bank_account_number=ACC,
            bank_name='HDFC', ifsc_code='HDFC0001234', employee_code='E1', annual_ctc=Decimal('600000'),
            base_amount=Decimal('25000'), effective_from=date(2026, 1, 1))

    def make_run(self):
        run = PayrollRun.objects.create(period_label='2026-11', period_start=date(2026, 11, 1),
                                        period_end=date(2026, 11, 30), status='approved', pay_date=date(2026, 11, 30))
        e = [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': 15000},
             {'code': 'SPECIAL_ALLOWANCE', 'label': 'Special', 'amount': 5000}]
        d = [{'code': 'PF', 'label': 'PF', 'amount': 1800}]
        entry = PayrollEntry.objects.create(run=run, email='emp@co.com', employee_name='Asha Rao',
                                            gross_earnings=20000, net_pay=Decimal('18200'), paid_days=30,
                                            earnings_data=e, deductions_data=d)
        slip = Payslip.objects.create(run=run, email='emp@co.com', employee_name='Asha Rao', gross_earnings=20000,
                                      net_pay=Decimal('18200'), paid_days=30, earnings_data=e, deductions_data=d,
                                      pan_number=PAN, uan_number=UAN, pf_account_number=PF,
                                      bank_account_number=ACC, bank_name='HDFC', employee_code='E1')
        pay = PayrollPayment.objects.create(run=run, entry=entry, email='emp@co.com', employee_name='Asha Rao',
                                            amount=Decimal('18200'), account_number=ACC,
                                            ifsc_or_routing='HDFC0001234')
        return run, entry, slip, pay


class FieldTests(Base):
    def test_round_trip_stores_ciphertext(self):
        for col in ('pan_number', 'uan_number', 'pf_account_number', 'bank_account_number'):
            stored = raw_get(EmployeeCompensation, self.comp.pk, col)
            self.assertTrue(stored.startswith('enc1:'), col)
            self.assertNotIn(PAN, stored)
        c = EmployeeCompensation.objects.get(pk=self.comp.pk)
        self.assertEqual((c.pan_number, c.uan_number, c.pf_account_number, c.bank_account_number),
                         (PAN, UAN, PF, ACC))
        self.assertEqual(EmployeeCompensation.objects.values_list('pan_number', flat=True).get(pk=c.pk), PAN)

    def test_blank_stays_blank(self):
        c = EmployeeCompensation.objects.create(email='x@co.com')
        self.assertEqual(raw_get(EmployeeCompensation, c.pk, 'pan_number'), '')
        self.assertTrue(EmployeeCompensation.objects.filter(pk=c.pk, pan_number='').exists())

    def test_legacy_plain_value_is_read_as_is(self):
        raw_set(EmployeeCompensation, self.comp.pk, 'pan_number', 'PLAIN1234X')
        c = EmployeeCompensation.objects.get(pk=self.comp.pk)
        self.assertEqual(c.pan_number, 'PLAIN1234X')
        c.save()                                    # next save encrypts it
        self.assertTrue(raw_get(EmployeeCompensation, c.pk, 'pan_number').startswith('enc1:'))
        self.assertEqual(EmployeeCompensation.objects.get(pk=c.pk).pan_number, 'PLAIN1234X')

    def test_value_lookups_are_refused(self):
        with self.assertRaises(ValueError):
            list(EmployeeCompensation.objects.filter(pan_number=PAN))
        from django.core.exceptions import FieldError
        with self.assertRaises(FieldError):
            list(EmployeeCompensation.objects.filter(pan_number__icontains='ABC'))

    def test_copy_between_rows_keeps_value(self):
        run, entry, slip, pay = self.make_run()
        self.assertEqual(Payslip.objects.get(pk=slip.pk).bank_account_number, ACC)
        self.assertEqual(PayrollPayment.objects.get(pk=pay.pk).account_number, ACC)

    def test_masks(self):
        self.assertEqual(mask(PAN, 'pan'), 'AB•••••34F')
        self.assertEqual(mask('123456781234', 'aadhaar'), 'XXXX XXXX 1234')
        self.assertEqual(mask('123-45-6789', 'ssn'), '***-**-6789')
        self.assertEqual(mask(ACC, 'account'), '••••7890')
        self.assertEqual(mask(PASSPORT, 'passport'), '••••567')
        self.assertEqual(mask('', 'pan'), '')
        self.assertEqual(mask('12', 'account'), '••')
        self.assertTrue(is_masked_input('••••7890'))
        self.assertTrue(is_masked_input('AB•••••34F'))
        self.assertFalse(is_masked_input(PAN))


class MissingKeyTests(Base):
    """Encrypted rows exist; then the key disappears."""

    def no_key(self):
        p = mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': ''})
        p.start()
        self.addCleanup(p.stop)

    def test_reads_are_masked_and_lists_keep_working(self):
        raw_set(EmployeeCompensation, self.comp.pk, 'ifsc_code', 'HDFC0001234')
        legacy = EmployeeCompensation.objects.create(email='old@co.com')
        raw_set(EmployeeCompensation, legacy.pk, 'pan_number', 'OLDPA1234N')
        self.no_key()
        c = EmployeeCompensation.objects.get(pk=self.comp.pk)
        self.assertTrue(F.is_locked(c.pan_number))
        self.assertEqual(EmployeeCompensation.objects.get(pk=legacy.pk).pan_number, 'OLDPA1234N')
        r = call(self.boss, 'GET', '/api/payroll/compensations')
        self.assertEqual(r.status_code, 200)
        row = [x for x in r.json() if x['id'] == self.comp.pk][0]
        self.assertEqual(row['pan_number'], F.LOCKED_MASK)
        self.assertNotIn('enc1:', r.content.decode())
        with self.assertRaises(SecretsNotConfigured):
            F.plain(c.pan_number)

    def test_saving_a_locked_row_keeps_the_ciphertext(self):
        before = raw_get(EmployeeCompensation, self.comp.pk, 'pan_number')
        self.no_key()
        c = EmployeeCompensation.objects.get(pk=self.comp.pk)
        c.annual_ctc = Decimal('700000')
        c.save()
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), before)

    def test_writes_of_new_values_are_refused(self):
        self.no_key()
        from django.db import transaction
        with self.assertRaises(SecretsNotConfigured), transaction.atomic():
            EmployeeCompensation.objects.create(email='new@co.com', pan_number='NEWPA1234N')
        self.assertFalse(EmployeeCompensation.objects.filter(email='new@co.com').exists())
        before = raw_get(EmployeeCompensation, self.comp.pk, 'pan_number')
        with transaction.atomic():   # a real request runs in autocommit; keep the test transaction usable
            r = call(self.boss, 'PATCH', f'/api/payroll/compensations/{self.comp.pk}', {'pan_number': 'NEWPA1234N'})
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()['code'], 'SECRETS_NOT_CONFIGURED')
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), before)

    def test_exports_and_reveal_refuse_instead_of_leaking_ciphertext(self):
        run, entry, slip, pay = self.make_run()
        self.no_key()
        r = self.boss.get(f'/api/payroll/runs/{run.id}/export-neft-file')
        self.assertNotEqual(r.status_code, 200)
        self.assertNotIn('enc1:', r.content.decode())
        with self.assertRaises(SecretsNotConfigured):
            PayrollService.generate_payslip_pdf(Payslip.objects.get(pk=slip.pk))
        r = call(self.pm, 'POST', f'/api/sensitive/compensation/{self.comp.pk}/reveal', {'field': 'pan_number'})
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()['code'], 'SECRETS_NOT_CONFIGURED')


class MaskedApiTests(Base):
    def assert_no_full_values(self, r):
        body = r.content.decode()
        for v in (PAN, UAN, PF, ACC, PASSPORT, 'enc1:'):
            self.assertNotIn(v, body)

    def test_compensation_list_and_detail(self):
        r = call(self.boss, 'GET', '/api/payroll/compensations')
        self.assertEqual(r.status_code, 200)
        row = [x for x in r.json() if x['id'] == self.comp.pk][0]
        self.assertEqual(row['pan_number'], 'AB•••••34F')
        self.assertEqual(row['bank_account_number'], '••••7890')
        self.assertEqual(row['uan_number'], '••••0400')
        self.assertTrue(row['has_pan_number'])
        self.assert_no_full_values(r)
        r = call(self.boss, 'GET', f'/api/payroll/compensations/{self.comp.pk}')
        self.assertEqual(r.json()['pan_number'], 'AB•••••34F')
        self.assert_no_full_values(r)

    def test_payslips_runs_payments(self):
        run, entry, slip, pay = self.make_run()
        for url in ('/api/payroll/payslips', f'/api/payroll/payslips/{slip.pk}', f'/api/payroll/runs/{run.pk}',
                    '/api/payroll/runs', '/api/payroll/payments'):
            r = call(self.boss, 'GET', url)
            self.assertEqual(r.status_code, 200, url)
            self.assert_no_full_values(r)
        r = call(self.boss, 'GET', f'/api/payroll/payslips/{slip.pk}')
        self.assertEqual(r.json()['pan_number'], 'AB•••••34F')
        self.assertNotIn('file_data', r.json())
        pm = call(self.boss, 'GET', '/api/payroll/payments').json()
        self.assertEqual(pm[0]['account_number'], '••••7890')

    def test_employees_list(self):
        r = call(self.boss, 'POST', '/api/employees', {
            'fullName': 'Priya Sharma', 'email': 'priya@co.com', 'department': 'Eng', 'jobTitle': 'Dev',
            'annualCtc': '1200000', 'panNumber': 'PQRSX1234Z', 'bankAccountNumber': '99887766554433'})
        self.assertEqual(r.status_code, 201, r.content)
        comp = EmployeeCompensation.objects.filter(email='priya@co.com').first()
        self.assertEqual(comp.pan_number, 'PQRSX1234Z')
        r = call(self.boss, 'GET', '/api/employees')
        row = [x for x in r.json() if x['email'] == 'priya@co.com'][0]
        self.assertEqual(row['compensation']['panNumber'], 'PQ•••••34Z')
        self.assertEqual(row['compensation']['bankAccountNumber'], '••••4433')
        self.assertNotIn('PQRSX1234Z', r.content.decode())
        self.assertNotIn('99887766554433', r.content.decode())

    def test_bench_sales_masked_and_searchable_by_hash(self):
        b = BenchSalesProfile.objects.create(name='Ravi', passport_no=PASSPORT)
        self.assertTrue(raw_get(BenchSalesProfile, b.pk, 'passport_no').startswith('enc1:'))
        self.assertEqual(len(raw_get(BenchSalesProfile, b.pk, 'passport_no_hash')), 64)
        for url in ('/api/recruit/bench-sales', f'/api/recruit/bench-sales/{b.pk}'):
            r = call(self.boss, 'GET', url)
            self.assertEqual(r.status_code, 200)
            self.assert_no_full_values(r)
        self.assertEqual(call(self.boss, 'GET', f'/api/recruit/bench-sales/{b.pk}').json()['passportNo'], '••••567')
        found = call(self.boss, 'GET', '/api/recruit/bench-sales?search=n123-4567')     # normalised
        self.assertEqual([p['id'] for p in found.json()], [b.pk])
        found = call(self.boss, 'GET', '/api/recruit/bench-sales?search=N12345')         # partial: no match
        self.assertEqual(found.json(), [])

    def test_onboarding_payroll_detail_and_list(self):
        cand = OnboardingCandidate.objects.create(email='cand@co.com', first_name='Cand')
        info = PayrollInformation.objects.create(candidate=cand, bank_name='Chase', account_number='000123456789',
                                                 routing_number='021000021')
        self.assertTrue(raw_get(PayrollInformation, info.pk, 'account_number').startswith('enc1:'))
        r = call(self.boss, 'GET', f'/api/onboarding/candidates/{cand.pk}/payroll')
        self.assertEqual(r.json()['accountNumberMasked'], '••••6789')
        self.assertNotIn('000123456789', r.content.decode())
        r = call(self.boss, 'GET', '/api/onboarding/payroll')
        self.assertEqual(r.status_code, 200)
        self.assertNotIn('000123456789', r.content.decode())

    def test_audit_logs_scrubbed(self):
        PayrollAuditLog.objects.create(action='compensation_revised', entity_type='EmployeeCompensation',
                                       entity_id='1', actor_email='x', changes={'pan_number': PAN, 'ctc': 5})
        r = call(self.boss, 'GET', '/api/payroll/audit-logs')
        self.assertNotIn(PAN, r.content.decode())
        self.assertIn('AB•••••34F', r.content.decode())

    def test_compensation_update_audit_never_stores_identifier(self):
        r = call(self.boss, 'PATCH', f'/api/payroll/compensations/{self.comp.pk}',
                 {'pan_number': 'ZZZZZ9999Z', 'revision_reason': 'fix'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(EmployeeCompensation.objects.get(pk=self.comp.pk).pan_number, 'ZZZZZ9999Z')
        logs = json.dumps(list(PayrollAuditLog.objects.values('changes', 'notes')))
        self.assertNotIn('ZZZZZ9999Z', logs)


class MaskedInputTests(Base):
    def test_compensation_mask_posted_back_is_ignored(self):
        shown = call(self.boss, 'GET', f'/api/payroll/compensations/{self.comp.pk}').json()
        r = call(self.boss, 'PATCH', f'/api/payroll/compensations/{self.comp.pk}',
                 {'pan_number': shown['pan_number'], 'bank_account_number': shown['bank_account_number'],
                  'annual_ctc': '650000.00'})
        self.assertEqual(r.status_code, 200, r.content)
        c = EmployeeCompensation.objects.get(pk=self.comp.pk)
        self.assertEqual((c.pan_number, c.bank_account_number, c.annual_ctc), (PAN, ACC, Decimal('650000.00')))
        # full PUT of everything the client was shown
        body = {k: v for k, v in shown.items() if not k.startswith('has_') and v is not None
                and k not in ('id', 'structure_name', 'structure_code', 'employee_name', 'department',
                              'designation', 'created_at', 'updated_at')}
        r = call(self.boss, 'PUT', f'/api/payroll/compensations/{self.comp.pk}', body)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(EmployeeCompensation.objects.get(pk=self.comp.pk).uan_number, UAN)

    def test_overlong_or_ciphertext_input_rejected(self):
        r = call(self.boss, 'PATCH', f'/api/payroll/compensations/{self.comp.pk}', {'pan_number': 'A' * 30})
        self.assertEqual(r.status_code, 400)
        r = call(self.boss, 'PATCH', f'/api/payroll/compensations/{self.comp.pk}', {'pan_number': 'enc1:abc'})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(EmployeeCompensation.objects.get(pk=self.comp.pk).pan_number, PAN)

    def test_bench_mask_posted_back_is_ignored(self):
        b = BenchSalesProfile.objects.create(name='Ravi', passport_no=PASSPORT)
        r = call(self.boss, 'PUT', f'/api/recruit/bench-sales/{b.pk}', {'name': 'Ravi K', 'passportNo': '••••567'})
        self.assertEqual(r.status_code, 200, r.content)
        b.refresh_from_db()
        self.assertEqual((b.name, b.passport_no), ('Ravi K', PASSPORT))
        r = call(self.boss, 'PUT', f'/api/recruit/bench-sales/{b.pk}', {'passportNo': 'Z7654321'})
        b.refresh_from_db()
        self.assertEqual(b.passport_no, 'Z7654321')
        self.assertEqual(b.passport_no_hash, F.blind_index('Z7654321'))

    def test_onboarding_mask_posted_back_is_ignored(self):
        cand = OnboardingCandidate.objects.create(email='cand@co.com', first_name='Cand')
        PayrollInformation.objects.create(candidate=cand, bank_name='Chase', account_number='000123456789',
                                          routing_number='021000021', tax_state='TX')
        r = call(self.boss, 'PUT', f'/api/onboarding/candidates/{cand.pk}/payroll',
                 {'bankName': 'Chase', 'accountNumber': '••••6789', 'routingNumber': '021000021',
                  'taxState': 'TX', 'status': 'Completed'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(PayrollInformation.objects.get(candidate=cand).account_number, '000123456789')


class RevealTests(Base):
    URL = '/api/sensitive/compensation/{}/reveal'

    def test_requires_permission(self):
        r = call(self.emp, 'POST', self.URL.format(self.comp.pk), {'field': 'pan_number'})
        self.assertEqual(r.status_code, 403)

    def test_requires_fresh_sign_in(self):
        r = call(self.pm_stale, 'POST', self.URL.format(self.comp.pk), {'field': 'pan_number'})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()['code'], 'REAUTH_REQUIRED')

    def test_reveal_returns_value_and_audits_without_it(self):
        r = call(self.pm, 'POST', self.URL.format(self.comp.pk), {'field': 'panNumber'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['value'], PAN)
        self.assertEqual(r['Cache-Control'], 'no-store')
        log = PayrollAuditLog.objects.get(action='sensitive_value_revealed')
        self.assertEqual(log.actor_email, 'pm@co.com')
        self.assertEqual(log.entity_id, str(self.comp.pk))
        self.assertNotIn(PAN, json.dumps(log.changes) + log.notes)

    def test_bad_field_and_entity(self):
        self.assertEqual(call(self.pm, 'POST', self.URL.format(self.comp.pk), {'field': 'annual_ctc'}).status_code, 400)
        self.assertEqual(call(self.pm, 'POST', '/api/sensitive/nope/1/reveal', {'field': 'x'}).status_code, 404)
        self.assertEqual(call(self.pm, 'POST', self.URL.format(999999), {'field': 'pan_number'}).status_code, 404)

    def test_other_entities_use_their_own_permission(self):
        b = BenchSalesProfile.objects.create(name='Ravi', passport_no=PASSPORT)
        url = f'/api/sensitive/bench-sales/{b.pk}/reveal'
        self.assertEqual(call(self.pm, 'POST', url, {'field': 'passport_no'}).status_code, 403)
        rec = make_role('Recruiter', 'recruitment.edit')
        AppUser.objects.create(email='rec@co.com', full_name='Rec', password='x', role='employee', role_ref=rec)
        r = call(client('rec@co.com'), 'POST', url, {'field': 'passportNo'})
        self.assertEqual(r.json()['value'], PASSPORT)
        run, entry, slip, pay = self.make_run()
        r = call(self.pm, 'POST', f'/api/sensitive/payment/{pay.pk}/reveal', {'field': 'account_number'})
        self.assertEqual(r.json()['value'], ACC)


class ExportTests(Base):
    def test_neft_and_bank_file_contain_real_values(self):
        run, entry, slip, pay = self.make_run()
        r = self.boss.get(f'/api/payroll/runs/{run.id}/export-neft-file')
        self.assertEqual(r.status_code, 200)
        self.assertIn(ACC, r.content.decode())
        self.assertNotIn('enc1:', r.content.decode())
        r = self.boss.get(f'/api/payroll/runs/{run.id}/export-bank-file')
        self.assertIn(ACC, r.content.decode())
        self.assertIn(PAN, r.content.decode())

    def test_payslip_html_contains_real_values(self):
        run, entry, slip, pay = self.make_run()
        html = base64.b64decode(PayrollService.generate_payslip_pdf(Payslip.objects.get(pk=slip.pk))).decode()
        for v in (PAN, ACC, UAN, PF):
            self.assertIn(v, html)
        self.assertNotIn('enc1:', html)

    def test_ecr_contains_real_uan(self):
        run, entry, slip, pay = self.make_run()
        r = call(client('stat@co.com'), 'POST', '/api/payroll/statutory/ecr', {'run_id': run.id})
        self.assertEqual(r.status_code, 201, r.content)
        from api.models import StatutoryFiling
        self.assertTrue(StatutoryFiling.objects.get().content.startswith(UAN + '#~#'))


class CommandTests(Base):
    def legacy_rows(self):
        """Rows as they are in production today: plain text."""
        for col, v in (('pan_number', PAN), ('uan_number', UAN), ('pf_account_number', PF),
                       ('bank_account_number', ACC)):
            raw_set(EmployeeCompensation, self.comp.pk, col, v)
        b = BenchSalesProfile.objects.create(name='Ravi')
        raw_set(BenchSalesProfile, b.pk, 'passport_no', PASSPORT)
        return b

    def test_refuses_without_key(self):
        self.legacy_rows()
        with mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': ''}):
            with self.assertRaises(CommandError):
                run_cmd('--dry-run')
            with self.assertRaises(CommandError):
                run_cmd('--i-have-backed-up-the-key')
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), PAN)

    def test_refuses_without_backup_flag(self):
        self.legacy_rows()
        with self.assertRaises(CommandError):
            run_cmd()
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), PAN)

    def test_dry_run_writes_nothing_and_prints_fingerprint(self):
        b = self.legacy_rows()
        out = run_cmd('--dry-run')
        self.assertIn(F.key_fingerprint(), out)
        self.assertIn('BACK UP THE KEY', out)
        self.assertIn('api.EmployeeCompensation.pan_number', out)
        self.assertIn('would change=1', out)
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), PAN)
        self.assertEqual(raw_get(BenchSalesProfile, b.pk, 'passport_no'), PASSPORT)
        self.assertEqual(raw_get(BenchSalesProfile, b.pk, 'passport_no_hash'), '')

    def test_encrypts_idempotently_and_fills_hash(self):
        b = self.legacy_rows()
        run_cmd('--i-have-backed-up-the-key')
        for col, v in (('pan_number', PAN), ('uan_number', UAN), ('pf_account_number', PF),
                       ('bank_account_number', ACC)):
            stored = raw_get(EmployeeCompensation, self.comp.pk, col)
            self.assertTrue(stored.startswith('enc1:'))
            self.assertEqual(getattr(EmployeeCompensation.objects.get(pk=self.comp.pk), col), v)
        self.assertEqual(raw_get(BenchSalesProfile, b.pk, 'passport_no_hash'), F.blind_index(PASSPORT))
        snapshot = raw_get(EmployeeCompensation, self.comp.pk, 'pan_number')
        out = run_cmd('--i-have-backed-up-the-key')
        self.assertIn('Changed 0 value(s)', out)
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), snapshot)
        found = call(self.boss, 'GET', f'/api/recruit/bench-sales?search={PASSPORT}')
        self.assertEqual([p['id'] for p in found.json()], [b.pk])

    def test_verify_before_commit_rolls_back(self):
        self.legacy_rows()
        real = Fernet(KEY.encode())

        class Liar:
            def encrypt(self, data):
                return real.encrypt(b'WRONG')

            def decrypt(self, token):
                return real.decrypt(token)

        with mock.patch('api.fields._key_fernet', return_value=Liar()):
            with self.assertRaises(CommandError):
                run_cmd('--i-have-backed-up-the-key')
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), PAN)

    def test_refuses_narrow_column(self):
        self.legacy_rows()
        with mock.patch('api.fields.column_width', return_value=20):
            with self.assertRaises(CommandError):
                run_cmd('--i-have-backed-up-the-key')
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), PAN)

    def test_reports_values_from_another_key(self):
        raw_set(EmployeeCompensation, self.comp.pk, 'pan_number',
                'enc1:' + Fernet(Fernet.generate_key()).encrypt(b'X').decode())
        out = run_cmd('--dry-run')
        self.assertIn('undecryptable=1', out)
        self.assertIn('do NOT decrypt', out)

    def test_decrypt_rollback(self):
        b = self.legacy_rows()
        run_cmd('--i-have-backed-up-the-key')
        with self.assertRaises(CommandError):
            run_cmd('--decrypt')
        run_cmd('--decrypt', '--i-have-backed-up-the-key')
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'pan_number'), PAN)
        self.assertEqual(raw_get(EmployeeCompensation, self.comp.pk, 'bank_account_number'), ACC)
        self.assertEqual(raw_get(BenchSalesProfile, b.pk, 'passport_no'), PASSPORT)


class WidthGuardTests(Base):
    def test_save_refuses_when_column_not_migrated(self):
        c = EmployeeCompensation.objects.get(pk=self.comp.pk)
        fld = EmployeeCompensation._meta.get_field('pan_number')
        fake = mock.Mock(vendor='mysql', alias='default')
        with mock.patch('api.fields.column_width', return_value=20):
            with self.assertRaises(F.ColumnTooNarrow):
                fld.get_db_prep_save(c.pan_number, fake)
