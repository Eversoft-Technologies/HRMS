"""My Team command center (api/team_hub.py, /api/my-team/*).

The hub must be ONE unit with the existing features: it lists only what each
feature's own permission rules let the caller decide, and decides through the
feature's own endpoint — so a decision made here has exactly the effect of the
same decision made on the feature's page."""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from unittest.mock import patch

import jwt
from django.conf import settings
from django.test import Client, TestCase

from api import team_hub
from api.models import (AppUser, AttendanceCorrection, AttendanceEvent, EmployeeAttendance, EmployeeLoan,
                        EmployeeTask, ExpenseClaim, HolidayCalendar, HolidayCalendarAssignment,
                        HolidayCalendarDay, LeaveRequest, OnboardingCandidate, Permission, Role, RolePermission,
                        Shift, ShiftAssignment, Team, TeamMembership, TimesheetWeek, UserProfile, WfhRequest)

NOW = datetime(2026, 11, 18, 11, 0)          # a Wednesday
TODAY = NOW.date()
YDAY = TODAY - timedelta(days=1)


@contextmanager
def at(when=NOW):
    with patch('api.views.local_now', return_value=when), \
            patch('api.views.local_today', return_value=when.date()), \
            patch('api.attendance_ext.missed_punch.local_now', return_value=when), \
            patch('api.attendance_ext.regularization.local_now', return_value=when):
        yield


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


def token_for(email):
    return jwt.encode({'email': email, 'exp': datetime.utcnow() + timedelta(minutes=30)},
                      settings.SECRET_KEY, algorithm='HS256')


class HubBase(TestCase):
    PEOPLE = (
        # email, role, manager, department
        ('boss@x.com', 'emp', '', 'Engineering'),
        ('a@x.com', 'emp', 'boss@x.com', 'Engineering'),
        ('b@x.com', 'emp', 'boss@x.com', 'Engineering'),
        ('c@x.com', 'emp', 'boss@x.com', 'Engineering'),
        ('deep@x.com', 'emp', 'a@x.com', 'Engineering'),
        ('mgr2@x.com', 'emp', '', 'Sales'),
        ('other@x.com', 'emp', 'mgr2@x.com', 'Sales'),
        ('hr@x.com', 'hr', '', 'People'),
        ('solo@x.com', 'emp', '', 'Sales'),
    )

    def setUp(self):
        from api import permissions
        permissions._CACHE.clear()
        self.mail = patch('api.mailer.send_email', return_value={'ok': True})
        self.mail.start()
        self.addCleanup(self.mail.stop)
        emp = Role.objects.create(name='Employee')
        grant(emp, 'attendance.create', 'leave.create')
        hr = Role.objects.create(name='HR Manager')
        grant(hr, 'employee.view', 'attendance.edit', 'leave.action', 'attendance.approve_wfh', 'attendance.approve_offsite',
              'attendance.view', 'attendance.edit', 'expense.approve', 'payroll.loans.approve', 'timesheet.approve')
        roles = {'emp': emp, 'hr': hr}
        self.shift = Shift.objects.create(id=1, name='Day', start_time=time(9, 0), end_time=time(18, 0),
                                          grace_minutes=15, break_minutes=60, overtime_after_minutes=540)
        for email, role, mgr, dept in self.PEOPLE:
            AppUser.objects.create(email=email, full_name=email.split('@')[0].title(), password='x',
                                   role='employee', role_ref=roles[role], status='active')
            UserProfile.objects.create(email=email, first_name=email.split('@')[0].title(), manager_email=mgr,
                                       department=dept)
            ShiftAssignment.objects.create(email=email, shift=self.shift, effective_from=TODAY - timedelta(days=90))

    def c(self, email, fresh=False):
        if fresh:
            return Client(HTTP_X_USER_EMAIL=email, HTTP_AUTHORIZATION='Bearer ' + token_for(email))
        return Client(HTTP_X_USER_EMAIL=email)

    def get(self, who, url, **kw):
        with at(kw.pop('when', NOW)):
            r = self.c(who).get(url, kw)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def decide(self, who, typ, pk, action='approve', note='', fresh=False):
        with at():
            return self.c(who, fresh).post('/api/my-team/inbox/decide',
                                           {'type': typ, 'id': pk, 'action': action, 'note': note},
                                           content_type='application/json')

    def leave(self, email, status='Pending', start=TODAY + timedelta(days=2), days=2, approver='boss@x.com'):
        return LeaveRequest.objects.create(email=email, employee_name=email.split('@')[0].title(),
                                           type='Casual Leave', from_date=start,
                                           to_date=start + timedelta(days=days - 1), days=days,
                                           status=status, approver_email=approver)

    def wfh(self, email, status='Pending', start=TODAY + timedelta(days=1), approver='boss@x.com'):
        return WfhRequest.objects.create(email=email, employee_name=email.split('@')[0].title(),
                                         from_date=start, to_date=start, days=1, status=status,
                                         approver_email=approver, reason='Plumber visit')

    def open_day(self, email, day=YDAY, start=time(9, 0), **kw):
        cin = datetime.combine(day, start)
        att = EmployeeAttendance.objects.create(email=email, employee_name=email.split('@')[0].title(), date=day,
                                                check_in=cin, shift_id=self.shift.id, status='present', **kw)
        AttendanceEvent.objects.create(email=email, date=day, event='check-in', at=cin,
                                       location=kw.get('device') == 'mobile' and 'Home' or 'Office')
        return att

    def regularization(self, email='c@x.com'):
        self.open_day(email)
        return AttendanceCorrection.objects.create(
            email=email, employee_name=email.split('@')[0].title(), attendance_date=YDAY,
            requested_check_out=datetime.combine(YDAY, time(18, 30)), reason='Forgot', reason_code='forgot_badge',
            kind='regularize', reviewer_email='boss@x.com', status='Pending')


