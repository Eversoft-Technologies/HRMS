"""Onsite, hybrid and remote employees — and what happens when that changes.

Work arrangement is a property of the person, effective-dated. The dating is
the part that earns its keep: a check-in in March has to stay judged by the
arrangement in force in March, not by whatever it was changed to since, or
every recomputation of an old month is wrong.

Agreed behaviour:
  * remote          -> works remotely any day, no request
  * hybrid + anchor -> those weekdays only; anything else needs a request
    days
  * hybrid + quota  -> N self-chosen days a week; past that, needs a request
  * onsite          -> geofence applies; remote needs an approved request
  * no arrangement  -> unchanged from before (the WFH request flow)
"""
import os
import sys
from datetime import date, timedelta

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import (AppUser, EmployeeAttendance, GeoFence, Permission,
                        Role, RolePermission, WorkArrangement)
from api.timeutil import local_today
from api.views import arrangement_for, remote_allowance_check

OFFICE_LAT, OFFICE_LNG = 17.4485, 78.3908
FAR_LAT, FAR_LNG = 12.9716, 77.5946


def monday_of_this_week():
    t = local_today()
    return t - timedelta(days=t.weekday())


class ArrangementResolutionTests(TestCase):
    """arrangement_for() must answer 'as at a date', not 'the latest one'."""

    def setUp(self):
        self.email = 'mover@example.com'
        # Onsite until end of March, hybrid from April, remote from June.
        WorkArrangement.objects.create(
            email=self.email, arrangement='onsite',
            effective_from=date(2026, 1, 1), effective_to=date(2026, 3, 31))
        WorkArrangement.objects.create(
            email=self.email, arrangement='hybrid', remote_days_per_week=2,
            effective_from=date(2026, 4, 1), effective_to=date(2026, 5, 31))
        WorkArrangement.objects.create(
            email=self.email, arrangement='remote',
            effective_from=date(2026, 6, 1))

    def test_resolves_the_row_in_force_on_a_past_date(self):
        self.assertEqual(arrangement_for(self.email, date(2026, 2, 14)).arrangement, 'onsite')
        self.assertEqual(arrangement_for(self.email, date(2026, 4, 15)).arrangement, 'hybrid')
        self.assertEqual(arrangement_for(self.email, date(2026, 9, 1)).arrangement, 'remote')

    def test_boundaries_belong_to_the_row_that_starts(self):
        self.assertEqual(arrangement_for(self.email, date(2026, 3, 31)).arrangement, 'onsite')
        self.assertEqual(arrangement_for(self.email, date(2026, 4, 1)).arrangement, 'hybrid')

    def test_before_the_first_arrangement_there_is_none(self):
        self.assertIsNone(arrangement_for(self.email, date(2025, 12, 31)))

    def test_an_open_ended_row_never_expires(self):
        self.assertEqual(arrangement_for(self.email, date(2030, 1, 1)).arrangement, 'remote')

    def test_someone_elses_arrangement_is_not_borrowed(self):
        self.assertIsNone(arrangement_for('other@example.com', date(2026, 9, 1)))


