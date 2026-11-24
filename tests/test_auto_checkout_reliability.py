"""Automatic check-out on leaving the office geofence — and what follows it.

Behaviour (the user's rules):
  1. outside the office fence continuously for the policy timeout (default
     10 minutes) → the browser shows a 10-second warning with a sound;
  2. still outside after the warning → automatic check-out;
  3. checking in again that work day needs the manager's approval;
  4. a forgotten check-out (no departure) is only notified — never closed.

The server is the authority: geofence-check keeps an unbroken run of precise
outside readings on the session, and an auto check-out is accepted only when
that run is at least (timeout - 1) minutes long and its last reading fresh.
Worked time ends when the employee LEFT (the start of the run), not when the
timeout ran out.
"""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import (AppUser, AttendanceAuditLog, EmployeeAttendance, GeoFence, MasterDataSet, Notification,
                        Permission, Role, RolePermission, Shift, ShiftAssignment, UserProfile)

OFFICE = (13.1500, 78.5100)
NEAR = (13.1505, 78.5102)        # inside
TOWN = (13.2300, 78.5600)        # ~10 km away
DAY = date(2026, 11, 2)
NOON = datetime(2026, 11, 2, 12, 0)
EMP, BOSS, HR, PEER = 'emp@example.com', 'boss@example.com', 'hr@example.com', 'peer@example.com'


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()), \
            patch('api.attendance_ext.missed_punch.local_now', return_value=dt, create=True):
        yield


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class Base(TestCase):
    def setUp(self):
        from api import permissions
        permissions._CACHE.clear()
        self.mail = patch('api.mailer.send_email', return_value={'ok': True})
        self.mail.start()
        self.addCleanup(self.mail.stop)
        emp = Role.objects.create(name='Employee')
        grant(emp, 'attendance.create', 'attendance.view')
        hr = Role.objects.create(name='HR Manager')
        grant(hr, 'attendance.create', 'attendance.view', 'attendance.edit', 'attendance.approve_offsite',
              'settings.manage', 'employee.view')
        for email, role, mgr in ((EMP, emp, BOSS), (BOSS, emp, ''), (HR, hr, ''), (PEER, emp, '')):
            AppUser.objects.create(email=email, full_name=email.split('@')[0].title(), password='x',
                                   role='employee', role_ref=role, status='active')
            UserProfile.objects.create(email=email, first_name=email.split('@')[0].title(), manager_email=mgr)
        self.shift = Shift.objects.create(id=1, name='Day', start_time=time(9, 0), end_time=time(18, 0),
                                          grace_minutes=15, break_minutes=0, overtime_after_minutes=540)
        ShiftAssignment.objects.create(email=EMP, shift=self.shift, effective_from=DAY - timedelta(days=30))
        GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        self.c = Client(HTTP_X_USER_EMAIL=EMP)

    def client_for(self, email):
        return Client(HTTP_X_USER_EMAIL=email)

    def session(self, **kw):
        base = dict(email=EMP, employee_name='Emp', date=DAY, check_in=datetime(2026, 11, 2, 9, 0), shift_id=1,
                    location_lat=OFFICE[0], location_lng=OFFICE[1], geo_verified=True)
        base.update(kw)
        return EmployeeAttendance.objects.create(**base)

    def geocheck(self, pos, when, acc=30):
        with at(when):
            return self.c.get(f'/api/attendance/geofence-check?email={EMP}'
                              f'&latitude={pos[0]}&longitude={pos[1]}&accuracy={acc}').json()

    def outside(self, minutes, end=NOON, step=4):
        """The watcher's precise outside readings, the last one at ``end``."""
        k = minutes
        while k >= 0:
            self.geocheck(TOWN, end - timedelta(minutes=k))
            k -= step
        if k != -step:
            self.geocheck(TOWN, end)

    def auto_out(self, when=NOON, auto='geofence_departure', **extra):
        with at(when):
            return self.c.post('/api/attendance/check-out', {'email': EMP, 'auto': auto, **extra},
                               content_type='application/json')

    def check_in(self, when, pos=OFFICE, **extra):
        with at(when):
            return self.c.post('/api/attendance/check-in', {'email': EMP, 'employee': 'Emp', 'latitude': pos[0],
                                                            'longitude': pos[1], 'accuracy': 20, **extra},
                               content_type='application/json')

    def check_out(self, when):
        with at(when):
            return self.c.post('/api/attendance/check-out', {'email': EMP}, content_type='application/json')

    def row(self):
        return EmployeeAttendance.objects.get(email=EMP, date=DAY)

    def set_policy(self, **kw):
        MasterDataSet.objects.update_or_create(key='attendance_departure_policy',
                                               defaults={'label': 'x', 'options': kw})


