"""Work arrangements, shifts, WFH geofencing and the profile's work setup.

Covers the critical scenarios of the work-setup plan:
  * onsite check-in inside / outside an office fence
  * approved WFH inside / outside the approved home fence
  * WFH approved but home not registered or still pending
  * home change: approved fence stays in force until HR decides; audit trail
  * arrangement and shift changes take effect on the right dates
  * nobody changes another person's setup or approves their own location
  * profile viewers see home coordinates only when permitted
  * the client cannot switch the geofence off
"""
from datetime import date, time, timedelta

from django.test import Client, TestCase

from api.models import (AppUser, GeoFence, HomeLocationChange, Permission, Role, RolePermission, Shift,
                        ShiftAssignment, UserProfile, WfhRequest, WorkArrangement)
from api.timeutil import local_today

OFFICE = (14.4426, 79.9865)
HOME = (14.4700, 79.9200)
NEW_HOME = (14.5000, 79.9000)
FAR = (17.3850, 78.4867)           # another city


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class Base(TestCase):
    def setUp(self):
        hr = Role.objects.create(name='HR Manager')
        grant(hr, 'attendance.view', 'attendance.create', 'attendance.approve_offsite',
              'attendance.manage_arrangement', 'settings.manage', 'employee.view', 'employee.edit')
        emp = Role.objects.create(name='Employee')
        grant(emp, 'attendance.create', 'employee.view')
        AppUser.objects.create(email='hr@x.com', full_name='HR Person', password='x', role='hr', role_ref=hr)
        AppUser.objects.create(email='hr2@x.com', full_name='HR Two', password='x', role='hr', role_ref=hr)
        for e, n in (('bob@x.com', 'Bob X'), ('eve@x.com', 'Eve X')):
            AppUser.objects.create(email=e, full_name=n, password='x', role='employee', role_ref=emp)
            UserProfile.objects.create(email=e, first_name=n.split()[0], last_name='X')
        GeoFence.objects.create(name='Office', latitude=OFFICE[0], longitude=OFFICE[1], radius_meters=200)
        self.c = {e: Client(HTTP_X_USER_EMAIL=e) for e in ('hr@x.com', 'hr2@x.com', 'bob@x.com', 'eve@x.com')}
        self.today = local_today()

    def check_in(self, who='bob@x.com', at=OFFICE, **extra):
        body = {'email': who, 'employee': who, 'latitude': at[0], 'longitude': at[1], 'accuracy': 10}
        body.update(extra)
        return self.c[who].post('/api/attendance/check-in', data=body, content_type='application/json')

    def approve_home(self, who='bob@x.com', at=HOME):
        return GeoFence.objects.create(name='Home', latitude=at[0], longitude=at[1], radius_meters=150,
                                       owner_email=who, status=GeoFence.APPROVED, reviewer='hr@x.com')

    def approve_wfh(self, who='bob@x.com'):
        WfhRequest.objects.create(email=who, from_date=self.today, to_date=self.today, status='Approved')


