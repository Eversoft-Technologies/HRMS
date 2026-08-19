"""What a candidate actually receives: the brand mark, and a link that works.

Both are absolute-URL problems, and the project had two names for the one
setting that answers them. ``brand_logo_url()`` reads ``HRMS_PUBLIC_URL`` — the
one the deployment sets — while ``_public_origin()`` read only
``PUBLIC_BASE_URL``, which nothing sets. So a single email could carry a logo
resolved against the public domain and, underneath it, a link resolved against
whatever host the recruiter's browser was on. The interview_links table still
holds fourteen rows pointing at http://127.0.0.1:8000.

These cases pin both halves against the configured URL, and pin the request
host as the last resort it was always meant to be.
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, override_settings

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import mailer
from api.views import _public_origin, build_followup_html, _followup_template

PUBLIC = 'https://hrms.example.com'


class _Req:
    """Just enough request for _public_origin's last-resort branch."""
    def __init__(self, host='127.0.0.1:8000', scheme='http'):
        self.META = {'HTTP_HOST': host, 'wsgi.url_scheme': scheme}
        self.scheme = scheme
        self._host = host

    def is_secure(self):
        return self.scheme == 'https'

    def get_host(self):
        return self._host


@override_settings(HRMS_PUBLIC_URL=PUBLIC)
class EmailBrandingTests(TestCase):
    def setUp(self):
        # PUBLIC_BASE_URL is the older name and is unset in this deployment;
        # make sure the tests see the same world.
        self._saved = os.environ.pop('PUBLIC_BASE_URL', None)

    def tearDown(self):
        if self._saved is not None:
            os.environ['PUBLIC_BASE_URL'] = self._saved

    # ── the logo ───────────────────────────────────────────────────────────
    def test_the_follow_up_email_carries_the_logo(self):
        subject, body = _followup_template('Selected', 'Srikanth', 'Data Analyst')
        html = build_followup_html(subject, body)
        self.assertIn('<img', html)
        # Absolute: a mail client has no page to resolve a relative path against.
        self.assertIn('src="%s/logo.jpg"' % PUBLIC, html)

    def test_the_company_name_is_next_to_the_logo(self):
        """So a client that blocks images still shows who sent the mail."""
        html = build_followup_html('Subject', 'Body')
        self.assertIn(mailer.BRAND_COMPANY, html)

    def test_a_deployment_with_no_public_url_draws_a_badge_not_a_broken_image(self):
        with override_settings(HRMS_PUBLIC_URL=''):
            html = mailer.render_branded(title='T', intro='', highlight_html='')
        self.assertNotIn('<img', html)
        self.assertIn(mailer.BRAND_COMPANY, html)

    def test_a_caller_that_knows_the_origin_wins(self):
        self.assertEqual(mailer.brand_logo_url('https://other.example/'),
                         'https://other.example/logo.jpg')

    # ── the candidate's link ───────────────────────────────────────────────
    def test_the_candidate_link_uses_the_configured_url_not_the_browser_host(self):
        self.assertEqual(_public_origin(_Req(), {}), PUBLIC)

    def test_an_explicit_origin_still_wins(self):
        self.assertEqual(_public_origin(_Req(), {'origin': 'https://given.example/'}),
                         'https://given.example')

    def test_the_older_setting_name_is_still_honoured(self):
        os.environ['PUBLIC_BASE_URL'] = 'https://legacy.example'
        try:
            self.assertEqual(_public_origin(_Req(), {}), 'https://legacy.example')
        finally:
            os.environ.pop('PUBLIC_BASE_URL', None)

    def test_the_request_host_is_the_last_resort(self):
        with override_settings(HRMS_PUBLIC_URL=''):
            self.assertEqual(_public_origin(_Req('hr.internal:8000'), {}),
                             'http://hr.internal:8000')

    def test_the_logo_and_the_link_agree_on_one_host(self):
        """The failure this whole file exists for: one email, two origins."""
        origin = _public_origin(_Req(), {})
        self.assertTrue(mailer.brand_logo_url().startswith(origin))
