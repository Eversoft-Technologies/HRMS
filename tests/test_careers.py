"""Public careers page, embeddable widget API and the recruiter inbox
(hrms_plus/careers.py, careers_pages.py)."""
import base64
import io
import json
import time
import zipfile
from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.test import Client, TestCase, override_settings

from api.models import (AppUser, CompanyDetail, JobPost, MasterDataSet, OnboardingCandidate, Permission, Role,
                        RolePermission)
from api.timeutil import local_now
from hrms_plus import careers as C
from hrms_plus.models import JobApplication

PDF = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 40


def b64(raw):
    return base64.b64encode(raw).decode('ascii')


def docx_bytes(word=True):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        if word:
            z.writestr('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Python developer with Django '
                                            'experience building APIs</w:t></w:r></w:p></w:body></w:document>')
        else:
            z.writestr('xl/workbook.xml', '<workbook/>')
    return buf.getvalue()


class Base(TestCase):
    def setUp(self):
        cache.clear()
        C.ASYNC_SIDE_EFFECTS = False
        self.addCleanup(setattr, C, 'ASYNC_SIDE_EFFECTS', True)
        p_view = Permission.objects.create(code='recruitment.view', name='View recruitment')
        p_edit = Permission.objects.create(code='recruitment.edit', name='Edit recruitment')
        p_onb = Permission.objects.create(code='onboarding.create', name='Create onboarding')
        viewer = Role.objects.create(name='Recruit Viewer')
        RolePermission.objects.create(role=viewer, permission=p_view)
        editor = Role.objects.create(name='Recruiter')
        for p in (p_view, p_edit, p_onb):
            RolePermission.objects.create(role=editor, permission=p)
        emp = Role.objects.create(name='Employee')
        AppUser.objects.create(email='viewer@co.com', full_name='Viewer', role_ref=viewer, status='active')
        AppUser.objects.create(email='rec@co.com', full_name='Rec', role_ref=editor, status='active')
        AppUser.objects.create(email='emp@co.com', full_name='Emp', role_ref=emp, status='active')
        CompanyDetail.objects.create(company_name='Acme Corp')
        self.job = JobPost.objects.create(code='JOB-101', title='Backend Engineer', dept='Engineering',
                                          location='Hyderabad', type='Full-time', salary='20-30 LPA',
                                          description='Build <b>APIs</b> with Django.', status='Active',
                                          custom_fields={'internal_budget': 'secret', 'perks': 'Free lunch'})
        self.job2 = JobPost.objects.create(code='JOB-102', title='Designer', dept='Design', location='Remote',
                                           type='Contract', is_remote=True, status='Active')
        self.closed = JobPost.objects.create(code='JOB-103', title='Old Role', dept='Engineering', status='Closed')
        self.public = Client()
        mail = mock.patch('api.mailer.send_email', return_value={'ok': True})
        self.sent = mail.start()
        self.addCleanup(mail.stop)

    def settings_set(self, **values):
        C.save_settings(values)

    def payload(self, **over):
        body = {
            'jobId': self.job.id, 'formToken': C.form_token(self.job.id, issued=time.time() - 30),
            'fullName': 'Asha Rao', 'email': 'asha@example.com', 'phone': '+91 98765 43210',
            'location': 'Pune', 'linkedinUrl': 'https://linkedin.com/in/asha', 'coverLetter': 'Hello',
            'consent': True, 'website': '',
            'resume': {'name': 'asha.pdf', 'mime': 'application/pdf', 'data': b64(PDF)},
        }
        body.update(over)
        return body

    def apply(self, client=None, **over):
        return (client or self.public).post('/api/public/careers/apply', data=json.dumps(self.payload(**over)),
                                            content_type='application/json')

    def as_user(self, email):
        return Client(HTTP_X_USER_EMAIL=email)


