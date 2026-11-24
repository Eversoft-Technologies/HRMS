"""Attendance policy profiles + day status from hours (workstream P).

api/attendance_ext/policy.py (resolution), day_status.py (present / late /
half-day / absent from worked minutes), its use at check-out, in an approved
regularization and in ``recalc_attendance --policy``, the profile's
regularization deadline, payroll's LOP from the new statuses, and the
settings API (policy_views.py).
"""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import Client, TestCase

from api.attendance_ext import day_status as ds
from api.attendance_ext import missed_punch as mp
from api.attendance_ext import policy as pol
from api.models import (AppUser, AttendanceAuditLog, AttendanceEvent, AttendancePolicyAssignment,
                        AttendancePolicyProfile, EmployeeAttendance, GeoFence, Permission, Role, RolePermission,
                        Shift, ShiftAssignment, ShortLeaveRequest, UserProfile)

OFFICE = (17.4485, 78.3908)
D = date(2026, 11, 2)          # a Monday


@contextmanager
def at(when):
    with patch('api.views.local_now', return_value=when), \
            patch('api.views.local_today', return_value=when.date()), \
            patch('api.attendance_ext.missed_punch.local_now', return_value=when), \
            patch('api.attendance_ext.regularization.local_now', return_value=when), \
            patch('api.attendance_ext.short_leave.local_now', return_value=when):
        yield


