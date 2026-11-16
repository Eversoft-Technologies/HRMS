"""A valid Anthropic key whose organization has no API credit gets a clear
message (billing, not a broken key) instead of the raw upstream 400."""
from unittest import mock

from django.test import SimpleTestCase

from api import ai, ai_settings


class Resp:
    def __init__(self, status, payload):
        self.status_code, self._p, self.ok, self.text = status, payload, status < 400, str(payload)

    def json(self):
        return self._p


NO_CREDIT = {'type': 'error', 'error': {'type': 'invalid_request_error',
             'message': 'Your credit balance is too low to access the Anthropic API. '
                        'Please go to Plans & Billing to upgrade or purchase credits.'}}


class NoCreditTests(SimpleTestCase):
    def test_key_test_explains_missing_credit(self):
        with mock.patch('api.ai_settings.requests.post', return_value=Resp(400, NO_CREDIT)):
            ok, msg = ai_settings.test_key('sk-ant-api03-x')
        self.assertFalse(ok)
        self.assertIn('Anthropic accepted this key', msg)
        self.assertIn('no API credit', msg)
        self.assertNotIn('Anthropic API error 400', msg)

    def test_other_400s_keep_the_upstream_detail(self):
        r = Resp(400, {'error': {'message': 'max_tokens: must be positive'}})
        self.assertEqual(ai._upstream_error(r), 'Anthropic API error 400: max_tokens: must be positive')
