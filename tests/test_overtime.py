"""Overtime rules + comp-off (api/attendance_ext/overtime.py, Workstream O)."""
from datetime import date, datetime, time, timedelta
from io import StringIO

from django.core.management import call_command

from api.attendance_ext import overtime as ot
from api.models import (AttendancePolicyAssignment, AttendancePolicyProfile, EmployeeAttendance, HolidayCalendar,
                        HolidayCalendarDay, LeaveLedgerEntry, LeaveRequest, MasterDataSet, Notification,
                        OvertimeRecord)
from api.services.payroll_service import PayrollService

from .test_missed_punch import Base, at

MON = date(2026, 11, 16)          # Mon 16 … Sun 22 Nov 2026
WED = date(2026, 11, 18)
SAT = date(2026, 11, 21)


class OTBase(Base):
    def setUp(self):
        super().setUp()
        self.profile = AttendancePolicyProfile.objects.create(name='Std', is_default=True)

    def setp(self, **kw):
        AttendancePolicyProfile.objects.filter(pk=self.profile.pk).update(**kw)

    def close(self, day, worked, email='emp@x.com'):
        """A closed day with ``worked`` minutes, evaluated through the hook."""
        cin = datetime.combine(day, time(9, 0))
        att, _ = EmployeeAttendance.objects.update_or_create(
            email=email, date=day, defaults={'check_in': cin, 'check_out': cin + timedelta(minutes=worked),
                                             'worked_minutes': worked, 'shift_id': self.day.id,
                                             'status': 'present', 'employee_name': email.split('@')[0]})
        ot.on_day_closed(att)
        return OvertimeRecord.objects.filter(email=email, date=day).first()

    def att(self, day, email='emp@x.com'):
        return EmployeeAttendance.objects.get(email=email, date=day)

    def decide(self, who, pk, action='approve', **body):
        body['action'] = action
        return self.c[who].post(f'/api/attendance/overtime-records/{pk}/decide', body,
                                content_type='application/json')


class RuleTests(OTBase):
    def test_threshold_from_shift_when_policy_unset(self):
        rec = self.close(WED, 600)                      # shift: OT after 540
        self.assertEqual((rec.overtime_minutes, rec.day_type, rec.status), (60, 'working', 'Pending'))
        self.assertEqual(rec.approver_email, 'boss@x.com')
        self.assertIsNone(self.close(MON, 540))         # exactly the threshold: no record

    def test_threshold_from_policy_overrides_shift(self):
        self.setp(overtime_after_minutes=480)
        rec = self.close(WED, 600)
        self.assertEqual(rec.overtime_minutes, 120)

    def test_daily_cap(self):
        rec = self.close(WED, 540 + 300)                # 300 raw, cap 240
        self.assertEqual((rec.overtime_minutes, rec.capped_minutes), (240, 60))

    def test_weekly_cap_across_days(self):
        self.setp(overtime_weekly_cap_minutes=300)
        a = self.close(MON, 540 + 200)
        b = self.close(date(2026, 11, 17), 540 + 200)
        a.refresh_from_db()
        self.assertEqual((a.overtime_minutes, a.capped_minutes), (200, 0))
        self.assertEqual((b.overtime_minutes, b.capped_minutes), (100, 100))
        # Next week has its own budget
        c = self.close(date(2026, 11, 23), 540 + 200)
        self.assertEqual(c.overtime_minutes, 200)

    def test_weekend_and_holiday_count_the_whole_day(self):
        rec = self.close(SAT, 180)
        self.assertEqual((rec.day_type, rec.overtime_minutes), ('weekend', 180))
        cal = HolidayCalendar.objects.create(name='Hyd', country='IN', include_national=False, is_default=True)
        HolidayCalendarDay.objects.create(calendar=cal, date=WED, name='Festival')
        rec = self.close(WED, 120)
        self.assertEqual((rec.day_type, rec.overtime_minutes), ('holiday', 120))

    def test_auto_when_no_approval_needed(self):
        self.setp(overtime_requires_approval=False)
        rec = self.close(WED, 600)
        self.assertEqual((rec.status, rec.approved_minutes), ('Auto', 60))
        self.assertEqual(self.att(WED).overtime_minutes, 60)          # payable at once

    def test_reevaluation_is_idempotent_and_follows_pending(self):
        self.close(WED, 600)
        self.close(WED, 600)
        self.assertEqual(OvertimeRecord.objects.count(), 1)
        rec = self.close(WED, 630)
        self.assertEqual((rec.status, rec.overtime_minutes), ('Pending', 90))
        self.assertIsNone(self.close(WED, 500))                     # no overtime any more
        self.assertEqual(OvertimeRecord.objects.count(), 0)

    def test_approved_record_is_reopened_when_worked_time_changes(self):
        rec = self.close(WED, 600)
        self.assertEqual(self.decide('boss@x.com', rec.id).status_code, 200)
        self.close(WED, 600)                                        # same time: untouched
        rec.refresh_from_db()
        self.assertEqual((rec.status, rec.approved_minutes), ('Approved', 60))
        rec = self.close(WED, 660)
        self.assertEqual((rec.status, rec.approved_minutes, rec.overtime_minutes), ('Pending', 0, 120))
        self.assertIn(ot.REOPEN_MARK, rec.note)
        self.assertEqual(rec.decided_by, 'boss@x.com')                # previous decision kept
        self.assertEqual(self.att(WED).overtime_minutes, 0)
        self.assertTrue(Notification.objects.filter(recipient='boss@x.com', title='Overtime to re-approve').exists())


