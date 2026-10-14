from django.test import TestCase, Client

from api.models import AppUser, JobPost
from api.serializers import job_title_problem, salary_range_problem


class JobPostValidationTests(TestCase):
    """BUG-HRMS-JOB-001 (title content) and BUG-HRMS-JOB-002 (salary range),
    enforced on create and on the Job Board's PATCH path alike."""

    def setUp(self):
        AppUser.objects.create(
            email='admin@example.com',
            full_name='Admin User',
            password='password',
            role='admin',
        )
        self.client = Client(HTTP_X_USER_EMAIL='admin@example.com')

    def post_job(self, **extra):
        body = {'title': 'Data Analyst', 'dept': 'Engineering', 'autoPost': False}
        body.update(extra)
        return self.client.post('/api/jobs', data=body, content_type='application/json')

    # -- title --------------------------------------------------------------
    def test_title_of_only_punctuation_is_rejected(self):
        for bad in (',,,', '@@@', '.', '---', '???', '$$$'):
            res = self.post_job(title=bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn('letters', res.json()['message'])
        self.assertEqual(JobPost.objects.count(), 0)

    def test_title_with_numbers_is_rejected(self):
        for bad in ('Developer 2', 'L3 Engineer', 'QA Automation Test Job 2026-001', '123'):
            res = self.post_job(title=bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn('numbers', res.json()['message'])
        self.assertEqual(JobPost.objects.count(), 0)

    def test_title_with_other_symbols_is_rejected(self):
        for bad in ('Dev @ Home', 'Engineer*', 'Sales [EU]', 'C++ Developer!'):
            res = self.post_job(title=bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn('only letters', res.json()['message'])
        self.assertEqual(JobPost.objects.count(), 0)

    def test_title_with_emoji_is_rejected_with_a_clear_message(self):
        for bad in ('\U0001F600 \U0001F525', 'Developer \U0001F600'):
            res = self.post_job(title=bad)
            self.assertEqual(res.status_code, 400, bad)
            self.assertIn('emoji', res.json()['message'])
        self.assertEqual(JobPost.objects.count(), 0)

    def test_titles_with_legitimate_punctuation_are_accepted(self):
        for good in ('C++ Developer', 'UI/UX Designer', '.NET Engineer', 'C# Dev (Remote)', 'Développeur',
                     'Sr. Front-End Developer', 'Sales & Marketing Lead', "Engineer's Assistant",
                     '\u0921\u0947\u0935\u0932\u092a\u0930'):   # Devanagari, with combining vowel signs
            res = self.post_job(title=good)
            self.assertEqual(res.status_code, 201, good)
            self.assertEqual(res.json()['title'], good)

    def test_title_rule_helper(self):
        self.assertEqual(job_title_problem('  '), 'Job title is required.')
        self.assertIn('only letters', job_title_problem('@@@'))
        self.assertIn('letters', job_title_problem(',,,'))
        self.assertIn('numbers', job_title_problem('Engineer 2'))
        self.assertIn('emoji', job_title_problem('Dev \U0001F600'))
        self.assertEqual(job_title_problem('QA Engineer'), '')

    # -- salary -------------------------------------------------------------
    def test_max_salary_below_min_is_rejected(self):
        res = self.post_job(salary='$ 500000 - 1')
        self.assertEqual(res.status_code, 400)
        self.assertIn('Maximum salary', res.json()['message'])
        self.assertEqual(JobPost.objects.count(), 0)

    def test_sane_salary_strings_are_accepted(self):
        for good in ('$ 50000 - 80000', '₹ 3,00,000 - 5,00,000', '10-12 LPA', '80k - 1L',
                     '₹ 300000', 'Negotiable', ''):
            res = self.post_job(salary=good)
            self.assertEqual(res.status_code, 201, good)

    def test_salary_rule_helper(self):
        self.assertIn('Maximum salary', salary_range_problem('$ 500000 - 1'))
        self.assertIn('Maximum salary', salary_range_problem('5,00,000 to 1,00,000'))
        self.assertIn('Maximum salary', salary_range_problem('1L - 80k'))
        self.assertEqual(salary_range_problem('$ 50000 - 80000'), '')
        self.assertEqual(salary_range_problem('10-12 LPA'), '')
        self.assertEqual(salary_range_problem('80k - 1L'), '')
        self.assertEqual(salary_range_problem('50000'), '')
        self.assertEqual(salary_range_problem(None), '')

    # -- PATCH path ---------------------------------------------------------
    def test_patch_applies_the_same_rules(self):
        job = self.post_job().json()
        bad_title = self.client.patch(
            f"/api/jobs/{job['id']}", data={'title': '@@@'}, content_type='application/json')
        self.assertEqual(bad_title.status_code, 400)
        bad_salary = self.client.patch(
            f"/api/jobs/{job['id']}", data={'salary': '$ 100 - 1'}, content_type='application/json')
        self.assertEqual(bad_salary.status_code, 400)
        job_row = JobPost.objects.get(pk=job['id'])
        self.assertEqual(job_row.title, 'Data Analyst')
        self.assertEqual(job_row.salary, '')

        ok = self.client.patch(
            f"/api/jobs/{job['id']}", data={'title': 'Senior Data Analyst', 'salary': '$ 1 - 100'},
            content_type='application/json')
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()['salary'], '$ 1 - 100')

    def test_patch_leaves_a_legacy_title_alone_when_unchanged(self):
        # Posts saved before the rules (numbers in the title) can still have
        # other fields edited; only a *new* title value is checked.
        legacy = JobPost.objects.create(title='QA Automation Test Job 2026-001', dept='QA', salary='$ 9 - 1')
        res = self.client.patch(
            f'/api/jobs/{legacy.id}',
            data={'title': legacy.title, 'salary': legacy.salary, 'status': 'Closed'},
            content_type='application/json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['status'], 'Closed')
        changed = self.client.patch(
            f'/api/jobs/{legacy.id}', data={'title': 'QA Automation Test Job 2026-002'},
            content_type='application/json')
        self.assertEqual(changed.status_code, 400)
