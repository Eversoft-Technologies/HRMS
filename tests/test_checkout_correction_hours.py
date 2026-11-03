"""Missed clock-out requests: hours are previewed while pending (request +
attendance history) and applied on approval with breaks deducted."""
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, AttendanceCorrection, EmployeeAttendance, Shift, ShiftAssignment

MON = date(2026, 11, 2)


class CheckoutCorrectionHoursTests(TestCase):
    def setUp(self):
        self.email = 'night@example.com'
        AppUser.objects.create(email=self.email, full_name='Night Worker', status='active', role='admin')
        self.night = Shift.objects.create(name='Night', start_time=time(18, 0), end_time=time(2, 30),
                                          grace_minutes=15, is_night_shift=True, overtime_after_minutes=480)
        ShiftAssignment.objects.create(email=self.email, shift=self.night, effective_from=MON - timedelta(days=30))
        # checked in 18:46, took a 30 min break, never checked out
        EmployeeAttendance.objects.create(email=self.email, date=MON, check_in=datetime(2026, 11, 2, 18, 46),
                                          break_minutes=30, shift_id=self.night.id, status='late')
        self.c = Client(HTTP_X_USER_EMAIL=self.email)

    def raise_request(self, out):
        with patch('api.views.local_now', return_value=datetime(2026, 11, 3, 12, 0)):
            return self.c.post('/api/attendance/corrections', {
                'email': self.email, 'employee': 'Night Worker', 'attendanceDate': '2026-11-02',
                'requestedCheckOut': out, 'reason': 'forgot'}, content_type='application/json')

    def test_overnight_request_previews_hours(self):
        r = self.raise_request('2026-11-03 03:16:00')
        self.assertEqual(r.status_code, 201, r.content)
        p = r.json()['preview']
        self.assertEqual((p['grossMinutes'], p['workedMinutes'], p['overtimeMinutes']), (510, 480, 0))

    def test_history_shows_the_pending_hours(self):
        self.raise_request('2026-11-03 04:46:00')                 # 10h gross, 9h30 worked
        row = self.c.get('/api/attendance?email=' + self.email + '&from=2026-11-01&to=2026-11-04').json()[0]
        pc = row['pendingCorrection']
        self.assertEqual((pc['requestedCheckOutTime'], pc['workedMinutes'], pc['overtimeMinutes']), ('04:46', 570, 90))
        self.assertIsNone(row['checkOut'])                        # nothing applied before approval

    def test_approval_applies_hours_with_breaks_deducted(self):
        cid = self.raise_request('2026-11-03 04:46:00').json()['id']
        r = self.c.put(f'/api/attendance/corrections/{cid}', {'status': 'Approved', 'reviewer': 'HR'},
                       content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        row = EmployeeAttendance.objects.get(email=self.email, date=MON)
        self.assertEqual((row.check_out, row.worked_minutes, row.overtime_minutes, row.early_exit_minutes),
                         (datetime(2026, 11, 3, 4, 46), 570, 90, 0))
        hist = self.c.get('/api/attendance?email=' + self.email + '&from=2026-11-01&to=2026-11-04').json()[0]
        self.assertNotIn('pendingCorrection', hist)
        self.assertEqual(hist['workedMinutes'], 570)

    def test_clock_out_before_clock_in_is_refused(self):
        r = self.raise_request('2026-11-02 03:00:00')             # same date, before 18:46
        self.assertEqual(r.status_code, 400)
        self.assertIn('after your clock-in', r.json()['message'])
        self.assertFalse(AttendanceCorrection.objects.exists())
