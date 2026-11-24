"""Office Wi-Fi / IP network whitelist (api/attendance_ext/networks.py).

A request from a company location's own network counts as inside that
location: check-in is verified without GPS or off-site approval, the departure
watcher's outside run is cleared and an automatic check-out sent from the
office network is refused. Homes are never verified by an office network.
"""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
from unittest.mock import patch

from django.test import Client, RequestFactory, TestCase

from api.attendance_ext import networks as nw
from api.models import (AppUser, AttendanceEvent, EmployeeAttendance, GeoFence, MasterDataSet, Permission, Role,
                        RolePermission, Shift, ShiftAssignment, UserProfile, WfhRequest)

OFFICE = (13.1500, 78.5100)
TOWN = (13.2300, 78.5600)        # ~10 km away
DAY = date(2026, 11, 2)
NOON = datetime(2026, 11, 2, 12, 0)
EMP, HR, ADMIN = 'emp@example.com', 'hr@example.com', 'admin@example.com'
OFFICE_IP, HOME_IP = '203.0.113.10', '198.51.100.7'


@contextmanager
def at(dt):
    with patch('api.views.local_now', return_value=dt), patch('api.views.local_today', return_value=dt.date()), \
            patch('api.attendance_ext.missed_punch.local_now', return_value=dt, create=True):
        yield


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


def req(remote='127.0.0.1', xff=None):
    extra = {'REMOTE_ADDR': remote}
    if xff is not None:
        extra['HTTP_X_FORWARDED_FOR'] = xff
    return RequestFactory().get('/', **extra)


class CidrValidationTests(TestCase):
    def test_single_ip_becomes_a_host_network(self):
        self.assertEqual(nw.validate_cidr('203.0.113.10'), ('203.0.113.10/32', None))
        self.assertEqual(nw.validate_cidr(' 2001:db8::1 '), ('2001:db8::1/128', None))

    def test_ranges_are_normalised(self):
        self.assertEqual(nw.validate_cidr('203.0.113.77/28')[0], '203.0.113.64/28')
        self.assertEqual(nw.validate_cidr('2001:db8:1::/48')[0], '2001:db8:1::/48')

    def test_invalid_refused(self):
        for bad in ('', 'office', '300.1.1.1', '203.0.113.0/33', '1.2.3', 'http://x'):
            with self.assertRaises(ValueError, msg=bad):
                nw.validate_cidr(bad)

    def test_too_broad_refused(self):
        for bad in ('0.0.0.0/0', '::/0', '0.0.0.0', '203.0.0.0/15', '10.0.0.0/8', '2001:db8::/32',
                    '2001:db8::/47', '224.0.0.1'):
            with self.assertRaises(ValueError, msg=bad):
                nw.validate_cidr(bad)
        self.assertEqual(nw.validate_cidr('203.0.0.0/16')[0], '203.0.0.0/16')

    def test_private_ranges_warned_not_refused(self):
        for priv in ('192.168.1.0/24', '10.1.2.3', '127.0.0.1', 'fd00::1', '172.20.0.0/16'):
            cidr, warn = nw.validate_cidr(priv)
            self.assertTrue(warn and 'private' in warn, priv)
        self.assertIsNone(nw.validate_cidr('203.0.113.0/24')[1])       # documentation range is public here

    def test_clean_networks_dedupes_and_collects(self):
        entries, warns, errs = nw.clean_networks([
            {'cidr': '203.0.113.10', 'label': 'Main Wi-Fi'}, '203.0.113.10/32', {'cidr': '192.168.0.0/24'},
            {'cidr': '1.0.0.0/8'}])
        self.assertEqual([e['cidr'] for e in entries], ['203.0.113.10/32', '192.168.0.0/24'])
        self.assertEqual(entries[0]['label'], 'Main Wi-Fi')
        self.assertEqual((len(warns), len(errs)), (1, 1))


