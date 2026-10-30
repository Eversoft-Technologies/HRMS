"""Managers and teams wired into tasks, submissions, leave, WFH, corrections
and overtime. Covers single- and multi-team employees, team changes on
existing tasks, missing managers, archived teams, and attempts to submit or
approve on someone else's behalf."""
from datetime import date

from django.test import Client, TestCase

from api.models import (AppUser, AttendanceCorrection, EmployeeTask, LeaveRequest, Permission, Role,
                        RolePermission, Team, TeamMembership, UserProfile, WfhRequest, WorkSubmission)


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class RoutingBase(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@x.com', full_name='Admin', password='x', role='admin')
        hr = Role.objects.create(name='HR Manager')
        grant(hr, 'employee.view', 'employee.edit', 'employee.create', 'leave.action', 'submission.view_all',
              'submission.action', 'attendance.view', 'attendance.create', 'task.edit', 'leave.view')
        AppUser.objects.create(email='hr@x.com', full_name='HR Person', password='x', role='hr', role_ref=hr)
        emp = Role.objects.create(name='Employee')
        grant(emp, 'employee.view', 'attendance.create')
        for email, first, last, mgr in (('anna@x.com', 'Anna', 'Lead', ''), ('bob@x.com', 'Bob', 'Dev', 'anna@x.com'),
                                        ('cara@x.com', 'Cara', 'Dev', 'anna@x.com'), ('dan@x.com', 'Dan', 'Ops', '')):
            AppUser.objects.create(email=email, full_name=f'{first} {last}', password='x', role='employee', role_ref=emp)
            UserProfile.objects.create(email=email, first_name=first, last_name=last, manager_email=mgr,
                                       manager=('Anna Lead' if mgr else ''))
        self.platform = Team.objects.create(name='Platform', lead_email='anna@x.com')
        self.infra = Team.objects.create(name='Infra', lead_email='dan@x.com')
        for t, e in ((self.platform, 'anna@x.com'), (self.platform, 'bob@x.com'), (self.platform, 'cara@x.com'),
                     (self.infra, 'dan@x.com'), (self.infra, 'cara@x.com')):
            TeamMembership.objects.create(team=t, email=e)
        self.c = {e: Client(HTTP_X_USER_EMAIL=e) for e in
                  ('admin@x.com', 'hr@x.com', 'anna@x.com', 'bob@x.com', 'cara@x.com', 'dan@x.com')}

    def post(self, who, url, body):
        return self.c[who].post(url, data=body, content_type='application/json')

    def put(self, who, url, body):
        return self.c[who].put(url, data=body, content_type='application/json')


class TaskRoutingTests(RoutingBase):
    def test_single_team_assignee_is_filed_automatically(self):
        r = self.post('hr@x.com', '/api/tasks', {'title': 'T1', 'assigneeEmail': 'bob@x.com', 'teamLead': ''})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()['teamName'], r.json()['teamLeadEmail']), ('Platform', 'anna@x.com'))

    def test_multi_team_assignee_needs_an_explicit_team(self):
        r = self.post('hr@x.com', '/api/tasks', {'title': 'T2', 'assigneeEmail': 'cara@x.com', 'teamLead': 'x'})
        self.assertEqual(r.status_code, 400)
        self.assertIn('several teams', r.json()['message'])
        r = self.post('hr@x.com', '/api/tasks', {'title': 'T2', 'assigneeEmail': 'cara@x.com', 'teamLead': '',
                                                 'teamId': self.infra.id})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['teamLeadEmail'], 'dan@x.com')
        self.assertEqual(r.json()['teamLead'], 'Dan Ops')

    def test_archived_team_is_refused(self):
        Team.objects.filter(pk=self.infra.id).update(status='archived')
        r = self.post('hr@x.com', '/api/tasks', {'title': 'T3', 'assigneeEmail': 'dan@x.com', 'teamLead': 'x',
                                                 'teamId': self.infra.id})
        self.assertEqual(r.status_code, 400)
        self.assertIn('archived', r.json()['message'])

    def test_editing_the_team_revalidates_assignee_and_refreshes_lead(self):
        tid = self.post('hr@x.com', '/api/tasks', {'title': 'T4', 'assigneeEmail': 'bob@x.com', 'teamLead': ''}).json()['id']
        r = self.put('hr@x.com', f'/api/tasks/{tid}', {'teamId': self.infra.id})          # bob is not in Infra
        self.assertEqual(r.status_code, 400)
        r = self.put('hr@x.com', f'/api/tasks/{tid}', {'teamId': self.infra.id, 'assigneeEmail': 'cara@x.com'})
        self.assertEqual(r.status_code, 200, r.content)
        t = EmployeeTask.objects.get(pk=tid)
        self.assertEqual((t.team_id, t.team_lead_email, t.team_lead), (self.infra.id, 'dan@x.com', 'Dan Ops'))
        r = self.put('hr@x.com', f'/api/tasks/{tid}', {'assigneeEmail': 'bob@x.com'})       # keeps Infra
        self.assertEqual(r.status_code, 400)
        self.assertIn('not a member', r.json()['message'])

    def test_assignee_picker_and_filters(self):
        r = self.c['hr@x.com'].get(f'/api/tasks/assignees?q=&teamId={self.infra.id}')
        self.assertEqual(r.json(), [])                                                      # q is required
        r = self.c['hr@x.com'].get(f'/api/tasks/assignees?q=c&teamId={self.infra.id}')
        self.assertEqual([x['email'] for x in r.json()], ['cara@x.com'])
        r = self.c['hr@x.com'].get(f'/api/tasks/assignees?q=b&teamId={self.infra.id}')
        self.assertEqual(r.json(), [])
        self.post('hr@x.com', '/api/tasks', {'title': 'P', 'assigneeEmail': 'bob@x.com', 'teamLead': ''})
        self.post('hr@x.com', '/api/tasks', {'title': 'I', 'assigneeEmail': 'dan@x.com', 'teamLead': ''})
        rows = self.c['hr@x.com'].get(f'/api/tasks?teamId={self.platform.id}').json()
        self.assertEqual([t['title'] for t in rows], ['P'])
        rows = self.c['hr@x.com'].get('/api/tasks?teamLeadEmail=dan@x.com').json()
        self.assertEqual([t['title'] for t in rows], ['I'])