class PublicJobsTests(Base):
    def test_only_active_jobs_and_no_internal_data(self):
        r = self.public.get('/api/public/careers/jobs')
        self.assertEqual(r.status_code, 200)
        d = r.json()
        codes = {j['code'] for j in d['jobs']}
        self.assertEqual(codes, {'JOB-101', 'JOB-102'})
        blob = json.dumps(d)
        self.assertNotIn('internal_budget', blob)
        self.assertNotIn('secret', blob)
        self.assertNotIn('applicants', blob)
        self.assertNotIn('20-30 LPA', blob)       # salary hidden by default
        self.assertEqual(d['company']['name'], 'Acme Corp')

    def test_filters(self):
        g = lambda q: {j['code'] for j in self.public.get('/api/public/careers/jobs' + q).json()['jobs']}
        self.assertEqual(g('?department=engineering'), {'JOB-101'})
        self.assertEqual(g('?remote=1'), {'JOB-102'})
        self.assertEqual(g('?type=Contract'), {'JOB-102'})
        self.assertEqual(g('?location=Hyderabad'), {'JOB-101'})
        self.assertEqual(g('?q=backend'), {'JOB-101'})
        self.assertEqual(g('?q=nothing-matches'), set())

    def test_detail_and_closed_job(self):
        r = self.public.get('/api/public/careers/jobs/JOB-101')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['formToken'])
        self.assertEqual(self.public.get(f'/api/public/careers/jobs/{self.job.id}').status_code, 200)
        self.assertEqual(self.public.get('/api/public/careers/jobs/JOB-103').status_code, 404)

    def test_salary_applicants_and_public_fields_when_configured(self):
        self.settings_set(showSalary=True, showApplicants=True, publicFields=['perks'])
        from api.models import JobFormTemplate
        JobFormTemplate.objects.create(name='T', is_active=True, schema=[{'id': 's', 'fields': [
            {'key': 'perks', 'label': 'Perks', 'type': 'text'},
            {'key': 'internal_budget', 'label': 'Budget', 'type': 'text'}]}])
        d = self.public.get('/api/public/careers/jobs/JOB-101').json()['job']
        self.assertEqual(d['salary'], '20-30 LPA')
        self.assertIn('applicants', d)
        self.assertEqual(d['fields'], [{'label': 'Perks', 'value': 'Free lunch'}])

    def test_disabled(self):
        self.settings_set(enabled=False)
        self.assertEqual(self.public.get('/api/public/careers/jobs').status_code, 404)
        self.assertEqual(self.public.get('/careers').status_code, 404)


class PagesTests(Base):
    def test_list_page_without_login(self):
        r = self.public.get('/careers')
        self.assertEqual(r.status_code, 200)
        html = r.content.decode()
        self.assertIn('Backend Engineer', html)
        self.assertNotIn('Old Role', html)
        self.assertIn("frame-ancestors 'self'", r['Content-Security-Policy'])
        r = self.public.get('/careers?department=Design')
        self.assertIn('Designer', r.content.decode())
        self.assertNotIn('Backend Engineer', r.content.decode())

    def test_detail_page_seo_and_escaping(self):
        r = self.public.get('/careers/JOB-101')
        self.assertEqual(r.status_code, 200)
        html = r.content.decode()
        self.assertIn('application/ld+json', html)
        self.assertIn('"@type": "JobPosting"', html)
        self.assertIn('<meta name="description"', html)
        self.assertNotIn('<b>APIs</b>', html)      # description is escaped
        self.assertEqual(self.public.get('/careers/JOB-103').status_code, 404)

    def test_widget_js_served(self):
        r = self.public.get('/careers/widget.js')
        self.assertEqual(r.status_code, 200)
        self.assertIn('javascript', r['Content-Type'])
        self.assertIn(b'attachShadow', r.content)


