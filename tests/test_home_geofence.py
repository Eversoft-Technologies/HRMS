"""Work-from-home check-ins verified against the employee's registered home.

Before this, `is_wfh` set geo_verified=True and discarded the position, so an
approved WFH day was "verified" from anywhere on earth — the flag proved only
that somebody had claimed it.

Home fences share the GeoFence table with company locations, told apart by
owner_email. That sharing is the risk this file exists to pin down: an office
check-in matched against an unfiltered fence list would succeed from a
colleague's living room.

Agreed behaviour:
  * confirmed home + inside it   -> verified, no review
  * confirmed home + away        -> reason captured, held for approval
  * no home registered           -> allowed, position recorded, NOT verified
  * home registered but unconfirmed -> same as no home; a claim is not a basis
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import AppUser, EmployeeAttendance, GeoFence, Role, WfhRequest
from api.timeutil import local_today
from api.views import home_fence_for, _office_fences, _geofencing_enabled

OFFICE_LAT, OFFICE_LNG = 17.4485, 78.3908
HOME_LAT, HOME_LNG = 17.4200, 78.4500          # ~8 km from the office
FAR_LAT, FAR_LNG = 12.9716, 77.5946            # ~500 km away


class FenceIsolationTests(TestCase):
    """Homes and offices share a table. They must never match each other."""

    def setUp(self):
        self.office = GeoFence.objects.create(
            name='HQ', latitude=OFFICE_LAT, longitude=OFFICE_LNG, radius_meters=200)
        self.home = GeoFence.objects.create(
            name='Home', latitude=HOME_LAT, longitude=HOME_LNG, radius_meters=150,
            owner_email='ravi@x.com', status=GeoFence.APPROVED)

    def test_office_fence_list_excludes_homes(self):
        self.assertEqual([f.id for f in _office_fences()], [self.office.id])

    def test_a_home_does_not_make_geofencing_look_enabled(self):
        """A company with no office fence but one registered home must not have
        enforcement switch on for everybody."""
        self.office.delete()
        self.assertFalse(_geofencing_enabled())

    def test_home_lookup_is_scoped_to_its_owner(self):
        self.assertEqual(home_fence_for('ravi@x.com').id, self.home.id)
        self.assertIsNone(home_fence_for('someone.else@x.com'))
        self.assertIsNone(home_fence_for(''))

    def test_an_unconfirmed_home_is_not_a_verification_basis(self):
        self.home.status = GeoFence.PENDING
        self.home.save()
        self.assertIsNone(home_fence_for('ravi@x.com'))

    def test_a_rejected_home_is_not_a_verification_basis(self):
        self.home.status = GeoFence.REJECTED
        self.home.save()
        self.assertIsNone(home_fence_for('ravi@x.com'))

    def test_the_fence_admin_list_never_exposes_homes(self):
        """Home addresses are personal data; the office admin screen is seen by
        anyone with attendance.view."""
        AppUser.objects.create(email='admin@x.com', status='active', role='admin')
        rows = Client().get('/api/attendance/geofences',
                            HTTP_X_USER_EMAIL='admin@x.com').json()
        self.assertEqual([r['name'] for r in rows], ['HQ'])


class WfhHomeCheckInTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='employee')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)
        today = local_today()
        WfhRequest.objects.create(email=self.email, from_date=today, to_date=today,
                                  days=1, status='Approved')

    def _home(self, status=GeoFence.APPROVED):
        return GeoFence.objects.create(
            name='Home', latitude=HOME_LAT, longitude=HOME_LNG, radius_meters=150,
            owner_email=self.email, status=status)

    def _check_in(self, **extra):
        payload = {'email': self.email, 'employee': 'Test Person', 'isWfh': True}
        payload.update(extra)
        return self.client.post('/api/attendance/check-in', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def _row(self):
        return EmployeeAttendance.objects.filter(
            email=self.email, date=local_today()).first()

    # ── the bypass this closes ───────────────────────────────────────────
    def test_wfh_far_from_home_is_no_longer_silently_verified(self):
        self._home()
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, accuracy=10)
        self.assertEqual(resp.status_code, 422)
        self.assertEqual(resp.json().get('code'), 'LOCATION_REASON_REQUIRED')
        self.assertFalse(self._row().geo_verified)

    def test_the_position_is_recorded_even_when_refused(self):
        """It used to be discarded entirely, so a WFH day showed 'Home' with no
        evidence of where that was."""
        self._home()
        self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, accuracy=10)
        row = self._row()
        self.assertAlmostEqual(row.location_lat, FAR_LAT, places=3)
        self.assertAlmostEqual(row.location_lng, FAR_LNG, places=3)

    def test_at_home_is_verified_and_needs_no_review(self):
        self._home()
        resp = self._check_in(latitude=HOME_LAT, longitude=HOME_LNG, accuracy=15)
        self.assertIn(resp.status_code, (200, 201))
        row = self._row()
        self.assertTrue(row.geo_verified)
        self.assertTrue(row.is_wfh)
        self.assertEqual(row.location_status, '')

    def test_a_poor_fix_widens_the_home_fence_rather_than_flagging_someone(self):
        """A ±300 m reading at the kitchen table must not read as 'away'."""
        self._home()
        resp = self._check_in(latitude=HOME_LAT + 0.0018, longitude=HOME_LNG,
                              accuracy=300)
        self.assertIn(resp.status_code, (200, 201))
        self.assertTrue(self._row().geo_verified)

    # ── no home on file: allowed, but not verified ───────────────────────
    def test_without_a_registered_home_the_check_in_still_works(self):
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))

    def test_without_a_registered_home_the_day_is_not_verified(self):
        self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        row = self._row()
        self.assertTrue(row.is_wfh)
        self.assertFalse(row.geo_verified,
                         'nothing was checked, so nothing may be claimed as verified')

    def test_an_unconfirmed_home_behaves_as_none(self):
        self._home(status=GeoFence.PENDING)
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.assertFalse(self._row().geo_verified)

    # ── the approval round trip ──────────────────────────────────────────
    def test_a_reason_sends_it_for_approval(self):
        self._home()
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, accuracy=10,
                              locationReason='At my parents this week')
        self.assertEqual(resp.status_code, 202)
        row = self._row()
        self.assertEqual(row.location_status, 'Pending')
        self.assertIsNone(row.check_in, 'not checked in until approved')

    def test_a_pending_request_blocks_a_second_attempt(self):
        self._home()
        self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, locationReason='x y z')
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertEqual(resp.status_code, 409)

    def test_approval_lets_the_check_in_through(self):
        self._home()
        self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, locationReason='x y z')
        row = self._row()
        row.location_status = 'Approved'
        row.save()
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))
        row.refresh_from_db()
        self.assertTrue(row.geo_verified)
        self.assertIsNotNone(row.check_in)

    def test_a_rejection_is_binding(self):
        self._home()
        row = EmployeeAttendance.objects.create(
            email=self.email, date=local_today(), location_status='Rejected',
            location_reason='x', location_reviewer='hr@x.com')
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json().get('code'), 'LOCATION_APPROVAL_REJECTED')

    def test_a_rejected_employee_can_still_check_in_from_home(self):
        """The refusal points at going home, so that has to work."""
        self._home()
        EmployeeAttendance.objects.create(
            email=self.email, date=local_today(), location_status='Rejected',
            location_reason='x', location_reviewer='hr@x.com')
        resp = self._check_in(latitude=HOME_LAT, longitude=HOME_LNG, accuracy=15)
        self.assertIn(resp.status_code, (200, 201))


class ClientSignalTests(TestCase):
    """The two flags the check-in client needs to show the right thing.

    Without them the employee-facing half of this feature cannot work: nobody
    would ever be offered the chance to register a home, so no home would ever
    exist, and every work-from-home day would stay unverified forever.
    """

    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='employee')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)
        today = local_today()
        WfhRequest.objects.create(email=self.email, from_date=today, to_date=today,
                                  days=1, status='Approved')

    def _check_in(self, **extra):
        payload = {'email': self.email, 'employee': 'Test Person', 'isWfh': True}
        payload.update(extra)
        return self.client.post('/api/attendance/check-in', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def test_a_wfh_check_in_with_no_home_asks_the_client_to_offer_one(self):
        resp = self._check_in(latitude=HOME_LAT, longitude=HOME_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.assertTrue(resp.json().get('homeLocationMissing'))

    def test_the_check_in_succeeds_regardless(self):
        """The prompt is an offer, not a gate — attendance must not depend on
        answering a question about where you live."""
        self._check_in(latitude=HOME_LAT, longitude=HOME_LNG)
        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertIsNotNone(row.check_in)

    def test_the_offer_stops_once_a_home_is_confirmed(self):
        GeoFence.objects.create(
            name='Home', latitude=HOME_LAT, longitude=HOME_LNG, radius_meters=150,
            owner_email=self.email, status=GeoFence.APPROVED)
        resp = self._check_in(latitude=HOME_LAT, longitude=HOME_LNG, accuracy=15)
        self.assertNotIn('homeLocationMissing', resp.json())

    def test_the_offer_continues_while_the_home_is_only_pending(self):
        """Still unverifiable, so still worth prompting if they cancelled
        halfway — but the client remembers a decline, so this does not nag."""
        GeoFence.objects.create(
            name='Home', latitude=HOME_LAT, longitude=HOME_LNG, radius_meters=150,
            owner_email=self.email, status=GeoFence.PENDING)
        resp = self._check_in(latitude=HOME_LAT, longitude=HOME_LNG)
        self.assertTrue(resp.json().get('homeLocationMissing'))

    def test_an_office_check_in_is_never_offered_a_home_prompt(self):
        WfhRequest.objects.filter(email=self.email).delete()
        resp = self.client.post(
            '/api/attendance/check-in',
            data={'email': self.email, 'employee': 'T', 'latitude': OFFICE_LAT,
                  'longitude': OFFICE_LNG},
            content_type='application/json', HTTP_X_USER_EMAIL=self.email)
        self.assertNotIn('homeLocationMissing', resp.json())

    def test_the_away_from_home_refusal_is_flagged_as_the_home_case(self):
        """So the dialog does not tell someone working from home that they are
        outside the office."""
        GeoFence.objects.create(
            name='Home', latitude=HOME_LAT, longitude=HOME_LNG, radius_meters=150,
            owner_email=self.email, status=GeoFence.APPROVED)
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, accuracy=10)
        self.assertEqual(resp.status_code, 422)
        self.assertTrue(resp.json().get('isWfh'))

    def test_the_office_refusal_is_not_flagged_as_the_home_case(self):
        WfhRequest.objects.filter(email=self.email).delete()
        resp = self.client.post(
            '/api/attendance/check-in',
            data={'email': self.email, 'employee': 'T', 'latitude': FAR_LAT,
                  'longitude': FAR_LNG, 'accuracy': 10},
            content_type='application/json', HTTP_X_USER_EMAIL=self.email)
        self.assertEqual(resp.status_code, 422)
        self.assertFalse(resp.json().get('isWfh'))


class HomeRegistrationTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='employee')
        self.hr = 'hrm@example.com'
        AppUser.objects.create(
            email=self.hr, status='active', role='employee',
            role_ref=Role.objects.filter(name='HR Manager').first())

    def _register(self, who=None, **body):
        body.setdefault('email', self.email)
        body.setdefault('latitude', HOME_LAT)
        body.setdefault('longitude', HOME_LNG)
        return self.client.post('/api/attendance/home-locations', data=body,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=who or self.email)

    def _review(self, fid, decision, who=None):
        return self.client.post('/api/attendance/home-locations/review',
                                data={'id': fid, 'decision': decision},
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=who or self.hr)

    def test_an_employee_registers_their_own_home(self):
        resp = self._register(accuracy=20)
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['status'], 'Pending')

    def test_a_freshly_registered_home_verifies_nothing_yet(self):
        self._register(accuracy=20)
        self.assertIsNone(home_fence_for(self.email))

    def test_confirming_makes_it_a_verification_basis(self):
        fid = self._register(accuracy=20).json()['id']
        self.assertEqual(self._review(fid, 'Approved').status_code, 200)
        self.assertIsNotNone(home_fence_for(self.email))

    def test_a_vague_fix_is_refused_at_registration(self):
        """Registering a ±5 km 'home' would cover a whole district and verify
        nothing, while looking confirmed."""
        resp = self._register(accuracy=5000)
        self.assertEqual(resp.status_code, 400)
        self.assertIn('too vague', resp.json().get('message', ''))

    def test_replacing_a_home_re_opens_the_approval(self):
        """A move must not inherit the confirmation given to the old address."""
        fid = self._register(accuracy=20).json()['id']
        self._review(fid, 'Approved')
        self._register(accuracy=20, latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIsNone(home_fence_for(self.email))
        self.assertEqual(GeoFence.objects.filter(owner_email=self.email).count(), 1)

    def test_an_employee_cannot_register_someone_elses_home(self):
        AppUser.objects.create(email='victim@x.com', status='active', role='employee')
        resp = self._register(who=self.email, email='victim@x.com')
        self.assertEqual(resp.status_code, 403)

    def test_an_employee_cannot_confirm_their_own_home(self):
        """The whole safeguard: capture is self-service, confirmation is not."""
        fid = self._register(accuracy=20).json()['id']
        self.assertEqual(self._review(fid, 'Approved', who=self.email).status_code, 403)
        self.assertIsNone(home_fence_for(self.email))

    def test_rejecting_leaves_it_unusable(self):
        fid = self._register(accuracy=20).json()['id']
        self._review(fid, 'Rejected')
        self.assertIsNone(home_fence_for(self.email))

    def test_the_review_endpoint_will_not_touch_a_company_fence(self):
        office = GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                         longitude=OFFICE_LNG, radius_meters=200)
        self.assertEqual(self._review(office.id, 'Approved').status_code, 404)
        office.refresh_from_db()
        self.assertEqual(office.status, '')
