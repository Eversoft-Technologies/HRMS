"""Individual timesheets (weekly approval) and the attendance audit trail."""
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api import attendance_recalc
from api.models import (AppUser, AttendanceAuditLog, AttendanceCorrection, EmployeeAttendance,
                        EmployeeTask, GeoFence, Notification, Permission, Role, RolePermission,
                        TimesheetEntry, TimesheetWeek, UserProfile)

MON = date(2026, 11, 2)          # a Monday
TUE = MON + timedelta(days=1)


def c(email):
    return Client(HTTP_X_USER_EMAIL=email)


class Base(TestCase):
    def setUp(self):
        approve, _ = Permission.objects.get_or_create(code='timesheet.approve', defaults={'name': 'Approve timesheets'})
        audit, _ = Permission.objects.get_or_create(code='attendance.audit', defaults={'name': 'Attendance audit'})
        hr_role, _ = Role.objects.get_or_create(name='HR Executive')
        RolePermission.objects.get_or_create(role=hr_role, permission=audit)
        pm_role, _ = Role.objects.get_or_create(name='Project Manager')
        RolePermission.objects.get_or_create(role=pm_role, permission=approve)

        AppUser.objects.create(email='emp@co.com', full_name='Emp Loyee', role='employee')
        AppUser.objects.create(email='mgr@co.com', full_name='Man Ager', role='employee')
        AppUser.objects.create(email='other@co.com', full_name='Oth Er', role='employee')
        AppUser.objects.create(email='hr@co.com', full_name='H R', role='employee', role_ref=hr_role)
        AppUser.objects.create(email='pm@co.com', full_name='P M', role='employee', role_ref=pm_role)
        AppUser.objects.create(email='admin@co.com', full_name='Ad Min', role='admin')
        UserProfile.objects.create(email='emp@co.com', first_name='Emp', last_name='Loyee', manager_email='mgr@co.com')
        UserProfile.objects.create(email='mgr@co.com', first_name='Man', last_name='Ager')

        self.emp, self.mgr, self.other = c('emp@co.com'), c('mgr@co.com'), c('other@co.com')
        self.hr, self.pm, self.admin = c('hr@co.com'), c('pm@co.com'), c('admin@co.com')

    def add(self, client=None, **kw):
        body = {'date': MON.isoformat(), 'project': 'Apollo', 'hours': 4, 'description': 'work', 'billable': True}
        body.update(kw)
        return (client or self.emp).post('/api/timesheets/entries', body, content_type='application/json')

    def submit(self, client=None):
        return (client or self.emp).post('/api/timesheets/week/submit', {'week': MON.isoformat()},
                                         content_type='application/json')

    def week_id(self):
        return TimesheetWeek.objects.get(email='emp@co.com', week_start=MON).id

    def decide(self, client, action, note=''):
        return client.post(f'/api/timesheets/week/{self.week_id()}/decide', {'action': action, 'note': note},
                           content_type='application/json')


