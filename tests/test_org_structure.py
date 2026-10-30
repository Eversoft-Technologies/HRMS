"""Reporting lines and teams (api/org_views.py and the wiring in api/views.py)."""
from datetime import date

from django.test import Client, TestCase

from api.models import (AppUser, EmployeeTask, LeaveRequest, Permission, Role, RolePermission, Team,
                        TeamMembership, UserProfile)


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class OrgBase(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@x.com', full_name='Admin', password='x', role='admin')
        self.hr_role = Role.objects.create(name='HR Manager')
        grant(self.hr_role, 'employee.view', 'employee.edit', 'employee.create')
        AppUser.objects.create(email='hr@x.com', full_name='HR', password='x', role='hr', role_ref=self.hr_role)
        emp = Role.objects.create(name='Employee')
        self.emp_role = emp
        for email, first, last in (('anna@x.com', 'Anna', 'Lead'), ('bob@x.com', 'Bob', 'Dev'),
                                   ('cara@x.com', 'Cara', 'Dev'), ('dan@x.com', 'Dan', 'Ops')):
            AppUser.objects.create(email=email, full_name=f'{first} {last}', password='x', role='employee', role_ref=emp)
            UserProfile.objects.create(email=email, first_name=first, last_name=last)
        self.admin = Client(HTTP_X_USER_EMAIL='admin@x.com')
        self.hr = Client(HTTP_X_USER_EMAIL='hr@x.com')
        self.bob = Client(HTTP_X_USER_EMAIL='bob@x.com')
        self.anna = Client(HTTP_X_USER_EMAIL='anna@x.com')
        self.dan = Client(HTTP_X_USER_EMAIL='dan@x.com')

    def set_manager(self, client, who, manager):
        return client.patch(f'/api/employees/{who}', data={'managerEmail': manager}, content_type='application/json')


class ManagerLinkTests(OrgBase):
    def test_hr_sets_a_manager_by_reference(self):
        r = self.set_manager(self.hr, 'bob@x.com', 'anna@x.com')
        self.assertEqual(r.status_code, 200, r.content)
        p = UserProfile.objects.get(email='bob@x.com')
        self.assertEqual((p.manager_email, p.manager), ('anna@x.com', 'Anna Lead'))
        prof = self.admin.get('/api/employees/bob@x.com/profile').json()
        self.assertEqual(prof['org']['manager']['email'], 'anna@x.com')
        self.assertEqual(prof['employment']['managerEmail'], 'anna@x.com')
        anna = self.admin.get('/api/employees/anna@x.com/profile').json()
        self.assertEqual([r['email'] for r in anna['org']['reports']], ['bob@x.com'])

    def test_self_unknown_and_cycles_are_rejected(self):
        self.assertIn('own manager', self.set_manager(self.hr, 'bob@x.com', 'bob@x.com').json()['message'])
        self.assertIn('existing employee', self.set_manager(self.hr, 'bob@x.com', 'ghost@x.com').json()['message'])
        self.assertEqual(self.set_manager(self.hr, 'bob@x.com', 'anna@x.com').status_code, 200)
        self.assertEqual(self.set_manager(self.hr, 'cara@x.com', 'bob@x.com').status_code, 200)
        r = self.set_manager(self.hr, 'anna@x.com', 'cara@x.com')          # anna <- bob <- cara <- anna
        self.assertEqual(r.status_code, 400)
        self.assertIn('circular', r.json()['message'])
        self.assertEqual(UserProfile.objects.get(email='anna@x.com').manager_email, '')

    def test_clearing_the_manager(self):
        self.set_manager(self.hr, 'bob@x.com', 'anna@x.com')
        self.assertEqual(self.set_manager(self.hr, 'bob@x.com', '').status_code, 200)
        p = UserProfile.objects.get(email='bob@x.com')
        self.assertEqual((p.manager_email, p.manager), ('', ''))

    def test_employee_cannot_change_their_own_manager(self):
        self.assertEqual(self.set_manager(self.bob, 'bob@x.com', 'anna@x.com').status_code, 403)

    def test_manager_review_lists_unlinked_text(self):
        UserProfile.objects.filter(email='dan@x.com').update(manager='Someone Gone')
        UserProfile.objects.filter(email='cara@x.com').update(manager_email='left@x.com', manager='Left Co')
        rows = self.hr.get('/api/org/manager-review').json()
        reasons = {r['employee']['email']: r['reason'] for r in rows}
        self.assertEqual(reasons['dan@x.com'], 'No employee with this name')
        self.assertEqual(reasons['cara@x.com'], 'Linked manager no longer exists')
        self.assertEqual(self.bob.get('/api/org/manager-review').status_code, 403)


class LeaveByManagerTests(OrgBase):
    def test_direct_manager_can_decide_but_others_cannot(self):
        self.set_manager(self.hr, 'bob@x.com', 'anna@x.com')
        lr = LeaveRequest.objects.create(email='bob@x.com', from_date=date(2026, 11, 2), to_date=date(2026, 11, 2))
        self.assertEqual(self.dan.put(f'/api/leave/{lr.id}', data={'status': 'Approved'},
                                      content_type='application/json').status_code, 403)
        r = self.anna.put(f'/api/leave/{lr.id}', data={'status': 'Approved'}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(LeaveRequest.objects.get(pk=lr.id).status, 'Approved')

    def test_nobody_approves_their_own_leave_through_the_manager_rule(self):
        lr = LeaveRequest.objects.create(email='bob@x.com', from_date=date(2026, 11, 2), to_date=date(2026, 11, 2))
        self.assertEqual(self.bob.put(f'/api/leave/{lr.id}', data={'status': 'Approved'},
                                      content_type='application/json').status_code, 403)


class TeamTests(OrgBase):
    def make_team(self, **extra):
        body = {'name': 'Platform', 'department': 'Engineering', 'leadEmail': 'anna@x.com',
                'members': ['bob@x.com']}
        body.update(extra)
        return self.hr.post('/api/teams', data=body, content_type='application/json')

    def test_create_team_adds_the_lead_as_a_member(self):
        r = self.make_team()
        self.assertEqual(r.status_code, 201, r.content)
        t = r.json()
        self.assertEqual(t['lead']['email'], 'anna@x.com')
        self.assertEqual(sorted(m['email'] for m in t['members']), ['anna@x.com', 'bob@x.com'])
        self.assertEqual(self.make_team().status_code, 409)                     # duplicate name

    def test_only_hr_manages_teams(self):
        self.assertEqual(self.bob.post('/api/teams', data={'name': 'X'}, content_type='application/json').status_code, 403)
        tid = self.make_team().json()['id']
        self.assertEqual(self.bob.post(f'/api/teams/{tid}/members', data={'email': 'cara@x.com'},
                                       content_type='application/json').status_code, 403)

    def test_visibility_members_see_their_team_others_do_not(self):
        tid = self.make_team().json()['id']
        self.assertEqual([t['id'] for t in self.bob.get('/api/teams').json()], [tid])
        self.assertEqual(self.dan.get('/api/teams').json(), [])
        self.assertEqual(self.dan.get(f'/api/teams/{tid}').status_code, 404)
        self.assertEqual(len(self.hr.get('/api/teams').json()), 1)

    def test_members_lead_and_multiple_teams(self):
        tid = self.make_team().json()['id']
        other = self.make_team(name='Infra', leadEmail='dan@x.com', members=['bob@x.com']).json()['id']
        self.assertEqual(self.hr.post(f'/api/teams/{tid}/members', data={'email': 'cara@x.com'},
                                      content_type='application/json').status_code, 201)
        self.assertEqual(self.hr.delete(f'/api/teams/{tid}/members/anna@x.com').status_code, 409)   # current lead
        self.assertEqual(self.hr.delete(f'/api/teams/{tid}/members/cara@x.com').status_code, 200)
        bob_teams = {t['id'] for t in self.admin.get('/api/employees/bob@x.com/profile').json()['org']['teams']}
        self.assertEqual(bob_teams, {tid, other})
        r = self.hr.put(f'/api/teams/{tid}', data={'leadEmail': 'bob@x.com'}, content_type='application/json')
        self.assertEqual(r.json()['lead']['email'], 'bob@x.com')

    def test_task_is_filed_under_the_assignees_team_with_its_lead(self):
        self.make_team()
        r = self.hr.post('/api/tasks', data={'title': 'Fix login', 'assigneeEmail': 'bob@x.com', 'teamLead': ''},
                         content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        t = EmployeeTask.objects.get(title='Fix login')
        self.assertEqual(t.team.name, 'Platform')
        self.assertEqual(t.team_lead_email, 'anna@x.com')
        self.assertEqual(t.team_lead, 'Anna Lead')
        self.assertEqual(r.json()['teamName'], 'Platform')

    def test_explicit_team_requires_membership(self):
        tid = self.make_team().json()['id']
        r = self.hr.post('/api/tasks', data={'title': 'X', 'assigneeEmail': 'dan@x.com', 'teamId': tid,
                                             'teamLead': 'Anna Lead'}, content_type='application/json')
        self.assertEqual(r.status_code, 400)
        self.assertIn('not a member', r.json()['message'])

    def test_deleting_a_team_keeps_its_tasks(self):
        tid = self.make_team().json()['id']
        self.hr.post('/api/tasks', data={'title': 'Keep me', 'assigneeEmail': 'bob@x.com', 'teamLead': 'x'},
                     content_type='application/json')
        self.assertEqual(self.hr.delete(f'/api/teams/{tid}').status_code, 200)
        self.assertIsNone(EmployeeTask.objects.get(title='Keep me').team_id)
        self.assertFalse(TeamMembership.objects.exists())
        self.assertFalse(Team.objects.exists())

    def test_people_picker(self):
        rows = self.hr.get('/api/org/people').json()
        self.assertIn('anna@x.com', [r['email'] for r in rows])
        self.assertEqual(self.bob.get('/api/org/people').status_code, 403)


class ManagerBackfillMigrationTests(OrgBase):
    """The 0076 data migration links free-text managers it can match."""
    def test_unique_names_and_emails_link_ambiguous_and_unknown_do_not(self):
        import importlib
        from django.apps import apps
        mig = importlib.import_module('api.migrations.0076_org_structure')
        AppUser.objects.create(email='anna2@x.com', full_name='Dup Name', password='x', role='employee')
        UserProfile.objects.create(email='dup@x.com', first_name='Dup', last_name='Name')
        UserProfile.objects.filter(email='bob@x.com').update(manager='anna lead')         # name, case-insensitive
        UserProfile.objects.filter(email='cara@x.com').update(manager='ANNA@x.com')       # email
        UserProfile.objects.filter(email='dan@x.com').update(manager='Dup Name')          # two people
        UserProfile.objects.filter(email='anna@x.com').update(manager='Nobody Here')      # unknown
        mig.link_managers(apps, None)
        got = dict(UserProfile.objects.values_list('email', 'manager_email'))
        self.assertEqual(got['bob@x.com'], 'anna@x.com')
        self.assertEqual(got['cara@x.com'], 'anna@x.com')
        self.assertEqual(got['dan@x.com'], '')
        self.assertEqual(got['anna@x.com'], '')


class ReportingTreeTests(OrgBase):
    def test_tree_size_departments_and_codes(self):
        UserProfile.objects.filter(email='bob@x.com').update(manager_email='anna@x.com', department='Engineering')
        UserProfile.objects.filter(email='cara@x.com').update(manager_email='bob@x.com', department='QA')
        UserProfile.objects.filter(email='dan@x.com').update(manager_email='cara@x.com', department='QA')
        AppUser.objects.filter(email='bob@x.com').update(employee_id='EV-0012')
        org = self.admin.get('/api/employees/anna@x.com/profile').json()['org']
        self.assertEqual([r['email'] for r in org['reports']], ['bob@x.com'])
        self.assertEqual(org['reports'][0]['employeeId'], 'EV-0012')
        self.assertEqual(org['treeSize'], 3)                       # bob, cara, dan
        self.assertEqual(org['departments'], ['Engineering', 'QA'])


class LedTeamStructureTests(OrgBase):
    def test_led_team_members_count_alongside_reports(self):
        UserProfile.objects.filter(email='bob@x.com').update(manager_email='anna@x.com', department='Engineering')
        UserProfile.objects.filter(email='cara@x.com').update(department='QA')
        team = Team.objects.create(name='Backend', lead_email='anna@x.com')
        for e in ('anna@x.com', 'bob@x.com', 'cara@x.com'):
            TeamMembership.objects.create(team=team, email=e)
        archived = Team.objects.create(name='Old', lead_email='anna@x.com', status='archived')
        TeamMembership.objects.create(team=archived, email='dan@x.com')
        org = self.admin.get('/api/employees/anna@x.com/profile').json()['org']
        self.assertEqual([r['email'] for r in org['reports']], ['bob@x.com'])
        self.assertEqual([(m['email'], m['teams']) for m in org['teamMembers']],
                         [('bob@x.com', ['Backend']), ('cara@x.com', ['Backend'])])
        self.assertEqual(org['treeSize'], 2)                       # bob counted once; archived team ignored
        self.assertEqual(org['departments'], ['Engineering', 'QA'])
