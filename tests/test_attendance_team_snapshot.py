"""The Team Status snapshot (GET /api/attendance/team) is requested by every
signed-in browser every few seconds, so it must cost a bounded amount of work
however many people are online: one shared snapshot per short interval, and a
fixed number of queries per rebuild (no per-employee queries)."""
import json
import os
import sys
import threading
import time
from unittest.mock import patch
from datetime import datetime, timedelta

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import views
from api.models import AppUser, AttendanceEvent, EmployeeAttendance, Shift
from api.timeutil import local_now

EMPLOYEES = 400
NIGHT_OPEN = 60          # people still checked in from yesterday's night shift


class TeamSnapshotTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        now = local_now()
        today = now.date()
        yesterday = today - timedelta(days=1)
        night = Shift.objects.create(name='Night', start_time=datetime.strptime('22:00', '%H:%M').time(),
                                     end_time=datetime.strptime('06:00', '%H:%M').time(), is_night_shift=True)
        day = Shift.objects.create(name='Day', start_time=datetime.strptime('09:00', '%H:%M').time(),
                                   end_time=datetime.strptime('18:00', '%H:%M').time(), is_night_shift=False)
        users, atts, events = [], [], []
        for i in range(EMPLOYEES):
            email = f'user{i}@example.com'
            users.append(AppUser(email=email, full_name=f'User {i}', password=''))
            if i < NIGHT_OPEN:
                atts.append(EmployeeAttendance(email=email, date=yesterday, check_in=now - timedelta(hours=9),
                                               shift_id=night.id))
            elif i < NIGHT_OPEN + 200:
                atts.append(EmployeeAttendance(email=email, date=today, check_in=now - timedelta(hours=1),
                                               shift_id=day.id, device='desktop'))
                for k, ev in enumerate(('check-in', 'break-start', 'break-end', 'office-switch')):
                    events.append(AttendanceEvent(email=email, employee_name=f'User {i}', date=today, event=ev,
                                                  location='HQ', at=now - timedelta(minutes=50 - k)))
        AppUser.objects.bulk_create(users)
        EmployeeAttendance.objects.bulk_create(atts)
        AttendanceEvent.objects.bulk_create(events)

    def setUp(self):
        views._team_snapshot_reset()

    def _get(self):
        r = self.client.get('/api/attendance/team')
        self.assertEqual(r.status_code, 200)
        return json.loads(r.content)

    def test_rebuild_cost_does_not_grow_with_the_number_of_employees(self):
        with CaptureQueriesContext(connection) as ctx:
            started = time.perf_counter()
            rows = self._get()
            elapsed = time.perf_counter() - started
        print(f'\n  team rebuild: {len(ctx)} queries, {elapsed * 1000:.0f} ms for {len(rows)} people')
        self.assertEqual(len(rows), EMPLOYEES)
        self.assertLessEqual(len(ctx), 8)

    def test_many_requests_share_one_snapshot(self):
        self._get()
        with CaptureQueriesContext(connection) as ctx:
            for _ in range(50):
                self._get()
        self.assertEqual(len(ctx), 0)               # 50 more pollers, zero queries

    def test_statuses_are_right(self):
        rows = {r['email']: r for r in self._get()}
        self.assertEqual(rows['user0@example.com']['status'], 'In Office')     # night shift still running
        self.assertEqual(rows['user100@example.com']['status'], 'In Office')   # checked in today
        self.assertEqual(rows['user399@example.com']['status'], 'Offline')     # nobody home
        order = [r['status'] for r in self._get()]
        self.assertEqual(order, sorted(order, key=lambda s: {'In Office': 0, 'Remote': 1, 'In Break': 2, 'Offline': 3, 'Absent': 4}.get(s, 9)))

    def test_yesterdays_session_that_is_not_a_night_shift_is_offline(self):
        EmployeeAttendance.objects.filter(email='user0@example.com').update(
            shift_id=Shift.objects.get(name='Day').id)
        views._team_snapshot_reset()
        rows = {r['email']: r for r in self._get()}
        self.assertEqual(rows['user0@example.com']['status'], 'Offline')

    def test_a_change_shows_up_within_a_second_not_a_poll_interval(self):
        before = {r['email']: r['status'] for r in self._get()}
        self.assertEqual(before['user399@example.com'], 'Offline')
        now = local_now()
        att = EmployeeAttendance.objects.create(email='user399@example.com', date=now.date(),
                                                check_in=now, shift_id=Shift.objects.get(name='Day').id)
        AttendanceEvent.objects.create(email='user399@example.com', date=now.date(), event='check-in',
                                       location='HQ', at=now)
        time.sleep(views.TEAM_SNAPSHOT_MIN_INTERVAL + 0.05)
        after = {r['email']: r['status'] for r in self._get()}
        self.assertEqual(after['user399@example.com'], 'In Office')
        self.assertIsNotNone(att.id)