class ApplyTests(Base):
    def test_happy_path_counter_and_side_effects(self):
        with self.captureOnCommitCallbacks(execute=True):
            r = self.apply()
        self.assertEqual(r.status_code, 201, r.content)
        app = JobApplication.objects.get()
        self.assertEqual(app.email, 'asha@example.com')
        self.assertEqual(app.status, 'new')
        self.assertTrue(app.consent)
        self.assertEqual(len(app.ip_hash), 64)
        self.assertNotIn('127.0.0.1', app.ip_hash)
        self.assertEqual(base64.b64decode(app.resume_data), PDF)
        self.job.refresh_from_db()
        self.assertEqual(self.job.applicants, 1)
        self.assertTrue(any(c.args[0] == 'asha@example.com' for c in self.sent.call_args_list))
        from api.models import Notification
        self.assertTrue(Notification.objects.filter(recipient='rec@co.com').exists())
        self.assertFalse(Notification.objects.filter(recipient='emp@co.com').exists())

    def test_docx_accepted(self):
        r = self.apply(resume={'name': 'cv.docx', 'data': b64(docx_bytes())})
        self.assertEqual(r.status_code, 201, r.content)

    def test_invalid_type_oversize_and_disguised(self):
        r = self.apply(resume={'name': 'cv.exe', 'data': b64(b'MZ....')})
        self.assertEqual(r.status_code, 400)
        self.assertIn('resume', r.json()['errors'])
        r = self.apply(resume={'name': 'cv.pdf', 'data': b64(PNG)})                 # PNG named .pdf
        self.assertEqual(r.status_code, 400)
        self.assertIn('resume', r.json()['errors'])
        r = self.apply(resume={'name': 'cv.docx', 'data': b64(docx_bytes(word=False))})   # zip, not Word
        self.assertEqual(r.status_code, 400)
        r = self.apply(resume={'name': 'cv.docx', 'data': b64(PDF)})                # PDF named .docx
        self.assertEqual(r.status_code, 400)
        big = PDF + b'0' * (5 * 1024 * 1024 + 10)
        r = self.apply(resume={'name': 'cv.pdf', 'data': b64(big)})
        self.assertEqual(r.status_code, 400)
        self.assertIn('5 MB', r.json()['errors']['resume'])
        self.assertEqual(JobApplication.objects.count(), 0)

    def test_honeypot(self):
        r = self.apply(website='http://spam.example')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['code'], 'SPAM_SUSPECTED')
        self.assertEqual(JobApplication.objects.count(), 0)

    def test_too_fast_and_bad_token(self):
        r = self.apply(formToken=C.form_token(self.job.id))
        self.assertEqual(r.json()['code'], 'TOO_FAST')
        r = self.apply(formToken='forged')
        self.assertEqual(r.json()['code'], 'FORM_EXPIRED')
        r = self.apply(formToken=C.form_token(self.job2.id, issued=time.time() - 30))   # another job's token
        self.assertEqual(r.json()['code'], 'FORM_EXPIRED')

    def test_rate_limit(self):
        iph = None
        for i in range(5):
            r = self.apply(email=f'p{i}@example.com', resume={'name': 'a.pdf', 'data': b64(PDF + bytes([i]))})
            self.assertEqual(r.status_code, 201, r.content)
            iph = iph or JobApplication.objects.first().ip_hash
        r = self.apply(email='p9@example.com', resume={'name': 'a.pdf', 'data': b64(PDF + b'9')})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()['code'], 'RATE_LIMITED')
        # an hour later the window is clear
        JobApplication.objects.update(created_at=local_now() - timedelta(hours=2))
        r = self.apply(email='p9@example.com', resume={'name': 'a.pdf', 'data': b64(PDF + b'9')})
        self.assertEqual(r.status_code, 201)

    def test_duplicate(self):
        self.assertEqual(self.apply().status_code, 201)
        r = self.apply()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()['code'], 'ALREADY_APPLIED')
        r = self.apply(email='other@example.com')            # same resume file, same job
        self.assertEqual(r.status_code, 409)
        r = self.apply(jobId=self.job2.id, formToken=C.form_token(self.job2.id, issued=time.time() - 30))
        self.assertEqual(r.status_code, 201)                 # another job is fine
        JobApplication.objects.filter(job=self.job).update(created_at=local_now() - timedelta(days=31))
        self.assertEqual(self.apply().status_code, 201)       # after 30 days
        self.job.refresh_from_db()
        self.assertEqual(self.job.applicants, 2)

    def test_consent_required_and_validation(self):
        r = self.apply(consent=False)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['code'], 'CONSENT_REQUIRED')
        r = self.apply(email='not-an-email', fullName='', linkedinUrl='javascript:alert(1)')
        errs = r.json()['errors']
        self.assertEqual({'email', 'fullName', 'linkedinUrl'}, set(errs))

    def test_closed_job_cannot_be_applied(self):
        r = self.apply(jobId=self.closed.id, formToken=C.form_token(self.closed.id, issued=time.time() - 30))
        self.assertEqual(r.status_code, 404)

    def test_questions(self):
        self.settings_set(questions=[{'label': 'Notice period', 'type': 'select', 'required': True,
                                      'options': ['Immediate', '30 days']}])
        r = self.apply()
        self.assertIn('answers.notice_period', r.json()['errors'])
        r = self.apply(answers={'notice_period': 'Immediate', 'unknown': 'x'})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(JobApplication.objects.get().answers, {'notice_period': {'label': 'Notice period',
                                                                                  'value': 'Immediate'}})