class CheckInScenarioTests(Base):
    def test_onsite_inside_and_outside_the_office_fence(self):
        r = self.check_in(at=OFFICE)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()['geoVerified'])
        r = self.check_in(who='eve@x.com', at=FAR)
        self.assertEqual(r.status_code, 422)                    # outside: a reason is required...
        self.assertTrue(r.json()['needsReason'])
        r = self.check_in(who='eve@x.com', at=FAR, locationReason='Client site visit')
        self.assertEqual(r.status_code, 202, r.content)         # ...then it goes to HR, not verified
        self.assertEqual(r.json()['status'], 'Pending')

    def test_approved_wfh_verifies_against_the_home_fence_only(self):
        self.approve_home()
        self.approve_wfh()
        r = self.check_in(at=HOME, isWfh=True)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()['geoVerified'])
        self.assertTrue(r.json()['isWfh'])

    def test_approved_wfh_outside_the_home_fence_is_not_verified(self):
        self.approve_home()
        self.approve_wfh()
        r = self.check_in(at=FAR, isWfh=True)
        self.assertEqual(r.status_code, 422)                    # same reason + HR review path as the office
        self.assertTrue(r.json()['isWfh'])
        r = self.check_in(at=FAR, isWfh=True, locationReason='Working from family home this week')
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()['status'], 'Pending')

    def test_wfh_without_an_approved_home_needs_a_reason_and_hr_review(self):
        self.approve_wfh()
        r = self.check_in(at=HOME, isWfh=True)
        self.assertEqual(r.status_code, 422)                     # no fence -> not a pass
        self.assertEqual(r.json()['homeLocationStatus'], 'Not set up')
        self.assertIn('cannot be verified', r.json()['message'])
        r = self.check_in(at=HOME, isWfh=True, locationReason='Home not registered yet')
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()['status'], 'Pending')

    def test_pending_home_does_not_verify(self):
        GeoFence.objects.create(name='Home', latitude=HOME[0], longitude=HOME[1], radius_meters=150,
                                owner_email='bob@x.com', status=GeoFence.PENDING)
        self.approve_wfh()
        r = self.check_in(at=HOME, isWfh=True)
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()['homeLocationStatus'], 'Pending review')

    def test_approved_home_alone_does_not_grant_wfh(self):
        self.approve_home()
        WorkArrangement.objects.create(email='bob@x.com', arrangement='onsite', effective_from=self.today)
        r = self.check_in(at=HOME, isWfh=True)
        self.assertEqual(r.status_code, 403)
        self.assertTrue(r.json()['needsWfhRequest'])

    def test_the_client_cannot_switch_the_geofence_off(self):
        r = self.check_in(at=FAR, bypassGeofence=True)
        self.assertEqual(r.status_code, 422)                     # ignored: the fence still applies
        r = self.c['hr@x.com'].post('/api/attendance/check-in', data={
            'email': 'hr@x.com', 'latitude': FAR[0], 'longitude': FAR[1], 'bypassGeofence': True},
            content_type='application/json', HTTP_X_BYPASS_GEOFENCE='1')
        self.assertEqual(r.status_code, 422)                     # nobody can switch it off, admins included


