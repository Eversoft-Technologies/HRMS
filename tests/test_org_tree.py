"""Interactive org tree (api/org_tree.py): GET /api/org/tree, POST /api/org/manager."""
from django.test import Client, TestCase

from api import org_views
from api.models import AppUser, Notification, Permission, Role, RolePermission, UserProfile


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class OrgTreeBase(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@x.com', full_name='Admin Root', password='x', role='admin')
        hr_role = Role.objects.create(name='HR Manager')
        grant(hr_role, 'employee.view', 'employee.edit')
        AppUser.objects.create(email='hr@x.com', full_name='Hana Res', password='x', role='hr', role_ref=hr_role)
        self.emp_role = Role.objects.create(name='Employee')
        # ceo <- anna <- bob, cara ; dan has no manager
        for email, first, last, mgr in (('ceo@x.com', 'Cleo', 'Exec', ''),
                                        ('anna@x.com', 'Anna', 'Lead', 'ceo@x.com'),
                                        ('bob@x.com', 'Bob', 'Dev', 'anna@x.com'),
                                        ('cara@x.com', 'Cara', 'Dev', 'anna@x.com'),
                                        ('dan@x.com', 'Dan', 'Ops', '')):
            AppUser.objects.create(email=email, full_name=f'{first} {last}', password='x',
                                   role='employee', role_ref=self.emp_role)
            UserProfile.objects.create(email=email, first_name=first, last_name=last,
                                       designation='Engineer', department='Tech', manager_email=mgr)
        self.hr = Client(HTTP_X_USER_EMAIL='hr@x.com')
        self.bob = Client(HTTP_X_USER_EMAIL='bob@x.com')

    def tree(self, client=None):
        r = (client or self.bob).get('/api/org/tree')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def nodes(self, data):
        return {n['email']: n for n in data['nodes']}

    def move(self, who, manager, client=None):
        return (client or self.hr).post('/api/org/manager', data={'email': who, 'managerEmail': manager},
                                        content_type='application/json')


class TreeTests(OrgTreeBase):
    def test_shape_roots_and_report_counts(self):
        data = self.tree()
        n = self.nodes(data)
        self.assertEqual(n['anna@x.com']['parentEmail'], 'ceo@x.com')
        self.assertEqual(n['bob@x.com']['managerEmail'], 'anna@x.com')
        self.assertEqual(n['bob@x.com']['managerName'], 'Anna Lead')
        self.assertEqual(n['anna@x.com']['reportsCount'], 2)
        self.assertEqual(n['ceo@x.com']['reportsCount'], 1)
        self.assertEqual(n['bob@x.com']['reportsCount'], 0)
        self.assertIn('ceo@x.com', data['roots'])
        self.assertIn('dan@x.com', data['roots'])
        self.assertNotIn('anna@x.com', data['roots'])
        self.assertEqual(n['bob@x.com']['title'], 'Engineer')
        self.assertEqual(n['bob@x.com']['department'], 'Tech')
        self.assertEqual(data['me'], 'bob@x.com')
        self.assertFalse(data['canEdit'])
        self.assertFalse(data['canViewProfiles'])
        self.assertTrue(self.tree(self.hr)['canEdit'])
        self.assertTrue(self.tree(self.hr)['canViewProfiles'])

    def test_approver_matches_approval_routing(self):
        UserProfile.objects.filter(email='dan@x.com').update(manager_email='gone@x.com')
        for email, node in self.nodes(self.tree()).items():
            self.assertEqual(node['approverEmail'], org_views.approver_for(email), email)

    def test_inactive_people_are_excluded(self):
        AppUser.objects.filter(email='cara@x.com').update(status='disabled')
        n = self.nodes(self.tree())
        self.assertNotIn('cara@x.com', n)
        self.assertEqual(n['anna@x.com']['reportsCount'], 1)

    def test_unknown_manager_is_an_unresolved_root(self):
        UserProfile.objects.filter(email='dan@x.com').update(manager_email='ghost@x.com')
        data = self.tree()
        self.assertIn('dan@x.com', data['roots'])
        self.assertIn('dan@x.com', data['unresolved'])
        self.assertTrue(self.nodes(data)['dan@x.com']['managerIssue'])

    def test_legacy_cycle_still_shows_everyone(self):
        UserProfile.objects.filter(email='ceo@x.com').update(manager_email='bob@x.com')
        data = self.tree()
        self.assertTrue(data['roots'])
        self.assertEqual(len(data['nodes']), 7)

    def test_identity_required(self):
        self.assertEqual(Client().get('/api/org/tree').status_code, 401)
        self.assertEqual(Client(HTTP_X_USER_EMAIL='nobody@x.com').get('/api/org/tree').status_code, 401)

    def test_few_queries(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        self.tree(self.hr)                       # warm the permission / company caches
        with CaptureQueriesContext(connection) as small:
            self.tree(self.hr)
        for i in range(20):                      # more people must not mean more queries
            AppUser.objects.create(email=f'p{i}@x.com', full_name=f'P {i}', password='x', role='employee',
                                   role_ref=self.emp_role)
            UserProfile.objects.create(email=f'p{i}@x.com', first_name='P', manager_email='anna@x.com')
        with CaptureQueriesContext(connection) as big:
            self.tree(self.hr)
        self.assertEqual(len(big), len(small))
        self.assertLessEqual(len(big), 8)


class SetManagerTests(OrgTreeBase):
    def test_requires_employee_edit(self):
        r = self.move('cara@x.com', 'dan@x.com', client=self.bob)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(UserProfile.objects.get(email='cara@x.com').manager_email, 'anna@x.com')
        self.assertEqual(Client().post('/api/org/manager', data={}, content_type='application/json').status_code, 401)

    def test_self_manager_rejected(self):
        r = self.move('bob@x.com', 'bob@x.com')
        self.assertEqual(r.status_code, 400)
        self.assertIn('own manager', r.json()['message'])

    def test_cycle_rejected(self):
        r = self.move('anna@x.com', 'bob@x.com')        # bob already reports to anna
        self.assertEqual(r.status_code, 400)
        self.assertIn('circular', r.json()['message'])
        self.assertEqual(UserProfile.objects.get(email='anna@x.com').manager_email, 'ceo@x.com')

    def test_unknown_or_inactive_manager_rejected(self):
        self.assertEqual(self.move('bob@x.com', 'ghost@x.com').status_code, 400)
        AppUser.objects.filter(email='dan@x.com').update(status='disabled')
        r = self.move('bob@x.com', 'dan@x.com')
        self.assertEqual(r.status_code, 400)
        self.assertIn('active', r.json()['message'])

    def test_success_updates_routing_and_notifies(self):
        r = self.move('bob@x.com', 'dan@x.com')
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body['node']['managerEmail'], 'dan@x.com')
        self.assertEqual(body['node']['approverEmail'], 'dan@x.com')
        self.assertIn('pending', body['message'])
        p = UserProfile.objects.get(email='bob@x.com')
        self.assertEqual((p.manager_email, p.manager), ('dan@x.com', 'Dan Ops'))
        self.assertEqual(org_views.approver_for('bob@x.com'), 'dan@x.com')
        self.assertTrue(Notification.objects.filter(recipient='bob@x.com').exists())
        self.assertTrue(Notification.objects.filter(recipient='dan@x.com').exists())
        self.assertTrue(Notification.objects.filter(recipient='anna@x.com').exists())
        n = self.nodes(self.tree())
        self.assertEqual(n['dan@x.com']['reportsCount'], 1)
        self.assertEqual(n['anna@x.com']['reportsCount'], 1)

    def test_clearing_the_manager(self):
        r = self.move('bob@x.com', '')
        self.assertEqual(r.status_code, 200, r.content)
        p = UserProfile.objects.get(email='bob@x.com')
        self.assertEqual((p.manager_email, p.manager), ('', ''))
        self.assertEqual(org_views.approver_for('bob@x.com'), '')
        self.assertIn('bob@x.com', self.tree()['roots'])

    def test_profile_row_created_when_missing(self):
        AppUser.objects.create(email='new@x.com', full_name='Nina New', password='x',
                               role='employee', role_ref=self.emp_role)
        r = self.move('new@x.com', 'anna@x.com')
        self.assertEqual(r.status_code, 200, r.content)
        p = UserProfile.objects.get(email='new@x.com')
        self.assertEqual((p.first_name, p.last_name, p.manager_email), ('Nina', 'New', 'anna@x.com'))

    def test_own_reporting_line_and_unknown_employee(self):
        self.assertEqual(self.move('hr@x.com', 'anna@x.com').status_code, 403)
        self.assertEqual(self.move('ghost@x.com', 'anna@x.com').status_code, 404)
