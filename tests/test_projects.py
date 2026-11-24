"""
tests/test_projects.py
=============================================================================
Unit and integration tests for Multi-Project Tracking and Cross-Team Collaboration.
"""
from decimal import Decimal
from django.test import Client, TestCase

from api.models import AppUser, Role, RolePermission, Permission, Team, TeamMembership, Project, ProjectMilestone, EmployeeTask, TimesheetEntry


def grant(role, *codes):
    for c in codes:
        p, _ = Permission.objects.get_or_create(code=c, defaults={'name': c})
        RolePermission.objects.get_or_create(role=role, permission=p)


class ProjectTests(TestCase):
    def setUp(self):
        self.hr_role = Role.objects.create(name='HR Project Manager')
        grant(self.hr_role, 'employee.view', 'task.create', 'task.edit', 'project.create', 'project.edit')
        self.dev_role = Role.objects.create(name='Developer')
        grant(self.dev_role, 'employee.view', 'task.edit')

        self.hr_user = AppUser.objects.create(email='hr@co.com', full_name='HR Lead', role_ref=self.hr_role)
        self.alice = AppUser.objects.create(email='alice@co.com', full_name='Alice Backend', role_ref=self.dev_role)
        self.bob = AppUser.objects.create(email='bob@co.com', full_name='Bob Frontend', role_ref=self.dev_role)

        self.team_be = Team.objects.create(name='Backend Team', lead_email='alice@co.com')
        self.team_fe = Team.objects.create(name='Frontend Team', lead_email='bob@co.com')
        TeamMembership.objects.create(team=self.team_be, email='alice@co.com')
        TeamMembership.objects.create(team=self.team_fe, email='bob@co.com')

        self.hr_client = Client(HTTP_X_USER_EMAIL='hr@co.com')
        self.alice_client = Client(HTTP_X_USER_EMAIL='alice@co.com')
        self.bob_client = Client(HTTP_X_USER_EMAIL='bob@co.com')

    def test_create_and_list_projects_with_multiple_teams(self):
        payload = {
            'projectCode': 'PRJ-HRMS-V2',
            'name': 'HRMS Revamp v2.0',
            'description': 'Enterprise platform overhaul',
            'allocatedHours': 160.0,
            'contributingTeamIds': [self.team_be.id, self.team_fe.id]
        }
        res = self.hr_client.post('/api/projects', data=payload, content_type='application/json')
        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertEqual(data['projectCode'], 'PRJ-HRMS-V2')
        self.assertEqual(len(data['contributingTeams']), 2)

        # List projects
        list_res = self.alice_client.get('/api/projects')
        self.assertEqual(list_res.status_code, 200)
        self.assertEqual(len(list_res.json()), 1)

    def test_project_milestones_and_task_attribution(self):
        proj = Project.objects.create(
            project_code='PRJ-AUTH', name='Auth Overhaul', allocated_hours=Decimal('80.0')
        )
        proj.contributing_teams.add(self.team_be, self.team_fe)

        # Create milestone
        m_res = self.hr_client.post(f'/api/projects/{proj.id}/milestones', data={
            'title': 'Phase 1 MVP', 'dueDate': '2026-12-01', 'sortOrder': 1
        }, content_type='application/json')
        self.assertEqual(m_res.status_code, 201)
        milestone_id = m_res.json()['id']

        # Create task under this project & milestone
        t1 = EmployeeTask.objects.create(
            title='OAuth Endpoints',
            assignee='Alice Backend',
            assignee_email='alice@co.com',
            team=self.team_be,
            project=proj,
            milestone_id=milestone_id,
            stage='inprogress'
        )

        t2 = EmployeeTask.objects.create(
            title='Login UI',
            assignee='Bob Frontend',
            assignee_email='bob@co.com',
            team=self.team_fe,
            project=proj,
            milestone_id=milestone_id,
            stage='todo'
        )

        # Task 2 is blocked by Task 1
        t2.blocked_by.add(t1)

        # Filter tasks by project
        q_res = self.alice_client.get(f'/api/tasks?projectId={proj.id}')
        self.assertEqual(q_res.status_code, 200)
        self.assertEqual(len(q_res.json()), 2)

        # When t1 is marked complete, t2's dependency unblocks
        complete_res = self.alice_client.put(f'/api/tasks/{t1.id}', data={'stage': 'done'}, content_type='application/json')
        self.assertEqual(complete_res.status_code, 200)

    def test_project_burndown_and_timesheet_integration(self):
        proj = Project.objects.create(
            project_code='PRJ-MOBILE', name='Mobile Portal', allocated_hours=Decimal('100.0')
        )
        task = EmployeeTask.objects.create(
            title='Setup React Native',
            assignee_email='alice@co.com',
            project=proj
        )

        # Log timesheet entries
        TimesheetEntry.objects.create(
            email='alice@co.com', date='2026-11-20', project=proj.name, task_id=task.id, hours=Decimal('15.5')
        )
        TimesheetEntry.objects.create(
            email='bob@co.com', date='2026-11-21', project=proj.project_code, hours=Decimal('20.0')
        )

        burndown_res = self.alice_client.get(f'/api/projects/{proj.id}/burndown')
        self.assertEqual(burndown_res.status_code, 200)
        b_data = burndown_res.json()
        self.assertEqual(b_data['allocatedHours'], 100.0)
        self.assertEqual(b_data['spentHours'], 35.5)
        self.assertEqual(b_data['remainingHours'], 64.5)
        self.assertEqual(b_data['burnRatePercent'], 35.5)

    def test_task_threaded_comments_and_reactions(self):
        task = EmployeeTask.objects.create(
            title='GitHub style comments',
            assignee='Bob Frontend',
            assignee_email='bob@co.com'
        )

        # Alice posts a comment on Bob's task
        c_res = self.alice_client.post(f'/api/tasks/{task.id}/comments', data={
            'body': 'LGTM! Please add unit tests.', 'commentType': 'comment'
        }, content_type='application/json')
        self.assertEqual(c_res.status_code, 201)
        comment_id = c_res.json()['id']

        # Get comments
        get_res = self.bob_client.get(f'/api/tasks/{task.id}/comments')
        self.assertEqual(get_res.status_code, 200)
        self.assertEqual(len(get_res.json()), 1)
        self.assertEqual(get_res.json()[0]['body'], 'LGTM! Please add unit tests.')

        # Bob reacts with +1
        react_res = self.bob_client.post(f'/api/tasks/{task.id}/comments/{comment_id}/reactions', data={
            'emoji': '+1'
        }, content_type='application/json')
        self.assertEqual(react_res.status_code, 200)
        self.assertIn('bob@co.com', react_res.json()['reactions']['+1'])