class HomeChangeTests(Base):
    def propose(self, who='bob@x.com', at=NEW_HOME, reason='Moved to a new flat'):
        return self.c[who].post('/api/attendance/home-locations', data={
            'email': who, 'latitude': at[0], 'longitude': at[1], 'accuracy': 15, 'reason': reason},
            content_type='application/json')

    def test_approved_fence_stays_in_force_while_a_change_is_pending(self):
        fence = self.approve_home()
        self.assertEqual(self.propose(reason='').status_code, 400)          # a reason is required
        r = self.propose()
        self.assertEqual(r.status_code, 202, r.content)
        self.assertTrue(r.json()['changeRequested'])
        fence.refresh_from_db()
        self.assertEqual((fence.status, fence.latitude), (GeoFence.APPROVED, HOME[0]))
        self.approve_wfh()
        self.assertTrue(self.check_in(at=HOME, isWfh=True).json()['geoVerified'])   # old home still verifies
        prof = self.c['hr@x.com'].get('/api/employees/bob@x.com/profile').json()
        self.assertEqual(prof['workSetup']['home']['status'], 'Change requested')

    def test_hr_approves_and_the_fence_moves_with_an_audit_trail(self):
        fence = self.approve_home()
        cid = self.propose().json()['pendingChange']['id']
        self.assertEqual(self.c['bob@x.com'].post(f'/api/attendance/home-locations/changes/{cid}/decide',
                                                  data={'decision': 'Approved'}, content_type='application/json').status_code, 403)
        r = self.c['hr@x.com'].post(f'/api/attendance/home-locations/changes/{cid}/decide',
                                    data={'decision': 'Approved', 'note': 'Matches the lease'},
                                    content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        fence.refresh_from_db()
        self.assertEqual((fence.latitude, fence.status, fence.reviewer), (NEW_HOME[0], GeoFence.APPROVED, 'hr@x.com'))
        row = HomeLocationChange.objects.get(pk=cid)
        self.assertEqual(row.previous['latitude'], HOME[0])
        self.assertEqual((row.status, row.reviewer, row.review_note), ('Approved', 'hr@x.com', 'Matches the lease'))
        self.assertEqual(self.c['hr@x.com'].post(f'/api/attendance/home-locations/changes/{cid}/decide',
                                                 data={'decision': 'Rejected'}, content_type='application/json').status_code, 409)

    def test_hr_rejects_and_the_old_fence_is_kept(self):
        fence = self.approve_home()
        cid = self.propose().json()['pendingChange']['id']
        self.c['hr@x.com'].post(f'/api/attendance/home-locations/changes/{cid}/decide',
                                data={'decision': 'Rejected'}, content_type='application/json')
        fence.refresh_from_db()
        self.assertEqual((fence.latitude, fence.status), (HOME[0], GeoFence.APPROVED))

    def test_nobody_reviews_their_own_location(self):
        fence = self.approve_home(who='hr@x.com')
        cid = self.propose(who='hr@x.com').json()['pendingChange']['id']
        r = self.c['hr@x.com'].post(f'/api/attendance/home-locations/changes/{cid}/decide',
                                    data={'decision': 'Approved'}, content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.c['hr2@x.com'].post(f'/api/attendance/home-locations/changes/{cid}/decide',
                                                  data={'decision': 'Approved'}, content_type='application/json').status_code, 200)
        fence.delete()
        mine = GeoFence.objects.create(name='Home', latitude=1, longitude=1, owner_email='hr@x.com', status='Pending')
        r = self.c['hr@x.com'].post('/api/attendance/home-locations/review', data={'id': mine.id, 'decision': 'Approved'},
                                    content_type='application/json')
        self.assertEqual(r.status_code, 403)

    def test_initial_registration_is_logged_and_closed_on_review(self):
        r = self.c['bob@x.com'].post('/api/attendance/home-locations', data={
            'email': 'bob@x.com', 'latitude': HOME[0], 'longitude': HOME[1], 'accuracy': 12},
            content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['homeStatus'], 'Pending review')
        self.c['hr@x.com'].post('/api/attendance/home-locations/review', data={'id': r.json()['id'], 'decision': 'Approved'},
                                content_type='application/json')
        hist = self.c['bob@x.com'].get('/api/attendance/home-locations/changes').json()
        self.assertEqual([(h['kind'], h['status']) for h in hist], [('initial', 'Approved')])

    def test_employees_only_see_their_own_history_and_can_cancel(self):
        self.approve_home()
        cid = self.propose().json()['pendingChange']['id']
        self.assertEqual(self.c['eve@x.com'].get('/api/attendance/home-locations/changes?email=bob@x.com').status_code, 403)
        self.assertEqual(self.c['eve@x.com'].delete(f'/api/attendance/home-locations/changes/{cid}').status_code, 404)
        self.assertEqual(self.c['bob@x.com'].delete(f'/api/attendance/home-locations/changes/{cid}').json()['status'], 'Cancelled')


class AssignmentTests(Base):
    def test_shift_assignment_is_validated_and_keeps_history(self):
        early = Shift.objects.create(name='Early', start_time=time(7), end_time=time(16))
        late = Shift.objects.create(name='Late', start_time=time(13), end_time=time(22))
        post = lambda body: self.c['hr@x.com'].post('/api/shift-assignments', data=body, content_type='application/json')
        self.assertEqual(post({'email': 'ghost@x.com', 'shift': early.id, 'effectiveFrom': '2026-11-01'}).status_code, 400)
        self.assertEqual(post({'email': 'bob@x.com', 'shift': 999, 'effectiveFrom': '2026-11-01'}).status_code, 400)
        self.assertEqual(post({'email': 'bob@x.com', 'shift': early.id, 'effectiveFrom': '2026-11-10',
                               'effectiveTo': '2026-11-01'}).status_code, 400)
        self.assertEqual(post({'email': 'bob@x.com', 'shift': early.id, 'effectiveFrom': '2026-11-01'}).status_code, 201)
        self.assertEqual(post({'email': 'bob@x.com', 'shift': late.id, 'effectiveFrom': '2026-12-01'}).status_code, 201)
        rows = list(ShiftAssignment.objects.filter(email='bob@x.com').order_by('effective_from')
                    .values_list('shift__name', 'effective_from', 'effective_to'))
        self.assertEqual(rows, [('Early', date(2026, 11, 1), date(2026, 11, 30)), ('Late', date(2026, 12, 1), None)])
        from api.views import _get_active_shift
        self.assertEqual(_get_active_shift('bob@x.com', date(2026, 11, 15)).name, 'Early')
        self.assertEqual(_get_active_shift('bob@x.com', date(2026, 12, 2)).name, 'Late')
        self.assertEqual(self.c['bob@x.com'].post('/api/shift-assignments', data={
            'email': 'eve@x.com', 'shift': early.id, 'effectiveFrom': '2026-11-01'},
            content_type='application/json').status_code, 403)

    def test_arrangement_needs_a_real_employee_and_cannot_be_self_set(self):
        post = lambda who, body: self.c[who].post('/api/attendance/arrangements', data=body, content_type='application/json')
        self.assertEqual(post('hr@x.com', {'email': 'ghost@x.com', 'arrangement': 'remote'}).status_code, 400)
        self.assertEqual(post('bob@x.com', {'email': 'bob@x.com', 'arrangement': 'remote'}).status_code, 403)
        self.assertEqual(post('hr@x.com', {'email': 'bob@x.com', 'arrangement': 'hybrid', 'remoteWeekdays': [0, 4],
                                           'effectiveFrom': (self.today + timedelta(days=3)).isoformat()}).status_code, 201)
        ws = self.c['hr@x.com'].get('/api/employees/bob@x.com/profile').json()['workSetup']
        self.assertIsNone(ws['arrangement'])                        # not in force yet
        self.assertEqual(ws['upcomingArrangement']['remoteWeekdays'], ['Mon', 'Fri'])


class ProfileWorkSetupTests(Base):
    def test_summary_and_location_privacy(self):
        self.approve_home()
        WorkArrangement.objects.create(email='bob@x.com', arrangement='remote', effective_from=self.today)
        s = Shift.objects.create(name='Flex', start_time=time(9), end_time=time(18), is_flexible=True, flex_hours_per_day=8)
        ShiftAssignment.objects.create(email='bob@x.com', shift=s, effective_from=self.today)
        self.approve_wfh()
        own = self.c['bob@x.com'].get('/api/employees/bob@x.com/profile').json()['workSetup']
        self.assertEqual(own['arrangement']['arrangement'], 'remote')
        self.assertEqual((own['shift']['name'], own['shift']['isDefault']), ('Flex', False))
        self.assertEqual(own['wfh'][0]['status'], 'Approved')
        self.assertEqual(own['home']['status'], 'Approved')
        self.assertEqual(own['home']['latitude'], HOME[0])                   # the employee sees it
        self.assertEqual(self.c['hr@x.com'].get('/api/employees/bob@x.com/profile').json()['workSetup']['home']['latitude'], HOME[0])
        # A colleague with employee.view but not the reviewer permission: status only.
        viewer_role = Role.objects.create(name='Viewer')
        grant(viewer_role, 'employee.view', 'attendance.view')
        AppUser.objects.create(email='viewer@x.com', full_name='V', password='x', role='employee', role_ref=viewer_role)
        other = Client(HTTP_X_USER_EMAIL='viewer@x.com').get('/api/employees/bob@x.com/profile').json()['workSetup']
        self.assertEqual(other['home']['status'], 'Approved')
        self.assertNotIn('latitude', other['home'])
        self.assertFalse(other['canSeeLocation'])

    def test_setup_issues_are_listed_for_hr(self):
        s = Shift.objects.create(name='A', start_time=time(9), end_time=time(18))
        ShiftAssignment.objects.create(email='bob@x.com', shift=s, effective_from=date(2026, 1, 1))
        ShiftAssignment.objects.create(email='bob@x.com', shift=s, effective_from=date(2026, 2, 1))
        WorkArrangement.objects.create(email='ghost@x.com', arrangement='remote', effective_from=date(2026, 1, 1))
        resp = self.c['hr@x.com'].get('/api/org/unresolved')
        self.assertEqual(resp.status_code, 200, resp.content)
        kinds = {x['kind'] for x in resp.json()}
        self.assertIn('Overlapping shift assignments', kinds)
        self.assertIn('Arrangement for unknown employee', kinds)


class LocationEverywhereTests(Base):
    """Location + fence verification is mandatory in every mode of work."""

    def test_coordinates_are_required_for_every_check_in(self):
        r = self.c['bob@x.com'].post('/api/attendance/check-in', data={'email': 'bob@x.com'},
                                     content_type='application/json')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['code'], 'LOCATION_REQUIRED')
        self.approve_wfh()
        r = self.c['bob@x.com'].post('/api/attendance/check-in', data={'email': 'bob@x.com', 'isWfh': True},
                                     content_type='application/json')
        self.assertEqual(r.json()['code'], 'LOCATION_REQUIRED')

    def test_no_office_fence_is_never_a_pass(self):
        GeoFence.objects.filter(owner_email='').delete()
        r = self.check_in(at=OFFICE)
        self.assertEqual(r.status_code, 422)
        self.assertIn('No office location', r.json()['message'])
        r = self.check_in(at=OFFICE, locationReason='Office fence not configured yet')
        self.assertEqual(r.status_code, 202)

    def test_remote_and_hybrid_staff_are_verified_against_home_too(self):
        WorkArrangement.objects.create(email='bob@x.com', arrangement='remote', effective_from=self.today)
        r = self.check_in(at=HOME, isWfh=True)
        self.assertEqual(r.status_code, 422)                     # remote but no approved home
        self.approve_home()
        r = self.check_in(who='bob@x.com', at=HOME, isWfh=True)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()['geoVerified'])

    def switch(self, who, event, at=None):
        body = {'email': who, 'employee': who, 'event': event}
        if at:
            body.update({'latitude': at[0], 'longitude': at[1], 'accuracy': 10})
        return self.c[who].post('/api/attendance/events', data=body, content_type='application/json')

    def test_switching_mode_mid_day_is_location_verified(self):
        self.check_in(at=OFFICE)
        self.approve_wfh()
        self.assertEqual(self.switch('bob@x.com', 'remote-switch').json()['code'], 'LOCATION_REQUIRED')
        self.assertEqual(self.switch('bob@x.com', 'remote-switch', HOME).json()['code'], 'HOME_NOT_APPROVED')
        self.approve_home()
        self.assertEqual(self.switch('bob@x.com', 'remote-switch', FAR).json()['code'], 'OUTSIDE_HOME_FENCE')
        r = self.switch('bob@x.com', 'remote-switch', HOME)
        self.assertEqual(r.status_code, 201, r.content)
        from api.models import EmployeeAttendance
        att = EmployeeAttendance.objects.get(email='bob@x.com', date=self.today)
        self.assertTrue(att.is_wfh)
        self.assertEqual(self.switch('bob@x.com', 'office-switch', HOME).json()['code'], 'OUTSIDE_OFFICE_FENCE')
        self.assertEqual(self.switch('bob@x.com', 'office-switch', OFFICE).status_code, 201)
        att.refresh_from_db()
        self.assertFalse(att.is_wfh)

    def test_the_old_open_routes_are_closed(self):
        r = Client().post('/api/attendance/check-in/', data={'email': 'bob@x.com', 'employeeName': 'Bob'},
                          content_type='application/json')
        self.assertEqual(r.status_code, 401)                     # was AllowAny, no fence at all
        r = self.c['bob@x.com'].post('/api/attendance/check-in/', data={'email': 'bob@x.com'},
                                     content_type='application/json')
        self.assertEqual(r.json()['code'], 'LOCATION_REQUIRED')
        r = Client().post('/api/attendance/device-punch/', data={'email': 'bob@x.com'},
                          content_type='application/json')
        self.assertEqual(r.status_code, 403)