class ScopeTests(HubBase):
    def test_manager_sees_only_direct_reports_and_optionally_the_tree(self):
        d = self.get('boss@x.com', '/api/my-team/members')
        self.assertEqual([m['email'] for m in d['members']], ['a@x.com', 'b@x.com', 'c@x.com'])
        self.assertEqual(d['scope']['kind'], 'reports')
        self.assertFalse(d['canViewAll'])
        d = self.get('boss@x.com', '/api/my-team/members', indirect='1')
        self.assertEqual({m['email'] for m in d['members']}, {'a@x.com', 'b@x.com', 'c@x.com', 'deep@x.com'})
        # a manager cannot look at another manager's team, a department or everyone
        with at():
            for q in ({'manager': 'mgr2@x.com'}, {'department': 'Sales'}, {'scope': 'all'}):
                self.assertEqual(self.c('boss@x.com').get('/api/my-team/presence', q).status_code, 403, q)

    def test_hr_scope_by_permission(self):
        d = self.get('hr@x.com', '/api/my-team/members')
        self.assertEqual(d['scope']['kind'], 'all')                  # HR without reports: everyone
        self.assertNotIn('hr@x.com', [m['email'] for m in d['members']])
        self.assertIn('mgr2@x.com', [m['email'] for m in d['options']['managers']])
        self.assertIn('Sales', d['options']['departments'])
        d = self.get('hr@x.com', '/api/my-team/members', manager='mgr2@x.com')
        self.assertEqual([m['email'] for m in d['members']], ['other@x.com'])
        d = self.get('hr@x.com', '/api/my-team/members', department='Sales')
        self.assertEqual({m['email'] for m in d['members']}, {'mgr2@x.com', 'other@x.com', 'solo@x.com'})

    def test_team_lead_scope(self):
        t = Team.objects.create(name='Platform', lead_email='mgr2@x.com')
        for e in ('mgr2@x.com', 'deep@x.com', 'c@x.com'):
            TeamMembership.objects.create(team=t, email=e)
        d = self.get('mgr2@x.com', '/api/my-team/members', teamId=t.id)
        self.assertEqual({m['email'] for m in d['members']}, {'deep@x.com', 'c@x.com'})
        with at():
            self.assertEqual(self.c('boss@x.com').get('/api/my-team/members', {'teamId': t.id}).status_code, 404)

    def test_employee_without_reports_gets_an_empty_team(self):
        d = self.get('solo@x.com', '/api/my-team/members')
        self.assertEqual(d['members'], [])
        s = self.get('solo@x.com', '/api/my-team/summary')
        self.assertEqual((s['isManager'], s['show'], s['pending']), (False, False, 0))
        self.assertEqual(self.get('solo@x.com', '/api/my-team/inbox')['items'], [])

    def test_anonymous_is_refused(self):
        self.assertEqual(Client().get('/api/my-team/summary').status_code, 401)
        self.assertEqual(Client().post('/api/my-team/inbox/batch', {}, content_type='application/json').status_code, 401)

    def test_summary_badge(self):
        self.leave('a@x.com')
        self.wfh('b@x.com')
        self.leave('other@x.com', approver='mgr2@x.com')             # not boss's
        s = self.get('boss@x.com', '/api/my-team/summary')
        self.assertEqual((s['isManager'], s['show'], s['pending'], s['directReports']), (True, True, 2, 3))
        self.assertEqual((s['byType']['leave'], s['byType']['wfh']), (1, 1))
        h = self.get('hr@x.com', '/api/my-team/summary')
        self.assertEqual((h['isManager'], h['show'], h['canViewAll'], h['pending']), (False, True, True, 3))