class SubmissionRoutingTests(RoutingBase):
    def submit(self, who, **extra):
        body = {'title': 'Report', 'type': 'Document', 'email': who}   # the form always sends it
        body.update(extra)
        return self.post(who, '/api/submissions', body)

    def test_submitter_is_the_caller_and_lead_is_the_reviewer(self):
        r = self.submit('bob@x.com')
        self.assertEqual(r.status_code, 201, r.content)
        s = WorkSubmission.objects.get()
        self.assertEqual((s.email, s.team_id, s.reviewer_email), ('bob@x.com', self.platform.id, 'anna@x.com'))
        self.assertEqual(r.json()['teamName'], 'Platform')

    def test_cannot_submit_as_someone_else(self):
        self.assertEqual(self.submit('bob@x.com', email='cara@x.com').status_code, 403)
        self.assertEqual(self.submit('hr@x.com', email='bob@x.com').status_code, 201)       # HR on behalf

    def test_multi_team_submitter_must_choose_from_their_teams(self):
        self.assertIn('several teams', self.submit('cara@x.com').json()['message'])
        self.assertEqual(self.submit('cara@x.com', teamId=self.infra.id).status_code, 201)
        self.assertEqual(WorkSubmission.objects.get().reviewer_email, 'dan@x.com')
        self.assertEqual(self.submit('bob@x.com', teamId=self.infra.id).status_code, 400)  # not bob's team

    def test_reviewer_override_is_hr_only_and_must_be_eligible(self):
        self.assertEqual(self.submit('bob@x.com', reviewerEmail='hr@x.com').status_code, 403)
        self.assertEqual(self.submit('hr@x.com', email='bob@x.com', reviewerEmail='dan@x.com').status_code, 400)
        r = self.submit('hr@x.com', email='bob@x.com', reviewerEmail='hr@x.com')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['reviewerEmail'], 'hr@x.com')

    def test_lead_sees_routed_work_but_cannot_decide_it(self):
        sid = self.submit('bob@x.com').json()['id']
        seen = [s['id'] for s in self.c['anna@x.com'].get('/api/submissions').json()]
        self.assertIn(sid, seen)
        self.assertEqual(self.c['dan@x.com'].get('/api/submissions').json(), [])
        r = self.put('anna@x.com', f'/api/submissions/{sid}', {'status': 'Approved'})
        self.assertEqual(r.status_code, 403)                       # leading a team grants no submission.action
        rows = self.c['hr@x.com'].get(f'/api/submissions?teamId={self.platform.id}&reviewerEmail=anna@x.com').json()
        self.assertEqual([s['id'] for s in rows], [sid])