class ManualHomeEntryTests(Base):
    """Typed coordinates when the device cannot get a precise fix."""

    def post_home(self, **body):
        data = {'email': 'bob@x.com'}
        data.update(body)
        return self.c['bob@x.com'].post('/api/attendance/home-locations', data=data, content_type='application/json')

    def test_vague_gps_is_refused_and_offers_manual_entry(self):
        r = self.post_home(latitude=17.42, longitude=78.51, accuracy=200000)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['code'], 'POSITION_TOO_VAGUE')
        self.assertTrue(r.json()['manualEntryAllowed'])

    def test_manual_coordinates_need_a_source_note_and_valid_ranges(self):
        self.assertEqual(self.post_home(latitude=HOME[0], longitude=HOME[1], captureMethod='manual').status_code, 400)
        self.assertEqual(self.post_home(latitude=95, longitude=HOME[1], captureMethod='manual',
                                        manualNote='Google Maps pin').status_code, 400)
        self.assertEqual(self.post_home(latitude=0, longitude=0, captureMethod='manual',
                                        manualNote='Google Maps pin').status_code, 400)

    def test_manual_entry_is_labelled_and_verifies_nothing_until_approved(self):
        r = self.post_home(latitude=HOME[0], longitude=HOME[1], accuracy=200000, captureMethod='manual',
                           manualNote='Google Maps pin on my house')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()['captureMethod'], r.json()['capturedAccuracy'], r.json()['homeStatus']),
                         ('manual', None, 'Pending review'))
        self.approve_wfh()
        self.assertEqual(self.check_in(at=HOME, isWfh=True).status_code, 422)       # pending: not a pass
        self.c['hr@x.com'].post('/api/attendance/home-locations/review', data={'id': r.json()['id'], 'decision': 'Approved'},
                                content_type='application/json')
        self.assertTrue(self.check_in(at=HOME, isWfh=True).json()['geoVerified'])
        hist = self.c['hr@x.com'].get('/api/attendance/home-locations/changes?email=bob@x.com').json()
        self.assertEqual(hist[0]['captureMethod'], 'manual')

    def test_manual_change_request_keeps_the_approved_home_until_hr_decides(self):
        fence = self.approve_home()
        r = self.post_home(latitude=NEW_HOME[0], longitude=NEW_HOME[1], captureMethod='manual',
                           reason='Moved; GPS on my laptop is unreliable')
        self.assertEqual(r.status_code, 202, r.content)
        self.assertEqual(r.json()['pendingChange']['captureMethod'], 'manual')
        fence.refresh_from_db()
        self.assertEqual(fence.latitude, HOME[0])
        cid = r.json()['pendingChange']['id']
        self.c['hr@x.com'].post(f'/api/attendance/home-locations/changes/{cid}/decide', data={'decision': 'Approved'},
                                content_type='application/json')
        fence.refresh_from_db()
        self.assertEqual((fence.latitude, fence.capture_method), (NEW_HOME[0], 'manual'))