class ServerEvidenceTests(Base):
    def setUp(self):
        super().setUp()
        self.session()

    def test_no_outside_run_no_auto_checkout(self):
        r = self.auto_out()
        self.assertEqual((r.status_code, r.json()['code']), (409, 'AUTO_CHECKOUT_UNCONFIRMED'))
        self.assertIsNone(self.row().check_out)

    def test_a_run_shorter_than_ten_minutes_is_not_enough(self):
        self.outside(8)
        r = self.auto_out()
        self.assertEqual((r.status_code, r.json()['outsideMinutes']), (409, 8))
        self.assertIsNone(self.row().check_out)

    def test_geofence_check_says_when_the_departure_is_due(self):
        d = self.geocheck(TOWN, NOON - timedelta(minutes=5))
        self.assertEqual((d['outsideMinutes'], d['departureDue'], d['timeoutMinutes'], d['warningSeconds']),
                         (0, False, 10, 10))
        self.assertTrue(d['warningSound'])
        d = self.geocheck(TOWN, NOON + timedelta(minutes=4))
        self.assertEqual((d['outsideMinutes'], d['departureDue']), (9, True))
        d = self.geocheck(NEAR, NOON + timedelta(minutes=5))           # back inside
        self.assertEqual((d['outsideMinutes'], d['departureDue']), (None, False))

    def test_a_sleep_gap_restarts_the_run(self):
        self.geocheck(TOWN, datetime(2026, 11, 2, 9, 30))
        self.geocheck(TOWN, datetime(2026, 11, 2, 9, 35))
        self.geocheck(TOWN, datetime(2026, 11, 2, 11, 58))           # woke up 2 h later
        self.assertEqual(self.row().outside_since, datetime(2026, 11, 2, 11, 58))
        self.assertEqual(self.auto_out().status_code, 409)

    def test_stale_run_does_not_count(self):
        for k in (40, 35, 30, 25, 20, 15):
            self.geocheck(TOWN, NOON - timedelta(minutes=k))
        # last reading 15 min ago: the tab stopped sampling (sleep / no network)
        self.assertEqual(self.auto_out().status_code, 409)
        self.assertIsNone(self.row().check_out)

    def test_back_inside_clears_the_run(self):
        self.outside(20, end=NOON - timedelta(minutes=2))
        self.geocheck(NEAR, NOON - timedelta(minutes=1))
        self.assertIsNone(self.row().outside_since)
        self.assertEqual(self.auto_out().status_code, 409)

    def test_vague_readings_neither_extend_nor_clear(self):
        self.geocheck(TOWN, NOON - timedelta(minutes=15))
        self.geocheck(TOWN, NOON - timedelta(minutes=10), acc=3000)
        self.geocheck(TOWN, NOON - timedelta(minutes=5))
        self.assertEqual(self.row().outside_since, NOON - timedelta(minutes=15))

    def test_a_real_departure_checks_out_at_the_time_they_left(self):
        self.outside(12)
        r = self.auto_out()
        self.assertEqual(r.status_code, 200, r.content)
        row = self.row()
        self.assertEqual(row.auto_checkout_at, NOON)                  # when the system acted
        self.assertEqual(row.check_out, NOON - timedelta(minutes=12))  # hours end when they left
        self.assertTrue(row.is_auto_checked_out)
        self.assertEqual(row.worked_minutes, 168)                     # 09:00 → 11:48, not → 12:00
        self.assertIn('>12 minutes', row.note)
        self.assertIsNone(row.outside_since)
        self.assertTrue(r.json()['autoCheckedOut'])

    def test_generic_true_flag_is_a_manual_checkout_not_an_auto_one(self):
        r = self.auto_out(auto='true')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(self.row().auto_checkout_at)
        self.assertEqual(self.row().check_out, NOON)

    def test_policy_disabled_refuses(self):
        self.set_policy(enabled=False)
        self.outside(20)
        d = self.geocheck(TOWN, NOON)
        self.assertFalse(d['departureDue'])
        self.assertEqual(self.auto_out().status_code, 409)
        self.assertIsNone(self.row().check_out)

    def test_policy_timeout_is_respected(self):
        self.set_policy(timeout_minutes=20)
        self.outside(12)
        self.assertEqual(self.auto_out().status_code, 409)
        self.outside(20, end=NOON + timedelta(minutes=8))
        self.assertEqual(self.auto_out(when=NOON + timedelta(minutes=8)).status_code, 200)


