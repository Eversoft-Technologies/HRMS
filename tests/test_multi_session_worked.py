"""Several check-in / check-out sessions on one day add up: each session's time
minus only the breaks taken in it. A check-out used to replace the day's
worked minutes with the latest session minus all of the day's breaks."""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, AttendanceCorrection, EmployeeAttendance, GeoFence, Shift, ShiftAssignment

OFFICE = (17.4485, 78.3908)
DAY = date(2026, 11, 2)


@contextmanager
def at(h, m=0, day=DAY):
    dt = datetime.combine(day, time(h, m))
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=day):
        yield


class MultiSessionTests(TestCase):
    def setUp(self):
        self.email = 'multi@example.com'
        AppUser.objects.create(email=self.email, full_name='Multi', status='active', role='admin')
        GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        shift = Shift.objects.create(name='Day', start_time=time(9, 0), end_time=time(18, 0),
                                     grace_minutes=15, overtime_after_minutes=480)
        ShiftAssignment.objects.create(email=self.email, shift=shift, effective_from=DAY - timedelta(days=10))
        self.c = Client(HTTP_X_USER_EMAIL=self.email)

    def post(self, path, **body):
        r = self.c.post(path, {'email': self.email, **body}, content_type='application/json')
        self.assertIn(r.status_code, (200, 201), r.content)
        return r

    def check_in(self, h, m=0):
        with at(h, m):
            self.post('/api/attendance/check-in', employee='Multi', latitude=OFFICE[0], longitude=OFFICE[1])

    def check_out(self, h, m=0):
        with at(h, m):
            self.post('/api/attendance/check-out')

    def brk(self, h1, m1, h2, m2):
        with at(h1, m1):
            self.post('/api/attendance/presence', label='Away')
        with at(h2, m2):
            self.post('/api/attendance/presence', label='Available')

    def row(self):
        return EmployeeAttendance.objects.get(email=self.email, date=DAY)

    def test_sessions_add_up_with_their_own_breaks(self):
        self.check_in(9)
        self.brk(10, 0, 10, 15)                   # 15 min break in session 1
        self.check_out(12)                        # 180 − 15 = 165
        self.assertEqual(self.row().worked_minutes, 165)
        self.check_in(13)
        self.brk(15, 0, 15, 30)                   # 30 min break in session 2
        self.check_out(18, 30)                    # 330 − 30 = 300
        r = self.row()
        self.assertEqual((r.worked_minutes, r.break_minutes, r.overtime_minutes), (465, 45, 0))
        self.check_in(19)
        self.check_out(20)                        # +60 → 525, overtime past 480
        r = self.row()
        self.assertEqual((r.worked_minutes, r.overtime_minutes), (525, 45))

    def test_live_tile_and_day_view_count_earlier_sessions(self):
        self.check_in(9)
        self.brk(10, 0, 10, 20)
        self.check_out(11)                        # 100
        self.check_in(13)
        with at(14, 0):
            t = self.c.get('/api/attendance/today?email=' + self.email).json()
            self.assertEqual((t['priorWorkedMinutes'], t['breaksBeforeSessionMinutes']), (100, 20))
            d = self.c.get(f'/api/attendance/day-detail?email={self.email}&date=2026-11-02').json()
        self.assertEqual((d['grossMinutes'], d['effectiveMinutes']), (300, 160))     # 9:00→14:00; 100 + 60
        self.check_out(15)
        d = self.c.get(f'/api/attendance/day-detail?email={self.email}&date=2026-11-02').json()
        self.assertEqual((d['grossMinutes'], d['effectiveMinutes']), (360, 220))

    def test_missed_check_out_adds_to_earlier_sessions(self):
        self.check_in(9)
        self.check_out(12)                        # 180
        self.check_in(13)                         # never checked out
        with at(9, 0, DAY + timedelta(days=1)):
            r = self.c.post('/api/attendance/corrections', {
                'email': self.email, 'employee': 'Multi', 'attendanceDate': '2026-11-02',
                'requestedCheckOut': '2026-11-02 17:00:00', 'reason': 'forgot'}, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['preview']['workedMinutes'], 420)                  # 180 + 240
        cid = r.json()['id']
        r = self.c.put(f'/api/attendance/corrections/{cid}', {'status': 'Approved', 'reviewer': 'HR'},
                       content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.row().worked_minutes, 420)
