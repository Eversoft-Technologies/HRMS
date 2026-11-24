"""Task Tracker notifications (api/task_notify.py): assignees, reassignment,
status changes, comments, watchers and @mentions - in-app and email, once
per recipient per action, honouring Settings > Notifications."""
import json
from unittest import mock

from django.test import Client, TestCase, override_settings

from api import task_notify
from api.models import (AppUser, EmployeeTask, Notification, NotificationPreference, Permission, Project,
                        Role, RolePermission)


def grant(role, *codes):
    for c in codes:
        p, _ = Permission.objects.get_or_create(code=c, defaults={'name': c})
        RolePermission.objects.get_or_create(role=role, permission=p)


J = 'application/json'
OK = {'ok': True}


@override_settings(HRMS_PUBLIC_URL='https://hrms.example.com')
class TaskNotifyTests(TestCase):
    def setUp(self):
        task_notify.RUN_ASYNC = False
        lead = Role.objects.create(name='Notify Lead')
        grant(lead, 'employee.view', 'task.create', 'task.edit', 'task.delete', 'project.create')
        AppUser.objects.create(email='lead@co.com', full_name='Lena Lead', role_ref=lead, status='active')
        AppUser.objects.create(email='ann@co.com', full_name='Ann Assignee', role_ref=lead, status='active')
        AppUser.objects.create(email='bob@co.com', full_name='Bob Builder', role_ref=lead, status='active')
        AppUser.objects.create(email='cat@co.com', full_name='Cat Watcher', role_ref=lead, status='active')
        AppUser.objects.create(email='gone@co.com', full_name='Gone Away', role_ref=lead, status='inactive')
        self.lead = Client(HTTP_X_USER_EMAIL='lead@co.com')
        self.ann = Client(HTTP_X_USER_EMAIL='ann@co.com')
        self.bob = Client(HTTP_X_USER_EMAIL='bob@co.com')
        self.proj = Project.objects.create(project_code='PRJ-N', name='Notify Project')
        patcher = mock.patch('api.mailer.send_email', return_value=OK)
        self.send = patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        task_notify.RUN_ASYNC = True

    # helpers -------------------------------------------------------------
    def create(self, client=None, **kw):
        body = {'title': 'Fix login', 'projectId': self.proj.id}
        body.update(kw)
        with self.captureOnCommitCallbacks(execute=True):
            r = (client or self.lead).post('/api/tasks', body, content_type=J)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def put(self, tid, body, client=None):
        with self.captureOnCommitCallbacks(execute=True):
            r = (client or self.lead).put('/api/tasks/%d' % tid, body, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def comment(self, tid, text, client=None):
        with self.captureOnCommitCallbacks(execute=True):
            r = (client or self.lead).post('/api/tasks/%d/comments' % tid, {'body': text}, content_type=J)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def notes(self, email):
        return list(Notification.objects.filter(recipient=email).order_by('id'))

    def mails(self, email=None):
        out = [c for c in self.send.call_args_list]
        return [c for c in out if email is None or c.args[0] == email]

    def reset(self):
        Notification.objects.all().delete()
        self.send.reset_mock()

    # assignee ------------------------------------------------------------
    def test_assignee_on_create_in_app_and_email(self):
        t = self.create(assigneeEmail='ann@co.com', description='Please look <b>now</b> & fix')
        n = self.notes('ann@co.com')
        self.assertEqual(len(n), 1)
        self.assertIn('assigned you', n[0].title)
        self.assertEqual(n[0].link, '/employees/tasks/issue/%d' % t['id'])
        m = self.mails('ann@co.com')
        self.assertEqual(len(m), 1)
        subject, html = m[0].args[1], m[0].kwargs['html']
        self.assertIn('Fix login', subject)
        self.assertIn('https://hrms.example.com/employees/tasks/issue/%d' % t['id'], html)
        self.assertIn('Notify Project', html)
        self.assertIn('Please look &lt;b&gt;now&lt;/b&gt; &amp; fix', html)       # escaped excerpt
        self.assertNotIn('<b>now</b>', html)
        self.assertIn('#%d' % t['id'], html)
        # nobody else, and never the author
        self.assertEqual(self.notes('lead@co.com'), [])
        self.assertEqual(len(self.mails()), 1)

    def test_no_self_notification(self):
        self.create(client=self.ann, assigneeEmail='ann@co.com', description='note to @ann@co.com')
        self.assertEqual(self.notes('ann@co.com'), [])
        self.assertEqual(self.mails(), [])

    def test_reassignment_notifies_both(self):
        t = self.create(assigneeEmail='ann@co.com')
        self.reset()
        self.put(t['id'], {'assigneeEmail': 'bob@co.com'})
        bob, ann = self.notes('bob@co.com'), self.notes('ann@co.com')
        self.assertEqual(len(bob), 1)
        self.assertIn('assigned you', bob[0].title)
        self.assertEqual(len(ann), 1)
        self.assertIn('reassigned', ann[0].title)
        self.assertIn('Bob Builder', ann[0].message)
        self.assertEqual(len(self.mails('bob@co.com')), 1)
        self.assertEqual(len(self.mails('ann@co.com')), 1)
        # an unrelated edit notifies nobody
        self.reset()
        self.put(t['id'], {'priority': 'high'})
        self.assertEqual(Notification.objects.count(), 0)
        self.assertEqual(self.mails(), [])

    def test_status_change_close_reopen_to_assignee_and_watchers(self):
        t = self.create(assigneeEmail='ann@co.com', watchers=json.dumps(['cat@co.com', 'lead@co.com']))
        self.reset()
        self.put(t['id'], {'stage': 'review'}, client=self.bob)
        self.assertIn('moved', self.notes('ann@co.com')[0].title)
        self.assertIn('In Review', self.notes('cat@co.com')[0].message)
        self.assertEqual(len(self.notes('lead@co.com')), 1)          # watcher, not the actor
        self.assertEqual(self.notes('bob@co.com'), [])               # the actor
        self.reset()
        self.put(t['id'], {'stage': 'done'}, client=self.bob)
        self.assertIn('closed', self.notes('ann@co.com')[0].title)
        self.reset()
        self.put(t['id'], {'stage': 'todo'}, client=self.bob)
        self.assertIn('reopened', self.notes('ann@co.com')[0].title)
        # the assignee changing their own issue's status hears nothing
        self.reset()
        self.put(t['id'], {'stage': 'inprogress'}, client=self.ann)
        self.assertEqual(self.notes('ann@co.com'), [])
        self.assertEqual(len(self.notes('cat@co.com')), 1)

    # mentions --------------------------------------------------------------
    def test_mention_in_description_only_new_mentions_on_edit(self):
        t = self.create(description='cc @bob@co.com please')
        self.assertEqual(len(self.notes('bob@co.com')), 1)
        self.assertIn('mentioned you', self.notes('bob@co.com')[0].title)
        self.reset()
        self.put(t['id'], {'description': 'cc @bob@co.com please, and @cat@co.com'})
        self.assertEqual(self.notes('bob@co.com'), [])               # already mentioned
        self.assertEqual(len(self.notes('cat@co.com')), 1)
        self.assertEqual(len(self.mails('cat@co.com')), 1)
        self.reset()
        self.put(t['id'], {'description': 'cc @bob@co.com please, and @cat@co.com (edited)'})
        self.assertEqual(Notification.objects.count(), 0)

    def test_mention_by_name_inactive_and_code_ignored(self):
        self.create(description='@bob and @gone@co.com and `@cat@co.com` and @nobody@co.com\n```\n@ann@co.com\n```')
        self.assertEqual(len(self.notes('bob@co.com')), 1)            # @bob = email local part, unique
        self.assertEqual(self.notes('gone@co.com'), [])               # inactive
        self.assertEqual(self.notes('cat@co.com'), [])                # inside code
        self.assertEqual(self.notes('ann@co.com'), [])                # inside a fence
        self.assertEqual(self.notes('nobody@co.com'), [])

    def test_mention_in_comment_and_edit(self):
        t = self.create(assigneeEmail='ann@co.com')
        self.reset()
        c = self.comment(t['id'], 'Hey @bob@co.com, see <script>x</script>')
        self.assertIn('mentioned you', self.notes('bob@co.com')[0].title)
        self.assertIn('commented', self.notes('ann@co.com')[0].title)
        html = self.mails('bob@co.com')[0].kwargs['html']
        self.assertIn('&lt;script&gt;x&lt;/script&gt;', html)
        self.assertNotIn('<script>x', html)
        self.assertEqual(self.notes('lead@co.com'), [])
        # editing: only the newly mentioned person hears about it
        self.reset()
        with self.captureOnCommitCallbacks(execute=True):
            r = self.lead.patch('/api/tasks/%d/comments/%d' % (t['id'], c['id']),
                                {'body': 'Hey @bob@co.com and @cat@co.com'}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.notes('bob@co.com'), [])
        self.assertEqual(self.notes('ann@co.com'), [])
        self.assertEqual(len(self.notes('cat@co.com')), 1)
        # only the author may edit
        self.assertEqual(self.bob.patch('/api/tasks/%d/comments/%d' % (t['id'], c['id']),
                                        {'body': 'x'}, content_type=J).status_code, 403)

    def test_comment_reaches_watchers(self):
        t = self.create(assigneeEmail='ann@co.com', watchers=json.dumps([{'email': 'cat@co.com'}]))
        self.reset()
        self.comment(t['id'], 'Progress update', client=self.bob)
        self.assertEqual(len(self.notes('ann@co.com')), 1)
        self.assertEqual(len(self.notes('cat@co.com')), 1)
        self.assertEqual(self.notes('bob@co.com'), [])

    # one message per recipient --------------------------------------------
    def test_assigned_and_mentioned_is_one_message(self):
        self.create(assigneeEmail='ann@co.com', description='@ann@co.com this one is yours')
        n = self.notes('ann@co.com')
        self.assertEqual(len(n), 1)
        self.assertIn('assigned you', n[0].message)
        self.assertIn('mentioned you', n[0].message)
        self.assertEqual(len(self.mails('ann@co.com')), 1)
        self.assertIn('mentioned you', self.mails('ann@co.com')[0].kwargs['html'])

    # preferences ----------------------------------------------------------------
    def test_preferences_switch_channels_off(self):
        NotificationPreference.objects.create(email='ann@co.com', prefs={'task_emails': False})
        NotificationPreference.objects.create(email='bob@co.com', prefs={'task_activity': False})
        self.create(assigneeEmail='ann@co.com', description='@bob@co.com fyi')
        self.assertEqual(len(self.notes('ann@co.com')), 1)            # in-app on
        self.assertEqual(self.mails('ann@co.com'), [])                # email off
        self.assertEqual(self.notes('bob@co.com'), [])                # in-app off
        self.assertEqual(len(self.mails('bob@co.com')), 1)            # email still on
        NotificationPreference.objects.filter(email='ann@co.com').update(
            prefs={'task_emails': False, 'task_activity': False})
        self.reset()
        self.create(assigneeEmail='ann@co.com')
        self.assertEqual(self.notes('ann@co.com'), [])
        self.assertEqual(self.mails(), [])

    # failures --------------------------------------------------------------------
    def test_email_failure_is_logged_not_raised(self):
        self.send.return_value = {'ok': False, 'error': 'SMTP down'}
        with self.assertLogs('api.task_notify', level='WARNING') as logs:
            self.create(assigneeEmail='ann@co.com')
        self.assertTrue(any('SMTP down' in m for m in logs.output))
        self.assertEqual(len(self.notes('ann@co.com')), 1)
        self.send.side_effect = RuntimeError('boom')
        with self.assertLogs('api.task_notify', level='ERROR'):
            self.create(assigneeEmail='ann@co.com')

    def test_email_sent_only_after_commit(self):
        with self.captureOnCommitCallbacks(execute=False) as cbs:
            r = self.lead.post('/api/tasks', {'title': 'Later', 'assigneeEmail': 'ann@co.com'}, content_type=J)
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.mails(), [])
        self.assertTrue(cbs)
        for cb in cbs:
            cb()
        self.assertEqual(len(self.mails('ann@co.com')), 1)

    @override_settings(HRMS_PUBLIC_URL='')
    def test_link_falls_back_to_request_host(self):
        with mock.patch.dict('os.environ', {'PUBLIC_BASE_URL': ''}):
            t = self.create(assigneeEmail='ann@co.com')
        self.assertIn('http://testserver/employees/tasks/issue/%d' % t['id'], self.mails('ann@co.com')[0].kwargs['html'])
        self.assertEqual(task_notify.public_base(None), '')

    def test_helpers(self):
        self.assertEqual(task_notify.mention_tokens('mail me@x.io or @a@b.co and @word, not `@c@d.e`'),
                         ({'a@b.co'}, {'word'}))
        self.assertEqual(task_notify.excerpt('x' * 400)[-1], '…')
        self.assertEqual(len(task_notify.excerpt('x' * 400)), 301)
        self.assertEqual(task_notify.excerpt('![shot](data:image/png;base64,AAAA) hi'), '[image: shot] hi')
        t = EmployeeTask.objects.create(title='w', watchers='not json, cat@co.com')
        self.assertEqual(task_notify.watchers_of(t), {'cat@co.com'})
