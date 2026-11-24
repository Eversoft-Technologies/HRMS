"""Twilio SMS / WhatsApp salary alerts and Slack pay run approvals.
Every outbound call is mocked — Twilio and Slack are never contacted."""
import hashlib
import hmac
import json
import os
import time
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest import mock
from urllib.parse import urlencode

import jwt
from cryptography.fernet import Fernet
from django.conf import settings
from django.test import Client, TestCase

from api.models import (AppUser, ChannelDelivery, PayrollPayment, PayrollRun, PayrollSetting, Permission, Role,
                        RolePermission, UserProfile)
from api.payroll_ext import channels
from api.payroll_ext import security as sec

SECRETS = Fernet.generate_key().decode()
SID = 'AC' + 'a' * 32
TOKEN = 'twilio-auth-token-' + 'b' * 20
BOT = 'xoxb-1234-5678-' + 'c' * 20
SIGNING = 'd' * 32


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


def no_network(*a, **kw):
    raise AssertionError('network must not be called')


@mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS})
class ChannelBase(TestCase):
    def setUp(self):
        a = mock.patch.object(channels, 'RUN_ASYNC', False)
        a.start()
        self.addCleanup(a.stop)
        manage = Permission.objects.create(code='payroll.manage', name='Manage Payroll')
        Permission.objects.create(code='payroll.integrations', name='Integrations')
        fin = Role.objects.create(name='Finance Manager')
        RolePermission.objects.create(role=fin, permission=manage)
        Role.objects.create(name='Super Admin')
        AppUser.objects.create(email='fin@co.com', full_name='Fiona Fin', password='x', role_ref=fin)
        AppUser.objects.create(email='plain@co.com', full_name='Plain', password='x', role='employee')
        self.run = PayrollRun.objects.create(period_label='2026-06', period_start=date(2026, 6, 1),
                                             period_end=date(2026, 6, 30), status='pending_approval',
                                             total_net=Decimal('1234567.50'), total_gross=Decimal('1500000'),
                                             employee_count=12)
        UserProfile.objects.create(email='asha@co.com', first_name='Asha', phone='098765 43210')
        self.pm = PayrollPayment.objects.create(run=self.run, email='asha@co.com', employee_name='Asha Rao',
                                                amount=Decimal('85432.10'), status='successful')


class PhoneTests(TestCase):
    def test_normalise(self):
        n = channels.normalise_phone
        self.assertEqual(n('98765 43210'), '+919876543210')
        self.assertEqual(n('098765-43210'), '+919876543210')
        self.assertEqual(n('919876543210'), '+919876543210')
        self.assertEqual(n('+1 (415) 555-0100'), '+14155550100')
        self.assertEqual(n('0091 98765 43210'), '+919876543210')
        self.assertEqual(n('12345'), '')
        self.assertEqual(n(''), '')
        self.assertEqual(n('+911234567890'), '')     # Indian mobiles start 6–9

    def test_mask_and_amount(self):
        self.assertEqual(channels.mask_phone('+919876543210'), '+91••••••3210')
        self.assertEqual(channels.inr(Decimal('1234567.5')), '12,34,567.50')
        self.assertEqual(channels.inr(950), '950.00')


