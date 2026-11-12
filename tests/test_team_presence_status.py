"""/api/attendance/team carries each person's own status (``presence``) — what
chat headers and avatar dots show — separately from their location
(``status``: In Office / Remote / In Break / Absent)."""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, EmployeeAttendance, Shift, ShiftAssignment

DAY = date(2026, 11, 2)


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()):
        yield


class TeamPresenceStatusTests(TestCase):
    def setUp(self):
        self.c = Client(HTTP_X_USER_EMAIL='viewer@example.com')
        AppUser.objects.create(email='viewer@example.com', full_name='Viewer', status='active', role='admin')

    def person(self, email, presence='', **kw):
        AppUser.objects.create(email=email, full_name=email.split('@')[0], status='active', role='recruitment')
        if kw.get('checked_in', True):
            EmployeeAttendance.objects.create(email=email, date=kw.get('day', DAY),
                                              check_in=kw.get('check_in', datetime(2026, 11, 2, 9, 0)),
                                              presence=presence, shift_id=kw.get('shift_id'))

    def team(self, when=datetime(2026, 11, 2, 12, 0)):
        with at(when):
            return {r['email']: r for r in self.c.get('/api/attendance/team').json()}

    def test_status_not_location(self):
        self.person('plain@example.com')
        self.person('busy@example.com', 'Busy')
        self.person('dnd@example.com', 'Do not disturb')
        self.person('brk@example.com', 'Away')
        self.person('ghost@example.com', 'Invisible')
        self.person('out@example.com', checked_in=False)
        t = self.team()
        self.assertEqual((t['plain@example.com']['presence'], t['plain@example.com']['status']), ('Available', 'In Office'))
        self.assertEqual(t['busy@example.com']['presence'], 'Busy')
        self.assertEqual(t['dnd@example.com']['presence'], 'Do not disturb')
        self.assertEqual((t['brk@example.com']['presence'], t['brk@example.com']['status']), ('In Break', 'In Break'))
        self.assertEqual(t['ghost@example.com']['presence'], 'Offline')        # invisible to others
        self.assertEqual((t['out@example.com']['presence'], t['out@example.com']['status']), ('Offline', 'Absent'))

    def test_break_from_the_check_in_card_shows_in_chat_status(self):
        self.person('me@example.com')
        me = Client(HTTP_X_USER_EMAIL='me@example.com')
        with at(datetime(2026, 11, 2, 11, 0)):
            r = me.post('/api/attendance/presence', {'email': 'me@example.com', 'label': 'Coffee break'},
                        content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.team()['me@example.com']['presence'], 'In Break')
        with at(datetime(2026, 11, 2, 11, 20)):
            me.post('/api/attendance/presence', {'email': 'me@example.com', 'label': 'Available'},
                    content_type='application/json')
        self.assertEqual(self.team()['me@example.com']['presence'], 'Available')

    def test_night_shift_after_midnight_is_not_offline(self):
        night = Shift.objects.create(name='Night', start_time=time(18, 0), end_time=time(2, 30), is_night_shift=True)
        self.person('night@example.com', 'Busy', check_in=datetime(2026, 11, 2, 18, 30), shift_id=night.id)
        ShiftAssignment.objects.create(email='night@example.com', shift=night, effective_from=DAY - timedelta(days=3))
        t = self.team(datetime(2026, 11, 3, 1, 0))
        self.assertEqual((t['night@example.com']['presence'], t['night@example.com']['status']), ('Busy', 'Busy'))
