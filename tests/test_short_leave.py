"""Short leave / permission (api/attendance_ext/short_leave.py) and its
My Team inbox type."""
from datetime import time, timedelta

from api.attendance_ext import penalties as pen
from api.models import AttendancePenalty, Notification, ShortLeaveRequest

from .test_attendance_policy import Base, D, at, dt

NOW = dt(D, 8, 0)
URL = '/api/attendance/short-leave'


class ShortLeaveTests(Base):
    def ask(self, who='emp@x.com', when=NOW, **body):
        payload = {'date': D.isoformat(), 'kind': 'early_out', 'fromTime': '16:00', 'toTime': '18:00',
                   'reason': 'Doctor appointment'}
        payload.update(body)
        with at(when):
            return self.post(who, URL, **payload)

    def decide(self, who, pk, action='approve', when=NOW):
        with at(when):
            return self.post(who, f'{URL}/{pk}/decide', action=action, reviewerNote='ok')

    def test_request_routes_to_the_manager(self):
        r = self.ask()
        self.assertEqual(r.status_code, 201, r.content)
        s = ShortLeaveRequest.objects.get(pk=r.json()['id'])
        self.assertEqual((s.status, s.minutes, s.approver_email, s.kind), ('Pending', 120, 'boss@x.com', 'early_out'))
        self.assertTrue(Notification.objects.filter(recipient='boss@x.com', title='Short leave to approve').exists())
        with at(NOW):
            mine = self.c['emp@x.com'].get(URL).json()
            q = self.c['boss@x.com'].get(URL + '/queue').json()
        self.assertEqual((mine['quota']['used'], mine['quota']['limit'], mine['quota']['maxMinutes']), (1, 2, 120))
        self.assertEqual([x['id'] for x in q], [s.id])

    def test_limits(self):
        self.assertEqual(self.ask(toTime='18:30').status_code, 400)                  # 150 > 120 minutes
        self.assertEqual(self.ask(reason='').status_code, 400)
        self.assertEqual(self.ask(kind='bogus').status_code, 400)
        self.assertEqual(self.ask(email='boss@x.com').status_code, 403)              # own only
        self.assertEqual(self.ask().status_code, 201)
        self.assertEqual(self.ask().status_code, 400)                                # same day + kind
        r = self.ask(date=(D + timedelta(days=1)).isoformat(), kind='late_in', fromTime='', toTime='10:00')
        self.assertEqual((r.status_code, r.json()['fromTime'], r.json()['minutes']), (201, '09:00', 60))  # from = shift start
        r = self.ask(date=(D + timedelta(days=2)).isoformat())
        self.assertEqual(r.status_code, 409)                                         # 2 per month
        self.assertIn('all 2 short leaves', r.json()['message'])
        ShortLeaveRequest.objects.filter(kind='late_in').update(status='Rejected')    # rejected do not count
        self.assertEqual(self.ask(date=(D + timedelta(days=2)).isoformat()).status_code, 201)

    def test_profile_limits_apply(self):
        self.profile('Strict', is_default=True, short_leaves_per_month=0)
        r = self.ask()
        self.assertEqual(r.status_code, 403)
        self.assertIn('not available', r.json()['message'])

    def test_no_self_approval_and_only_the_manager_or_hr(self):
        pk = self.ask().json()['id']
        self.assertEqual(self.decide('emp@x.com', pk).status_code, 403)
        self.assertEqual(self.decide('other@x.com', pk).status_code, 403)
        own = self.ask(who='hr@x.com').json()['id']
        r = self.decide('hr@x.com', own)
        self.assertEqual((r.status_code, r.json().get('code')), (403, 'SELF_APPROVAL'))
        self.assertEqual(self.decide('hr@x.com', pk).status_code, 200)                # attendance.regularize.approve
        self.assertEqual(self.decide('boss@x.com', pk).status_code, 409)              # already decided

    def test_approval_reclassifies_the_closed_day(self):
        self.work(D, (9, 0), (16, 0))                                       # 7h -> half-day
        self.assertEqual(self.row().status, 'half-day')
        pk = self.ask(when=dt(D, 16, 5)).json()['id']
        r = self.decide('boss@x.com', pk, when=dt(D, 17, 0))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.row().status, 'present')
        self.assertTrue(Notification.objects.filter(recipient='emp@x.com', title='Short leave approved').exists())
        from api.models import AttendanceAuditLog
        self.assertTrue(AttendanceAuditLog.objects.filter(email='emp@x.com', date=D, source='short_leave',
                                                          field='status', new_value='present').exists())
        # cancelling the approved one puts the day back
        with at(dt(D, 17, 30)):
            self.assertEqual(self.post('emp@x.com', f'{URL}/{pk}/cancel').status_code, 200)
        self.assertEqual(self.row().status, 'half-day')

    def test_approved_late_in_removes_the_penalty(self):
        for i in range(4):
            self.closed_day(D + timedelta(days=i), (9, 40), (18, 30), status='late', late_minutes=40)
        pen.evaluate_month('emp@x.com', 2026, 11)
        self.assertEqual(AttendancePenalty.objects.count(), 1)
        day4 = D + timedelta(days=3)
        pk = self.ask(when=dt(day4, 20, 0), date=day4.isoformat(), kind='late_in', fromTime='09:00',
                      toTime='09:45').json()['id']
        self.assertEqual(self.decide('boss@x.com', pk, when=dt(day4, 21, 0)).status_code, 200)
        self.assertEqual(self.row(day4).status, 'present')
        self.assertFalse(AttendancePenalty.objects.exists())

    def test_my_team_inbox_lists_and_decides(self):
        pk = self.ask().json()['id']
        with at(NOW):
            inbox = self.c['boss@x.com'].get('/api/my-team/inbox').json()
        items = [i for i in inbox['items'] if i['type'] == 'short_leave']
        self.assertEqual([(i['id'], i['typeLabel'], i['minutes']) for i in items], [(pk, 'Short leave', 120)])
        self.assertIn('short_leave', [t['value'] for t in inbox['types']])
        self.assertEqual(inbox['byType']['short_leave'], 1)
        with at(NOW):
            r = self.post('emp@x.com', '/api/my-team/inbox/decide', type='short_leave', id=pk, action='approve')
            self.assertEqual(r.status_code, 403)                                      # own request
            r = self.post('boss@x.com', '/api/my-team/inbox/decide', type='short_leave', id=pk, action='approve')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(ShortLeaveRequest.objects.get(pk=pk).status, 'Approved')
        with at(NOW):
            r = self.post('boss@x.com', '/api/my-team/inbox/decide', type='short_leave', id=pk, action='reject')
        self.assertEqual(r.status_code, 409)
