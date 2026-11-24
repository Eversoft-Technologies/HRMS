"""Matrix reporting (hrms_plus/org.py): project / scrum lead lines next to the
line manager, the chart data that draws them, and who may read / write them."""
from datetime import timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, Notification, Permission, Role, RolePermission, UserProfile
from api.timeutil import local_today
from hrms_plus.models import ReportingLine


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class MatrixBase(TestCase):
    PEOPLE = (
        # email, role, manager, status
        ('ceo@x.com', 'emp', '', 'active'),
        ('boss@x.com', 'emp', 'ceo@x.com', 'active'),
        ('a@x.com', 'emp', 'boss@x.com', 'active'),
        ('b@x.com', 'emp', 'boss@x.com', 'active'),
        ('lead@x.com', 'emp', 'ceo@x.com', 'active'),
        ('lead2@x.com', 'emp', 'ceo@x.com', 'active'),
        ('solo@x.com', 'emp', '', 'active'),
        ('gone@x.com', 'emp', 'boss@x.com', 'inactive'),
        ('hr@x.com', 'hr', '', 'active'),
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
        grant(hr, 'employee.view', 'employee.edit', 'attendance.edit')
        roles = {'emp': emp, 'hr': hr}
        for email, role, mgr, status in self.PEOPLE:
            name = email.split('@')[0].title()
            AppUser.objects.create(email=email, full_name=name, password='x', role='employee',
                                   role_ref=roles[role], status=status)
            UserProfile.objects.create(email=email, first_name=name, manager_email=mgr, department='Eng')
        self.today = local_today()

    def c(self, who):
        return Client(HTTP_X_USER_EMAIL=who)

    def post(self, who, url, body):
        return self.c(who).post(url, body, content_type='application/json')

    def add(self, email='a@x.com', lead='lead@x.com', project='Alpha', pct=60, who='hr@x.com', **kw):
        body = {'email': email, 'leadEmail': lead, 'project': project, 'allocationPct': pct}
        body.update(kw)
        return self.post(who, '/api/org/lines', body)

    def line(self, email='a@x.com', lead='lead@x.com', project='Alpha', pct=60, **kw):
        return ReportingLine.objects.create(email=email, lead_email=lead, project=project, allocation_pct=pct, **kw)


class WriteTests(MatrixBase):
    def test_hr_creates_a_line_with_audit_and_notifications(self):
        with self.assertLogs('hrms.audit.org', 'INFO') as logs:
            r = self.add()
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()['line']
        self.assertEqual((d['email'], d['leadEmail'], d['project'], d['allocationPct'], d['status']),
                         ('a@x.com', 'lead@x.com', 'Alpha', 60, 'active'))
        self.assertEqual(ReportingLine.objects.get().created_by, 'hr@x.com')
        self.assertIn('created', logs.output[0])
        self.assertIn('actor=hr@x.com', logs.output[0])
        self.assertTrue(Notification.objects.filter(recipient='a@x.com', title='New project lead').exists())
        self.assertTrue(Notification.objects.filter(recipient='lead@x.com').exists())
        # the line manager (and so approvals) is untouched
        self.assertEqual(UserProfile.objects.get(email='a@x.com').manager_email, 'boss@x.com')

    def test_permissions(self):
        self.assertEqual(self.add(who='boss@x.com').status_code, 403)          # managers do not write lines
        self.assertEqual(self.add(email='hr@x.com').status_code, 403)          # nobody edits their own lines
        self.assertEqual(Client().post('/api/org/lines', {}, content_type='application/json').status_code, 401)
        self.assertFalse(ReportingLine.objects.exists())

    def test_validation(self):
        cases = [
            ({'lead': 'a@x.com'}, 'own project lead'),
            ({'email': 'gone@x.com'}, 'not an active employee'),
            ({'lead': 'nobody@x.com'}, 'not an active employee'),
            ({'project': ''}, 'Name the project'),
            ({'pct': 120}, 'between 0 and 100'),
            ({'pct': 'lots'}, 'whole number'),
            ({'kind': 'boss'}, 'kind must be'),
            ({'startDate': '2026-12-10', 'endDate': '2026-12-01'}, 'before the start'),
            ({'startDate': 'soon'}, 'must be a date'),
            ({'endDate': (self.today - timedelta(days=1)).isoformat()}, 'already in the past'),
        ]
        for kw, msg in cases:
            r = self.add(**kw)
            self.assertEqual(r.status_code, 400, kw)
            self.assertIn(msg, r.json()['message'], kw)
        self.assertFalse(ReportingLine.objects.exists())

    def test_duplicates_and_allocation_cap(self):
        self.assertEqual(self.add(pct=60).status_code, 201)
        r = self.add(pct=10)                                                  # same lead + project
        self.assertEqual(r.status_code, 400)
        self.assertIn('already has an active line', r.json()['message'])
        self.assertEqual(self.add(project='alpha ', pct=5).status_code, 400)  # case / spacing insensitive
        r = self.add(lead='lead2@x.com', project='Beta', pct=50)              # 60 + 50 > 100
        self.assertEqual(r.status_code, 400)
        self.assertIn('110%', r.json()['message'])
        self.assertEqual(self.add(lead='lead2@x.com', project='Beta', pct=40).status_code, 201)
        # a dotted line takes no project time
        self.assertEqual(self.add(lead='lead2@x.com', project='', kind='dotted', pct=0).status_code, 201)
        # a later project that does not overlap in time is fine
        start = self.today + timedelta(days=60)
        r = self.add(lead='boss@x.com', project='Gamma', pct=100, startDate=start.isoformat())
        self.assertEqual(r.status_code, 400)          # Alpha / Beta are open-ended, so they overlap
        ReportingLine.objects.filter(project__in=('Alpha', 'Beta')).update(end_date=start - timedelta(days=1))
        r = self.add(lead='boss@x.com', project='Gamma', pct=100, startDate=start.isoformat())
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['line']['status'], 'scheduled')

    def test_update_and_soft_delete(self):
        pk = self.add().json()['line']['id']
        self.add(lead='lead2@x.com', project='Beta', pct=40)
        r = self.c('hr@x.com').patch(f'/api/org/lines/{pk}', {'allocationPct': 70}, content_type='application/json')
        self.assertEqual(r.status_code, 400)                                   # 70 + 40
        r = self.c('hr@x.com').patch(f'/api/org/lines/{pk}', {'allocationPct': 50}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(ReportingLine.objects.get(pk=pk).allocation_pct, 50)
        self.assertEqual(self.c('boss@x.com').delete(f'/api/org/lines/{pk}').status_code, 403)
        r = self.c('hr@x.com').delete(f'/api/org/lines/{pk}')
        self.assertEqual(r.status_code, 200)
        line = ReportingLine.objects.get(pk=pk)
        self.assertFalse(line.is_active)                                       # kept for history
        self.assertEqual(self.add(pct=60).status_code, 201)                    # may be added again
        r = self.c('hr@x.com').patch(f'/api/org/lines/{pk}', {'allocationPct': 5}, content_type='application/json')
        self.assertEqual(r.status_code, 409)

    def test_bulk_is_all_or_nothing(self):
        self.line(email='b@x.com', lead='lead2@x.com', project='Beta', pct=80)
        body = {'leadEmail': 'lead@x.com', 'project': 'Alpha',
                'people': [{'email': 'a@x.com', 'allocationPct': 50}, {'email': 'b@x.com', 'allocationPct': 30},
                           {'email': 'solo@x.com', 'allocationPct': 100}]}
        r = self.post('hr@x.com', '/api/org/lines/bulk', body)
        self.assertEqual(r.status_code, 400)
        self.assertEqual([e['email'] for e in r.json()['errors']], ['b@x.com'])        # 80 + 30
        self.assertEqual(ReportingLine.objects.count(), 1)
        body['people'][1]['allocationPct'] = 20
        r = self.post('hr@x.com', '/api/org/lines/bulk', body)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(len(r.json()['created']), 3)
        self.assertEqual(self.post('boss@x.com', '/api/org/lines/bulk', body).status_code, 403)
        r = self.post('hr@x.com', '/api/org/lines/bulk', dict(body, project='Delta', people=['a@x.com', 'a@x.com']))
        self.assertEqual(r.status_code, 400)
        self.assertIn('Listed twice', str(r.json()['errors']))


class ReadTests(MatrixBase):
    def setUp(self):
        super().setUp()
        self.line()                                                            # a -> lead, Alpha 60%
        self.line(email='b@x.com', lead='lead2@x.com', project='Beta', pct=30)

    def test_who_may_read_a_persons_lines(self):
        for who in ('a@x.com', 'boss@x.com', 'ceo@x.com', 'lead@x.com', 'hr@x.com'):
            r = self.c(who).get('/api/org/lines', {'email': 'a@x.com'})
            self.assertEqual(r.status_code, 200, who)
        for who in ('b@x.com', 'solo@x.com', 'lead2@x.com'):
            self.assertEqual(self.c(who).get('/api/org/lines', {'email': 'a@x.com'}).status_code, 403, who)
        d = self.c('boss@x.com').get('/api/org/lines', {'email': 'a@x.com'}).json()
        self.assertEqual(d['lineManager']['email'], 'boss@x.com')
        self.assertEqual(d['lines'][0]['leadEmail'], 'lead@x.com')
        self.assertEqual(d['allocation']['label'], '60% Alpha, 40% line team')
        self.assertFalse(d['canEdit'])
        self.assertNotIn('projectReports', d)
        self.assertTrue(self.c('hr@x.com').get('/api/org/lines', {'email': 'a@x.com'}).json()['canEdit'])
        self.assertEqual(self.c('a@x.com').get('/api/org/lines', {'all': '1'}).status_code, 403)
        self.assertEqual(self.c('hr@x.com').get('/api/org/lines', {'all': '1'}).json()['count'], 2)

    def test_my_project_reports(self):
        d = self.c('lead@x.com').get('/api/org/project-reports').json()
        self.assertEqual([l['email'] for l in d['lines']], ['a@x.com'])
        self.assertEqual(d['lines'][0]['allocation']['projectPct'], 60)
        self.assertEqual(self.c('lead@x.com').get('/api/org/project-reports', {'lead': 'lead2@x.com'}).status_code, 403)
        own = self.c('lead@x.com').get('/api/org/lines').json()
        self.assertEqual([l['email'] for l in own['projectReports']], ['a@x.com'])
        self.assertEqual(self.c('solo@x.com').get('/api/org/projects').json()['projects'][0]['name'], 'Alpha')

    def test_chart_edges(self):
        self.line(email='solo@x.com', lead='lead@x.com', project='Later', pct=10,
                  start_date=self.today + timedelta(days=5))                   # scheduled: not drawn yet
        self.line(email='gone@x.com', lead='lead@x.com', project='Alpha', pct=10)  # inactive person: not drawn
        self.line(email='b@x.com', lead='lead@x.com', project='Old', pct=10, is_active=False)
        d = self.c('hr@x.com').get('/api/org/chart').json()
        line_edges = {(e['from'], e['to']) for e in d['edges'] if e['kind'] == 'line'}
        self.assertIn(('boss@x.com', 'a@x.com'), line_edges)
        proj = [e for e in d['edges'] if e['kind'] == 'project']
        self.assertEqual({(e['from'], e['to'], e['project'], e['pct']) for e in proj},
                         {('lead@x.com', 'a@x.com', 'Alpha', 60), ('lead2@x.com', 'b@x.com', 'Beta', 30)})
        self.assertTrue(d['canEditLines'])
        nodes = {n['email']: n for n in d['nodes']}
        self.assertEqual((nodes['lead@x.com']['projectReportsCount'], nodes['a@x.com']['projectLeadsCount']), (1, 1))
        self.assertEqual([p['name'] for p in d['projects']], ['Alpha', 'Beta'])
        # everyone sees who leads whom; the % only the person, their managers, leads and HR
        d = self.c('solo@x.com').get('/api/org/chart').json()
        self.assertEqual({e['pct'] for e in d['edges'] if e['kind'] == 'project'}, {None})
        self.assertFalse(d['canEditLines'])
        d = self.c('boss@x.com').get('/api/org/chart').json()
        pct = {e['to']: e['pct'] for e in d['edges'] if e['kind'] == 'project'}
        self.assertEqual(pct, {'a@x.com': 60, 'b@x.com': 30})
        # the existing tree endpoint is unchanged
        t = self.c('solo@x.com').get('/api/org/tree').json()
        self.assertIn('roots', t)
        self.assertNotIn('edges', t)


class DirectoryRightsCannotWriteLinesTests(MatrixBase):
    """employee.edit is a directory right plain employees hold on real installs:
    it must not let them create or end reporting lines."""

    def test_employee_edit_alone_cannot_write(self):
        grant(Role.objects.get(name='Employee'), 'employee.view', 'employee.edit')
        from api import permissions
        permissions._CACHE.clear()
        r = self.add(who='solo@x.com')
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(ReportingLine.objects.exists())