class InboxTests(HubBase):
    def seed_all(self):
        self.lv = self.leave('a@x.com')
        self.wf = self.wfh('b@x.com')
        self.reg = self.regularization('c@x.com')
        self.ts = TimesheetWeek.objects.create(email='a@x.com', week_start=TODAY - timedelta(days=9), status='Submitted',
                                               total_hours=Decimal('40'), approver_email='boss@x.com',
                                               submitted_at=NOW - timedelta(days=2))
        self.exp = ExpenseClaim.objects.create(email='b@x.com', category='travel', amount=Decimal('1234.50'),
                                               expense_date=YDAY, description='Cab', status='submitted',
                                               approver_email='boss@x.com')
        self.loan = EmployeeLoan.objects.create(email='c@x.com', kind='advance', principal=Decimal('20000'),
                                                tenure_months=4, status='requested')
        self.off = EmployeeAttendance.objects.create(email='a@x.com', date=TODAY, check_in=NOW - timedelta(hours=2),
                                                     location_status='Pending', location_reason='Client site')
        self.foreign = self.leave('other@x.com', approver='mgr2@x.com')

    def test_inbox_lists_each_type_the_caller_may_decide(self):
        self.seed_all()
        d = self.get('boss@x.com', '/api/my-team/inbox')
        keys = {i['key'] for i in d['items']}
        self.assertEqual(keys, {f'leave:{self.lv.id}', f'wfh:{self.wf.id}', f'regularization:{self.reg.id}',
                                f'timesheet:{self.ts.id}', f'expense:{self.exp.id}'})
        # a manager decides expenses but holds no expense.approve: no amount
        exp = next(i for i in d['items'] if i['type'] == 'expense')
        self.assertNotIn('amount', exp)
        self.assertTrue(next(i for i in d['items'] if i['type'] == 'timesheet')['noteRequired'])
        self.assertFalse(next(i for i in d['items'] if i['type'] == 'leave')['noteRequired'])
        # HR (permission scope): everything, incl. loans + off-site, with amounts
        d = self.get('hr@x.com', '/api/my-team/inbox')
        keys = {i['key'] for i in d['items']}
        for k in (f'loan:{self.loan.id}', f'offsite:{self.off.id}', f'leave:{self.foreign.id}'):
            self.assertIn(k, keys)
        exp = next(i for i in d['items'] if i['type'] == 'expense')
        self.assertEqual((exp['amount'], exp['currency']), (1234.5, 'INR'))
        # type filter
        d = self.get('boss@x.com', '/api/my-team/inbox', types='leave,wfh')
        self.assertEqual({i['type'] for i in d['items']}, {'leave', 'wfh'})

    def test_leave_decided_via_hub_equals_the_original_endpoint(self):
        via_hub, via_page = self.leave('a@x.com'), self.leave('b@x.com')
        r = self.decide('boss@x.com', 'leave', via_hub.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['ok'])
        with at():
            r2 = self.c('boss@x.com').put(f'/api/leave/{via_page.id}', {'status': 'Approved'},
                                          content_type='application/json')
        self.assertEqual(r2.status_code, 200, r2.content)
        via_hub.refresh_from_db()
        via_page.refresh_from_db()
        fields = ('status', 'approver', 'approver_email', 'days', 'from_date', 'to_date', 'type')
        self.assertEqual([getattr(via_hub, f) for f in fields[:3]], [getattr(via_page, f) for f in fields[:3]])
        self.assertEqual((via_hub.status, via_hub.approver_email), ('Approved', 'boss@x.com'))
        from api.models import Notification
        self.assertTrue(Notification.objects.filter(recipient='a@x.com', title='Leave request update').exists())

    def test_regularization_approved_via_hub_recalculates_the_day(self):
        reg = self.regularization('c@x.com')
        r = self.decide('boss@x.com', 'regularization', reg.id)
        self.assertEqual(r.status_code, 200, r.content)
        reg.refresh_from_db()
        att = EmployeeAttendance.objects.get(email='c@x.com', date=YDAY)
        self.assertEqual(reg.status, 'Approved')
        self.assertEqual(att.check_out, datetime.combine(YDAY, time(18, 30)))
        self.assertGreater(att.worked_minutes, 8 * 60)

    def test_wfh_via_hub_uses_the_wfh_approval_flow(self):
        w = self.wfh('b@x.com', start=TODAY)
        r = self.decide('boss@x.com', 'wfh', w.id)
        self.assertEqual(r.status_code, 200, r.content)
        w.refresh_from_db()
        self.assertEqual(w.status, 'Approved')
        self.assertTrue(EmployeeAttendance.objects.get(email='b@x.com', date=TODAY).is_wfh)   # the flow's own side effect

    def test_batch_with_a_failing_item_reports_per_item(self):
        lv = self.leave('a@x.com')
        w = self.wfh('b@x.com')
        done = self.leave('c@x.com', status='Approved')
        foreign = self.leave('other@x.com', approver='mgr2@x.com')
        with at():
            r = self.c('boss@x.com').post('/api/my-team/inbox/batch', {'action': 'approve', 'items': [
                {'type': 'leave', 'id': lv.id}, f'wfh:{w.id}', {'key': f'leave:{done.id}'},
                {'type': 'leave', 'id': foreign.id}, {'type': 'leave', 'id': lv.id}]},
                content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d['total'], d['ok'], d['failed']), (4, 2, 2))
        res = {x['key']: x for x in d['results']}
        self.assertEqual(res[f'leave:{done.id}']['status'], 409)
        self.assertIn('already approved', res[f'leave:{done.id}']['message'])
        self.assertEqual(res[f'leave:{foreign.id}']['status'], 403)       # the leave endpoint's own refusal
        lv.refresh_from_db()
        w.refresh_from_db()
        foreign.refresh_from_db()
        self.assertEqual((lv.status, w.status, foreign.status), ('Approved', 'Approved', 'Pending'))

    def test_self_approval_is_refused_and_never_listed(self):
        own = self.leave('hr@x.com', approver='')
        self.assertNotIn(f'leave:{own.id}', {i['key'] for i in self.get('hr@x.com', '/api/my-team/inbox')['items']})
        r = self.decide('hr@x.com', 'leave', own.id)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()['code'], 'SELF_APPROVAL')
        own.refresh_from_db()
        self.assertEqual(own.status, 'Pending')

    def test_reject_note_rules_and_fresh_signin_are_surfaced(self):
        claim = ExpenseClaim.objects.create(email='b@x.com', category='travel', amount=Decimal('500'),
                                            expense_date=YDAY, description='Cab', status='submitted',
                                            approver_email='boss@x.com')
        r = self.decide('boss@x.com', 'expense', claim.id, 'reject')
        self.assertEqual(r.status_code, 400)                          # a reason is required
        r = self.decide('boss@x.com', 'expense', claim.id, 'reject', 'No receipt')
        self.assertEqual(r.status_code, 401)                          # ess needs a fresh sign-in token
        self.assertEqual(r.json()['code'], 'REAUTH_REQUIRED')
        r = self.decide('boss@x.com', 'expense', claim.id, 'reject', 'No receipt', fresh=True)
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual((claim.status, claim.decision_note, claim.decided_by), ('rejected', 'No receipt', 'boss@x.com'))

    def test_timesheet_and_offsite_and_loan(self):
        ts = TimesheetWeek.objects.create(email='a@x.com', week_start=TODAY - timedelta(days=9), status='Submitted',
                                          total_hours=Decimal('38'), approver_email='boss@x.com')
        r = self.decide('boss@x.com', 'timesheet', ts.id, 'reject', 'Missing Friday')
        self.assertEqual(r.status_code, 200, r.content)
        ts.refresh_from_db()
        self.assertEqual((ts.status, ts.decision_note), ('Rejected', 'Missing Friday'))
        off = EmployeeAttendance.objects.create(email='a@x.com', date=TODAY, check_in=NOW, location_status='Pending')
        self.assertEqual(self.decide('boss@x.com', 'offsite', off.id).status_code, 403)   # managers lack the perm
        self.assertEqual(self.decide('hr@x.com', 'offsite', off.id).status_code, 200)
        off.refresh_from_db()
        self.assertEqual((off.location_status, off.geo_verified), ('Approved', True))
        loan = EmployeeLoan.objects.create(email='c@x.com', kind='advance', principal=Decimal('1000'),
                                           tenure_months=1, status='requested')
        self.assertEqual(self.decide('boss@x.com', 'loan', loan.id, fresh=True).status_code, 403)
        self.assertEqual(self.decide('hr@x.com', 'loan', loan.id, fresh=True).status_code, 200)
        loan.refresh_from_db()
        self.assertEqual(loan.status, 'approved')


