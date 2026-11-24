"""Merged attendance / leave features work as one unit.

* Missed punch: the old forgot-punch ticket (/api/attendance/punch-ticket),
  the old Leave-page clock-out correction (kind '') and the regularization
  are ONE feature — same record, one monthly limit (policy monthly_limit,
  every kind, rejected excluded), the same deadline / late flag, reason code
  required, proof optional, one queue and one approval / recalculation path.
* Leave ledger: /api/leave/ledger lists the leave requests the balance's
  "used" / "pending" are made of, so the balance card can expand into them.
* Holidays: /api/holidays no longer appends " (optional)" to names; ?meta=1
  wraps the list with the calendar the caller is on (and, for settings.view,
  the calendars to switch to).
"""
from datetime import date, datetime, time, timedelta

from api.attendance_ext import missed_punch as mp
from api.models import (AttendanceAuditLog, AttendanceCorrection, AttendanceEvent, EmployeeAttendance,
                        HolidayCalendarAssignment, HolidayCalendarDay, LeaveRequest)

from .test_holiday_calendars import Base as HolidayBase, client as hclient, HYD, PUN
from .test_leave_accrual import Base as LeaveBase, EMP
from .test_missed_punch import Base, D, at

NOW = datetime(2026, 11, 19, 10, 0)


