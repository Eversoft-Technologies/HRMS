from django.test import TestCase, Client


class HolidaysApiTests(TestCase):
    def get(self, year):
        response = Client().get(f'/api/holidays?year={year}')
        self.assertEqual(response.status_code, 200)
        return {(h['country'], h['name']): h['date'] for h in response.json()}

    def test_india_national_and_festival_holidays(self):
        h = self.get(2026)
        self.assertEqual(h[('IN', 'Republic Day')], '2026-01-26')
        self.assertEqual(h[('IN', 'Gandhi Jayanti')], '2026-10-02')
        self.assertEqual(h[('IN', 'Dussehra')], '2026-10-20')
        self.assertEqual(h[('IN', 'Diwali (Deepavali)')], '2026-11-08')
        self.assertEqual(h[('IN', 'Holi')], '2026-03-04')
        self.assertEqual(h[('IN', 'Makar Sankranti / Pongal')], '2026-01-14')
        self.assertEqual(h[('IN', 'Janmashtami')], '2026-09-04')

    def test_us_federal_holidays_follow_weekday_rules(self):
        h = self.get(2027)
        self.assertEqual(h[('US', 'Labor Day')], '2027-09-06')
        self.assertEqual(h[('US', 'Thanksgiving Day')], '2027-11-25')
        self.assertEqual(h[('US', 'Memorial Day')], '2027-05-31')
        self.assertEqual(len([k for k in h if k[0] == 'US']), 11)

    def test_national_three_present_past_festival_data_range(self):
        h = self.get(2040)
        self.assertEqual(h[('IN', 'Independence Day')], '2040-08-15')

    def test_rejects_bad_year(self):
        self.assertEqual(Client().get('/api/holidays?year=abc').status_code, 400)
