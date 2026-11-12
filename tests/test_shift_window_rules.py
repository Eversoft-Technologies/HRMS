"""On Time / Late judged on the shift window, the 4-hour tail after a night
shift, HR edits of worked time, and the recalc_attendance command."""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import Client, TestCase

from api.models import AppUser, AttendanceEvent, EmployeeAttendance, GeoFence, Shift, ShiftAssignment

OFFICE = (17.4485, 78.3908)
D = date(2026, 11, 2)


@contextmanager
def at(day, h, m=0):
    dt = datetime.combine(day, time(h, m))
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=day):
        yield


class Base(TestCase):
    shift_kw = {}

    def setUp(self):
        self.email = 'rules@example.com'
        AppUser.objects.create(email=self.email, full_name='Rules', status='active', role='admin')
        AppUser.objects.create(email='hr@example.com', full_name='HR', status='active', role='admin')
        GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        self.shift = Shift.objects.create(**self.shift_kw)
        ShiftAssignment.objects.create(email=self.email, shift=self.shift, effective_from=D - timedelta(days=10))
        self.c = Client(HTTP_X_USER_EMAIL=self.email)
        self.hr = Client(HTTP_X_USER_EMAIL='hr@example.com')

    def post(self, path, **body):
        r = self.c.post(path, {'email': self.email, **body}, content_type='application/json')
        self.assertIn(r.status_code, (200, 201), r.content)
        return r

    def check_in(self, day, h, m=0):
        with at(day, h, m):
            self.post('/api/attendance/check-in', employee='Rules', latitude=OFFICE[0], longitude=OFFICE[1])

    def check_out(self, day, h, m=0):
        with at(day, h, m):
            self.post('/api/attendance/check-out')

    def row(self, day):
        return EmployeeAttendance.objects.get(email=self.email, date=day)


class NightTailTests(Base):
    shift_kw = dict(name='Night', start_time=time(18, 0), end_time=time(2, 0), grace_minutes=15,
                    is_night_shift=True, overtime_after_minutes=480)

    def test_check_in_just_after_the_shift_is_last_nights_overtime(self):
        self.check_in(D, 18, 0)
        self.check_out(D + timedelta(days=1), 2, 0)                 # 8h
        self.check_in(D + timedelta(days=1), 2, 18)                 # 18 min after the end
        self.check_out(D + timedelta(days=1), 2, 48)
        r = self.row(D)
        self.assertEqual((r.worked_minutes, r.overtime_minutes, r.status), (510, 30, 'present'))
        self.assertFalse(EmployeeAttendance.objects.filter(email=self.email, date=D + timedelta(days=1)).exists())
        # tonight's shift is judged on its own check-in
        self.check_in(D + timedelta(days=1), 17, 51)
        self.assertEqual(self.row(D + timedelta(days=1)).status, 'present')

    def test_well_after_the_tail_is_a_new_day(self):
        self.check_in(D, 18, 0)
        self.check_out(D + timedelta(days=1), 2, 0)
        self.check_in(D + timedelta(days=1), 6, 30)                 # 4h30 after the end
        self.assertTrue(EmployeeAttendance.objects.filter(email=self.email, date=D + timedelta(days=1)).exists())


class OnTimeWindowTests(Base):
    shift_kw = dict(name='Day', start_time=time(9, 0), end_time=time(18, 0), grace_minutes=15,
                    overtime_after_minutes=480)

    def test_a_check_in_long_before_the_shift_does_not_decide(self):
        self.check_in(D, 2, 18)                                     # before 05:00
        self.check_out(D, 2, 40)
        self.assertEqual((self.row(D).status, self.row(D).late_minutes), ('present', 0))
        self.check_in(D, 9, 40)                                     # the shift's own arrival
        self.assertEqual((self.row(D).status, self.row(D).late_minutes), ('late', 40))

    def test_only_the_first_check_in_in_the_window_counts(self):
        self.check_in(D, 8, 50)
        self.check_out(D, 12, 0)
        self.check_in(D, 13, 30)                                    # after lunch: not "late"
        self.assertEqual((self.row(D).status, self.row(D).late_minutes), ('present', 0))


