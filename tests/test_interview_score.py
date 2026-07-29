"""The recruiter's Candidate Follow-up list reads InterviewLink.score.

Nothing used to copy the assessment result onto the link, so an interview that
really ran still rendered as "Score: 0/100". These tests pin the hand-off from
the saved recording to the link, and the branded shell every email now uses.
"""
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import mailer
from api.models import AppUser, InterviewLink, InterviewRecording


class InterviewScoreTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.link = InterviewLink.objects.create(
            name='srikanth', initials='S', role='data analyst',
            email='candidate@example.com', status='Active',
            platform='AI Interview (Eva)', candidate_token='tok-score',
        )

    def _post_recording(self, total=73, role='data analyst'):
        return self.client.post('/api/interview-recordings', data={
            'candidateName': 'srikanth', 'candidateEmail': 'candidate@example.com',
            'role': role, 'duration': 300, 'verdict': 'HOLD', 'totalScore': total,
            'techScore': 30, 'commScore': 21, 'integrityScore': 22,
            'transcript': 'Q1: ...', 'responses': [],
        }, content_type='application/json')

    def test_saving_a_recording_copies_the_score_onto_the_link(self):
        self.assertEqual(self.link.score, 0)

        resp = self._post_recording(total=73)
        self.assertEqual(resp.status_code, 201)

        self.link.refresh_from_db()
        self.assertEqual(self.link.score, 73, 'follow-up list would still show 0/100')
        self.assertEqual(self.link.status, 'Completed')
        self.assertIsNotNone(self.link.completed_at)

    def test_a_missing_score_still_completes_the_interview(self):
        """Completion must never hinge on a score being present.

        (A non-numeric totalScore is rejected by the serializer with 400 before
        this code runs, so the case worth covering here is the field's absence.)
        """
        resp = self.client.post('/api/interview-recordings', data={
            'candidateName': 'srikanth', 'candidateEmail': 'candidate@example.com',
            'role': 'data analyst', 'verdict': 'HOLD',
            'transcript': '', 'responses': [],
        }, content_type='application/json')
        self.assertEqual(resp.status_code, 201)

        self.link.refresh_from_db()
        self.assertEqual(self.link.status, 'Completed')
        self.assertIsNotNone(self.link.completed_at)
        self.assertEqual(self.link.score, 0)

    def test_score_lands_on_the_matching_role_only(self):
        other = InterviewLink.objects.create(
            name='srikanth', initials='S', role='data engineer',
            email='candidate@example.com', status='Active',
            candidate_token='tok-other-role',
        )
        self._post_recording(total=88, role='data analyst')

        self.link.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(self.link.score, 88)
        self.assertEqual(other.score, 0, 'a different role must not be marked')
        self.assertEqual(other.status, 'Active')


class TranscriptTests(TestCase):
    """The recordings viewer renders each answer from `responses`, so the API
    must round-trip the question, the round and the candidate's speech."""

    def setUp(self):
        self.client = Client()
        # Listing recordings needs a resolvable identity AND recruitment.view;
        # only the candidate's POST is anonymous. hrms-actor.js attaches this
        # header in the browser. No role_ref => the legacy 'admin' string grants
        # Super Admin, which is the simplest way to satisfy the check here.
        self.viewer = AppUser.objects.create(
            email='viewer@example.com', status='active', role='admin',
        )

    def test_responses_round_trip_question_round_and_answer(self):
        resp = self.client.post('/api/interview-recordings', data={
            'candidateName': 'srikanth', 'candidateEmail': 'candidate@example.com',
            'role': 'data analyst', 'verdict': 'HOLD', 'totalScore': 55,
            'transcript': 'Q1 · Technical\nEva: Explain indexing.\nCandidate: I used B-tree indexes.',
            'responses': [
                {'q': 'Explain indexing.', 'stageGroup': 'Technical', 'type': 'TECHNICAL',
                 'transcript': 'I used B-tree indexes.'},
                {'q': 'Tell me about a conflict.', 'stageGroup': 'HR Round', 'type': 'BEHAVIORAL',
                 'transcript': 'We disagreed on scope and I set up a call.'},
            ],
        }, content_type='application/json')
        self.assertEqual(resp.status_code, 201)

        rec = InterviewRecording.objects.get(candidate_email='candidate@example.com')
        listed = self.client.get('/api/interview-recordings',
                                 HTTP_X_USER_EMAIL=self.viewer.email)
        self.assertEqual(listed.status_code, 200)
        row = next(r for r in listed.json() if r['id'] == rec.id)

        self.assertEqual(len(row['responses']), 2)
        first, second = row['responses']
        self.assertEqual(first['q'], 'Explain indexing.')
        self.assertEqual(first['stageGroup'], 'Technical')
        self.assertEqual(first['transcript'], 'I used B-tree indexes.')
        self.assertEqual(second['stageGroup'], 'HR Round')

    def test_saved_transcript_contains_both_voices(self):
        """The flat transcript is the export/fallback view — it must not drop
        Eva's question the way the old "Q1: <answer>" format did."""
        self.client.post('/api/interview-recordings', data={
            'candidateName': 'srikanth', 'candidateEmail': 'both@example.com',
            'role': 'data analyst', 'verdict': 'HOLD',
            'transcript': 'Q1 · Technical\nEva: Explain indexing.\nCandidate: I used B-tree indexes.',
            'responses': [],
        }, content_type='application/json')

        rec = InterviewRecording.objects.get(candidate_email='both@example.com')
        self.assertIn('Eva:', rec.transcript)
        self.assertIn('Candidate:', rec.transcript)


class BrandedEmailTests(TestCase):
    """Every outbound mail shares one header and footer; only content varies."""

    def test_shell_carries_the_brand_header_and_footer(self):
        html = mailer.render_branded(title='Anything', intro='Body copy.')
        for fragment in ('EverSoft Technologies LLC', 'Human Resources Department',
                         'system-generated email', 'Warm regards', 'EverSoft HR Team'):
            self.assertIn(fragment, html)

    def test_details_card_skips_empty_values(self):
        card = mailer.render_details_card('Interview Details', [
            ('Position', 'data analyst'),
            ('Interviewer', ''),          # not set → row omitted, no blank line
            ('Duration', '45 min'),
        ])
        self.assertIn('data analyst', card)
        self.assertIn('45 min', card)
        self.assertNotIn('Interviewer', card)

    def test_details_card_is_empty_when_nothing_to_show(self):
        self.assertEqual(mailer.render_details_card('Interview Details', [('a', '')]), '')

    def test_cta_renders_button_and_raw_link(self):
        cta = mailer.render_cta('https://example.com/x', 'Join Interview')
        self.assertIn('Join Interview', cta)
        # twice as href (button + fallback) and once as the visible link text
        self.assertEqual(cta.count('https://example.com/x'), 3)
        self.assertEqual(mailer.render_cta('', 'Join'), '')