class OffsiteSessionsTests(Base):
    def test_approved_offsite_day_is_never_auto_closed(self):
        self.session(location_lat=TOWN[0], location_lng=TOWN[1], location_status='Approved')
        self.assertTrue(self.geocheck(TOWN, NOON)['offsite'])
        r = self.auto_out()
        self.assertEqual((r.status_code, r.json()['code']), (409, 'NOT_AN_OFFICE_SESSION'))
        self.assertIsNone(self.row().check_out)

    def test_wfh_session_is_never_auto_closed(self):
        self.session(is_wfh=True)
        EmployeeAttendance.objects.filter(email=EMP).update(outside_since=NOON - timedelta(minutes=30),
                                                           outside_last_at=NOON - timedelta(minutes=1))
        r = self.auto_out()
        self.assertEqual((r.status_code, r.json()['code']), (409, 'NOT_AN_OFFICE_SESSION'))
        self.assertIsNone(self.row().check_out)


class NotificationsAndLabelsTests(Base):
    def setUp(self):
        super().setUp()
        self.session()
        self.outside(12)
        r = self.auto_out(distance=1800, fence='HQ', latitude=TOWN[0], longitude=TOWN[1])
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_employee_is_told_why(self):
        n = Notification.objects.get(recipient=EMP, title='Checked out automatically')
        self.assertIn('outside the office for 12 minutes', n.message)
        self.assertIn('about 1.8 km from HQ', n.message)
        self.assertIn("needs your manager's approval", n.message)

    def test_hr_and_the_manager_hear_about_it(self):
        for who in (HR, BOSS):
            n = Notification.objects.get(recipient=who, title='Employee auto checked out')
            self.assertIn('was checked out automatically', n.message)
            self.assertIn('1.8 km from HQ', n.message)

    def test_event_is_labelled_and_audited(self):
        day = self.client_for(HR).get(f'/api/attendance/day-detail?email={EMP}&date=2026-11-02').json()
        self.assertIn('Auto check-out (left office)', [e['label'] for e in day['events']])
        rows = {x.field: x for x in AttendanceAuditLog.objects.filter(attendance_id=self.row().id)}
        self.assertEqual(rows['check_out'].new_value, '2026-11-02 11:48:00')
        self.assertIn('auto_checkout_at', rows)
        self.assertTrue(all(x.source == 'auto_checkout' and x.actor == 'system' for x in rows.values()))