class ClientIpTests(TestCase):
    def test_remote_addr_by_default_and_xff_ignored(self):
        self.assertEqual(nw.client_ip(req('198.51.100.7', xff=OFFICE_IP)), '198.51.100.7')

    def test_xff_trusted_takes_entry_appended_by_the_proxy(self):
        pol = {'enabled': True, 'trustForwardedFor': True, 'proxyCount': 1}
        # client forged the left entry; our proxy appended the real one on the right
        self.assertEqual(nw.client_ip(req('10.0.0.2', xff=f'{OFFICE_IP}, 198.51.100.7'), pol), '198.51.100.7')

    def test_proxy_count(self):
        pol = {'enabled': True, 'trustForwardedFor': True, 'proxyCount': 2}
        self.assertEqual(nw.client_ip(req('10.0.0.3', xff=f'{OFFICE_IP}, 198.51.100.7, 10.0.0.2'), pol),
                         '198.51.100.7')
        # fewer entries than proxies: fall back to REMOTE_ADDR, never the client's own word
        self.assertEqual(nw.client_ip(req('10.0.0.3', xff=OFFICE_IP), pol), '10.0.0.3')
        # garbage entry: fall back too
        self.assertEqual(nw.client_ip(req('10.0.0.3', xff='junk, x'), pol), '10.0.0.3')

    def test_ports_and_mapped_addresses(self):
        pol = {'enabled': True, 'trustForwardedFor': True, 'proxyCount': 1}
        self.assertEqual(nw.client_ip(req('10.0.0.2', xff='203.0.113.10:5555'), pol), OFFICE_IP)
        self.assertEqual(nw.client_ip(req('10.0.0.2', xff='[2001:db8::5]:443'), pol), '2001:db8::5')
        self.assertEqual(nw.client_ip(req('::ffff:203.0.113.10')), OFFICE_IP)

    def test_trusted_policy_is_read_from_settings(self):
        MasterDataSet.objects.create(key=nw.POLICY_KEY, label='x',
                                     options={'enabled': True, 'trustForwardedFor': True, 'proxyCount': 1})
        self.assertEqual(nw.client_ip(req('10.0.0.2', xff=OFFICE_IP)), OFFICE_IP)


class MatchTests(TestCase):
    def setUp(self):
        self.hq = GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200,
                                          office_networks=[{'cidr': '203.0.113.0/28', 'label': 'Main Wi-Fi'},
                                                           {'cidr': '2001:db8:abcd::/48', 'label': 'v6'}])

    def test_v4_and_v6(self):
        self.assertEqual(nw.match_ip(OFFICE_IP)['fence'], self.hq)
        self.assertEqual(nw.match_ip('203.0.113.10')['label'], 'Main Wi-Fi')
        self.assertIsNone(nw.match_ip('203.0.113.16'))
        self.assertEqual(nw.match_ip('2001:db8:abcd:12::99')['label'], 'v6')
        self.assertIsNone(nw.match_ip('2001:db8:abce::1'))
        self.assertIsNone(nw.match_ip(''))

    def test_inactive_and_home_fences_never_match(self):
        GeoFence.objects.create(name='Home', latitude=1, longitude=1, owner_email=EMP, status='Approved',
                                office_networks=[{'cidr': HOME_IP}])
        self.assertIsNone(nw.match_ip(HOME_IP))
        self.hq.is_active = False
        self.hq.save()
        self.assertIsNone(nw.match_ip(OFFICE_IP))

    def test_disabled_policy_matches_nothing(self):
        MasterDataSet.objects.create(key=nw.POLICY_KEY, label='x', options={'enabled': False})
        self.assertIsNone(nw.office_network_match(req(OFFICE_IP)))
        MasterDataSet.objects.filter(key=nw.POLICY_KEY).update(options={'enabled': True})
        self.assertIsNotNone(nw.office_network_match(req(OFFICE_IP)))

    def test_bad_stored_entry_is_skipped(self):
        self.hq.office_networks = [{'cidr': 'nonsense'}, {'cidr': '203.0.113.10'}]
        self.hq.save()
        self.assertIsNotNone(nw.match_ip(OFFICE_IP))


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
              'attendance.network.manage')
        adm = Role.objects.create(name='Settings Admin')
        grant(adm, 'settings.manage', 'attendance.network.manage')
        for email, role in ((EMP, emp), (HR, hr), (ADMIN, adm)):
            AppUser.objects.create(email=email, full_name=email.split('@')[0].title(), password='x',
                                   role='employee', role_ref=role, status='active')
            UserProfile.objects.create(email=email, first_name=email.split('@')[0].title())
        self.shift = Shift.objects.create(id=1, name='Day', start_time=time(9, 0), end_time=time(18, 0),
                                          grace_minutes=15, break_minutes=0, overtime_after_minutes=540)
        ShiftAssignment.objects.create(email=EMP, shift=self.shift, effective_from=DAY - timedelta(days=30))
        self.hq = GeoFence.objects.create(name='HQ', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200,
                                          office_networks=[{'cidr': '203.0.113.10/32', 'label': 'Main Wi-Fi'}])
        self.office = Client(HTTP_X_USER_EMAIL=EMP, REMOTE_ADDR=OFFICE_IP)
        self.home = Client(HTTP_X_USER_EMAIL=EMP, REMOTE_ADDR=HOME_IP)

    def check_in(self, c, pos=TOWN, when=datetime(2026, 11, 2, 9, 0), **extra):
        body = {'email': EMP, 'employee': 'Emp', **extra}
        if pos is not None:
            body.update(latitude=pos[0], longitude=pos[1], accuracy=20)
        with at(when):
            return c.post('/api/attendance/check-in', body, content_type='application/json')

    def row(self):
        return EmployeeAttendance.objects.get(email=EMP, date=DAY)


