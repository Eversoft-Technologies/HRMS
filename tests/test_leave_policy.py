"""Leave policy set by the admin (Settings › General): leave types and days per
year drive balances and what an employee may apply for."""
from datetime import date
from unittest.mock import patch

from django.test import Client, TestCase

from api.models import AppUser, LeaveRequest


class LeavePolicyTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@example.com', full_name='Admin', status='active', role='admin')
        AppUser.objects.create(email='emp@example.com', full_name='Emp', status='active', role='recruitment')
        self.admin = Client(HTTP_X_USER_EMAIL='admin@example.com')
        self.emp = Client(HTTP_X_USER_EMAIL='emp@example.com')
        self.today = patch('api.views.local_today', return_value=date(2026, 11, 4))
        self.today.start()
        self.addCleanup(self.today.stop)

    def put(self, client, body):
        return client.put('/api/leave/policy', body, content_type='application/json')

    def apply(self, typ, frm, to):
        return self.emp.post('/api/leave', {'email': 'emp@example.com', 'type': typ, 'fromDate': frm, 'toDate': to},
                             content_type='application/json')

    def balances(self):
        return {b['type']: b for b in self.emp.get('/api/leave/balance?email=emp@example.com').json()['balances']}

    def test_defaults_until_the_admin_sets_one(self):
        p = self.emp.get('/api/leave/policy').json()
        self.assertEqual([(t['name'], t['days']) for t in p['types']],
                         [('Casual Leave', 12), ('Sick Leave', 12), ('Earned Leave', 15)])
        self.assertEqual(self.balances()['Casual Leave']['remaining'], 12)

    def test_admin_sets_types_and_days(self):
        r = self.put(self.admin, {'types': [{'name': 'Casual Leave', 'days': 8}, {'name': 'Sick Leave', 'days': 6},
                                            {'name': ' Maternity  Leave ', 'days': 180}, {'name': 'Loss of Pay', 'days': None}],
                                  'enforceBalance': True})
        self.assertEqual(r.status_code, 200, r.content)
        b = self.balances()
        self.assertEqual(list(b), ['Casual Leave', 'Sick Leave', 'Maternity Leave', 'Loss of Pay'])
        self.assertEqual((b['Casual Leave']['allowance'], b['Sick Leave']['remaining']), (8, 6))
        self.assertEqual((b['Loss of Pay']['unlimited'], b['Loss of Pay']['remaining']), (True, None))

    def test_only_settings_managers_can_change_it(self):
        r = self.put(self.emp, {'types': [{'name': 'Casual Leave', 'days': 99}]})
        self.assertEqual(r.status_code, 403)

    def test_bad_policies_are_refused(self):
        for body, msg in [({'types': []}, 'at least one'),
                          ({'types': [{'name': '', 'days': 2}]}, 'needs a name'),
                          ({'types': [{'name': 'Sick', 'days': 2}, {'name': 'sick', 'days': 3}]}, 'listed twice'),
                          ({'types': [{'name': 'Sick', 'days': -1}]}, 'whole number'),
                          ({'types': [{'name': 'Sick', 'days': 2.5}]}, 'whole number')]:
            r = self.put(self.admin, body)
            self.assertEqual(r.status_code, 400, body)
            self.assertIn(msg, r.json()['message'])

    def test_balance_counts_this_year_and_blocks_going_over(self):
        self.put(self.admin, {'types': [{'name': 'Casual Leave', 'days': 3}, {'name': 'Loss of Pay', 'days': None}]})
        LeaveRequest.objects.create(email='emp@example.com', type='Casual Leave', from_date=date(2025, 12, 1),
                                    to_date=date(2025, 12, 3), days=3, status='Approved')      # last year
        LeaveRequest.objects.create(email='emp@example.com', type='Casual Leave', from_date=date(2026, 3, 2),
                                    to_date=date(2026, 3, 2), days=1, status='Approved')
        self.assertEqual(self.balances()['Casual Leave']['remaining'], 2)
        self.assertEqual(self.apply('Casual Leave', '2026-11-10', '2026-11-10').status_code, 201)   # 1 pending
        r = self.apply('Casual Leave', '2026-11-16', '2026-11-17')                                  # 2 > 1 left
        self.assertEqual(r.status_code, 400)
        self.assertIn('1 day of Casual Leave left', r.json()['message'])
        self.assertEqual(self.apply('Loss of Pay', '2026-11-16', '2026-11-27').status_code, 201)   # no limit

    def test_unknown_type_refused_and_case_normalised(self):
        r = self.apply('Vacation', '2026-11-10', '2026-11-10')
        self.assertEqual(r.status_code, 400)
        self.assertIn('Casual Leave, Sick Leave, Earned Leave', r.json()['message'])
        r = self.apply('sick leave', '2026-11-10', '2026-11-10')
        self.assertEqual((r.status_code, r.json()['type']), (201, 'Sick Leave'))

    def test_enforcement_can_be_switched_off(self):
        self.put(self.admin, {'types': [{'name': 'Casual Leave', 'days': 1}], 'enforceBalance': False})
        self.assertEqual(self.apply('Casual Leave', '2026-11-10', '2026-11-13').status_code, 201)
