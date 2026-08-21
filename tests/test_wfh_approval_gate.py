"""Working from home has to be approved, and a rejection has to mean something.

`isWfh` is supplied by the client, and a WFH day skips the geofence entirely —
so until this was gated, posting {"isWfh": true} was a complete bypass of
attendance verification available to anyone who could reach the endpoint. The
WfhRequest workflow existed but only ever turned the flag ON; a Rejected request
was not consulted at all.

Agreed behaviour:
  * approved WFH request for the day  -> WFH check-in allowed, no geofence
  * no request at all                 -> claiming WFH is refused
  * rejected request                  -> refused, and it beats standing remote
                                         access, or rejection would be advisory
  * attendance.remote / a no-approval  -> allowed without filing a request
    policy
  * rejected off-site check-in        -> binding for the day; the employee
                                         cannot re-submit a reason, but can
                                         still check in from inside the fence
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import (AppUser, EmployeeAttendance, GeoFence, Permission,
                        Role, RolePermission, WfhRequest, WFHPolicy)
from api.timeutil import local_today

OFFICE_LAT, OFFICE_LNG = 17.4485, 78.3908           # inside the fence below
FAR_LAT, FAR_LNG = 12.9716, 77.5946                 # ~500 km away


class WfhCheckInGateTests(TestCase):
    """A plain employee — no role_ref, no legacy 'admin' — so no permission
    silently waves these through."""

    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='employee')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)

    def _check_in(self, **extra):
        payload = {'email': self.email, 'employee': 'Test Person'}
        payload.update(extra)
        return self.client.post('/api/attendance/check-in', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def _request(self, status):
        today = local_today()
        return WfhRequest.objects.create(
            email=self.email, employee_name='Test Person', from_date=today,
            to_date=today, days=1, reason='Plumber', status=status,
        )

    def _row(self):
        return EmployeeAttendance.objects.filter(
            email=self.email, date=local_today()).first()

    # ── the bypass this exists to close ──────────────────────────────────
    def test_claiming_wfh_without_a_request_is_refused(self):
        resp = self._check_in(isWfh=True)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json().get('code'), 'WFH_APPROVAL_REQUIRED')

    def test_a_refused_wfh_claim_does_not_stamp_a_check_in(self):
        self._check_in(isWfh=True)
        row = self._row()
        self.assertTrue(row is None or row.check_in is None,
                        'a refused claim must not record a check-in')

    def test_wfh_cannot_be_used_to_skip_the_fence_from_far_away(self):
        """The whole point: isWfh used to set geo_verified from anywhere."""
        resp = self._check_in(isWfh=True, latitude=FAR_LAT, longitude=FAR_LNG,
                              accuracy=10)
        self.assertEqual(resp.status_code, 403)
        row = self._row()
        self.assertFalse(row and row.geo_verified,
                         'an unapproved WFH claim must never be geo-verified')

    # ── the approved path still works ────────────────────────────────────
    def test_an_approved_request_allows_wfh_far_from_every_fence(self):
        self._request('Approved')
        resp = self._check_in(isWfh=True, latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))
        row = self._row()
        self.assertTrue(row.is_wfh)
        self.assertEqual(row.location_status, '', 'WFH must never need review')

    def test_an_approval_applies_even_if_the_client_forgets_to_ask(self):
        self._request('Approved')
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.assertTrue(self._row().is_wfh)

    # ── rejection ────────────────────────────────────────────────────────
    def test_a_rejected_request_blocks_the_wfh_check_in(self):
        self._request('Rejected')
        resp = self._check_in(isWfh=True)
        self.assertEqual(resp.status_code, 403)
        self.assertIn('rejected', resp.json().get('message', '').lower())

    def test_a_pending_request_is_not_an_approval(self):
        self._request('Pending')
        self.assertEqual(self._check_in(isWfh=True).status_code, 403)

    def test_rejection_beats_standing_remote_access(self):
        """Otherwise an approver's decision is advisory for anyone holding the
        permission, which is the failure mode the gate exists to prevent."""
        self._grant('attendance.remote')
        self._request('Rejected')
        self.assertEqual(self._check_in(isWfh=True).status_code, 403)

    def test_an_approval_still_wins_over_a_stale_rejection(self):
        """An approver reversing themselves should not have to delete a row."""
        self._request('Rejected')
        self._request('Approved')
        self.assertIn(self._check_in(isWfh=True).status_code, (200, 201))

    def test_a_rejection_for_another_day_does_not_block_today(self):
        today = local_today()
        WfhRequest.objects.create(
            email=self.email, from_date=today.replace(day=1) if today.day > 1 else today,
            to_date=today, days=1, status='Approved')
        self.assertIn(self._check_in(isWfh=True).status_code, (200, 201))

    # ── the two ways to work remotely without filing a request ───────────
    def _grant(self, code):
        role, _ = Role.objects.get_or_create(name='Remote Staff')
        perm = Permission.objects.filter(code=code).first()
        self.assertIsNotNone(perm, f'{code} must be seeded by a migration')
        RolePermission.objects.get_or_create(role_id=role.id, permission=perm)
        AppUser.objects.filter(email=self.email).update(role_ref=role)
        return role

    def test_attendance_remote_allows_wfh_without_a_request(self):
        self._grant('attendance.remote')
        resp = self._check_in(isWfh=True, latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.assertTrue(self._row().is_wfh)

    def test_a_policy_that_needs_no_approval_allows_wfh(self):
        WFHPolicy.objects.create(name='Open', requires_approval=False, is_active=True)
        self.assertIn(self._check_in(isWfh=True).status_code, (200, 201))

    def test_standing_remote_access_does_not_mark_office_staff_as_wfh(self):
        """It permits a claim; it must not make one. Otherwise every admin
        checking in at their desk would skip the fence."""
        self._grant('attendance.remote')
        resp = self._check_in(latitude=OFFICE_LAT, longitude=OFFICE_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.assertFalse(self._row().is_wfh)


class OffsiteRejectionIsBindingTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='employee')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)
        self.row = EmployeeAttendance.objects.create(
            email=self.email, employee_name='Test Person', date=local_today(),
            location_status='Rejected', location_reason='Client visit',
            location_reviewer='hr@example.com', geo_verified=False,
        )

    def _check_in(self, **extra):
        payload = {'email': self.email, 'employee': 'Test Person'}
        payload.update(extra)
        return self.client.post('/api/attendance/check-in', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def test_a_rejected_employee_cannot_simply_ask_again(self):
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG,
                              locationReason='Client visit, second attempt')
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json().get('code'), 'LOCATION_APPROVAL_REJECTED')

    def test_re_asking_does_not_reset_the_decision_to_pending(self):
        """The bug this closes: the retry fell through to the branch that sets
        Pending, so a rejection cost the employee only the time to retype."""
        self._check_in(latitude=FAR_LAT, longitude=FAR_LNG,
                       locationReason='Client visit, second attempt')
        self.row.refresh_from_db()
        self.assertEqual(self.row.location_status, 'Rejected')
        self.assertEqual(self.row.location_reason, 'Client visit')

    def test_the_refusal_names_the_reviewer(self):
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG,
                              locationReason='again')
        self.assertEqual(resp.json().get('reviewer'), 'hr@example.com')

    def test_rejection_blocks_the_off_site_route_only(self):
        """Reaching the office is the remedy the refusal points at, so it has
        to actually work."""
        resp = self._check_in(latitude=OFFICE_LAT, longitude=OFFICE_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.row.refresh_from_db()
        self.assertTrue(self.row.geo_verified)
        self.assertIsNotNone(self.row.check_in)


class ApprovalPermissionTests(TestCase):
    """Who may action the two decisions, now that each has its own permission."""

    def setUp(self):
        self.client = Client()
        today = local_today()
        self.wfh = WfhRequest.objects.create(
            email='employee@example.com', from_date=today, to_date=today,
            days=1, status='Pending',
        )
        self.att = EmployeeAttendance.objects.create(
            email='employee@example.com', date=today, location_status='Pending',
            location_reason='Client visit', geo_verified=False,
        )

    def _as(self, email, role_name=None, legacy_role='employee'):
        role = Role.objects.filter(name=role_name).first() if role_name else None
        AppUser.objects.create(email=email, status='active',
                               role=legacy_role, role_ref=role)
        return email

    def _decide_wfh(self, who, status='Approved'):
        return self.client.put(
            f'/api/attendance/wfh/{self.wfh.id}',
            data={'status': status}, content_type='application/json',
            HTTP_X_USER_EMAIL=who)

    def _decide_wfh_viewset(self, who, action='approve'):
        """The second, older route to the same decision."""
        return self.client.post(
            f'/api/attendance/wfh/{action}/',
            data={'requestId': self.wfh.id}, content_type='application/json',
            **({'HTTP_X_USER_EMAIL': who} if who else {}))

    def _decide_offsite(self, who, decision='Approved'):
        return self.client.post(
            '/api/attendance/location-reviews',
            data={'id': self.att.id, 'decision': decision},
            content_type='application/json', HTTP_X_USER_EMAIL=who)

    def test_hr_manager_can_action_a_wfh_request(self):
        self.assertEqual(self._decide_wfh(self._as('hrm@x.com', 'HR Manager')).status_code, 200)

    def test_a_plain_employee_cannot_action_a_wfh_request(self):
        self.assertEqual(self._decide_wfh(self._as('emp@x.com')).status_code, 403)

    def test_hr_manager_can_action_an_off_site_check_in(self):
        self.assertEqual(self._decide_offsite(self._as('hrm2@x.com', 'HR Manager')).status_code, 200)

    def test_a_plain_employee_cannot_action_an_off_site_check_in(self):
        self.assertEqual(self._decide_offsite(self._as('emp2@x.com')).status_code, 403)

    # ── the older /wfh/approve/ + /wfh/reject/ route ─────────────────────
    # These carried no permission check at all, so an employee could approve
    # their own request and walk straight through the check-in gate. Gating
    # only the newer endpoint would have left the front door open.
    def test_an_employee_cannot_self_approve_via_the_viewset_route(self):
        who = self._as('selfserve@x.com')
        self.assertEqual(self._decide_wfh_viewset(who).status_code, 403)
        self.wfh.refresh_from_db()
        self.assertEqual(self.wfh.status, 'Pending')

    def test_an_employee_cannot_self_reject_via_the_viewset_route(self):
        who = self._as('selfserve2@x.com')
        self.assertEqual(self._decide_wfh_viewset(who, 'reject').status_code, 403)
        self.wfh.refresh_from_db()
        self.assertEqual(self.wfh.status, 'Pending')

    def test_an_anonymous_caller_cannot_approve_via_the_viewset_route(self):
        self.assertEqual(self._decide_wfh_viewset(None).status_code, 401)
        self.wfh.refresh_from_db()
        self.assertEqual(self.wfh.status, 'Pending')

    def test_hr_manager_can_approve_via_the_viewset_route(self):
        who = self._as('hrm3@x.com', 'HR Manager')
        self.assertEqual(self._decide_wfh_viewset(who).status_code, 200)
        self.wfh.refresh_from_db()
        self.assertEqual(self.wfh.status, 'Approved')

    def test_the_viewset_route_records_who_actually_decided(self):
        """It used to read request.user.email — AnonymousUser on an AllowAny
        viewset — so the approver was never the person who clicked."""
        who = self._as('hrm4@x.com', 'HR Manager')
        self._decide_wfh_viewset(who)
        self.wfh.refresh_from_db()
        self.assertEqual(self.wfh.approver, who)

    def test_the_two_decisions_are_separately_grantable(self):
        """A role given only the WFH permission must not inherit the off-site
        one — separating them is the reason they are two codes."""
        role, _ = Role.objects.get_or_create(name='Team Lead')
        perm = Permission.objects.filter(code='attendance.approve_wfh').first()
        RolePermission.objects.get_or_create(role_id=role.id, permission=perm)
        who = self._as('lead@x.com', 'Team Lead')

        self.assertEqual(self._decide_wfh(who).status_code, 200)
        self.assertEqual(self._decide_offsite(who).status_code, 403)