class CorsTests(Base):
    def setUp(self):
        super().setUp()
        self.settings_set(allowedOrigins=['https://eversoftit.com/', 'not a url', '*'])

    def test_settings_normalise_origins(self):
        self.assertEqual(C.get_settings()['allowedOrigins'], ['https://eversoftit.com'])

    @override_settings(CORS_ALLOW_ALL_ORIGINS=False)
    def test_allowed_origin(self):
        r = self.public.get('/api/public/careers/jobs', HTTP_ORIGIN='https://eversoftit.com')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['Access-Control-Allow-Origin'], 'https://eversoftit.com')
        self.assertNotIn('Access-Control-Allow-Credentials', r)
        pre = self.public.options('/api/public/careers/apply', HTTP_ORIGIN='https://eversoftit.com',
                                  HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST')
        self.assertEqual(pre['Access-Control-Allow-Origin'], 'https://eversoftit.com')
        r = self.apply(client=Client(HTTP_ORIGIN='https://eversoftit.com'), source='careers')
        self.assertEqual(r.status_code, 201)
        app = JobApplication.objects.get()
        self.assertEqual((app.source, app.source_detail), ('widget', 'eversoftit.com'))

    @override_settings(CORS_ALLOW_ALL_ORIGINS=False)
    def test_other_origin_refused(self):
        r = self.public.get('/api/public/careers/jobs', HTTP_ORIGIN='https://evil.example')
        self.assertEqual(r.status_code, 403)
        self.assertNotIn('Access-Control-Allow-Origin', r)
        pre = self.public.options('/api/public/careers/apply', HTTP_ORIGIN='https://evil.example',
                                  HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST')
        self.assertNotIn('Access-Control-Allow-Origin', pre)
        r = self.apply(client=Client(HTTP_ORIGIN='https://evil.example'))
        self.assertEqual(r.status_code, 403)
        r = self.apply(client=Client(HTTP_ORIGIN='null'))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(JobApplication.objects.count(), 0)

    def test_same_origin_allowed(self):
        r = self.apply(client=Client(HTTP_ORIGIN='http://testserver'))
        self.assertEqual(r.status_code, 201)
        self.assertEqual(JobApplication.objects.get().source, 'careers')


class RecruiterTests(Base):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.apply().status_code, 201)
        self.app = JobApplication.objects.get()

    def test_permissions(self):
        self.assertEqual(Client().get('/api/recruit/applications').status_code, 401)
        self.assertEqual(self.as_user('emp@co.com').get('/api/recruit/applications').status_code, 403)
        self.assertEqual(self.as_user('viewer@co.com').get('/api/recruit/applications').status_code, 200)
        r = self.as_user('viewer@co.com').patch(f'/api/recruit/applications/{self.app.id}',
                                                data=json.dumps({'status': 'screening'}), content_type='application/json')
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.as_user('emp@co.com').get(f'/api/recruit/applications/{self.app.id}/resume').status_code, 403)
        r = self.as_user('viewer@co.com').put('/api/recruit/careers/settings', data='{}', content_type='application/json')
        self.assertEqual(r.status_code, 403)

    def test_list_never_contains_resume(self):
        r = self.as_user('viewer@co.com').get('/api/recruit/applications')
        d = r.json()
        self.assertEqual(d['total'], 1)
        self.assertEqual(d['counts']['new'], 1)
        blob = json.dumps(d)
        self.assertNotIn(b64(PDF), blob)
        self.assertNotIn('resumeData', blob)
        self.assertNotIn('resume_data', blob)
        det = self.as_user('viewer@co.com').get(f'/api/recruit/applications/{self.app.id}').json()
        self.assertNotIn(b64(PDF), json.dumps(det))
        self.assertTrue(det['hasResume'])

    def test_filters(self):
        u = self.as_user('viewer@co.com')
        self.assertEqual(u.get(f'/api/recruit/applications?job={self.job2.id}').json()['total'], 0)
        self.assertEqual(u.get(f'/api/recruit/applications?job={self.job.id}&status=new').json()['total'], 1)
        self.assertEqual(u.get('/api/recruit/applications?source=widget').json()['total'], 0)
        self.assertEqual(u.get('/api/recruit/applications?q=asha').json()['total'], 1)
        today = local_now().date().isoformat()
        self.assertEqual(u.get(f'/api/recruit/applications?from={today}&to={today}').json()['total'], 1)

    def test_resume_download_is_audited(self):
        r = self.as_user('viewer@co.com').get(f'/api/recruit/applications/{self.app.id}/resume')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, PDF)
        self.assertIn('attachment', r['Content-Disposition'])
        from api.models import PayrollAuditLog
        self.assertTrue(PayrollAuditLog.objects.filter(action='careers.resume_download',
                                                       entity_id=str(self.app.id)).exists())

    def test_status_transitions(self):
        u = self.as_user('rec@co.com')
        url = f'/api/recruit/applications/{self.app.id}'
        move = lambda s, note='': u.patch(url, data=json.dumps({'status': s, 'note': note}),
                                          content_type='application/json')
        self.assertEqual(move('hired').status_code, 400)          # cannot skip stages
        for s in ('screening', 'interview', 'offer'):
            r = move(s)
            self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(move('rejected').json()['code'], 'NOTE_REQUIRED')
        r = move('rejected', 'Salary mismatch')
        self.assertEqual(r.json()['status'], 'rejected')
        self.assertEqual(move('screening').status_code, 200)       # re-open
        self.app.refresh_from_db()
        self.assertEqual((self.app.status, self.app.reviewed_by), ('screening', 'rec@co.com'))
        self.assertTrue(len(r.json()['history']) >= 4)

    def test_onboard_only_when_hired(self):
        u = self.as_user('rec@co.com')
        url = f'/api/recruit/applications/{self.app.id}/onboard'
        self.assertEqual(u.post(url).json()['code'], 'NOT_HIRED')
        JobApplication.objects.filter(pk=self.app.pk).update(status='hired')
        r = u.post(url)
        self.assertEqual(r.status_code, 201, r.content)
        c = OnboardingCandidate.objects.get()
        self.assertEqual((c.email, c.first_name, c.job_title), ('asha@example.com', 'Asha', 'Backend Engineer'))
        self.assertTrue(c.candidate_code.startswith('CAN'))
        self.assertEqual(u.post(url).status_code, 409)
        self.assertEqual(self.as_user('viewer@co.com').post(url).status_code, 403)

    def test_score_uses_resume_scoring_engine(self):
        JobApplication.objects.filter(pk=self.app.pk).update(
            resume_data=b64(docx_bytes()), resume_mime=C.RESUME_TYPES['.docx'], resume_name='cv.docx')
        fake = {'score': 77, 'technical': 80, 'experience': 70, 'domain': 75, 'skills': ['Django'],
                'missing': [], 'gap': 'ok', 'aiFallback': True}
        with mock.patch('api.ai.score_resume_ai', return_value=fake) as m:
            r = self.as_user('rec@co.com').post(f'/api/recruit/applications/{self.app.id}/score')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn('Django', m.call_args.kwargs['resume_text'])
        self.assertEqual(r.json()['score']['score'], 77)
        from api.models import ResumeScore
        rs = ResumeScore.objects.get()
        self.assertEqual((rs.job_code, rs.source), ('JOB-101', 'Careers'))

    def test_settings_roundtrip(self):
        u = self.as_user('rec@co.com')
        r = u.put('/api/recruit/careers/settings', content_type='application/json', data=json.dumps({
            'enabled': True, 'allowedOrigins': 'https://a.com, https://b.com/x', 'showSalary': True,
            'privacyUrl': 'javascript:x', 'notifyEmails': 'hr@co.com, bad'}))
        s = r.json()['settings']
        self.assertEqual(s['allowedOrigins'], ['https://a.com'])
        self.assertTrue(s['showSalary'])
        self.assertEqual(s['privacyUrl'], '')
        self.assertEqual(s['notifyEmails'], ['hr@co.com'])
        self.assertTrue(MasterDataSet.objects.filter(key='careers_settings').exists())
        self.assertIn('/careers/widget.js', r.json()['urls']['widget'])


