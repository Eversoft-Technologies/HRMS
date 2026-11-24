"""Day-by-day attendance history for the employee profile
(GET /api/attendance/history, api/attendance_ext/history.py)."""
import csv
import io
from datetime import datetime, time, timedelta
from unittest import mock

from django.test import Client, TestCase

from api.models import (AppUser, EmployeeAttendance, HolidayCalendar, HolidayCalendarDay, LeaveRequest, Permission,
                        Role, RolePermission, UserProfile)
from api.timeutil import local_today

TODAY = local_today()


def back(n):
    return TODAY - timedelta(days=n)


def last_weekday(before, wanted):
    """Most recent date before `before` whose weekday is in `wanted`."""
    d = before - timedelta(days=1)
    while d.weekday() not in wanted:
        d -= timedelta(days=1)
    return d


class HistoryTests(TestCase):
    def setUp(self):
        from api import permissions
        permissions._CACHE.clear()
        emp = Role.objects.create(name='Employee')
        hr = Role.objects.create(name='HR Executive')
        p, _ = Permission.objects.get_or_create(code='attendance.view', defaults={'name': 'View attendance'})
        RolePermission.objects.create(role=hr, permission=p)
        for email, role in (('asha@x.com', emp), ('ravi@x.com', emp), ('hr@x.com', hr)):
            AppUser.objects.create(email=email, full_name=email.split('@')[0].title(), password='x',
                                   role='employee', role_ref=role, status='active')
        UserProfile.objects.create(email='asha@x.com', first_name='Asha', start_date=back(40))
        # Mon-Fri week (no CompanyDetail row → default), so pick real weekdays.
        self.d_present = last_weekday(TODAY, {0, 1, 2, 3, 4})
        self.d_late = last_weekday(self.d_present, {0, 1, 2, 3, 4})
        self.d_wfh = last_weekday(self.d_late, {0, 1, 2, 3, 4})
        self.d_leave = last_weekday(self.d_wfh, {0, 1, 2, 3, 4})
        self.d_hol = last_weekday(self.d_leave, {0, 1, 2, 3, 4})
        self.d_absent = last_weekday(self.d_hol, {0, 1, 2, 3, 4})
        self.d_weekend = last_weekday(TODAY, {5, 6})

        def row(d, status, wfh=False, late=0, issue=''):
            ci = datetime.combine(d, time(9, 30 if late else 0))
            EmployeeAttendance.objects.create(email='asha@x.com', employee_name='Asha', date=d, check_in=ci,
                                              check_out=ci + timedelta(hours=9), status=status, is_wfh=wfh,
                                              worked_minutes=480, break_minutes=60, late_minutes=late,
                                              punch_issue=issue)
        row(self.d_present, 'present')
        row(self.d_late, 'late', late=30, issue='early_exit')
        row(self.d_wfh, 'present', wfh=True)
        LeaveRequest.objects.create(email='asha@x.com', type='Sick Leave', from_date=self.d_leave,
                                    to_date=self.d_leave, days=1, status='Approved')
        cal = HolidayCalendar.objects.create(name='India', country='IN', include_national=False, is_default=True)
        HolidayCalendarDay.objects.create(calendar=cal, date=self.d_hol, name='Founders Day')

    def get(self, who, **params):
        params.setdefault('email', 'asha@x.com')
        return Client(HTTP_X_USER_EMAIL=who).get('/api/attendance/history', params)

    def days(self, who='asha@x.com', **params):
        r = self.get(who, **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def by_date(self, data):
        return {x['date']: x for x in data['results']}

    def test_every_day_gets_a_status(self):
        d = self.days(**{'from': self.d_absent.isoformat(), 'to': TODAY.isoformat(), 'pageSize': 100})
        m = self.by_date(d)
        self.assertEqual(m[self.d_present.isoformat()]['status'], 'present')
        self.assertEqual(m[self.d_present.isoformat()]['checkIn'], '09:00')
        self.assertEqual(m[self.d_late.isoformat()]['status'], 'late')
        self.assertEqual(m[self.d_late.isoformat()]['punchIssue'], 'early_exit')
        self.assertEqual(m[self.d_wfh.isoformat()]['mode'], 'wfh')
        self.assertEqual((m[self.d_leave.isoformat()]['status'], m[self.d_leave.isoformat()]['detail']), ('leave', 'Sick Leave'))
        self.assertEqual((m[self.d_hol.isoformat()]['status'], m[self.d_hol.isoformat()]['detail']), ('holiday', 'Founders Day'))
        self.assertEqual(m[self.d_absent.isoformat()]['status'], 'absent')
        if self.d_weekend.isoformat() in m:
            self.assertEqual(m[self.d_weekend.isoformat()]['status'], 'weekend')
        if TODAY.weekday() < 5:
            self.assertEqual(m[TODAY.isoformat()]['status'], 'pending')
        self.assertEqual(d['results'][0]['date'], TODAY.isoformat())             # newest first
        self.assertEqual(d['counts']['absent'], 1)

    def test_days_before_joining_and_after_today_are_left_out(self):
        d = self.days(**{'from': back(60).isoformat(), 'to': (TODAY + timedelta(days=5)).isoformat(), 'pageSize': 100})
        dates = [x['date'] for x in d['results']]
        self.assertEqual(min(dates), back(40).isoformat())
        self.assertEqual(max(dates), TODAY.isoformat())
        self.assertEqual(d['total'], 41)

    def test_filters(self):
        rng = {'from': self.d_absent.isoformat(), 'to': TODAY.isoformat(), 'pageSize': 100}
        late = self.days(status='late', **rng)
        self.assertEqual([x['status'] for x in late['results']], ['late'])
        both = self.days(status='late,absent', **rng)
        self.assertEqual(sorted(x['status'] for x in both['results']), ['absent', 'late'])
        wfh = self.days(mode='wfh', **rng)
        self.assertEqual([x['date'] for x in wfh['results']], [self.d_wfh.isoformat()])
        issues = self.days(issues='1', **rng)
        self.assertEqual(sorted(x['status'] for x in issues['results']), ['absent', 'late'])
        # counts describe the whole range, not just the filtered rows
        self.assertEqual(late['counts']['present'], 2)

    def test_pagination(self):
        rng = {'from': back(40).isoformat(), 'to': TODAY.isoformat()}
        p1 = self.days(pageSize=10, page=1, **rng)
        p5 = self.days(pageSize=10, page=5, **rng)
        self.assertEqual((p1['total'], p1['pages'], len(p1['results'])), (41, 5, 10))
        self.assertEqual(len(p5['results']), 1)
        self.assertEqual(self.days(pageSize=10, page=99, **rng)['page'], 5)      # clamped
        self.assertEqual(self.days(pageSize=7, **rng)['pageSize'], 20)          # only allowed sizes

    def test_csv_export(self):
        r = self.get('asha@x.com', export='csv', **{'from': self.d_absent.isoformat(), 'to': TODAY.isoformat()})
        self.assertEqual(r.status_code, 200)
        self.assertIn('attachment', r['Content-Disposition'])
        rows = list(csv.reader(io.StringIO(r.content.decode('utf-8'))))
        self.assertEqual(rows[0][:3], ['Date', 'Day', 'Status'])
        self.assertTrue(any(x[2] == 'holiday' and 'Founders Day' in x[10] for x in rows[1:]))

    def test_access(self):
        self.assertEqual(self.get('asha@x.com').status_code, 200)              # self
        self.assertEqual(self.get('hr@x.com').status_code, 200)                # attendance.view
        self.assertEqual(self.get('ravi@x.com').status_code, 403)              # someone else
        self.assertEqual(Client().get('/api/attendance/history', {'email': 'asha@x.com'}).status_code in (401, 403), True)

    def test_range_limit(self):
        r = self.get('asha@x.com', **{'from': back(400).isoformat(), 'to': TODAY.isoformat()})
        self.assertEqual(r.status_code, 400)