class LeaveRoutingTests(RoutingBase):
    def apply(self, who, **extra):
        body = {'email': who, 'type': 'Casual Leave', 'fromDate': '2026-11-02', 'toDate': '2026-11-02'}
        body.update(extra)
        return self.post(who, '/api/leave', body)

    def test_approver_is_the_linked_manager_not_the_employees_choice(self):
        r = self.apply('bob@x.com', approver='Dan Ops', approverEmail='dan@x.com')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()['approverEmail'], r.json()['approver']), ('anna@x.com', 'Anna Lead'))
        self.assertEqual(self.c['bob@x.com'].get('/api/org/approver').json()['manager']['email'], 'anna@x.com')

    def test_missing_manager_leaves_it_to_hr(self):
        r = self.apply('dan@x.com')
        self.assertEqual(r.json()['approverEmail'], '')
        self.assertIsNone(self.c['dan@x.com'].get('/api/org/approver').json()['manager'])

    def test_manager_lists_and_decides_reports_requests(self):
        lid = self.apply('bob@x.com').json()['id']
        mine = [x['id'] for x in self.c['anna@x.com'].get('/api/leave').json()]
        self.assertIn(lid, mine)
        self.assertEqual(self.c['dan@x.com'].get('/api/leave').json(), [])
        self.assertEqual(self.put('dan@x.com', f'/api/leave/{lid}', {'status': 'Approved'}).status_code, 403)
        self.assertEqual(self.put('bob@x.com', f'/api/leave/{lid}', {'status': 'Approved'}).status_code, 403)
        self.assertEqual(self.put('anna@x.com', f'/api/leave/{lid}', {'status': 'Approved'}).status_code, 200)

    def test_hr_override_routes_to_someone_else(self):
        lid = self.apply('bob@x.com').json()['id']
        self.assertEqual(self.post('anna@x.com', f'/api/leave/{lid}/approver', {'approverEmail': 'dan@x.com'}).status_code, 403)
        self.assertEqual(self.post('hr@x.com', f'/api/leave/{lid}/approver', {'approverEmail': 'bob@x.com'}).status_code, 400)
        r = self.post('hr@x.com', f'/api/leave/{lid}/approver', {'approverEmail': 'dan@x.com'})
        self.assertEqual(r.json()['approverEmail'], 'dan@x.com')
        self.assertEqual(self.put('dan@x.com', f'/api/leave/{lid}', {'status': 'Approved'}).status_code, 200)

    def test_team_filter_on_the_queue(self):
        self.apply('bob@x.com')
        self.apply('dan@x.com')
        rows = self.c['hr@x.com'].get(f'/api/leave?teamId={self.infra.id}').json()
        self.assertEqual({x['email'] for x in rows}, {'dan@x.com'})