class HrEditTests(Base):
    shift_kw = dict(name='Day', start_time=time(9, 0), end_time=time(18, 0), overtime_after_minutes=480)

    def test_worked_total_cannot_be_typed_over_a_running_session(self):
        self.check_in(D, 9, 0)
        pk = self.row(D).pk
        r = self.hr.put(f'/api/attendance/{pk}', {'worked_minutes': 600}, content_type='application/json')
        self.assertEqual((r.status_code, r.json()['code']), (409, 'SESSION_OPEN'))
        self.assertEqual(self.row(D).worked_minutes, 0)

    def test_edited_times_recalculate_every_session(self):
        self.check_in(D, 9, 0)
        self.check_out(D, 12, 0)                                    # 180
        self.check_in(D, 13, 0)
        self.check_out(D, 17, 0)                                    # 240 → 420
        pk = self.row(D).pk
        with at(D + timedelta(days=1), 10):
            r = self.hr.put(f'/api/attendance/{pk}', {'check_out': '2026-11-02T19:00:00'},
                            content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        row = self.row(D)
        self.assertEqual((row.worked_minutes, row.overtime_minutes), (540, 60))   # 180 + 360
        ev = AttendanceEvent.objects.get(email=self.email, event='hr-edit')
        self.assertIn('hr@example.com: worked 7h 0m → 9h 0m', ev.location)

    def test_check_out_before_check_in_is_refused(self):
        self.check_in(D, 9, 0)
        self.check_out(D, 12, 0)
        pk = self.row(D).pk
        r = self.hr.put(f'/api/attendance/{pk}', {'check_out': '2026-11-02T08:00:00'}, content_type='application/json')
        self.assertEqual(r.status_code, 400)


class RecalcCommandTests(Base):
    shift_kw = dict(name='Day', start_time=time(9, 0), end_time=time(18, 0), overtime_after_minutes=480)

    def old_style_day(self):
        """A two-session day saved by the old code: only the last session kept."""
        self.check_in(D, 9, 0)
        self.check_out(D, 12, 0)
        self.check_in(D, 13, 0)
        self.check_out(D, 18, 0)
        EmployeeAttendance.objects.filter(email=self.email, date=D).update(worked_minutes=300, overtime_minutes=0)

    def run_cmd(self, *args):
        out = StringIO()
        with patch('api.management.commands.recalc_attendance.local_today', return_value=D + timedelta(days=3)):
            call_command('recalc_attendance', *args, stdout=out)
        return out.getvalue()

    def test_preview_changes_nothing_and_apply_writes(self):
        self.old_style_day()
        out = self.run_cmd('--from', '2026-11-01')
        self.assertIn('PREVIEW', out)
        self.assertIn('5h 0m → 8h 0m', out)
        self.assertEqual(self.row(D).worked_minutes, 300)
        out = self.run_cmd('--from', '2026-11-01', '--apply')
        self.assertIn('1 day(s) changed', out)
        self.assertEqual(self.row(D).worked_minutes, 480)
        self.assertTrue(AttendanceEvent.objects.filter(email=self.email, event='recalculated').exists())
        self.assertIn('0 day(s) changed', self.run_cmd('--from', '2026-11-01', '--apply'))   # idempotent

    def test_a_trail_that_does_not_pair_up_is_left_alone(self):
        self.old_style_day()
        AttendanceEvent.objects.filter(email=self.email, event='check-out').order_by('at').first().delete()
        out = self.run_cmd('--from', '2026-11-01', '--apply')
        self.assertIn('left as they are', out)
        self.assertEqual(self.row(D).worked_minutes, 300)

    def test_default_range_starts_this_month(self):
        self.old_style_day()                                        # 2 Nov
        with patch('api.management.commands.recalc_attendance.local_today', return_value=date(2026, 12, 5)):
            out = StringIO(); call_command('recalc_attendance', stdout=out)
        self.assertIn('2026-12-01', out.getvalue())
        self.assertIn('0 day(s) would change', out.getvalue())