class TeamSnapshotConcurrencyTests(TestCase):
    """The morning rush: many requests at the same instant, rebuild is slow."""

    def setUp(self):
        views._team_snapshot_reset()

    def test_thirty_simultaneous_requests_cause_one_rebuild(self):
        builds, results = [], []
        gate = threading.Barrier(30)

        def slow_build():
            builds.append(1)
            time.sleep(0.4)
            return [{'email': 'a@x.com', 'name': 'A', 'status': 'In Office', 'presence': 'Available', 'since': '09:00 AM'}]

        def asker():
            gate.wait()
            results.append(views._team_snapshot_body())

        with patch.object(views, '_build_team_rows', side_effect=slow_build):
            threads = [threading.Thread(target=asker) for _ in range(30)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(10)
        self.assertEqual(len(builds), 1)
        self.assertEqual(len(results), 30)
        self.assertEqual(len(set(results)), 1)              # everyone got the same answer

    def test_while_a_rebuild_runs_others_get_the_previous_snapshot_instead_of_waiting(self):
        old = [{'email': 'old@x.com', 'name': 'Old', 'status': 'Absent', 'presence': 'Offline', 'since': '—'}]
        with patch.object(views, '_build_team_rows', return_value=old):
            first = views._team_snapshot_body()
        views._team_snapshot_mark_dirty()
        time.sleep(views.TEAM_SNAPSHOT_MIN_INTERVAL + 0.05)  # old snapshot may now be replaced
        started, served = threading.Event(), []

        def slow_build():
            started.set()
            time.sleep(0.5)
            return [{'email': 'new@x.com', 'name': 'New', 'status': 'In Office', 'presence': 'Available', 'since': '09:00 AM'}]

        with patch.object(views, '_build_team_rows', side_effect=slow_build):
            builder = threading.Thread(target=lambda: served.append(('builder', views._team_snapshot_body())))
            builder.start()
            started.wait(2)
            t0 = time.perf_counter()
            other = views._team_snapshot_body()             # arrives mid-rebuild
            waited = time.perf_counter() - t0
            builder.join(5)
        self.assertEqual(other, first)                      # previous snapshot, not a pile-up
        self.assertLess(waited, 0.2)
        self.assertIn(b'new@x.com', served[0][1])

    def test_snapshot_is_refreshed_at_least_every_ttl_even_without_writes(self):
        calls = []
        with patch.object(views, '_build_team_rows', side_effect=lambda: calls.append(1) or []):
            views._team_snapshot_body()
            views._team_snapshot_body()
            self.assertEqual(len(calls), 1)
            with patch.object(views, 'TEAM_SNAPSHOT_TTL', 0.2), patch.object(views, 'TEAM_SNAPSHOT_MIN_INTERVAL', 0.05):
                time.sleep(0.3)
                views._team_snapshot_body()
            self.assertEqual(len(calls), 2)
