"""Connected banking: payout batches (maker-checker + OTP), simulated bank,
signed webhooks, re-queue, ICICI hybrid encryption and integrations.

All outbound HTTP is mocked — no real bank is ever called.
"""
import hashlib
import hmac
import json
import os
import re
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest import mock

import jwt
from cryptography import x509
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from django.conf import settings
from django.test import Client, TestCase

from api.models import (ActionOtp, AppUser, ChannelDelivery, IntegrationSecret, PayoutBatch, PayoutTransaction,
                        PayrollAuditLog, PayrollEntry, PayrollPayment, PayrollRun, PayrollSetting, Permission, Role,
                        RolePermission, UserProfile, WebhookEvent)
from api.payroll_ext import banking, channels
from api.payroll_ext import security as sec

SECRETS = Fernet.generate_key().decode()
WEBHOOK_SECRET = 'whsec_' + 'k' * 32
API_KEY = 'icici-api-key-' + 'z' * 24
ACC1, ACC2, ACC_BAD = '123456789012', '998877665544', '55554444333'


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


def rsa_pair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'test')])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(datetime(2025, 1, 1))
            .not_valid_after(datetime(2035, 1, 1)).sign(key, hashes.SHA256()))
    return priv, cert.public_bytes(serialization.Encoding.PEM).decode()


OUR_PRIV, OUR_CERT = rsa_pair()
BANK_PRIV, BANK_CERT = rsa_pair()


class Mailbox:
    def __init__(self):
        self.codes = []

    def __call__(self, to=None, subject=None, html=None, text=None, sender_email=None):
        m = re.search(r'(\d{6})', text or '')
        self.codes.append((to, m.group(1) if m else None))
        return {'ok': True}

    def last(self, to):
        return [c for t, c in self.codes if t == to][-1]


def no_network(*a, **kw):
    raise AssertionError('network must not be called')


@mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS})
class BankingBase(TestCase):
    def setUp(self):
        self.mail = Mailbox()
        p = mock.patch('api.mailer.send_email', side_effect=self.mail)
        p.start()
        self.addCleanup(p.stop)
        for target in ('api.payroll_ext.banking.requests.post', 'api.payroll_ext.banking.requests.get',
                       'api.payroll_ext.channels.requests.post', 'api.payroll_ext.channels.requests.get'):
            q = mock.patch(target, side_effect=no_network)
            setattr(self, 'net_' + target.split('.')[2] + '_' + target.rsplit('.', 1)[1], q.start())
            self.addCleanup(q.stop)
        a = mock.patch.object(channels, 'RUN_ASYNC', False)
        a.start()
        self.addCleanup(a.stop)

        perms = {c: Permission.objects.create(code=c, name=c) for c in
                 ('payroll.payout.prepare', 'payroll.payout.release', 'payroll.integrations', 'payroll.manage')}
        maker_role = Role.objects.create(name='Payroll Admin')
        RolePermission.objects.create(role=maker_role, permission=perms['payroll.payout.prepare'])
        checker_role = Role.objects.create(name='HR Manager')
        RolePermission.objects.create(role=checker_role, permission=perms['payroll.payout.release'])
        both_role = Role.objects.create(name='Payroll Lead')
        for c in ('payroll.payout.prepare', 'payroll.payout.release'):
            RolePermission.objects.create(role=both_role, permission=perms[c])
        super_role = Role.objects.create(name='Super Admin')
        AppUser.objects.create(email='maker@co.com', full_name='Maker', password='x', role_ref=maker_role)
        AppUser.objects.create(email='checker@co.com', full_name='Checker', password='x', role_ref=checker_role)
        AppUser.objects.create(email='lead@co.com', full_name='Lead', password='x', role_ref=both_role)
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role_ref=super_role)
        AppUser.objects.create(email='plain@co.com', full_name='Plain', password='x', role='employee')
        self.maker = self.client_for('maker@co.com')
        self.checker = self.client_for('checker@co.com')
        self.lead = self.client_for('lead@co.com')
        self.boss = self.client_for('boss@co.com')
        self.plain = self.client_for('plain@co.com')
        self.maker_stale = Client(HTTP_X_USER_EMAIL='maker@co.com')
        self.checker_stale = Client(HTTP_X_USER_EMAIL='checker@co.com')

        self.run = PayrollRun.objects.create(period_label='2026-06', period_start=date(2026, 6, 1),
                                             period_end=date(2026, 6, 30), status='approved',
                                             total_net=Decimal('380000.00'), employee_count=3)
        self.pay1 = self.make_payment('asha@co.com', 'Asha Rao', '80000.00', ACC1, 'ICIC0001234')
        self.pay2 = self.make_payment('ravi@co.com', 'Ravi Kumar', '250000.00', ACC2, 'HDFC0004321')
        self.pay3 = self.make_payment('bad@co.com', 'Bad Data', '50000.00', ACC_BAD, 'XX12')
        UserProfile.objects.create(email='asha@co.com', first_name='Asha', phone='98765 43210')

    def client_for(self, email):
        return Client(HTTP_X_USER_EMAIL=email, HTTP_AUTHORIZATION='Bearer ' + token_for(email))

    def make_payment(self, email, name, amount, acc, ifsc, run=None):
        run = run or self.run
        e = PayrollEntry.objects.create(run=run, email=email, employee_name=name, net_pay=Decimal(amount))
        return PayrollPayment.objects.create(run=run, entry=e, email=email, employee_name=name, amount=Decimal(amount),
                                             account_number=acc, ifsc_or_routing=ifsc, status='pending')

    def post(self, client, url, body=None, **extra):
        return client.post(url, json.dumps(body or {}), content_type='application/json', **extra)

    def prepare(self, client=None, provider='simulated', **body):
        body.setdefault('provider', provider)
        return self.post(client or self.maker, f'/api/payroll/banking/runs/{self.run.id}/prepare', body)

    def otp(self, client, purpose, ref):
        return self.post(client, '/api/payroll/banking/otp', {'purpose': purpose, 'id': ref})

    def release(self, batch_id, client=None, email='checker@co.com'):
        client = client or self.checker
        r = self.otp(client, 'release', batch_id)
        self.assertEqual(r.status_code, 200, r.content)
        return self.post(client, f'/api/payroll/banking/batches/{batch_id}/release',
                         {'code': self.mail.last(email)})


