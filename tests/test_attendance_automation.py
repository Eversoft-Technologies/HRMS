"""Late/absent sweep, HR digest, and the geofence watcher's endpoint."""
import os
import sys
from datetime import datetime, time, timedelta
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import attendance_alerts
from api.models import (AppUser, EmployeeAttendance, GeoFence, Shift,
                        ShiftAssignment, WfhRequest)
from api.timeutil import local_today

OFFICE_LAT, OFFICE_LNG = 17.4485, 78.3908


class LateSweepTests(TestCase):
    def setUp(self):
        self.shift = Shift.objects.create(
            name='Day', start_time=time(9, 0), end_time=time(18, 0), grace_minutes=15,
        )
        self.user = AppUser.objects.create(
            email='late@example.com', full_name='Late Person', status='active', role='employee',
        )
        ShiftAssignment.objects.create(email=self.user.email, shift=self.shift,
                                       effective_from=local_today() - timedelta(days=30))

    def _sweep(self, hh, mm):
        when = datetime.combine(local_today(), time(hh, mm))
        with patch('api.mailer.send_email', return_value={'ok': True}) as sent:
            notified = attendance_alerts.run_late_sweep(now=when)
        return notified, sent

    def test_nobody_is_late_before_the_grace_period_ends(self):
        notified, sent = self._sweep(9, 10)          # 09:00 + 15 min grace
        self.assertEqual(notified, [])
        sent.assert_not_called()

    def test_a_missing_check_in_after_grace_is_notified(self):
        notified, sent = self._sweep(9, 45)
        self.assertEqual(notified, ['late@example.com'])
        sent.assert_called_once()

        row = EmployeeAttendance.objects.get(email=self.user.email, date=local_today())
        self.assertIsNotNone(row.late_alert_sent_at)

    def test_the_notice_is_sent_only_once_a_day(self):
        self._sweep(9, 45)
        notified, sent = self._sweep(10, 30)         # the sweep runs every 15 min
        self.assertEqual(notified, [])
        sent.assert_not_called()

    def test_someone_already_checked_in_is_left_alone(self):
        EmployeeAttendance.objects.create(
            email=self.user.email, date=local_today(), check_in=datetime.now(),
        )
        notified, _ = self._sweep(9, 45)
        self.assertEqual(notified, [])

    def test_approved_wfh_is_not_absent(self):
        WfhRequest.objects.create(email=self.user.email, status='Approved',
                                  from_date=local_today(), to_date=local_today(), days=1)
        notified, _ = self._sweep(9, 45)
        self.assertEqual(notified, [])

    def test_a_flexible_shift_has_nothing_to_be_late_for(self):
        self.shift.is_flexible = True
        self.shift.save(update_fields=['is_flexible'])
        notified, _ = self._sweep(11, 0)
        self.assertEqual(notified, [])

    def test_dry_run_sends_nothing_but_still_reports(self):
        when = datetime.combine(local_today(), time(9, 45))
        with patch('api.mailer.send_email') as sent:
            notified = attendance_alerts.run_late_sweep(now=when, dry_run=True)
        self.assertEqual(notified, ['late@example.com'])
        sent.assert_not_called()
        self.assertFalse(EmployeeAttendance.objects.filter(email=self.user.email).exists())


class DigestTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='hr@example.com', status='active', role='admin')
        AppUser.objects.create(email='a@example.com', status='active', role='employee')
        AppUser.objects.create(email='b@example.com', status='active', role='employee')
        EmployeeAttendance.objects.create(
            email='a@example.com', date=local_today(),
            check_in=datetime.now(), worked_minutes=600, late_minutes=20,
        )
        EmployeeAttendance.objects.create(
            email='c@example.com', date=local_today(),
            location_status='Pending', location_reason='Client site',
        )

    def test_the_numbers_add_up(self):
        d = attendance_alerts.collect_digest()
        self.assertEqual(d['checkedIn'], 1)
        self.assertEqual(d['late'], 1)
        self.assertEqual(d['longDays'], 1)          # 600 min >= 9h
        self.assertEqual(d['stillOpen'], 1)         # checked in, never out
        self.assertEqual(d['pendingApprovals'], 1)
        self.assertEqual(d['expected'], 3)
        self.assertEqual(d['absent'], 2)

    def test_the_digest_goes_to_attendance_viewers(self):
        with patch('api.mailer.send_email', return_value={'ok': True}) as sent:
            to = attendance_alerts.send_hr_digest()
        self.assertIn('hr@example.com', to)
        self.assertNotIn('a@example.com', to, 'employees must not get the digest')
        self.assertEqual(sent.call_count, len(to))

    def test_pending_approvals_are_named_in_the_mail(self):
        with patch('api.mailer.send_email', return_value={'ok': True}) as sent:
            attendance_alerts.send_hr_digest()
        html = sent.call_args.kwargs['html']
        self.assertIn('Client site', html)
        self.assertIn('Off-site approvals waiting', html)

    def test_nobody_to_mail_is_not_an_error(self):
        self.assertEqual(attendance_alerts.send_hr_digest(recipients=[]), [])


class GeofenceCheckEndpointTests(TestCase):
    """Drives the endpoint the in-tab watcher polls."""

    def setUp(self):
        self.client = Client()
        self.email = 'watch@example.com'
        AppUser.objects.create(email=self.email, status='active', role='admin')
        GeoFence.objects.create(name='HQ', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)

    def _check(self, lat, lng, accuracy=None):
        url = f'/api/attendance/geofence-check?latitude={lat}&longitude={lng}'
        if accuracy is not None:
            url += f'&accuracy={accuracy}'
        return self.client.get(url, HTTP_X_USER_EMAIL=self.email).json()

    def test_inside_the_fence(self):
        d = self._check(OFFICE_LAT, OFFICE_LNG, 20)
        self.assertTrue(d['inside'])
        self.assertFalse(d['uncertain'])

    def test_clearly_outside_with_a_good_fix(self):
        d = self._check(OFFICE_LAT + 0.02, OFFICE_LNG, 20)      # ~2.2 km
        self.assertFalse(d['inside'])
        self.assertFalse(d['uncertain'])
        self.assertGreater(d['distance'], 1000)

    def test_a_slightly_out_reading_is_admitted_by_the_accuracy_allowance(self):
        """Within radius + accuracy (capped at 750 m) counts as inside, so the
        watcher resets its strikes instead of counting one."""
        d = self._check(OFFICE_LAT + 0.003, OFFICE_LNG, 900)    # ~330 m out, +-900 m
        self.assertTrue(d['inside'])

    def test_a_useless_fix_beyond_the_cap_is_uncertain_not_outside(self):
        """Past the 750 m cap the allowance stops, but a +-2 km reading still
        cannot prove someone left — it must not close their day."""
        d = self._check(OFFICE_LAT + 0.01, OFFICE_LNG, 2000)    # ~1.1 km out, +-2 km
        self.assertFalse(d['inside'])
        self.assertTrue(d['uncertain'], 'a fix vaguer than the overshoot proves nothing')

    def test_wfh_is_reported_so_the_watcher_stops(self):
        WfhRequest.objects.create(email=self.email, status='Approved',
                                  from_date=local_today(), to_date=local_today(), days=1)
        d = self._check(OFFICE_LAT + 0.02, OFFICE_LNG, 20)
        self.assertTrue(d['wfh'])

    def test_no_fences_means_nothing_to_enforce(self):
        GeoFence.objects.all().delete()
        d = self._check(OFFICE_LAT + 0.5, OFFICE_LNG)
        self.assertFalse(d['enforced'])

    def test_a_missing_position_is_uncertain(self):
        d = self.client.get('/api/attendance/geofence-check',
                            HTTP_X_USER_EMAIL=self.email).json()
        self.assertTrue(d['uncertain'])

    def test_it_needs_an_identity(self):
        self.assertEqual(
            self.client.get('/api/attendance/geofence-check?latitude=1&longitude=1').status_code,
            401,
        )


class AutoCheckoutTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.email = 'auto@example.com'
        AppUser.objects.create(email=self.email, status='active', role='admin')
        EmployeeAttendance.objects.create(
            email=self.email, date=local_today(), check_in=datetime.now(),
        )

    def test_an_auto_checkout_is_stamped_and_labelled(self):
        resp = self.client.post('/api/attendance/check-out',
                                data={'email': self.email, 'auto': 'geofence'},
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=self.email)
        self.assertEqual(resp.status_code, 200)

        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertIsNotNone(row.check_out)
        self.assertIsNotNone(row.auto_checkout_at, 'must be distinguishable from a manual one')
        self.assertIn('geofence', (row.note or '').lower())

    def test_a_manual_checkout_is_not_stamped(self):
        self.client.post('/api/attendance/check-out',
                         data={'email': self.email},
                         content_type='application/json',
                         HTTP_X_USER_EMAIL=self.email)
        row = EmployeeAttendance.objects.get(email=self.email, date=local_today())
        self.assertIsNotNone(row.check_out)
        self.assertIsNone(row.auto_checkout_at)


class UnusableFixTests(TestCase):
    """An IP-level fix reports numbers that mean nothing.

    A browser with no GPS or WiFi positioning falls back to IP geolocation,
    which resolves to the ISP gateway: we saw ±50 km place someone 110 km from
    the office they were sitting in. It must never be quoted as a distance, and
    never acted on.
    """

    def setUp(self):
        self.client = Client()
        self.email = 'ipfix@example.com'
        AppUser.objects.create(email=self.email, status='active', role='admin')
        GeoFence.objects.create(name='Nellore', latitude=OFFICE_LAT,
                                longitude=OFFICE_LNG, radius_meters=200)

    def test_the_watcher_calls_an_ip_fix_uncertain_however_far_it_claims(self):
        d = self.client.get(
            f'/api/attendance/geofence-check?latitude={OFFICE_LAT + 1.0}'
            f'&longitude={OFFICE_LNG}&accuracy=50000',
            HTTP_X_USER_EMAIL=self.email,
        ).json()
        self.assertFalse(d['inside'])
        self.assertTrue(d['uncertain'], 'a ±50 km fix must never trigger auto-checkout')

    def test_check_in_explains_the_fix_instead_of_quoting_a_distance(self):
        resp = self.client.post(
            '/api/attendance/check-in',
            data={'email': self.email, 'latitude': OFFICE_LAT + 1.0,
                  'longitude': OFFICE_LNG, 'accuracy': 50000},
            content_type='application/json', HTTP_X_USER_EMAIL=self.email,
        )
        self.assertEqual(resp.status_code, 422)
        body = resp.json()

        self.assertFalse(body['hasPosition'], 'numbers arrived, but none of them mean anything')
        self.assertTrue(body['gotCoordinates'])
        self.assertIsNone(body['distance'], 'a distance from a ±50 km fix is fiction')
        self.assertIn('50 km', body['message'])
        self.assertIn('location', body['message'].lower())
        self.assertNotIn('110', body['message'])

    def test_a_good_fix_still_quotes_the_real_distance(self):
        resp = self.client.post(
            '/api/attendance/check-in',
            data={'email': self.email, 'latitude': OFFICE_LAT + 0.02,
                  'longitude': OFFICE_LNG, 'accuracy': 25},
            content_type='application/json', HTTP_X_USER_EMAIL=self.email,
        )
        body = resp.json()
        self.assertTrue(body['hasPosition'])
        self.assertGreater(body['distance'], 1000)
        self.assertIn('Nellore', body['message'])
