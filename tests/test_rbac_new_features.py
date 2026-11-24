"""Role-based access for the newer features (migration 0106).

Each feature has its own permission code, so an admin can grant it per role in
Access Control, and the broad codes every role holds (settings.view,
attendance.view, employee.view) no longer unlock admin screens or other
people's pay-impacting data."""
import importlib

from django.apps import apps as django_apps
from django.test import Client, TestCase

from api.models import AppUser, AttendancePenalty, OvertimeRecord, Permission, Project, Role, RolePermission

J = 'application/json'


def grant(role, *codes):
    for c in codes:
        p, _ = Permission.objects.get_or_create(code=c, defaults={'name': c})
        RolePermission.objects.get_or_create(role=role, permission=p)


def user(email, *codes, role_name=None):
    role = Role.objects.create(name=role_name or ('Role ' + email))
    grant(role, *codes)
    AppUser.objects.create(email=email, full_name=email.split('@')[0].title(), password='x', role='employee',
                           role_ref=role, status='active')
    return Client(HTTP_X_USER_EMAIL=email)


# What the plain Employee role holds on a typical install.
EMPLOYEE = ('employee.view', 'task.edit', 'attendance.view', 'attendance.create', 'leave.view', 'leave.create',
            'settings.view')


class AttendanceAdminTests(TestCase):
    def setUp(self):
        self.emp = user('emp@x.com', *EMPLOYEE)
        self.peer = user('peer@x.com', *EMPLOYEE)

    def test_broad_codes_no_longer_open_admin_screens(self):
        self.assertEqual(self.emp.get('/api/attendance/policies').status_code, 403)
        self.assertEqual(self.emp.get('/api/attendance/networks').status_code, 403)
        self.assertEqual(self.emp.post('/api/holiday-calendars', {'name': 'X'}, content_type=J).status_code, 403)
        self.assertEqual(self.emp.post('/api/attendance/penalties/evaluate', {}, content_type=J).status_code, 403)
        self.assertEqual(self.emp.post('/api/attendance/overtime-evaluate', {}, content_type=J).status_code, 403)
        # reading holidays stays open to everyone
        self.assertEqual(self.emp.get('/api/holiday-calendars').status_code, 200)

    def test_policy_view_and_manage_are_separate(self):
        viewer = user('pv@x.com', 'attendance.policy.view')
        self.assertEqual(viewer.get('/api/attendance/policies').status_code, 200)
        self.assertFalse(viewer.get('/api/attendance/policies').json()['canManage'])
        self.assertEqual(viewer.post('/api/attendance/policies', {'name': 'P'}, content_type=J).status_code, 403)
        manager = user('pm@x.com', 'attendance.policy.manage')
        r = manager.get('/api/attendance/policies')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['canManage'])
        self.assertNotEqual(manager.post('/api/attendance/policies', {'name': 'P'}, content_type=J).status_code, 403)

    def test_network_whitelist_needs_its_own_code(self):
        it = user('it@x.com', 'attendance.network.manage')
        r = it.get('/api/attendance/networks')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['canManage'])
        old_hr = user('hr@x.com', 'attendance.edit', 'settings.manage')
        self.assertEqual(old_hr.get('/api/attendance/networks').status_code, 403)

    def test_holiday_calendars_need_holiday_manage(self):
        self.assertEqual(user('s@x.com', 'settings.manage').post(
            '/api/holiday-calendars', {'name': 'Hyd'}, content_type=J).status_code, 403)
        self.assertNotEqual(user('h@x.com', 'holiday.manage').post(
            '/api/holiday-calendars', {'name': 'Hyd'}, content_type=J).status_code, 403)

    def test_everyones_penalties_need_more_than_attendance_view(self):
        AttendancePenalty.objects.create(email='peer@x.com', date='2026-11-02', period='2026-11', kind='late', action='warning')
        AttendancePenalty.objects.create(email='emp@x.com', date='2026-11-03', period='2026-11', kind='late', action='warning')
        rows = self.emp.get('/api/attendance/penalties').json()
        rows = rows['results']
        self.assertEqual({r['email'] for r in rows}, {'emp@x.com'})
        hr = user('hr@x.com', 'attendance.policy.view')
        rows = hr.get('/api/attendance/penalties').json()
        rows = rows['results']
        self.assertEqual({r['email'] for r in rows}, {'emp@x.com', 'peer@x.com'})

    def test_everyones_overtime_needs_overtime_approve(self):
        OvertimeRecord.objects.create(email='peer@x.com', date='2026-11-02', overtime_minutes=60, status='Pending')
        self.assertEqual(self.emp.get('/api/attendance/overtime-records?scope=all').status_code, 403)
        self.assertEqual(self.emp.get('/api/attendance/overtime-records?email=peer@x.com').status_code, 403)
        self.assertEqual(self.emp.get('/api/attendance/overtime-summary?email=peer@x.com').status_code, 403)
        self.assertEqual(self.emp.get('/api/attendance/overtime-records').status_code, 200)       # own
        approver = user('ot@x.com', 'overtime.approve')
        self.assertEqual(approver.get('/api/attendance/overtime-records?scope=all').status_code, 200)
        rec = OvertimeRecord.objects.get(email='peer@x.com')
        self.assertEqual(self.emp.post('/api/attendance/overtime-records/%d/decide' % rec.id,
                                       {'action': 'approve'}, content_type=J).status_code, 403)
        self.assertNotEqual(approver.post('/api/attendance/overtime-records/%d/decide' % rec.id,
                                          {'action': 'reject'}, content_type=J).status_code, 403)