class EntryTests(Base):
    def test_auth_required(self):
        r = Client().get('/api/timesheets/week')
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()['code'], 'AUTH_REQUIRED')

    def test_add_edit_delete(self):
        task = EmployeeTask.objects.create(title='Build login', assignee_email='emp@co.com', stage='todo')
        r = self.add(taskId=task.id)
        self.assertEqual(r.status_code, 201, r.content)
        e = r.json()
        self.assertEqual((e['hours'], e['taskTitle'], e['email']), (4.0, 'Build login', 'emp@co.com'))

        r = self.emp.put(f'/api/timesheets/entries/{e["id"]}', {'hours': 6.5, 'project': 'Zeus'},
                         content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['hours'], r.json()['project'], r.json()['taskTitle']), (6.5, 'Zeus', 'Build login'))
        self.assertEqual(float(TimesheetWeek.objects.get(email='emp@co.com').total_hours), 6.5)

        self.assertEqual(self.other.put(f'/api/timesheets/entries/{e["id"]}', {'hours': 1},
                                        content_type='application/json').status_code, 403)
        self.assertEqual(self.emp.delete(f'/api/timesheets/entries/{e["id"]}').status_code, 200)
        self.assertFalse(TimesheetEntry.objects.exists())
        self.assertEqual(float(TimesheetWeek.objects.get(email='emp@co.com').total_hours), 0)

    def test_hours_validation_and_day_cap(self):
        self.assertEqual(self.add(hours=0).status_code, 400)
        self.assertEqual(self.add(hours=25).status_code, 400)
        self.assertEqual(self.add(hours=1.1).status_code, 400)          # not a quarter-hour step
        self.assertEqual(self.add(project='').status_code, 400)
        self.assertEqual(self.add(hours=20).status_code, 201)
        r = self.add(hours=4.25)
        self.assertEqual((r.status_code, r.json()['code']), (400, 'DAY_OVER_24'))
        self.assertEqual(self.add(hours=4).status_code, 201)            # exactly 24
        self.assertEqual(self.add(date=TUE.isoformat(), hours=8).status_code, 201)

    def test_week_view_totals_and_attendance(self):
        EmployeeTask.objects.create(title='Open task', assignee_email='emp@co.com', stage='inprogress')
        EmployeeTask.objects.create(title='Done task', assignee_email='emp@co.com', stage='done')
        EmployeeAttendance.objects.create(email='emp@co.com', date=MON, worked_minutes=480)
        self.add(hours=3)
        self.add(hours=2.5, project='Zeus')
        self.add(date=TUE.isoformat(), hours=8)
        r = self.emp.get(f'/api/timesheets/week?week={(MON + timedelta(days=3)).isoformat()}')
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual((d['weekStart'], d['weekEnd'], d['status']), ('2026-11-02', '2026-11-08', 'Draft'))
        self.assertEqual(d['totalHours'], 13.5)
        self.assertEqual(len(d['days']), 7)
        self.assertEqual(d['days'][0], {'date': '2026-11-02', 'hours': 5.5, 'attendanceMinutes': 480})
        self.assertEqual(d['days'][1]['hours'], 8.0)
        self.assertEqual(d['approver']['email'], 'mgr@co.com')
        self.assertEqual(set(d['projects']), {'Apollo', 'Zeus'})
        self.assertEqual([t['title'] for t in d['tasks']], ['Open task'])
        self.assertEqual(len(d['entries']), 3)

    def test_viewing_someone_elses_week(self):
        self.add()
        self.assertEqual(self.other.get('/api/timesheets/week?email=emp@co.com').status_code, 403)
        self.assertEqual(self.mgr.get(f'/api/timesheets/week?email=emp@co.com&week={MON}').status_code, 200)
        r = self.mgr.get(f'/api/timesheets/entries?email=emp@co.com&week={MON}')
        self.assertEqual(len(r.json()), 1)
        self.assertEqual(self.other.get(f'/api/timesheets/entries?email=emp@co.com').status_code, 403)


