import os
import sys
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import mailer
from api.views import create_notification
from api.models import Notification


class NotificationTests(TestCase):
    def test_create_notification_saves_record(self):
        notification = create_notification(
            'employee@example.com',
            'Welcome',
            'Your account is ready.',
            'success',
            '/profile',
        )

        self.assertIsNotNone(notification)
        assert notification is not None
        self.assertTrue(Notification.objects.filter(pk=notification.pk).exists())
        self.assertEqual(notification.recipient, 'employee@example.com')
        self.assertFalse(notification.is_read)

    def test_smtp_password_is_normalized(self):
        with patch.dict(os.environ, {
            'SMTP_HOST': 'smtp.gmail.com',
            'SMTP_PORT': '587',
            'SMTP_USER': 'user@example.com',
            'SMTP_PASSWORD': 'atjy hixl lmet rpjd',
            'SMTP_SECURE': 'false',
            'SMTP_FROM_NAME': 'HRMS',
            'SMTP_FROM_EMAIL': 'sender@example.com',
        }, clear=False):
            settings = mailer.get_smtp_settings()
            self.assertEqual(settings['password'], 'atjyhixllmetrpjd')

    def test_send_email_prefers_smtp_when_available(self):
        smtp_settings = {
            'host': 'smtp.gmail.com',
            'port': 587,
            'user': 'user@example.com',
            'password': 'secret',
            'secure': False,
            'from_name': 'HRMS',
            'from_email': 'sender@example.com',
        }
        resend_settings = {
            'type': 'resend',
            'api_key': 'dummy',
            'from_name': 'HRMS',
            'from_email': 'sender@example.com',
        }

        with patch('api.mailer.get_smtp_settings', return_value=smtp_settings), \
             patch('api.mailer._get_resend_settings', return_value=resend_settings), \
             patch('api.mailer._send_via_smtp', return_value={'ok': True}) as smtp_mock, \
             patch('api.mailer._send_via_resend', return_value={'ok': False, 'error': 'should not be used'}) as resend_mock:
            result = mailer.send_email('user@example.com', 'Subject', 'body')

        self.assertTrue(result['ok'])
        smtp_mock.assert_called_once()
        resend_mock.assert_not_called()
