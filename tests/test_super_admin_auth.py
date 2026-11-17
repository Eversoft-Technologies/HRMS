import os
import sys
from datetime import timedelta
from unittest import mock

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import Client, TestCase
from django.utils import timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.auth_views import _hash_code
from api.models import AppUser, LoginOtp, Role


class SuperAdminAuthTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.admin_role, _ = Role.objects.get_or_create(name='Super Admin')
        self.employee_role, _ = Role.objects.get_or_create(name='Employee')
        self.admin = AppUser.objects.create(
            full_name='Site Administrator', email='admin@example.test',
            password='admin-pass', role='admin', role_ref=self.admin_role,
            status='active',
        )
        self.employee = AppUser.objects.create(
            full_name='Regular Employee', email='employee@example.test',
            password='employee-pass', role='employee', role_ref=self.employee_role,
            status='active',
        )

    def _post_json(self, path, body):
        return self.client.post(path, body, content_type='application/json')

    def _create_otp(self, user, code='123456'):
        salt = 'test-salt'
        LoginOtp.objects.create(
            email=user.email,
            code_hash=_hash_code(code, salt),
            salt=salt,
            expires_at=timezone.now() + timedelta(minutes=5),
        )
        return code

    def test_dedicated_page_has_no_role_selector(self):
        response = self.client.get('/super-admin/login')

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'Super Admin Sign In')
        self.assertNotContains(response, 'auth-role')

    @mock.patch('api.auth_views._issue_otp', return_value={'ok': True})
    def test_super_admin_credentials_start_otp(self, issue_otp):
        response = self._post_json('/api/auth/super-admin/login', {
            'email': self.admin.email, 'password': 'admin-pass',
        })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['otpRequired'])
        issue_otp.assert_called_once_with(self.admin)

    @mock.patch('api.auth_views._issue_otp')
    def test_regular_account_cannot_start_super_admin_login(self, issue_otp):
        response = self._post_json('/api/auth/super-admin/login', {
            'email': self.employee.email, 'password': 'employee-pass',
        })

        self.assertEqual(response.status_code, 401)
        issue_otp.assert_not_called()

    def test_super_admin_cannot_use_public_login_endpoint(self):
        response = self._post_json('/api/auth/login', {
            'email': self.admin.email, 'password': 'admin-pass', 'role': 'Super Admin',
        })

        self.assertEqual(response.status_code, 403)

    @mock.patch('api.auth_views._issue_otp', return_value={'ok': True})
    def test_regular_account_still_uses_public_login(self, issue_otp):
        response = self._post_json('/api/auth/login', {
            'email': self.employee.email, 'password': 'employee-pass', 'role': 'Employee',
        })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['otpRequired'])
        issue_otp.assert_called_once_with(self.employee)

    def test_super_admin_otp_is_only_accepted_by_admin_endpoint(self):
        code = self._create_otp(self.admin)

        public_response = self._post_json('/api/auth/verify-otp', {
            'email': self.admin.email, 'code': code,
        })
        self.assertEqual(public_response.status_code, 403)
        self.assertFalse(LoginOtp.objects.get(email=self.admin.email).consumed)

        admin_response = self._post_json('/api/auth/super-admin/verify-otp', {
            'email': self.admin.email, 'code': code,
        })
        self.assertEqual(admin_response.status_code, 200)
        self.assertTrue(admin_response.json()['ok'])
        self.assertNotIn('password', admin_response.json()['user'])

    def test_regular_user_otp_is_rejected_by_admin_endpoint(self):
        code = self._create_otp(self.employee)

        response = self._post_json('/api/auth/super-admin/verify-otp', {
            'email': self.employee.email, 'code': code,
        })

        self.assertEqual(response.status_code, 400)
        self.assertFalse(LoginOtp.objects.get(email=self.employee.email).consumed)

    @mock.patch('api.auth_views._issue_otp', return_value={'ok': True})
    def test_admin_resend_requires_super_admin_account(self, issue_otp):
        response = self._post_json('/api/auth/super-admin/resend-otp', {
            'email': self.employee.email,
        })

        self.assertEqual(response.status_code, 401)
        issue_otp.assert_not_called()

    @mock.patch('api.auth_views._issue_otp', return_value={'ok': True})
    def test_public_resend_cannot_target_super_admin_account(self, issue_otp):
        response = self._post_json('/api/auth/resend-otp', {
            'email': self.admin.email,
        })

        self.assertEqual(response.status_code, 401)
        issue_otp.assert_not_called()