class CheckInTests(Base):
    def test_outside_gps_on_office_network_is_verified(self):
        r = self.check_in(self.office, pos=TOWN)
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertEqual(d['verifiedBy'], 'office_network')
        self.assertEqual((d['network']['matched'], d['network']['fence'], d['network']['label']),
                         (True, 'HQ', 'Main Wi-Fi'))
        row = self.row()
        self.assertTrue(row.geo_verified)
        self.assertEqual(row.location_status, '')
        ev = AttendanceEvent.objects.get(email=EMP, event='check-in')
        self.assertEqual(ev.geo_fence_id, self.hq.id)
        self.assertIn('Verified by office network (Main Wi-Fi)', ev.location)

    def test_missing_gps_on_office_network_is_verified(self):
        r = self.check_in(self.office, pos=None)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(self.row().geo_verified)
        self.assertIsNone(self.row().location_lat)

    def test_missing_gps_elsewhere_still_required(self):
        r = self.check_in(self.home, pos=None)
        self.assertEqual((r.status_code, r.json()['code']), (400, 'LOCATION_REQUIRED'))

    def test_outside_gps_elsewhere_still_needs_a_reason(self):
        r = self.check_in(self.home, pos=TOWN)
        self.assertEqual((r.status_code, r.json()['code']), (422, 'LOCATION_REASON_REQUIRED'))

    def test_forged_forwarded_for_is_ignored(self):
        c = Client(HTTP_X_USER_EMAIL=EMP, REMOTE_ADDR=HOME_IP, HTTP_X_FORWARDED_FOR=OFFICE_IP)
        r = self.check_in(c, pos=TOWN)
        self.assertEqual(r.status_code, 422)

    def test_gps_inside_keeps_plain_label(self):
        r = self.check_in(self.office, pos=OFFICE)
        self.assertEqual(r.status_code, 201)
        self.assertNotIn('verifiedBy', r.json())
        self.assertEqual(AttendanceEvent.objects.get(email=EMP, event='check-in').location, 'HQ')

    def test_home_check_in_is_not_verified_by_office_network(self):
        WfhRequest.objects.create(email=EMP, from_date=DAY, to_date=DAY, status='Approved', reason='x')
        GeoFence.objects.create(name='Home', latitude=OFFICE[0] + 0.5, longitude=OFFICE[1], radius_meters=100,
                                owner_email=EMP, status='Approved')
        r = self.check_in(self.office, pos=TOWN)
        self.assertEqual((r.status_code, r.json()['code']), (422, 'LOCATION_REASON_REQUIRED'))
        r = self.check_in(self.office, pos=None)
        self.assertEqual((r.status_code, r.json()['code']), (400, 'LOCATION_REQUIRED'))


