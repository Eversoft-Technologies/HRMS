"""Cross-team collaborators and comments on work submissions."""
from django.test import Client, TestCase

from api.models import (AppUser, Notification, Permission, Role, RolePermission, SubmissionComment, Team,
                        TeamMembership, UserProfile, WorkSubmission)


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class DiscussionTests(TestCase):
    def setUp(self):
        hr = Role.objects.create(name='HR Manager')
        grant(hr, 'employee.view', 'employee.edit', 'submission.view_all', 'submission.action')
        emp = Role.objects.create(name='Employee')
        grant(emp, 'employee.view', 'employee.create')
        AppUser.objects.create(email='hr@x.com', full_name='HR Person', password='x', role='hr', role_ref=hr)
        for email, first in (('anna@x.com', 'Anna'), ('bob@x.com', 'Bob'), ('dan@x.com', 'Dan'), ('eve@x.com', 'Eve')):
            AppUser.objects.create(email=email, full_name=f'{first} X', password='x', role='employee', role_ref=emp)
            UserProfile.objects.create(email=email, first_name=first, last_name='X')
        backend = Team.objects.create(name='Backend', lead_email='anna@x.com')
        for e in ('anna@x.com', 'bob@x.com'):
            TeamMembership.objects.create(team=backend, email=e)
        design = Team.objects.create(name='Design', lead_email='dan@x.com')        # another team
        TeamMembership.objects.create(team=design, email='dan@x.com')
        self.sub = WorkSubmission.objects.create(email='bob@x.com', title='API spec', team=backend,
                                                 reviewer_email='anna@x.com', file_name='spec.pdf',
                                                 file_mime='application/pdf', file_data='JVBERi0=')
        self.c = {e: Client(HTTP_X_USER_EMAIL=e) for e in ('hr@x.com', 'anna@x.com', 'bob@x.com', 'dan@x.com', 'eve@x.com')}
        self.base = f'/api/submissions/{self.sub.id}'

    def post(self, who, url, body):
        return self.c[who].post(url, data=body, content_type='application/json')

    def test_outsiders_cannot_see_it_until_added(self):
        self.assertEqual(self.c['dan@x.com'].get(self.base + '/thread').status_code, 404)
        self.assertEqual([s['id'] for s in self.c['dan@x.com'].get('/api/submissions').json()], [])
        r = self.post('bob@x.com', self.base + '/collaborators', {'email': 'dan@x.com'})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual([c['email'] for c in r.json()['collaborators']], ['dan@x.com'])
        self.assertEqual([s['id'] for s in self.c['dan@x.com'].get('/api/submissions').json()], [self.sub.id])
        self.assertEqual(self.c['dan@x.com'].get(self.base + '/thread').status_code, 200)
        self.assertTrue(Notification.objects.filter(recipient='dan@x.com', title__icontains='discussion').exists())

    def test_collaborator_can_open_the_attachment_and_so_can_the_reviewer(self):
        self.assertEqual(self.c['anna@x.com'].get(self.base + '/file').status_code, 200)   # routed reviewer
        self.assertEqual(self.c['dan@x.com'].get(self.base + '/file').status_code, 403)
        self.post('bob@x.com', self.base + '/collaborators', {'email': 'dan@x.com'})
        self.assertEqual(self.c['dan@x.com'].get(self.base + '/file').status_code, 200)

    def test_who_may_add_people(self):
        self.post('bob@x.com', self.base + '/collaborators', {'email': 'dan@x.com'})
        r = self.post('dan@x.com', self.base + '/collaborators', {'email': 'eve@x.com'})
        self.assertEqual(r.status_code, 403)                     # collaborators cannot invite
        self.assertEqual(self.post('anna@x.com', self.base + '/collaborators', {'email': 'eve@x.com'}).status_code, 201)
        self.assertEqual(self.post('hr@x.com', self.base + '/collaborators', {'email': 'ghost@x.com'}).status_code, 400)

    def test_comments_thread_and_notifications(self):
        self.post('bob@x.com', self.base + '/collaborators', {'email': 'dan@x.com'})
        self.assertEqual(self.post('eve@x.com', self.base + '/comments', {'body': 'hi'}).status_code, 404)
        self.assertEqual(self.post('dan@x.com', self.base + '/comments', {'body': '  '}).status_code, 400)
        r = self.post('dan@x.com', self.base + '/comments', {'body': 'Can the header use our design tokens?'})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['authorName'], 'Dan X')
        self.post('bob@x.com', self.base + '/comments', {'body': 'Yes, updating now.'})
        thread = self.c['anna@x.com'].get(self.base + '/thread').json()
        self.assertEqual([c['authorEmail'] for c in thread['comments']], ['dan@x.com', 'bob@x.com'])
        self.assertTrue(thread['canManage'])
        self.assertFalse(self.c['dan@x.com'].get(self.base + '/thread').json()['canManage'])
        self.assertTrue(Notification.objects.filter(recipient='anna@x.com', title__icontains='comment').exists())
        self.assertFalse(Notification.objects.filter(recipient='dan@x.com', message__icontains='Dan X commented').exists())
        listing = self.c['bob@x.com'].get('/api/submissions').json()[0]
        self.assertEqual((listing['commentCount'], listing['collaborators']), (2, ['dan@x.com']))

    def test_collaborating_grants_no_decision_rights(self):
        self.post('bob@x.com', self.base + '/collaborators', {'email': 'dan@x.com'})
        r = self.c['dan@x.com'].put(self.base, data={'status': 'Approved'}, content_type='application/json')
        self.assertEqual(r.status_code, 403)

    def test_removing_and_leaving(self):
        self.post('bob@x.com', self.base + '/collaborators', {'emails': ['dan@x.com', 'eve@x.com']})
        self.assertEqual(self.c['dan@x.com'].delete(self.base + '/collaborators/eve@x.com').status_code, 403)
        r = self.c['dan@x.com'].delete(self.base + '/collaborators/dan@x.com')          # leave
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json().get('left'))
        self.assertEqual(self.c['dan@x.com'].get(self.base + '/thread').status_code, 404)
        self.assertEqual(self.c['bob@x.com'].delete(self.base + '/collaborators/eve@x.com').status_code, 200)

    def test_comments_are_deleted_with_the_submission(self):
        self.post('bob@x.com', self.base + '/comments', {'body': 'note'})
        self.sub.delete()
        self.assertFalse(SubmissionComment.objects.exists())
