"""Contract tests for the /interview-access token hand-off.

interview-access.js turns a verified token into a runnable AI interview by
rebuilding the same URL the recruiter console mails:

    /recruit/interview?tab=ai-interviewer&candidateEmail=..&name=..&role=..&qid=..

That only works while verify-token keeps returning `platform`, `email`, `name`,
`role` and `interviewQuestions`, and while a question set can be created and
read back anonymously (the candidate is not signed in). These tests pin both.
"""
import json
import os
import sys
from datetime import datetime, timedelta

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, Client

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import InterviewLink


QUESTIONS = [
    'Coding Challenge (Medium): flatten a nested object.',
    'Explain a window function you have used.',
    'Tell me about a project you are proud of.',
]


class InterviewAccessTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.link = InterviewLink.objects.create(
            name='srikanth', initials='S', role='data analyst',
            email='candidate@example.com', status='Scheduled',
            platform='AI Interview (Eva)', link=None,          # AI interview: no meeting URL
            interview_questions=json.dumps(QUESTIONS),
            candidate_token='tok-ai-interview',
            link_expires_at=datetime.now() + timedelta(days=1),
        )

    def _verify(self, token):
        return self.client.post(
            '/api/interviews/verify-token',
            data={'token': token}, content_type='application/json',
        )

    def test_verify_token_returns_everything_the_start_url_needs(self):
        data = self._verify('tok-ai-interview').json()

        self.assertTrue(data['valid'])
        self.assertEqual(data['email'], 'candidate@example.com')
        self.assertEqual(data['name'], 'srikanth')
        self.assertEqual(data['role'], 'data analyst')
        self.assertEqual(data['platform'], 'AI Interview (Eva)')
        self.assertFalse(data.get('link'), 'an AI interview must not carry a meeting URL')
        self.assertEqual(data['interviewQuestions'], QUESTIONS)

    def test_ai_interview_is_distinguishable_from_a_pending_external_one(self):
        """The 'recruiter will share the link' copy must survive for real
        external interviews — it is only wrong for AI ones."""
        InterviewLink.objects.create(
            name='pending', initials='P', role='backend',
            email='pending@example.com', status='Scheduled',
            platform='Microsoft Teams', link=None,   # recruiter has not pasted it yet
            candidate_token='tok-teams-pending',
            link_expires_at=datetime.now() + timedelta(days=1),
        )
        data = self._verify('tok-teams-pending').json()

        self.assertTrue(data['valid'])
        self.assertNotIn('ai', (data['platform'] or '').lower())
        self.assertFalse(data.get('link'))
        self.assertFalse(data.get('interviewQuestions'))

    def test_question_set_round_trips_for_an_anonymous_candidate(self):
        """The candidate is not signed in when the page mints their qid."""
        created = self.client.post(
            '/api/question-sets',
            data={'questions': QUESTIONS}, content_type='application/json',
        )
        self.assertEqual(created.status_code, 200)
        qid = created.json()['id']

        fetched = self.client.get(f'/api/question-sets/{qid}')
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.json()['questions'], QUESTIONS)

    def test_completed_interview_still_refuses_the_token(self):
        """The single-use rule must not be weakened by the new start path."""
        self.link.completed_at = datetime.now()
        self.link.save(update_fields=['completed_at'])

        data = self._verify('tok-ai-interview').json()
        self.assertFalse(data['valid'])
        self.assertIn('already completed', data['reason'].lower())


class StatusMustNotLockCandidatesOutTests(TestCase):
    """A recruiter's workflow label is not proof the candidate sat the interview."""

    def setUp(self):
        self.client = Client()
        self.link = InterviewLink.objects.create(
            name='sree', initials='S', role='data analyst',
            email='sree@example.com', status='Completed',   # set by hand / in bulk
            completed_at=None,                              # never actually taken
            candidate_token='tok-status-only',
            link_expires_at=datetime.now() + timedelta(days=1),
        )

    def test_status_completed_without_completed_at_still_lets_them_in(self):
        data = self.client.post(
            '/api/interviews/verify-token',
            data={'token': 'tok-status-only'}, content_type='application/json',
        ).json()
        self.assertTrue(data['valid'], '20 real candidates were locked out by this')

    def test_a_real_completion_is_still_refused(self):
        self.link.completed_at = datetime.now()
        self.link.save(update_fields=['completed_at'])
        data = self.client.post(
            '/api/interviews/verify-token',
            data={'token': 'tok-status-only'}, content_type='application/json',
        ).json()
        self.assertFalse(data['valid'])
        self.assertIn('already completed', data['reason'].lower())
