"""An interview belongs to whoever scheduled it, and the KPI dashboard says so.

Before ``created_by_email`` existed, both the "My View" scope and the recruiter
leaderboard were keyed on ``interviewer`` — the free text typed on the
scheduling form ("HR Team", "Eva AI", a panel name). Nothing failed loudly: the
dashboard simply attributed nobody's work to anybody. ``scope=me`` compared that
text to the caller's email and matched nothing, so every recruiter's own
dashboard read zero, and the leaderboard grouped strings rather than people.

The cases below pin the behaviour that replaced it — including the two that are
easy to lose in a refactor: the creator comes from the header and not the
payload (so numbers cannot be claimed), and rows created before any of this
still appear, marked as unattributed rather than silently dropped.
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from datetime import timedelta
from unittest import mock

from api.models import AppUser, InterviewLink
from api.timeutil import local_now


class InterviewCreatorKpiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.recruiter = AppUser.objects.create(
            full_name='Zeta Recruiter', email='zeta.recruiter@example.test',
            status='active', role='admin')
        self.viewer = AppUser.objects.create(
            full_name='Yara Viewer', email='yara.viewer@example.test',
            status='active', role='admin')

    def _schedule(self, actor, **overrides):
        payload = {
            'name': 'Test Candidate', 'email': 'cand@example.test', 'role': 'QA Engineer',
            'interviewDate': '2026-09-01', 'time': '10:00',
            'interviewer': 'HR Team',      # what the form actually sends
        }
        payload.update(overrides)
        return self.client.post('/api/interviews', data=payload,
                                content_type='application/json',
                                HTTP_X_USER_EMAIL=actor)

    def _kpis(self, actor, query):
        return self.client.get('/api/recruitment/kpis?' + query, HTTP_X_USER_EMAIL=actor)

    # ── storing the creator ────────────────────────────────────────────────
    def test_scheduling_records_who_did_it(self):
        resp = self._schedule(self.recruiter.email)
        self.assertEqual(resp.status_code, 201, resp.content[:300])
        row = InterviewLink.objects.get(pk=resp.json()['id'])
        self.assertEqual(row.created_by_email, self.recruiter.email)
        # Resolved from the account, not from the payload, so one person cannot
        # become three leaderboard rows by typing their name three ways.
        self.assertEqual(row.created_by_name, 'Zeta Recruiter')
        # The typed interviewer is a separate fact and is left alone.
        self.assertEqual(row.interviewer, 'HR Team')

    def test_the_payload_cannot_claim_someone_elses_interview(self):
        resp = self._schedule(self.recruiter.email,
                              createdByEmail=self.viewer.email,
                              createdByName='Yara Viewer')
        row = InterviewLink.objects.get(pk=resp.json()['id'])
        self.assertEqual(row.created_by_email, self.recruiter.email)

    # ── attributing the numbers ────────────────────────────────────────────
    def test_my_view_counts_my_interviews_and_only_mine(self):
        self._schedule(self.recruiter.email)
        mine = self._kpis(self.recruiter.email, 'scope=me&range=all').json()
        self.assertEqual(mine['pipeline']['total'], 1)
        self.assertEqual(mine['viewing']['name'], 'Zeta Recruiter')

        theirs = self._kpis(self.viewer.email, 'scope=me&range=all').json()
        self.assertEqual(theirs['pipeline']['total'], 0)

    def test_leaderboard_groups_by_person_not_by_typed_text(self):
        self._schedule(self.recruiter.email)
        data = self._kpis(self.viewer.email, 'scope=all&range=all').json()
        rows = {r['interviewer']: r for r in data['recruiterStats']}
        self.assertIn(self.recruiter.email, rows)
        self.assertNotIn('HR Team', rows)
        self.assertEqual(rows[self.recruiter.email]['name'], 'Zeta Recruiter')
        self.assertTrue(rows[self.recruiter.email]['attributed'])

    def test_an_admin_can_scope_the_dashboard_to_one_person(self):
        self._schedule(self.recruiter.email)
        self._schedule(self.recruiter.email, email='cand2@example.test')
        data = self._kpis(self.viewer.email,
                          'scope=all&range=all&interviewer=' + self.recruiter.email).json()
        self.assertEqual(data['pipeline']['total'], 2)
        self.assertEqual(data['viewing']['name'], 'Zeta Recruiter')

    def test_the_recruiter_filter_offers_people_by_email(self):
        self._schedule(self.recruiter.email)
        data = self._kpis(self.viewer.email, 'scope=all&range=all').json()
        opts = {o['value']: o for o in data['filters']['interviewers']}
        self.assertIn(self.recruiter.email, opts)
        self.assertEqual(opts[self.recruiter.email]['label'], 'Zeta Recruiter')

    # ── rows that predate attribution ──────────────────────────────────────
    def test_pre_attribution_rows_are_kept_and_labelled(self):
        InterviewLink.objects.create(
            name='Legacy Cand', initials='LC', role='QA Engineer',
            email='legacy@example.test', interviewer='Old Panel',
            status='Scheduled', outcome='Selected')
        data = self._kpis(self.viewer.email, 'scope=all&range=all').json()
        rows = {r['interviewer']: r for r in data['recruiterStats']}
        self.assertIn('Old Panel', rows)
        # Present, but never passed off as a colleague.
        self.assertFalse(rows['Old Panel']['attributed'])
        self.assertEqual(rows['Old Panel']['email'], '')

        drill = self._kpis(self.viewer.email,
                           'scope=all&range=all&interviewer=Old+Panel').json()
        self.assertEqual(drill['pipeline']['total'], 1)

    def test_interviews_credited_to_nobody_are_still_counted(self):
        """The leaderboard used to drop rows with no creator AND no interviewer.

        Every interview scheduled before attribution existed is one of those, so
        the tab rendered "No recruiter data found" while the very same response
        reported a pipeline of 31 — two numbers out of one queryset that could
        not both be true. They belong in a bucket of their own, not in a filter.
        """
        for i in range(3):
            InterviewLink.objects.create(
                name='Orphan %d' % i, initials='O%d' % i, role='QA Engineer',
                email='orphan%d@example.test' % i, status='Scheduled')

        data = self._kpis(self.viewer.email, 'scope=all&range=all').json()
        rows = data['recruiterStats']
        bucket = [r for r in rows if not r['attributed']]
        self.assertEqual(len(bucket), 1)
        self.assertEqual(bucket[0]['total'], 3)
        # Nothing identifies the bucket, so there is no person to drill into.
        self.assertFalse(bucket[0]['drillable'])
        # The column has to reconcile with the pipeline, or one of them is lying.
        self.assertEqual(sum(r['total'] for r in rows), data['pipeline']['total'])

    def test_a_persons_row_carries_the_figures_the_report_needs(self):
        self._schedule(self.recruiter.email)
        row = [r for r in self._kpis(self.viewer.email, 'scope=all&range=all').json()['recruiterStats']
               if r['interviewer'] == self.recruiter.email][0]
        for field in ('total', 'invited', 'completed', 'selected', 'rejected',
                      'pending', 'shortlistRate', 'avgScore', 'lastAt'):
            self.assertIn(field, row)
        self.assertEqual(row['total'], 1)          # scheduled by them
        self.assertEqual(row['pending'], 1)        # no outcome recorded yet

    def test_my_view_still_finds_a_legacy_row_typed_with_my_email(self):
        InterviewLink.objects.create(
            name='Legacy Mine', initials='LM', role='QA Engineer',
            email='legacy2@example.test', interviewer=self.recruiter.email,
            status='Scheduled')
        mine = self._kpis(self.recruiter.email, 'scope=me&range=all').json()
        self.assertEqual(mine['pipeline']['total'], 1)

    # ── the roster: everyone is listed, not just the busy ──────────────────
    def test_every_active_account_gets_a_row(self):
        """A report that lists only people with activity cannot answer "who
        scheduled nothing this week", which is half of what it is opened for."""
        self._schedule(self.recruiter.email)
        rows = self._kpis(self.viewer.email, 'scope=all&range=all').json()['recruiterStats']
        by_email = {r['email']: r for r in rows if r['email']}
        self.assertIn(self.recruiter.email, by_email)
        # The viewer has scheduled nothing and is still named, with zeros.
        self.assertIn(self.viewer.email, by_email)
        self.assertEqual(by_email[self.viewer.email]['total'], 0)
        self.assertEqual(by_email[self.viewer.email]['name'], 'Yara Viewer')

    def test_a_disabled_account_is_not_listed(self):
        AppUser.objects.create(full_name='Gone Away', email='gone@example.test',
                               status='disabled', role='admin')
        rows = self._kpis(self.viewer.email, 'scope=all&range=all').json()['recruiterStats']
        self.assertNotIn('gone@example.test', [r['email'] for r in rows])

    def test_the_busiest_person_leads_and_the_uncredited_bucket_trails(self):
        self._schedule(self.recruiter.email)
        InterviewLink.objects.create(
            name='Orphan', initials='O', role='QA Engineer',
            email='orphan@example.test', status='Scheduled')
        rows = self._kpis(self.viewer.email, 'scope=all&range=all').json()['recruiterStats']
        self.assertEqual(rows[0]['email'], self.recruiter.email)
        self.assertFalse(rows[-1]['attributed'])

    # ── periods ────────────────────────────────────────────────────────────
    def test_today_covers_only_today(self):
        self._schedule(self.recruiter.email)
        InterviewLink.objects.filter(email='cand@example.test').update(
            created_at=local_now() - timedelta(days=3))
        today = self._kpis(self.viewer.email, 'scope=all&range=day').json()
        self.assertEqual(today['pipeline']['total'], 0)
        self.assertEqual(today['period']['label'], 'Today')

        self._schedule(self.recruiter.email, email='today@example.test')
        today = self._kpis(self.viewer.email, 'scope=all&range=day').json()
        self.assertEqual(today['pipeline']['total'], 1)

    def test_a_custom_window_includes_both_end_days(self):
        self._schedule(self.recruiter.email)
        day = InterviewLink.objects.get(email='cand@example.test').created_at.date()
        # The window is exactly the one day the interview lands on: an
        # exclusive upper bound would drop everything after midnight on it.
        q = 'scope=all&range=custom&from=%s&to=%s' % (day.isoformat(), day.isoformat())
        data = self._kpis(self.viewer.email, q).json()
        self.assertEqual(data['pipeline']['total'], 1)
        self.assertEqual(data['period']['label'], '%s to %s' % (day.isoformat(), day.isoformat()))

        after = day + timedelta(days=1)
        q = 'scope=all&range=custom&from=%s&to=%s' % (after.isoformat(), after.isoformat())
        self.assertEqual(self._kpis(self.viewer.email, q).json()['pipeline']['total'], 0)

    def test_a_back_to_front_window_is_read_the_way_it_was_meant(self):
        self._schedule(self.recruiter.email)
        day = InterviewLink.objects.get(email='cand@example.test').created_at.date()
        q = 'scope=all&range=custom&from=%s&to=%s' % (
            (day + timedelta(days=1)).isoformat(), (day - timedelta(days=1)).isoformat())
        data = self._kpis(self.viewer.email, q).json()
        self.assertEqual(data['pipeline']['total'], 1)

    def test_an_unparseable_date_widens_the_report_rather_than_failing(self):
        self._schedule(self.recruiter.email)
        r = self._kpis(self.viewer.email, 'scope=all&range=custom&from=not-a-date')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['pipeline']['total'], 1)

    def test_the_period_travels_with_the_figures(self):
        for rng, label in (('all', 'All time'), ('week', 'Last 7 days'),
                           ('month', 'Last 30 days'), ('quarter', 'Last 90 days')):
            data = self._kpis(self.viewer.email, 'scope=all&range=' + rng).json()
            self.assertEqual(data['period']['label'], label)

    # ── follow-up emails ───────────────────────────────────────────────────
    def test_a_follow_up_records_who_sent_it(self):
        """The outcome mail leaves a shared SMTP mailbox, so the message itself
        does not identify the sender — the row has to."""
        iv = InterviewLink.objects.create(
            name='FU', initials='FU', role='QA Engineer', email='fu@example.test',
            status='Scheduled')
        with mock.patch('api.mailer.send_email', return_value={'ok': True}):
            r = self.client.post('/api/interviews/send-followup',
                                 data={'interviewId': iv.id, 'outcome': 'Selected'},
                                 content_type='application/json',
                                 HTTP_X_USER_EMAIL=self.viewer.email)
        self.assertEqual(r.status_code, 200, r.content[:200])
        iv.refresh_from_db()
        self.assertEqual(iv.followup_sent_by_email, self.viewer.email)
        self.assertEqual(iv.followup_sent_by_name, 'Yara Viewer')
        self.assertIsNotNone(iv.followup_sent_at)
        # The flag existed on the model and was never written before this.
        self.assertTrue(iv.followup_sent)
        self.assertEqual(iv.outcome, 'Selected')

    def test_the_sender_is_not_taken_from_the_payload(self):
        iv = InterviewLink.objects.create(
            name='FU2', initials='FU', role='QA Engineer', email='fu2@example.test',
            status='Scheduled')
        with mock.patch('api.mailer.send_email', return_value={'ok': True}):
            self.client.post('/api/interviews/send-followup',
                             data={'interviewId': iv.id, 'outcome': 'Rejected',
                                   'followupSentByEmail': self.recruiter.email},
                             content_type='application/json',
                             HTTP_X_USER_EMAIL=self.viewer.email)
        iv.refresh_from_db()
        self.assertEqual(iv.followup_sent_by_email, self.viewer.email)

    def test_a_failed_send_records_nobody(self):
        """Recording a sender for a mail that never left would say a candidate
        was told their outcome when they were not."""
        iv = InterviewLink.objects.create(
            name='FU3', initials='FU', role='QA Engineer', email='fu3@example.test',
            status='Scheduled')
        with mock.patch('api.mailer.send_email', return_value={'ok': False, 'error': 'smtp down'}):
            r = self.client.post('/api/interviews/send-followup',
                                 data={'interviewId': iv.id, 'outcome': 'Selected'},
                                 content_type='application/json',
                                 HTTP_X_USER_EMAIL=self.viewer.email)
        self.assertEqual(r.status_code, 502)
        iv.refresh_from_db()
        self.assertFalse(iv.followup_sent)
        self.assertEqual(iv.followup_sent_by_email, '')

    def test_the_sender_reaches_the_interview_payload(self):
        iv = InterviewLink.objects.create(
            name='FU4', initials='FU', role='QA Engineer', email='fu4@example.test',
            status='Scheduled')
        with mock.patch('api.mailer.send_email', return_value={'ok': True}):
            self.client.post('/api/interviews/send-followup',
                             data={'interviewId': iv.id, 'outcome': 'Waitlisted'},
                             content_type='application/json',
                             HTTP_X_USER_EMAIL=self.viewer.email)
        row = [x for x in self.client.get(
            '/api/interviews', HTTP_X_USER_EMAIL=self.viewer.email).json()
               if x['email'] == 'fu4@example.test'][0]
        self.assertEqual(row['followupSentByName'], 'Yara Viewer')
        self.assertTrue(row['followupSent'])
