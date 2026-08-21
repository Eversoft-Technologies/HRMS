"""Presence has to agree with what the employee actually did.

Three things write to ``employee_attendance.presence``: the STATUS picker, the
Break button, and — as of this change — a location switch. ``_team_status``
shows an explicit presence in preference to the location, which is right for
"Busy" and wrong for a switch the person just made: somebody who picked
"Available" this morning and then hit Switch to Remote went on reading
"Available" to the whole team, with the switch invisible to everyone.

The rule that needs pinning is the exception to it: a *break* label is never
cleared by a location switch. Breaks are ended by break-end, which is also what
accrues the elapsed minutes into "Break taken today" — dropping the label some
other way would quietly lose that time.
"""
import os
import sys
from datetime import timedelta

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import AppUser, AttendanceEvent, EmployeeAttendance
from api.timeutil import local_now, local_today


class PresenceSyncTests(TestCase):
    EMAIL = 'presence@example.test'

    def setUp(self):
        self.client = Client()
        AppUser.objects.create(full_name='Pres Ence', email=self.EMAIL,
                               status='active', role='admin')
        self.att = EmployeeAttendance.objects.create(
            email=self.EMAIL, employee_name='Pres Ence', date=local_today(),
            check_in=local_now() - timedelta(hours=2),
        )

    def _event(self, event, location=''):
        return self.client.post('/api/attendance/events',
                                data={'email': self.EMAIL, 'event': event, 'location': location},
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.EMAIL)

    def _presence(self, label):
        return self.client.post('/api/attendance/presence',
                                data={'email': self.EMAIL, 'label': label,
                                      'key': label.lower(), 'employee': 'Pres Ence'},
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.EMAIL)

    def _team_row(self):
        rows = self.client.get('/api/attendance/team', HTTP_X_USER_EMAIL=self.EMAIL).json()
        return [r for r in rows if r['email'] == self.EMAIL][0]

    # ── the status picker ──────────────────────────────────────────────────
    def test_a_chosen_status_is_what_the_team_sees(self):
        self.assertEqual(self._presence('Busy').status_code, 200)
        self.assertEqual(self._team_row()['status'], 'Busy')

    def test_choosing_a_break_status_starts_a_break(self):
        self._presence('Coffee break')
        self.assertTrue(AttendanceEvent.objects.filter(
            email=self.EMAIL, event='break-start').exists())
        # Every break label collapses to one word for the team panel.
        self.assertEqual(self._team_row()['status'], 'In Break')

    def test_leaving_a_break_status_ends_the_break(self):
        self._presence('Coffee break')
        self._presence('Available')
        self.assertTrue(AttendanceEvent.objects.filter(
            email=self.EMAIL, event='break-end').exists())
        self.assertEqual(self._team_row()['status'], 'Available')

    # ── the Break button ───────────────────────────────────────────────────
    def test_the_break_button_shows_up_as_a_break(self):
        self._event('break-start')
        self.att.refresh_from_db()
        self.assertEqual(self.att.presence, 'Away')
        self.assertEqual(self._team_row()['status'], 'In Break')

    def test_ending_a_break_returns_to_the_location(self):
        self._event('break-start')
        self._event('break-end', 'Office')
        self.att.refresh_from_db()
        self.assertEqual(self.att.presence, '')
        self.assertEqual(self._team_row()['status'], 'In Office')

    # ── switching location ─────────────────────────────────────────────────
    def test_switching_to_remote_replaces_a_stale_status(self):
        self._presence('Available')
        self._event('remote-switch', 'Home')
        self.att.refresh_from_db()
        self.assertEqual(self.att.presence, '')
        self.assertEqual(self._team_row()['status'], 'Remote')

    def test_switching_back_to_the_office_shows_the_office(self):
        self._event('remote-switch', 'Home')
        self._presence('Busy')
        self._event('office-switch', 'Office')
        self.assertEqual(self._team_row()['status'], 'In Office')

    def test_a_location_switch_does_not_cancel_a_break(self):
        """The break label survives, so break-end still finds it and can bill
        the minutes; otherwise the time on break is lost from the day."""
        self._event('break-start')
        self._event('remote-switch', 'Home')
        self.att.refresh_from_db()
        self.assertEqual(self.att.presence, 'Away')
        self.assertEqual(self._team_row()['status'], 'In Break')

        self._event('break-end', 'Home')
        self.att.refresh_from_db()
        self.assertEqual(self.att.presence, '')
        self.assertEqual(self._team_row()['status'], 'Remote')

    def test_presence_cannot_be_set_while_checked_out(self):
        self.att.check_out = local_now()
        self.att.save()
        self.assertEqual(self._presence('Busy').status_code, 409)
        self.assertEqual(self._team_row()['status'], 'Absent')