class TwilioTests(ChannelBase):
    def configure(self, mode='live', **public):
        public.setdefault('sms_from', '+14155550199')
        sec.set_secret('twilio', {'account_sid': SID, 'auth_token': TOKEN}, mode=mode, enabled=True, public=public)

    def test_salary_sms_sent_and_phone_masked(self):
        self.configure()
        with mock.patch('api.payroll_ext.channels.requests.post',
                        return_value=_Resp(201, {'sid': 'SM123'})) as post:
            out = channels.send_salary_credit_alert(self.pm, 'ICIN0001')
        self.assertEqual([d.status for d in out], ['sent'])
        args, kw = post.call_args
        self.assertIn(f'/Accounts/{SID}/Messages.json', args[0])
        self.assertEqual(kw['auth'], (SID, TOKEN))
        self.assertLessEqual(kw['timeout'], 10)
        self.assertEqual(kw['data']['To'], '+919876543210')
        self.assertEqual(kw['data']['Body'], 'Dear Asha, your salary of ₹85,432.10 for June 2026 has been processed. '
                                             'Reference: UTRICIN0001.')
        d = ChannelDelivery.objects.get()
        self.assertEqual((d.recipient, d.provider_ref, d.email), ('+91••••••3210', 'SM123', 'asha@co.com'))
        # idempotent per payment
        with mock.patch('api.payroll_ext.channels.requests.post', side_effect=no_network):
            self.assertEqual(channels.send_salary_credit_alert(self.pm, 'ICIN0001'), [])

    def test_whatsapp_template(self):
        self.configure(whatsapp_from='+14155550111', whatsapp_content_sid='HX' + 'e' * 32,
                       salary_channels=['whatsapp'])
        with mock.patch('api.payroll_ext.channels.requests.post', return_value=_Resp(201, {'sid': 'SM9'})) as post:
            channels.send_salary_credit_alert(self.pm, 'U1')
        data = post.call_args[1]['data']
        self.assertEqual((data['To'], data['From']), ('whatsapp:+919876543210', 'whatsapp:+14155550111'))
        self.assertEqual(json.loads(data['ContentVariables']), {'1': 'Asha', '2': '85,432.10', '3': 'June 2026', '4': 'U1'})
        self.assertNotIn('Body', data)

    def test_test_mode_and_unconfigured_are_simulated(self):
        with mock.patch('api.payroll_ext.channels.requests.post', side_effect=no_network):
            out = channels.send_salary_credit_alert(self.pm, 'X1')
            self.assertEqual(out[0].status, 'simulated')
            ChannelDelivery.objects.all().delete()
            self.configure(mode='test')
            out = channels.send_salary_credit_alert(self.pm, 'X1')
        self.assertEqual(out[0].status, 'simulated')
        self.assertNotIn('98765', out[0].recipient)

    def test_failure_logged_not_raised_and_scrubbed(self):
        self.configure()
        with mock.patch('api.payroll_ext.channels.requests.post',
                        return_value=_Resp(400, {'code': 21211, 'message': f'bad To {TOKEN}'})):
            out = channels.send_salary_credit_alert(self.pm, 'X')
        self.assertEqual(out[0].status, 'failed')
        self.assertNotIn(TOKEN, out[0].error)
        import requests
        ChannelDelivery.objects.all().delete()
        with mock.patch('api.payroll_ext.channels.requests.post', side_effect=requests.Timeout()):
            out = channels.send_salary_credit_alert(self.pm, 'X')
        self.assertEqual(out[0].status, 'failed')

    def test_opt_out(self):
        self.configure()
        PayrollSetting.objects.create(key='alerts_salary_optout', value='someone@co.com, ASHA@co.com')
        with mock.patch('api.payroll_ext.channels.requests.post', side_effect=no_network):
            out = channels.send_salary_credit_alert(self.pm, 'X')
        self.assertEqual(out[0].status, 'skipped')

    def test_test_connection_live_and_secret_not_returned(self):
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x',
                               role_ref=Role.objects.get(name='Super Admin'))
        boss = Client(HTTP_X_USER_EMAIL='boss@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('boss@co.com'))
        r = boss.put('/api/payroll/banking/integrations/twilio',
                     json.dumps({'credentials': {'account_sid': SID, 'auth_token': TOKEN}, 'mode': 'live',
                                 'enabled': True, 'public': {'sms_from': '+14155550199'}}),
                     content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        with mock.patch('api.payroll_ext.channels.requests.get', return_value=_Resp(200, {})) as get:
            r2 = boss.post('/api/payroll/banking/integrations/twilio/test')
        self.assertTrue(r2.json()['ok'])
        self.assertEqual(get.call_args[1]['auth'], (SID, TOKEN))
        for body in (r.content.decode(), r2.content.decode(), boss.get('/api/payroll/banking/integrations').content.decode()):
            self.assertNotIn(TOKEN, body)


class SlackSignatureTests(TestCase):
    def sign(self, body, ts, secret=SIGNING):
        return 'v0=' + hmac.new(secret.encode(), f'v0:{ts}:'.encode() + body, hashlib.sha256).hexdigest()

    def test_verify(self):
        body, ts = b'payload=%7B%7D', str(int(time.time()))
        self.assertTrue(channels.verify_slack_signature(SIGNING, ts, body, self.sign(body, ts)))
        self.assertFalse(channels.verify_slack_signature(SIGNING, ts, body + b'x', self.sign(body, ts)))
        self.assertFalse(channels.verify_slack_signature(SIGNING, ts, body, self.sign(body, ts, 'other' * 8)))
        old = str(int(time.time()) - 301)
        self.assertFalse(channels.verify_slack_signature(SIGNING, old, body, self.sign(body, old)))
        self.assertFalse(channels.verify_slack_signature('', ts, body, self.sign(body, ts)))


class SlackTests(ChannelBase):
    def setUp(self):
        super().setUp()
        sec.set_secret('slack', {'bot_token': BOT, 'signing_secret': SIGNING}, mode='live', enabled=True,
                       public={'team_id': 'T1'})

    def interact(self, action='payrun_approve', slack_user='U_FIN', ts=None, secret=SIGNING, team='T1'):
        payload = {'type': 'block_actions', 'team': {'id': team}, 'user': {'id': slack_user},
                   'response_url': 'https://hooks.slack.com/actions/T1/1/abc',
                   'actions': [{'action_id': action, 'value': str(self.run.id)}]}
        body = urlencode({'payload': json.dumps(payload)}).encode()
        ts = str(int(time.time()) if ts is None else ts)
        sig = 'v0=' + hmac.new(secret.encode(), f'v0:{ts}:'.encode() + body, hashlib.sha256).hexdigest()
        return Client().post('/api/payroll/alerts/slack/interact', body,
                             content_type='application/x-www-form-urlencoded',
                             HTTP_X_SLACK_REQUEST_TIMESTAMP=ts, HTTP_X_SLACK_SIGNATURE=sig)

    def users_info(self, email):
        def fake_get(url, params=None, headers=None, timeout=None):
            assert url.endswith('users.info') and headers['Authorization'] == 'Bearer ' + BOT
            return _Resp(200, {'ok': True, 'user': {'id': params['user'], 'profile': {'email': email}}})
        return fake_get

    def test_bad_or_stale_signature_rejected(self):
        with mock.patch('api.payroll_ext.channels.requests.get', side_effect=no_network), \
                mock.patch('api.payroll_ext.channels.requests.post', side_effect=no_network):
            self.assertEqual(self.interact(secret='x' * 32).status_code, 401)
            self.assertEqual(self.interact(ts=int(time.time()) - 400).status_code, 401)
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, 'pending_approval')

    def test_approve_by_permitted_user(self):
        with mock.patch('api.payroll_ext.channels.requests.get', side_effect=self.users_info('fin@co.com')), \
                mock.patch('api.payroll_ext.channels.requests.post', return_value=_Resp(200, {})) as post:
            r = self.interact()
        self.assertEqual(r.status_code, 200, r.content)
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, 'approved')          # finance_manager level = final sign-off
        approval = self.run.approvals.order_by('-id').first()
        self.assertEqual((approval.approver_email, approval.level), ('fin@co.com', 'finance_manager'))
        self.assertTrue(post.call_args[0][0].startswith('https://hooks.slack.com/'))
        self.assertIn('approved', json.loads(post.call_args[1]['data'])['text'])

    def test_reject(self):
        with mock.patch('api.payroll_ext.channels.requests.get', side_effect=self.users_info('fin@co.com')), \
                mock.patch('api.payroll_ext.channels.requests.post', return_value=_Resp(200, {})):
            self.interact(action='payrun_reject')
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, 'rejected')

    def test_user_without_permission_refused(self):
        with mock.patch('api.payroll_ext.channels.requests.get', side_effect=self.users_info('plain@co.com')), \
                mock.patch('api.payroll_ext.channels.requests.post', return_value=_Resp(200, {})) as post:
            r = self.interact(slack_user='U_PLAIN')
        self.assertEqual(r.status_code, 200)
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, 'pending_approval')
        self.assertIn('approval rights', json.loads(post.call_args[1]['data'])['text'])

    def test_unknown_slack_email_refused_and_wrong_team(self):
        with mock.patch('api.payroll_ext.channels.requests.get', side_effect=self.users_info('stranger@x.com')), \
                mock.patch('api.payroll_ext.channels.requests.post', return_value=_Resp(200, {})):
            self.interact()
            self.assertEqual(self.interact(team='T_OTHER').status_code, 403)
        self.run.refresh_from_db()
        self.assertEqual(self.run.status, 'pending_approval')

    def test_notify_sends_cards_to_matched_approvers(self):
        calls = []

        def fake_get(url, params=None, headers=None, timeout=None):
            if params['email'] == 'fin@co.com':
                return _Resp(200, {'ok': True, 'user': {'id': 'U_FIN'}})
            return _Resp(200, {'ok': False, 'error': 'users_not_found'})

        def fake_post(url, data=None, headers=None, timeout=None):
            calls.append(json.loads(data))
            return _Resp(200, {'ok': True, 'channel': 'D1', 'ts': '1.2'})

        with mock.patch('api.payroll_ext.channels.requests.get', side_effect=fake_get), \
                mock.patch('api.payroll_ext.channels.requests.post', side_effect=fake_post):
            out = channels.notify_payrun_submitted(self.run)
            again = channels.notify_payrun_submitted(self.run)     # de-duplicated
        self.assertEqual([(d.recipient, d.status) for d in out], [('U_FIN', 'sent')])
        self.assertEqual(again, [])
        self.assertEqual(calls[0]['channel'], 'U_FIN')
        actions = [b for b in calls[0]['blocks'] if b['type'] == 'actions'][0]['elements']
        self.assertEqual([a['action_id'] for a in actions[:2]], ['payrun_approve', 'payrun_reject'])

    def test_notify_simulated_in_test_mode_and_endpoint_permissions(self):
        sec.set_secret('slack', None, mode='test', enabled=True)
        with mock.patch('api.payroll_ext.channels.requests.get', side_effect=no_network), \
                mock.patch('api.payroll_ext.channels.requests.post', side_effect=no_network):
            plain = Client(HTTP_X_USER_EMAIL='plain@co.com')
            self.assertEqual(plain.post(f'/api/payroll/alerts/payrun/{self.run.id}/notify').status_code, 403)
            fin = Client(HTTP_X_USER_EMAIL='fin@co.com')
            r = fin.post(f'/api/payroll/alerts/payrun/{self.run.id}/notify')
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual([d['status'] for d in r.json()['deliveries']], ['simulated'])
            self.assertEqual(fin.post('/api/payroll/alerts/payrun/sweep').json()['announced'], 0)
            log = fin.get('/api/payroll/alerts/deliveries')
        self.assertEqual(log.status_code, 403)    # alerts log needs payout / integration rights
        self.assertNotIn(BOT, r.content.decode())
