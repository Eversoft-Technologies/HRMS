"""Missed-punch detection (api/attendance_ext/missed_punch.py).

A day is flagged once it is over (midnight for a day shift, shift end +
NIGHT_SHIFT_TAIL for a night shift), the employee is told once per
day-issue (in-app + e-mail), the manager once the deadline passes unfiled,
and the flag clears when the day is completed or a correction is approved.
"""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import Client, TestCase

from api.attendance_ext import missed_punch as mp
from api.models import (AppUser, AttendanceCorrection, AttendanceEvent, EmployeeAttendance, Notification,
                        Permission, Role, RolePermission, Shift, ShiftAssignment, UserProfile)

D = date(2026, 11, 18)


@contextmanager
def at(when):
    with patch('api.views.local_now', return_value=when), \
            patch('api.views.local_today', return_value=when.date()), \
            patch('api.attendance_ext.missed_punch.local_now', return_value=when), \
            patch('api.attendance_ext.regularization.local_now', return_value=when):
        yield


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class Base(TestCase):
    def setUp(self):
        from api import permissions
        permissions._CACHE.clear()
        mp._LAST_RUN.clear()
        self.mail = patch('api.mailer.send_email', return_value={'ok': True})
        self.sent = self.mail.start()
        self.addCleanup(self.mail.stop)
        emp = Role.objects.create(name='Employee')
        grant(emp, 'attendance.create')
        hr = Role.objects.create(name='HR Manager')
        grant(hr, 'attendance.view', 'attendance.edit', 'attendance.create',
              'overtime.approve', 'attendance.regularize.approve')
        for email, role, mgr in (('emp@x.com', emp, 'boss@x.com'), ('boss@x.com', emp, ''),
                                 ('hr@x.com', hr, ''), ('solo@x.com', emp, '')):
            AppUser.objects.create(email=email, full_name=email.split('@')[0].title(), password='x',
                                   role='employee', role_ref=role, status='active')
            UserProfile.objects.create(email=email, first_name=email.split('@')[0], manager_email=mgr)
        self.day = Shift.objects.create(name='Day', start_time=time(9, 0), end_time=time(18, 0),
                                        grace_minutes=15, break_minutes=60, overtime_after_minutes=540)
        self.night = Shift.objects.create(name='Night', start_time=time(18, 0), end_time=time(2, 30),
                                          grace_minutes=15, is_night_shift=True, overtime_after_minutes=540)
        for e in ('emp@x.com', 'boss@x.com', 'hr@x.com', 'solo@x.com'):
            ShiftAssignment.objects.create(email=e, shift=self.day, effective_from=D - timedelta(days=60))
        self.c = {e: Client(HTTP_X_USER_EMAIL=e) for e in ('emp@x.com', 'boss@x.com', 'hr@x.com', 'solo@x.com')}

    def open_day(self, email='emp@x.com', day=D, start=time(9, 0), shift=None, **kw):
        shift = shift or self.day
        cin = datetime.combine(day, start)
        att = EmployeeAttendance.objects.create(email=email, employee_name=email.split('@')[0].title(), date=day,
                                                check_in=cin, shift_id=shift.id, status='present', **kw)
        AttendanceEvent.objects.create(email=email, date=day, event='check-in', at=cin)
        return att

    def row(self, email='emp@x.com', day=D):
        return EmployeeAttendance.objects.get(email=email, date=day)

    def notes(self, email='emp@x.com'):
        return list(Notification.objects.filter(recipient=email).values_list('title', 'message'))