class AllowanceRuleTests(TestCase):
    """The rules themselves, without the HTTP layer in the way."""

    def _arr(self, email, **kw):
        kw.setdefault('effective_from', date(2020, 1, 1))
        return WorkArrangement.objects.create(email=email, **kw)

    def test_remote_may_work_remotely_any_day(self):
        self._arr('r@x.com', arrangement='remote')
        for offset in range(7):
            allowed, _ = remote_allowance_check('r@x.com', monday_of_this_week() + timedelta(days=offset))
            self.assertTrue(allowed)

    def test_onsite_may_not(self):
        self._arr('o@x.com', arrangement='onsite')
        allowed, why = remote_allowance_check('o@x.com', local_today())
        self.assertFalse(allowed)
        self.assertIn('office-based', why)

    def test_no_arrangement_falls_back_to_the_request_flow(self):
        allowed, why = remote_allowance_check('nobody@x.com', local_today())
        self.assertFalse(allowed)
        self.assertIn('work-from-home request', why)

    # ── hybrid with anchor days ──────────────────────────────────────────
    def test_anchor_days_allow_only_those_weekdays(self):
        self._arr('h@x.com', arrangement='hybrid', remote_weekdays='0,4')  # Mon, Fri
        monday = monday_of_this_week()
        self.assertTrue(remote_allowance_check('h@x.com', monday)[0])
        self.assertTrue(remote_allowance_check('h@x.com', monday + timedelta(days=4))[0])
        self.assertFalse(remote_allowance_check('h@x.com', monday + timedelta(days=1))[0])

    def test_a_non_anchor_day_says_which_days_are_allowed(self):
        self._arr('h2@x.com', arrangement='hybrid', remote_weekdays='0,4')
        _, why = remote_allowance_check('h2@x.com', monday_of_this_week() + timedelta(days=1))
        self.assertIn('Tuesday', why)
        self.assertIn('Monday, Friday', why)

    def test_anchor_days_are_not_capped_by_a_quota(self):
        """Naming the days IS the rule; a stale quota must not fight it."""
        self._arr('h3@x.com', arrangement='hybrid', remote_weekdays='0,1,2,3,4',
                  remote_days_per_week=1)
        monday = monday_of_this_week()
        for offset in range(5):
            self.assertTrue(remote_allowance_check('h3@x.com', monday + timedelta(days=offset))[0])

    # ── hybrid with a weekly quota ───────────────────────────────────────
    def test_quota_allows_up_to_the_cap(self):
        self._arr('q@x.com', arrangement='hybrid', remote_days_per_week=2)
        self.assertTrue(remote_allowance_check('q@x.com', monday_of_this_week())[0])

    def test_quota_runs_out(self):
        self._arr('q2@x.com', arrangement='hybrid', remote_days_per_week=2)
        monday = monday_of_this_week()
        for offset in (0, 1):
            EmployeeAttendance.objects.create(
                email='q2@x.com', date=monday + timedelta(days=offset), is_wfh=True)
        allowed, why = remote_allowance_check('q2@x.com', monday + timedelta(days=2))
        self.assertFalse(allowed)
        self.assertIn('already used your 2 remote days', why)

    def test_last_weeks_remote_days_do_not_count(self):
        self._arr('q3@x.com', arrangement='hybrid', remote_days_per_week=2)
        monday = monday_of_this_week()
        for offset in (-7, -6, -5):
            EmployeeAttendance.objects.create(
                email='q3@x.com', date=monday + timedelta(days=offset), is_wfh=True)
        self.assertTrue(remote_allowance_check('q3@x.com', monday)[0])

    def test_today_does_not_count_against_itself(self):
        """The row exists before the check runs; counting it would make the
        first remote day of the week look like the second."""
        self._arr('q4@x.com', arrangement='hybrid', remote_days_per_week=1)
        monday = monday_of_this_week()
        EmployeeAttendance.objects.create(email='q4@x.com', date=monday, is_wfh=True)
        self.assertTrue(remote_allowance_check('q4@x.com', monday)[0])

    def test_a_hybrid_row_with_no_entitlement_grants_nothing(self):
        self._arr('q5@x.com', arrangement='hybrid')
        self.assertFalse(remote_allowance_check('q5@x.com', local_today())[0])

    def test_an_unrecognised_arrangement_does_not_grant_remote_work(self):
        self._arr('weird@x.com', arrangement='sabbatical')
        self.assertFalse(remote_allowance_check('weird@x.com', local_today())[0])


