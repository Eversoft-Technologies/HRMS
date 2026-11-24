"""Multi-region holiday calendars (Attendance Phase 1 / Workstream H).

Covers the resolver (assignment > location > default > none), national +
exclude, optional days, the no-calendar fallback, absent / LOP suppression on
an employee's own holiday (and only theirs), permissions and CSV import.
"""
import io
from datetime import date, datetime

from django.core.management import call_command
from django.test import Client, TestCase

from api.attendance_ext import holidays as H
from api.attendance_ext.holiday_views import parse_holiday_csv
from api.holiday_calendar import national_holidays
from api.models import (AppUser, EmployeeAttendance, HolidayCalendar, HolidayCalendarAssignment,
                        HolidayCalendarDay, Permission, Role, RolePermission, Shift, UserProfile)

HYD = 'hyd@co.com'
NYC = 'nyc@co.com'
PUN = 'pune@co.com'
NOBODY = 'nobody@co.com'


def client(email=None):
    return Client(HTTP_X_USER_EMAIL=email) if email else Client()


class Base(TestCase):
    def setUp(self):
        manage = Permission.objects.create(code='settings.manage', name='Manage Settings')
        view = Permission.objects.create(code='settings.view', name='View Settings')
        self.super_role = Role.objects.create(name='Super Admin')
        hr = Role.objects.create(name='HR Manager')
        RolePermission.objects.create(role=hr, permission=manage)
        RolePermission.objects.create(role=hr, permission=Permission.objects.create(
            code='holiday.manage', name='Manage Holiday Calendars'))
        viewer = Role.objects.create(name='Settings Viewer')
        RolePermission.objects.create(role=viewer, permission=view)
        emp = Role.objects.create(name='Employee')
        AppUser.objects.create(email='boss@co.com', full_name='Boss', role_ref=self.super_role)
        AppUser.objects.create(email='hr@co.com', full_name='HR', role_ref=hr)
        AppUser.objects.create(email='viewer@co.com', full_name='Viewer', role_ref=viewer)
        for em, loc in ((HYD, 'Hyderabad'), (NYC, 'New York'), (PUN, 'Pune'), (NOBODY, '')):
            AppUser.objects.create(email=em, full_name=em.split('@')[0].title(), role_ref=emp)
            UserProfile.objects.create(email=em, first_name=em.split('@')[0].title(), location=loc)

    def calendars(self):
        self.india = HolidayCalendar.objects.create(name='India', country='IN', is_default=True)
        self.us = HolidayCalendar.objects.create(name='United States', country='US',
                                                 locations=['New York'])
        self.hydcal = HolidayCalendar.objects.create(name='Hyderabad Hub', country='IN',
                                                     locations=['hyderabad'])
        # Bonalu: a Telangana-only holiday on Tue 3 Nov 2026 (test date).
        HolidayCalendarDay.objects.create(calendar=self.hydcal, date=date(2026, 11, 3), name='Bonalu')