class ApprovalTests(Base):
    def test_submit_requires_an_entry(self):
        r = self.submit()
        self.assertEqual((r.status_code, r.json()['code']), (400, 'EMPTY_WEEK'))

    def test_submit_locks_and_notifies_manager(self):
        e = self.add().json()
        r = self.submit()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['status'], r.json()['approverEmail'], r.json()['totalHours']),
                         ('Submitted', 'mgr@co.com', 4.0))
        n = Notification.objects.get(recipient='mgr@co.com')
        self.assertEqual(n.link, '/timesheets/approvals')
        # locked
        self.assertEqual(self.add(hours=1).json()['code'], 'WEEK_LOCKED')
        self.assertEqual(self.emp.put(f'/api/timesheets/entries/{e["id"]}', {'hours': 1},
                                      content_type='application/json').status_code, 409)
        self.assertEqual(self.emp.delete(f'/api/timesheets/entries/{e["id"]}').status_code, 409)
        self.assertEqual(self.submit().status_code, 409)
        # another week is not locked
        self.assertEqual(self.add(date=(MON + timedelta(days=7)).isoformat()).status_code, 201)

    def test_manager_approves(self):
        self.add()
        self.submit()
        r = self.mgr.get('/api/timesheets/approvals')
        self.assertEqual(r.status_code, 200)
        self.assertEqual([w['email'] for w in r.json()['weeks']], ['emp@co.com'])
        self.assertEqual(len(r.json()['weeks'][0]['entries']), 1)
        r = self.decide(self.mgr, 'approve')
        self.assertEqual((r.status_code, r.json()['status'], r.json()['decidedBy']), (200, 'Approved', 'mgr@co.com'))
        n = Notification.objects.get(recipient='emp@co.com')
        self.assertEqual((n.title, n.link), ('Timesheet approved', '/timesheets'))
        self.assertEqual(self.add(hours=1).status_code, 409)              # approved stays locked
        self.assertEqual(self.decide(self.mgr, 'reject', 'late').status_code, 409)
        h = self.mgr.get('/api/timesheets/approvals?status=Approved').json()['weeks']
        self.assertEqual(len(h), 1)

    def test_non_manager_cannot_decide_or_list(self):
        self.add()
        self.submit()
        self.assertEqual(self.decide(self.other, 'approve').status_code, 403)
        self.assertEqual(self.other.get('/api/timesheets/approvals').status_code, 403)
        self.assertEqual(self.hr.get('/api/timesheets/approvals').status_code, 403)   # audit != approve

    def test_permission_holder_and_super_admin_can_decide(self):
        self.add()
        self.submit()
        self.assertEqual(len(self.pm.get('/api/timesheets/approvals').json()['weeks']), 1)
        self.assertEqual(self.decide(self.pm, 'approve').status_code, 200)

    def test_own_week_cannot_be_decided(self):
        self.add(client=self.pm)
        self.submit(client=self.pm)
        wk = TimesheetWeek.objects.get(email='pm@co.com')
        r = self.pm.post(f'/api/timesheets/week/{wk.id}/decide', {'action': 'approve'}, content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertNotIn('pm@co.com', [w['email'] for w in self.pm.get('/api/timesheets/approvals').json()['weeks']])
        # the super admin approves it instead
        self.assertEqual(self.admin.post(f'/api/timesheets/week/{wk.id}/decide', {'action': 'approve'},
                                         content_type='application/json').status_code, 200)

    def test_reject_needs_note_then_edit_returns_to_draft(self):
        e = self.add().json()
        self.submit()
        r = self.decide(self.mgr, 'reject')
        self.assertEqual((r.status_code, r.json()['code']), (400, 'NOTE_REQUIRED'))
        r = self.decide(self.mgr, 'reject', 'Split Apollo hours by task')
        self.assertEqual((r.status_code, r.json()['status']), (200, 'Rejected'))
        n = Notification.objects.filter(recipient='emp@co.com').get()
        self.assertIn('Split Apollo hours by task', n.message)
        self.assertEqual(self.emp.get(f'/api/timesheets/week?week={MON}').json()['decisionNote'],
                         'Split Apollo hours by task')
        r = self.emp.put(f'/api/timesheets/entries/{e["id"]}', {'hours': 5}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(TimesheetWeek.objects.get(email='emp@co.com').status, 'Draft')
        self.assertEqual(self.submit().json()['status'], 'Submitted')

    def test_no_manager_notifies_permission_holders(self):
        self.add(client=self.other)
        self.submit(client=self.other)
        self.assertTrue(Notification.objects.filter(recipient='pm@co.com').exists())
        self.assertFalse(Notification.objects.filter(recipient='admin@co.com').exists())


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()):
        yield


class AttendanceAuditTests(Base):
    def make_day(self, **kw):
        base = dict(email='emp@co.com', employee_name='Emp Loyee', date=MON,
                    check_in=datetime(2026, 11, 2, 9, 0), check_out=datetime(2026, 11, 2, 17, 0),
                    worked_minutes=480)
        base.update(kw)
        return EmployeeAttendance.objects.create(**base)

    def test_manual_edit_is_logged_field_by_field(self):
        att = self.make_day()
        r = self.admin.put(f'/api/attendance/{att.id}',
                           {'check_out': '2026-11-02T18:00:00', 'note': 'Stayed for release', 'reason': 'Manager confirmed'},
                           content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        rows = {x.field: x for x in AttendanceAuditLog.objects.filter(attendance_id=att.id)}
        self.assertIn('check_out', rows)
        self.assertEqual((rows['check_out'].old_value, rows['check_out'].new_value),
                         ('2026-11-02 17:00:00', '2026-11-02 18:00:00'))
        self.assertEqual(rows['note'].new_value, 'Stayed for release')
        self.assertEqual((rows['worked_minutes'].old_value, rows['worked_minutes'].new_value), ('480', '540'))
        self.assertTrue(all(x.source == 'edit' and x.actor == 'admin@co.com' and x.reason == 'Manager confirmed'
                            for x in rows.values()))
        self.assertNotIn('status', rows)                       # unchanged fields are not logged

    def test_manual_checkout_is_not_logged(self):
        AppUser.objects.filter(email='emp@co.com').update(role='admin')
        EmployeeAttendance.objects.create(email='emp@co.com', date=MON, check_in=datetime(2026, 11, 2, 9, 0))
        with at(datetime(2026, 11, 2, 17, 0)):
            r = self.emp.post('/api/attendance/check-out', {'email': 'emp@co.com'}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(AttendanceAuditLog.objects.exists())

    def test_punch_ticket_and_correction_and_recalc_are_logged(self):
        att = self.make_day(check_out=None, worked_minutes=0)
        t = AttendanceCorrection.objects.create(email='emp@co.com', employee_name='Emp', attendance_date=MON,
                                                kind='forgot_checkout', reason='Forgot', status='Pending')
        r = self.admin.post(f'/api/attendance/punch-ticket/{t.id}/decide', {'action': 'approve'},
                            content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(AttendanceAuditLog.objects.filter(attendance_id=att.id, source='punch_ticket',
                                                          field='check_out').exists())

        corr = AttendanceCorrection.objects.create(email='emp@co.com', employee_name='Emp', attendance_date=MON,
                                                   requested_check_out=datetime(2026, 11, 2, 19, 0),
                                                   reason='Late deploy', status='Pending')
        r = self.admin.put(f'/api/attendance/corrections/{corr.id}', {'status': 'Approved'},
                           content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        row = AttendanceAuditLog.objects.get(attendance_id=att.id, source='correction', field='check_out')
        self.assertEqual((row.new_value, row.reason, row.actor), ('2026-11-02 19:00:00', 'Late deploy', 'admin@co.com'))

        att.refresh_from_db()
        attendance_recalc.apply([(att, 555, 15)], 'hr@co.com')
        row = AttendanceAuditLog.objects.get(attendance_id=att.id, source='recalc', field='worked_minutes')
        self.assertEqual((row.new_value, row.actor), ('555', 'hr@co.com'))

    def test_audit_failure_never_breaks_the_edit(self):
        att = self.make_day()
        with patch('api.timesheets.AttendanceAuditLog.objects.bulk_create', side_effect=RuntimeError('db down')):
            r = self.admin.put(f'/api/attendance/{att.id}', {'note': 'x'}, content_type='application/json')
        self.assertEqual(r.status_code, 200)

    def test_audit_visibility(self):
        att = self.make_day()
        self.admin.put(f'/api/attendance/{att.id}', {'note': 'fixed'}, content_type='application/json')
        r = self.emp.get('/api/attendance/audit')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()[0]['field'], 'note')
        self.assertEqual(set(r.json()[0]), {'id', 'attendanceId', 'email', 'at', 'date', 'source', 'field',
                                            'oldValue', 'newValue', 'actor', 'reason'})
        self.assertEqual(self.other.get('/api/attendance/audit?email=emp@co.com').status_code, 403)
        self.assertEqual(self.other.get(f'/api/attendance/audit?attendanceId={att.id}').status_code, 403)
        self.assertEqual(self.pm.get('/api/attendance/audit?email=emp@co.com').status_code, 403)
        self.assertEqual(len(self.hr.get('/api/attendance/audit?email=emp@co.com').json()), 1)
        self.assertEqual(len(self.mgr.get(f'/api/attendance/audit?attendanceId={att.id}').json()), 1)
        self.assertEqual(len(self.admin.get('/api/attendance/audit?email=emp@co.com&from=2026-11-03').json()), 0)
        self.assertEqual(Client().get('/api/attendance/audit').status_code, 401)
