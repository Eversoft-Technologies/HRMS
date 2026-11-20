"""/api/me/permissions carries the account's current role (what the React menu
is built from), so a browser session saved under an older role is corrected."""
from django.test import Client, TestCase

from api.models import AppUser


class AccountRoleTests(TestCase):
    def get(self, email):
        return Client(HTTP_X_USER_EMAIL=email).get('/api/me/permissions?email=' + email).json()

    def test_admin_account_is_admin(self):
        AppUser.objects.create(email='boss@example.com', full_name='Boss', status='active', role='admin')
        d = self.get('boss@example.com')
        self.assertEqual((d['superAdmin'], d['accountRole']), (True, 'admin'))

    def test_recruiter_stays_recruitment(self):
        AppUser.objects.create(email='rec@example.com', full_name='Rec', status='active', role='recruitment')
        self.assertEqual(self.get('rec@example.com')['accountRole'], 'recruitment')

    def test_unknown_email_has_no_account_role(self):
        AppUser.objects.create(email='boss@example.com', full_name='Boss', status='active', role='admin')
        d = Client(HTTP_X_USER_EMAIL='boss@example.com').get('/api/me/permissions?email=nobody@example.com').json()
        self.assertIsNone(d['accountRole'])