class ResolverTests(Base):
    def test_precedence_assignment_location_default_none(self):
        self.calendars()
        self.assertEqual(H.calendar_for(HYD), self.hydcal)          # location (case-insensitive)
        self.assertEqual(H.calendar_for(NYC), self.us)              # location
        self.assertEqual(H.calendar_for(PUN), self.india)           # default
        HolidayCalendarAssignment.objects.create(email=HYD, calendar=self.us)
        self.assertEqual(H.calendar_for(HYD.upper()), self.us)      # assignment wins
        self.india.is_default = False
        self.india.save()
        self.assertIsNone(H.calendar_for(PUN))                      # nothing applies
        self.us.is_active = False
        self.us.save()
        self.assertEqual(H.calendar_for(HYD), self.hydcal)          # inactive assignment ignored

    def test_national_plus_exclude_and_optional(self):
        self.calendars()
        HolidayCalendarDay.objects.create(calendar=self.india, date=date(2026, 1, 26),
                                          name='Republic Day', exclude=True)
        HolidayCalendarDay.objects.create(calendar=self.india, date=date(2026, 3, 20),
                                          name='Ugadi', optional=True)
        HolidayCalendarDay.objects.create(calendar=self.india, date=date(2026, 6, 1),
                                          name='Company Day')
        lst = H.holidays_for(PUN, date(2026, 1, 1), date(2026, 12, 31))
        names = {(h['date'], h['name']) for h in lst}
        self.assertNotIn(('2026-01-26', 'Republic Day'), names)
        self.assertIn(('2026-08-15', 'Independence Day'), names)
        self.assertIn(('2026-06-01', 'Company Day'), names)
        self.assertTrue(all(h['country'] == 'IN' for h in lst))     # no US holidays
        ugadi = [h for h in lst if h['name'] == 'Ugadi'][0]
        self.assertTrue(ugadi['optional'])
        self.assertFalse(ugadi['off'])
        offs = H.holiday_dates(PUN, date(2026, 1, 1), date(2026, 12, 31))
        self.assertIn(date(2026, 8, 15), offs)
        self.assertIn(date(2026, 6, 1), offs)
        self.assertNotIn(date(2026, 3, 20), offs)                    # optional: not a day off
        self.assertNotIn(date(2026, 1, 26), offs)                    # excluded
        self.assertFalse(H.is_holiday(PUN, date(2026, 11, 3)))       # Hyderabad-only
        self.assertTrue(H.is_holiday(HYD, date(2026, 11, 3)))
        # include_national=False drops the national list entirely.
        self.india.include_national = False
        self.india.save()
        self.assertEqual({h['name'] for h in H.holidays_for(PUN, date(2026, 1, 1), date(2026, 12, 31))},
                         {'Company Day', 'Ugadi'})

    def test_no_calendar_fallback_matches_old_behaviour(self):
        old = national_holidays(2026)
        r = client(HYD).get('/api/holidays?year=2026')
        self.assertEqual(r.status_code, 200)
        new = r.json()
        self.assertEqual([{k: h[k] for k in ('date', 'name', 'country', 'type')} for h in new], old)
        self.assertTrue(all(h['optional'] is False and h['calendar'] is None for h in new))
        # Anonymous still works, as before.
        self.assertEqual(len(client().get('/api/holidays?year=2026').json()), len(old))
        # ... and nothing is a day off, so attendance / payroll are unchanged.
        self.assertEqual(H.holiday_dates(HYD, date(2026, 1, 1), date(2026, 12, 31)), frozenset())

    def test_seed_command_idempotent(self):
        call_command('seed_holiday_calendars', stdout=io.StringIO())
        call_command('seed_holiday_calendars', stdout=io.StringIO())
        self.assertEqual(HolidayCalendar.objects.count(), 2)
        self.assertTrue(HolidayCalendar.objects.get(name='India (default)').is_default)
        self.assertFalse(HolidayCalendar.objects.get(name='United States').is_default)


class DayOffEffectTests(Base):
    """Hyderabad has Bonalu on Tue 3 Nov 2026; New York works that day.
    Both are present Mon 2 and Wed 4 and have no row (or an 'absent' row) on 3."""

    def setUp(self):
        super().setUp()
        self.calendars()
        for em in (HYD, NYC):
            for d in (2, 4):
                EmployeeAttendance.objects.create(email=em, date=date(2026, 11, d), status='present')

    def test_payroll_lop_zero_on_own_holiday_only(self):
        from api.services.payroll_service import PayrollService
        rows = {r['email']: r for r in PayrollService.step_fetch_attendance(date(2026, 11, 2), date(2026, 11, 4))}
        self.assertEqual(rows[HYD]['lop_days'], 0.0)
        self.assertEqual(rows[NYC]['lop_days'], 1.0)
        calc_h = PayrollService.calculate_employee_pay(HYD, date(2026, 11, 2), date(2026, 11, 4))
        calc_n = PayrollService.calculate_employee_pay(NYC, date(2026, 11, 2), date(2026, 11, 4))
        self.assertEqual(float(calc_h['lop_days']), 0.0)
        self.assertEqual(float(calc_n['lop_days']), 1.0)

    def test_us_national_holiday_is_off_for_us_calendar_only(self):
        from api.services.payroll_service import PayrollService
        # Veterans Day, Wed 11 Nov 2026.
        for em in (HYD, NYC):
            for d in (10, 12):
                EmployeeAttendance.objects.create(email=em, date=date(2026, 11, d), status='present')
        rows = {r['email']: r for r in PayrollService.step_fetch_attendance(date(2026, 11, 10), date(2026, 11, 12))}
        self.assertEqual(rows[NYC]['lop_days'], 0.0)
        self.assertEqual(rows[HYD]['lop_days'], 1.0)

    def test_absent_row_on_own_holiday_is_not_absent(self):
        from api.services.attendance_service import AttendanceService
        for em in (HYD, NYC):
            EmployeeAttendance.objects.create(email=em, date=date(2026, 11, 3), status='absent')
        h = AttendanceService.get_attendance_summary(HYD, date(2026, 11, 2), date(2026, 11, 4))
        n = AttendanceService.get_attendance_summary(NYC, date(2026, 11, 2), date(2026, 11, 4))
        self.assertEqual(h['absent'], 0)
        self.assertEqual(h['holiday'], 1)
        self.assertEqual(n['absent'], 1)
        self.assertEqual(n['holiday'], 0)

    def test_late_sweep_skips_own_holiday(self):
        from api import attendance_alerts
        Shift.objects.create(id=1, name='General', grace_minutes=15)
        now = datetime(2026, 11, 3, 11, 0)
        notified = attendance_alerts.run_late_sweep(now=now, dry_run=True)
        self.assertNotIn(HYD, notified)
        self.assertIn(NYC, notified)

    def test_payroll_unchanged_without_calendars(self):
        from api.services.payroll_service import PayrollService
        HolidayCalendar.objects.all().delete()
        rows = {r['email']: r for r in PayrollService.step_fetch_attendance(date(2026, 11, 2), date(2026, 11, 4))}
        self.assertEqual(rows[HYD]['lop_days'], 1.0)
        self.assertEqual(rows[NYC]['lop_days'], 1.0)


