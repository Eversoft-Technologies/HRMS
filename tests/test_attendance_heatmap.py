"""GET /api/attendance/heatmap — check-in density for the live map heatmap."""
from datetime import timedelta

from django.test import Client, TestCase

from api.models import AppUser, AttendanceEvent, UserProfile
from api.timeutil import local_now


class AttendanceHeatmapTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='boss@co.com', full_name='Boss', password='x', role='admin')
        AppUser.objects.create(email='emp@co.com', full_name='Emp', password='x', role='recruitment')
        UserProfile.objects.create(email='a@co.com', department='Sales')
        UserProfile.objects.create(email='b@co.com', department='IT')
        self.boss = Client(HTTP_X_USER_EMAIL='boss@co.com')
        now = local_now()
        today = now.date()

        def ev(email, days_ago, lat, lng, event='check-in'):
            AttendanceEvent.objects.create(email=email, date=today - timedelta(days=days_ago), event=event,
                                           latitude=lat, longitude=lng, at=now - timedelta(days=days_ago))
        ev('a@co.com', 0, 14.343712, 80.066241)
        ev('a@co.com', 1, 14.343714, 80.066243)      # same ~11 m cell as above
        ev('b@co.com', 3, 13.677900, 79.554000)
        ev('b@co.com', 40, 12.0, 77.0)                # outside 30 days
        ev('b@co.com', 0, 13.0, 79.0, event='check-out')   # not a check-in
        AttendanceEvent.objects.create(email='a@co.com', date=today, event='check-in', at=now)  # no location

    def test_default_period_aggregates_check_ins(self):
        r = self.boss.get('/api/attendance/heatmap')
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual((d['days'], d['checkins'], d['people']), (30, 3, 2))
        self.assertEqual(d['points'][0], {'lat': 14.3437, 'lng': 80.0662, 'weight': 2})

    def test_period_and_department_filters(self):
        self.assertEqual(self.boss.get('/api/attendance/heatmap?days=1').json()['checkins'], 1)
        self.assertEqual(self.boss.get('/api/attendance/heatmap?days=90').json()['checkins'], 4)
        self.assertEqual(self.boss.get('/api/attendance/heatmap?days=999').json()['days'], 90)
        it = self.boss.get('/api/attendance/heatmap?department=IT').json()
        self.assertEqual((it['checkins'], it['people']), (1, 1))

    def test_requires_attendance_view(self):
        self.assertEqual(Client().get('/api/attendance/heatmap').status_code, 401)
        self.assertEqual(Client(HTTP_X_USER_EMAIL='emp@co.com').get('/api/attendance/heatmap').status_code, 403)
