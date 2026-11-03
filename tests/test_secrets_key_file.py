"""HRMS_SECRETS_KEY no longer has to be set by hand: without it the server
uses (and on first need creates) a key file outside the code and database."""
import os
import stat
import sys
import tempfile
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet
from django.test import SimpleTestCase

from api import secret_box


class KeyFileTests(SimpleTestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='hrms-key-')
        self.path = Path(self.dir) / 'nested' / 'secrets.key'
        p = mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': '', 'HRMS_SECRETS_FILE': str(self.path),
                                         'HRMS_SECRETS_AUTOGEN': '1'})
        p.start()
        self.addCleanup(p.stop)

    def test_created_on_first_save_and_reused(self):
        self.assertEqual(secret_box.key_source(), 'auto')
        self.assertTrue(secret_box.encryption_ready())
        self.assertFalse(self.path.exists())                       # nothing written just by asking
        token = secret_box.encrypt('sk-ant-secret')
        self.assertTrue(self.path.exists())
        self.assertEqual(secret_box.key_source(), 'file')
        self.assertEqual(secret_box.decrypt(token), 'sk-ant-secret')
        key = self.path.read_text().strip()
        secret_box.encrypt('again')
        self.assertEqual(self.path.read_text().strip(), key)        # never regenerated
        if sys.platform != 'win32':
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_environment_key_wins_over_the_file(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(Fernet.generate_key().decode())
        env_key = Fernet.generate_key().decode()
        with mock.patch.dict(os.environ, {'HRMS_SECRETS_KEY': env_key}):
            token = secret_box.encrypt('x')
            self.assertEqual(secret_box.key_source(), 'environment')
        self.assertEqual(Fernet(env_key.encode()).decrypt(token[len('enc1:'):].encode()), b'x')

    def test_autogen_can_be_switched_off(self):
        with mock.patch.dict(os.environ, {'HRMS_SECRETS_AUTOGEN': '0'}):
            self.assertFalse(secret_box.encryption_ready())
            self.assertIsNone(secret_box.key_source())
            with self.assertRaises(secret_box.SecretsNotConfigured):
                secret_box.encrypt('x')
        self.assertFalse(self.path.exists())

    def test_a_broken_key_is_never_replaced(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('not-a-key')
        self.assertFalse(secret_box.encryption_ready())
        with self.assertRaises(secret_box.SecretsNotConfigured):
            secret_box.encrypt('x')
        self.assertEqual(self.path.read_text(), 'not-a-key')
