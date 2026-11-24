"""Task Tracker: saved project views, project (custom) fields, the new issue
fields (start / target / effort / parent / closed_at) and removing a project
(archive, unarchive, delete with name confirmation)."""
from django.test import Client, TestCase

from api.models import (AppUser, EmployeeTask, Permission, Project, ProjectField, ProjectMilestone,
                        ProjectStatusUpdate, ProjectView, Role, RolePermission, TaskComment,
                        TaskFieldValue)


def grant(role, *codes):
    for c in codes:
        p, _ = Permission.objects.get_or_create(code=c, defaults={'name': c})
        RolePermission.objects.get_or_create(role=role, permission=p)


J = 'application/json'


class Base(TestCase):
    def setUp(self):
        admin = Role.objects.create(name='Proj Admin')
        grant(admin, 'employee.view', 'task.create', 'task.edit', 'task.delete',
              'project.view', 'project.create', 'project.edit', 'project.delete')
        dev = Role.objects.create(name='Proj Dev')
        grant(dev, 'employee.view', 'task.create', 'task.edit')
        viewer = Role.objects.create(name='Proj Viewer')
        grant(viewer, 'employee.view')
        AppUser.objects.create(email='admin@co.com', full_name='Ada Admin', role_ref=admin, status='active')
        AppUser.objects.create(email='dev@co.com', full_name='Dev One', role_ref=dev, status='active')
        AppUser.objects.create(email='view@co.com', full_name='Vic Viewer', role_ref=viewer, status='active')
        self.admin = Client(HTTP_X_USER_EMAIL='admin@co.com')
        self.dev = Client(HTTP_X_USER_EMAIL='dev@co.com')
        self.viewer = Client(HTTP_X_USER_EMAIL='view@co.com')
        self.proj = Project.objects.create(project_code='PRJ-V', name='HRMS')

    def task(self, **kw):
        body = {'title': 'Issue', 'projectId': self.proj.id}
        body.update(kw)
        r = self.admin.post('/api/tasks', body, content_type=J)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def row(self, tid):
        for t in self.admin.get('/api/tasks').json():
            if t['id'] == tid:
                return t
        return None


class ViewTests(Base):
    def setUp(self):
        super().setUp()
        self.proj.project_manager = 'dev@co.com'     # configures as the project's manager
        self.proj.save()

    def test_default_views_created_once(self):
        r = self.viewer.get('/api/projects/%d/views' % self.proj.id)
        self.assertEqual(r.status_code, 200)
        self.assertEqual([(v['name'], v['layout']) for v in r.json()],
                         [('Table', 'table'), ('Board', 'board'), ('Roadmap', 'roadmap')])
        self.viewer.get('/api/projects/%d/views' % self.proj.id)
        self.assertEqual(ProjectView.objects.filter(project=self.proj).count(), 3)

    def test_crud_and_config_validation(self):
        url = '/api/projects/%d/views' % self.proj.id
        self.viewer.get(url)     # the three default views
        cfg = {'fields': ['assignees', 'status', 'f:12', 'title', 'status'], 'widths': {'status': 5000},
               'sort': 'priority', 'dir': 'asc', 'group': 'status', 'tgroup': 'none', 'q': 'is:open',
               'state': 'open', 'zoom': 'week', 'junk': 1}
        r = self.dev.post(url, {'name': '  Sprint   board ', 'layout': 'board', 'config': cfg}, content_type=J)
        self.assertEqual(r.status_code, 201, r.content)
        v = r.json()
        self.assertEqual(v['name'], 'Sprint board')
        self.assertEqual(v['config']['fields'], ['assignees', 'status', 'f:12'])   # title implicit, dupes dropped
        self.assertEqual(v['config']['widths'], {'status': 900})
        self.assertNotIn('junk', v['config'])
        self.assertEqual(self.dev.post(url, {'layout': 'gantt'}, content_type=J).status_code, 400)
        self.assertEqual(self.dev.post(url, {'config': {'fields': ['<script>']}}, content_type=J).status_code, 400)
        self.assertEqual(self.dev.post(url, {'config': {'dir': 'up'}}, content_type=J).status_code, 400)
        d = '%s/%d' % (url, v['id'])
        r = self.dev.patch(d, {'name': 'Renamed', 'layout': 'roadmap', 'config': {'zoom': 'quarter'}}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['name'], r.json()['layout'], r.json()['config']), ('Renamed', 'roadmap', {'zoom': 'quarter'}))
        self.assertEqual(self.dev.patch(d, {'name': '  '}, content_type=J).status_code, 400)
        # shared: everyone who can see the project sees it
        self.assertIn('Renamed', [x['name'] for x in self.viewer.get(url).json()])
        self.assertEqual(self.dev.delete(d).status_code, 200)
        self.assertFalse(ProjectView.objects.filter(pk=v['id']).exists())

    def test_permissions_and_last_view(self):
        url = '/api/projects/%d/views' % self.proj.id
        views = self.viewer.get(url).json()
        self.assertEqual(self.viewer.post(url, {'name': 'x'}, content_type=J).status_code, 403)
        self.assertEqual(self.viewer.patch('%s/%d' % (url, views[0]['id']), {'name': 'x'}, content_type=J).status_code, 403)
        self.assertEqual(self.viewer.delete('%s/%d' % (url, views[0]['id'])).status_code, 403)
        # the project manager may configure even without task.edit
        self.proj.project_manager = 'view@co.com'
        self.proj.save()
        self.assertEqual(self.viewer.post(url, {'name': 'Mine'}, content_type=J).status_code, 201)
        for v in self.admin.get(url).json()[1:]:
            self.assertEqual(self.admin.delete('%s/%d' % (url, v['id'])).status_code, 200)
        last = self.admin.get(url).json()[0]
        self.assertEqual(self.admin.delete('%s/%d' % (url, last['id'])).status_code, 409)
        self.assertEqual(self.admin.get('/api/projects/999/views').status_code, 404)


