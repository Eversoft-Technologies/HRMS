from django.test import TestCase, Client

from api.models import AppUser, JobPost, ResumeScore


class JobCodeTests(TestCase):
    """Job Code on job posts: auto-assigned, unique, searchable, and carried on
    the resume scores that were evaluated against a post."""

    def setUp(self):
        AppUser.objects.create(
            email='admin@example.com',
            full_name='Admin User',
            password='password',
            role='admin',
        )
        self.client = Client(HTTP_X_USER_EMAIL='admin@example.com')

    def post_job(self, **extra):
        body = {'title': 'Data Analyst', 'dept': 'Engineering', 'description': 'Crunch numbers.'}
        body.update(extra)
        return self.client.post('/api/jobs', data=body, content_type='application/json')

    def test_code_is_auto_assigned_sequentially(self):
        first = self.post_job()
        second = self.post_job(title='QA Engineer')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(first.json()['code'], 'JOB-101')
        self.assertEqual(second.json()['code'], 'JOB-102')

    def test_next_code_preview_skips_past_custom_codes(self):
        self.post_job(code='job-250')          # normalised to upper case
        self.assertEqual(JobPost.objects.get().code, 'JOB-250')
        preview = self.client.get('/api/jobs/next-code')
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json()['code'], 'JOB-251')
        self.assertEqual(self.post_job().json()['code'], 'JOB-251')

    def test_duplicate_code_is_rejected_on_create_and_patch(self):
        self.post_job(code='JOB-500')
        dup = self.post_job(title='Other', code='job-500')
        self.assertEqual(dup.status_code, 400)
        self.assertIn('JOB-500', str(dup.json()))

        other = self.post_job(title='Other').json()
        patched = self.client.patch(
            f"/api/jobs/{other['id']}", data={'code': 'JOB-500'}, content_type='application/json')
        self.assertEqual(patched.status_code, 409)

        renamed = self.client.patch(
            f"/api/jobs/{other['id']}", data={'code': 'REQ-7'}, content_type='application/json')
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()['code'], 'REQ-7')

    def test_jobs_list_search_matches_code(self):
        self.post_job(title='Backend Engineer')
        self.post_job(title='Frontend Engineer')
        res = self.client.get('/api/jobs?search=job-102')
        self.assertEqual([j['title'] for j in res.json()], ['Frontend Engineer'])

    def test_resume_score_keeps_job_code(self):
        res = self.client.post(
            '/api/resume-scores',
            data={'name': 'Priya Sharma', 'role': 'Data Analyst', 'score': 88, 'jobCode': 'job-101'},
            content_type='application/json',
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()['jobCode'], 'JOB-101')
        self.assertEqual(ResumeScore.objects.get().job_code, 'JOB-101')
        listing = self.client.get('/api/resume-scores').json()
        self.assertEqual(listing[0]['jobCode'], 'JOB-101')
        # The picker's "recently used" strip orders codes by when they were
        # last scored against, so every row says when that was.
        self.assertTrue(listing[0]['createdAt'])
        self.assertTrue(listing[0]['updatedAt'])

        untagged = self.client.post(
            '/api/resume-scores',
            data={'name': 'Rahul Verma', 'score': 75, 'jobCode': None},
            content_type='application/json',
        )
        self.assertEqual(untagged.status_code, 201)
        self.assertEqual(untagged.json()['jobCode'], '')
