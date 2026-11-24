"""GitHub-style projects (short description, README, status updates) and
issue types on the Task Tracker."""
from django.test import Client, TestCase

from api.models import (AppUser, EmployeeTask, Permission, Project, ProjectStatusUpdate,
                        Role, RolePermission)


def grant(role, *codes):
    for c in codes:
        p, _ = Permission.objects.get_or_create(code=c, defaults={'name': c})
        RolePermission.objects.get_or_create(role=role, permission=p)


class GithubProjectTests(TestCase):
    def setUp(self):
        mgr = Role.objects.create(name='Project Admin')
        grant(mgr, 'employee.view', 'task.create', 'task.edit', 'project.create', 'project.edit')
        dev = Role.objects.create(name='Dev')
        grant(dev, 'employee.view', 'task.edit')
        AppUser.objects.create(email='boss@co.com', full_name='Boss Lady', role='employee', role_ref=mgr, status='active')
        AppUser.objects.create(email='dev@co.com', full_name='Dev Guy', role='employee', role_ref=dev, status='active')
        AppUser.objects.create(email='pm@co.com', full_name='Pat PM', role='employee', role_ref=dev, status='active')
        self.boss = Client(HTTP_X_USER_EMAIL='boss@co.com')
        self.dev = Client(HTTP_X_USER_EMAIL='dev@co.com')
        self.pm = Client(HTTP_X_USER_EMAIL='pm@co.com')

    def mk(self, client=None, **kw):
        body = {'name': 'HRMS', 'description': 'People platform'}
        body.update(kw)
        r = (client or self.boss).post('/api/projects', body, content_type='application/json')
        return r

    def put(self, client, pid, body):
        return client.put('/api/projects/%d' % pid, body, content_type='application/json')

    # -- projects -------------------------------------------------------------
    def test_create_project_autocode_owner_and_readme(self):
        r = self.mk(readme='# Hello\n\n- [ ] first')
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertTrue(d['projectCode'].startswith('PRJ-'))
        self.assertEqual(d['readme'], '# Hello\n\n- [ ] first')
        self.assertEqual(d['projectManager'], 'boss@co.com')
        self.assertEqual(d['createdBy'], 'boss@co.com')
        self.assertIsNone(d['latestStatus'])

    def test_create_requires_permission_and_name(self):
        self.assertEqual(self.mk(self.dev).status_code, 403)
        self.assertEqual(self.mk(name='  ').status_code, 400)

    def test_short_description_limit(self):
        self.assertEqual(self.mk(description='x' * 256).status_code, 400)
        pid = self.mk().json()['id']
        self.assertEqual(self.put(self.boss, pid, {'description': 'y' * 256}).status_code, 400)
        r = self.put(self.boss, pid, {'description': 'Short and sweet'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['description'], 'Short and sweet')
        # a legacy long description can still be saved unchanged with other edits
        Project.objects.filter(pk=pid).update(description='z' * 400)
        self.assertEqual(self.put(self.boss, pid, {'description': 'z' * 400, 'readme': 'ok'}).status_code, 200)

    def test_readme_edit_permissions(self):
        pid = self.mk().json()['id']
        self.assertEqual(self.put(self.dev, pid, {'readme': 'hacked'}).status_code, 403)
        r = self.put(self.boss, pid, {'readme': '## Usage\nSee **docs**'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.boss.get('/api/projects/%d' % pid).json()['readme'], '## Usage\nSee **docs**')

    def test_markdown_stored_raw_no_html_rendering(self):
        evil = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))'
        pid = self.mk(readme=evil).json()['id']
        r = self.boss.get('/api/projects/%d' % pid)
        self.assertEqual(r['Content-Type'].split(';')[0], 'application/json')
        self.assertEqual(r.json()['readme'], evil)          # raw, not rendered or "cleaned"
        up = self.boss.post('/api/projects/%d/status-updates' % pid, {'status': 'at_risk', 'body': evil},
                            content_type='application/json')
        self.assertEqual(up.status_code, 201)
        self.assertEqual(up['Content-Type'].split(';')[0], 'application/json')
        self.assertEqual(up.json()['body'], evil)
        self.assertNotIn('bodyHtml', up.json())

    # -- status updates ---------------------------------------------------------
    def test_status_updates_crud_and_latest(self):
        pid = self.mk().json()['id']
        url = '/api/projects/%d/status-updates' % pid
        r1 = self.boss.post(url, {'status': 'on_track', 'startDate': '2026-11-01', 'targetDate': '2026-12-31',
                                  'body': 'Kick-off done'}, content_type='application/json')
        self.assertEqual(r1.status_code, 201, r1.content)
        self.assertEqual(r1.json()['authorName'], 'Boss Lady')
        r2 = self.boss.post(url, {'status': 'at_risk', 'body': 'Blocked on API'}, content_type='application/json')
        self.assertEqual(r2.status_code, 201)
        lst = self.dev.get(url).json()
        self.assertEqual([u['status'] for u in lst], ['at_risk', 'on_track'])   # newest first
        proj = self.dev.get('/api/projects/%d' % pid).json()
        self.assertEqual(proj['latestStatus']['status'], 'at_risk')
        listed = [p for p in self.dev.get('/api/projects').json() if p['id'] == pid][0]
        self.assertEqual(listed['latestStatus']['id'], r2.json()['id'])
        uid = r2.json()['id']
        r = self.boss.patch('%s/%d' % (url, uid), {'status': 'off_track'}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['status'], 'off_track')
        self.assertEqual(r.json()['body'], 'Blocked on API')
        self.assertEqual(self.boss.delete('%s/%d' % (url, uid)).status_code, 200)
        self.assertEqual(self.dev.get('/api/projects/%d' % pid).json()['latestStatus']['status'], 'on_track')

    def test_status_update_validation(self):
        pid = self.mk().json()['id']
        url = '/api/projects/%d/status-updates' % pid
        self.assertEqual(self.boss.post(url, {'status': 'great'}, content_type='application/json').status_code, 400)
        self.assertEqual(self.boss.post(url, {'status': 'on_track', 'startDate': '2026-12-01',
                                              'targetDate': '2026-11-01'}, content_type='application/json').status_code, 400)
        self.assertEqual(self.boss.post('/api/projects/9999/status-updates', {}, content_type='application/json').status_code, 404)

    def test_status_update_permissions(self):
        pid = self.mk(projectManager='pm@co.com').json()['id']
        url = '/api/projects/%d/status-updates' % pid
        # plain developer: may read, may not post
        self.assertEqual(self.dev.get(url).status_code, 200)
        self.assertEqual(self.dev.post(url, {'status': 'on_track'}, content_type='application/json').status_code, 403)
        # the project manager may post without employee.edit
        r = self.pm.post(url, {'status': 'complete', 'body': 'Shipped'}, content_type='application/json')
        self.assertEqual(r.status_code, 201)
        uid = r.json()['id']
        # other people cannot edit / delete it; author and employee.edit holders can
        self.assertEqual(self.dev.patch('%s/%d' % (url, uid), {'body': 'x'}, content_type='application/json').status_code, 403)
        self.assertEqual(self.dev.delete('%s/%d' % (url, uid)).status_code, 403)
        self.assertEqual(self.pm.patch('%s/%d' % (url, uid), {'body': 'Shipped v2'}, content_type='application/json').status_code, 200)
        self.assertEqual(self.boss.delete('%s/%d' % (url, uid)).status_code, 200)
        self.assertFalse(ProjectStatusUpdate.objects.filter(pk=uid).exists())
        # anonymous
        self.assertEqual(Client().get(url).status_code, 401)

    def test_status_update_wrong_project_404(self):
        a = self.mk().json()['id']
        b = self.mk(name='Other').json()['id']
        uid = self.boss.post('/api/projects/%d/status-updates' % a, {'status': 'on_track'},
                             content_type='application/json').json()['id']
        self.assertEqual(self.boss.delete('/api/projects/%d/status-updates/%d' % (b, uid)).status_code, 404)

    # -- issue types ------------------------------------------------------------
    def test_issue_type_create_filter_and_validation(self):
        r = self.boss.post('/api/tasks', {'title': 'Crash on login', 'issueType': 'bug',
                                          'description': '- [ ] repro\n<b>raw</b>'}, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['issueType'], 'bug')
        r2 = self.boss.post('/api/tasks', {'title': 'Plain'}, content_type='application/json')
        self.assertEqual(r2.json()['issueType'], 'task')
        bad = self.boss.post('/api/tasks', {'title': 'Bad', 'issueType': 'epic'}, content_type='application/json')
        self.assertEqual(bad.status_code, 400)
        rows = self.boss.get('/api/tasks?issueType=bug').json()
        self.assertEqual([t['title'] for t in rows], ['Crash on login'])
        self.assertEqual(rows[0]['description'], '- [ ] repro\n<b>raw</b>')
        tid = r2.json()['id']
        u = self.dev.put('/api/tasks/%d' % tid, {'issueType': 'feature'}, content_type='application/json')
        self.assertEqual(u.status_code, 200, u.content)
        self.assertEqual(EmployeeTask.objects.get(pk=tid).issue_type, 'feature')
        self.assertTrue(all('issueType' in t for t in self.boss.get('/api/tasks').json()))