class UnifiedMissedPunchTests(Base):
    def reg(self, day, who='emp@x.com', when=NOW, **body):
        payload = {'date': day.isoformat(), 'checkOut': '18:00', 'reasonCode': 'forgot_badge'}
        payload.update(body)
        with at(when):
            return self.c[who].post('/api/attendance/regularization', payload, content_type='application/json')

    def ticket(self, day, kind='forgot_checkout', who='emp@x.com', when=NOW, **body):
        payload = {'email': who, 'date': day.isoformat(), 'kind': kind, 'reasonCode': 'network_issue'}
        payload.update(body)
        with at(when):
            return self.c[who].post('/api/attendance/punch-ticket', payload, content_type='application/json')

    def decide(self, pk, who='boss@x.com', action='approve', url='regularization', when=NOW + timedelta(hours=1)):
        with at(when):
            return self.c[who].post(f'/api/attendance/{url}/{pk}/decide', {'action': action},
                                    content_type='application/json')

    # --- one record, one limit -------------------------------------------------
    def test_old_ticket_is_filed_as_a_regularization_without_proof(self):
        self.open_day()
        r = self.ticket(D)
        self.assertEqual(r.status_code, 200, r.content)
        c = AttendanceCorrection.objects.get(pk=r.json()['id'])
        self.assertEqual((c.kind, c.status, c.reason_code, c.reviewer_email),
                         ('regularize', 'Pending', 'network_issue', 'boss@x.com'))
        self.assertEqual(c.requested_check_out, datetime(2026, 11, 18, 18, 0))     # the shift end
        self.assertFalse(c.proof_image)                                          # proof is optional now
        # reason code is required on this entry point too
        AttendanceCorrection.objects.all().delete()
        self.assertEqual(self.ticket(D, reasonCode='').status_code, 400)

    def test_one_monthly_limit_counts_every_kind(self):
        for d in (16, 17, 18, 13):
            self.open_day(day=date(2026, 11, d))
        self.assertEqual(self.reg(date(2026, 11, 16)).status_code, 201)
        self.assertEqual(self.ticket(date(2026, 11, 17)).status_code, 200)       # old entry point
        AttendanceCorrection.objects.create(email='emp@x.com', attendance_date=date(2026, 11, 18),
                                            requested_check_out=datetime(2026, 11, 18, 18, 0),
                                            status='Approved')                    # old Leave-page correction
        with at(NOW):
            d = self.c['emp@x.com'].get('/api/attendance/regularization?email=emp@x.com').json()
        self.assertEqual(d['quota'], {'used': 3, 'limit': 3, 'remaining': 0, 'month': 'November 2026'})
        self.assertEqual({r['kind'] for r in d['requests']}, {'regularize', ''})  # one history
        r = self.reg(date(2026, 11, 13))
        self.assertEqual(r.status_code, 403)
        self.assertIn('3 missed-punch requests', r.json()['message'])
        self.assertEqual(self.ticket(date(2026, 11, 13)).status_code, 403)       # same limit on the old entry
        with at(NOW):
            legacy = self.c['emp@x.com'].get('/api/attendance/punch-ticket?email=emp@x.com').json()
        self.assertEqual((legacy['usedThisMonth'], legacy['limit'], legacy['remaining']), (3, 3, 0))
        # a rejected request frees its slot
        first = AttendanceCorrection.objects.filter(attendance_date=date(2026, 11, 16)).first()
        self.assertEqual(self.decide(first.id, action='reject').status_code, 200)
        self.assertEqual(self.reg(date(2026, 11, 13)).status_code, 201)
        # configurable; 0 = no limit
        mp.save_policy({'monthly_limit': 0})
        self.open_day(day=date(2026, 11, 12))
        self.assertEqual(self.reg(date(2026, 11, 12)).status_code, 201)

    def test_limit_is_per_attendance_month(self):
        mp.save_policy({'monthly_limit': 1})
        self.open_day(day=date(2026, 10, 30))
        self.open_day(day=date(2026, 11, 2))
        self.assertEqual(self.reg(date(2026, 10, 30)).status_code, 201)
        self.assertEqual(self.reg(date(2026, 11, 2)).status_code, 201)            # another month

    def test_one_pending_request_per_day_across_entry_points(self):
        self.open_day()
        self.assertEqual(self.ticket(D).status_code, 200)
        r = self.reg(D)
        self.assertEqual(r.status_code, 400)
        self.assertIn('pending request', r.json()['message'])

    def test_deadline_and_late_flag_apply_to_the_old_entry_point(self):
        self.open_day()
        with at(datetime(2026, 11, 19, 0, 5)):
            mp.detect()
        r = self.ticket(D, when=datetime(2026, 11, 21, 9, 0))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['late'])
        AttendanceCorrection.objects.all().delete()
        mp.save_policy({'block_after_deadline': True})
        self.assertEqual(self.ticket(D, when=datetime(2026, 11, 21, 9, 0)).status_code, 403)

    def test_today_can_be_regularized_after_the_shift_ends(self):
        today = date(2026, 11, 19)
        self.open_day(day=today)
        self.assertEqual(self.reg(today, checkOut='09:30').status_code, 400)       # 10:00, shift until 18:00
        r = self.reg(today, when=datetime(2026, 11, 19, 21, 0))
        self.assertEqual(r.status_code, 201, r.content)

    # --- one queue, one approval / recalculation path ----------------------------
    def test_every_kind_is_in_one_queue_and_recalculated_the_same_way(self):
        days = [date(2026, 11, 16), date(2026, 11, 17), date(2026, 11, 18)]
        for d in days:
            self.open_day(day=d)
        reg = AttendanceCorrection.objects.get(pk=self.reg(days[0]).json()['id'])
        legacy = AttendanceCorrection.objects.create(email='emp@x.com', employee_name='Emp',
                                                     attendance_date=days[1], kind='forgot_checkout',
                                                     reason_code='other', reason='Forgot', status='Pending')
        corr = AttendanceCorrection.objects.create(email='emp@x.com', employee_name='Emp',
                                                   attendance_date=days[2], reviewer_email='boss@x.com',
                                                   requested_check_out=datetime(2026, 11, 18, 18, 0),
                                                   reason='Left at six', status='Pending')
        with at(NOW):
            q1 = {x['id'] for x in self.c['boss@x.com'].get('/api/attendance/punch-ticket/pending').json()}
            q2 = {x['id'] for x in self.c['boss@x.com'].get('/api/attendance/regularization/queue').json()}
        self.assertEqual(q1, {reg.id, legacy.id, corr.id})
        self.assertEqual(q1, q2)
        self.assertEqual(self.decide(reg.id).status_code, 200)
        self.assertEqual(self.decide(legacy.id, url='punch-ticket').status_code, 200)
        self.assertEqual(self.decide(corr.id).status_code, 200)
        rows = [self.row(day=d) for d in days]
        for a in rows:
            self.assertEqual(a.check_out.time(), time(18, 0))
            self.assertEqual(a.punch_issue, '')
        self.assertEqual({(a.worked_minutes, a.status, a.late_minutes) for a in rows},
                         {(rows[0].worked_minutes, rows[0].status, rows[0].late_minutes)})
        self.assertGreater(rows[0].worked_minutes, 0)
        # the trail got a check-out event on every day (same code path)
        for d in days:
            self.assertTrue(AttendanceEvent.objects.filter(email='emp@x.com', date=d, event='check-out').exists())
        legacy.refresh_from_db()
        self.assertEqual(legacy.requested_check_out, datetime(2026, 11, 17, 18, 0))  # the times it implied
        src = dict(AttendanceAuditLog.objects.filter(field='check_out').values_list('attendance_id', 'source'))
        self.assertEqual([src[a.id] for a in rows], ['regularization', 'punch_ticket', 'correction'])

    def test_legacy_checkin_ticket_sets_the_shift_start(self):
        att = self.open_day(start=time(10, 30), check_out=datetime(2026, 11, 18, 18, 0))
        t = AttendanceCorrection.objects.create(email='emp@x.com', attendance_date=D, kind='forgot_checkin',
                                                reason_code='other', reason='Was in early', status='Pending')
        self.assertEqual(self.decide(t.id).status_code, 200)
        att.refresh_from_db()
        self.assertEqual((att.check_in.time(), att.status, att.late_minutes), (time(9, 0), 'present', 0))

    def test_proof_visible_to_the_deciding_manager(self):
        self.open_day()
        c = AttendanceCorrection.objects.get(pk=self.reg(D, proofImage='data:image/png;base64,AAAA').json()['id'])
        with at(NOW):
            self.assertEqual(self.c['boss@x.com'].get(f'/api/attendance/punch-ticket/{c.id}/proof').status_code, 200)
            self.assertEqual(self.c['emp@x.com'].get(f'/api/attendance/punch-ticket/{c.id}/proof').status_code, 200)
            self.assertEqual(self.c['solo@x.com'].get(f'/api/attendance/punch-ticket/{c.id}/proof').status_code, 403)


