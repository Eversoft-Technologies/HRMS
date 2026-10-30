"""Server-managed AI key: Settings > AI Settings.

Covers access control (view / manage permissions, fresh sign-in token for
changes), validation before activation, rotation, removal with fallback, the
audit trail, the ignored x-api-key header, and that the key never appears in
any response, audit row or log line.
"""
import logging
import os
from datetime import datetime, timedelta
from unittest import mock

import jwt
from cryptography.fernet import Fernet
from django.conf import settings
from django.test import Client, TestCase

from api import ai
from api.models import AIProviderSetting, AISettingsAudit, AppUser, Permission, Role, RolePermission

GOOD = 'sk-ant-api03-GOODKEY-' + 'a' * 40
GOOD2 = 'sk-ant-api03-SECONDKEY-' + 'b' * 40
BAD = 'sk-ant-api03-BADKEY-' + 'c' * 40
ENV_KEY = 'sk-ant-api03-ENVKEY-' + 'd' * 40
SECRETS = Fernet.generate_key().decode()


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


class FakeResp:
    def __init__(self, status):
        self.status_code = status
        self.ok = status < 400
        self.text = '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'
        self.headers = {}

    def json(self):
        return {'error': {'type': 'authentication_error', 'message': 'invalid x-api-key'}}


def fake_post(url, headers=None, json=None, timeout=None):
    return FakeResp(200 if headers.get('x-api-key') in (GOOD, GOOD2, ENV_KEY) else 401)


@mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS, 'ANTHROPIC_API_KEY': '', 'VITE_ANTHROPIC_API_KEY': ''})
@mock.patch('api.ai_settings.requests.post', side_effect=fake_post)
class AISettingsTests(TestCase):
    def setUp(self):
        ai.reset_status_cache()
        view = Permission.objects.create(code='ai.settings.view', name='View AI Settings')
        Permission.objects.create(code='ai.settings.manage', name='Manage AI Settings')
        gen = Permission.objects.create(code='settings.manage', name='Manage Settings')
        viewer_role = Role.objects.create(name='AI Viewer')
        RolePermission.objects.create(role=viewer_role, permission=view)
        hr_role = Role.objects.create(name='HR Manager')
        RolePermission.objects.create(role=hr_role, permission=gen)
        super_role = Role.objects.create(name='Super Admin')

        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role_ref=super_role)
        AppUser.objects.create(email='viewer@co.com', full_name='Viewer', password='x', role_ref=viewer_role)
        AppUser.objects.create(email='hr@co.com', full_name='HR', password='x', role_ref=hr_role)

        self.boss = Client(HTTP_X_USER_EMAIL='boss@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('boss@co.com'))
        self.boss_no_token = Client(HTTP_X_USER_EMAIL='boss@co.com')
        self.viewer = Client(HTTP_X_USER_EMAIL='viewer@co.com',
                             HTTP_AUTHORIZATION='Bearer ' + token_for('viewer@co.com'))
        self.hr = Client(HTTP_X_USER_EMAIL='hr@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('hr@co.com'))

    def put_key(self, client, key):
        return client.put('/api/ai/settings/key', {'apiKey': key}, content_type='application/json')

    # ---- access ---------------------------------------------------------
    def test_metadata_needs_ai_view_permission(self, _post):
        self.assertEqual(Client().get('/api/ai/settings').status_code, 401)
        self.assertEqual(self.hr.get('/api/ai/settings').status_code, 403)   # general settings != AI settings
        r = self.viewer.get('/api/ai/settings')
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body['provider'], body['configured'], body['source']), ('anthropic', False, None))
        self.assertIn('model', body)

    def test_viewer_cannot_change_the_key(self, _post):
        self.assertEqual(self.put_key(self.viewer, GOOD).status_code, 403)
        self.assertEqual(self.viewer.delete('/api/ai/settings/key').status_code, 403)
        self.assertEqual(self.viewer.post('/api/ai/settings/validate', {'apiKey': GOOD},
                                          content_type='application/json').status_code, 403)
        self.assertFalse(AIProviderSetting.objects.exists())

    def test_a_forged_identity_header_alone_cannot_change_the_key(self, _post):
        r = self.put_key(self.boss_no_token, GOOD)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()['code'], 'REAUTH_REQUIRED')
        # token for someone else + header claiming to be the super admin
        forged = Client(HTTP_X_USER_EMAIL='boss@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('viewer@co.com'))
        self.assertEqual(self.put_key(forged, GOOD).status_code, 401)
        self.assertFalse(AIProviderSetting.objects.exists())

    # ---- save / validate / rotate / remove ------------------------------
    def test_valid_key_is_validated_saved_encrypted_and_used(self, post):
        r = self.put_key(self.boss, GOOD)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body['configured'], body['source']), (True, 'managed'))
        self.assertTrue(post.called)
        row = AIProviderSetting.objects.get()
        self.assertNotIn(GOOD, row.encrypted_key)                 # encrypted at rest
        self.assertEqual(Fernet(SECRETS.encode()).decrypt(row.encrypted_key.encode()).decode(), GOOD)
        self.assertEqual(ai._api_key(), GOOD)                     # AI calls use it
        self.assertEqual(body['managed']['updatedBy'], 'boss@co.com')

    def test_invalid_key_is_rejected_and_not_activated(self, _post):
        r = self.put_key(self.boss, BAD)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['code'], 'KEY_INVALID')
        self.assertFalse(AIProviderSetting.objects.filter(encrypted_key__gt='').exists())
        self.assertEqual(AISettingsAudit.objects.get().action, 'key_rejected')

    def test_validate_only_does_not_save(self, _post):
        ok = self.boss.post('/api/ai/settings/validate', {'apiKey': GOOD}, content_type='application/json').json()
        bad = self.boss.post('/api/ai/settings/validate', {'apiKey': BAD}, content_type='application/json').json()
        self.assertTrue(ok['valid'])
        self.assertFalse(bad['valid'])
        self.assertIn('rejected', bad['message'])
        self.assertFalse(AIProviderSetting.objects.exists())

    def test_rotation_replaces_the_key_and_is_audited(self, _post):
        self.put_key(self.boss, GOOD)
        r = self.put_key(self.boss, GOOD2)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(ai._api_key(), GOOD2)
        actions = list(AISettingsAudit.objects.order_by('id').values_list('action', flat=True))
        self.assertEqual(actions, ['key_saved', 'key_rotated'])

    def test_remove_falls_back_to_the_environment_key(self, _post):
        self.put_key(self.boss, GOOD)
        with mock.patch.dict(os.environ, {'ANTHROPIC_API_KEY': ENV_KEY}):
            r = self.boss.delete('/api/ai/settings/key')
            self.assertEqual(r.status_code, 200)
            self.assertEqual((r.json()['source'], r.json()['configured']), ('environment', True))
            self.assertEqual(ai._api_key(), ENV_KEY)
        self.assertIn('fallback: environment', AISettingsAudit.objects.order_by('-id').first().detail)

    def test_remove_without_fallback_switches_ai_off(self, _post):
        self.put_key(self.boss, GOOD)
        r = self.boss.delete('/api/ai/settings/key')
        self.assertEqual((r.json()['configured'], r.json()['source']), (False, None))
        self.assertIsNone(ai._api_key())
        self.assertEqual(self.boss.delete('/api/ai/settings/key').status_code, 404)

    def test_legacy_vite_key_still_works_but_is_flagged(self, _post):
        with mock.patch.dict(os.environ, {'VITE_ANTHROPIC_API_KEY': ENV_KEY}):
            body = self.viewer.get('/api/ai/settings').json()
            self.assertEqual(body['source'], 'legacy_environment')
            self.assertTrue(body['legacyViteKeyPresent'])

    def test_saving_needs_the_encryption_key(self, _post):
        with mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': ''}):
            r = self.put_key(self.boss, GOOD)
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()['code'], 'ENCRYPTION_NOT_CONFIGURED')

    def test_wrong_encryption_key_falls_back_safely(self, _post):
        self.put_key(self.boss, GOOD)
        with mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': Fernet.generate_key().decode(),
                                          'ANTHROPIC_API_KEY': ENV_KEY}):
            body = self.viewer.get('/api/ai/settings').json()
            self.assertEqual(body['source'], 'environment')
            self.assertFalse(body['managed']['readable'])

    # ---- the key never leaks ----------------------------------------------
    def test_key_never_appears_in_responses_audit_or_logs(self, _post):
        with self.assertLogs('api', level='DEBUG') as logs:
            logging.getLogger('api').debug('start')
            responses = [
                self.put_key(self.boss, GOOD),
                self.put_key(self.boss, BAD),
                self.boss.post('/api/ai/settings/validate', {'apiKey': GOOD2}, content_type='application/json'),
                self.viewer.get('/api/ai/settings'),
                self.viewer.get('/api/ai/settings/audit'),
                self.boss.get('/api/integrations/status'),
            ]
        for r in responses:
            for k in (GOOD, BAD, GOOD2):
                self.assertNotIn(k, r.content.decode())
        for a in AISettingsAudit.objects.all():
            for k in (GOOD, BAD, GOOD2):
                self.assertNotIn(k, a.detail + a.key_fingerprint)
        for line in logs.output:
            for k in (GOOD, BAD, GOOD2):
                self.assertNotIn(k, line)
        events = self.viewer.get('/api/ai/settings/audit').json()['events']
        self.assertEqual({e['actor'] for e in events}, {'boss@co.com'})

    def test_integrations_summary_reports_the_active_source(self, _post):
        self.put_key(self.boss, GOOD)
        body = self.boss.get('/api/integrations/status').json()['ai']
        self.assertEqual((body['configured'], body['source']), (True, 'managed'))


@mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': '', 'ANTHROPIC_API_KEY': ENV_KEY, 'VITE_ANTHROPIC_API_KEY': ''})
class BrowserKeyOverrideTests(TestCase):
    def setUp(self):
        ai.reset_status_cache()

    def test_ai_status_ignores_the_x_api_key_header(self):
        seen = []

        def capture(url, headers=None, json=None, timeout=None):
            seen.append(headers.get('x-api-key'))
            return FakeResp(200)

        with mock.patch('api.ai.requests.post', side_effect=capture):
            r = Client().get('/api/ai/status', HTTP_X_API_KEY='sk-ant-attacker-' + 'z' * 40)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(seen, [ENV_KEY])

    def test_status_cache_follows_key_changes(self):
        calls = []

        def capture(url, headers=None, json=None, timeout=None):
            calls.append(headers.get('x-api-key'))
            return FakeResp(200)

        with mock.patch('api.ai.requests.post', side_effect=capture):
            ai.check_ai_key_valid()
            ai.check_ai_key_valid()                        # cached
            with mock.patch.dict(os.environ, {'ANTHROPIC_API_KEY': GOOD}):
                ai.check_ai_key_valid()                    # different key -> re-checked
        self.assertEqual(calls, [ENV_KEY, GOOD])
