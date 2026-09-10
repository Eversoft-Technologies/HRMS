from django.test import TestCase, Client

from api.models import AppUser, UserProfile


class EmployeeDirectoryApiTests(TestCase):
    def setUp(self):
        AppUser.objects.create(
            email='admin@example.com',
            full_name='Admin User',
            password='password',
            role='admin',
        )
        self.client = Client(HTTP_X_USER_EMAIL='admin@example.com')

    def test_create_and_list_employee(self):
        response = self.client.post(
            '/api/employees',
            data={
                'fullName': 'Priya Sharma',
                'email': 'priya@company.com',
                'department': 'Engineering',
                'jobTitle': 'Software Engineer',
                'manager': 'Ankit R',
                'level': 'L4',
                'employmentType': 'Full-time',
                'location': 'Bengaluru / Remote',
                'annualCtc': '2800000',
                'startDate': '2026-09-01',
            },
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()['firstName'], 'Priya')
        self.assertEqual(response.json()['annualCtc'], '2800000.00')
        self.assertEqual(UserProfile.objects.get(email='priya@company.com').designation, 'Software Engineer')

        listing = self.client.get('/api/employees')
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()[0]['email'], 'priya@company.com')

    def test_duplicate_email_is_rejected(self):
        UserProfile.objects.create(email='priya@company.com', first_name='Priya')
        response = self.client.post(
            '/api/employees',
            data={
                'fullName': 'Priya Sharma',
                'email': 'PRIYA@COMPANY.COM',
                'department': 'Engineering',
                'jobTitle': 'Software Engineer',
            },
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 409)