class PrepareTests(BankingBase):
    def test_preview_lists_problems(self):
        r = self.maker.get(f'/api/payroll/banking/runs/{self.run.id}/preview')
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(len(d['eligible']), 2)
        self.assertEqual(d['problems'][0]['paymentId'], self.pay3.id)
        self.assertNotIn(ACC1, r.content.decode())

    def test_only_approved_run(self):
        self.run.status = 'pending_approval'
        self.run.save()
        r = self.prepare()
        self.assertEqual((r.status_code, r.json()['code']), (400, 'RUN_NOT_APPROVED'))

    def test_prepare_encrypts_and_flags_bad_data(self):
        r = self.prepare()
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertEqual(d['batch']['status'], 'awaiting_release')
        self.assertEqual(d['batch']['itemCount'], 2)
        self.assertEqual(d['batch']['totalAmount'], '330000.00')
        self.assertEqual([p['paymentId'] for p in d['problems']], [self.pay3.id])
        body = r.content.decode()
        self.assertNotIn(ACC1, body)
        self.assertNotIn(ACC2, body)
        t1 = PayoutTransaction.objects.get(payment_id=self.pay1.id)
        self.assertNotIn(ACC1, t1.account_enc)
        self.assertEqual(sec.unseal(t1.account_enc), ACC1)
        self.assertEqual(t1.account_last4, ACC1[-4:])
        self.assertEqual(t1.mode, 'NEFT')
        self.assertEqual(PayoutTransaction.objects.get(payment_id=self.pay2.id).mode, 'RTGS')
        self.assertNotEqual(t1.client_ref, PayoutTransaction.objects.get(payment_id=self.pay2.id).client_ref)
        for row in PayrollAuditLog.objects.values_list('changes', 'notes'):
            self.assertNotIn(ACC1, json.dumps(row))

    def test_duplicates_refused_and_idempotency_replay(self):
        r1 = self.prepare(idempotencyKey='key-run-0001')
        self.assertEqual(r1.status_code, 201)
        r2 = self.prepare(idempotencyKey='key-run-0001')
        self.assertEqual((r2.status_code, r2.json()['replayed']), (200, True))
        self.assertEqual(r2.json()['batch']['id'], r1.json()['batch']['id'])
        r3 = self.prepare()
        self.assertEqual((r3.status_code, r3.json()['code']), (409, 'ALREADY_PREPARED'))
        self.assertEqual(PayoutBatch.objects.count(), 1)

    def test_needs_permission_and_fresh_sign_in(self):
        self.assertEqual(self.prepare(self.plain).status_code, 403)
        self.assertEqual(self.prepare(self.checker).status_code, 403)
        r = self.prepare(self.maker_stale)
        self.assertEqual((r.status_code, r.json()['code']), (401, 'REAUTH_REQUIRED'))

    def test_disabled_bank_refused(self):
        r = self.prepare(provider='icici')
        self.assertEqual((r.status_code, r.json()['code']), (400, 'PROVIDER_DISABLED'))

    def test_fix_bank_details_with_otp(self):
        self.prepare()
        url = f'/api/payroll/banking/payments/{self.pay3.id}/bank-details'
        body = {'accountNumber': '111122223333', 'ifsc': 'SBIN0001111', 'bankName': 'SBI'}
        r = self.post(self.maker, url, body)
        self.assertEqual(r.json()['code'], 'OTP_REQUIRED')
        self.assertEqual(self.otp(self.maker, 'bank_update', self.pay3.id).status_code, 200)
        r = self.post(self.maker, url, dict(body, code=self.mail.last('maker@co.com')))
        self.assertEqual(r.status_code, 200, r.content)
        r = self.prepare()
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()['batch']['itemCount'], 1)


