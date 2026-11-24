"""Leave accrual ledger (Attendance phase 1 / L): monthly accrual, joiner
proration, carry-forward caps, year-end encashment / lapse, payroll hook."""
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.test import Client, TestCase

from api.attendance_ext import leave_accrual as la
from api.models import (AppUser, EmployeeCompensation, LeaveLedgerEntry, LeaveRequest, Permission,
                        PayrollRun, Role, RolePermission, UserProfile)

EMP = 'emp@example.com'


class Base(TestCase):
    today = date(2026, 11, 4)

    def setUp(self):
        AppUser.objects.create(email='admin@example.com', full_name='Admin', status='active', role='admin')
        AppUser.objects.create(email=EMP, full_name='Emp', status='active', role='recruitment')
        AppUser.objects.create(email='other@example.com', full_name='Other', status='active', role='recruitment')
        perm = Permission.objects.create(code='leave.action', name='Action leave')
        role = Role.objects.create(name='Leave HR')
        RolePermission.objects.create(role=role, permission=perm)
        AppUser.objects.create(email='hr@example.com', full_name='HR', status='active', role_ref=role)
        self.admin = Client(HTTP_X_USER_EMAIL='admin@example.com')
        self.hr = Client(HTTP_X_USER_EMAIL='hr@example.com')
        self.emp = Client(HTTP_X_USER_EMAIL=EMP)
        self.set_today(self.today)

    def set_today(self, d):
        for p in getattr(self, '_patches', []):
            p.stop()
        self._patches = [patch(t, return_value=d) for t in ('api.views.local_today',
                                                            'api.attendance_ext.leave_accrual.local_today',
                                                            'api.attendance_ext.leave_views.local_today')]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def policy(self, types, **kw):
        r = self.admin.put('/api/leave/policy', dict({'types': types, 'enforceBalance': True}, **kw),
                           content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def joined(self, d, email=EMP):
        UserProfile.objects.update_or_create(email=email, defaults={'start_date': d})

    def balances(self, email=EMP, client=None):
        r = (client or self.emp).get('/api/leave/balance?email=' + email)
        self.assertEqual(r.status_code, 200, r.content)
        return {b['type']: b for b in r.json()['balances']}

    def apply(self, typ, frm, to):
        return self.emp.post('/api/leave', {'email': EMP, 'type': typ, 'fromDate': frm, 'toDate': to},
                             content_type='application/json')

    def leave(self, typ, frm, to, days, status='Approved'):
        LeaveRequest.objects.create(email=EMP, type=typ, from_date=frm, to_date=to, days=days, status=status)


MONTHLY = {'name': 'Earned Leave', 'days': 18, 'accrual': 'monthly'}


class AccrualTests(Base):
    def test_monthly_accrual_is_idempotent(self):
        self.policy([MONTHLY])
        b = self.balances()['Earned Leave']
        self.assertEqual((b['allowance'], b['accrued'], b['remaining'], b['accrual']), (16.5, 16.5, 16.5, 'monthly'))
        self.assertEqual(b['nextAccrual'], {'date': '2026-12-01', 'days': 1.5})
        self.balances()
        la.accrue(EMP, date(2026, 11, 30))
        self.assertEqual(LeaveLedgerEntry.objects.filter(email=EMP, kind='accrual').count(), 11)
        self.set_today(date(2026, 12, 2))
        self.assertEqual(self.balances()['Earned Leave']['accrued'], 18)
        self.assertEqual(LeaveLedgerEntry.objects.filter(email=EMP, kind='accrual').count(), 12)

    def test_accrue_on_month_end(self):
        self.policy([dict(MONTHLY, accrueOn='end')])
        b = self.balances()['Earned Leave']
        self.assertEqual((b['accrued'], b['nextAccrual']), (15, {'date': '2026-11-30', 'days': 1.5}))

    def test_joiner_before_and_after_cutoff(self):
        self.policy([MONTHLY])
        self.joined(date(2026, 3, 10))                        # March counts: Mar..Nov = 9
        self.assertEqual(self.balances()['Earned Leave']['accrued'], 13.5)
        self.assertEqual(LeaveLedgerEntry.objects.get(email=EMP, period='2026-03').effective_date, date(2026, 3, 10))
        self.joined(date(2026, 3, 20), 'other@example.com')   # after the 15th: Apr..Nov = 8
        self.assertEqual(self.balances('other@example.com', self.admin)['Earned Leave']['accrued'], 12)

    def test_joining_in_the_future_accrues_nothing(self):
        self.policy([MONTHLY, {'name': 'Casual Leave', 'days': 12}])
        self.joined(date(2026, 12, 1))
        b = self.balances()
        self.assertEqual((b['Earned Leave']['accrued'], b['Casual Leave']['accrued']), (0, 0))

    def test_annual_prorate_for_joiners(self):
        self.policy([{'name': 'Casual Leave', 'days': 12}, {'name': 'Earned Leave', 'days': 15},
                     {'name': 'Sick Leave', 'days': 12, 'prorateJoiners': False}])
        self.joined(date(2026, 7, 20))
        b = self.balances()
        self.assertEqual(b['Casual Leave']['allowance'], 5)        # Aug..Dec = 5/12 of 12
        self.assertEqual(b['Earned Leave']['allowance'], 6.5)      # 15 x 5/12 = 6.25 -> 6.5
        self.assertEqual(b['Sick Leave']['allowance'], 12)
        self.assertEqual(LeaveLedgerEntry.objects.get(email=EMP, leave_type='Casual Leave').kind, 'prorate')
        self.joined(date(2026, 7, 10))
        self.assertEqual(self.balances()['Casual Leave']['allowance'], 6)

    def test_annual_grant_follows_policy_changes(self):
        self.policy([{'name': 'Casual Leave', 'days': 12}])
        self.assertEqual(self.balances()['Casual Leave']['remaining'], 12)
        self.policy([{'name': 'Casual Leave', 'days': 8}])
        self.assertEqual(self.balances()['Casual Leave']['remaining'], 8)
        self.assertEqual(LeaveLedgerEntry.objects.filter(email=EMP).count(), 1)

    def test_balance_with_approved_and_pending(self):
        self.policy([MONTHLY])
        self.leave('Earned Leave', date(2026, 3, 2), date(2026, 3, 4), 3)
        self.leave('Earned Leave', date(2026, 12, 1), date(2026, 12, 2), 2, status='Pending')
        self.leave('Earned Leave', date(2025, 12, 1), date(2025, 12, 5), 5)               # last year
        b = self.balances()['Earned Leave']
        self.assertEqual((b['used'], b['pending'], b['remaining'], b['balance'], b['canApply']),
                         (3, 2, 13.5, 13.5, 11.5))

    def test_enforce_blocks_leave_not_yet_accrued(self):
        self.policy([MONTHLY])
        self.joined(date(2026, 10, 1))                                     # Oct + Nov = 3 days
        r = self.apply('Earned Leave', '2026-11-10', '2026-11-13')         # 4 days
        self.assertEqual(r.status_code, 400)
        self.assertIn('3 days of Earned Leave left', r.json()['message'])
        # By mid-December the December credit has landed: 4.5 days.
        self.assertEqual(self.apply('Earned Leave', '2026-12-14', '2026-12-17').status_code, 201)
        self.assertFalse(LeaveLedgerEntry.objects.filter(period='2026-12').exists())   # projected, not written

    def test_allow_negative_lets_employees_borrow(self):
        self.policy([dict(MONTHLY, allowNegative=1)])
        self.joined(date(2026, 10, 1))
        self.assertEqual(self.apply('Earned Leave', '2026-11-10', '2026-11-13').status_code, 201)
        self.assertEqual(self.apply('Earned Leave', '2026-11-16', '2026-11-16').status_code, 400)

    def test_legacy_policy_unchanged(self):
        self.policy([{'name': 'Casual Leave', 'days': 3}, {'name': 'Loss of Pay', 'days': None}])
        p = self.emp.get('/api/leave/policy').json()
        self.assertEqual(p['types'], [{'name': 'Casual Leave', 'days': 3}, {'name': 'Loss of Pay', 'days': None}])
        self.leave('Casual Leave', date(2026, 3, 2), date(2026, 3, 2), 1)
        b = self.balances()
        self.assertEqual((b['Casual Leave']['allowance'], b['Casual Leave']['remaining']), (3, 2))
        self.assertEqual((b['Loss of Pay']['unlimited'], b['Loss of Pay']['remaining']), (True, None))
        self.assertEqual(self.apply('Casual Leave', '2026-11-10', '2026-11-11').status_code, 201)
        self.assertEqual(self.apply('Casual Leave', '2026-11-16', '2026-11-16').status_code, 400)


class PolicyValidationTests(Base):
    def put(self, types):
        return self.admin.put('/api/leave/policy', {'types': types}, content_type='application/json')

    def test_bad_settings_refused(self):
        for t, msg in [({'name': 'EL', 'days': 12, 'accrual': 'weekly'}, 'accrual must be'),
                       ({'name': 'EL', 'days': 12, 'colour': 'red'}, 'unknown setting'),
                       ({'name': 'LOP', 'days': None, 'accrual': 'monthly'}, 'cannot accrue monthly'),
                       ({'name': 'EL', 'days': 12, 'carryForwardMax': -1}, 'carryForwardMax'),
                       ({'name': 'EL', 'days': 12, 'joinCutoffDay': 40}, 'joinCutoffDay'),
                       ({'name': 'EL', 'days': 12, 'monthlyRate': 'x'}, 'monthlyRate'),
                       ({'name': 'EL', 'days': 12, 'prorateJoiners': 'yes'}, 'prorateJoiners'),
                       ({'name': 'EL', 'days': 12, 'excess': 'pay'}, 'excess'),
                       ({'name': 'EL', 'days': 12, 'encashBasis': 'net'}, 'encashBasis')]:
            r = self.put([t])
            self.assertEqual(r.status_code, 400, t)
            self.assertIn(msg, r.json()['message'])

    def test_settings_round_trip(self):
        t = {'name': 'Earned Leave', 'days': 18, 'accrual': 'monthly', 'monthlyRate': 1.5, 'accrueOn': 'end',
             'prorateJoiners': True, 'joinCutoffDay': 10, 'carryForwardMax': 30, 'excess': 'encash',
             'encashMax': 10, 'encashBasis': 'gross', 'encashDivisor': 26, 'maxBalance': 45, 'allowNegative': 2}
        r = self.put([t, {'name': 'Loss of Pay', 'days': None}])
        self.assertEqual(r.status_code, 200, r.content)
        got = self.emp.get('/api/leave/policy').json()['types']
        self.assertEqual(got[0], t)
        self.assertEqual(got[1], {'name': 'Loss of Pay', 'days': None})


class RolloverTests(Base):
    today = date(2026, 1, 5)
    EL = {'name': 'Earned Leave', 'days': 12, 'carryForwardMax': 5, 'excess': 'encash', 'encashMax': 3}

    def setUp(self):
        super().setUp()
        self.policy([self.EL, {'name': 'Casual Leave', 'days': 12}, {'name': 'Loss of Pay', 'days': None}])
        EmployeeCompensation.objects.create(email=EMP, base_amount=Decimal('30000'), annual_ctc=Decimal('720000'),
                                            effective_from=date(2024, 1, 1))
        self.leave('Earned Leave', date(2025, 6, 2), date(2025, 6, 3), 2)

    def roll(self, client=None, **body):
        return (client or self.admin).post('/api/leave/rollover', dict({'year': 2025}, **body),
                                           content_type='application/json')

    def row(self, out, typ, email=EMP):
        return next(r for r in out['rows'] if r['email'] == email and r['type'] == typ)

    def test_preview_writes_nothing(self):
        out = self.roll().json()
        self.assertTrue(out['dryRun'])
        el = self.row(out, 'Earned Leave')
        self.assertEqual((el['remaining'], el['carryForward'], el['encash'], el['encashAmount'], el['lapse']),
                         (10, 5, 3, 3000, 2))
        self.assertEqual(self.row(out, 'Casual Leave')['lapse'], 12)
        self.assertFalse(LeaveLedgerEntry.objects.exists())

    def test_rollover_carry_encash_lapse_idempotent(self):
        out = self.roll(dryRun=False).json()
        self.assertEqual(self.row(out, 'Earned Leave')['status'], 'rolled')
        enc = LeaveLedgerEntry.objects.get(email=EMP, kind='encash')
        self.assertEqual((enc.days, enc.amount, enc.year, enc.effective_date), (Decimal('-3'), Decimal('3000'), 2025,
                                                                             date(2026, 1, 1)))
        self.assertEqual(LeaveLedgerEntry.objects.get(email=EMP, kind='lapse', leave_type='Earned Leave').days, -2)
        self.assertEqual(LeaveLedgerEntry.objects.get(email=EMP, kind='lapse', leave_type='Casual Leave').days, -12)
        b = self.balances()['Earned Leave']
        self.assertEqual((b['allowance'], b['carriedForward']), (17, 5))
        # 2025 is closed: nothing left in it.
        r = self.emp.get('/api/leave/ledger?email=%s&year=2025' % EMP).json()
        self.assertEqual({x['type']: x['balance'] for x in r['balances']}['Earned Leave'], 0)
        n = LeaveLedgerEntry.objects.count()
        again = self.roll(dryRun=False).json()
        self.assertEqual(self.row(again, 'Earned Leave')['status'], 'done')
        self.assertEqual(self.row(again, 'Earned Leave')['carryForward'], 5)
        self.assertEqual(LeaveLedgerEntry.objects.count(), n)

    def test_cannot_commit_an_open_year(self):
        r = self.roll(year=2026, dryRun=False)
        self.assertEqual(r.status_code, 400)
        self.assertIn('has not ended', r.json()['message'])

    def test_encash_priced_on_gross(self):
        self.policy([dict(self.EL, encashBasis='gross', encashDivisor=25)])
        self.roll(dryRun=False)
        self.assertEqual(LeaveLedgerEntry.objects.get(email=EMP, kind='encash').amount, Decimal('7200'))  # 60000/25*3

    def test_payroll_hook_pays_once_per_run(self):
        self.roll(dryRun=False)
        run1 = PayrollRun.objects.create(period_label='2026-01', period_start=date(2026, 1, 1),
                                         period_end=date(2026, 1, 31))
        run2 = PayrollRun.objects.create(period_label='2026-01b', period_start=date(2026, 1, 1),
                                         period_end=date(2026, 1, 31))

        def calc(run_id, end=date(2026, 1, 31)):
            res = {'earnings_data': [{'code': 'BASIC_SALARY', 'label': 'Basic', 'amount': 30000}],
                   'deductions_data': [], 'employer_contributions_data': []}
            return la.apply_leave_encashment(res, {'email': EMP, 'start': date(end.year, end.month, 1),
                                                   'end': end, 'run_id': run_id})

        def enc(res):
            return [l['amount'] for l in res['earnings_data'] if l['code'] == 'LEAVE_ENC']

        self.assertEqual(enc(calc(None, date(2025, 12, 31))), [])          # December run: not yet
        self.assertEqual(enc(calc(None)), [3000.0])                         # preview: shown, not marked
        self.assertIsNone(LeaveLedgerEntry.objects.get(email=EMP, kind='encash').paid_run_id)
        r = calc(run1.id)
        self.assertEqual((enc(r), r['gross_earnings']), ([3000.0], 33000.0))
        self.assertEqual(LeaveLedgerEntry.objects.get(email=EMP, kind='encash').paid_run_id, run1.id)
        self.assertEqual(enc(calc(run1.id)), [3000.0])                      # re-run of the same run
        self.assertEqual(enc(calc(run2.id)), [])                            # never paid twice
        run1.status = 'cancelled'
        run1.save()
        self.assertEqual(enc(calc(run2.id)), [3000.0])                      # cancelled run releases it

    def test_command(self):
        from io import StringIO
        from django.core.management import call_command
        buf = StringIO()
        call_command('leave_accrual', '--rollover', '2025', '--dry-run', '--email', EMP, stdout=buf)
        self.assertIn('[dry run] 2025', buf.getvalue())
        self.assertFalse(LeaveLedgerEntry.objects.exists())
        call_command('leave_accrual', '--upto', '2026-01-05', stdout=StringIO())
        self.assertTrue(LeaveLedgerEntry.objects.filter(email=EMP, year=2026, kind='opening').exists())


class LedgerPermissionTests(Base):
    def adjust(self, client, **body):
        return client.post('/api/leave/ledger/adjust', dict({'email': EMP, 'type': 'Casual Leave', 'days': 2,
                                                            'note': 'Worked on a holiday'}, **body),
                           content_type='application/json')

    def test_hr_adjusts_with_a_note(self):
        self.policy([{'name': 'Casual Leave', 'days': 12}])
        r = self.adjust(self.hr)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['entry']['createdBy'], 'hr@example.com')
        self.assertEqual(self.balances()['Casual Leave']['remaining'], 14)
        self.assertEqual(self.adjust(self.admin, days=-1.5).status_code, 201)
        self.assertEqual(self.balances()['Casual Leave']['adjusted'], 0.5)
        self.assertEqual(self.adjust(self.hr, note='').status_code, 400)
        self.assertEqual(self.adjust(self.hr, days=0).status_code, 400)
        self.assertEqual(self.adjust(self.hr, type='Nope').status_code, 400)

    def test_employees_cannot_adjust_or_roll_over(self):
        self.assertEqual(self.adjust(self.emp).status_code, 403)
        r = self.emp.post('/api/leave/rollover', {'year': 2025}, content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.emp.post('/api/leave/accrual/run', {}, content_type='application/json').status_code, 403)
        self.assertEqual(self.emp.get('/api/leave/ledger/people').status_code, 403)
        self.assertEqual(Client().get('/api/leave/ledger?email=' + EMP).status_code, 401)

    def test_ledger_self_or_hr(self):
        self.assertEqual(self.emp.get('/api/leave/ledger?email=' + EMP).status_code, 200)
        self.assertEqual(self.emp.get('/api/leave/ledger?email=other@example.com').status_code, 403)
        r = self.hr.get('/api/leave/ledger?email=' + EMP)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['entries'])
        self.assertEqual(self.hr.post('/api/leave/accrual/run', {}, content_type='application/json').status_code, 200)