class RecheckinApprovalTests(Base):
    """After an automatic check-out, checking in again needs the manager."""

    def setUp(self):
        super().setUp()
        self.session()
        self.outside(12)
        self.assertEqual(self.auto_out().status_code, 200)
        self.base_worked = self.row().worked_minutes                     # 09:00 → 11:48

    def decide(self, who, action, note=''):
        with at(NOON + timedelta(hours=3)):
            return self.client_for(who).post('/api/my-team/inbox/decide',
                                             {'type': 'recheckin', 'id': self.row().id, 'action': action,
                                              'note': note}, content_type='application/json')

    def test_without_a_reason_it_is_refused(self):
        r = self.check_in(NOON + timedelta(minutes=30))
        self.assertEqual((r.status_code, r.json()['code']), (409, 'RECHECKIN_APPROVAL_REQUIRED'))
        self.assertEqual(r.json()['autoCheckoutTime'], '12:00')
        self.assertIn('needs your manager', r.json()['message'])
        self.assertFalse(self.row().check_out is None)               # still checked out

    def test_with_a_reason_it_is_pending_and_the_manager_is_asked(self):
        r = self.check_in(NOON + timedelta(minutes=30), recheckinReason='Went to the bank, back now')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['recheckinStatus'], 'Pending')
        row = self.row()
        self.assertTrue(row.check_out < row.check_in)                 # checked in
        self.assertEqual(row.recheckin_reason, 'Went to the bank, back now')
        self.assertTrue(Notification.objects.filter(
            recipient=BOSS, title='Check-in after automatic check-out needs approval').exists())
        inbox = self.client_for(BOSS).get('/api/my-team/inbox').json()
        self.assertIn('recheckin:%d' % row.id, [i['key'] for i in inbox['items']])

    def test_pending_time_is_held_then_counted_when_the_manager_approves(self):
        self.check_in(NOON + timedelta(minutes=30), recheckinReason='Back from the bank')
        self.assertEqual(self.check_out(NOON + timedelta(hours=2, minutes=30)).status_code, 200)
        row = self.row()
        self.assertEqual((row.worked_minutes, row.recheckin_held_minutes), (self.base_worked, 120))
        r = self.decide(BOSS, 'approve')
        self.assertEqual(r.status_code, 200, r.content)
        row = self.row()
        self.assertEqual((row.recheckin_status, row.worked_minutes, row.recheckin_held_minutes),
                         ('Approved', self.base_worked + 120, 0))
        self.assertTrue(Notification.objects.filter(recipient=EMP, title='Check-in approved').exists())
        # approved: checking in again is normal
        self.assertEqual(self.check_in(NOON + timedelta(hours=4)).status_code, 201)
        self.assertEqual(self.row().recheckin_status, 'Approved')

    def test_approved_while_still_checked_in_counts_at_checkout(self):
        self.check_in(NOON + timedelta(minutes=30), recheckinReason='Back from the bank')
        self.assertEqual(self.decide(HR, 'approve').status_code, 200)
        self.check_out(NOON + timedelta(hours=4, minutes=30))
        self.assertEqual(self.row().worked_minutes, self.base_worked + 240)

    def test_rejection_closes_the_session_and_nothing_counts(self):
        from api import views
        from api.models import AttendanceEvent
        AttendanceEvent.objects.create(email=EMP, date=DAY, event='check-in', location='HQ',
                                       at=datetime(2026, 11, 2, 9, 0))      # the morning's session trail
        self.check_in(NOON + timedelta(minutes=30), recheckinReason='Back from the bank')
        r = self.decide(BOSS, 'reject', 'You were at home')
        self.assertEqual(r.status_code, 200, r.content)
        row = self.row()
        self.assertEqual(row.recheckin_status, 'Rejected')
        self.assertEqual(row.check_out, NOON + timedelta(hours=3))     # closed at the decision
        self.assertEqual(row.worked_minutes, self.base_worked)         # not counted
        self.assertEqual(views._recompute_worked(row), self.base_worked)
        self.assertIn('You were at home', Notification.objects.get(recipient=EMP,
                                                                    title='Check-in not approved').message)
        r = self.check_in(NOON + timedelta(hours=3, minutes=10), recheckinReason='Please')
        self.assertEqual((r.status_code, r.json()['code']), (403, 'RECHECKIN_REJECTED'))

    def test_rejecting_held_time_drops_it(self):
        self.check_in(NOON + timedelta(minutes=30), recheckinReason='Back from the bank')
        self.check_out(NOON + timedelta(hours=1, minutes=30))
        self.assertEqual(self.decide(BOSS, 'reject').status_code, 200)
        row = self.row()
        self.assertEqual((row.worked_minutes, row.recheckin_held_minutes), (self.base_worked, 0))

    def test_self_approval_and_strangers_are_refused(self):
        self.check_in(NOON + timedelta(minutes=30), recheckinReason='Back from the bank')
        pk = self.row().id
        with at(NOON + timedelta(hours=1)):
            r = self.c.post(f'/api/attendance/recheckin/{pk}/decide', {'action': 'approve'},
                            content_type='application/json')
        self.assertEqual((r.status_code, r.json()['code']), (403, 'SELF_APPROVAL'))
        self.assertEqual(self.decide(EMP, 'approve').status_code, 403)
        with at(NOON + timedelta(hours=1)):
            r = self.client_for(PEER).post(f'/api/attendance/recheckin/{pk}/decide', {'action': 'approve'},
                                           content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.row().recheckin_status, 'Pending')

    def test_a_second_session_while_pending_joins_the_same_request(self):
        self.check_in(NOON + timedelta(minutes=30), recheckinReason='Back from the bank')
        self.check_out(NOON + timedelta(hours=1, minutes=30))
        self.assertEqual(self.check_in(NOON + timedelta(hours=2)).status_code, 201)   # no new reason
        self.check_out(NOON + timedelta(hours=3))
        self.assertEqual(self.row().recheckin_held_minutes, 120)

    def test_switched_off_by_policy_it_is_a_normal_check_in(self):
        self.set_policy(recheckin_requires_approval=False)
        r = self.check_in(NOON + timedelta(minutes=30))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['recheckinStatus'], '')
        self.check_out(NOON + timedelta(hours=1, minutes=30))
        self.assertEqual(self.row().worked_minutes, self.base_worked + 60)


