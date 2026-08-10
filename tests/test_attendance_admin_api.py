"""The payloads hrms-attendance-admin.js posts must be accepted as-is.

The admin UI is a sidecar hand-written against these endpoints, so nothing but
a test keeps the two in step. Each case sends exactly what the browser sends.
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import AppUser, GeoFence, Shift, ShiftAssignment


class AttendanceAdminApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.admin = 'admin@example.com'
        AppUser.objects.create(email=self.admin, status='active', role='admin')

    def _post(self, url, payload):
        return self.client.post(url, data=payload, content_type='application/json',
                                HTTP_X_USER_EMAIL=self.admin)

    def test_creating_a_geofence(self):
        resp = self._post('/api/attendance/geofences', {
            'name': 'Head Office', 'latitude': 17.4485, 'longitude': 78.3908,
            'radiusMeters': 200, 'radius_meters': 200,
        })
        self.assertEqual(resp.status_code, 201, resp.content[:300])

        fence = GeoFence.objects.get(name='Head Office')
        self.assertEqual(fence.radius_meters, 200)
        self.assertTrue(fence.is_active)

    def test_listing_geofences(self):
        GeoFence.objects.create(name='HQ', latitude=1.0, longitude=2.0, radius_meters=150)
        resp = self.client.get('/api/attendance/geofences', HTTP_X_USER_EMAIL=self.admin)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 1)

    def test_deleting_a_geofence(self):
        fence = GeoFence.objects.create(name='Old', latitude=1.0, longitude=2.0)
        resp = self.client.delete(f'/api/attendance/geofences/{fence.id}',
                                  HTTP_X_USER_EMAIL=self.admin)
        self.assertIn(resp.status_code, (200, 204))
        self.assertFalse(GeoFence.objects.filter(id=fence.id).exists())

    def test_creating_a_shift(self):
        resp = self._post('/api/shifts', {
            'name': 'Morning Shift',
            'startTime': '09:00', 'start_time': '09:00',
            'endTime': '18:00', 'end_time': '18:00',
            'graceMinutes': 15, 'grace_minutes': 15,
            'overtimeAfterMinutes': 540, 'overtime_after_minutes': 540,
        })
        self.assertEqual(resp.status_code, 201, resp.content[:300])

        shift = Shift.objects.get(name='Morning Shift')
        self.assertEqual(shift.overtime_after_minutes, 540)
        self.assertEqual(shift.grace_minutes, 15)

    def test_assigning_a_shift_to_an_employee(self):
        shift = Shift.objects.create(name='Night', overtime_after_minutes=540)
        resp = self._post('/api/shift-assignments', {
            'email': 'person@example.com',
            'shift': shift.id, 'shiftId': shift.id,
            'effectiveFrom': '2026-08-01', 'effective_from': '2026-08-01',
            'effectiveTo': None, 'effective_to': None,
        })
        self.assertEqual(resp.status_code, 201, resp.content[:300])

        asg = ShiftAssignment.objects.get(email='person@example.com')
        self.assertEqual(asg.shift_id, shift.id)
        self.assertIsNone(asg.effective_to)

    def test_an_assigned_shift_wins_over_the_default(self):
        """The whole point of assignment: it must drive late/overtime maths."""
        from api.views import _get_active_shift
        from datetime import date

        shift = Shift.objects.create(name='Late Shift', overtime_after_minutes=480)
        ShiftAssignment.objects.create(email='person@example.com', shift=shift,
                                       effective_from=date(2026, 1, 1))

        active = _get_active_shift('person@example.com', date(2026, 8, 6))
        self.assertEqual(active.id, shift.id)
        self.assertEqual(active.overtime_after_minutes, 480)

    def test_the_default_shift_is_usable_when_nobody_is_assigned(self):
        """Regression: the fallback used to be built with string times, so
        datetime.combine() raised TypeError on the very first check-in."""
        from api.views import _get_active_shift
        from datetime import date, datetime

        active = _get_active_shift('nobody@example.com', date(2026, 8, 6))
        combined = datetime.combine(date(2026, 8, 6), active.start_time)
        self.assertEqual(combined.hour, 9)

    def test_admin_endpoints_reject_an_anonymous_caller(self):
        self.assertEqual(
            self.client.post('/api/attendance/geofences',
                             data={'name': 'X', 'latitude': 1, 'longitude': 2},
                             content_type='application/json').status_code,
            401,
        )