class OtherWorkflowTests(RoutingBase):
    def test_wfh_routes_to_manager_who_can_decide(self):
        r = self.post('bob@x.com', '/api/attendance/wfh', {'email': 'bob@x.com', 'fromDate': '2026-11-03',
                                                            'toDate': '2026-11-03', 'reason': 'x'})
        self.assertEqual(r.status_code, 201, r.content)
        wid = r.json()['id']
        self.assertEqual(WfhRequest.objects.get(pk=wid).approver_email, 'anna@x.com')
        self.assertIn(wid, [x['id'] for x in self.c['anna@x.com'].get('/api/attendance/wfh').json()])
        self.assertEqual(self.put('dan@x.com', f'/api/attendance/wfh/{wid}', {'status': 'Approved'}).status_code, 403)
        self.assertEqual(self.put('bob@x.com', f'/api/attendance/wfh/{wid}', {'status': 'Approved'}).status_code, 403)
        self.assertEqual(self.put('anna@x.com', f'/api/attendance/wfh/{wid}', {'status': 'Approved'}).status_code, 200)

    def test_correction_routes_to_manager(self):
        r = self.post('bob@x.com', '/api/attendance/corrections', {
            'email': 'bob@x.com', 'kind': 'forgot_checkout', 'attendanceDate': '2026-10-28',
            'requestedCheckOut': '2026-10-28 18:00:00', 'reason': 'forgot'})
        self.assertEqual(r.status_code, 201, r.content)
        cid = r.json()['id']
        self.assertEqual(AttendanceCorrection.objects.get(pk=cid).reviewer_email, 'anna@x.com')
        self.assertEqual(self.put('dan@x.com', f'/api/attendance/corrections/{cid}', {'status': 'Rejected'}).status_code, 403)
        self.assertEqual(self.put('anna@x.com', f'/api/attendance/corrections/{cid}', {'status': 'Rejected'}).status_code, 200)

    def test_legacy_correction_and_overtime_actions_now_require_a_decider(self):
        c = AttendanceCorrection.objects.create(email='bob@x.com', attendance_date=date(2026, 10, 28),
                                                status='Pending', reviewer_email='anna@x.com')
        self.assertEqual(Client().post('/api/attendance/correction/reject/', data={'correctionId': c.id},
                                       content_type='application/json').status_code, 401)
        self.assertEqual(self.post('dan@x.com', '/api/attendance/correction/reject/', {'correctionId': c.id}).status_code, 403)
        self.assertEqual(self.post('dan@x.com', '/api/attendance/overtime/approve/',
                                   {'email': 'bob@x.com', 'date': '2026-10-28'}).status_code, 403)

    def test_unresolved_names_are_listed_for_hr(self):
        EmployeeTask.objects.create(title='Old', team_lead='Somebody Typed')
        rows = self.c['hr@x.com'].get('/api/org/unresolved').json()
        self.assertIn(('Task team lead', 'Somebody Typed'), [(r['kind'], r['name']) for r in rows])
        self.assertEqual(self.c['bob@x.com'].get('/api/org/unresolved').status_code, 403)

    def test_reviewer_picker_puts_the_lead_first(self):
        rows = self.c['hr@x.com'].get(f'/api/org/reviewers?teamId={self.infra.id}').json()
        self.assertEqual(rows[0]['email'], 'dan@x.com')
        self.assertTrue(rows[0]['isLead'])
        self.assertIn('hr@x.com', [r['email'] for r in rows])


class RoutingBackfillTests(RoutingBase):
    def test_pending_requests_route_to_manager_and_names_link_once(self):
        import importlib
        from django.apps import apps
        mig = importlib.import_module('api.migrations.0077_approval_routing')
        LeaveRequest.objects.create(email='bob@x.com', from_date=date(2026, 11, 2), to_date=date(2026, 11, 2))
        LeaveRequest.objects.create(email='dan@x.com', from_date=date(2026, 11, 2), to_date=date(2026, 11, 2),
                                    status='Approved', approver='HR Person')
        WorkSubmission.objects.create(email='bob@x.com', title='w', reviewer='Nobody Known')
        WorkSubmission.objects.create(email='bob@x.com', title='v', reviewer='anna lead')
        mig.backfill_identities(apps, None)
        got = dict(LeaveRequest.objects.values_list('email', 'approver_email'))
        self.assertEqual(got, {'bob@x.com': 'anna@x.com', 'dan@x.com': 'hr@x.com'})
        subs = dict(WorkSubmission.objects.values_list('title', 'reviewer_email'))
        self.assertEqual(subs, {'w': '', 'v': 'anna@x.com'})
