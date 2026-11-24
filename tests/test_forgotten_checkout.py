"""Forgot to check out — on any shift, from anywhere — with automatic
check-out removed.

A night shift (18:00–02:30) left open stays closable until the next shift's
check-in window opens (14:00 next day): working late still counts. After
that it must not block the next check-in, and a plain check-out must not
close it "now" (≈21+ h). It is a missed punch: flagged, and closed only through
a regularization with the real time. Being outside the office geofence never
closes anything; a manual check-out from outside still works.
"""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, EmployeeAttendance, GeoFence, Shift, ShiftAssignment

OFFICE = (17.4485, 78.3908)
TOWN = (17.5300, 78.5000)        # ~13 km away
MON = date(2026, 11, 2)
TUE = MON + timedelta(days=1)


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()), \
         patch('api.attendance_ext.missed_punch.local_now', return_value=dt, create=True):
        yield


class ForgottenCheckoutTests(TestCase):
    def setUp(self):
        self.email = 'shift@example.com'
        AppUser.objects.create(email=self.email, full_name='Shift Worker', status='active', role='admin')
        GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        self.night = Shift.objects.create(name='Night', start_time=time(18, 0), end_time=time(2, 30), grace_minutes=15,
                                          break_minutes=0, is_night_shift=True, overtime_after_minutes=540)
        ShiftAssignment.objects.create(email=self.email, shift=self.night, effective_from=MON - timedelta(days=30))
        self.c = Client(HTTP_X_USER_EMAIL=self.email)

    def post(self, path, **body):
        return self.c.post(path, {'email': self.email, **body}, content_type='application/json')

    def check_in(self, pos=OFFICE):
        return self.post('/api/attendance/check-in', employee='Shift Worker', latitude=pos[0], longitude=pos[1])

    def check_out(self, pos=OFFICE):
        return self.post('/api/attendance/check-out', latitude=pos[0], longitude=pos[1])

    def mon(self):
        return EmployeeAttendance.objects.get(email=self.email, date=MON)

    def test_checkout_inside_the_night_shift_still_closes_it(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.assertEqual(self.check_in().status_code, 201)
        with at(datetime(2026, 11, 3, 2, 40)):                     # just after 02:30 end
            r = self.check_out()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.mon().check_out, datetime(2026, 11, 3, 2, 40))

    def test_out_of_range_never_closes_and_manual_checkout_from_outside_works(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        for k in range(0, 90, 10):                                 # 90 min outside the fence
            with at(datetime(2026, 11, 2, 20, 0) + timedelta(minutes=k)):
                self.c.get(f'/api/attendance/geofence-check?email={self.email}&latitude={TOWN[0]}&longitude={TOWN[1]}&accuracy=20')
        self.assertIsNone(self.mon().check_out)                    # nothing automatic
        with at(datetime(2026, 11, 3, 1, 0)):
            r = self.check_out(TOWN)                               # leaves from outside, checks out himself
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNotNone(self.mon().check_out)

    def test_forgotten_night_shift_does_not_block_next_check_in(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        # Tuesday 17:55 — Monday's shift ended long ago, never checked out.
        with at(datetime(2026, 11, 3, 17, 55)):
            r = self.check_in()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(EmployeeAttendance.objects.filter(email=self.email, date=TUE, check_in__isnull=False).exists())
        self.assertIsNone(self.mon().check_out)                    # Monday stays for regularization

    def test_late_checkout_of_a_forgotten_shift_is_refused_not_stamped_now(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        with at(datetime(2026, 11, 3, 15, 0)):                     # next afternoon: next shift's window is open
            r = self.check_out()
        self.assertEqual(r.status_code, 409)
        d = r.json()
        self.assertEqual((d['code'], d['date']), ('SESSION_EXPIRED', '2026-11-02'))
        self.assertIn('regularize=2026-11-02', d['regularizeUrl'])
        self.assertIsNone(self.mon().check_out)                    # no 21-hour day invented

    def test_working_late_after_a_night_shift_still_counts(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        with at(datetime(2026, 11, 3, 9, 0)):                      # stayed until 09:00
            r = self.check_out()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.mon().worked_minutes, 15 * 60)

    def test_within_the_grace_after_shift_end_it_is_still_open(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        with at(datetime(2026, 11, 3, 5, 0)):                      # 02:30 + 4 h tail not over yet
            r = self.check_in()
        self.assertEqual((r.status_code, r.json()['code']), (409, 'ALREADY_CHECKED_IN'))

    def test_forgotten_day_shift_is_refused_next_morning(self):
        day = Shift.objects.create(name='Day', start_time=time(9, 0), end_time=time(18, 0), grace_minutes=15,
                                   break_minutes=60, is_night_shift=False, overtime_after_minutes=540)
        ShiftAssignment.objects.filter(email=self.email).update(shift=day)
        with at(datetime(2026, 11, 2, 9, 0)):
            self.check_in()
        with at(datetime(2026, 11, 3, 8, 50)):                     # before checking in on Tuesday
            r = self.check_out()
        self.assertEqual((r.status_code, r.json()['code']), (409, 'SESSION_EXPIRED'))
        with at(datetime(2026, 11, 3, 9, 0)):
            self.assertEqual(self.check_in().status_code, 201)