class ReleaseTests(BankingBase):
    def batch(self):
        return self.prepare().json()['batch']['id']

    def test_maker_cannot_release(self):
        bid = self.prepare(self.lead).json()['batch']['id']
        r = self.otp(self.lead, 'release', bid)
        self.assertEqual((r.status_code, r.json()['code']), (403, 'RELEASE_BLOCKED'))
        r = self.post(self.lead, f'/api/payroll/banking/batches/{bid}/release', {'code': '123456'})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(PayoutBatch.objects.get(id=bid).status, 'awaiting_release')

    def test_super_admin_self_release_needs_setting_and_single_admin(self):
        bid = self.prepare(self.boss).json()['batch']['id']
        self.assertEqual(self.otp(self.boss, 'release', bid).status_code, 403)
        PayrollSetting.objects.create(key='payout_allow_single_admin_self_release', value='true')
        self.assertEqual(self.otp(self.boss, 'release', bid).status_code, 200)
        AppUser.objects.create(email='boss2@co.com', full_name='Boss 2', password='x',
                               role_ref=Role.objects.get(name='Super Admin'))
        r = self.post(self.boss, f'/api/payroll/banking/batches/{bid}/release', {'code': self.mail.last('boss@co.com')})
        self.assertEqual(r.status_code, 403)

    def test_maker_role_has_no_release_right(self):
        bid = self.batch()
        self.assertEqual(self.otp(self.maker, 'release', bid).status_code, 403)

    def test_release_needs_fresh_sign_in(self):
        bid = self.batch()
        r = self.post(self.checker_stale, f'/api/payroll/banking/batches/{bid}/release', {'code': '123456'})
        self.assertEqual((r.status_code, r.json()['code']), (401, 'REAUTH_REQUIRED'))
        r = self.otp(self.checker_stale, 'release', bid)
        self.assertEqual(r.status_code, 401)

    def test_wrong_expired_and_consumed_codes(self):
        bid = self.batch()
        url = f'/api/payroll/banking/batches/{bid}/release'
        self.assertEqual(self.post(self.checker, url, {}).json()['code'], 'OTP_REQUIRED')
        self.assertEqual(self.post(self.checker, url, {'code': '000000'}).json()['code'], 'OTP_INVALID')  # none issued
        self.otp(self.checker, 'release', bid)
        good = self.mail.last('checker@co.com')
        wrong = '111111' if good != '111111' else '222222'
        r = self.post(self.checker, url, {'code': wrong})
        self.assertEqual((r.status_code, r.json()['code']), (400, 'OTP_INVALID'))
        ActionOtp.objects.filter(email='checker@co.com').update(expires_at=datetime.now() - timedelta(minutes=1))
        r = self.post(self.checker, url, {'code': good})
        self.assertIn('expired', r.json()['message'])
        # consumed: a fresh code used once cannot be used again
        ActionOtp.objects.filter(email='checker@co.com').update(created_at=datetime.now() - timedelta(minutes=5))
        self.otp(self.checker, 'release', bid)
        code = self.mail.last('checker@co.com')
        ActionOtp.objects.filter(email='checker@co.com', consumed=False).update(consumed=True)
        r = self.post(self.checker, url, {'code': code})
        self.assertEqual(r.json()['code'], 'OTP_INVALID')
        self.assertEqual(PayoutBatch.objects.get(id=bid).status, 'awaiting_release')

    def test_otp_rate_limited(self):
        bid = self.batch()
        self.assertEqual(self.otp(self.checker, 'release', bid).status_code, 200)
        self.assertEqual(self.otp(self.checker, 'release', bid).status_code, 429)

    def test_tamper_check_blocks_release(self):
        bid = self.batch()
        PayrollPayment.objects.filter(id=self.pay1.id).update(amount=Decimal('99999.00'))
        r = self.release(bid)
        self.assertEqual((r.status_code, r.json()['code']), (409, 'TAMPER_CHECK_FAILED'))
        self.assertEqual(PayoutBatch.objects.get(id=bid).status, 'awaiting_release')
        self.assertFalse(PayoutTransaction.objects.filter(status='sent').exists())

    def test_simulated_end_to_end_with_failure(self):
        bid = self.batch()
        r = self.release(bid)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['summary']['sent'], 2)
        self.assertEqual(set(PayoutTransaction.objects.values_list('status', flat=True)), {'sent'})
        self.assertEqual(PayrollPayment.objects.get(id=self.pay1.id).status, 'processing')
        # released twice → refused; never resent
        again = self.post(self.checker, f'/api/payroll/banking/batches/{bid}/release', {'code': '123456'})
        self.assertEqual(again.status_code, 409)
        t2 = PayoutTransaction.objects.get(payment_id=self.pay2.id)
        # settle is test-mode + integrations only
        self.assertEqual(self.post(self.checker, f'/api/payroll/banking/batches/{bid}/simulate-settle').status_code, 403)
        with self.captureOnCommitCallbacks(execute=True):
            r = self.post(self.boss, f'/api/payroll/banking/batches/{bid}/simulate-settle',
                          {'failures': {str(t2.id): 'ACCOUNT_FROZEN'}})
        self.assertEqual(r.status_code, 200, r.content)
        t1 = PayoutTransaction.objects.get(payment_id=self.pay1.id)
        t2.refresh_from_db()
        self.assertEqual(t1.status, 'success')
        self.assertTrue(t1.utr.startswith('SIMU'))
        self.assertEqual((t2.status, t2.failure_code), ('failed', 'ACCOUNT_FROZEN'))
        pm1 = PayrollPayment.objects.get(id=self.pay1.id)
        self.assertEqual((pm1.status, pm1.reference_number), ('successful', t1.utr))
        self.assertEqual(pm1.entry.payment_status, 'paid')
        pm2 = PayrollPayment.objects.get(id=self.pay2.id)
        self.assertEqual(pm2.status, 'failed')
        self.assertIn('ACCOUNT_FROZEN', pm2.failure_reason)
        self.assertEqual(PayoutBatch.objects.get(id=bid).status, 'partially_paid')
        alert = ChannelDelivery.objects.get(purpose='salary_credit', email='asha@co.com')
        self.assertEqual(alert.status, 'simulated')
        self.assertNotIn('98765', alert.recipient)
        self.net_banking_post.assert_not_called()

    def test_live_batch_cannot_be_simulated(self):
        bid = self.batch()
        PayoutBatch.objects.filter(id=bid).update(mode='live')
        r = self.post(self.boss, f'/api/payroll/banking/batches/{bid}/simulate-settle')
        self.assertEqual(r.status_code, 403)


