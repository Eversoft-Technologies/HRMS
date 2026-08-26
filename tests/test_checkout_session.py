"""Checking out requires a session that is actually open.

Only the missing-row case was caught. A row with check_in still NULL was
accepted, and that row shape is not hypothetical — it is exactly what a
geofence-refused attempt leaves behind: the position is recorded so HR can see
where the person was, but the check-in never happened. Closing it stamped a
check-out with no check-in, and worked minutes are computed from that pair.

The client half matters too: when the toggle and the server disagree, the
answer is to re-read the server, not to argue. Rolling back locally restores
what the client believed, which is the thing that was wrong.
"""
import os
import sys
from datetime import datetime, timedelta, time
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import AppUser, EmployeeAttendance, GeoFence, Shift
from api.timeutil import local_now, local_today

OFFICE_LAT, OFFICE_LNG = 17.4485, 78.3908
FAR_LAT, FAR_LNG = 12.9716, 77.5946


class CheckOutSessionTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='admin')

    def _check_out(self):
        return self.client.post('/api/attendance/check-out',
                                data={'email': self.email},
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def _check_in(self, **extra):
        payload = {'email': self.email, 'employee': 'Test Person'}
        payload.update(extra)
        return self.client.post('/api/attendance/check-in', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def _row(self):
        return EmployeeAttendance.objects.filter(
            email=self.email, date=local_today()).first()

    def test_no_row_at_all_is_refused(self):
        r = self._check_out()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json().get('code'), 'NO_OPEN_SESSION')

    def test_a_row_with_no_check_in_is_refused(self):
        """The bug: this returned 200 and stamped a close."""
        EmployeeAttendance.objects.create(
            email=self.email, date=local_today(), location_lat=1.0, location_lng=1.0)
        r = self._check_out()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json().get('code'), 'NO_OPEN_SESSION')

    def test_a_refused_check_out_leaves_the_row_untouched(self):
        EmployeeAttendance.objects.create(
            email=self.email, date=local_today(), location_lat=1.0, location_lng=1.0)
        self._check_out()
        row = self._row()
        self.assertIsNone(row.check_in)
        self.assertIsNone(row.check_out,
                          'a session that never opened must not acquire a close')

    def test_the_row_left_by_a_geofence_refusal_cannot_be_checked_out(self):
        """End to end through the real refusal path, not a hand-made row."""
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)
        refused = self._check_in(latitude=FAR_LAT, longitude=FAR_LNG, accuracy=10)
        self.assertEqual(refused.status_code, 422, 'precondition: the fence refuses')
        self.assertIsNotNone(self._row(), 'precondition: the position was recorded')

        r = self._check_out()
        self.assertEqual(r.status_code, 409)
        self.assertIsNone(self._row().check_out)

    def test_a_real_session_still_checks_out(self):
        self._check_in()
        self.assertIsNotNone(self._row().check_in, 'precondition: checked in')
        self.assertIn(self._check_out().status_code, (200, 201))
        self.assertIsNotNone(self._row().check_out)

    def test_night_shift_can_check_out_after_midnight(self):
        today = local_today()
        yesterday = today - timedelta(days=1)
        shift = Shift.objects.create(
            name='Night Shift', start_time=time(22, 0), end_time=time(6, 0),
            is_night_shift=True, overtime_after_minutes=480,
        )
        row = EmployeeAttendance.objects.create(
            email=self.email, employee_name='Test Person', date=yesterday,
            check_in=datetime.combine(yesterday, time(22, 0)),
            shift_id=shift.id,
        )
        checkout_time = datetime.combine(today, time(6, 0))
        with patch('api.views.local_now', return_value=checkout_time):
            response = self._check_out()

        self.assertIn(response.status_code, (200, 201))
        row.refresh_from_db()
        self.assertEqual(row.id, response.json()['id'])
        self.assertEqual(row.date, yesterday)
        self.assertEqual(row.check_out, checkout_time)
        self.assertEqual(row.worked_minutes, 480)
        self.assertFalse(EmployeeAttendance.objects.filter(
            email=self.email, date=today
        ).exclude(pk=row.pk).exists())

    def test_checking_out_twice_is_refused(self):
        self._check_in()
        self._check_out()
        first_close = self._row().check_out
        r = self._check_out()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self._row().check_out, first_close,
                         'the original close time must not be overwritten')

    def test_the_refusal_tells_the_client_the_truth_about_the_state(self):
        """The client uses this to correct its toggle rather than guess."""
        r = self._check_out()
        self.assertIs(r.json().get('checkedIn'), False)

    def test_the_refusal_is_not_mistakable_for_an_hr_approval_wait(self):
        """Both are 409. The client matches on the code, so the codes must
        differ — otherwise someone is sent chasing an approval that does not
        exist."""
        self.assertNotEqual(self._check_out().json().get('code'),
                            'LOCATION_APPROVAL_PENDING')
