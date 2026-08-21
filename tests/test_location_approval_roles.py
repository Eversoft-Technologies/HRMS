"""Who may action an off-site check-in.

The approval endpoint is gated on attendance.edit. Super Admin passes every
check by definition, so "can an admin approve?" needs asserting rather than
assuming — and the roles that cannot are worth pinning too, so widening it
later is a deliberate act.
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import AppUser, EmployeeAttendance, Role
from api.timeutil import local_today


class ApprovalRoleTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.row = EmployeeAttendance.objects.create(
            email='employee@example.com', employee_name='Test Person',
            date=local_today(), location_status='Pending',
            location_reason='Client visit', geo_verified=False,
        )

    def _as(self, email, role_name=None, legacy_role='employee'):
        role = Role.objects.filter(name=role_name).first() if role_name else None
        AppUser.objects.create(email=email, status='active',
                               role=legacy_role, role_ref=role)
        return email

    def _approve(self, email):
        return self.client.post(
            '/api/attendance/location-reviews',
            data={'id': self.row.id, 'decision': 'Approved'},
            content_type='application/json', HTTP_X_USER_EMAIL=email,
        )

    def test_super_admin_can_approve(self):
        who = self._as('sa@example.com', 'Super Admin')
        self.assertEqual(self._approve(who).status_code, 200)
        self.row.refresh_from_db()
        self.assertEqual(self.row.location_status, 'Approved')

    def test_legacy_admin_account_can_approve(self):
        """Accounts created via signup/OTP carry role='admin' and no role_ref."""
        who = self._as('legacy@example.com', None, legacy_role='admin')
        self.assertEqual(self._approve(who).status_code, 200)

    def test_hr_manager_can_approve(self):
        who = self._as('hrm@example.com', 'HR Manager')
        self.assertEqual(self._approve(who).status_code, 200)

    def test_a_plain_employee_cannot_approve(self):
        who = self._as('emp@example.com', 'Employee')
        self.assertEqual(self._approve(who).status_code, 403)
        self.row.refresh_from_db()
        self.assertEqual(self.row.location_status, 'Pending')

    def test_an_anonymous_caller_cannot_approve(self):
        resp = self.client.post(
            '/api/attendance/location-reviews',
            data={'id': self.row.id, 'decision': 'Approved'},
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 401)


class ApprovalButtonVisibilityTests(TestCase):
    """The sidecar hides the Approve button unless __hrmsCan('attendance.edit').

    That comes from /api/me/permissions, so if the API grants the action but
    this response omits the code, an admin sees no button and concludes they
    cannot approve.
    """

    def setUp(self):
        self.client = Client()

    def _codes(self, email):
        resp = self.client.get(f'/api/me/permissions?email={email}',
                               HTTP_X_USER_EMAIL=email)
        self.assertEqual(resp.status_code, 200)
        return resp.json().get('permissions') or []

    def test_super_admin_sees_the_button(self):
        AppUser.objects.create(email='sa@example.com', status='active', role='employee',
                               role_ref=Role.objects.get(name='Super Admin'))
        self.assertIn('attendance.edit', self._codes('sa@example.com'))

    def test_legacy_admin_account_sees_the_button(self):
        AppUser.objects.create(email='legacy@example.com', status='active', role='admin')
        self.assertIn('attendance.edit', self._codes('legacy@example.com'))

    def test_hr_manager_sees_the_button(self):
        AppUser.objects.create(email='hrm@example.com', status='active', role='employee',
                               role_ref=Role.objects.get(name='HR Manager'))
        self.assertIn('attendance.edit', self._codes('hrm@example.com'))

    def test_a_plain_employee_does_not(self):
        AppUser.objects.create(email='emp@example.com', status='active', role='employee',
                               role_ref=Role.objects.get(name='Employee'))
        self.assertNotIn('attendance.edit', self._codes('emp@example.com'))