class ProjectAccessTests(TestCase):
    def setUp(self):
        self.emp = user('emp@x.com', *EMPLOYEE)
        self.pm_user = user('pm@x.com', *EMPLOYEE)
        self.creator = user('lead@x.com', 'employee.view', 'project.view', 'project.create')
        self.editor = user('ed@x.com', 'employee.view', 'project.edit')
        self.deleter = user('del@x.com', 'employee.view', 'project.delete')
        self.proj = Project.objects.create(project_code='PRJ-R', name='Rbac', project_manager='pm@x.com')

    def test_everyone_on_tasks_can_see_projects(self):
        self.assertEqual(self.emp.get('/api/projects').status_code, 200)
        self.assertEqual(self.emp.get('/api/projects/%d' % self.proj.id).status_code, 200)
        self.assertEqual(user('pv@x.com', 'project.view').get('/api/projects').status_code, 200)

    def test_create_needs_project_create(self):
        self.assertEqual(self.emp.post('/api/projects', {'name': 'No'}, content_type=J).status_code, 403)
        self.assertEqual(self.creator.post('/api/projects', {'name': 'Yes'}, content_type=J).status_code, 201)

    def test_edit_archive_and_configure_need_project_edit_or_being_its_manager(self):
        url = '/api/projects/%d' % self.proj.id
        self.assertEqual(self.emp.put(url, {'readme': 'x'}, content_type=J).status_code, 403)
        self.assertEqual(self.emp.post(url + '/archive').status_code, 403)
        self.assertEqual(self.emp.post(url + '/fields', {'name': 'N', 'type': 'text'}, content_type=J).status_code, 403)
        self.assertEqual(self.editor.put(url, {'readme': 'by editor'}, content_type=J).status_code, 200)
        self.assertEqual(self.pm_user.put(url, {'readme': 'by manager'}, content_type=J).status_code, 200)
        self.assertEqual(self.pm_user.post(url + '/archive').status_code, 200)
        self.assertEqual(self.editor.post(url + '/unarchive').status_code, 200)
        self.assertEqual(self.pm_user.post(url + '/fields', {'name': 'N', 'type': 'text'}, content_type=J).status_code, 201)

    def test_delete_needs_project_delete(self):
        url = '/api/projects/%d' % self.proj.id
        for c in (self.emp, self.pm_user, self.editor):
            self.assertEqual(c.delete(url, {'confirmName': 'Rbac'}, content_type=J).status_code, 403)
        self.assertEqual(self.deleter.delete(url, {'confirmName': 'Rbac'}, content_type=J).status_code, 200)

    def test_new_issue_needs_task_create(self):
        no = user('no@x.com', 'employee.view', 'employee.create')          # the old gate is not enough
        self.assertEqual(no.post('/api/tasks', {'title': 'T'}, content_type=J).status_code, 403)
        yes = user('yes@x.com', 'employee.view', 'task.create')
        self.assertEqual(yes.post('/api/tasks', {'title': 'T'}, content_type=J).status_code, 201)


