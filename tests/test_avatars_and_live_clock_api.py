"""Profile-picture endpoints and the live-clock fields on /api/attendance/today.

GET /api/avatars                 who has a picture (any signed-in user)
GET /api/avatars/<email>         the picture bytes / a redirect for URL pictures
GET /api/attendance/today        + overtimeAfterMinutes, onBreak, breakStartedAt
"""
import base64
from datetime import datetime, time

from django.test import Client, TestCase

from api.models import (
    AppUser,
    AttendanceEvent,
    EmployeeAttendance,
    Shift,
    ShiftAssignment,
    UserProfile,
)
from api.timeutil import local_today

# A 1x1 transparent PNG.
PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
)
DATA_URL = 'data:image/png;base64,' + base64.b64encode(PNG).decode('ascii')


class AvatarsApiTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@example.com', full_name='Admin User', password='x', role='admin')
        AppUser.objects.create(email='priya@company.com', full_name='Priya S', password='x',
                               role='employee', initials='PS', employee_id='EV-0007')
        UserProfile.objects.create(email='priya@company.com', first_name='Priya', last_name='Sharma',
                                   profile_pic=DATA_URL)
        AppUser.objects.create(email='google@company.com', full_name='Google Person', password='x',
                               role='employee', profile_pic='https://lh3.googleusercontent.com/a/abc')
        AppUser.objects.create(email='nopic@company.com', full_name='No Picture', password='x', role='employee')
        self.admin = Client(HTTP_X_USER_EMAIL='admin@example.com')
        self.employee = Client(HTTP_X_USER_EMAIL='nopic@company.com')

    def test_list_names_everyone_with_a_picture(self):
        r = self.employee.get('/api/avatars')          # any signed-in user may read it
        self.assertEqual(r.status_code, 200)
        rows = r.json()
        self.assertEqual([x['email'] for x in rows], ['google@company.com', 'priya@company.com'])
        priya = rows[1]
        self.assertEqual(priya['name'], 'Priya Sharma')
        self.assertEqual(priya['initials'], 'PS')
        self.assertEqual(priya['aliases'], ['Priya Sharma', 'Priya S'])
        self.assertEqual(priya['employeeId'], 'EV-0007')
        self.assertEqual(priya['url'], '')               # data URL: bytes come from the image route
        self.assertGreater(priya['v'], 0)
        self.assertEqual(rows[0]['url'], 'https://lh3.googleusercontent.com/a/abc')

    def test_image_decodes_the_stored_data_url(self):
        r = self.employee.get('/api/avatars/PRIYA@company.com')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['Content-Type'], 'image/png')
        self.assertEqual(r.content, PNG)
        self.assertIn('max-age', r['Cache-Control'])

    def test_url_pictures_redirect(self):
        r = self.employee.get('/api/avatars/google@company.com')
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r['Location'], 'https://lh3.googleusercontent.com/a/abc')

    def test_missing_picture_is_404(self):
        self.assertEqual(self.employee.get('/api/avatars/nopic@company.com').status_code, 404)
        self.assertEqual(self.employee.get('/api/avatars/nobody@company.com').status_code, 404)

    def test_unidentified_caller_is_refused(self):
        self.assertEqual(Client().get('/api/avatars').status_code, 401)
        self.assertEqual(Client().get('/api/avatars/priya@company.com').status_code, 401)

    def test_profile_picture_wins_over_account_picture(self):
        AppUser.objects.filter(email='priya@company.com').update(profile_pic='https://old.example/pic.jpg')
        r = self.employee.get('/api/avatars/priya@company.com')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, PNG)


class AttendanceTodayLiveClockTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@example.com', full_name='Admin User', password='x', role='admin')
        AppUser.objects.create(email='raja@company.com', full_name='Raja Pavan', password='x', role='employee')
        self.admin = Client(HTTP_X_USER_EMAIL='admin@example.com')
        self.day = local_today()

    def today(self):
        r = self.admin.get('/api/attendance/today?email=raja@company.com')
        self.assertEqual(r.status_code, 200)
        return r.json()

    def test_no_record_still_reports_threshold_and_no_break(self):
        d = self.today()
        self.assertFalse(d['checkedIn'])
        self.assertEqual(d['overtimeAfterMinutes'], 540)    # General Shift fallback
        self.assertFalse(d['onBreak'])
        self.assertIsNone(d['breakStartedAt'])

    def test_open_break_is_reported_until_it_ends(self):
        EmployeeAttendance.objects.create(email='raja@company.com', date=self.day,
                                          check_in=datetime.combine(self.day, time(9, 0)), status='present')
        AttendanceEvent.objects.create(email='raja@company.com', date=self.day, event='check-in',
                                       at=datetime.combine(self.day, time(9, 0)))
        AttendanceEvent.objects.create(email='raja@company.com', date=self.day, event='break-start',
                                       at=datetime.combine(self.day, time(13, 5)))
        d = self.today()
        self.assertTrue(d['checkedIn'])
        self.assertTrue(d['onBreak'])
        self.assertTrue(d['breakStartedAt'].endswith(' 13:05:00'))
        self.assertEqual(d['checkIn'][-8:], '09:00:00')

        AttendanceEvent.objects.create(email='raja@company.com', date=self.day, event='break-end',
                                       at=datetime.combine(self.day, time(13, 35)))
        d = self.today()
        self.assertFalse(d['onBreak'])
        self.assertIsNone(d['breakStartedAt'])

    def test_flexible_shift_sets_threshold_from_daily_hours(self):
        shift = Shift.objects.create(name='Flex 7.5', start_time=time(9, 0), end_time=time(18, 0),
                                     is_flexible=True, flex_hours_per_day=7.5, overtime_after_minutes=540)
        ShiftAssignment.objects.create(email='raja@company.com', shift=shift, effective_from=self.day)
        self.assertEqual(self.today()['overtimeAfterMinutes'], 450)

    def test_fixed_shift_uses_its_overtime_threshold(self):
        shift = Shift.objects.create(name='Long', start_time=time(8, 0), end_time=time(18, 0),
                                     is_flexible=False, overtime_after_minutes=600)
        ShiftAssignment.objects.create(email='raja@company.com', shift=shift, effective_from=self.day)
        self.assertEqual(self.today()['overtimeAfterMinutes'], 600)


class AvatarContentNegotiationTests(AvatarsApiTests):
    def test_browser_image_accept_header_is_not_refused(self):
        for accept in ('image/*', 'image/avif,image/webp,*/*', 'image/*,*/*;q=0.8'):
            r = self.employee.get('/api/avatars/priya@company.com', HTTP_ACCEPT=accept)
            self.assertEqual(r.status_code, 200, accept)
            self.assertEqual(r.content, PNG)
        r = self.employee.get('/api/avatars/nopic@company.com', HTTP_ACCEPT='image/*')
        self.assertEqual(r.status_code, 404)
