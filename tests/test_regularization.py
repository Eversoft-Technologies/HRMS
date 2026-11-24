"""Regularization of flagged days (api/attendance_ext/regularization.py).

The employee files check-in and/or check-out times with a reason code; the
manager (or attendance.edit / HR) approves, which recalculates the day,
clears the flag, writes the event trail + audit log — and so removes a false
Loss of Pay from attendance_service / payroll without touching payroll code.
"""
from datetime import date, datetime, time, timedelta

from api.attendance_ext import missed_punch as mp
from api.models import (AttendanceAuditLog, AttendanceCorrection, AttendanceEvent, EmployeeAttendance,
                        Notification)
from api.services.attendance_service import AttendanceService

from .test_missed_punch import Base, D, at

NOW = datetime(2026, 11, 19, 10, 0)


class RegularizationTests(Base):
    def setUp(self):
        super().setUp()
        self.open_day()
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, 'missing_checkout')

    def file(self, who='emp@x.com', when=NOW, **body):
        payload = {'date': '2026-11-18', 'checkOut': '18:30', 'reasonCode': 'forgot_badge'}
        payload.update(body)
        with at(when):
            return self.c[who].post('/api/attendance/regularization', payload, content_type='application/json')

    def decide(self, who, pk, action='approve', note='', when=NOW + timedelta(hours=1), url='regularization'):
        with at(when):
            return self.c[who].post(f'/api/attendance/{url}/{pk}/decide', {'action': action, 'reviewerNote': note},
                                    content_type='application/json')

    # --- employee side -------------------------------------------------------
    def test_get_lists_flagged_days_with_deadline(self):
        with at(NOW):
            d = self.c['emp@x.com'].get('/api/attendance/regularization?email=emp@x.com').json()
        self.assertEqual(len(d['issues']), 1)
        i = d['issues'][0]
        self.assertEqual((i['date'], i['issue'], i['overdue']), ('2026-11-18', 'missing_checkout', False))
        self.assertEqual(i['regularizeBy'], '2026-11-21 00:05:00')
        self.assertEqual(i['secondsLeft'], int((datetime(2026, 11, 21, 0, 5) - NOW).total_seconds()))
        self.assertIn('client_meeting', [c['code'] for c in d['reasonCodes']])

    def test_employee_submits_and_it_routes_to_the_manager(self):
        r = self.file()
        self.assertEqual(r.status_code, 201, r.content)
        c = AttendanceCorrection.objects.get(pk=r.json()['id'])
        self.assertEqual((c.kind, c.status, c.reason_code, c.reviewer_email),
                         ('regularize', 'Pending', 'forgot_badge', 'boss@x.com'))
        self.assertEqual(c.requested_check_out, datetime(2026, 11, 18, 18, 30))
        self.assertIsNone(c.requested_check_in)
        self.assertFalse(r.json()['late'])
        self.assertTrue(Notification.objects.filter(recipient='boss@x.com', title='Regularization to approve').exists())
        # the manager sees it in the (shared) punch-ticket queue and in the regularization queue
        with at(NOW):
            q1 = self.c['boss@x.com'].get('/api/attendance/punch-ticket/pending')
            q2 = self.c['boss@x.com'].get('/api/attendance/regularization/queue')
        self.assertEqual(q1.status_code, 200, q1.content)
        self.assertEqual([x['id'] for x in q1.json()], [c.id])
        self.assertEqual([x['id'] for x in q2.json()], [c.id])
        # a second pending one for the same day is refused
        self.assertEqual(self.file().status_code, 400)

    def test_reason_code_rules(self):
        self.assertEqual(self.file(reasonCode='').status_code, 400)
        self.assertEqual(self.file(reasonCode='bogus').status_code, 400)
        self.assertEqual(self.file(reasonCode='other').status_code, 400)          # 'other' needs text
        self.assertEqual(self.file(reasonCode='other', reason='Power cut').status_code, 201)

    def test_invalid_times_are_refused(self):
        r = self.file(checkOut='08:30')                      # before the 09:00 check-in
        self.assertEqual(r.status_code, 400)
        self.assertIn('after the check-in', r.json()['message'])
        r = self.file(checkOut='2026-11-19 08:00')           # past the work day (midnight)
        self.assertEqual(r.status_code, 400)
        self.assertIn('within the work day', r.json()['message'])
        r = self.file(checkOut='25:99')
        self.assertEqual(r.status_code, 400)
        r = self.file(checkIn='19:00', checkOut='18:00')
        self.assertEqual(r.status_code, 400)
        r = self.file(checkOut='', checkIn='')
        self.assertEqual(r.status_code, 400)

    def test_future_time_is_refused(self):
        ShiftAssignment = __import__('api.models', fromlist=['ShiftAssignment']).ShiftAssignment
        ShiftAssignment.objects.filter(email='solo@x.com').update(shift=self.night)
        self.open_day(email='solo@x.com', start=time(18, 0), shift=self.night)
        EmployeeAttendance.objects.filter(email='solo@x.com').update(punch_issue='missing_checkout')
        r = self.file(who='solo@x.com', when=datetime(2026, 11, 19, 0, 30), checkOut='02:00')
        self.assertEqual(r.status_code, 400)
        self.assertIn('future', r.json()['message'])

    def test_day_in_progress_is_refused(self):
        self.open_day(day=date(2026, 11, 19))
        r = self.file(date='2026-11-19', checkOut='09:30')
        self.assertEqual(r.status_code, 400)
        self.assertIn('in progress', r.json()['message'])

    def test_only_own_attendance(self):
        r = self.file(who='solo@x.com', email='emp@x.com')
        self.assertEqual(r.status_code, 403)
        with at(NOW):
            self.assertEqual(self.c['solo@x.com'].get('/api/attendance/regularization?email=emp@x.com').status_code, 403)
            self.assertEqual(self.c['boss@x.com'].get('/api/attendance/regularization?email=emp@x.com').status_code, 200)

    def test_late_filing_is_allowed_but_marked_and_can_be_blocked(self):
        late_at = datetime(2026, 11, 21, 9, 0)
        r = self.file(when=late_at)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()['late'])
        self.assertTrue(Notification.objects.filter(title='Late regularization filed', recipient='hr@x.com').exists())
        AttendanceCorrection.objects.all().delete()
        mp.save_policy({'block_after_deadline': True})
        self.assertEqual(self.file(when=late_at).status_code, 403)

    # --- approval ------------------------------------------------------------
    def test_manager_approval_recalculates_and_clears(self):
        pk = self.file().json()['id']
        r = self.decide('boss@x.com', pk, note='ok')
        self.assertEqual(r.status_code, 200, r.content)
        att = self.row()
        self.assertEqual(att.check_out, datetime(2026, 11, 18, 18, 30))
        self.assertEqual(att.worked_minutes, 9 * 60 + 30)
        # Overtime is now a pending OvertimeRecord; overtime_minutes holds only approved (payable) OT.
        from api.models import OvertimeRecord
        self.assertEqual(OvertimeRecord.objects.get(email='emp@x.com', date=D).overtime_minutes, 30)
        self.assertEqual(att.overtime_minutes, 0)
        self.assertEqual(att.early_exit_minutes, 0)
        self.assertEqual((att.status, att.late_minutes), ('present', 0))
        self.assertEqual(att.punch_issue, '')
        self.assertEqual(AttendanceCorrection.objects.get(pk=pk).status, 'Approved')
        evs = list(AttendanceEvent.objects.filter(email='emp@x.com', date=D).values_list('event', 'at'))
        self.assertEqual(evs, [('check-in', datetime(2026, 11, 18, 9, 0)), ('check-out', datetime(2026, 11, 18, 18, 30))])
        audit = AttendanceAuditLog.objects.filter(email='emp@x.com', source='regularization')
        self.assertTrue(audit.filter(field='check_out', actor='boss@x.com').exists())
        self.assertTrue(audit.filter(field='worked_minutes').exists())
        self.assertTrue(Notification.objects.filter(recipient='emp@x.com', title='Regularization approved').exists())
        with at(NOW + timedelta(hours=2)):
            mp.detect()                                         # not re-flagged
        self.assertEqual(self.row().punch_issue, '')
        self.assertEqual(self.decide('boss@x.com', pk).status_code, 400)   # already decided

    def test_multi_session_day_counts_every_session(self):
        EmployeeAttendance.objects.all().delete()
        AttendanceEvent.objects.all().delete()
        cin = datetime(2026, 11, 18, 13, 0)
        EmployeeAttendance.objects.create(email='emp@x.com', date=D, check_in=cin,
                                          check_out=datetime(2026, 11, 18, 12, 0), worked_minutes=180,
                                          shift_id=self.day.id, status='present')
        for ev, h in (('check-in', 9), ('check-out', 12), ('check-in', 13)):
            AttendanceEvent.objects.create(email='emp@x.com', date=D, event=ev, at=datetime(2026, 11, 18, h, 0))
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        pk = self.file(checkOut='18:00').json()['id']
        self.assertEqual(self.decide('hr@x.com', pk).status_code, 200)
        self.assertEqual(self.row().worked_minutes, 3 * 60 + 5 * 60)

    def test_hr_can_approve_and_reject_with_note(self):
        pk = self.file().json()['id']
        r = self.decide('hr@x.com', pk, action='reject', note='Use the right time')
        self.assertEqual(r.status_code, 200, r.content)
        c = AttendanceCorrection.objects.get(pk=pk)
        self.assertEqual((c.status, c.reviewer, c.reviewer_note), ('Rejected', 'hr@x.com', 'Use the right time'))
        self.assertEqual(self.row().punch_issue, 'missing_checkout')       # still flagged
        self.assertTrue(Notification.objects.filter(recipient='emp@x.com', title='Regularization rejected').exists())
        pk2 = self.file(checkOut='18:00').json()['id']                     # can file again
        self.assertEqual(self.decide('hr@x.com', pk2, url='punch-ticket').status_code, 200)   # via the shared queue
        self.assertEqual(self.row().worked_minutes, 9 * 60)

    def test_self_approval_is_refused(self):
        pk = self.file().json()['id']
        self.assertEqual(self.decide('emp@x.com', pk).status_code, 403)
        self.assertEqual(self.decide('emp@x.com', pk, url='punch-ticket').status_code, 403)
        # even someone holding attendance.edit cannot decide their own
        self.open_day(email='hr@x.com')
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        pk2 = self.file(who='hr@x.com').json()['id']
        self.assertEqual(self.decide('hr@x.com', pk2).status_code, 403)
        with at(NOW):
            self.assertNotIn(pk2, [x['id'] for x in self.c['hr@x.com'].get('/api/attendance/regularization/queue').json()])
        self.assertEqual(AttendanceCorrection.objects.get(pk=pk2).status, 'Pending')

    def test_unrelated_employee_cannot_decide(self):
        pk = self.file().json()['id']
        self.assertEqual(self.decide('solo@x.com', pk).status_code, 403)
        with at(NOW):
            self.assertEqual(self.c['solo@x.com'].get('/api/attendance/regularization/queue').json(), [])
            self.assertEqual(self.c['solo@x.com'].get('/api/attendance/punch-ticket/pending').status_code, 403)

    def test_missing_checkin_day(self):
        EmployeeAttendance.objects.all().delete()
        AttendanceEvent.objects.all().delete()
        EmployeeAttendance.objects.create(email='emp@x.com', date=D, check_out=datetime(2026, 11, 18, 18, 0),
                                          shift_id=self.day.id, status='absent')
        AttendanceEvent.objects.create(email='emp@x.com', date=D, event='check-out', at=datetime(2026, 11, 18, 18, 0))
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        self.assertEqual(self.row().punch_issue, 'missing_checkin')
        self.assertEqual(self.file(checkOut='').status_code, 400)          # needs the check-in
        pk = self.file(checkOut='', checkIn='09:40').json()['id']
        self.assertEqual(self.decide('boss@x.com', pk).status_code, 200)
        att = self.row()
        self.assertEqual((att.status, att.late_minutes, att.worked_minutes), ('late', 40, 8 * 60 + 20))
        self.assertEqual(att.punch_issue, '')

    # --- payroll consequence --------------------------------------------------
    def test_approval_removes_false_loss_of_pay(self):
        absent = date(2026, 11, 17)
        EmployeeAttendance.objects.create(email='emp@x.com', date=absent, status='absent', shift_id=self.day.id)

        def lop():
            from api.services.payroll_service import PayrollService
            rows = [r for r in PayrollService.step_fetch_attendance(absent, absent) if r['email'] == 'emp@x.com']
            return rows[0]['lop_days']

        s = AttendanceService.get_attendance_summary('emp@x.com', absent, absent)
        self.assertEqual((s['absent'], s['present']), (1, 0))
        self.assertEqual(lop(), 1.0)

        r = self.file(date='2026-11-17', checkIn='09:05', checkOut='18:00', reasonCode='system_issue')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.decide('boss@x.com', r.json()['id']).status_code, 200)

        att = EmployeeAttendance.objects.get(email='emp@x.com', date=absent)
        self.assertEqual((att.status, att.worked_minutes), ('present', 8 * 60 + 55))
        s = AttendanceService.get_attendance_summary('emp@x.com', absent, absent)
        self.assertEqual((s['absent'], s['present']), (0, 1))
        self.assertEqual(lop(), 0.0)