class ApprovalTests(OTBase):
    def test_pending_pays_nothing_then_manager_approves(self):
        rec = self.close(WED, 600)
        self.assertEqual(self.att(WED).overtime_minutes, 0)
        self.assertTrue(Notification.objects.filter(recipient='boss@x.com', title='Overtime to approve').exists())
        r = self.decide('boss@x.com', rec.id, note='ok')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['emailed'])
        self.assertEqual(self.att(WED).overtime_minutes, 60)
        self.assertTrue(Notification.objects.filter(recipient='emp@x.com', title='Overtime approved').exists())
        self.assertEqual(self.sent.call_args.kwargs['to'], 'emp@x.com')
        self.assertEqual(self.decide('boss@x.com', rec.id).status_code, 409)   # already decided

    def test_partial_approval(self):
        rec = self.close(WED, 540 + 200)
        self.assertEqual(self.decide('boss@x.com', rec.id, minutes=500).status_code, 400)   # over the capped value
        r = self.decide('hr@x.com', rec.id, minutes=90)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['record']['approvedMinutes'], 90)
        self.assertEqual(self.att(WED).overtime_minutes, 90)

    def test_reject_with_note(self):
        rec = self.close(WED, 600)
        r = self.decide('boss@x.com', rec.id, 'reject', note='Not pre-approved')
        self.assertEqual(r.status_code, 200, r.content)
        rec.refresh_from_db()
        self.assertEqual((rec.status, rec.note, rec.approved_minutes), ('Rejected', 'Not pre-approved', 0))
        self.assertEqual(self.att(WED).overtime_minutes, 0)

    def test_email_failure_is_reported(self):
        rec = self.close(WED, 600)
        self.sent.return_value = {'ok': False, 'error': 'smtp down'}
        r = self.decide('boss@x.com', rec.id)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()['emailed'])

    def test_no_self_approval_even_with_attendance_edit(self):
        rec = self.close(WED, 600, email='hr@x.com')
        r = self.decide('hr@x.com', rec.id)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()['code'], 'SELF_APPROVAL')

    def test_outsider_cannot_decide_or_list_all(self):
        rec = self.close(WED, 600)
        self.assertEqual(self.decide('solo@x.com', rec.id).status_code, 403)
        self.assertEqual(self.c['solo@x.com'].get('/api/attendance/overtime-records?scope=all').status_code, 403)
        self.assertEqual(self.c['solo@x.com'].get('/api/attendance/overtime-records?email=emp@x.com').status_code, 403)
        self.assertEqual(self.c['solo@x.com'].get('/api/attendance/overtime-records?scope=team').json()['count'], 0)

    def test_lists(self):
        rec = self.close(WED, 600)
        mine = self.c['emp@x.com'].get('/api/attendance/overtime-records').json()
        self.assertEqual([i['id'] for i in mine['items']], [rec.id])
        self.assertFalse(mine['items'][0]['canDecide'])
        team = self.c['boss@x.com'].get('/api/attendance/overtime-records?scope=team&status=Pending').json()
        self.assertEqual([(i['id'], i['canDecide']) for i in team['items']], [(rec.id, True)])
        allr = self.c['hr@x.com'].get('/api/attendance/overtime-records?scope=all&dayType=working&month=2026-11').json()
        self.assertEqual(allr['count'], 1)

    def test_batch_approve(self):
        a = self.close(MON, 600)
        b = self.close(WED, 600)
        own = self.close(WED, 600, email='boss@x.com')
        r = self.c['boss@x.com'].post('/api/attendance/overtime-records/batch',
                                      {'action': 'approve', 'ids': [a.id, b.id, own.id]},
                                      content_type='application/json').json()
        self.assertEqual((r['ok'], r['failed']), (2, 1))

    def test_my_team_inbox_lists_and_decides_overtime(self):
        rec = self.close(WED, 600)
        inbox = self.c['boss@x.com'].get('/api/my-team/inbox').json()
        items = [i for i in inbox['items'] if i['type'] == 'overtime']
        self.assertEqual([i['id'] for i in items], [rec.id])
        self.assertEqual(inbox['byType']['overtime'], 1)
        self.assertEqual(self.c['emp@x.com'].get('/api/my-team/inbox').json()['byType']['overtime'], 0)
        r = self.c['boss@x.com'].post('/api/my-team/inbox/decide', {'type': 'overtime', 'id': rec.id,
                                                                    'action': 'approve'},
                                      content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        rec.refresh_from_db()
        self.assertEqual(rec.status, 'Approved')

    def test_check_out_runs_the_hook(self):
        self.open_day(start=time(8, 0))
        with at(datetime(2026, 11, 18, 20, 0)):
            r = self.c['emp@x.com'].post('/api/attendance/check-out', {'email': 'emp@x.com'},
                                         content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        rec = OvertimeRecord.objects.get(email='emp@x.com', date=WED)
        self.assertEqual(rec.status, 'Pending')
        self.assertGreater(rec.overtime_minutes, 0)
        self.assertEqual(self.att(WED).overtime_minutes, 0)         # unapproved: not payable


class CompOffTests(OTBase):
    def balance(self):
        from api.attendance_ext import leave_accrual as la
        return la.balance('emp@x.com', 'Comp Off', 2026, today=SAT + timedelta(days=2))

    def test_full_day_comp_off_on_approval_and_type_added(self):
        rec = self.close(SAT, 480)
        self.assertEqual(rec.comp_off_days, 0)                       # pending: nothing yet
        self.decide('boss@x.com', rec.id)
        rec.refresh_from_db()
        self.assertEqual(float(rec.comp_off_days), 1.0)
        self.assertEqual(rec.comp_off_expires, SAT + timedelta(days=60))
        e = LeaveLedgerEntry.objects.get(pk=rec.comp_off_ledger_id)
        self.assertEqual((e.kind, e.leave_type, e.period, float(e.days)), ('comp_off', 'Comp Off', '2026-11-21', 1.0))
        names = [t['name'] for t in MasterDataSet.objects.get(key='leave_policy').options['types']]
        self.assertIn('Comp Off', names)
        self.assertEqual(self.balance()['balance'], 1)
        self.assertEqual(self.att(SAT).overtime_minutes, 0)          # compensated by comp-off, not paid
        # the employee can apply leave against it
        r = self.c['emp@x.com'].post('/api/leave', {'email': 'emp@x.com', 'type': 'Comp Off', 'fromDate': '2026-11-24',
                                                    'toDate': '2026-11-24', 'days': 1, 'reason': 'comp off'},
                                     content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        r = self.c['emp@x.com'].post('/api/leave', {'email': 'emp@x.com', 'type': 'Comp Off', 'fromDate': '2026-11-25',
                                                    'toDate': '2026-11-25', 'days': 1, 'reason': 'again'},
                                     content_type='application/json')
        self.assertEqual(r.status_code, 400)                         # only one day earned

    def test_half_day_and_auto(self):
        self.setp(overtime_requires_approval=False)
        rec = self.close(SAT, 300)
        self.assertEqual((rec.status, float(rec.comp_off_days)), ('Auto', 0.5))
        rec = self.close(date(2026, 11, 22), 120)                    # below half-day: paid as OT instead
        self.assertEqual(float(rec.comp_off_days), 0)
        self.assertEqual(self.att(date(2026, 11, 22)).overtime_minutes, 120)

    def test_idempotent_credit(self):
        self.setp(overtime_requires_approval=False)
        self.close(SAT, 480)
        self.close(SAT, 480)
        self.assertEqual(LeaveLedgerEntry.objects.filter(kind='comp_off').count(), 1)

    def test_partial_approval_earns_on_approved_minutes(self):
        rec = self.close(SAT, 480)                                   # capped to 240 for pay
        self.assertEqual(rec.overtime_minutes, 240)
        self.decide('boss@x.com', rec.id, minutes=200)
        rec.refresh_from_db()
        self.assertEqual(float(rec.comp_off_days), 0)                # 200 < half-day 240
        self.assertEqual(self.att(SAT).overtime_minutes, 200)

    def test_reject_gives_no_comp_off_and_reopen_reverses_unused(self):
        rec = self.close(SAT, 480)
        self.decide('boss@x.com', rec.id, 'reject')
        self.assertFalse(LeaveLedgerEntry.objects.filter(kind='comp_off').exists())
        other = self.close(date(2026, 11, 22), 480)
        self.decide('boss@x.com', other.id)
        self.assertTrue(LeaveLedgerEntry.objects.filter(kind='comp_off').exists())
        self.close(date(2026, 11, 22), 500)                          # worked time changed -> reopened
        self.assertFalse(LeaveLedgerEntry.objects.filter(kind='comp_off').exists())

    def test_used_credit_is_not_reversed(self):
        self.setp(overtime_requires_approval=False)
        self.close(SAT, 480)
        LeaveRequest.objects.create(email='emp@x.com', type='Comp Off', from_date=date(2026, 11, 24),
                                    to_date=date(2026, 11, 24), days=1, status='Approved')
        self.close(SAT, 100)                                         # now earns nothing
        e = LeaveLedgerEntry.objects.get(kind='comp_off')
        self.assertEqual(float(e.days), 1.0)                         # already used: kept

    def test_expiry_lapses_unused_once(self):
        self.setp(overtime_requires_approval=False, comp_off_expiry_days=30)
        self.close(SAT, 480)                                         # 1 day, expires 21 Dec
        self.close(date(2026, 11, 22), 480)                          # 1 day, expires 22 Dec
        LeaveRequest.objects.create(email='emp@x.com', type='Comp Off', from_date=date(2026, 11, 30),
                                    to_date=date(2026, 11, 30), days=1, status='Approved')   # FIFO: uses the 21st
        self.assertEqual(ot.expire(date(2026, 12, 21)), [])          # last usable day
        out = ot.expire(date(2026, 12, 23))
        self.assertEqual(out, [{'email': 'emp@x.com', 'date': '2026-11-22', 'days': 1}])
        self.assertEqual(ot.expire(date(2026, 12, 24)), [])          # once
        lapse = LeaveLedgerEntry.objects.get(kind='lapse')
        self.assertEqual(float(lapse.days), -1.0)
        rows = {r['date']: r['state'] for r in ot.balance_rows('emp@x.com', date(2026, 12, 24))}
        self.assertEqual(rows, {'2026-11-21': 'used', '2026-11-22': 'expired'})

    def test_management_command(self):
        self.setp(overtime_requires_approval=False, comp_off_expiry_days=1)
        self.close(SAT, 480)
        OvertimeRecord.objects.all().delete()
        LeaveLedgerEntry.objects.all().delete()
        out = StringIO()
        call_command('overtime_jobs', '--evaluate', '2026-11-16..2026-11-22', '--dry-run', stdout=out)
        self.assertIn('1 with overtime', out.getvalue())
        self.assertEqual(OvertimeRecord.objects.count(), 0)          # dry run
        call_command('overtime_jobs', '--evaluate', '2026-11-16..2026-11-22', '--expire', '--today', '2026-12-01',
                     stdout=out)
        self.assertEqual(OvertimeRecord.objects.count(), 1)
        self.assertIn('1 credit(s) lapsed', out.getvalue())

    def test_summary_endpoint(self):
        self.setp(overtime_requires_approval=False)
        self.close(SAT, 480)
        self.close(WED, 600)
        d = self.c['emp@x.com'].get('/api/attendance/overtime-summary?month=2026-11').json()
        self.assertEqual(d['payableMinutes'], 60)
        self.assertEqual(d['compOff']['earned'], 1)
        self.assertEqual(d['policy']['dailyCapMinutes'], 240)
        self.assertEqual(self.c['solo@x.com'].get('/api/attendance/overtime-summary?email=emp@x.com').status_code, 403)
        self.assertEqual(self.c['boss@x.com'].get('/api/attendance/overtime-summary?email=emp@x.com').status_code, 200)


class PayrollTests(OTBase):
    def test_payroll_counts_only_approved_overtime(self):
        a = self.close(MON, 600)                    # 60 pending
        b = self.close(WED, 660)                    # 120 -> approve 90
        c = self.close(date(2026, 11, 17), 600)     # 60 -> rejected
        self.decide('boss@x.com', b.id, minutes=90)
        self.decide('boss@x.com', c.id, 'reject')
        rows = PayrollService.step_fetch_attendance(date(2026, 11, 1), date(2026, 11, 30))
        row = next(r for r in rows if r['email'] == 'emp@x.com')
        self.assertEqual(row['overtime_hours'], 1.5)
        self.decide('boss@x.com', a.id)
        row = next(r for r in PayrollService.step_fetch_attendance(date(2026, 11, 1), date(2026, 11, 30))
                   if r['email'] == 'emp@x.com')
        self.assertEqual(row['overtime_hours'], 2.5)


class EvaluateEndpointTests(OTBase):
    def test_hr_recompute_and_permissions(self):
        self.close(WED, 600)
        EmployeeAttendance.objects.filter(email='emp@x.com', date=WED).update(overtime_minutes=999)  # drifted
        body = {'from': '2026-11-16', 'to': '2026-11-22'}
        self.assertEqual(self.c['boss@x.com'].post('/api/attendance/overtime-evaluate', body,
                                                   content_type='application/json').status_code, 403)
        r = self.c['hr@x.com'].post('/api/attendance/overtime-evaluate', body, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['records'], 1)
        self.assertEqual(self.att(WED).overtime_minutes, 0)          # back to payable (pending = 0)
        r = self.c['hr@x.com'].post('/api/attendance/overtime-evaluate', {'from': '2026-01-01', 'to': '2026-12-31'},
                                    content_type='application/json')
        self.assertEqual(r.status_code, 400)

    def test_individual_policy_assignment(self):
        p = AttendancePolicyProfile.objects.create(name='Ops', overtime_after_minutes=300)
        AttendancePolicyAssignment.objects.create(email='emp@x.com', profile=p)
        self.assertEqual(self.close(WED, 400).overtime_minutes, 100)