def dt(day, h, m=0):
    return datetime.combine(day, time(h, m))


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class Base(TestCase):
    PEOPLE = (('emp@x.com', 'emp', 'boss@x.com', 'Engineering', 'Hyderabad'),
              ('boss@x.com', 'emp', '', 'Engineering', 'Hyderabad'),
              ('hr@x.com', 'hr', '', 'People', 'Hyderabad'),
              ('admin@x.com', 'admin', '', 'People', 'Hyderabad'),
              ('sales@x.com', 'emp', 'boss@x.com', 'Sales', 'Mumbai'),
              ('other@x.com', 'emp', '', 'Support', 'Pune'))

    def setUp(self):
        from api import permissions
        permissions._CACHE.clear()
        mp._LAST_RUN.clear()
        self.mail = patch('api.mailer.send_email', return_value={'ok': True})
        self.sent = self.mail.start()
        self.addCleanup(self.mail.stop)
        roles = {'emp': Role.objects.create(name='Employee'), 'hr': Role.objects.create(name='HR Manager'),
                 'admin': Role.objects.create(name='Settings Admin')}
        grant(roles['emp'], 'attendance.create')
        grant(roles['hr'], 'attendance.create', 'attendance.view', 'attendance.edit',
              'attendance.policy.view', 'attendance.penalty.waive', 'attendance.regularize.approve')
        grant(roles['admin'], 'attendance.create', 'settings.view', 'settings.manage',
              'attendance.policy.view', 'attendance.policy.manage')
        GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        self.shift = Shift.objects.create(name='Day', start_time=time(9, 0), end_time=time(18, 0), grace_minutes=15,
                                          break_minutes=60, overtime_after_minutes=540)
        self.c = {}
        for email, role, mgr, dept, loc in self.PEOPLE:
            AppUser.objects.create(email=email, full_name=email.split('@')[0].title(), password='x',
                                   role='employee', role_ref=roles[role], status='active')
            UserProfile.objects.create(email=email, first_name=email.split('@')[0], manager_email=mgr,
                                       department=dept, location=loc)
            ShiftAssignment.objects.create(email=email, shift=self.shift, effective_from=D - timedelta(days=60))
            self.c[email] = Client(HTTP_X_USER_EMAIL=email)

    # --- helpers -----------------------------------------------------------
    def post(self, who, path, **body):
        return self.c[who].post(path, body, content_type='application/json')

    def check_in(self, when, who='emp@x.com'):
        with at(when):
            r = self.post(who, '/api/attendance/check-in', email=who, employee=who,
                          latitude=OFFICE[0], longitude=OFFICE[1])
        self.assertIn(r.status_code, (200, 201), r.content)

    def check_out(self, when, who='emp@x.com'):
        with at(when):
            r = self.post(who, '/api/attendance/check-out', email=who, latitude=OFFICE[0], longitude=OFFICE[1])
        self.assertEqual(r.status_code, 200, r.content)

    def work(self, day, start, end, who='emp@x.com'):
        self.check_in(dt(day, *start), who)
        self.check_out(dt(day, *end), who)
        return self.row(day, who)

    def row(self, day=D, who='emp@x.com'):
        return EmployeeAttendance.objects.get(email=who, date=day)

    def closed_day(self, day, start, end, who='emp@x.com', status='present', **kw):
        """A closed day written directly (check-in / check-out events included)."""
        cin, cout = dt(day, *start), dt(day, *end)
        worked = int((cout - cin).total_seconds() // 60)
        att = EmployeeAttendance.objects.create(email=who, employee_name=who, date=day, check_in=cin, check_out=cout,
                                                worked_minutes=worked, shift_id=self.shift.id, status=status, **kw)
        AttendanceEvent.objects.create(email=who, date=day, event='check-in', at=cin)
        AttendanceEvent.objects.create(email=who, date=day, event='check-out', at=cout)
        return att

    def profile(self, name='Standard', **kw):
        return AttendancePolicyProfile.objects.create(name=name, **kw)


class ResolutionTests(Base):
    def test_builtin_when_there_is_no_profile(self):
        p = pol.resolve('emp@x.com')
        self.assertEqual((p.source, p.profile_id, p.full_day_minutes, p.penalty_leave_types),
                         ('builtin', None, 480, ['Casual Leave']))

    def test_precedence_assignment_department_location_default(self):
        default = self.profile('Default', is_default=True)
        by_loc = self.profile('Hyd', locations=['hyderabad'])
        by_dept = self.profile('Eng', departments=['Engineering'])
        solo = self.profile('Solo')
        AttendancePolicyAssignment.objects.create(email='emp@x.com', profile=solo)
        r = pol.Resolver()
        self.assertEqual((r.resolve('emp@x.com').profile_id, r.resolve('emp@x.com').source), (solo.id, 'assignment'))
        self.assertEqual((r.resolve('boss@x.com').profile_id, r.resolve('boss@x.com').source), (by_dept.id, 'department'))
        self.assertEqual((r.resolve('hr@x.com').profile_id, r.resolve('hr@x.com').source), (by_loc.id, 'location'))
        self.assertEqual((r.resolve('other@x.com').profile_id, r.resolve('other@x.com').source), (default.id, 'default'))

    def test_priority_breaks_ties_and_inactive_profiles_are_ignored(self):
        low = self.profile('Low', departments=['Engineering'], priority=1)
        high = self.profile('High', departments=['engineering '], priority=5)
        self.assertEqual(pol.resolve('boss@x.com').profile_id, high.id)
        high.is_active = False
        high.save()
        self.assertEqual(pol.resolve('boss@x.com').profile_id, low.id)

    def test_preview_applies_an_unsaved_draft(self):
        self.profile('Default', is_default=True)
        rows = {e: p for e, _prof, p in pol.preview({'name': 'Sales', 'departments': ['Sales']})}
        self.assertEqual((rows['sales@x.com'].profile_id, rows['sales@x.com'].source), (pol.DRAFT_ID, 'department'))
        self.assertEqual(rows['emp@x.com'].source, 'default')
        self.assertFalse(AttendancePolicyProfile.objects.filter(name='Sales').exists())     # nothing written


class ThresholdTests(Base):
    def test_hours_decide_absent_half_day_and_present(self):
        self.assertEqual(self.work(D, (9, 0), (12, 0)).status, 'absent')                 # 3h < 4h30
        self.assertEqual(self.work(D + timedelta(days=1), (9, 0), (15, 0)).status, 'half-day')   # 6h < 8h
        self.assertEqual(self.work(D + timedelta(days=2), (9, 0), (17, 30)).status, 'present')   # 8h30

    def test_open_day_is_not_classified(self):
        self.check_in(dt(D, 9, 0))
        self.assertEqual(self.row().status, 'present')
        self.assertIsNone(ds.classify(self.row()))

    def test_late_arrival_with_a_full_day_stays_late_and_profile_grace_applies(self):
        self.assertEqual(self.work(D, (9, 20), (17, 30)).status, 'late')                # shift grace 15
        self.profile('Lenient', is_default=True, grace_checkin_minutes=30)
        att = self.work(D + timedelta(days=1), (9, 20), (17, 30))
        self.assertEqual((att.status, att.late_minutes), ('present', 0))                 # profile grace 30

    def test_very_late_arrival_is_a_half_day(self):
        self.profile('Strict', is_default=True, late_half_day_after_minutes=60)
        self.assertEqual(self.work(D, (10, 30), (19, 0)).status, 'half-day')             # 90 min late, 8h30 worked
        self.assertEqual(self.work(D + timedelta(days=1), (9, 45), (18, 0)).status, 'late')

    def test_use_shift_hours(self):
        self.profile('Shift', is_default=True, use_shift_hours=True, full_day_minutes=600)
        # 9-18 with a 60-minute break = 480: 8h is a full day although full_day_minutes says 10h
        self.assertEqual(self.work(D, (9, 0), (17, 0)).status, 'present')
        AttendancePolicyProfile.objects.update(use_shift_hours=False)
        self.assertEqual(self.work(D + timedelta(days=1), (9, 0), (17, 0)).status, 'half-day')

    def test_approved_short_leave_counts_as_worked_and_covers_the_early_out(self):
        ShortLeaveRequest.objects.create(email='emp@x.com', date=D, kind='early_out', from_time=time(16, 0),
                                         to_time=time(18, 0), minutes=120, status='Approved')
        r = ds.classify(self.closed_day(D, (9, 0), (16, 0)))
        self.assertEqual((r.status, r.worked, r.credited, r.early_out, r.early_covered), ('present', 420, 540, False, True))
        ShortLeaveRequest.objects.update(status='Rejected')
        self.assertEqual(ds.classify(self.row()).status, 'half-day')

    def test_late_in_short_leave_suppresses_late(self):
        ShortLeaveRequest.objects.create(email='emp@x.com', date=D, kind='late_in', from_time=time(9, 0),
                                         to_time=time(10, 0), minutes=60, status='Approved')
        r = ds.classify(self.closed_day(D, (9, 55), (18, 0)))
        self.assertEqual((r.status, r.late_covered), ('present', True))

    def test_wfh_day_follows_the_same_thresholds(self):
        att = self.closed_day(D, (9, 0), (13, 0), is_wfh=True)
        self.assertEqual(ds.classify(att).status, 'absent')

    def test_reopening_a_short_day_makes_it_provisional_again(self):
        self.work(D, (9, 0), (12, 0))
        self.assertEqual(self.row().status, 'absent')
        self.check_in(dt(D, 13, 0))
        self.assertEqual(self.row().status, 'present')
        self.check_out(dt(D, 18, 0))                                   # 3h + 5h = 8h
        self.assertEqual((self.row().worked_minutes, self.row().status), (480, 'present'))


class PayrollTests(Base):
    def test_step_fetch_attendance_counts_half_and_absent_days_as_lop(self):
        from api.services.payroll_service import PayrollService
        self.work(D, (9, 0), (17, 30))                                      # present
        self.work(D + timedelta(days=1), (9, 0), (17, 30))                  # present
        self.work(D + timedelta(days=2), (9, 30), (18, 0))                  # late (full day)
        self.work(D + timedelta(days=3), (9, 0), (15, 0))                   # half-day
        self.work(D + timedelta(days=4), (9, 0), (11, 0))                   # absent
        rows = {r['email']: r for r in PayrollService.step_fetch_attendance(D, D + timedelta(days=4))}
        r = rows['emp@x.com']
        self.assertEqual((r['present_days'], r['half_days'], r['worked_days'], r['lop_days']), (2, 1, 3.5, 1.5))


class RegularizationAndRecalcTests(Base):
    def test_approved_regularization_classifies_the_day(self):
        self.check_in(dt(D, 9, 0))
        with at(dt(D + timedelta(days=1), 9, 0)):
            r = self.post('emp@x.com', '/api/attendance/regularization', date=D.isoformat(), checkOut='12:00',
                          reasonCode='forgot_badge')
            self.assertEqual(r.status_code, 201, r.content)
            r = self.post('boss@x.com', f'/api/attendance/regularization/{r.json()["id"]}/decide', action='approve')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((self.row().worked_minutes, self.row().status), (180, 'absent'))

    def test_recalc_attendance_policy_previews_then_applies(self):
        self.closed_day(D, (9, 0), (12, 0))                               # stored as present (pre-engine)
        self.closed_day(D + timedelta(days=1), (9, 0), (18, 0))            # already right
        out = StringIO()
        call_command('recalc_attendance', '--policy', '--from', D.isoformat(), '--to', (D + timedelta(days=1)).isoformat(),
                     stdout=out)
        self.assertIn('1 day(s) would change', out.getvalue())
        self.assertEqual(self.row().status, 'present')
        call_command('recalc_attendance', '--policy', '--from', D.isoformat(), '--apply', stdout=StringIO())
        self.assertEqual(self.row().status, 'absent')
        self.assertTrue(AttendanceAuditLog.objects.filter(email='emp@x.com', date=D, source='policy_recalc',
                                                          field='status', new_value='absent').exists())

    def test_profile_regularize_within_days_sets_the_deadline(self):
        att = EmployeeAttendance.objects.create(email='emp@x.com', date=D, check_in=dt(D, 9, 0), status='present',
                                                shift_id=self.shift.id)
        AttendanceEvent.objects.create(email='emp@x.com', date=D, event='check-in', at=dt(D, 9, 0))
        self.profile('Default', is_default=True, regularize_within_days=3)
        now = dt(D + timedelta(days=1), 0, 5)
        with at(now):
            mp.detect()
        att.refresh_from_db()
        self.assertEqual((att.punch_issue, att.regularize_by), ('missing_checkout', now + timedelta(days=3)))
        self.assertTrue(any('within 72 hours' in m for m in
                            __import__('api.models', fromlist=['Notification']).Notification.objects
                            .filter(recipient='emp@x.com').values_list('message', flat=True)))


class SettingsApiTests(Base):
    def test_permissions(self):
        self.assertEqual(self.c['emp@x.com'].get('/api/attendance/policies').status_code, 403)
        self.assertEqual(self.c['hr@x.com'].get('/api/attendance/policies').status_code, 200)       # attendance.edit reads
        self.assertEqual(self.post('hr@x.com', '/api/attendance/policies', name='X').status_code, 403)
        self.assertEqual(self.post('emp@x.com', '/api/attendance/policies', name='X').status_code, 403)
        r = self.post('admin@x.com', '/api/attendance/policies', name='Standard', is_default=True,
                      departments=['Engineering'])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(AttendancePolicyProfile.objects.get().created_by, 'admin@x.com')
        # the employee may read the rules that apply to them, not someone else's
        self.assertEqual(self.c['emp@x.com'].get('/api/attendance/policies/resolve').json()['profileName'], 'Standard')
        self.assertEqual(self.c['emp@x.com'].get('/api/attendance/policies/resolve?email=boss@x.com').status_code, 403)

    def test_crud_default_and_validation(self):
        a = self.post('admin@x.com', '/api/attendance/policies', name='A', is_default=True).json()
        b = self.post('admin@x.com', '/api/attendance/policies', name='B', is_default=True).json()
        self.assertFalse(AttendancePolicyProfile.objects.get(pk=a['id']).is_default)     # one default
        self.assertEqual(self.post('admin@x.com', '/api/attendance/policies', name='B').status_code, 409)
        r = self.c['admin@x.com'].patch(f'/api/attendance/policies/{b["id"]}',
                                        {'half_day_minutes': 500, 'full_day_minutes': 480},
                                        content_type='application/json')
        self.assertEqual(r.status_code, 400)
        r = self.c['admin@x.com'].patch(f'/api/attendance/policies/{b["id"]}',
                                        {'penalty_action': 'lop_half_day', 'free_lates_per_month': 2},
                                        content_type='application/json')
        self.assertEqual((r.status_code, r.json()['penalty_action'], sorted(r.json()['changed'])),
                         (200, 'lop_half_day', ['free_lates_per_month', 'penalty_action']))
        self.assertEqual(self.c['admin@x.com'].delete(f'/api/attendance/policies/{a["id"]}').status_code, 200)

    def test_assignments_counts_preview_and_options(self):
        p = self.post('admin@x.com', '/api/attendance/policies', name='Eng', departments=['Engineering']).json()
        r = self.post('admin@x.com', '/api/attendance/policies/assignments', profileId=p['id'], emails=['other@x.com'])
        self.assertEqual(r.status_code, 200, r.content)
        lst = self.c['admin@x.com'].get('/api/attendance/policies').json()
        eng = lst['profiles'][0]
        self.assertEqual((eng['employee_count'], eng['counts']), (3, {'department': 2, 'assignment': 1}))
        self.assertEqual(lst['builtinCount'], 3)
        prev = self.post('admin@x.com', '/api/attendance/policies/preview',
                         draft={'id': p['id'], 'name': 'Eng', 'departments': ['Engineering', 'Sales']}).json()
        rows = {x['email']: x for x in prev['rows']}
        self.assertEqual(rows['sales@x.com']['profileId'], p['id'])
        self.assertEqual(rows['other@x.com']['source'], 'assignment')
        opts = self.c['admin@x.com'].get('/api/attendance/policies/options').json()
        self.assertEqual(opts['departments'], ['Engineering', 'People', 'Sales', 'Support'])
        self.assertIn('Casual Leave', opts['leaveTypes'])
        # clearing the assignment
        self.post('admin@x.com', '/api/attendance/policies/assignments', profileId=None, emails=['other@x.com'])
        self.assertFalse(AttendancePolicyAssignment.objects.exists())
