"""Settings > Notifications: per-user preferences that the senders honour."""
from django.test import Client, TestCase

from api.models import AppUser, LeaveRequest, Notification, NotificationPreference, Permission, Role, RolePermission
from api.views import create_notification


class NotificationPrefsApiTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='me@co.com', full_name='Me', password='x', role='recruitment')
        AppUser.objects.create(email='other@co.com', full_name='Other', password='x', role='recruitment')
        self.me = Client(HTTP_X_USER_EMAIL='me@co.com')

    def test_defaults_match_the_settings_page(self):
        r = self.me.get('/api/user-settings/me@co.com/notification-preferences')
        self.assertEqual(r.status_code, 200)
        cats = {c['key']: c for c in r.json()['categories']}
        self.assertEqual(len(cats), 8)
        self.assertTrue(cats['leave_approvals']['enabled'])
        self.assertFalse(cats['job_applications']['enabled'])
        self.assertFalse(cats['ai_digest']['enabled'])
        self.assertTrue(cats['leave_approvals']['active'])
        self.assertFalse(cats['attrition_risk']['active'])
        self.assertEqual([c['label'] for c in r.json()['categories']][:2],
                         ['Payroll approval reminders', 'Attrition risk alerts'])

    def test_user_saves_their_own_preferences(self):
        r = self.me.put('/api/user-settings/me@co.com/notification-preferences',
                        {'prefs': {'leave_approvals': False, 'ai_digest': True}}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        cats = {c['key']: c['enabled'] for c in r.json()['categories']}
        self.assertEqual((cats['leave_approvals'], cats['ai_digest'], cats['payroll_approvals']), (False, True, True))
        # partial update keeps earlier choices
        self.me.put('/api/user-settings/me@co.com/notification-preferences',
                    {'prefs': {'ai_digest': False}}, content_type='application/json')
        self.assertEqual(NotificationPreference.objects.get(pk='me@co.com').prefs,
                         {'leave_approvals': False, 'ai_digest': False})

    def test_bad_input_is_rejected(self):
        url = '/api/user-settings/me@co.com/notification-preferences'
        self.assertEqual(self.me.put(url, {'prefs': {'nope': True}}, content_type='application/json').status_code, 400)
        self.assertEqual(self.me.put(url, {'prefs': {'ai_digest': 'yes'}}, content_type='application/json').status_code, 400)
        self.assertEqual(self.me.put(url, {'prefs': {}}, content_type='application/json').status_code, 400)

    def test_sound_settings_default_save_and_merge(self):
        url = '/api/user-settings/me@co.com/notification-preferences'
        snd = self.me.get(url).json()['sound']
        self.assertEqual(snd, {'notificationSound': True, 'messageSound': True, 'notificationTone': 'chime',
                               'messageTone': 'pop', 'volume': 70, 'inAppPopups': True,
                               'desktopPopups': False, 'muteInDnd': True})
        r0 = self.me.put(url, {'sound': {'notificationTone': 'marimba', 'messageTone': 'bubble', 'inAppPopups': False}},
                         content_type='application/json')
        self.assertEqual((r0.json()['sound']['notificationTone'], r0.json()['sound']['messageTone'],
                          r0.json()['sound']['inAppPopups']), ('marimba', 'bubble', False))
        r = self.me.put(url, {'sound': {'messageSound': False, 'volume': 35}}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()['sound']['messageSound'], r.json()['sound']['volume'],
                          r.json()['sound']['notificationSound']), (False, 35, True))
        # category prefs and sound settings live side by side and merge
        self.me.put(url, {'prefs': {'ai_digest': True}, 'sound': {'desktopPopups': True}}, content_type='application/json')
        body = self.me.get(url).json()
        self.assertEqual((body['sound']['volume'], body['sound']['desktopPopups'], body['sound']['messageSound']), (35, True, False))
        self.assertTrue({c['key']: c['enabled'] for c in body['categories']}['ai_digest'])

    def test_bad_sound_settings_are_rejected(self):
        url = '/api/user-settings/me@co.com/notification-preferences'
        for bad in ({'volume': 150}, {'volume': '50'}, {'volume': True}, {'messageSound': 'no'}, {'loud': True}, {},
                    {'notificationTone': 'pop'}, {'messageTone': 'siren'}, {'inAppPopups': 'yes'}):
            self.assertEqual(self.me.put(url, {'sound': bad}, content_type='application/json').status_code, 400, bad)
        self.assertEqual(self.me.put(url, {}, content_type='application/json').status_code, 400)
        self.assertFalse(NotificationPreference.objects.filter(pk='me@co.com').exists())

    def test_cannot_change_someone_elses_without_settings_manage(self):
        r = self.me.put('/api/user-settings/other@co.com/notification-preferences',
                        {'prefs': {'leave_approvals': False}}, content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertFalse(NotificationPreference.objects.filter(pk='other@co.com').exists())
        self.assertEqual(Client().get('/api/user-settings/me@co.com/notification-preferences').status_code, 401)


class NotificationPrefsDeliveryTests(TestCase):
    def test_switched_off_category_is_not_delivered(self):
        NotificationPreference.objects.create(email='me@co.com', prefs={'leave_approvals': False})
        self.assertIsNone(create_notification('me@co.com', 't', 'm', category='leave_approvals'))
        self.assertIsNotNone(create_notification('me@co.com', 't', 'm', category='onboarding_milestones'))
        self.assertIsNotNone(create_notification('me@co.com', 't', 'm'))           # untagged always delivered
        self.assertIsNotNone(create_notification('you@co.com', 't', 'm', category='leave_approvals'))
        self.assertEqual(Notification.objects.count(), 3)

    def test_leave_flow_respects_the_preference(self):
        role = Role.objects.create(name='Employee')
        for code in ('leave.create', 'leave.view'):
            RolePermission.objects.create(role=role, permission=Permission.objects.create(code=code, name=code))
        AppUser.objects.create(email='emp@co.com', full_name='Emp', password='x', role_ref=role)
        NotificationPreference.objects.create(email='emp@co.com', prefs={'leave_approvals': False})
        c = Client(HTTP_X_USER_EMAIL='emp@co.com')
        r = c.post('/api/leave', {'email': 'emp@co.com', 'type': 'Casual Leave', 'fromDate': '2026-11-10',
                                           'toDate': '2026-11-10', 'days': 1, 'reason': 'x'},
                   content_type='application/json')
        self.assertIn(r.status_code, (200, 201), r.content)
        self.assertTrue(LeaveRequest.objects.filter(email='emp@co.com').exists())
        self.assertFalse(Notification.objects.filter(recipient='emp@co.com').exists())