class DetectionTests(Base):
    def test_not_flagged_before_midnight_flagged_after(self):
        self.open_day()
        with at(datetime(2026, 11, 18, 23, 50)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, '')
        now = datetime(2026, 11, 19, 0, 5)
        with at(now):
            mp.detect()
        r = self.row()
        self.assertEqual(r.punch_issue, 'missing_checkout')
        self.assertEqual(r.punch_issue_at, now)
        self.assertEqual(r.regularize_by, now + timedelta(hours=48))
        self.assertEqual(r.punch_issue_notified_at, now)
        self.assertIsNone(r.check_out)                     # nothing is closed automatically

    def test_notification_is_sent_once_in_app_and_by_mail(self):
        self.open_day()
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
            mp.detect()
            mp._LAST_RUN.clear()
            self.c['emp@x.com'].get('/api/notifications')      # the bell's poll runs it too
        mine = [n for n in self.notes() if 'check out' in n[1]]
        self.assertEqual(len(mine), 1, self.notes())
        self.assertIn('You forgot to check out on 11/18/2026', mine[0][1])
        self.assertIn('within 48 hours', mine[0][1])
        self.assertEqual(self.sent.call_count, 1)
        self.assertEqual(self.sent.call_args.kwargs['to'], 'emp@x.com')

    def test_poll_after_midnight_gives_one_check_out_missing_note(self):
        """The existing 'Check-out missing' reminder and the detector merge into one note."""
        self.open_day()
        with at(datetime(2026, 11, 19, 9, 0)):
            self.c['emp@x.com'].get('/api/notifications')
            mp._LAST_RUN.clear()
            self.c['emp@x.com'].get('/api/notifications')
        notes = [n for n in self.notes() if n[0] in ('Check-out missing', 'Missing check-out')]
        self.assertEqual(len(notes), 1, notes)
        self.assertIn('Regularize with your manager', notes[0][1])
        self.assertEqual(self.row().punch_issue, 'missing_checkout')

    def test_running_night_shift_is_not_flagged(self):
        ShiftAssignment.objects.filter(email='emp@x.com').update(shift=self.night)
        self.open_day(start=time(18, 0), shift=self.night)
        for when in (datetime(2026, 11, 19, 0, 30), datetime(2026, 11, 19, 3, 0), datetime(2026, 11, 19, 6, 20)):
            with at(when):
                mp.detect()
            self.assertEqual(self.row().punch_issue, '', when)   # shift end 02:30 + 4 h tail
        with at(datetime(2026, 11, 19, 6, 45)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, 'missing_checkout')

    def test_late_night_check_out_clears_the_flag(self):
        ShiftAssignment.objects.filter(email='emp@x.com').update(shift=self.night)
        self.open_day(start=time(18, 0), shift=self.night)
        with at(datetime(2026, 11, 19, 6, 45)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, 'missing_checkout')
        with at(datetime(2026, 11, 19, 7, 0)):
            r = self.c['emp@x.com'].post('/api/attendance/check-out', {'email': 'emp@x.com'},
                                         content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.row().punch_issue, '')

    def test_auto_checked_out_day_is_complete(self):
        self.open_day(check_out=datetime(2026, 11, 18, 11, 0), auto_checkout_at=datetime(2026, 11, 18, 11, 0),
                      early_exit_minutes=420, worked_minutes=120)
        self.open_day(email='solo@x.com', check_out=datetime(2026, 11, 18, 11, 0), early_exit_minutes=420,
                      worked_minutes=120)
        with at(datetime(2026, 11, 19, 1, 0)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, '')
        self.assertEqual(self.row('solo@x.com').punch_issue, 'early_exit')   # same day, closed by hand
        self.assertEqual(self.row('solo@x.com').status, 'present')           # flagged only

    def test_short_early_exit_under_threshold_is_not_flagged(self):
        self.open_day(check_out=datetime(2026, 11, 18, 17, 0), early_exit_minutes=60, worked_minutes=420)
        with at(datetime(2026, 11, 19, 1, 0)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, '')

    def test_check_out_without_check_in_is_missing_checkin(self):
        EmployeeAttendance.objects.create(email='emp@x.com', date=D, check_out=datetime(2026, 11, 18, 18, 0),
                                          shift_id=self.day.id, status='absent')
        AttendanceEvent.objects.create(email='emp@x.com', date=D, event='check-out', at=datetime(2026, 11, 18, 18, 0))
        with at(datetime(2026, 11, 19, 1, 0)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, 'missing_checkin')

    def test_absent_day_without_punches_is_not_a_missed_punch(self):
        EmployeeAttendance.objects.create(email='emp@x.com', date=D, status='absent')
        with at(datetime(2026, 11, 19, 1, 0)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, '')

    def test_manager_reminded_once_after_deadline(self):
        self.open_day()
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        with at(datetime(2026, 11, 20, 23, 0)):          # before the deadline
            mp.detect()
        self.assertFalse(Notification.objects.filter(recipient='boss@x.com').exists())
        with at(datetime(2026, 11, 21, 0, 10)):
            mp.detect()
            mp.detect()
        boss = Notification.objects.filter(recipient='boss@x.com', title='Regularization overdue')
        self.assertEqual(boss.count(), 1)
        self.assertIn('11/18/2026', boss.first().message)

    def test_no_manager_reminder_when_a_regularization_was_filed(self):
        self.open_day()
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        with at(datetime(2026, 11, 19, 10, 0)):
            r = self.c['emp@x.com'].post('/api/attendance/regularization',
                                         {'date': '2026-11-18', 'checkOut': '18:00', 'reasonCode': 'forgot_badge'},
                                         content_type='application/json')
            self.assertEqual(r.status_code, 201, r.content)
        with at(datetime(2026, 11, 21, 1, 0)):
            mp.detect()
        self.assertFalse(Notification.objects.filter(recipient='boss@x.com', title='Regularization overdue').exists())

    def test_approved_punch_ticket_clears_the_flag(self):
        self.open_day()
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        t = AttendanceCorrection.objects.create(email='emp@x.com', attendance_date=D, kind='forgot_checkout',
                                                reason='x', reason_code='other', status='Pending')
        Permission.objects.get_or_create(code='attendance.approve_wfh', defaults={'name': 'x'})
        grant(Role.objects.get(name='HR Manager'), 'attendance.approve_wfh')
        with at(datetime(2026, 11, 19, 9, 0)):
            r = self.c['hr@x.com'].post(f'/api/attendance/punch-ticket/{t.id}/decide', {'action': 'approve'},
                                        content_type='application/json')
            self.assertEqual(r.status_code, 200, r.content)
            mp.detect()                                   # and it is not re-flagged
        self.assertEqual(self.row().punch_issue, '')

    def test_disabled_policy_does_nothing(self):
        mp.save_policy({'enabled': False})
        self.open_day()
        with at(datetime(2026, 11, 19, 1, 0)):
            self.assertEqual(mp.detect(), [])
        self.assertEqual(self.row().punch_issue, '')

    def test_policy_deadline_and_threshold_are_configurable(self):
        mp.save_policy({'deadline_hours': 24, 'early_exit_threshold_minutes': 30})
        self.open_day(check_out=datetime(2026, 11, 18, 17, 0), early_exit_minutes=60, worked_minutes=420)
        now = datetime(2026, 11, 19, 1, 0)
        with at(now):
            mp.detect()
        self.assertEqual((self.row().punch_issue, self.row().regularize_by), ('early_exit', now + timedelta(hours=24)))


