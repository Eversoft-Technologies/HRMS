"""Late / early-out penalties (api/attendance_ext/penalties.py) and their
payroll hook."""
from datetime import date, timedelta
from decimal import Decimal
from io import StringIO

from django.core.management import call_command

from api.attendance_ext import leave_accrual as la
from api.attendance_ext import penalties as pen
from api.models import AttendancePenalty, LeaveLedgerEntry, Notification, PayrollRun

from .test_attendance_policy import Base, D, at, dt

DAYS = [D + timedelta(days=i) for i in range(5)]        # Mon 2 .. Fri 6 Nov 2026


def bal(lt='Casual Leave', email='emp@x.com'):
    return la.balance(email, lt, 2026)['balance']


class PenaltyTests(Base):
    def lates(self, n, who='emp@x.com'):
        for d in DAYS[:n]:
            self.closed_day(d, (9, 30), (18, 30), who=who, status='late', late_minutes=30)

    def test_free_allowance_then_half_day_from_casual_leave(self):
        start = bal()
        for d in DAYS[:4]:                                  # live check-outs: penalties evaluated each time
            self.work(d, (9, 30), (18, 0))
        p = AttendancePenalty.objects.get()
        self.assertEqual((p.date, p.kind, p.occurrence, p.status, p.leave_type, float(p.days)),
                         (DAYS[3], 'late', 4, 'applied', 'Casual Leave', 0.5))
        e = LeaveLedgerEntry.objects.get(pk=p.ledger_entry_id)
        self.assertEqual((e.kind, e.period, e.days), ('penalty', DAYS[3].isoformat(), Decimal('-0.50')))
        self.assertEqual(bal(), start - 0.5)
        note = Notification.objects.filter(recipient='emp@x.com', title='Attendance penalty').get()
        self.assertIn('4th', note.message)
        self.assertIn('Regularize', note.message)                       # how to dispute
        self.assertIn('0.5 day was deducted from your Casual Leave balance', note.message)
        self.assertTrue(any(c.kwargs.get('subject', '').startswith('Attendance penalty') for c in self.sent.call_args_list))

    def test_idempotent(self):
        self.lates(5)
        pen.evaluate_month('emp@x.com', 2026, 11)
        pen.evaluate_month('emp@x.com', 2026, 11)
        self.assertEqual(AttendancePenalty.objects.count(), 2)
        self.assertEqual(LeaveLedgerEntry.objects.filter(kind='penalty').count(), 2)
        self.assertEqual(Notification.objects.filter(title='Attendance penalty').count(), 2)

    def test_leave_types_in_order_then_lop(self):
        self.profile('Default', is_default=True, free_lates_per_month=1,
                     penalty_leave_types=['Casual Leave', 'Sick Leave'])
        la.adjust('emp@x.com', 'Casual Leave', -(bal() - 0.5), 'test', 'hr@x.com', 2026, DAYS[0])   # 0.5 left
        la.adjust('emp@x.com', 'Sick Leave', -(bal('Sick Leave') - 0.5), 'test', 'hr@x.com', 2026, DAYS[0])
        self.lates(4)
        pen.evaluate_month('emp@x.com', 2026, 11)
        got = list(AttendancePenalty.objects.order_by('date').values_list('occurrence', 'status', 'leave_type'))
        self.assertEqual(got, [(2, 'applied', 'Casual Leave'), (3, 'applied', 'Sick Leave'), (4, 'lop', '')])

    def test_lop_and_warning_actions(self):
        prof = self.profile('Default', is_default=True, free_lates_per_month=0, penalty_action='lop_half_day')
        self.lates(1)
        pen.evaluate_month('emp@x.com', 2026, 11)
        self.assertEqual(AttendancePenalty.objects.get().status, 'lop')
        prof.penalty_action = 'warning'
        prof.save()
        self.lates(1, who='sales@x.com')
        pen.evaluate_month('sales@x.com', 2026, 11)
        p = AttendancePenalty.objects.get(email='sales@x.com')
        self.assertEqual((p.status, float(p.days)), ('warned', 0.0))
        self.assertFalse(LeaveLedgerEntry.objects.filter(kind='penalty').exists())

    def test_early_outs_count_when_enabled(self):
        self.profile('Default', is_default=True, free_lates_per_month=1, count_early_outs=True,
                     full_day_minutes=420, grace_early_out_minutes=10)
        self.closed_day(DAYS[0], (9, 30), (17, 30), status='late', late_minutes=30)     # late + early out
        self.closed_day(DAYS[1], (9, 0), (17, 55))                                     # within grace
        pen.evaluate_month('emp@x.com', 2026, 11)
        self.assertEqual(list(AttendancePenalty.objects.values_list('date', 'kind', 'occurrence')),
                         [(DAYS[0], 'early_out', 2)])

    def test_waive_reverses_the_ledger(self):
        start = bal()
        self.lates(4)
        pen.evaluate_month('emp@x.com', 2026, 11)
        p = AttendancePenalty.objects.get()
        url = f'/api/attendance/penalties/{p.id}/waive'
        self.assertEqual(self.post('emp@x.com', url, note='mine').status_code, 403)          # own
        self.assertEqual(self.post('other@x.com', url, note='x').status_code, 403)           # not the manager
        self.assertEqual(self.post('boss@x.com', url).status_code, 400)                      # note required
        r = self.post('boss@x.com', url, note='Client visit')
        self.assertEqual(r.status_code, 200, r.content)
        p.refresh_from_db()
        self.assertEqual((p.status, p.waived_by, p.ledger_entry_id), ('waived', 'boss@x.com', None))
        self.assertEqual(bal(), start)
        self.assertEqual(self.post('hr@x.com', url, note='again').status_code, 409)
        pen.evaluate_month('emp@x.com', 2026, 11)                                         # not re-created
        self.assertEqual(AttendancePenalty.objects.get().status, 'waived')
        self.assertFalse(LeaveLedgerEntry.objects.filter(kind='penalty').exists())

    def test_hr_can_waive_and_lists_are_scoped(self):
        self.lates(4)
        pen.evaluate_month('emp@x.com', 2026, 11)
        self.assertEqual(self.c['hr@x.com'].get('/api/attendance/penalties?month=2026-11').json()['count'], 1)
        self.assertEqual(self.c['boss@x.com'].get('/api/attendance/penalties').json()['count'], 1)     # a report
        self.assertEqual(self.c['other@x.com'].get('/api/attendance/penalties').json()['count'], 0)
        mine = self.c['emp@x.com'].get('/api/attendance/penalties').json()
        self.assertEqual((mine['count'], mine['results'][0]['canWaive']), (1, False))
        p = AttendancePenalty.objects.get()
        self.assertEqual(self.post('hr@x.com', f'/api/attendance/penalties/{p.id}/waive', note='ok').status_code, 200)

    def test_regularization_that_removes_the_late_removes_the_penalty(self):
        start = bal()
        for d in DAYS[:4]:
            self.work(d, (9, 30), (18, 0))
        self.assertEqual(AttendancePenalty.objects.count(), 1)
        with at(dt(DAYS[4], 9, 0)):
            r = self.post('emp@x.com', '/api/attendance/regularization', date=DAYS[1].isoformat(), checkIn='09:00',
                          reasonCode='forgot_badge')
            self.assertEqual(r.status_code, 201, r.content)
            r = self.post('boss@x.com', f'/api/attendance/regularization/{r.json()["id"]}/decide', action='approve')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.row(DAYS[1]).status, 'present')
        self.assertFalse(AttendancePenalty.objects.exists())                 # 3 lates left: all free
        self.assertEqual(bal(), start)
        self.assertTrue(Notification.objects.filter(recipient='emp@x.com', title='Attendance penalty removed').exists())

    def test_history_shows_the_penalty(self):
        self.lates(4)
        pen.evaluate_month('emp@x.com', 2026, 11)
        with at(dt(DAYS[4], 20, 0)):
            r = self.c['emp@x.com'].get(f'/api/attendance/history?email=emp@x.com&from={DAYS[0]}&to={DAYS[4]}')
        day = {x['date']: x for x in r.json()['results']}[DAYS[3].isoformat()]
        self.assertIn('Late arrival penalty: 0.5 day Casual Leave', day['detail'])
        self.assertEqual(day['penalty'][0]['status'], 'applied')

    def test_command_dry_run_then_apply(self):
        self.lates(5)
        out = StringIO()
        call_command('attendance_penalties', '--month', '2026-11', '--dry-run', stdout=out)
        self.assertIn('2 would be created', out.getvalue())
        self.assertFalse(AttendancePenalty.objects.exists())
        call_command('attendance_penalties', '--month', '2026-11', stdout=StringIO())
        self.assertEqual(AttendancePenalty.objects.count(), 2)


