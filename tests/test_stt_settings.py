"""Deepgram key managed from Settings › AI Settings (api/stt_settings.py).

Saved encrypted, checked with Deepgram before it is activated, preferred over
DEEPGRAM_API_KEY in the .env, never returned or logged, and only changeable by
someone with ai.settings.manage and a fresh sign-in. Deepgram is mocked.
"""
import os
from datetime import datetime, timedelta
from unittest import mock

import jwt
from cryptography.fernet import Fernet
from django.conf import settings
from django.test import Client, TestCase

from api import transcription
from api.models import AIProviderSetting, AISettingsAudit, AppUser, Permission, Role, RolePermission

GOOD = 'dg-good-key-' + 'a' * 30
GOOD2 = 'dg-second-key-' + 'b' * 30
BAD = 'dg-bad-key-' + 'c' * 30
ENV_KEY = 'dg-env-key-' + 'd' * 30
SECRETS = Fernet.generate_key().decode()


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


class FakeResp:
    def __init__(self, status):
        self.status_code = status


def fake_get(url, headers=None, timeout=None):
    key = (headers or {}).get('Authorization', '').replace('Token ', '')
    return FakeResp(200 if key in (GOOD, GOOD2, ENV_KEY) else 401)


@mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS, 'DEEPGRAM_API_KEY': ''})
@mock.patch('api.stt_settings.requests.get', side_effect=fake_get)
class SttSettingsTests(TestCase):
    def setUp(self):
        view = Permission.objects.create(code='ai.settings.view', name='View AI Settings')
        Permission.objects.create(code='ai.settings.manage', name='Manage AI Settings')
        viewer_role = Role.objects.create(name='AI Viewer')
        RolePermission.objects.create(role=viewer_role, permission=view)
        super_role = Role.objects.create(name='Super Admin')
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role_ref=super_role)
        AppUser.objects.create(email='viewer@co.com', full_name='Viewer', password='x', role_ref=viewer_role)
        self.boss = Client(HTTP_X_USER_EMAIL='boss@co.com', HTTP_AUTHORIZATION='Bearer ' + token_for('boss@co.com'))
        self.boss_no_token = Client(HTTP_X_USER_EMAIL='boss@co.com')
        self.viewer = Client(HTTP_X_USER_EMAIL='viewer@co.com',
                             HTTP_AUTHORIZATION='Bearer ' + token_for('viewer@co.com'))

    def put_key(self, client, key):
        return client.put('/api/stt/settings/key', {'apiKey': key}, content_type='application/json')

    def test_starts_unconfigured(self, _get):
        m = self.boss.get('/api/stt/settings').json()
        self.assertEqual((m['configured'], m['source'], m['canManage']), (False, None, True))
        self.assertFalse(transcription.is_configured())

    def test_save_encrypts_and_transcription_uses_it(self, _get):
        r = self.put_key(self.boss, GOOD)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['configured'], r.json()['source']), (True, 'managed'))
        row = AIProviderSetting.objects.get(provider='deepgram')
        self.assertNotIn(GOOD, row.encrypted_key)                   # stored encrypted
        self.assertEqual(transcription.api_key(), GOOD)              # used for transcription
        # the Anthropic row is untouched
        self.assertFalse(AIProviderSetting.objects.filter(provider='anthropic').exists())

    def test_saved_key_beats_env_and_removal_falls_back(self, _get):
        with mock.patch.dict(os.environ, {'DEEPGRAM_API_KEY': ENV_KEY}):
            self.assertEqual(transcription.api_key(), ENV_KEY)
            self.put_key(self.boss, GOOD)
            self.assertEqual(transcription.api_key(), GOOD)
            m = self.boss.delete('/api/stt/settings/key').json()
            self.assertEqual(m['source'], 'environment')
            self.assertEqual(transcription.api_key(), ENV_KEY)

    def test_bad_key_is_not_saved(self, _get):
        r = self.put_key(self.boss, BAD)
        self.assertEqual((r.status_code, r.json()['code']), (400, 'KEY_INVALID'))
        self.assertFalse(transcription.is_configured())

    def test_rotate(self, _get):
        self.put_key(self.boss, GOOD)
        self.put_key(self.boss, GOOD2)
        self.assertEqual(transcription.api_key(), GOOD2)
        actions = list(AISettingsAudit.objects.filter(provider='deepgram').values_list('action', flat=True))
        self.assertIn('key_rotated', actions)

    def test_validate_does_not_save(self, _get):
        r = self.boss.post('/api/stt/settings/validate', {'apiKey': GOOD}, content_type='application/json')
        self.assertTrue(r.json()['valid'])
        self.assertFalse(transcription.is_configured())

    def test_key_never_returned_or_audited(self, _get):
        self.put_key(self.boss, GOOD)
        for url in ('/api/stt/settings', '/api/stt/settings/audit'):
            self.assertNotIn(GOOD, self.boss.get(url).content.decode())
        for d in AISettingsAudit.objects.values_list('detail', 'key_fingerprint'):
            self.assertNotIn(GOOD, ' '.join(d))

    def test_viewer_can_see_but_not_change(self, _get):
        self.assertEqual(self.viewer.get('/api/stt/settings').json()['canManage'], False)
        self.assertEqual(self.put_key(self.viewer, GOOD).status_code, 403)

    def test_change_needs_fresh_sign_in(self, _get):
        r = self.put_key(self.boss_no_token, GOOD)
        self.assertEqual((r.status_code, r.json()['code']), (401, 'REAUTH_REQUIRED'))

    def test_histories_are_separate(self, _get):
        self.put_key(self.boss, GOOD)
        self.assertEqual(len(self.boss.get('/api/stt/settings/audit').json()['events']), 1)
        self.assertEqual(self.boss.get('/api/ai/settings/audit').json()['events'], [])