class ArrangementCheckInTests(TestCase):
    """End to end, through the check-in endpoint, with a fence in place."""

    def setUp(self):
        self.client = Client()
        self.email = 'employee@example.com'
        AppUser.objects.create(email=self.email, status='active', role='employee')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)

    def _check_in(self, **extra):
        payload = {'email': self.email, 'employee': 'Test Person'}
        payload.update(extra)
        return self.client.post('/api/attendance/check-in', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)

    def _arr(self, **kw):
        kw.setdefault('effective_from', date(2020, 1, 1))
        return WorkArrangement.objects.create(email=self.email, **kw)

    def test_a_remote_employee_checks_in_from_anywhere_without_a_request(self):
        self._arr(arrangement='remote')
        resp = self._check_in(isWfh=True, latitude=FAR_LAT, longitude=FAR_LNG)
        self.assertIn(resp.status_code, (200, 201))
        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertTrue(row.is_wfh)
        self.assertEqual(row.location_status, '')

    def test_an_onsite_employee_is_still_refused(self):
        self._arr(arrangement='onsite')
        resp = self._check_in(isWfh=True)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json().get('code'), 'WFH_APPROVAL_REQUIRED')
        self.assertIn('office-based', resp.json().get('message', ''))

    def test_an_onsite_employee_checks_in_normally_at_the_office(self):
        self._arr(arrangement='onsite')
        resp = self._check_in(latitude=OFFICE_LAT, longitude=OFFICE_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.assertTrue(EmployeeAttendance.objects.get(
            email=self.email, date=local_today()).geo_verified)

    def test_a_hybrid_employee_over_quota_is_told_to_file_a_request(self):
        self._arr(arrangement='hybrid', remote_days_per_week=1)
        monday = monday_of_this_week()
        other = monday if local_today() != monday else monday + timedelta(days=1)
        EmployeeAttendance.objects.create(email=self.email, date=other, is_wfh=True)
        resp = self._check_in(isWfh=True)
        self.assertEqual(resp.status_code, 403)
        self.assertIn('remote day', resp.json().get('message', ''))

    def test_a_remote_arrangement_does_not_mark_office_days_as_wfh(self):
        """It permits a remote claim; it must not invent one."""
        self._arr(arrangement='remote')
        resp = self._check_in(latitude=OFFICE_LAT, longitude=OFFICE_LNG)
        self.assertIn(resp.status_code, (200, 201))
        self.assertFalse(EmployeeAttendance.objects.get(
            email=self.email, date=local_today()).is_wfh)


class RosterTests(TestCase):
    """The employee list behind the arrangement dropdown."""

    def setUp(self):
        self.client = Client()
        self.admin = 'hrm@example.com'
        AppUser.objects.create(
            email=self.admin, full_name='HR Person', status='active',
            role='employee', role_ref=Role.objects.filter(name='HR Manager').first())
        AppUser.objects.create(email='active@x.com', full_name='Active Person',
                               status='active', role='employee', password='hunter2')
        AppUser.objects.create(email='gone@x.com', full_name='Left Person',
                               status='disabled', role='employee')

    def _get(self, who=None):
        return self.client.get('/api/attendance/roster',
                               **({'HTTP_X_USER_EMAIL': who} if who else {}))

    def test_lists_active_employees(self):
        rows = self._get(self.admin).json()
        self.assertIn('active@x.com', [r['email'] for r in rows])

    def test_excludes_disabled_accounts(self):
        """Offering someone who has left invites setting an arrangement that
        can never apply."""
        rows = self._get(self.admin).json()
        self.assertNotIn('gone@x.com', [r['email'] for r in rows])

    def test_returns_only_email_and_name(self):
        """This schema stores passwords in plain text, so a roster that leaked
        the whole AppUser row would hand them to every attendance screen."""
        rows = self._get(self.admin).json()
        self.assertTrue(rows)
        for r in rows:
            self.assertEqual(set(r.keys()), {'email', 'name'})

    def test_no_password_anywhere_in_the_payload(self):
        self.assertNotIn('hunter2', self._get(self.admin).content.decode())

    def test_falls_back_to_the_email_when_no_name_is_set(self):
        AppUser.objects.create(email='nameless@x.com', full_name='',
                               status='active', role='employee')
        rows = {r['email']: r['name'] for r in self._get(self.admin).json()}
        self.assertEqual(rows['nameless@x.com'], 'nameless@x.com')

    def test_an_anonymous_caller_gets_nothing(self):
        self.assertEqual(self._get().status_code, 401)

    def test_a_plain_employee_cannot_enumerate_staff(self):
        AppUser.objects.create(email='nosy@x.com', status='active', role='employee')
        self.assertEqual(self._get('nosy@x.com').status_code, 403)


class ArrangementApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.admin = 'hrm@example.com'
        AppUser.objects.create(
            email=self.admin, status='active', role='employee',
            role_ref=Role.objects.filter(name='HR Manager').first())
        self.target = 'employee@example.com'

    def _post(self, who=None, **body):
        body.setdefault('email', self.target)
        return self.client.post('/api/attendance/arrangements', data=body,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=who or self.admin)

    def test_creating_an_arrangement(self):
        resp = self._post(arrangement='hybrid', remoteWeekdays=[0, 4],
                          effectiveFrom='2026-04-01')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['remoteWeekdays'], [0, 4])

    def test_weekday_names_are_accepted(self):
        resp = self._post(arrangement='hybrid', remoteWeekdays='Mon,Fri')
        self.assertEqual(resp.json()['remoteWeekdays'], [0, 4])

    def test_a_change_closes_the_previous_row_instead_of_editing_it(self):
        self._post(arrangement='onsite', effectiveFrom='2026-01-01')
        self._post(arrangement='remote', effectiveFrom='2026-06-01')

        rows = WorkArrangement.objects.filter(email=self.target).order_by('effective_from')
        self.assertEqual(len(rows), 2, 'the old arrangement must survive the change')
        self.assertEqual(rows[0].effective_to, date(2026, 5, 31),
                         'the old row must end the day before the new one starts')
        self.assertIsNone(rows[1].effective_to)
        # And the history still answers correctly for a date in the past.
        self.assertEqual(arrangement_for(self.target, date(2026, 3, 1)).arrangement, 'onsite')

    def test_a_same_day_correction_replaces_rather_than_stacking(self):
        self._post(arrangement='onsite', effectiveFrom='2026-01-01')
        self._post(arrangement='remote', effectiveFrom='2026-01-01')
        rows = WorkArrangement.objects.filter(email=self.target)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].arrangement, 'remote')

    def test_backdating_behind_a_future_row_is_refused(self):
        self._post(arrangement='remote', effectiveFrom='2026-06-01')
        resp = self._post(arrangement='onsite', effectiveFrom='2026-01-01')
        self.assertEqual(resp.status_code, 409)

    def test_hybrid_with_no_entitlement_is_refused_at_the_door(self):
        resp = self._post(arrangement='hybrid')
        self.assertEqual(resp.status_code, 400)

    def test_an_unknown_arrangement_is_refused(self):
        self.assertEqual(self._post(arrangement='sabbatical').status_code, 400)

    def test_deleting_a_row_reopens_what_it_superseded(self):
        self._post(arrangement='onsite', effectiveFrom='2026-01-01')
        second = self._post(arrangement='remote', effectiveFrom='2026-06-01').json()

        resp = self.client.delete(f'/api/attendance/arrangements/{second["id"]}',
                                  HTTP_X_USER_EMAIL=self.admin)
        self.assertEqual(resp.status_code, 200)
        remaining = WorkArrangement.objects.get(email=self.target)
        self.assertIsNone(remaining.effective_to,
                          'deleting the successor must leave no gap in cover')

    # ── permission boundary ──────────────────────────────────────────────
    def test_a_plain_employee_cannot_set_their_own_arrangement(self):
        AppUser.objects.create(email='sneaky@x.com', status='active', role='employee')
        resp = self.client.post(
            '/api/attendance/arrangements',
            data={'email': 'sneaky@x.com', 'arrangement': 'remote'},
            content_type='application/json', HTTP_X_USER_EMAIL='sneaky@x.com')
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(WorkArrangement.objects.filter(email='sneaky@x.com').exists())

    def test_the_permission_is_separately_grantable(self):
        role, _ = Role.objects.get_or_create(name='Ops Lead')
        perm = Permission.objects.filter(code='attendance.manage_arrangement').first()
        self.assertIsNotNone(perm, 'migration 0043 must seed the permission')
        RolePermission.objects.get_or_create(role_id=role.id, permission=perm)
        AppUser.objects.create(email='ops@x.com', status='active',
                               role='employee', role_ref=role)
        self.assertEqual(self._post('ops@x.com', arrangement='remote').status_code, 201)
