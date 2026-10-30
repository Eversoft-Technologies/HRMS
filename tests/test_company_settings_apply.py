"""Settings > General must apply across the app.

- the business timezone follows CompanyDetail.timezone (settings.TIME_ZONE is
  only the fallback), is validated on save, and the cache is dropped on save
- /api/config publishes the company block the overlays format from
- employee-ID fallbacks and the dashboard payroll KPI follow the settings
"""
from django.test import Client, TestCase, override_settings

from api import timeutil
from api.models import AppUser, CompanyDetail, EmployeeCompensation, UserProfile


class CompanyTimezoneTests(TestCase):
    def setUp(self):
        timeutil.reset_company_tz_cache()
        AppUser.objects.create(email='admin@example.com', full_name='Admin User', password='x', role='admin')
        self.admin = Client(HTTP_X_USER_EMAIL='admin@example.com')

    def tearDown(self):
        timeutil.reset_company_tz_cache()

    @override_settings(TIME_ZONE='Asia/Kolkata')
    def test_company_timezone_wins_over_settings(self):
        self.admin.get('/api/settings/general')                  # creates the defaults row
        CompanyDetail.objects.update(timezone='Europe/London')
        timeutil.reset_company_tz_cache()
        self.assertEqual(timeutil.business_tz().key, 'Europe/London')

    @override_settings(TIME_ZONE='Asia/Kolkata')
    def test_blank_company_timezone_falls_back_to_settings(self):
        self.admin.get('/api/settings/general')
        CompanyDetail.objects.update(timezone='')
        timeutil.reset_company_tz_cache()
        self.assertEqual(timeutil.business_tz().key, 'Asia/Kolkata')

    @override_settings(TIME_ZONE='Asia/Kolkata')
    def test_saving_general_settings_applies_immediately(self):
        self.admin.get('/api/settings/general')
        self.assertEqual(timeutil.business_tz().key, 'Asia/Kolkata')      # now cached
        r = self.admin.put('/api/settings/general', data={'timezone': 'America/New_York'},
                           content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(timeutil.business_tz().key, 'America/New_York')   # cache dropped on save

    def test_unknown_timezone_is_rejected(self):
        self.admin.get('/api/settings/general')
        r = self.admin.put('/api/settings/general', data={'timezone': 'Asia/Kolkatta'},
                           content_type='application/json')
        self.assertEqual(r.status_code, 400)
        self.assertIn('Unknown timezone', r.json()['message'])
        self.assertEqual(CompanyDetail.objects.first().timezone, 'Asia/Kolkata')

    def test_valid_timezone_helper(self):
        self.assertTrue(timeutil.valid_timezone('Europe/Berlin'))
        self.assertFalse(timeutil.valid_timezone('Mars/Olympus'))
        self.assertFalse(timeutil.valid_timezone(''))


class CompanyConfigAndFormatsTests(TestCase):
    def setUp(self):
        timeutil.reset_company_tz_cache()
        AppUser.objects.create(email='admin@example.com', full_name='Admin User', password='x', role='admin')
        self.admin = Client(HTTP_X_USER_EMAIL='admin@example.com')
        self.admin.get('/api/settings/general')
        CompanyDetail.objects.update(
            company_name='Acme Corp', brand_name='Acme', timezone='Europe/London', currency='USD',
            date_format='MM/DD/YYYY', work_week=['Mon', 'Tue', 'Wed', 'Thu'],
            emp_id_prefix='ACM/', emp_id_min_digits=3, emp_id_suffix='-X',
        )
        timeutil.reset_company_tz_cache()

    def test_config_publishes_the_company_block(self):
        r = Client().get('/api/config')                # public, used before sign-in
        self.assertEqual(r.status_code, 200)
        c = r.json()['company']
        self.assertEqual(c['brandName'], 'Acme')
        self.assertEqual(c['companyName'], 'Acme Corp')
        self.assertEqual(c['timezone'], 'Europe/London')
        self.assertEqual(c['currency'], 'USD')
        self.assertEqual(c['dateFormat'], 'MM/DD/YYYY')
        self.assertEqual(c['workWeek'], ['Mon', 'Tue', 'Wed', 'Thu'])
        self.assertEqual((c['empIdPrefix'], c['empIdMinDigits'], c['empIdSuffix']), ('ACM/', 3, '-X'))

    def test_employee_id_fallback_uses_the_configured_format(self):
        u = AppUser.objects.create(email='new@example.com', full_name='New Person', password='x', role='employee')
        profile = self.admin.get(f'/api/employees/{u.id}/profile').json()
        self.assertEqual(profile['person']['employeeId'], 'ACM/' + str(u.id).zfill(3) + '-X')
        rows = self.admin.get('/api/directory?q=new').json()
        hit = [r for r in (rows if isinstance(rows, list) else rows.get('results', rows.get('employees', []))) if r.get('email') == 'new@example.com']
        if hit:
            self.assertEqual(hit[0]['employeeId'], 'ACM/' + str(u.id).zfill(3) + '-X')

    def test_dashboard_payroll_kpi_uses_the_configured_currency(self):
        UserProfile.objects.create(email='admin@example.com', first_name='Admin')
        EmployeeCompensation.objects.create(email='admin@example.com', base_amount=12500, annual_ctc=150000,
                                            status='active')
        r = self.admin.get('/api/dashboard/stats')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['monthlyPayroll'].startswith('$'), r.json()['monthlyPayroll'])
        CompanyDetail.objects.update(currency='INR')
        self.assertTrue(self.admin.get('/api/dashboard/stats').json()['monthlyPayroll'].startswith('₹'))
