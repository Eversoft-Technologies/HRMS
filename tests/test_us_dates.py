"""US date format (MM/DD/YYYY) by default, still switchable in Settings › General."""
from datetime import date

from django.test import Client, TestCase

from api.models import AppUser, CompanyDetail
from api.timeutil import company_date, company_date_format


class UsDateFormatTests(TestCase):
    def test_default_is_us(self):
        self.assertEqual(company_date_format(), 'MM/DD/YYYY')
        self.assertEqual(company_date(date(2026, 1, 5)), '01/05/2026')
        self.assertEqual(CompanyDetail().date_format, 'MM/DD/YYYY')

    def test_follows_the_setting(self):
        CompanyDetail.objects.create(date_format='DD MMM YYYY')
        self.assertEqual(company_date(date(2026, 1, 5)), '05 Jan 2026')
        self.assertEqual(company_date(date(2026, 12, 31), 'YYYY-MM-DD'), '2026-12-31')
        self.assertEqual(company_date(None), '')

    def test_config_reports_us_by_default(self):
        AppUser.objects.create(email='cfg.dates@example.com', full_name='C', password='x', role='admin', status='active')
        cfg = Client(HTTP_X_USER_EMAIL='cfg.dates@example.com').get('/api/config').json()
        self.assertEqual((cfg.get('company') or {}).get('dateFormat'), 'MM/DD/YYYY')
