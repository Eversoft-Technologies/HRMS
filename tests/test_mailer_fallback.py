"""Resend → SMTP fallback in api.mailer.send_email (no network: all mocked)."""
from unittest import mock

from django.test import SimpleTestCase

from api import mailer

RESEND = {'type': 'resend', 'api_key': 'k', 'from_name': 'HRMS', 'from_email': 'no-reply@x.com'}
SMTP = {'type': 'smtp', 'host': 'smtp.x.com', 'port': 587, 'user': 'u', 'password': 'p', 'secure': False,
        'from_name': 'HRMS', 'from_email': 'u@x.com'}


def resend_reply(status, body):
    r = mock.Mock(ok=200 <= status < 300, status_code=status, text=str(body))
    r.json.return_value = body
    return r


class FallbackTests(SimpleTestCase):
    def send(self, resend_resp, smtp_result=None, smtp_cfg=SMTP):
        with mock.patch.object(mailer, 'get_email_settings', return_value=RESEND), \
             mock.patch.object(mailer, 'get_smtp_settings', return_value=smtp_cfg), \
             mock.patch.object(mailer.requests, 'post', return_value=resend_resp), \
             mock.patch.object(mailer, '_send_via_smtp', return_value=smtp_result or {'ok': True}) as smtp:
            return mailer.send_email('a@b.com', 'Hi', html='<p>x</p>'), smtp

    def test_daily_quota_falls_back_to_smtp(self):
        res, smtp = self.send(resend_reply(429, {'name': 'daily_quota_exceeded',
                                                 'message': 'You have reached your daily email sending quota.'}))
        self.assertTrue(res['ok'])
        smtp.assert_called_once()

    def test_rate_limit_falls_back_to_smtp(self):
        res, smtp = self.send(resend_reply(429, {'name': 'rate_limit_exceeded', 'message': 'Too many requests'}))
        self.assertTrue(res['ok'])
        smtp.assert_called_once()

    def test_both_failing_reports_both_reasons(self):
        res, _ = self.send(resend_reply(429, {'name': 'daily_quota_exceeded', 'message': 'quota'}),
                           smtp_result={'ok': False, 'error': 'SMTPAuthenticationError: bad password'})
        self.assertFalse(res['ok'])
        self.assertIn('daily_quota_exceeded', res['error'])
        self.assertIn('bad password', res['error'])

    def test_quota_without_smtp_keeps_resend_reason(self):
        res, smtp = self.send(resend_reply(429, {'name': 'daily_quota_exceeded', 'message': 'quota'}), smtp_cfg=None)
        self.assertFalse(res['ok'])
        self.assertIn('daily_quota_exceeded', res['error'])
        smtp.assert_not_called()

    def test_other_resend_errors_do_not_fall_back(self):
        res, smtp = self.send(resend_reply(422, {'name': 'invalid_to', 'message': 'bad address'}))
        self.assertFalse(res['ok'])
        smtp.assert_not_called()

    def test_success_needs_no_fallback(self):
        res, smtp = self.send(resend_reply(200, {'id': 'x'}))
        self.assertTrue(res['ok'])
        smtp.assert_not_called()
