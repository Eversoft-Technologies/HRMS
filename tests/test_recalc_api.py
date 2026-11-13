"""Attendance Administration › Recalculate Hours: GET previews, POST applies
exactly what was previewed; earlier (possibly paid) months need a tick."""
from datetime import date, time, timedelta
from unittest.mock import patch

from django.test import Client

from api.models import AppUser, AttendanceEvent, EmployeeAttendance
from tests.test_shift_window_rules import Base, D

TODAY = date(2026, 11, 20)


class RecalcApiTests(Base):
    shift_kw = dict(name='Day', start_time=time(9, 0), end_time=time(18, 0), overtime_after_minutes=480)

    def setUp(self):
        super().setUp()
        p = patch('api.timeutil.local_today', return_value=TODAY)
        p.start(); self.addCleanup(p.stop)
        self.check_in(D, 9, 0); self.check_out(D, 12, 0)
        self.check_in(D, 13, 0); self.check_out(D, 18, 0)
        EmployeeAttendance.objects.filter(email=self.email, date=D).update(worked_minutes=300, overtime_minutes=0)

    def get(self, q=''):
        return self.hr.get('/api/attendance/recalculate' + q)

    def apply_req(self, **body):
        return self.hr.post('/api/attendance/recalculate', body, content_type='application/json')

    def test_preview_writes_nothing(self):
        d = self.get().json()
        self.assertEqual((d['from'], d['to'], d['includesClosedMonths']), ('2026-11-01', '2026-11-20', False))
        self.assertEqual([(r['date'], r['oldWorkedMinutes'], r['newWorkedMinutes']) for r in d['changes']],
                         [('2026-11-02', 300, 480)])
        self.assertEqual(self.row(D).worked_minutes, 300)

    def test_apply_writes_what_was_previewed(self):
        r = self.apply_req(expect=1)
        self.assertEqual((r.status_code, r.json()['applied']), (200, 1))
        self.assertEqual(self.row(D).worked_minutes, 480)
        self.assertIn('hr@example.com: worked 5h 0m → 8h 0m',
                      AttendanceEvent.objects.get(email=self.email, event='recalculated').location)

    def test_stale_preview_is_refused(self):
        r = self.apply_req(expect=3)
        self.assertEqual((r.status_code, r.json()['code']), (409, 'PREVIEW_STALE'))
        self.assertEqual(self.row(D).worked_minutes, 300)
        self.assertEqual(self.apply_req().status_code, 400)                     # no preview count at all

    def test_earlier_months_need_confirmation(self):
        d = self.get('?from=2026-10-01').json()
        self.assertTrue(d['includesClosedMonths'])
        self.assertEqual(self.apply_req(**{'from': '2026-10-01', 'expect': 1}).status_code, 400)
        r = self.apply_req(**{'from': '2026-10-01', 'expect': 1, 'allowClosedMonths': True})
        self.assertEqual(r.status_code, 200, r.content)

    def test_needs_attendance_edit(self):
        AppUser.objects.create(email='emp@example.com', full_name='Emp', status='active', role='recruitment')
        r = Client(HTTP_X_USER_EMAIL='emp@example.com').get('/api/attendance/recalculate')
        self.assertEqual(r.status_code, 403)
