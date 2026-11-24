"""
Task Tracker board (GitHub Projects-style page, dist/dist/assets/hrms-projects.js).

Covers what the board needs from the API:
  * GET /api/tasks returns the project-tracking fields (labels, project,
    milestone, comment count, updatedAt) - the serializer's hand-written
    representation used to drop them;
  * a status change (incl. the 'review' stage) is stored and logged as a
    timeline event that does not count as a comment;
  * DELETE /api/tasks/<id>/comments/<cid>: author or task.delete only.
"""
from django.test import Client, TestCase

from api.models import (AppUser, EmployeeTask, Permission, Project, ProjectMilestone,
                        Role, RolePermission, TaskComment)


def grant(role, *codes):
    for c in codes:
        p, _ = Permission.objects.get_or_create(code=c, defaults={'name': c})
        RolePermission.objects.get_or_create(role=role, permission=p)


class TaskTrackerBoardTests(TestCase):
    def setUp(self):
        lead = Role.objects.create(name='Board Lead')
        grant(lead, 'employee.view', 'task.create', 'task.edit', 'task.delete', 'project.create')
        dev = Role.objects.create(name='Board Dev')
        grant(dev, 'employee.view', 'task.edit')
        AppUser.objects.create(email='lead@co.com', full_name='Lead One', role_ref=lead, status='active')
        AppUser.objects.create(email='dev@co.com', full_name='Dev One', role_ref=dev, status='active')
        AppUser.objects.create(email='dev2@co.com', full_name='Dev Two', role_ref=dev, status='active')
        self.lead = Client(HTTP_X_USER_EMAIL='lead@co.com')
        self.dev = Client(HTTP_X_USER_EMAIL='dev@co.com')
        self.dev2 = Client(HTTP_X_USER_EMAIL='dev2@co.com')
        self.proj = Project.objects.create(project_code='PRJ-B', name='Board Project')
        self.ms = ProjectMilestone.objects.create(project=self.proj, title='M1')

    def _row(self, task_id, client=None):
        res = (client or self.lead).get('/api/tasks')
        self.assertEqual(res.status_code, 200)
        return next(r for r in res.json() if r['id'] == task_id)

    def test_list_returns_project_tracking_fields(self):
        res = self.lead.post('/api/tasks', data={
            'title': 'Wire the board', 'assigneeEmail': 'dev@co.com', 'priority': 'high',
            'stage': 'todo', 'projectId': self.proj.id, 'milestoneId': self.ms.id,
            'labels': '["bug", "frontend"]', 'due': '2026-12-01',
        }, content_type='application/json')
        self.assertEqual(res.status_code, 201, res.content)
        tid = res.json()['id']
        row = self._row(tid)
        self.assertEqual(row['labels'], '["bug", "frontend"]')
        self.assertEqual(row['projectId'], self.proj.id)
        self.assertEqual(row['projectName'], 'Board Project')
        self.assertEqual(row['projectCode'], 'PRJ-B')
        self.assertEqual(row['milestoneId'], self.ms.id)
        self.assertEqual(row['milestoneTitle'], 'M1')
        self.assertEqual(row['commentCount'], 0)
        self.assertTrue(row['updatedAt'])
        self.assertIn('blockedByIds', row)
        # Filtering by project still works.
        self.assertEqual(len(self.lead.get(f'/api/tasks?projectId={self.proj.id}').json()), 1)

    def test_status_change_is_stored_and_logged_as_event(self):
        t = EmployeeTask.objects.create(title='Review me', assignee_email='dev@co.com', assignee='Dev One')
        res = self.dev.put(f'/api/tasks/{t.id}', data={'stage': 'review'}, content_type='application/json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()['stage'], 'review')
        ev = TaskComment.objects.filter(task=t, comment_type='event')
        self.assertEqual(ev.count(), 1)
        self.assertIn('To Do', ev.first().body)
        self.assertIn('In Review', ev.first().body)
        # Same stage again: no new event. Events are not counted as comments.
        self.dev.put(f'/api/tasks/{t.id}', data={'stage': 'review'}, content_type='application/json')
        self.assertEqual(TaskComment.objects.filter(task=t, comment_type='event').count(), 1)
        self.dev.post(f'/api/tasks/{t.id}/comments', data={'body': 'hi'}, content_type='application/json')
        self.assertEqual(self._row(t.id)['commentCount'], 1)
        # Editing another field does not log an event.
        self.dev.put(f'/api/tasks/{t.id}', data={'title': 'Renamed'}, content_type='application/json')
        self.assertEqual(TaskComment.objects.filter(task=t, comment_type='event').count(), 1)

    def test_delete_comment_author_or_moderator_only(self):
        t = EmployeeTask.objects.create(title='Talk', assignee_email='dev@co.com')
        c1 = self.dev.post(f'/api/tasks/{t.id}/comments', data={'body': 'mine'},
                           content_type='application/json').json()['id']
        c2 = self.dev.post(f'/api/tasks/{t.id}/comments', data={'body': 'mine too'},
                           content_type='application/json').json()['id']
        # Someone else without task.delete cannot.
        self.assertEqual(self.dev2.delete(f'/api/tasks/{t.id}/comments/{c1}').status_code, 403)
        # The author can.
        self.assertEqual(self.dev.delete(f'/api/tasks/{t.id}/comments/{c1}').status_code, 200)
        self.assertFalse(TaskComment.objects.filter(pk=c1).exists())
        # A task.delete holder can moderate.
        self.assertEqual(self.lead.delete(f'/api/tasks/{t.id}/comments/{c2}').status_code, 200)
        # Wrong task id -> 404; events cannot be deleted.
        self.assertEqual(self.dev.delete(f'/api/tasks/{t.id + 999}/comments/{c2}').status_code, 404)
        ev = TaskComment.objects.create(task=t, author_email='dev@co.com', comment_type='event', body='moved')
        self.assertEqual(self.dev.delete(f'/api/tasks/{t.id}/comments/{ev.id}').status_code, 409)
        # Anonymous callers are refused.
        self.assertIn(Client().delete(f'/api/tasks/{t.id}/comments/{ev.id}').status_code, (401, 403))
