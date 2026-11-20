from django.test import TestCase, Client

from api.models import AppUser, EmployeeDirectoryEntry, UserProfile


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

    def test_delete_removes_directory_row_and_preserves_profile(self):
        employee = AppUser.objects.create(
            email='priya@company.com',
            full_name='Priya Sharma',
            password='password',
            role='employee',
        )
        UserProfile.objects.create(
            email=employee.email, first_name='Priya', last_name='Sharma',
            department='Engineering', phone='+91 90000 00000',
        )

        response = self.client.delete(f'/api/employees/{employee.email}')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'ok': True, 'email': employee.email})
        profile = UserProfile.objects.get(email=employee.email)
        self.assertEqual(profile.department, 'Engineering')
        self.assertEqual(profile.phone, '+91 90000 00000')
        self.assertFalse(EmployeeDirectoryEntry.objects.filter(profile=profile).exists())
        self.assertTrue(AppUser.objects.filter(pk=employee.id).exists())
        refreshed_emails = [row['email'] for row in self.client.get('/api/employees').json()]
        self.assertNotIn(employee.email, refreshed_emails)
        details = self.client.get(f'/api/employees/{employee.email}')
        self.assertEqual(details.status_code, 200)
        self.assertEqual(details.json()['phone'], '+91 90000 00000')

    def test_delete_requires_employee_delete_permission(self):
        employee = AppUser.objects.create(
            email='priya@company.com',
            full_name='Priya Sharma',
            password='password',
            role='employee',
        )
        UserProfile.objects.create(email=employee.email, first_name='Priya', last_name='Sharma')
        viewer = AppUser.objects.create(
            email='viewer@example.com',
            full_name='Viewer User',
            password='password',
            role='employee',
        )

        response = Client(HTTP_X_USER_EMAIL=viewer.email).delete(f'/api/employees/{employee.id}')

        self.assertEqual(response.status_code, 403)
        self.assertTrue(UserProfile.objects.filter(email=employee.email).exists())

    def test_employee_can_be_added_again_after_hris_row_deletion(self):
        employee = AppUser.objects.create(
            email='priya@company.com',
            full_name='Priya Sharma',
            password='password',
            role='employee',
        )
        UserProfile.objects.create(email=employee.email, first_name='Priya', last_name='Sharma')
        self.client.delete(f'/api/employees/{employee.email}')

        response = self.client.post(
            '/api/employees',
            data={
                'fullName': 'Priya Sharma',
                'email': employee.email,
                'department': 'Engineering',
                'jobTitle': 'Software Engineer',
            },
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 201)
        refreshed_emails = [row['email'] for row in self.client.get('/api/employees').json()]
        self.assertIn(employee.email, refreshed_emails)
        self.assertTrue(AppUser.objects.filter(pk=employee.id).exists())
        self.assertTrue(EmployeeDirectoryEntry.objects.filter(profile__email=employee.email).exists())
