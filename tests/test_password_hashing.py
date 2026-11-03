"""Login passwords are always hashed; SMTP passwords are encrypted and never
returned to the browser."""
import os
from unittest import mock

from cryptography.fernet import Fernet
from django.contrib.auth.hashers import check_password, make_password
from django.test import Client, TestCase

from api import mailer
from api.auth_views import _verify_password
from api.models import AppUser, UserEmailConfig
from api.secret_box import decrypt, is_encrypted, is_password_hash

SECRETS = Fernet.generate_key().decode()


class LoginPasswordHashingTests(TestCase):
    def test_save_hashes_a_raw_password(self):
        u = AppUser.objects.create(email='a@co.com', full_name='A', password='secret123')
        stored = AppUser.objects.get(pk=u.pk).password
        self.assertTrue(is_password_hash(stored))
        self.assertNotIn('secret123', stored)
        self.assertTrue(check_password('secret123', stored))

    def test_existing_hash_is_not_hashed_again_and_blank_stays_blank(self):
        h = make_password('pw-123456')
        u = AppUser.objects.create(email='b@co.com', full_name='B', password=h)
        self.assertEqual(AppUser.objects.get(pk=u.pk).password, h)
        g = AppUser.objects.create(email='g@co.com', full_name='G', password='')   # Google / SSO account
        self.assertEqual(AppUser.objects.get(pk=g.pk).password, '')

    def test_login_check_uses_the_hash(self):
        u = AppUser.objects.create(email='c@co.com', full_name='C', password='right-pass')
        self.assertTrue(_verify_password('right-pass', u))
        self.assertFalse(_verify_password('wrong-pass', u))
        self.assertFalse(_verify_password('', u))
        self.assertFalse(_verify_password(u.password, u))       # the hash itself is not a password

    def test_plain_text_written_outside_the_orm_is_upgraded_on_login(self):
        u = AppUser.objects.create(email='d@co.com', full_name='D', password='x')
        AppUser.objects.filter(pk=u.pk).update(password='legacy-pass')   # bypasses save()
        u.refresh_from_db()
        self.assertFalse(_verify_password('nope', u))
        self.assertTrue(_verify_password('legacy-pass', u))
        self.assertTrue(is_password_hash(AppUser.objects.get(pk=u.pk).password))

    def test_users_api_stores_a_hash_and_never_returns_it(self):
        AppUser.objects.create(email='admin@co.com', full_name='Admin', password='admin-pass', role='admin')
        c = Client(HTTP_X_USER_EMAIL='admin@co.com')
        r = c.post('/api/users', {'name': 'New Person', 'email': 'new@co.com', 'password': 'brand-new-1',
                                  'role': 'recruitment'}, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json().get('password', ''), '')
        self.assertTrue(check_password('brand-new-1', AppUser.objects.get(email='new@co.com').password))
        listing = c.get('/api/users').content.decode()
        self.assertNotIn('brand-new-1', listing)
        self.assertNotIn('pbkdf2_', listing)

    def test_migration_logic_hashes_plain_rows(self):
        import importlib
        mig = importlib.import_module('api.migrations.0082_hash_passwords_encrypt_smtp')
        u = AppUser.objects.create(email='e@co.com', full_name='E', password='x')
        AppUser.objects.filter(pk=u.pk).update(password='plain-old')
        from django.apps import apps
        mig.forwards(apps, None)
        stored = AppUser.objects.get(pk=u.pk).password
        self.assertTrue(is_password_hash(stored))
        self.assertTrue(check_password('plain-old', stored))


@mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': SECRETS})
class SmtpPasswordEncryptionTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='me@co.com', full_name='Me', password='x', role='admin')
        self.me = Client(HTTP_X_USER_EMAIL='me@co.com')
        self.url = '/api/user-settings/me@co.com/email-config'
        self.base = {'smtpHost': 'smtp.co.com', 'smtpPort': '587', 'smtpUser': 'me@co.com',
                     'fromName': 'Me', 'fromEmail': 'me@co.com'}

    def put(self, **extra):
        return self.me.put(self.url, {**self.base, **extra}, content_type='application/json')

    def test_saved_encrypted_never_returned_and_usable_by_the_mailer(self):
        r = self.put(smtpPassword='smtp-secret-9')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['smtpPassword'], '')
        self.assertTrue(r.json()['smtpPasswordSet'])
        stored = UserEmailConfig.objects.get(pk='me@co.com').smtp_password
        self.assertTrue(is_encrypted(stored))
        self.assertNotIn('smtp-secret-9', stored)
        self.assertEqual(decrypt(stored), 'smtp-secret-9')
        self.assertEqual(mailer._cfg_to_settings(UserEmailConfig.objects.get(pk='me@co.com'))['password'],
                         'smtp-secret-9')
        self.assertNotIn('smtp-secret-9', self.me.get('/api/user-settings/me@co.com').content.decode())

    def test_blank_keeps_the_saved_password_and_clear_removes_it(self):
        self.put(smtpPassword='smtp-secret-9')
        before = UserEmailConfig.objects.get(pk='me@co.com').smtp_password
        self.put(smtpPassword='')
        self.assertEqual(UserEmailConfig.objects.get(pk='me@co.com').smtp_password, before)
        self.put(clearSmtpPassword=True)
        self.assertEqual(UserEmailConfig.objects.get(pk='me@co.com').smtp_password, '')

    def test_refuses_to_store_without_the_encryption_key(self):
        with mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': ''}):
            r = self.put(smtpPassword='smtp-secret-9')
        self.assertEqual(r.status_code, 503)
        self.assertFalse(UserEmailConfig.objects.filter(pk='me@co.com', smtp_password='smtp-secret-9').exists())

    def test_legacy_plain_text_still_works_until_resaved(self):
        UserEmailConfig.objects.create(user_email='me@co.com', smtp_host='h', smtp_user='u', smtp_password='old-plain')
        self.assertEqual(mailer._cfg_to_settings(UserEmailConfig.objects.get(pk='me@co.com'))['password'], 'old-plain')
