"""GET /api/user-settings/<email> fills a blank HRIS profile from the login
account, so the My Profile card and the topbar drawer show the same person."""
from django.test import Client, TestCase

from api.models import AppUser, UserProfile


class UserSettingsProfileSyncTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='sri@company.com', full_name='sri', password='x', role='recruitment',
                               employee_id='EV-0008', profile_pic='data:image/png;base64,QUJD')
        self.me = Client(HTTP_X_USER_EMAIL='sri@company.com')

    def test_no_profile_row_is_synthesised_from_the_account(self):
        r = self.me.get('/api/user-settings/sri@company.com')
        self.assertEqual(r.status_code, 200)
        p = r.json()['profile']
        self.assertEqual(p['firstName'], 'sri')
        self.assertEqual(p['lastName'], '')
        self.assertEqual(p['employeeId'], 'EV-0008')
        self.assertEqual(p['profilePic'], 'data:image/png;base64,QUJD')
        self.assertEqual(p['email'], 'sri@company.com')
        self.assertEqual(p['department'], '')      # every editable field present, blank

    def test_blank_profile_row_borrows_the_account_name_and_picture(self):
        UserProfile.objects.create(email='sri@company.com', department='Recruitment')
        p = self.me.get('/api/user-settings/sri@company.com').json()['profile']
        self.assertEqual(p['firstName'], 'sri')
        self.assertEqual(p['department'], 'Recruitment')
        self.assertEqual(p['profilePic'], 'data:image/png;base64,QUJD')
        self.assertEqual(p['employeeId'], 'EV-0008')

    def test_a_filled_profile_row_wins_over_the_account(self):
        UserProfile.objects.create(email='sri@company.com', first_name='Srikanth', last_name='Reddy',
                                   employee_id='EV-0099', profile_pic='data:image/png;base64,WFla')
        AppUser.objects.filter(email='sri@company.com').update(full_name='Someone Else')
        p = self.me.get('/api/user-settings/sri@company.com').json()['profile']
        self.assertEqual((p['firstName'], p['lastName']), ('Srikanth', 'Reddy'))
        self.assertEqual(p['employeeId'], 'EV-0099')
        self.assertEqual(p['profilePic'], 'data:image/png;base64,WFla')

    def test_multi_word_account_name_splits_into_first_and_last(self):
        AppUser.objects.filter(email='sri@company.com').update(full_name='Raja Pavan Kumar')
        p = self.me.get('/api/user-settings/sri@company.com').json()['profile']
        self.assertEqual((p['firstName'], p['lastName']), ('Raja', 'Pavan Kumar'))