class MigrationTests(TestCase):
    def test_grants_named_roles_and_is_idempotent(self):
        for name in ('Super Admin', 'HR Manager', 'HR Executive', 'Manager', 'Team Lead', 'Employee', 'IT Admin',
                     'Payroll Admin'):
            Role.objects.create(name=name)
        for c in ('project.view', 'project.create', 'project.edit', 'project.delete', 'project.manage'):
            Permission.objects.create(code=c, name=c)
        mig = importlib.import_module('api.migrations.0106_rbac_new_features')
        mig.forwards(django_apps, None)
        mig.forwards(django_apps, None)

        def codes(role):
            return set(RolePermission.objects.filter(role__name=role).values_list('permission__code', flat=True))
        self.assertEqual(codes('HR Manager'), {p[0] for p in mig.PERMS})
        self.assertEqual(codes('Employee'), {'task.create'})
        self.assertEqual(codes('Manager'), {'task.create', 'attendance.policy.view'})
        self.assertEqual(codes('Team Lead'), {'task.create', 'project.view', 'project.edit'})
        self.assertEqual(codes('IT Admin'), {'attendance.network.manage'})
        self.assertEqual(codes('Payroll Admin'), set())
        self.assertTrue({p[0] for p in mig.PERMS} <= codes('Super Admin'))
        grp = Permission.objects.get(code='overtime.approve').group
        self.assertEqual((grp.name, grp.module.name), ('Attendance Policy Group', 'Attendance'))
        self.assertEqual(RolePermission.objects.filter(role__name='HR Manager').count(), len(mig.PERMS))

    def test_0107_creates_project_codes_when_missing_and_grants_them(self):
        # Production never had project.* rows: 0106 could not grant them.
        for name in ('Super Admin', 'HR Manager', 'HR Executive', 'Manager', 'Team Lead', 'Employee', 'IT Admin'):
            Role.objects.create(name=name)
        Permission.objects.filter(code__startswith='project.').delete()
        mig = importlib.import_module('api.migrations.0107_project_permissions')
        mig.forwards(django_apps, None)
        mig.forwards(django_apps, None)

        def codes(role):
            return set(RolePermission.objects.filter(role__name=role, permission__code__startswith='project.')
                       .values_list('permission__code', flat=True))
        allp = {'project.view', 'project.create', 'project.edit', 'project.delete', 'project.manage'}
        self.assertEqual(codes('Super Admin'), allp)
        self.assertEqual(codes('HR Manager'), allp)
        self.assertEqual(codes('Manager'), {'project.view', 'project.create', 'project.edit'})
        self.assertEqual(codes('Team Lead'), {'project.view', 'project.create', 'project.edit'})
        self.assertEqual(codes('Employee'), {'project.view'})
        self.assertEqual(codes('IT Admin'), set())
        grp = Permission.objects.get(code='project.create').group
        self.assertEqual((grp.name, grp.module.name), ('Project Group', 'Employees'))
        self.assertEqual(Permission.objects.filter(code__startswith='project.').count(), 5)

    def test_manager_can_create_a_project_after_0107(self):
        Permission.objects.filter(code__startswith='project.').delete()
        mgr_role = Role.objects.create(name='Manager')
        emp_role = Role.objects.create(name='Employee')
        importlib.import_module('api.migrations.0107_project_permissions').forwards(django_apps, None)
        AppUser.objects.create(email='mgr@x.com', full_name='Mgr', password='x', role='employee', role_ref=mgr_role,
                               status='active')
        AppUser.objects.create(email='e@x.com', full_name='E', password='x', role='employee', role_ref=emp_role,
                               status='active')
        mgr, emp = Client(HTTP_X_USER_EMAIL='mgr@x.com'), Client(HTTP_X_USER_EMAIL='e@x.com')
        r = mgr.post('/api/projects', {'name': 'From a manager'}, content_type=J)
        self.assertIn(r.status_code, (200, 201), r.content)
        self.assertEqual(emp.post('/api/projects', {'name': 'Nope'}, content_type=J).status_code, 403)
        listed = emp.get('/api/projects?archived=all')
        self.assertEqual(listed.status_code, 200, listed.content)
        self.assertEqual([p['name'] for p in listed.json()], ['From a manager'])


class ProjectEditTests(TestCase):
    def setUp(self):
        self.pm = user('pm@x.com', *EMPLOYEE)
        self.editor = user('ed@x.com', 'employee.view', 'project.edit')
        self.proj = Project.objects.create(project_code='PRJ-E', name='Old', project_manager='pm@x.com')
        self.url = '/api/projects/%d' % self.proj.id

    def test_manager_edits_details_but_cannot_hand_over(self):
        r = self.pm.put(self.url, {'name': 'New name', 'description': 'Short', 'status': 'on_hold',
                                   'startDate': '2026-11-01', 'targetEndDate': '2026-12-31', 'allocatedHours': 120},
                        content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d['name'], d['description'], d['status'], d['startDate'], d['targetEndDate']),
                         ('New name', 'Short', 'on_hold', '2026-11-01', '2026-12-31'))
        self.assertEqual(float(d['allocatedHours']), 120.0)
        self.assertEqual(d['projectCode'], 'PRJ-E')
        self.assertEqual(self.pm.put(self.url, {'projectManager': 'other@x.com'}, content_type=J).status_code, 403)
        self.assertEqual(self.pm.put(self.url, {'projectManager': 'pm@x.com', 'name': 'Same mgr'},
                                     content_type=J).status_code, 200)

    def test_editor_changes_manager_code_is_fixed(self):
        self.assertEqual(self.editor.put(self.url, {'projectManager': 'ed@x.com'}, content_type=J).status_code, 200)
        self.assertEqual(Project.objects.get(pk=self.proj.id).project_manager, 'ed@x.com')
        self.assertEqual(self.editor.put(self.url, {'projectCode': 'HACK'}, content_type=J).status_code, 400)