class PayrollHookTests(Base):
    def setUp(self):
        super().setUp()
        self.profile('Default', is_default=True, free_lates_per_month=0, penalty_action='lop_half_day')
        self.closed_day(DAYS[0], (9, 30), (18, 30), status='late', late_minutes=30)
        self.closed_day(DAYS[1], (9, 30), (18, 30), status='late', late_minutes=30)
        pen.evaluate_month('emp@x.com', 2026, 11)
        self.assertEqual(AttendancePenalty.objects.filter(status='lop').count(), 2)
        self.start, self.end = date(2026, 11, 1), date(2026, 11, 30)

    def result(self):
        return {'earnings_data': [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': 20000.0},
                                  {'code': 'HRA', 'label': 'HRA', 'amount': 10000.0},
                                  {'code': 'REIMB', 'label': 'Reimbursement', 'amount': 5000.0}],
                'deductions_data': [], 'employer_contributions_data': []}

    def ctx(self, run_id=None):
        return {'email': 'emp@x.com', 'start': self.start, 'end': self.end, 'run_id': run_id}

    def line(self, res):
        return [l for l in res['deductions_data'] if l['code'] == 'ATT_PENALTY']

    def test_lop_line_once_per_run(self):
        run1 = PayrollRun.objects.create(period_label='2026-11', period_start=self.start, period_end=self.end)
        res = pen.apply_attendance_penalties(self.result(), self.ctx(run1.id))
        # gross 30000 (reimbursement excluded) / 30 days = 1000 a day; 2 x 0.5 day
        self.assertEqual(self.line(res), [{'code': 'ATT_PENALTY', 'label': 'Attendance penalty (LOP)', 'amount': 1000.0}])
        self.assertEqual(res['net_pay'], 34000.0)
        self.assertEqual(set(AttendancePenalty.objects.values_list('paid_run_id', flat=True)), {run1.id})
        again = pen.apply_attendance_penalties(self.result(), self.ctx(run1.id))       # same run: re-included
        self.assertEqual(self.line(again)[0]['amount'], 1000.0)
        run2 = PayrollRun.objects.create(period_label='2026-11b', period_start=self.start, period_end=self.end)
        other = pen.apply_attendance_penalties(self.result(), self.ctx(run2.id))       # another run: never twice
        self.assertEqual(self.line(other), [])
        run1.status = 'cancelled'
        run1.save()
        self.assertEqual(self.line(pen.apply_attendance_penalties(self.result(), self.ctx(run2.id)))[0]['amount'], 1000.0)

    def test_outside_the_period_and_waived_are_not_deducted(self):
        self.start, self.end = date(2026, 12, 1), date(2026, 12, 31)
        self.assertEqual(self.line(pen.apply_attendance_penalties(self.result(), self.ctx())), [])
        self.start, self.end = date(2026, 11, 1), date(2026, 11, 30)
        p = AttendancePenalty.objects.first()
        pen.waive(p, 'hr@x.com', 'ok')
        self.assertEqual(self.line(pen.apply_attendance_penalties(self.result(), self.ctx()))[0]['amount'], 500.0)

    def test_paid_lop_cannot_be_waived_or_removed(self):
        run = PayrollRun.objects.create(period_label='2026-11', period_start=self.start, period_end=self.end)
        pen.apply_attendance_penalties(self.result(), self.ctx(run.id))
        p = AttendancePenalty.objects.first()
        with self.assertRaises(pen.Refused):
            pen.waive(p, 'hr@x.com', 'late fix')
        self.row(p.date).delete()                                   # the occurrence vanishes …
        pen.evaluate_month('emp@x.com', 2026, 11)
        self.assertTrue(AttendancePenalty.objects.filter(pk=p.pk).exists())   # … but paid history stays