class LedgerLeavesTests(LeaveBase):
    def test_ledger_lists_the_leave_behind_used_and_pending(self):
        self.policy([{'name': 'Casual Leave', 'days': 12}])
        self.leave('Casual Leave', date(2026, 3, 2), date(2026, 3, 3), 2)
        self.leave('Casual Leave', date(2026, 12, 7), date(2026, 12, 7), 1, status='Pending')
        self.leave('Casual Leave', date(2026, 5, 4), date(2026, 5, 4), 1, status='Rejected')
        d = self.emp.get('/api/leave/ledger?email=' + EMP).json()
        self.assertEqual([(x['fromDate'], x['status'], x['days']) for x in d['leaves']],
                         [('2026-03-02', 'Approved', 2), ('2026-12-07', 'Pending', 1)])
        bal = {b['type']: b for b in d['balances']}['Casual Leave']
        self.assertEqual((bal['used'], bal['pending']), (2, 1))
        # the balance card and the ledger read the same numbers
        self.assertEqual(self.balances()['Casual Leave']['remaining'], bal['remaining'])


class HolidayMetaTests(HolidayBase):
    def test_optional_holidays_keep_their_name_and_meta_names_the_calendar(self):
        self.calendars()
        HolidayCalendarDay.objects.create(calendar=self.india, date=date(2026, 3, 20), name='Ugadi', optional=True)
        lst = hclient(PUN).get('/api/holidays?year=2026').json()
        ugadi = [h for h in lst if h['date'] == '2026-03-20'][0]
        self.assertEqual((ugadi['name'], ugadi['optional']), ('Ugadi', True))     # no " (optional)" suffix
        m = hclient(PUN).get('/api/holidays?year=2026&meta=1').json()
        self.assertEqual((m['calendar']['name'], m['calendar']['how']), ('India', 'default'))
        self.assertFalse(m['canManage'])
        self.assertEqual(m['calendars'], [])
        self.assertTrue(any(h['name'] == 'Ugadi' for h in m['holidays']))
        # an admin sees the calendars and can switch to another one
        HolidayCalendarAssignment.objects.create(email='viewer@co.com', calendar=self.us)
        v = hclient('viewer@co.com').get('/api/holidays?year=2026&meta=1').json()
        self.assertTrue(v['canManage'])
        self.assertEqual({c['name'] for c in v['calendars']}, {'India', 'United States', 'Hyderabad Hub'})
        self.assertEqual(v['own']['name'], 'United States')
        h = hclient('viewer@co.com').get(f'/api/holidays?year=2026&meta=1&calendar={self.hydcal.id}').json()
        self.assertEqual(h['calendar']['name'], 'Hyderabad Hub')
        self.assertEqual(h['own']['name'], 'United States')
        self.assertIn('Bonalu', [x['name'] for x in h['holidays']])
        # an employee may not peek at another calendar
        self.assertEqual(hclient(HYD).get(f'/api/holidays?year=2026&calendar={self.us.id}').status_code, 403)
