"""Approved leave shows in the attendance summary.

A sick day has no attendance row, so the summary used to ignore it: "Absent 0"
and attendance 100%. It is now counted as ``leave`` — weekdays only, never past
today, never a day the person checked in anyway, and only once approved.
"""
from datetime import date, datetime, time
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import EmployeeAttendance, LeaveRequest

EMAIL = 'leave.summary@example.com'
TODAY = date(2026, 11, 13)          # a Friday


class FakeDate(date):
    @classmethod
    def today(cls):
        return TODAY


class SummaryLeaveTests(TestCase):
    def setUp(self):
        self.c = Client(HTTP_X_USER_EMAIL=EMAIL)
        for d in (date(2026, 11, 9), date(2026, 11, 10), date(2026, 11, 12)):
            EmployeeAttendance.objects.create(email=EMAIL, employee_name='Leave Tester', date=d,
                                              check_in=datetime.combine(d, time(9, 0)),
                                              check_out=datetime.combine(d, time(18, 0)),
                                              status='present', worked_minutes=480)

    def summary(self, frm='2026-11-01', to='2026-11-30'):
        with patch('api.services.attendance_service.date', FakeDate):
            r = self.c.get(f'/api/attendance/summary/?email={EMAIL}&fromDate={frm}&toDate={to}')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def leave(self, frm, to, status='Approved', typ='Sick Leave'):
        LeaveRequest.objects.create(email=EMAIL, type=typ, from_date=frm, to_date=to, status=status,
                                    days=(to - frm).days + 1)

    def test_a_sick_day_counts_as_leave(self):
        self.leave(date(2026, 11, 11), date(2026, 11, 11))
        s = self.summary()
        self.assertEqual((s['present'], s['absent'], s['leave']), (3, 0, 1))

    def test_pending_or_rejected_leave_is_not_counted(self):
        self.leave(date(2026, 11, 11), date(2026, 11, 11), status='Pending')
        self.leave(date(2026, 11, 13), date(2026, 11, 13), status='Rejected')
        self.assertEqual(self.summary()['leave'], 0)

    def test_weekends_future_and_worked_days_are_skipped(self):
        # Wed 11 → Tue 17: Thu 12 was worked, Sat/Sun skipped, Mon 16 / Tue 17
        # are still in the future -> only Wed 11 and Fri 13 count.
        self.leave(date(2026, 11, 11), date(2026, 11, 17))
        self.assertEqual(self.summary()['leave'], 2)

    def test_only_the_part_inside_the_range(self):
        self.leave(date(2026, 10, 29), date(2026, 11, 3))   # Thu 29, Fri 30, Mon 2, Tue 3
        self.assertEqual(self.summary()['leave'], 2)         # range starts Nov 1
        self.assertEqual(self.summary('2026-10-01', '2026-10-31')['leave'], 2)


class HeaderMatchesTabTests(TestCase):
    """The profile header's "Attendance %" and the Attendance tab agree."""

    def test_header_counts_approved_leave_like_the_tab(self):
        from api.models import AppUser
        from api.timeutil import local_today
        from datetime import timedelta
        admin = 'hdr.admin@example.com'
        AppUser.objects.create(email=admin, full_name='Hdr Admin', password='x', role='admin', status='active')
        u = AppUser.objects.create(email=EMAIL, full_name='Leave Tester', password='x', role='hr', status='active')
        today = local_today()
        days = [today - timedelta(days=i) for i in range(1, 15)]
        weekdays = [d for d in days if d.weekday() < 5]
        for d in weekdays[1:4]:
            EmployeeAttendance.objects.create(email=EMAIL, date=d, status='present',
                                              check_in=datetime.combine(d, time(9, 0)))
        LeaveRequest.objects.create(email=EMAIL, type='Sick Leave', from_date=weekdays[0],
                                    to_date=weekdays[0], status='Approved', days=1)
        c = Client(HTTP_X_USER_EMAIL=admin)
        body = c.get(f'/api/employees/{u.id}/profile').json()
        self.assertEqual(body['stats']['attendancePct'], 75)          # 3 present / (3 + 1 leave)
        frm = (today - timedelta(days=29)).isoformat()
        s = c.get(f'/api/attendance/summary/?email={EMAIL}&fromDate={frm}&toDate={today.isoformat()}').json()
        self.assertEqual((s['present'], s['leave']), (3, 1))