class FieldTests(Base):
    def setUp(self):
        super().setUp()
        self.proj.project_manager = 'dev@co.com'     # configures as the project's manager
        self.proj.save()

    def mkfield(self, client=None, **kw):
        return (client or self.dev).post('/api/projects/%d/fields' % self.proj.id, kw, content_type=J)

    def test_create_each_type_and_validation(self):
        self.assertEqual(self.mkfield(name='Notes', type='text').status_code, 201)
        self.assertEqual(self.mkfield(name='Points', type='number').status_code, 201)
        self.assertEqual(self.mkfield(name='Ship', type='date').status_code, 201)
        r = self.mkfield(name='Size', type='single_select',
                         options={'choices': [{'name': 'S', 'color': 'green'}, {'name': 'L', 'color': 'red'}]})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual([c['name'] for c in r.json()['options']['choices']], ['S', 'L'])
        self.assertTrue(all(c['id'] for c in r.json()['options']['choices']))
        r = self.mkfield(name='Sprint', type='iteration', options={'weeks': 2, 'start': '2026-11-02', 'count': 3})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual([i['id'] for i in r.json()['iterations']], ['2026-11-02', '2026-11-16', '2026-11-30'])
        self.assertEqual(r.json()['iterations'][0]['end'], '2026-11-15')
        # validation
        self.assertEqual(self.mkfield(name='size', type='text').status_code, 400)           # duplicate name
        self.assertEqual(self.mkfield(name='Priority', type='text').status_code, 400)       # built-in name
        self.assertEqual(self.mkfield(name='', type='text').status_code, 400)
        self.assertEqual(self.mkfield(name='X', type='formula').status_code, 400)
        self.assertEqual(self.mkfield(name='Y', type='single_select', options={'choices': []}).status_code, 400)
        self.assertEqual(self.mkfield(name='Y', type='single_select',
                                      options={'choices': [{'name': 'a'}, {'name': 'A'}]}).status_code, 400)
        self.assertEqual(self.mkfield(name='Y', type='single_select',
                                      options={'choices': [{'name': 'a', 'color': 'neon'}]}).status_code, 400)
        self.assertEqual(self.mkfield(name='Z', type='iteration', options={'weeks': 9}).status_code, 400)
        self.assertEqual(self.mkfield(self.viewer, name='Nope', type='text').status_code, 403)
        names = [f['name'] for f in self.viewer.get('/api/projects/%d/fields' % self.proj.id).json()]
        self.assertEqual(names, ['Notes', 'Points', 'Ship', 'Size', 'Sprint'])

    def test_values_per_type(self):
        t = self.task()
        text = self.mkfield(name='Notes', type='text').json()
        num = self.mkfield(name='Points', type='number').json()
        date = self.mkfield(name='Ship', type='date').json()
        sel = self.mkfield(name='Size', type='single_select', options={'choices': [{'name': 'S'}, {'name': 'L'}]}).json()
        it = self.mkfield(name='Sprint', type='iteration', options={'weeks': 1, 'start': '2026-11-02', 'count': 4}).json()

        def put(f, value, client=None):
            return (client or self.dev).put('/api/tasks/%d/fields/%d' % (t['id'], f['id']), {'value': value}, content_type=J)

        self.assertEqual(put(text, '  hello ').json()['value'], 'hello')
        self.assertEqual(put(text, 'x' * 1025).status_code, 400)
        self.assertEqual(put(num, '3.5').json()['value'], 3.5)
        self.assertEqual(put(num, 8).json()['value'], 8)
        self.assertEqual(put(num, 'abc').status_code, 400)
        self.assertEqual(put(num, True).status_code, 400)
        self.assertEqual(put(date, '2026-12-01').json()['value'], '2026-12-01')
        self.assertEqual(put(date, '12/01/2026').status_code, 400)
        large = sel['options']['choices'][1]['id']
        self.assertEqual(put(sel, large).json()['value'], large)
        self.assertEqual(put(sel, 's').json()['value'], sel['options']['choices'][0]['id'])   # by name
        self.assertEqual(put(sel, 'XL').status_code, 400)
        self.assertEqual(put(it, '2026-11-09').json()['value'], '2026-11-09')
        self.assertEqual(put(it, '2026-11-10').status_code, 400)
        self.assertEqual(put(text, 'nope', self.viewer).status_code, 403)
        # list returns every value, bulk-loaded
        row = self.row(t['id'])
        self.assertEqual(row['fields'], {str(text['id']): 'hello', str(num['id']): 8, str(date['id']): '2026-12-01',
                                         str(sel['id']): sel['options']['choices'][0]['id'], str(it['id']): '2026-11-09'})
        # clearing
        self.assertIsNone(put(text, '').json()['value'])
        self.assertNotIn(str(text['id']), self.row(t['id'])['fields'])
        # field of another project
        other = Project.objects.create(project_code='PRJ-O', name='Other')
        of = ProjectField.objects.create(project=other, name='Other field', field_type='text')
        r = self.dev.put('/api/tasks/%d/fields/%d' % (t['id'], of.id), {'value': 'x'}, content_type=J)
        self.assertEqual(r.status_code, 400)
        # moving the issue to another project drops the old project's values
        self.assertEqual(self.admin.put('/api/tasks/%d' % t['id'], {'projectId': other.id}, content_type=J).status_code, 200)
        self.assertEqual(TaskFieldValue.objects.filter(task_id=t['id']).count(), 0)

    def test_list_is_bulk_loaded(self):
        f = self.mkfield(name='Notes', type='text').json()
        for i in range(6):
            t = self.task(title='T%d' % i)
            self.dev.put('/api/tasks/%d/fields/%d' % (t['id'], f['id']), {'value': 'v%d' % i}, content_type=J)
            self.task(title='child %d' % i, parentId=t['id'])
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        with CaptureQueriesContext(connection) as small:
            self.admin.get('/api/tasks?projectId=%d' % self.proj.id)
        for i in range(6):
            self.task(title='more %d' % i)
        with CaptureQueriesContext(connection) as big:
            self.admin.get('/api/tasks?projectId=%d' % self.proj.id)
        self.assertEqual(len(small), len(big))   # no per-row queries

    def test_edit_and_delete_field(self):
        t = self.task()
        sel = self.mkfield(name='Size', type='single_select',
                           options={'choices': [{'name': 'S'}, {'name': 'M'}, {'name': 'L'}]}).json()
        s_id, m_id, l_id = [c['id'] for c in sel['options']['choices']]
        self.dev.put('/api/tasks/%d/fields/%d' % (t['id'], sel['id']), {'value': l_id}, content_type=J)
        url = '/api/projects/%d/fields/%d' % (self.proj.id, sel['id'])
        r = self.dev.patch(url, {'name': 'T-shirt', 'options': {'choices': [
            {'id': s_id, 'name': 'Small', 'color': 'blue'}, {'id': m_id, 'name': 'M'}]}}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['name'], 'T-shirt')
        self.assertEqual([c['id'] for c in r.json()['options']['choices']], [s_id, m_id])   # ids kept
        self.assertEqual(r.json()['valuesRemoved'], 1)                                       # L was removed
        self.assertFalse(TaskFieldValue.objects.filter(field_id=sel['id']).exists())
        self.assertEqual(self.dev.patch(url, {'type': 'text'}, content_type=J).status_code, 400)
        self.assertEqual(self.viewer.delete(url).status_code, 403)
        self.dev.put('/api/tasks/%d/fields/%d' % (t['id'], sel['id']), {'value': s_id}, content_type=J)
        r = self.dev.delete(url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['valuesRemoved'], 1)
        self.assertFalse(ProjectField.objects.filter(pk=sel['id']).exists())
        self.assertEqual(self.row(t['id'])['fields'], {})