class WebhookTests(BankingBase):
    def setUp(self):
        super().setUp()
        sec.set_secret('icici', {'api_key': API_KEY, 'webhook_secret': WEBHOOK_SECRET, 'debit_account': '000111222333',
                                 'client_private_key_pem': OUR_PRIV, 'bank_public_cert_pem': BANK_CERT},
                       mode='test', enabled=True, public={'base_url': 'https://bank.example', 'aggr_id': 'A',
                                                          'corp_id': 'C', 'user_id': 'U', 'urn': 'N'})
        bid = self.prepare(provider='icici').json()['batch']['id']
        r = self.release(bid)
        self.assertEqual(r.status_code, 200, r.content)
        self.bid = bid
        self.t1 = PayoutTransaction.objects.get(payment_id=self.pay1.id)

    def hook(self, body, secret=WEBHOOK_SECRET, ts=None, sig=None):
        raw = json.dumps(body).encode()
        ts = str(int(time.time()) if ts is None else ts)
        if sig is None:
            sig = hmac.new(secret.encode(), ts.encode() + b'.' + raw, hashlib.sha256).hexdigest()
        return Client().post('/api/payroll/banking/webhook/icici', raw, content_type='application/json',
                             HTTP_X_SIGNATURE=sig, HTTP_X_TIMESTAMP=ts)

    def event(self, eid='evt-1', status='SUCCESS', utr='ICIN260601234567'):
        return {'event_id': eid, 'events': [{'UNIQUEID': self.t1.client_ref, 'STATUS': status, 'UTRNUMBER': utr}]}

    def test_test_mode_never_calls_bank(self):
        self.net_banking_post.assert_not_called()
        self.assertEqual(self.t1.status, 'sent')
        self.assertTrue(self.t1.provider_ref.startswith('SIM'))

    def test_bad_signature_rejected(self):
        r = self.hook(self.event(), secret='wrong-secret-xxxxxxxx')
        self.assertEqual(r.status_code, 401)
        self.t1.refresh_from_db()
        self.assertEqual(self.t1.status, 'sent')
        # a forged call does not burn the real event id
        self.assertEqual(self.hook(self.event()).status_code, 200)
        self.t1.refresh_from_db()
        self.assertEqual(self.t1.status, 'success')

    def test_stale_and_missing_timestamp_rejected(self):
        self.assertEqual(self.hook(self.event(), ts=int(time.time()) - 600).status_code, 401)
        raw = json.dumps(self.event()).encode()
        sig = hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        r = Client().post('/api/payroll/banking/webhook/icici', raw, content_type='application/json', HTTP_X_SIGNATURE=sig)
        self.assertEqual(r.status_code, 401)

    def test_good_webhook_updates_and_replay_ignored(self):
        with self.captureOnCommitCallbacks(execute=True):
            r = self.hook(self.event())
        self.assertEqual(r.status_code, 200, r.content)
        self.t1.refresh_from_db()
        self.assertEqual((self.t1.status, self.t1.utr), ('success', 'ICIN260601234567'))
        self.assertIsNotNone(self.t1.debited_at)
        pm = PayrollPayment.objects.get(id=self.pay1.id)
        self.assertEqual((pm.status, pm.reference_number), ('successful', 'ICIN260601234567'))
        self.assertEqual(pm.entry.payment_reference, 'ICIN260601234567')
        r2 = self.hook(self.event(utr='FORGED'))
        self.assertTrue(r2.json().get('replay'))
        self.t1.refresh_from_db()
        self.assertEqual(self.t1.utr, 'ICIN260601234567')
        self.assertEqual(ChannelDelivery.objects.filter(purpose='salary_credit').count(), 1)

    def test_ip_allowlist(self):
        row = IntegrationSecret.objects.get(provider='icici')
        row.public_config = dict(row.public_config, webhook_ip_allowlist=['10.0.0.0/8'])
        row.save()
        self.assertEqual(self.hook(self.event()).status_code, 403)

    def test_failure_then_requeue_needs_otp_and_release(self):
        self.hook(self.event(status='FAILED', utr=''))
        self.t1.refresh_from_db()
        self.assertEqual(self.t1.status, 'failed')
        url = f'/api/payroll/banking/transactions/{self.t1.id}/requeue'
        new = {'accountNumber': '444455556666', 'ifsc': 'SBIN0009999', 'bankName': 'SBI'}
        self.assertEqual(self.post(self.maker, url, new).json()['code'], 'OTP_REQUIRED')
        self.assertEqual(self.post(self.maker_stale, url, new).status_code, 401)
        self.assertEqual(self.post(self.maker, url, dict(new, ifsc='BAD')).json()['code'], 'INVALID_BANK_DETAILS')
        self.assertEqual(self.otp(self.maker, 'requeue', self.t1.id).status_code, 200)
        r = self.post(self.maker, url, dict(new, code=self.mail.last('maker@co.com')))
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertNotIn('444455556666', r.content.decode())
        self.assertEqual(d['transaction']['attempt'], 2)
        self.assertEqual(d['batch']['status'], 'awaiting_release')
        self.assertTrue(d['batch']['isFollowUp'])
        self.t1.refresh_from_db()
        self.assertEqual(self.t1.status, 'requeued')
        t_new = PayoutTransaction.objects.get(id=d['transaction']['id'])
        self.assertEqual(sec.unseal(t_new.account_enc), '444455556666')
        # second re-queue of the same failure refused
        ActionOtp.objects.filter(email='maker@co.com').update(created_at=datetime.now() - timedelta(minutes=5))
        self.otp(self.maker, 'requeue', self.t1.id)
        r = self.post(self.maker, url, dict(new, code=self.mail.last('maker@co.com')))
        self.assertEqual(r.status_code, 409)
        # the follow-up batch needs a checker, not the maker
        self.assertEqual(self.otp(self.maker, 'release', d['batch']['id']).status_code, 403)
        ActionOtp.objects.filter(email='checker@co.com').update(created_at=datetime.now() - timedelta(minutes=5))
        r = self.release(d['batch']['id'])
        self.assertEqual(r.status_code, 200, r.content)
        t_new.refresh_from_db()
        self.assertEqual(t_new.status, 'sent')

    def test_reconciliation_view(self):
        self.hook(self.event(status='FAILED', utr=''))
        r = self.checker.get('/api/payroll/banking/reconciliation')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()['failures']), 1)
        self.assertTrue(r.json()['webhooks'][0]['signatureOk'])
        self.assertNotIn(WEBHOOK_SECRET, r.content.decode())
        self.assertEqual(self.plain.get('/api/payroll/banking/reconciliation').status_code, 403)

    def test_poll_in_test_mode_stays_pending(self):
        r = self.post(self.checker, f'/api/payroll/banking/batches/{self.bid}/poll')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['summary']['pending'], 2)
        self.net_banking_post.assert_not_called()


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


@mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS})
class IciciCryptoTests(TestCase):
    def test_round_trip_with_certificate(self):
        payload = {'UNIQUEID': 'HRP1', 'AMOUNT': '100.00', 'CREDITACC': ACC1}
        env = banking.hybrid_encrypt(payload, BANK_CERT)
        self.assertNotIn(ACC1, json.dumps(env))
        self.assertEqual(banking.hybrid_decrypt(env, BANK_PRIV), payload)

    def test_round_trip_oaep_and_aes128(self):
        env = banking.hybrid_encrypt({'a': 1}, BANK_CERT, rsa_padding='OAEP', key_bytes=16)
        self.assertEqual(banking.hybrid_decrypt(env, BANK_PRIV, rsa_padding='OAEP'), {'a': 1})
        with self.assertRaises(banking.ProviderError):
            banking.hybrid_decrypt(env, OUR_PRIV, rsa_padding='OAEP')   # wrong key

    def _provider(self, mode):
        cfg = {'api_key': API_KEY, 'debit_account': '000111222333', 'client_private_key_pem': OUR_PRIV,
               'client_cert_pem': OUR_CERT, 'bank_public_cert_pem': BANK_CERT}
        pub = {'base_url': 'https://bank.example', 'aggr_id': 'AG', 'corp_id': 'CO', 'user_id': 'US', 'urn': 'UR'}
        return banking.IciciCibProvider(cfg, pub, mode, True)

    def _txn(self):
        return PayoutTransaction(client_ref='HRPABC', amount=Decimal('1500.00'), ifsc='ICIC0001234', mode='NEFT',
                                 employee_name='Asha', account_enc=sec.seal(ACC1), account_last4=ACC1[-4:])

    def test_test_mode_never_calls_network(self):
        with mock.patch('api.payroll_ext.banking.requests.post', side_effect=no_network) as post:
            res = self._provider('test').initiate_transfer(self._txn())
            st = self._provider('test').fetch_status(self._txn())
        post.assert_not_called()
        self.assertEqual(res['status'], 'sent')
        self.assertEqual(st['status'], 'sent')

    def test_live_call_encrypts_uses_mtls_and_decrypts_response(self):
        seen = {}

        def fake_post(url, data=None, headers=None, cert=None, timeout=None, verify=None):
            env = json.loads(data)
            seen['request'] = banking.hybrid_decrypt(env, BANK_PRIV)       # bank side decrypts
            seen['cert'] = cert
            seen['exists'] = all(os.path.exists(p) for p in cert)
            seen['headers'], seen['timeout'], seen['url'] = headers, timeout, url
            reply = {'RESPONSE': 'SUCCESS', 'STATUS': 'PENDING', 'REQID': 'BANK-77', 'UNIQUEID': env and 'HRPABC'}
            return _Resp(200, banking.hybrid_encrypt(reply, OUR_CERT))      # bank encrypts for us

        with mock.patch('api.payroll_ext.banking.requests.post', side_effect=fake_post):
            res = self._provider('live').initiate_transfer(self._txn())
        self.assertEqual(res, {'provider_ref': 'BANK-77', 'status': 'sent', 'utr': '', 'debited_at': ''})
        self.assertEqual(seen['request']['CREDITACC'], ACC1)
        self.assertEqual(seen['request']['UNIQUEID'], 'HRPABC')
        self.assertEqual(seen['request']['TXNTYPE'], 'NFT')
        self.assertTrue(seen['exists'])
        self.assertFalse(any(os.path.exists(p) for p in seen['cert']))      # temp key files removed
        self.assertEqual(seen['headers']['apikey'], API_KEY)
        self.assertLessEqual(seen['timeout'], 10)
        self.assertTrue(seen['url'].startswith('https://bank.example/'))

    def test_live_rejection_is_definitive_failure_without_secrets(self):
        def fake_post(url, data=None, **kw):
            return _Resp(400, {'RESPONSE': 'FAILURE', 'STATUS': 'FAILED', 'ERRORCODE': 'INVALID_IFSC',
                               'MESSAGE': f'bad ifsc for {ACC1} key {API_KEY}'})
        with mock.patch('api.payroll_ext.banking.requests.post', side_effect=fake_post):
            with self.assertRaises(banking.ProviderError) as cm:
                self._provider('live').initiate_transfer(self._txn())
        self.assertEqual(cm.exception.code, 'INVALID_IFSC')
        self.assertNotIn(ACC1, cm.exception.reason)
        self.assertNotIn(API_KEY, cm.exception.reason)

    def test_validate_config(self):
        self._provider('test').validate_config()
        bad = banking.IciciCibProvider({'api_key': 'x'}, {}, 'test', True)
        with self.assertRaises(banking.ConfigError):
            bad.validate_config()

    def test_cert_paths_confined_to_cert_dir(self):
        with self.assertRaises(banking.ConfigError):
            banking._read_cert_path('../../etc/passwd.pem')