class DepartureTests(Base):
    def setUp(self):
        super().setUp()
        EmployeeAttendance.objects.create(email=EMP, employee_name='Emp', date=DAY,
                                          check_in=datetime(2026, 11, 2, 9, 0), shift_id=1,
                                          location_lat=OFFICE[0], location_lng=OFFICE[1], geo_verified=True)

    def geocheck(self, c, when, pos=TOWN, acc=30):
        q = f'/api/attendance/geofence-check?email={EMP}'
        if pos is not None:
            q += f'&latitude={pos[0]}&longitude={pos[1]}&accuracy={acc}'
        with at(when):
            return c.get(q).json()

    def outside_run(self, minutes=12):
        for k in range(minutes, -1, -3):
            self.geocheck(self.home, NOON - timedelta(minutes=k))

    def test_office_network_clears_outside_run(self):
        self.outside_run()
        d = self.geocheck(self.home, NOON)
        self.assertTrue(d['departureDue'])
        self.assertEqual(d['network'], {'matched': False})
        d = self.geocheck(self.office, NOON + timedelta(minutes=1))
        self.assertTrue(d['inside'])
        self.assertFalse(d['departureDue'])
        self.assertIsNone(d['outsideMinutes'])
        self.assertEqual((d['network']['matched'], d['network']['fence'], d['network']['label']),
                         (True, 'HQ', 'Main Wi-Fi'))
        self.assertIsNone(self.row().outside_since)

    def test_office_network_without_gps(self):
        d = self.geocheck(self.office, NOON, pos=None)
        self.assertTrue(d['inside'] and d['network']['matched'])
        d = self.geocheck(self.home, NOON, pos=None)
        self.assertTrue(d['uncertain'])

    def test_auto_checkout_refused_from_office_network(self):
        self.outside_run()
        with at(NOON):
            r = self.office.post('/api/attendance/check-out', {'email': EMP, 'auto': 'geofence_departure'},
                                 content_type='application/json')
        self.assertEqual((r.status_code, r.json()['code']), (409, 'AUTO_CHECKOUT_UNCONFIRMED'))
        self.assertTrue(r.json()['network']['matched'])
        self.assertIsNone(self.row().check_out)
        self.assertIsNone(self.row().outside_since)

    def test_auto_checkout_still_works_elsewhere(self):
        self.outside_run()
        with at(NOON):
            r = self.home.post('/api/attendance/check-out', {'email': EMP, 'auto': 'geofence_departure'},
                               content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(self.row().is_auto_checked_out)

    def test_manual_check_out_label_from_office_network(self):
        with at(NOON):
            r = self.office.post('/api/attendance/check-out', {'email': EMP, 'latitude': TOWN[0],
                                                               'longitude': TOWN[1]},
                                 content_type='application/json')
        self.assertEqual(r.status_code, 200)
        ev = AttendanceEvent.objects.get(email=EMP, event='check-out')
        self.assertEqual(ev.geo_fence_id, self.hq.id)
        self.assertIn('Verified by office network', ev.location)

    def test_wfh_session_unaffected(self):
        EmployeeAttendance.objects.filter(email=EMP).update(is_wfh=True)
        d = self.geocheck(self.office, NOON)
        self.assertTrue(d['wfh'])
        self.assertEqual(d['network'], {'matched': False})


class EndpointTests(Base):
    URL = '/api/attendance/networks'

    def put(self, who, body, ip='127.0.0.1'):
        return Client(HTTP_X_USER_EMAIL=who, REMOTE_ADDR=ip).put(self.URL, body, content_type='application/json')

    def test_permissions(self):
        self.assertEqual(Client(HTTP_X_USER_EMAIL=EMP).get(self.URL).status_code, 403)
        self.assertEqual(self.put(EMP, {'fences': []}).status_code, 403)
        self.assertEqual(Client().get(self.URL).status_code, 401)
        self.assertEqual(Client(HTTP_X_USER_EMAIL=HR).get(self.URL).status_code, 200)
        self.assertEqual(Client(HTTP_X_USER_EMAIL=ADMIN).get(self.URL).status_code, 200)
        self.assertEqual(self.put(ADMIN, {'fences': []}).status_code, 200)

    def test_get_shows_your_ip_and_match(self):
        d = Client(HTTP_X_USER_EMAIL=HR, REMOTE_ADDR=OFFICE_IP).get(self.URL).json()
        self.assertEqual(d['yourIp'], OFFICE_IP)
        self.assertFalse(d['yourIpPrivate'])
        self.assertEqual(d['yourMatch']['fence'], 'HQ')
        self.assertEqual(d['policy'], {'enabled': True, 'trustForwardedFor': False, 'proxyCount': 1})
        self.assertEqual(d['fences'][0]['networks'], [{'cidr': '203.0.113.10/32', 'label': 'Main Wi-Fi',
                                                       'private': False}])
        self.assertTrue(d['canManage'])
        d = Client(HTTP_X_USER_EMAIL=HR).get(self.URL).json()
        self.assertEqual((d['yourIp'], d['yourIpPrivate'], d['yourMatch']), ('127.0.0.1', True, None))

    def test_put_saves_validates_and_audits(self):
        r = self.put(HR, {'fences': [{'id': self.hq.id, 'networks': [
            {'cidr': '203.0.113.10', 'label': 'Main Wi-Fi'}, {'cidr': '127.0.0.1', 'label': 'Test'}]}]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()['warnings']), 1)               # loopback is private: warned
        self.hq.refresh_from_db()
        self.assertEqual([n['cidr'] for n in self.hq.office_networks], ['203.0.113.10/32', '127.0.0.1/32'])
        audit = r.json()['audit']
        self.assertEqual((audit[0]['by'], audit[0]['fence']), (HR, 'HQ'))
        self.assertIn('added 127.0.0.1/32', audit[0]['detail'])
        # Now the local test client (127.0.0.1) is on the office network.
        self.assertEqual(Client(HTTP_X_USER_EMAIL=HR).get(self.URL).json()['yourMatch']['label'], 'Test')

    def test_put_refuses_broad_and_saves_nothing(self):
        r = self.put(HR, {'policy': {'enabled': False},
                          'fences': [{'id': self.hq.id, 'networks': [{'cidr': '203.0.0.0/8'}]}]})
        self.assertEqual((r.status_code, r.json()['code']), (400, 'INVALID_NETWORK'))
        self.hq.refresh_from_db()
        self.assertEqual(len(self.hq.office_networks), 1)
        self.assertTrue(nw.network_policy()['enabled'])

    def test_put_refuses_home_fence(self):
        home = GeoFence.objects.create(name='Home', latitude=1, longitude=1, owner_email=EMP, status='Approved')
        r = self.put(HR, {'fences': [{'id': home.id, 'networks': ['203.0.113.99']}]})
        self.assertEqual(r.status_code, 400)

    def test_policy_validation(self):
        r = self.put(HR, {'policy': {'trustForwardedFor': True, 'proxyCount': 9}})
        self.assertEqual(r.status_code, 400)
        r = self.put(HR, {'policy': {'trustForwardedFor': True, 'proxyCount': 2}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['policy'], {'enabled': True, 'trustForwardedFor': True, 'proxyCount': 2})
        self.assertIn('trustForwardedFor', r.json()['audit'][0]['detail'])

    def test_fence_list_shows_network_count_only(self):
        d = Client(HTTP_X_USER_EMAIL=EMP).get('/api/attendance/geofences').json()
        self.assertEqual(d[0]['networkCount'], 1)
        self.assertNotIn('office_networks', d[0])
