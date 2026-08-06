"""Out-of-geofence check-in: warn, capture a reason, hold for HR.

Agreed behaviour:
  * working from home  -> always allowed, no review
  * inside a fence     -> allowed, no review
  * outside a fence    -> NOT checked in; a reason is captured and HR must
                          approve before the employee can check in
  * no fences defined  -> nothing to enforce
  * past the shift's overtime threshold -> the employee is emailed once
"""
import os
import sys
from datetime import date, timedelta
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import (AppUser, EmployeeAttendance, GeoFence, Shift,
                        WfhRequest)
from api.timeutil import local_today

OFFICE_LAT, OFFICE_LNG = 17.4485, 78.3908           # inside the fence below
FAR_LAT, FAR_LNG = 12.9716, 77.5946                 # ~500 km away


class OutOfGeofenceCheckInTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='admin')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)

    def _check_in(self, **extra):
        payload = {'email': self.email, 'employee': 'Test Person'}
        payload.update(extra)
        return self.client.post('/api/attendance/check-in', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def test_inside_the_fence_is_verified_and_needs_no_review(self):
        resp = self._check_in(latitude=OFFICE_LAT, longitude=OFFICE_LNG)
        self.assertIn(resp.status_code, (200, 201))

        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertTrue(row.geo_verified)
        self.assertEqual(row.location_status, '')

    def test_outside_the_fence_without_a_reason_asks_for_one(self):
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)

        self.assertEqual(resp.status_code, 422)
        self.assertEqual(resp.json()['code'], 'LOCATION_REASON_REQUIRED')
        self.assertFalse(
            EmployeeAttendance.objects.filter(email=self.email).exclude(check_in=None).exists(),
            'the check-in must not be stamped until a reason is supplied',
        )

    def test_outside_the_fence_with_a_reason_requests_approval_only(self):
        """Agreed flow: HR approves first, the employee checks in afterwards."""
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG,
                              locationReason='Client visit in Bengaluru')
        self.assertEqual(resp.status_code, 202)
        self.assertEqual(resp.json()['code'], 'LOCATION_APPROVAL_REQUESTED')

        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertIsNone(row.check_in, 'must not be checked in before approval')
        self.assertEqual(row.location_status, 'Pending')
        self.assertEqual(row.location_reason, 'Client visit in Bengaluru')
        self.assertFalse(row.geo_verified)

    def test_a_second_attempt_while_pending_is_refused(self):
        self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, locationReason='Client visit')
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()['code'], 'LOCATION_APPROVAL_PENDING')

    def test_after_approval_the_employee_can_check_in(self):
        self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, locationReason='Client visit')
        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        row.location_status = 'Approved'
        row.save(update_fields=['location_status'])

        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))

        row.refresh_from_db()
        self.assertIsNotNone(row.check_in, 'approval must let the check-in through')
        self.assertTrue(row.geo_verified)

    def test_a_poor_gps_fix_is_given_the_benefit_of_the_doubt(self):
        """A WiFi/IP position can be a kilometre out; someone at their desk must
        not be told they are off-site because of it."""
        resp = self._check_in(latitude=OFFICE_LAT + 0.005, longitude=OFFICE_LNG,
                              accuracy=1200)
        self.assertIn(resp.status_code, (200, 201))

        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertTrue(row.geo_verified)

    def test_an_accurate_fix_outside_the_fence_still_asks(self):
        resp = self._check_in(latitude=OFFICE_LAT + 0.005, longitude=OFFICE_LNG,
                              accuracy=25)
        self.assertEqual(resp.status_code, 422)
        body = resp.json()
        self.assertIsNotNone(body['distance'], 'the employee must be told how far out they are')
        self.assertEqual(body['fence'], 'HQ')

    def test_a_missing_position_does_not_keep_yesterdays_coordinates(self):
        EmployeeAttendance.objects.create(
            email=self.email, date=local_today(),
            location_lat=OFFICE_LAT, location_lng=OFFICE_LNG,
        )
        resp = self._check_in()          # no position at all
        self.assertEqual(resp.status_code, 422)

        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertIsNone(row.location_lat, 'a stale fix makes an unverified day look measured')

    def test_wfh_is_exempt_even_far_from_every_fence(self):
        WfhRequest.objects.create(
            email=self.email, status='Approved',
            from_date=local_today(), to_date=local_today(), days=1,
        )
        resp = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG)

        self.assertIn(resp.status_code, (200, 201))
        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertTrue(row.is_wfh)
        self.assertTrue(row.geo_verified)
        self.assertEqual(row.location_status, '', 'WFH must never need approval')

    def test_no_position_from_the_browser_is_treated_as_outside(self):
        """A denied geolocation prompt cannot be told apart from being away."""
        self.assertEqual(self._check_in().status_code, 422)

    def test_nothing_is_enforced_until_a_fence_exists(self):
        GeoFence.objects.all().delete()
        resp = self._check_in()

        self.assertIn(resp.status_code, (200, 201))
        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertEqual(row.location_status, '')


class LocationReviewQueueTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.hr = 'hr@example.com'
        AppUser.objects.create(email=self.hr, status='active', role='admin')
        self.row = EmployeeAttendance.objects.create(
            email='employee@example.com', employee_name='Test Person',
            date=local_today(), location_status='Pending',
            location_reason='Client visit', geo_verified=False,
        )

    def test_pending_rows_appear_in_the_queue(self):
        resp = self.client.get('/api/attendance/location-reviews',
                               HTTP_X_USER_EMAIL=self.hr)
        self.assertEqual(resp.status_code, 200)
        rows = resp.json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['reason'], 'Client visit')

    def test_approving_verifies_the_day(self):
        resp = self.client.post(
            '/api/attendance/location-reviews',
            data={'id': self.row.id, 'decision': 'Approved'},
            content_type='application/json', HTTP_X_USER_EMAIL=self.hr,
        )
        self.assertEqual(resp.status_code, 200)

        self.row.refresh_from_db()
        self.assertEqual(self.row.location_status, 'Approved')
        self.assertTrue(self.row.geo_verified)
        self.assertEqual(self.row.location_reviewer, self.hr)

    def test_rejecting_records_the_decision_without_verifying(self):
        self.client.post(
            '/api/attendance/location-reviews',
            data={'id': self.row.id, 'decision': 'Rejected', 'note': 'Not approved'},
            content_type='application/json', HTTP_X_USER_EMAIL=self.hr,
        )
        self.row.refresh_from_db()
        self.assertEqual(self.row.location_status, 'Rejected')
        self.assertFalse(self.row.geo_verified)

    def test_a_bad_decision_is_refused(self):
        resp = self.client.post(
            '/api/attendance/location-reviews',
            data={'id': self.row.id, 'decision': 'Maybe'},
            content_type='application/json', HTTP_X_USER_EMAIL=self.hr,
        )
        self.assertEqual(resp.status_code, 400)

    def test_an_anonymous_caller_cannot_review(self):
        resp = self.client.post(
            '/api/attendance/location-reviews',
            data={'id': self.row.id, 'decision': 'Approved'},
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 401)


class LongDayAlertTests(TestCase):
    """Past the shift's overtime threshold the employee gets one email."""

    def setUp(self):
        self.shift = Shift.objects.create(name='Test Shift', overtime_after_minutes=540)
        self.row = EmployeeAttendance.objects.create(
            email='employee@example.com', employee_name='Test Person',
            date=local_today(), worked_minutes=600,      # 10h
        )

    def _run(self):
        from api.views import _maybe_send_long_day_alert
        with patch('api.mailer.send_email', return_value={'ok': True}) as sent:
            _maybe_send_long_day_alert(self.row, self.shift)
        return sent

    def test_an_email_goes_out_past_the_threshold(self):
        sent = self._run()
        sent.assert_called_once()
        self.assertIn('10h 0m', sent.call_args.kwargs['subject'])

        self.row.refresh_from_db()
        self.assertIsNotNone(self.row.overtime_alert_sent_at)

    def test_it_is_sent_at_most_once_a_day(self):
        self._run()
        second = self._run()
        second.assert_not_called()

    def test_a_normal_day_sends_nothing(self):
        self.row.worked_minutes = 480          # 8h
        self.row.save(update_fields=['worked_minutes'])
        self._run().assert_not_called()

    def test_a_mail_failure_never_breaks_check_out(self):
        from api.views import _maybe_send_long_day_alert
        with patch('api.mailer.send_email', side_effect=RuntimeError('SMTP down')):
            _maybe_send_long_day_alert(self.row, self.shift)   # must not raise
        self.row.refresh_from_db()
        self.assertIsNone(self.row.overtime_alert_sent_at)