class ConfirmationEmailTests(Base):
    """The applicant confirmation is recorded (sent / failed with the reason)
    because mailer.send_email reports failure by return value, not exception."""

    def apply(self, *a, **k):
        with self.captureOnCommitCallbacks(execute=True):
            return super().apply(*a, **k)

    def _delivery(self, app_id):
        from api.models import ChannelDelivery
        return ChannelDelivery.objects.filter(channel='email', purpose='application_ack', ref=str(app_id)).order_by('-id').first()

    def test_success_is_recorded_and_response_names_the_email(self):
        r = self.apply()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['email'], 'asha@example.com')
        self.assertNotIn('We have sent', r.json()['message'])
        d = self._delivery(r.json()['id'])
        self.assertEqual((d.status, d.error), ('sent', ''))

    def test_failure_is_recorded_with_reason_and_shown_to_recruiters(self):
        self.sent.return_value = {'ok': False, 'error': 'Resend: domain is not verified'}
        r = self.apply()
        self.assertEqual(r.status_code, 201)                     # the application itself still succeeds
        app_id = r.json()['id']
        d = self._delivery(app_id)
        self.assertEqual(d.status, 'failed')
        self.assertIn('domain is not verified', d.error)
        detail = self.as_user('viewer@co.com').get(f'/api/recruit/applications/{app_id}').json()
        self.assertEqual(detail['confirmation']['status'], 'failed')
        self.assertIn('not verified', detail['confirmation']['error'])

    def test_resend_needs_edit_rights_and_records_the_outcome(self):
        app_id = self.apply().json()['id']
        url = f'/api/recruit/applications/{app_id}/resend-confirmation'
        self.assertEqual(self.as_user('viewer@co.com').post(url).status_code, 403)
        self.sent.return_value = {'ok': False, 'error': 'SMTP auth failed'}
        r = self.as_user('rec@co.com').post(url)
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()['code'], 'EMAIL_FAILED')
        self.sent.return_value = {'ok': True}
        r = self.as_user('rec@co.com').post(url)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['confirmation']['status'], 'sent')
        self.assertEqual(r.json()['confirmation']['attempts'], 3)
