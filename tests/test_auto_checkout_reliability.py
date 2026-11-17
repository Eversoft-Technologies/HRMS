"""Automatic check-out only on the server's own evidence.

The browser watcher used to count "strikes" itself: a throttled or sleeping
tab, a network reconnect or a second open tab could add them up and close a
session nobody had left. Now geofence-check keeps an unbroken outside run on
the session, and an auto check-out is accepted only when that run is at least
the departure timeout long and its last reading is fresh.
"""
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, EmployeeAttendance, GeoFence

OFFICE = (13.1500, 78.5100)
NEAR = (13.1505, 78.5102)        # inside
TOWN = (13.2300, 78.5600)        # ~10 km away
NOON = datetime(2026, 11, 2, 12, 0)


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()):
        yield


class AutoCheckoutReliabilityTests(TestCase):
    def setUp(self):
        self.email = 'reliable@example.com'
        AppUser.objects.create(email=self.email, full_name='Reliable', status='active', role='admin')
        GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        EmployeeAttendance.objects.create(email=self.email, date=date(2026, 11, 2), check_in=datetime(2026, 11, 2, 9, 0),
                                          location_lat=OFFICE[0], location_lng=OFFICE[1], geo_verified=True)
        self.c = Client(HTTP_X_USER_EMAIL=self.email)

    def geocheck(self, pos, when, acc=30):
        with at(when):
            return self.c.get(f'/api/attendance/geofence-check?email={self.email}'
                              f'&latitude={pos[0]}&longitude={pos[1]}&accuracy={acc}').json()

    def auto_out(self, when=NOON, auto='geofence_departure'):
        with at(when):
            return self.c.post('/api/attendance/check-out', {'email': self.email, 'auto': auto, 'outside_minutes': 15},
                               content_type='application/json')

    def row(self):
        return EmployeeAttendance.objects.get(email=self.email)

    def test_no_outside_run_no_auto_checkout(self):
        r = self.auto_out()
        self.assertEqual((r.status_code, r.json()['code']), (409, 'AUTO_CHECKOUT_UNCONFIRMED'))
        self.assertIsNone(self.row().check_out)

    def test_a_short_run_is_not_enough(self):
        for m in (55, 50):                                   # 10 minutes outside
            self.geocheck(TOWN, NOON - timedelta(minutes=60 - m))
        r = self.auto_out()
        self.assertEqual(r.status_code, 409)
        self.assertIsNone(self.row().check_out)

    def test_a_sleep_gap_restarts_the_run(self):
        # outside before the laptop slept, outside again after waking 2 hours later
        self.geocheck(TOWN, datetime(2026, 11, 2, 9, 30))
        self.geocheck(TOWN, datetime(2026, 11, 2, 9, 35))
        self.geocheck(TOWN, datetime(2026, 11, 2, 11, 55))
        self.assertEqual(self.row().outside_since, datetime(2026, 11, 2, 11, 55))
        self.assertEqual(self.auto_out().status_code, 409)

    def test_stale_run_does_not_count(self):
        for k in (30, 25, 20, 15):
            self.geocheck(TOWN, NOON - timedelta(minutes=k))
        # last reading 15 min ago: the tab stopped sampling (sleep / no network)
        self.assertEqual(self.auto_out().status_code, 409)

    def test_back_inside_clears_the_run(self):
        for k in (20, 15, 10):
            self.geocheck(TOWN, NOON - timedelta(minutes=k))
        self.geocheck(NEAR, NOON - timedelta(minutes=5))
        self.assertIsNone(self.row().outside_since)
        self.assertEqual(self.auto_out().status_code, 409)

    def test_vague_readings_neither_extend_nor_clear(self):
        self.geocheck(TOWN, NOON - timedelta(minutes=15))
        self.geocheck(TOWN, NOON - timedelta(minutes=10), acc=3000)  # vague fix outside: uncertain, run untouched
        self.geocheck(TOWN, NOON - timedelta(minutes=5))
        self.assertEqual(self.row().outside_since, NOON - timedelta(minutes=15))

    def test_a_real_departure_checks_out_with_measured_minutes(self):
        for k in (20, 15, 10, 5):
            self.geocheck(TOWN, NOON - timedelta(minutes=k))
        r = self.auto_out()
        self.assertEqual(r.status_code, 200, r.content)
        row = self.row()
        self.assertIsNotNone(row.auto_checkout_at)
        self.assertIn('>20 minutes', row.note)
        self.assertIsNone(row.outside_since)                 # cleared with the session

    def test_generic_true_flag_is_a_manual_checkout_not_an_auto_one(self):
        r = self.auto_out(auto='true')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(self.row().auto_checkout_at)
