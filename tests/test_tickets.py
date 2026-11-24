"""Help Desk tickets (api/tickets.py): raising, visibility, SLA, workflow,
conversation, notifications and the meta endpoint."""
from datetime import timedelta

from django.test import Client, TestCase

from api.models import AppUser, Notification, Permission, Role, RolePermission, Ticket, TicketComment
from api.timeutil import local_now


class TicketTests(TestCase):
    def setUp(self):
        perm, _ = Permission.objects.get_or_create(code='ticket.manage', defaults={'name': 'Manage tickets'})
        agent_role, _ = Role.objects.get_or_create(name='IT Admin')
        RolePermission.objects.get_or_create(role=agent_role, permission=perm)
        emp_role, _ = Role.objects.get_or_create(name='Employee')
        AppUser.objects.create(email='agent@co.com', full_name='Alice Agent', password='x', role='employee',
                               role_ref=agent_role)
        AppUser.objects.create(email='agent2@co.com', full_name='Bob Agent', password='x', role='employee',
                               role_ref=agent_role)
        AppUser.objects.create(email='emp@co.com', full_name='Eve Employee', password='x', role='employee',
                               role_ref=emp_role)
        AppUser.objects.create(email='other@co.com', full_name='Olly Other', password='x', role='employee',
                               role_ref=emp_role)
        self.agent = Client(HTTP_X_USER_EMAIL='agent@co.com')
        self.agent2 = Client(HTTP_X_USER_EMAIL='agent2@co.com')
        self.emp = Client(HTTP_X_USER_EMAIL='emp@co.com')
        self.other = Client(HTTP_X_USER_EMAIL='other@co.com')

    # -- helpers ------------------------------------------------------------
    def raise_ticket(self, client=None, **kw):
        body = {'category': 'IT', 'priority': 'Medium', 'subject': 'Laptop broken', 'description': 'Screen dead'}
        body.update(kw)
        r = (client or self.emp).post('/api/tickets', body, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def patch(self, client, tid, body):
        return client.patch('/api/tickets/%d' % tid, body, content_type='application/json')

    def comment(self, client, tid, body, internal=False):
        return client.post('/api/tickets/%d/comments' % tid, {'body': body, 'internal': internal},
                           content_type='application/json')

    # -- tests --------------------------------------------------------------
    def test_requires_identity(self):
        c = Client()
        self.assertEqual(c.get('/api/tickets').status_code, 401)
        self.assertEqual(c.get('/api/tickets/meta').json()['code'], 'AUTH_REQUIRED')
        self.assertEqual(Client(HTTP_X_USER_EMAIL='ghost@co.com').post(
            '/api/tickets', {'category': 'IT', 'subject': 'x'}, content_type='application/json').status_code, 401)

    def test_create_sets_code_sla_and_event(self):
        for pri, hours in (('Urgent', 4), ('High', 8), ('Medium', 24), ('Low', 72)):
            d = self.raise_ticket(priority=pri)
            t = Ticket.objects.get(pk=d['id'])
            self.assertEqual(d['code'], 'TK-%05d' % t.id)
            self.assertEqual(t.sla_hours, hours)
            self.assertEqual(t.sla_due_at, t.created_at + timedelta(hours=hours))
            self.assertEqual(d['requesterName'], 'Eve Employee')
            self.assertEqual(d['status'], 'Open')
            self.assertEqual(d['sla']['state'], 'on_track')
            self.assertEqual([c['body'] for c in d['comments']], ['Ticket raised'])

    def test_create_validation(self):
        bad = [{'category': 'Nope', 'subject': 'x'}, {'category': 'IT', 'priority': 'Huge', 'subject': 'x'},
               {'category': 'IT', 'subject': ''}, {'category': 'IT', 'subject': 'x' * 256}]
        for body in bad:
            r = self.emp.post('/api/tickets', body, content_type='application/json')
            self.assertEqual(r.status_code, 400, body)

    def test_visibility(self):
        mine = self.raise_ticket()
        theirs = self.raise_ticket(self.other, subject='Payslip wrong', category='Payroll')
        r = self.emp.get('/api/tickets?scope=all').json()
        self.assertEqual([t['id'] for t in r['tickets']], [mine['id']])
        self.assertEqual(self.emp.get('/api/tickets/%d' % theirs['id']).status_code, 404)
        r = self.agent.get('/api/tickets').json()
        self.assertEqual({t['id'] for t in r['tickets']}, {mine['id'], theirs['id']})
        # filters
        self.assertEqual(self.agent.get('/api/tickets?category=Payroll').json()['total'], 1)
        self.assertEqual(self.agent.get('/api/tickets?q=payslip').json()['tickets'][0]['id'], theirs['id'])
        self.assertEqual(self.agent.get('/api/tickets?q=' + mine['code']).json()['total'], 1)
        self.assertEqual(self.agent.get('/api/tickets?priority=Urgent').json()['total'], 0)
        # assignee (non-requester) sees the ticket too
        self.patch(self.agent, theirs['id'], {'assigneeEmail': 'agent2@co.com'})
        self.assertEqual(self.agent.get('/api/tickets?scope=assigned').json()['total'], 0)
        self.assertEqual(self.agent2.get('/api/tickets?scope=assigned').json()['total'], 1)

    def test_status_workflow_and_reopen(self):
        d = self.raise_ticket()
        tid = d['id']
        r = self.patch(self.agent, tid, {'status': 'In Progress'})
        self.assertEqual(r.status_code, 200)
        r = self.patch(self.agent, tid, {'status': 'Resolved'}).json()
        self.assertIsNotNone(r['resolvedAt'])
        self.assertIsNone(r['closedAt'])
        self.assertEqual(r['sla']['state'], 'met')
        self.assertTrue(r['permissions']['canReopen'] is False)   # agent view: not the requester
        # requester reopens
        r = self.patch(self.emp, tid, {'status': 'Open'})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()['resolvedAt'])
        # requester closes
        r = self.patch(self.emp, tid, {'status': 'Closed'}).json()
        self.assertIsNotNone(r['closedAt'])
        self.assertIsNotNone(r['resolvedAt'])
        events = [c['body'] for c in r['comments'] if c['kind'] == 'event']
        self.assertIn('Status: Open → In Progress', events)
        self.assertIn('Status: Resolved → Open', events)
        self.assertIn('Status: Open → Closed', events)
        # reopen window expired
        Ticket.objects.filter(pk=tid).update(closed_at=local_now() - timedelta(days=8),
                                             resolved_at=local_now() - timedelta(days=8))
        self.assertEqual(self.patch(self.emp, tid, {'status': 'Open'}).status_code, 403)

    def test_requester_limits(self):
        tid = self.raise_ticket()['id']
        self.assertEqual(self.patch(self.emp, tid, {'assigneeEmail': 'agent@co.com'}).status_code, 403)
        self.assertEqual(self.patch(self.emp, tid, {'priority': 'Urgent'}).status_code, 403)
        self.assertEqual(self.patch(self.emp, tid, {'status': 'Resolved'}).status_code, 403)
        self.assertEqual(self.patch(self.emp, tid, {'status': 'Open'}).status_code, 403)   # not resolved yet
        # agents: assignee must be an agent
        self.assertEqual(self.patch(self.agent, tid, {'assigneeEmail': 'other@co.com'}).status_code, 400)

    def test_priority_change_recomputes_sla(self):
        tid = self.raise_ticket(priority='Low')['id']
        r = self.patch(self.agent, tid, {'priority': 'High', 'category': 'HR'}).json()
        t = Ticket.objects.get(pk=tid)
        self.assertEqual(t.sla_hours, 8)
        self.assertEqual(t.sla_due_at, t.created_at + timedelta(hours=8))
        bodies = [c['body'] for c in r['comments']]
        self.assertIn('Priority: Low → High', bodies)
        self.assertIn('Category: IT → HR', bodies)

    def test_internal_notes_hidden_from_requester(self):
        tid = self.raise_ticket()['id']
        self.assertEqual(self.comment(self.emp, tid, 'sneaky', internal=True).status_code, 403)
        self.assertEqual(self.comment(self.agent, tid, 'agent-only note', internal=True).status_code, 201)
        emp_view = self.emp.get('/api/tickets/%d' % tid).json()
        self.assertNotIn('agent-only note', [c['body'] for c in emp_view['comments']])
        agent_view = self.agent.get('/api/tickets/%d' % tid).json()
        self.assertIn('agent-only note', [c['body'] for c in agent_view['comments']])
        # an internal note is not a first response
        self.assertIsNone(agent_view['firstResponseAt'])
        self.assertEqual(self.comment(self.other, tid, 'hi').status_code, 404)

    def test_first_response_stamped_once(self):
        tid = self.raise_ticket()['id']
        self.comment(self.emp, tid, 'any update?')
        self.assertIsNone(Ticket.objects.get(pk=tid).first_response_at)
        self.comment(self.agent, tid, 'Looking into it')
        first = Ticket.objects.get(pk=tid).first_response_at
        self.assertIsNotNone(first)
        Ticket.objects.filter(pk=tid).update(first_response_at=first - timedelta(minutes=5))
        self.comment(self.agent2, tid, 'Second reply')
        self.assertEqual(Ticket.objects.get(pk=tid).first_response_at, first - timedelta(minutes=5))

    def test_requester_reply_resumes_waiting(self):
        tid = self.raise_ticket()['id']
        self.patch(self.agent, tid, {'status': 'Waiting'})
        self.assertEqual(self.agent.get('/api/tickets/%d' % tid).json()['sla']['state'], 'paused')
        self.comment(self.emp, tid, 'Here is the info')
        self.assertEqual(Ticket.objects.get(pk=tid).status, 'In Progress')

    def test_overdue_and_breached(self):
        late = self.raise_ticket(subject='late')['id']
        self.raise_ticket(subject='fine')
        Ticket.objects.filter(pk=late).update(sla_due_at=local_now() - timedelta(hours=2))
        r = self.agent.get('/api/tickets?overdue=1').json()
        self.assertEqual([t['id'] for t in r['tickets']], [late])
        self.assertEqual(r['tickets'][0]['sla']['state'], 'breached')
        self.assertLess(r['tickets'][0]['sla']['minutesLeft'], -100)
        # resolved after due -> still breached
        r = self.patch(self.agent, late, {'status': 'Resolved'}).json()
        self.assertEqual(r['sla']['state'], 'breached')
        self.assertEqual(self.agent.get('/api/tickets?overdue=1').json()['total'], 0)
        # due soon: under 25% of the window left
        soon = self.raise_ticket(subject='soon', priority='Urgent')['id']
        Ticket.objects.filter(pk=soon).update(sla_due_at=local_now() + timedelta(minutes=30))
        self.assertEqual(self.agent.get('/api/tickets/%d' % soon).json()['sla']['state'], 'due_soon')

    def test_notifications(self):
        tid = self.raise_ticket()['id']
        # unassigned: every agent hears about the new ticket
        self.assertEqual(Notification.objects.filter(recipient='agent@co.com', link='/tickets/%d' % tid).count(), 1)
        self.assertEqual(Notification.objects.filter(recipient='agent2@co.com').count(), 1)
        self.assertEqual(Notification.objects.filter(recipient='emp@co.com').count(), 0)
        self.patch(self.agent, tid, {'assigneeEmail': 'agent2@co.com'})
        self.assertEqual(Notification.objects.filter(recipient='agent2@co.com', title__contains='assigned').count(), 1)
        self.patch(self.agent2, tid, {'status': 'In Progress'})
        self.assertEqual(Notification.objects.filter(recipient='emp@co.com').count(), 1)
        self.comment(self.agent2, tid, 'internal', internal=True)
        self.assertEqual(Notification.objects.filter(recipient='emp@co.com').count(), 1)
        self.comment(self.agent2, tid, 'public reply')
        self.assertEqual(Notification.objects.filter(recipient='emp@co.com').count(), 2)
        before_a1 = Notification.objects.filter(recipient='agent@co.com').count()
        self.comment(self.emp, tid, 'thanks')
        self.assertEqual(Notification.objects.filter(recipient='agent2@co.com', title__startswith='Reply').count(), 1)
        self.assertEqual(Notification.objects.filter(recipient='agent@co.com').count(), before_a1)  # assigned elsewhere

    def test_meta(self):
        a = self.raise_ticket()['id']
        b = self.raise_ticket(self.other)['id']
        self.patch(self.agent, b, {'assigneeEmail': 'agent@co.com'})
        Ticket.objects.filter(pk=a).update(sla_due_at=local_now() - timedelta(hours=1))
        m = self.agent.get('/api/tickets/meta').json()
        self.assertTrue(m['canManage'])
        self.assertEqual(m['slaHours']['Urgent'], 4)
        self.assertEqual({x['email'] for x in m['agents']}, {'agent@co.com', 'agent2@co.com'})
        self.assertEqual(m['counts'], {'open': 2, 'assignedToMe': 1, 'overdue': 1, 'mine': 0})
        e = self.emp.get('/api/tickets/meta').json()
        self.assertFalse(e['canManage'])
        self.assertEqual(e['agents'], [])
        self.assertEqual(e['counts'], {'open': 1, 'assignedToMe': 0, 'overdue': 1, 'mine': 1})
        self.assertIn('Payroll', e['categories'])

    def test_super_admin_is_agent(self):
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role='admin')
        tid = self.raise_ticket()['id']
        boss = Client(HTTP_X_USER_EMAIL='boss@co.com')
        self.assertEqual(boss.get('/api/tickets/%d' % tid).status_code, 200)
        self.assertEqual(self.patch(self.agent, tid, {'assigneeEmail': 'boss@co.com'}).status_code, 200)
        self.assertEqual(TicketComment.objects.filter(ticket_id=tid, body='Assigned to Boss').count(), 1)