class ApiTests(Base):
    def setUp(self):
        super().setUp()
        self.calendars()

    def test_caller_gets_own_calendar_from_holidays(self):
        lst = client(HYD).get('/api/holidays?year=2026').json()
        self.assertTrue(all(h['calendar'] == 'Hyderabad Hub' for h in lst))
        bon = [h for h in lst if h['name'] == 'Bonalu'][0]
        self.assertEqual(bon['date'], '2026-11-03')
        self.assertEqual(bon['country'], 'IN')
        self.assertIn('type', bon)
        us = client(NYC).get('/api/holidays?year=2026').json()
        self.assertTrue(all(h['country'] == 'US' for h in us))
        self.assertEqual(client(HYD).get('/api/holidays?year=abc').status_code, 400)

    def test_holidays_admin_params_are_gated(self):
        self.assertEqual(client(HYD).get('/api/holidays?year=2026&all=1').status_code, 403)
        self.assertEqual(client(HYD).get(f'/api/holidays?year=2026&calendar={self.us.id}').status_code, 403)
        self.assertEqual(client(HYD).get(f'/api/holidays?year=2026&calendar={self.hydcal.id}').status_code, 200)
        self.assertEqual(client(HYD).get(f'/api/holidays?year=2026&email={NYC}').status_code, 403)
        self.assertEqual(client().get('/api/holidays?year=2026&all=1').status_code, 401)
        r = client('viewer@co.com').get('/api/holidays?year=2026&all=1')
        self.assertEqual(r.status_code, 200)
        self.assertEqual({h['calendar'] for h in r.json()}, {'India', 'United States', 'Hyderabad Hub'})
        r = client('viewer@co.com').get(f'/api/holidays?year=2026&email={NYC}')
        self.assertTrue(all(h['country'] == 'US' for h in r.json()))

    def test_calendar_list_scoped_for_employees(self):
        r = client(HYD).get('/api/holiday-calendars').json()
        self.assertEqual([c['name'] for c in r['calendars']], ['Hyderabad Hub'])
        self.assertFalse(r['canManage'])
        r = client('viewer@co.com').get('/api/holiday-calendars').json()
        self.assertEqual(len(r['calendars']), 3)
        self.assertFalse(r['canManage'])
        counts = {c['name']: c['employeeCount'] for c in r['calendars']}
        # boss/hr/viewer/pune/nobody fall to the default India calendar.
        self.assertEqual(counts['Hyderabad Hub'], 1)
        self.assertEqual(counts['United States'], 1)
        self.assertEqual(counts['India'], 5)
        self.assertEqual(client().get('/api/holiday-calendars').status_code, 401)

    def test_write_requires_settings_manage(self):
        body = {'name': 'California', 'country': 'US', 'locations': ['San Jose']}
        self.assertEqual(client(HYD).post('/api/holiday-calendars', body, content_type='application/json').status_code, 403)
        self.assertEqual(client('viewer@co.com').post('/api/holiday-calendars', body, content_type='application/json').status_code, 403)
        r = client('hr@co.com').post('/api/holiday-calendars', body, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        cid = r.json()['id']
        # Duplicate name / clashing location / bad country rejected.
        self.assertEqual(client('hr@co.com').post('/api/holiday-calendars', body, content_type='application/json').status_code, 400)
        self.assertEqual(client('hr@co.com').post('/api/holiday-calendars', {'name': 'X', 'locations': ['NEW YORK']},
                                                 content_type='application/json').status_code, 400)
        self.assertEqual(client('hr@co.com').post('/api/holiday-calendars', {'name': 'Y', 'country': 'USA'},
                                                 content_type='application/json').status_code, 400)
        # Making it default unsets the old default.
        r = client('hr@co.com').patch(f'/api/holiday-calendars/{cid}', {'isDefault': True}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.india.refresh_from_db()
        self.assertFalse(self.india.is_default)
        # Days: add, exclude a national one, edit, delete.
        r = client('hr@co.com').post(f'/api/holiday-calendars/{cid}/days', {'date': '2026-03-31', 'name': 'Cesar Chavez Day'},
                                     content_type='application/json')
        self.assertEqual(r.status_code, 201)
        did = r.json()['id']
        self.assertEqual(client(HYD).delete(f'/api/holiday-calendars/{cid}/days/{did}').status_code, 403)
        r = client('hr@co.com').post(f'/api/holiday-calendars/{cid}/days', {'date': '2026-10-12', 'name': 'Columbus Day', 'exclude': True},
                                     content_type='application/json')
        self.assertEqual(r.status_code, 201)
        r = client('hr@co.com').get(f'/api/holiday-calendars/{cid}/days?year=2026').json()
        col = [h for h in r['national'] if h['name'] == 'Columbus Day'][0]
        self.assertTrue(col['excluded'])
        self.assertNotIn('Columbus Day', [h['name'] for h in r['resolved']])
        self.assertIn('Cesar Chavez Day', [h['name'] for h in r['resolved']])
        r = client('hr@co.com').patch(f'/api/holiday-calendars/{cid}/days/{did}', {'optional': True}, content_type='application/json')
        self.assertTrue(r.json()['optional'])
        self.assertEqual(client('hr@co.com').delete(f'/api/holiday-calendars/{cid}/days/{did}').status_code, 200)
        self.assertEqual(client('hr@co.com').delete(f'/api/holiday-calendars/{cid}').status_code, 200)

    def test_assignments_single_bulk_and_location(self):
        url = '/api/holiday-calendars/assignments'
        self.assertEqual(client(HYD).get(url).status_code, 403)
        self.assertEqual(client(HYD).post(url, {'calendarId': self.us.id, 'emails': [HYD]},
                                          content_type='application/json').status_code, 403)
        r = client('hr@co.com').post(url, {'calendarId': self.us.id, 'emails': [HYD, 'ghost@co.com']},
                                     content_type='application/json').json()
        self.assertEqual(r['changed'], 1)
        self.assertEqual(r['unknown'], ['ghost@co.com'])
        self.assertEqual(H.calendar_for(HYD), self.us)
        r = client('hr@co.com').post(url, {'calendarId': self.hydcal.id, 'location': 'pune'},
                                     content_type='application/json').json()
        self.assertEqual(r['emails'], [PUN])
        self.assertEqual(H.calendar_for(PUN), self.hydcal)
        client('hr@co.com').post(url, {'calendarId': None, 'emails': HYD}, content_type='application/json')
        self.assertEqual(H.calendar_for(HYD), self.hydcal)          # back to the location match
        r = client('viewer@co.com').get(url).json()
        via = {e['email']: e['via'] for e in r['employees']}
        self.assertEqual(via[PUN], 'assignment')
        self.assertEqual(via[HYD], 'location')
        self.assertEqual(via[NOBODY], 'default')
        self.assertIn('Pune', r['locations'])


class CsvImportTests(Base):
    def setUp(self):
        super().setUp()
        self.calendars()
        self.url = f'/api/holiday-calendars/{self.hydcal.id}/import'

    def test_parse_validation(self):
        rows, errors = parse_holiday_csv('date,name,optional\n2026-01-14,Sankranti,yes\n\n# note\n'
                                         '2026-13-01,Bad\n2026-04-01,\n2026-05-01,May Day,perhaps\n'
                                         '2026-01-14,sankranti\n2026-06-01\n')
        self.assertEqual(rows, [(date(2026, 1, 14), 'Sankranti', True)])
        self.assertEqual([e['line'] for e in errors], [5, 6, 7, 8, 9])

    def test_import_all_or_nothing_and_upsert(self):
        before = HolidayCalendarDay.objects.count()
        r = client('hr@co.com').post(self.url, {'csv': '2026-01-14,Sankranti\nnot-a-date,Oops'},
                                     content_type='application/json')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['errors'][0]['line'], 2)
        self.assertEqual(HolidayCalendarDay.objects.count(), before)
        self.assertEqual(client(HYD).post(self.url, {'csv': '2026-01-14,Sankranti'},
                                          content_type='application/json').status_code, 403)
        r = client('hr@co.com').post(self.url, {'csv': 'date,name,optional\n2026-01-14,Sankranti,no\n'
                                                       '03/11/2026,Bonalu,yes\n2026-06-02,Telangana Formation Day'},
                                     content_type='application/json').json()
        self.assertEqual((r['created'], r['updated']), (2, 1))
        self.assertTrue(HolidayCalendarDay.objects.get(calendar=self.hydcal, name='Bonalu').optional)
        self.assertFalse(H.is_holiday(HYD, date(2026, 11, 3)))       # now optional: not off
        r = client('hr@co.com').post(self.url, {'csv': '2026-12-01,Only One', 'replace': True},
                                     content_type='application/json').json()
        self.assertEqual(r['removed'], 3)
        self.assertEqual(list(self.hydcal.days.values_list('name', flat=True)), ['Only One'])
