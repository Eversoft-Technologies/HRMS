"""Night shifts across midnight: one work day, one record.

Shift "Night" 18:00–02:30 (night shift ticked). Check in Monday evening;
after midnight the widget, status picker and breaks must still act on
Monday's session, a second check-in must be refused, check-out closes Monday,
someone arriving after midnight is late on Monday's shift, and a forgotten
check-out is closed at the shift end — only once the shift is well over.
"""
from datetime import date, datetime, time, timedelta
from contextlib import contextmanager
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, AttendanceEvent, EmployeeAttendance, GeoFence, Shift, ShiftAssignment

OFFICE_LAT, OFFICE_LNG = 17.4485, 78.3908
MON = date(2026, 11, 2)
TUE = MON + timedelta(days=1)


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()):
        yield


class NightShiftTests(TestCase):
    def setUp(self):
        self.email = 'night@example.com'
        AppUser.objects.create(email=self.email, full_name='Night Worker', status='active', role='admin')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT, longitude=OFFICE_LNG, radius_meters=200)
        self.night = Shift.objects.create(name='Night', start_time=time(18, 0), end_time=time(2, 30),
                                          grace_minutes=15, break_minutes=0, is_night_shift=True,
                                          overtime_after_minutes=540)
        ShiftAssignment.objects.create(email=self.email, shift=self.night, effective_from=MON - timedelta(days=30))
        self.c = Client(HTTP_X_USER_EMAIL=self.email)

    def post(self, path, **body):
        return self.c.post(path, {'email': self.email, **body}, content_type='application/json')

    def check_in(self):
        return self.post('/api/attendance/check-in', employee='Night Worker', latitude=OFFICE_LAT, longitude=OFFICE_LNG)

    def today(self):
        return self.c.get('/api/attendance/today?email=' + self.email).json()

    def test_after_midnight_the_session_is_still_open_everywhere(self):
        with at(datetime(2026, 11, 2, 18, 46)):
            self.assertEqual(self.check_in().status_code, 201)
        with at(datetime(2026, 11, 3, 1, 30)):
            t = self.today()
            self.assertTrue(t['checkedIn'], t)
            self.assertEqual((t['date'], t.get('overnight')), ('2026-11-02', True))
            # status picker / break works after midnight
            r = self.post('/api/attendance/presence', label='Away')
            self.assertEqual(r.status_code, 200, r.content)
            # a second check-in is refused instead of opening Tuesday
            r = self.check_in()
            self.assertEqual((r.status_code, r.json()['code']), (409, 'ALREADY_CHECKED_IN'))
            self.assertFalse(EmployeeAttendance.objects.filter(email=self.email, date=TUE).exists())
        with at(datetime(2026, 11, 3, 1, 40)):
            self.assertEqual(self.post('/api/attendance/presence', label='Available').status_code, 200)
        with at(datetime(2026, 11, 3, 2, 40)):
            r = self.post('/api/attendance/check-out')
            self.assertEqual(r.status_code, 200, r.content)
        row = EmployeeAttendance.objects.get(email=self.email, date=MON)
        self.assertEqual(row.break_minutes, 10)
        self.assertEqual(row.worked_minutes, (7 * 60 + 54) - 10)       # 18:46 → 02:40, minus the break
        self.assertEqual(row.early_exit_minutes, 0)                    # left after 02:30 on Tuesday
        self.assertEqual(set(AttendanceEvent.objects.filter(email=self.email).values_list('date', flat=True)), {MON})

    def test_arriving_after_midnight_is_late_on_last_nights_shift(self):
        with at(datetime(2026, 11, 3, 0, 20)):
            self.assertEqual(self.check_in().status_code, 201)
        row = EmployeeAttendance.objects.get(email=self.email)
        self.assertEqual((row.date, row.status, row.late_minutes), (MON, 'late', 6 * 60 + 20))

    def notes(self):
        from api.models import Notification
        return list(Notification.objects.filter(recipient=self.email, title__in=['Still checked in', 'Check-out missing']).order_by('id').values_list('title', flat=True))

    def poll(self):
        """The bell's poll — this is what triggers check-out reminders."""
        return self.c.get('/api/notifications?unreadOnly=true')

    def test_forgotten_night_check_out_stays_open_and_reminds(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        with at(datetime(2026, 11, 3, 2, 50)):            # 20 min after the end: nothing yet
            self.poll()
            self.assertEqual(self.notes(), [])
        with at(datetime(2026, 11, 3, 3, 5)):             # 35 min after: first reminder
            self.poll(); self.poll()                      # polling twice sends it once
            self.assertEqual(self.notes(), ['Still checked in'])
            self.assertTrue(self.today()['checkedIn'])    # never auto-checked-out
        with at(datetime(2026, 11, 3, 4, 0)):             # not 2 h since the first yet
            self.poll()
            self.assertEqual(len(self.notes()), 1)
        with at(datetime(2026, 11, 3, 5, 10)):            # 2 h later: second reminder
            self.poll()
            self.assertEqual(self.notes(), ['Still checked in', 'Still checked in'])
        with at(datetime(2026, 11, 3, 9, 0)):             # check out late: all the time counts
            self.assertEqual(self.post('/api/attendance/check-out').status_code, 200)
        row = EmployeeAttendance.objects.get(email=self.email, date=MON)
        self.assertEqual(row.worked_minutes, 15 * 60)     # 18:00 → 09:00
        self.assertFalse(row.is_auto_checked_out)

    def test_reminders_stop_after_four(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        for hour in range(3, 20):
            with at(datetime(2026, 11, 3, hour, 5)):
                self.poll()
        self.assertEqual(len(self.notes()), 4)

    def test_forgotten_day_shift_gets_one_missing_note_and_stays_open(self):
        day = Shift.objects.create(name='Day', start_time=time(9, 0), end_time=time(18, 0))
        ShiftAssignment.objects.filter(email=self.email).delete()
        ShiftAssignment.objects.create(email=self.email, shift=day, effective_from=MON - timedelta(days=30))
        with at(datetime(2026, 11, 2, 9, 5)):
            self.check_in()
        with at(datetime(2026, 11, 2, 18, 40)):           # same evening: still current
            self.poll()
            self.assertEqual(self.notes(), ['Still checked in'])
        with at(datetime(2026, 11, 3, 9, 0)):             # next morning: one "missing" note
            self.poll(); self.poll()
            self.assertEqual(self.notes(), ['Still checked in', 'Check-out missing'])
        row = EmployeeAttendance.objects.get(email=self.email, date=MON)
        self.assertIsNone(row.check_out)                  # nothing was closed automatically

    def test_no_reminder_while_the_shift_is_on(self):
        with at(datetime(2026, 11, 2, 18, 0)):
            self.check_in()
        with at(datetime(2026, 11, 3, 1, 0)):
            self.poll()
        self.assertEqual(self.notes(), [])