class PresenceTests(HubBase):
    def test_buckets(self):
        AppUser.objects.create(email='d@x.com', full_name='D', status='active', role='employee')
        UserProfile.objects.create(email='d@x.com', first_name='D', manager_email='boss@x.com')
        AppUser.objects.create(email='e@x.com', full_name='E', status='active', role='employee')
        UserProfile.objects.create(email='e@x.com', first_name='E', manager_email='boss@x.com')
        self.open_day('a@x.com', day=TODAY)                                   # in office
        self.leave('b@x.com', status='Approved', start=TODAY, days=1)        # on leave
        cal = HolidayCalendar.objects.create(name='Local', country='IN', include_national=False)
        HolidayCalendarDay.objects.create(calendar=cal, date=TODAY, name='Local Fest')
        HolidayCalendarAssignment.objects.create(email='c@x.com', calendar=cal)   # c: holiday
        e = self.open_day('e@x.com', day=TODAY, device='mobile')
        e.is_wfh = True
        e.save()
        d = self.get('boss@x.com', '/api/my-team/presence')
        b = {m['email']: m for m in d['members']}
        self.assertEqual({k: b[k]['bucket'] for k in b},
                         {'a@x.com': 'office', 'b@x.com': 'leave', 'c@x.com': 'holiday', 'd@x.com': 'notin',
                          'e@x.com': 'remote'})
        self.assertEqual(b['c@x.com']['holiday'], 'Local Fest')
        self.assertEqual(b['a@x.com']['checkIn'], '2026-11-18 09:00:00')
        self.assertTrue(b['d@x.com']['late'])
        self.assertEqual((d['counts']['office'], d['counts']['leave'], d['counts']['notin']), (1, 1, 1))
        # Saturday: nobody checked in is "off"
        sat = datetime(2026, 11, 21, 11, 0)
        d = self.get('boss@x.com', '/api/my-team/presence', when=sat)
        self.assertEqual({m['email']: m['bucket'] for m in d['members']}['d@x.com'], 'off')

    def test_company_work_week_decides_the_off_day(self):
        from api.models import CompanyDetail
        CompanyDetail.objects.create(company_name='X', work_week=['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
        sat = datetime(2026, 11, 21, 11, 0)
        d = {m['email']: m['bucket'] for m in self.get('boss@x.com', '/api/my-team/presence', when=sat)['members']}
        self.assertEqual(d['c@x.com'], 'notin')            # Saturday is a work day here
        sun = datetime(2026, 11, 22, 11, 0)
        d = {m['email']: m['bucket'] for m in self.get('boss@x.com', '/api/my-team/presence', when=sun)['members']}
        self.assertEqual(d['c@x.com'], 'off')

    def test_break_and_checked_out(self):
        a = self.open_day('a@x.com', day=TODAY)
        a.presence, a.presence_at = 'Away', NOW
        a.save()
        b = self.open_day('b@x.com', day=TODAY)
        b.check_out = NOW - timedelta(minutes=5)
        b.save()
        d = {m['email']: m['bucket'] for m in self.get('boss@x.com', '/api/my-team/presence')['members']}
        self.assertEqual((d['a@x.com'], d['b@x.com']), ('break', 'out'))


class WorkloadTests(HubBase):
    def test_flags_with_reasons(self):
        for i in range(7):
            EmployeeTask.objects.create(title=f'T{i}', assignee_email='a@x.com', priority='high', stage='todo')
        EmployeeTask.objects.create(title='done', assignee_email='a@x.com', priority='high', stage='done')
        monday = TODAY - timedelta(days=TODAY.weekday())
        for i in range(3):          # b: three 11-hour days in a row
            EmployeeAttendance.objects.create(email='b@x.com', date=monday + timedelta(days=i),
                                              check_in=datetime.combine(monday + timedelta(days=i), time(8, 0)),
                                              worked_minutes=11 * 60, overtime_minutes=120)
        EmployeeTask.objects.create(title='x', assignee_email='b@x.com', priority='low', stage='todo')
        d = self.get('boss@x.com', '/api/my-team/workload')
        self.assertEqual(d['weekStart'], monday.isoformat())
        m = {r['email']: r for r in d['members']}
        self.assertEqual(m['a@x.com']['state'], 'overloaded')
        self.assertIn('7 open high-priority tasks', m['a@x.com']['flags'][0]['reason'])
        self.assertEqual(m['a@x.com']['tasks']['open'], 7)
        self.assertEqual(m['b@x.com']['state'], 'overloaded')
        self.assertIn('3 consecutive days over 10 h', ' '.join(f['reason'] for f in m['b@x.com']['flags']))
        self.assertEqual(m['b@x.com']['overtimeDays'], 3)
        self.assertEqual(m['c@x.com']['state'], 'underutilized')         # 0 h of 16 h, no tasks
        self.assertEqual(m['c@x.com']['expectedHours'], 16)
        # thresholds are configurable
        d = self.get('boss@x.com', '/api/my-team/workload', maxHighTasks='10', longDayRun='4')
        m = {r['email']: r for r in d['members']}
        self.assertEqual((m['a@x.com']['state'], m['b@x.com']['state']), ('ok', 'ok'))


class CalendarTests(HubBase):
    def test_month_items(self):
        UserProfile.objects.filter(email='a@x.com').update(start_date=date(2023, 11, 25))
        self.leave('a@x.com', status='Approved', start=date(2026, 11, 20), days=2)
        self.leave('c@x.com', status='Rejected', start=date(2026, 11, 20), days=1)   # not shown
        self.wfh('b@x.com', status='Pending', start=date(2026, 11, 23))
        cal = HolidayCalendar.objects.create(name='Local', country='IN', include_national=False)
        HolidayCalendarDay.objects.create(calendar=cal, date=date(2026, 11, 27), name='Local Fest')
        HolidayCalendarAssignment.objects.create(email='c@x.com', calendar=cal)
        EmployeeTask.objects.create(title='Ship it', assignee_email='a@x.com', due='2026-11-25', stage='todo')
        EmployeeTask.objects.create(title='Spec', assignee_email='b@x.com', due='26/11/2026', stage='inprogress')
        EmployeeTask.objects.create(title='Vague', assignee_email='b@x.com', due='next week', stage='todo')
        EmployeeTask.objects.create(title='Old', assignee_email='b@x.com', due='2026-11-02', stage='done')
        OnboardingCandidate.objects.create(email='a@x.com', first_name='A', dob=date(1990, 11, 9))
        d = self.get('boss@x.com', '/api/my-team/calendar', month='2026-11')
        kinds = [(i['kind'], i['date'], i.get('title')) for i in d['items']]
        self.assertIn(('leave', '2026-11-20', 'Casual Leave'), kinds)
        self.assertIn(('wfh', '2026-11-23', 'Work from home'), kinds)
        self.assertIn(('holiday', '2026-11-27', 'Local Fest'), kinds)
        self.assertIn(('anniversary', '2026-11-25', '3 years at the company'), kinds)
        self.assertIn(('deadline', '2026-11-25', 'Ship it'), kinds)
        self.assertIn(('deadline', '2026-11-26', 'Spec'), kinds)
        self.assertNotIn('Vague', [k[2] for k in kinds])
        self.assertNotIn('Old', [k[2] for k in kinds])
        self.assertEqual(sum(1 for k in kinds if k[0] == 'leave'), 1)
        self.assertNotIn('birthday', [k[0] for k in kinds])                 # privacy: off by default
        self.assertEqual((d['birthdaysIncluded'], d['birthdaysAvailable']), (False, 1))
        d = self.get('boss@x.com', '/api/my-team/calendar', month='2026-11', birthdays='1')
        self.assertIn(('birthday', '2026-11-09'), [(i['kind'], i['date']) for i in d['items']])

    def test_parse_due(self):
        p = team_hub.parse_due
        self.assertEqual(p('2026-11-25'), date(2026, 11, 25))
        self.assertEqual(p('2026-11-25T10:00:00Z'), date(2026, 11, 25))
        self.assertEqual(p('25/11/2026'), date(2026, 11, 25))
        self.assertEqual(p('Nov 25, 2026'), date(2026, 11, 25))
        self.assertEqual(p('25 Nov 2026'), date(2026, 11, 25))
        for bad in ('', None, 'soon', '2026-13-40', '31/02/2026'):
            self.assertIsNone(p(bad), bad)


class DirectoryPermissionIsNotHrScopeTests(HubBase):
    """employee.view / employee.edit are directory rights that plain employees
    hold on real installs; they must not open other people's teams."""

    def setUp(self):
        super().setUp()
        grant(Role.objects.get(name='Employee'), 'employee.view', 'employee.edit', 'employee.create')

    def test_plain_employee_with_directory_rights_has_no_hub(self):
        d = self.get('solo@x.com', '/api/my-team/summary')
        self.assertFalse(d['show'])
        self.assertFalse(d['canViewAll'])
        with at():
            r = self.c('solo@x.com').get('/api/my-team/presence', {'scope': 'all'})
        self.assertEqual(r.status_code, 403)

    def test_hr_still_sees_everyone(self):
        d = self.get('hr@x.com', '/api/my-team/summary')
        self.assertTrue(d['show'])
        self.assertTrue(d['canViewAll'])


class ProjectScopeTests(HubBase):
    """scope=project: people with a matrix ReportingLine to the caller as their
    project / scrum lead. Members, presence, calendar, workload — never approvals."""

    def setUp(self):
        super().setUp()
        from hrms_plus.models import ReportingLine
        # mgr2 leads Project Alpha: a (60%) and c (30%); boss manages a, b, c.
        ReportingLine.objects.create(email='a@x.com', lead_email='mgr2@x.com', project='Alpha', allocation_pct=60)
        ReportingLine.objects.create(email='c@x.com', lead_email='mgr2@x.com', project='Alpha', allocation_pct=30)
        ReportingLine.objects.create(email='b@x.com', lead_email='mgr2@x.com', project='Old', allocation_pct=10,
                                     is_active=False)

    def test_project_team_members_presence_calendar_workload(self):
        d = self.get('mgr2@x.com', '/api/my-team/members', scope='project')
        self.assertEqual(d['scope']['kind'], 'project')
        self.assertFalse(d['scope']['approvals'])
        self.assertEqual([m['email'] for m in d['members']], ['a@x.com', 'c@x.com'])
        self.assertEqual(d['leadsProjects'], 2)
        self.assertEqual(d['members'][0]['allocation']['label'], '60% Alpha, 40% line team')
        p = self.get('mgr2@x.com', '/api/my-team/presence', scope='project')
        self.assertEqual({m['email'] for m in p['members']}, {'a@x.com', 'c@x.com'})
        self.leave('a@x.com', status='Approved', start=TODAY, days=1)
        c = self.get('mgr2@x.com', '/api/my-team/calendar', scope='project')
        self.assertIn('a@x.com', {i.get('email') for i in c['items'] if i['kind'] == 'leave'})
        w = self.get('mgr2@x.com', '/api/my-team/workload', scope='project')
        m = {r['email']: r for r in w['members']}
        self.assertEqual(m['c@x.com']['allocation']['projectPct'], 30)
        self.assertTrue(w['showAllocation'])
        # the default (line) scope is unchanged: mgr2's direct report only
        d = self.get('mgr2@x.com', '/api/my-team/members')
        self.assertEqual([m['email'] for m in d['members']], ['other@x.com'])

    def test_project_lead_gets_no_approvals(self):
        self.leave('a@x.com')                       # routed to boss, a's line manager
        self.leave('c@x.com', approver='mgr2@x.com')  # even one routed to the lead by name
        d = self.get('mgr2@x.com', '/api/my-team/inbox', scope='project')
        self.assertEqual((d['items'], d['count']), ([], 0))
        self.assertIn('line manager', d['note'])
        # the line manager still gets them
        self.assertIn('a@x.com', [i['email'] for i in self.get('boss@x.com', '/api/my-team/inbox')['items']])

    def test_summary_and_scope_rules(self):
        s = self.get('mgr2@x.com', '/api/my-team/summary')
        self.assertEqual((s['leadsProjects'], s['show']), (2, True))
        # someone who leads nothing has an empty project team and still no hub
        self.assertEqual(self.get('solo@x.com', '/api/my-team/members', scope='project')['members'], [])
        self.assertFalse(self.get('solo@x.com', '/api/my-team/summary')['show'])
        # only HR may look at another lead's project team
        with at():
            self.assertEqual(self.c('boss@x.com').get('/api/my-team/members',
                                                      {'scope': 'project', 'lead': 'mgr2@x.com'}).status_code, 403)
        d = self.get('hr@x.com', '/api/my-team/members', scope='project', lead='mgr2@x.com')
        self.assertEqual(len(d['members']), 2)
        # the line manager sees the split of their own reports in their workload
        w = self.get('boss@x.com', '/api/my-team/workload')
        m = {r['email']: r for r in w['members']}
        self.assertEqual(m['a@x.com']['allocation']['label'], '60% Alpha, 40% line team')
        self.assertEqual(m['b@x.com']['allocation']['label'], '100% line team')
