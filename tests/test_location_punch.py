"""Hourly location punches and the leave-the-office watcher.

Someone sitting at the same desk all evening was logged in two towns, and
nothing told them. Punches now: label coarse readings "Approximate", compare a
precise reading with where the session started and alert the employee when
it is clearly elsewhere, and work after midnight on a night shift. The
departure watcher never counts a coarse fix, never auto-closes an approved
off-site day, and tells the employee through the bell.
"""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import (AppUser, AttendanceLocationPunch, EmployeeAttendance, GeoFence,
                        Notification, Shift, ShiftAssignment)

OFFICE = (13.1500, 78.5100)            # an office fence, 200 m
NEAR = (13.1505, 78.5102)              # ~60 m away: inside
TOWN = (13.2300, 78.5600)              # ~10 km away
DAY = date(2026, 11, 2)


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()):
        yield


class LocationPunchTests(TestCase):
    def setUp(self):
        self.email = 'punch@example.com'
        AppUser.objects.create(email=self.email, full_name='Punch Tester', status='active', role='admin')
        self.fence = GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        self.c = Client(HTTP_X_USER_EMAIL=self.email)

    def session(self, **kw):
        base = dict(email=self.email, date=DAY, check_in=datetime(2026, 11, 2, 9, 0),
                    location_lat=OFFICE[0], location_lng=OFFICE[1], geo_verified=True)
        base.update(kw)
        return EmployeeAttendance.objects.create(**base)

    def punch(self, pos, acc, label='Somewhere, AP', when=datetime(2026, 11, 2, 12, 0)):
        with at(when):
            return self.c.post('/api/attendance/location-punch', {
                'email': self.email, 'latitude': pos[0], 'longitude': pos[1],
                'accuracy': acc, 'label': label}, content_type='application/json').json()

    def alerts(self, title):
        return Notification.objects.filter(recipient=self.email, title=title).count()

    # ── punches ──────────────────────────────────────────────────────────
    def test_coarse_reading_is_labelled_approximate_and_never_alerts(self):
        self.session()
        r = self.punch(TOWN, 3000, label='Punganuru, Andhra Pradesh')
        self.assertTrue(r['stored'])
        self.assertEqual((r['state'], r['approximate']), ('uncertain', True))
        p = AttendanceLocationPunch.objects.get()
        self.assertTrue(p.label.startswith('Approximate location (±3.0 km)'), p.label)
        self.assertEqual(self.alerts('Location check: you appear to be elsewhere'), 0)
        rows = self.c.get(f'/api/attendance/location-punch?email={self.email}&date=2026-11-02').json()
        self.assertTrue(rows[0]['approximate'])

    def test_precise_reading_at_the_office_is_fine(self):
        self.session()
        r = self.punch(NEAR, 25, label='Brahmadevam, Andhra Pradesh')
        self.assertEqual(r['state'], 'ok')
        self.assertEqual(AttendanceLocationPunch.objects.get().label, 'Brahmadevam, Andhra Pradesh')
        self.assertEqual(self.alerts('Location check: you appear to be elsewhere'), 0)

    def test_precise_reading_far_away_alerts_the_employee(self):
        self.session()
        r = self.punch(TOWN, 30)
        self.assertEqual(r['state'], 'away')
        self.assertIn('from HQ', r['message'])
        self.assertEqual(self.alerts('Location check: you appear to be elsewhere'), 1)

    def test_offsite_day_is_measured_from_the_check_in_spot(self):
        home = (13.3000, 78.6000)
        self.session(location_lat=home[0], location_lng=home[1], geo_verified=True, location_status='Approved')
        self.assertEqual(self.punch((home[0] + 0.0005, home[1]), 30)['state'], 'ok')       # ~55 m
        r = self.punch(TOWN, 30, when=datetime(2026, 11, 2, 13, 0))
        self.assertEqual(r['state'], 'away')
        self.assertIn('where you checked in', r['message'])

    def test_night_shift_punch_after_midnight_goes_to_last_nights_session(self):
        night = Shift.objects.create(name='Night', start_time=time(18, 0), end_time=time(2, 30), is_night_shift=True)
        ShiftAssignment.objects.create(email=self.email, shift=night, effective_from=DAY - timedelta(days=5))
        self.session(check_in=datetime(2026, 11, 2, 18, 30), shift_id=night.id)
        r = self.punch(NEAR, 20, when=datetime(2026, 11, 3, 1, 0))
        self.assertTrue(r['stored'], r)
        self.assertEqual(AttendanceLocationPunch.objects.get().date, DAY)

    # ── departure watcher ────────────────────────────────────────────────
    def geocheck(self, pos, acc, when=datetime(2026, 11, 2, 12, 0)):
        with at(when):
            return self.c.get(f'/api/attendance/geofence-check?email={self.email}'
                              f'&latitude={pos[0]}&longitude={pos[1]}&accuracy={acc}').json()

    def test_coarse_fix_never_counts_as_leaving(self):
        self.session()
        d = self.geocheck(TOWN, 2500)
        self.assertTrue(d['uncertain'])
        self.assertEqual(self.alerts('You are outside the office'), 0)

    def test_leaving_the_office_notifies_once_per_half_hour(self):
        self.session()
        d = self.geocheck(TOWN, 30)
        self.assertFalse(d['inside'] or d['uncertain'])
        self.geocheck(TOWN, 30, when=datetime(2026, 11, 2, 12, 5))
        self.assertEqual(self.alerts('You are outside the office'), 1)
        self.geocheck(TOWN, 30, when=datetime(2026, 11, 2, 12, 40))
        self.assertEqual(self.alerts('You are outside the office'), 2)

    def test_approved_offsite_day_is_not_watched_or_auto_closed(self):
        self.session(location_lat=TOWN[0], location_lng=TOWN[1], location_status='Approved')
        self.assertTrue(self.geocheck(TOWN, 20)['offsite'])
        with at(datetime(2026, 11, 2, 12, 0)):
            r = self.c.post('/api/attendance/check-out', {'email': self.email, 'auto': 'geofence_departure'},
                            content_type='application/json')
        self.assertEqual((r.status_code, r.json()['code']), (409, 'NOT_AN_OFFICE_SESSION'))
        self.assertIsNone(EmployeeAttendance.objects.get().check_out)

    def test_auto_check_out_tells_the_employee_why(self):
        self.session()
        with at(datetime(2026, 11, 2, 12, 0)):
            r = self.c.post('/api/attendance/check-out', {'email': self.email, 'auto': 'geofence_departure',
                                                          'outside_minutes': 15}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        n = Notification.objects.get(recipient=self.email, title='Checked out automatically')
        self.assertIn('outside the office for more than 15 minutes', n.message)

    def test_hr_and_the_manager_hear_about_an_auto_check_out(self):
        from api.models import UserProfile
        AppUser.objects.filter(email=self.email).update(role='recruitment')
        AppUser.objects.create(email='hr@example.com', full_name='HR', status='active', role='admin')
        AppUser.objects.create(email='boss@example.com', full_name='Boss', status='active', role='recruitment')
        UserProfile.objects.create(email=self.email, manager_email='boss@example.com')
        self.session(employee_name='Punch Tester')
        with at(datetime(2026, 11, 2, 12, 0)):
            r = self.c.post('/api/attendance/check-out', {
                'email': self.email, 'auto': 'geofence_departure', 'outside_minutes': 15,
                'distance': 1800, 'fence': 'HQ', 'latitude': TOWN[0], 'longitude': TOWN[1]},
                content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        for who in ('hr@example.com', 'boss@example.com'):
            n = Notification.objects.get(recipient=who, title='Employee auto checked out')
            self.assertIn('Punch Tester was checked out automatically', n.message)
            self.assertIn('about 1.8 km from HQ', n.message)
        self.assertIn('1.8 km from HQ', Notification.objects.get(
            recipient=self.email, title='Checked out automatically').message)
        row = self.c.get(f'/api/attendance?email={self.email}&date=2026-11-02').json()[0]
        self.assertTrue(row['autoCheckedOut'])
        self.assertIn('1.8 km from HQ', row['note'])
        day = self.c.get(f'/api/attendance/day-detail?email={self.email}&date=2026-11-02').json()
        self.assertIn('Auto check-out (left office)', [e['label'] for e in day['events']])
