"""RBAC must refuse a caller it cannot identify.

@require_perm and @require_admin used to return the view when _get_caller()
could not resolve a user ("Once all clients send the header, change this to
deny"), so omitting X-User-Email — or sending an address with no AppUser row —
reached every guarded endpoint, including role and permission administration.
Both now deny. The one documented exception is the candidate's end-of-interview
upload, which opts in via anonymous_methods.
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import AppUser, Role


class RbacHeaderBypassTests(TestCase):
    def setUp(self):
        self.client = Client()
        # The RBAC migrations already seed the standard roles, so use a name
        # that cannot collide with them.
        role = Role.objects.create(name='Bypass Test Role', is_active=True)
        self.employee = AppUser.objects.create(
            email='employee@example.com', status='active', role='employee', role_ref=role,
        )

    def test_admin_endpoint_rejects_request_with_no_identity_header(self):
        """An anonymous caller must not reach a @require_admin endpoint."""
        resp = self.client.get('/api/roles')
        self.assertIn(resp.status_code, (401, 403), msg=(
            f'GET /api/roles with no X-User-Email returned {resp.status_code}; '
            'the RBAC grace period lets anonymous callers list roles.'
        ))

    def test_admin_endpoint_rejects_unknown_email(self):
        """An address with no AppUser row must not be treated as trusted."""
        resp = self.client.get('/api/roles', HTTP_X_USER_EMAIL='nobody@attacker.example')
        self.assertIn(resp.status_code, (401, 403), msg=(
            f'GET /api/roles with an unknown email returned {resp.status_code}; '
            'unresolvable identities fall into the same open branch.'
        ))

    def test_admin_write_is_rejected_without_identity_header(self):
        """The bypass is not read-only — role creation is reachable too."""
        before = Role.objects.count()
        resp = self.client.post(
            '/api/roles', data={'name': 'Injected Role'}, content_type='application/json',
        )
        self.assertIn(resp.status_code, (401, 403), msg=(
            f'POST /api/roles with no X-User-Email returned {resp.status_code}.'
        ))
        self.assertEqual(Role.objects.count(), before, 'an anonymous POST created a Role')

    def test_signed_in_employee_is_denied_admin_endpoint(self):
        """The check works correctly once an identity actually resolves."""
        resp = self.client.get('/api/roles', HTTP_X_USER_EMAIL=self.employee.email)
        self.assertIn(resp.status_code, (401, 403))


class AuthClosureDoesNotBreakLegitimateTrafficTests(TestCase):
    """Closing the grace period must not take real flows down with it."""

    def setUp(self):
        self.client = Client()
        role = Role.objects.create(name='Recruiter Test Role', is_active=True)
        self.recruiter = AppUser.objects.create(
            email='recruiter@example.com', status='active', role='hr', role_ref=role,
        )

    def test_candidate_can_still_upload_their_recording_anonymously(self):
        """The interview upload opts into anonymous_methods — a candidate has no
        AppUser row and cannot send an identity."""
        resp = self.client.post('/api/interview-recordings', data={
            'candidateName': 'srikanth', 'candidateEmail': 'candidate@example.com',
            'role': 'data analyst', 'verdict': 'HOLD', 'totalScore': 62,
            'transcript': 'Q1 · Technical\nEva: ...\nCandidate: ...', 'responses': [],
        }, content_type='application/json')
        self.assertEqual(resp.status_code, 201, 'candidates could no longer finish an interview')

    def test_listing_recordings_still_requires_identity(self):
        """Only POST is anonymous — reading the pool must stay protected."""
        self.assertEqual(self.client.get('/api/interview-recordings').status_code, 401)

    def test_public_candidate_endpoints_are_untouched(self):
        """Undecorated endpoints never went through the grace period."""
        self.assertEqual(self.client.get('/api/health').status_code, 200)
        verify = self.client.post(
            '/api/interviews/verify-token',
            data={'token': 'nope'}, content_type='application/json',
        )
        self.assertIn(verify.status_code, (200, 404))
        self.assertNotEqual(verify.status_code, 401)

    def test_a_signed_in_user_still_reaches_endpoints_they_are_granted(self):
        """The header hrms-actor.js attaches must still authenticate."""
        resp = self.client.get(
            '/api/interview-recordings', HTTP_X_USER_EMAIL=self.recruiter.email,
        )
        self.assertNotEqual(resp.status_code, 401, 'a signed-in user was treated as anonymous')