class IntegrationsTests(BankingBase):
    URL = '/api/payroll/banking/integrations'

    def save(self, client, provider, body):
        return client.put(f'{self.URL}/{provider}', json.dumps(body), content_type='application/json')

    def test_only_integrations_permission_with_fresh_sign_in(self):
        self.assertEqual(self.checker.get(self.URL).status_code, 403)
        self.assertEqual(self.save(self.maker, 'icici', {}).status_code, 403)
        stale = Client(HTTP_X_USER_EMAIL='boss@co.com')
        r = self.save(stale, 'icici', {'credentials': {'api_key': API_KEY}})
        self.assertEqual(r.json()['code'], 'REAUTH_REQUIRED')

    def test_secrets_never_returned(self):
        creds = {'api_key': API_KEY, 'webhook_secret': WEBHOOK_SECRET, 'debit_account': '000111222333',
                 'client_private_key_pem': OUR_PRIV, 'client_cert_pem': OUR_CERT, 'bank_public_cert_pem': BANK_CERT}
        public = {'base_url': 'https://bank.example', 'aggr_id': 'A', 'corp_id': 'C', 'user_id': 'U', 'urn': 'N'}
        bodies = []
        r = self.save(self.boss, 'icici', {'credentials': creds, 'public': public, 'mode': 'test', 'enabled': True})
        self.assertEqual(r.status_code, 200, r.content)
        bodies.append(r.content.decode())
        self.assertTrue(r.json()['integration']['configured'])
        r = self.post(self.boss, f'{self.URL}/icici/test')
        self.assertTrue(r.json()['ok'], r.content)
        bodies.append(r.content.decode())
        # blank fields keep the stored value
        r = self.save(self.boss, 'icici', {'credentials': {'api_key': ''}, 'mode': 'test', 'enabled': True})
        bodies.append(r.content.decode())
        self.assertEqual(sec.get_secret('icici')[0]['api_key'], API_KEY)
        bodies.append(self.boss.get(self.URL).content.decode())
        bodies.append(self.boss.get('/api/payroll/banking/meta').content.decode())
        self.assertEqual(self.prepare(provider='icici').status_code, 201)
        bid = PayoutBatch.objects.get().id
        bodies.append(self.release(bid).content.decode())
        bodies.append(self.checker.get(f'/api/payroll/banking/batches/{bid}').content.decode())
        bodies.append(self.checker.get('/api/payroll/banking/batches').content.decode())
        audit = json.dumps(list(PayrollAuditLog.objects.values('changes', 'notes')))
        for text in bodies + [audit]:
            for s in (API_KEY, WEBHOOK_SECRET, '000111222333', 'PRIVATE KEY', ACC1, ACC2):
                self.assertNotIn(s, text)
        self.assertNotIn(API_KEY, IntegrationSecret.objects.get(provider='icici').encrypted_config)

    def test_live_requires_valid_config_and_remove(self):
        r = self.save(self.boss, 'icici', {'credentials': {'api_key': API_KEY}, 'mode': 'live', 'enabled': True})
        self.assertEqual((r.status_code, r.json()['code']), (400, 'INVALID_CONFIG'))
        r = self.save(self.boss, 'twilio', {'credentials': {'account_sid': 'nope'}})
        self.assertEqual(r.status_code, 400)
        self.save(self.boss, 'slack', {'credentials': {'bot_token': 'xoxb-1-2', 'signing_secret': 's' * 32}})
        r = self.boss.delete(f'{self.URL}/slack')
        self.assertEqual(r.status_code, 200)
        self.assertFalse(IntegrationSecret.objects.filter(provider='slack').exists())

    def test_bad_public_values_rejected(self):
        r = self.save(self.boss, 'icici', {'credentials': {'api_key': API_KEY},
                                           'public': {'base_url': 'http://insecure'}})
        self.assertEqual(r.status_code, 400)
        r = self.save(self.boss, 'icici', {'credentials': {'api_key': API_KEY},
                                           'public': {'webhook_ip_allowlist': 'not-an-ip'}})
        self.assertEqual(r.status_code, 400)