class PolicyEndpointTests(Base):
    def test_defaults(self):
        d = self.c.get('/api/attendance/departure-policy').json()
        self.assertEqual(d, {'enabled': True, 'timeout_minutes': 10, 'warning_seconds': 10,
                             'warning_sound': True, 'recheckin_requires_approval': True})

    def test_admin_saves_and_bad_values_are_refused(self):
        hr = self.client_for(HR)
        r = hr.post('/api/attendance/departure-policy', {'timeout_minutes': 15, 'warning_seconds': 20,
                                                         'warning_sound': False}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['timeout_minutes'], r.json()['warning_seconds'], r.json()['warning_sound']),
                         (15, 20, False))
        for bad in ({'timeout_minutes': 0}, {'timeout_minutes': 'ten'}, {'warning_seconds': 2},
                    {'warning_seconds': 500}, {'enabled': 'maybe'}):
            r = hr.post('/api/attendance/departure-policy', bad, content_type='application/json')
            self.assertEqual(r.status_code, 400, bad)
        self.assertEqual(self.c.get('/api/attendance/departure-policy').json()['timeout_minutes'], 15)

    def test_employees_cannot_change_it(self):
        r = self.c.post('/api/attendance/departure-policy', {'enabled': False}, content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertTrue(self.c.get('/api/attendance/departure-policy').json()['enabled'])


class ForgottenCheckoutIsNeverAutoClosedTests(Base):
    def test_bulk_auto_correct_stays_disabled(self):
        self.session(date=date(2026, 10, 30), check_in=datetime(2026, 10, 30, 9, 0))
        with at(NOON):
            r = self.client_for(HR).post('/api/attendance/auto-correct', {}, content_type='application/json')
        self.assertEqual((r.status_code, r.json()['code']), (410, 'AUTO_CHECKOUT_REMOVED'))
        self.assertIsNone(EmployeeAttendance.objects.get(email=EMP, date=date(2026, 10, 30)).check_out)

    def test_inside_all_day_and_forgot_to_check_out_nothing_closes(self):
        self.session()
        for h in range(10, 23):
            self.geocheck(NEAR, datetime(2026, 11, 2, h, 0))
        self.assertIsNone(self.row().check_out)
        self.assertEqual(self.auto_out(when=datetime(2026, 11, 2, 22, 0)).status_code, 409)

    def test_a_manual_check_out_then_check_in_needs_no_approval(self):
        self.session()
        self.check_out(NOON)
        r = self.check_in(NOON + timedelta(minutes=30))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.row().recheckin_status, '')