class CommandAndApiTests(Base):
    def test_command_dry_run_then_apply(self):
        self.open_day()
        out = StringIO()
        with at(datetime(2026, 11, 19, 1, 0)):
            call_command('detect_missed_punches', '--dry-run', stdout=out)
        self.assertIn('flagged:missing_checkout', out.getvalue())
        self.assertEqual(self.row().punch_issue, '')
        with at(datetime(2026, 11, 19, 1, 0)):
            call_command('detect_missed_punches', '--date', '2026-11-18', stdout=StringIO())
            call_command('detect_missed_punches', stdout=StringIO())      # idempotent
        self.assertEqual(self.row().punch_issue, 'missing_checkout')
        self.assertEqual(self.sent.call_count, 1)

    def test_policy_endpoint_permissions(self):
        r = self.c['emp@x.com'].put('/api/attendance/missed-punch-policy', {'deadline_hours': 12},
                                    content_type='application/json')
        self.assertEqual(r.status_code, 403)
        r = self.c['hr@x.com'].put('/api/attendance/missed-punch-policy', {'deadline_hours': 12},
                                   content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.c['emp@x.com'].get('/api/attendance/missed-punch-policy').json()['deadline_hours'], 12)

    def test_punch_issues_list_scoping(self):
        self.open_day()
        self.open_day(email='solo@x.com')
        with at(datetime(2026, 11, 19, 1, 0)):
            mp.detect()
            hr = self.c['hr@x.com'].get('/api/attendance/punch-issues').json()
            boss = self.c['boss@x.com'].get('/api/attendance/punch-issues').json()
            solo = self.c['solo@x.com'].get('/api/attendance/punch-issues')
        self.assertEqual(sorted(r['email'] for r in hr), ['emp@x.com', 'solo@x.com'])
        self.assertEqual([r['email'] for r in boss], ['emp@x.com'])
        self.assertEqual(solo.status_code, 403)