class IssueFieldTests(Base):
    def test_new_fields_round_trip(self):
        t = self.task(startDate='2026-11-02', targetDate='2026-11-20', effort=3.5)
        self.assertEqual((t['startDate'], t['targetDate'], t['effort']), ('2026-11-02', '2026-11-20', 3.5))
        r = self.admin.put('/api/tasks/%d' % t['id'], {'targetDate': '2026-12-01', 'effort': None}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        row = self.row(t['id'])
        self.assertEqual((row['startDate'], row['targetDate'], row['effort']), ('2026-11-02', '2026-12-01', None))
        bad = self.admin.put('/api/tasks/%d' % t['id'], {'startDate': '2026-12-05'}, content_type=J)
        self.assertEqual(bad.status_code, 400)   # target before start
        self.assertEqual(self.admin.put('/api/tasks/%d' % t['id'], {'effort': -1}, content_type=J).status_code, 400)

    def test_parent_and_sub_issue_progress(self):
        parent = self.task(title='Epic')
        a = self.task(title='A', parentId=parent['id'])
        b = self.task(title='B', parentId=parent['id'])
        self.task(title='C', parentId=parent['id'], stage='done')
        row = self.row(parent['id'])
        self.assertEqual(row['subIssues'], {'done': 1, 'total': 3})
        self.assertEqual(self.row(a['id'])['parentTitle'], 'Epic')
        self.admin.put('/api/tasks/%d' % b['id'], {'stage': 'done'}, content_type=J)
        self.assertEqual(self.row(parent['id'])['subIssues'], {'done': 2, 'total': 3})
        # cycles and self-parenting are refused
        self.assertEqual(self.admin.put('/api/tasks/%d' % parent['id'], {'parentId': a['id']}, content_type=J).status_code, 400)
        self.assertEqual(self.admin.put('/api/tasks/%d' % a['id'], {'parentId': a['id']}, content_type=J).status_code, 400)
        self.assertEqual(self.admin.put('/api/tasks/%d' % a['id'], {'parentId': 99999}, content_type=J).status_code, 400)
        r = self.admin.put('/api/tasks/%d' % a['id'], {'parentId': None}, content_type=J)
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(self.row(a['id'])['parentId'])

    def test_closed_at(self):
        t = self.task()
        self.assertIsNone(t['closedAt'])
        r = self.admin.put('/api/tasks/%d' % t['id'], {'stage': 'done'}, content_type=J)
        self.assertTrue(r.json()['closedAt'])
        first = r.json()['closedAt']
        self.admin.put('/api/tasks/%d' % t['id'], {'title': 'Still closed'}, content_type=J)
        self.assertEqual(self.row(t['id'])['closedAt'], first)
        self.admin.put('/api/tasks/%d' % t['id'], {'stage': 'review'}, content_type=J)
        self.assertIsNone(self.row(t['id'])['closedAt'])
        self.assertTrue(self.task(stage='done')['closedAt'])


class RemoveProjectTests(Base):
    def setUp(self):
        super().setUp()
        self.ms = ProjectMilestone.objects.create(project=self.proj, title='M1')
        self.todo = self.task(title='todo one', milestoneId=self.ms.id)
        self.doing = self.task(title='doing one', stage='inprogress')
        self.done = self.task(title='done one', stage='done')
        TaskComment.objects.create(task_id=self.todo['id'], author_email='admin@co.com', body='hi')
        ProjectStatusUpdate.objects.create(project=self.proj, status='on_track', body='ok')
        self.field = ProjectField.objects.create(project=self.proj, name='Notes', field_type='text')
        TaskFieldValue.objects.create(task_id=self.doing['id'], field=self.field, value='x')
        self.admin.get('/api/projects/%d/views' % self.proj.id)   # creates the default views

    def test_archive_and_unarchive(self):
        url = '/api/projects/%d' % self.proj.id
        self.assertEqual(self.dev.post(url + '/archive').status_code, 403)
        r = self.admin.post(url + '/archive')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['archivedAt'])
        self.assertNotIn(self.proj.id, [p['id'] for p in self.viewer.get('/api/projects').json()])
        self.assertIn(self.proj.id, [p['id'] for p in self.viewer.get('/api/projects?archived=all').json()])
        self.assertEqual([p['id'] for p in self.viewer.get('/api/projects?archived=only').json()], [self.proj.id])
        self.assertEqual(self.row(self.todo['id'])['projectId'], self.proj.id)     # nothing unlinked
        r = self.admin.post(url + '/unarchive')
        self.assertIsNone(r.json()['archivedAt'])
        self.assertIn(self.proj.id, [p['id'] for p in self.viewer.get('/api/projects').json()])

    def test_delete_requires_permission_and_name(self):
        url = '/api/projects/%d' % self.proj.id
        self.assertEqual(self.dev.delete(url, {'confirmName': 'HRMS'}, content_type=J).status_code, 403)
        self.assertEqual(self.admin.delete(url, {'confirmName': 'hrms'}, content_type=J).status_code, 400)
        self.assertEqual(self.admin.delete(url).status_code, 400)
        self.assertTrue(Project.objects.filter(pk=self.proj.id).exists())

    def test_delete_keeps_and_unlinks_issues(self):
        with self.assertLogs('api.project_views', level='WARNING') as logs:
            r = self.admin.delete('/api/projects/%d' % self.proj.id, {'confirmName': 'HRMS'}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['unlinked'], r.json()['deleted']), (3, 0))
        self.assertTrue(any('admin@co.com' in m and 'PRJ-V' in m for m in logs.output))
        for t in (self.todo, self.doing, self.done):
            row = self.row(t['id'])
            self.assertIsNotNone(row)
            self.assertIsNone(row['projectId'])
            self.assertIsNone(row['milestoneId'])
            self.assertEqual(row['fields'], {})
        self.assertFalse(ProjectView.objects.exists())
        self.assertFalse(ProjectField.objects.exists())
        self.assertFalse(TaskFieldValue.objects.exists())
        self.assertFalse(ProjectStatusUpdate.objects.exists())
        self.assertFalse(ProjectMilestone.objects.exists())

    def test_delete_with_todo_issues(self):
        # deleting To Do issues needs task.delete as well
        Role.objects.get(name='Proj Dev')
        editor = Role.objects.create(name='Proj Editor')
        grant(editor, 'employee.view', 'project.edit', 'project.delete')
        AppUser.objects.create(email='ed@co.com', full_name='Ed', role_ref=editor, status='active')
        ed = Client(HTTP_X_USER_EMAIL='ed@co.com')
        url = '/api/projects/%d' % self.proj.id
        r = ed.delete(url, {'confirmName': 'HRMS', 'deleteTodoIssues': True}, content_type=J)
        self.assertEqual(r.status_code, 403)
        r = self.admin.delete(url, {'confirmName': 'HRMS', 'deleteTodoIssues': True}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['unlinked'], r.json()['deleted']), (2, 1))
        self.assertIsNone(self.row(self.todo['id']))
        self.assertFalse(TaskComment.objects.filter(task_id=self.todo['id']).exists())
        self.assertIsNone(self.row(self.doing['id'])['projectId'])
        self.assertIsNotNone(self.row(self.done['id']))
