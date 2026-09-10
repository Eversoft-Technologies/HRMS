import json
from unittest.mock import patch, MagicMock
from django.test import TestCase
from rest_framework.test import APIClient
from api import ai
from api.models import AppUser, ResumeScore, InterviewRecording


class AIScoringAndEvalTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = AppUser.objects.create(
            email='recruiter@eversoftit.com',
            full_name='Recruiter User',
            role='recruitment',
            status='active',
            password='password123',
        )
        self.client.force_authenticate(user=self.user)

    @patch('api.ai._call_raw_claude')
    def test_score_resume_ai_unit(self, mock_claude):
        mock_response = json.dumps({
            "candidateName": "John Doe",
            "role": "Python Developer",
            "score": 88,
            "technical": 90,
            "experience": 85,
            "domain": 89,
            "gap": "88% skill match. 5 years meets requirement.",
            "skills": ["Python", "Django", "PostgreSQL"],
            "missing": ["Docker"],
            "strengths": ["Strong backend architecture", "FastAPI proficiency"],
            "redFlags": ["No direct Kubernetes mention"],
            "executiveSummary": "Candidate demonstrates high technical competence.",
            "suggestedQuestions": ["Explain how you optimize PostgreSQL queries."]
        })
        mock_claude.return_value = mock_response

        res = ai.score_resume_ai(
            resume_text="Experienced Python Django developer with 5 years experience.",
            jd_text="Looking for Python Django PostgreSQL developer.",
            candidate_name="John Doe",
            role="Python Developer",
            request_key="test-key"
        )

        self.assertEqual(res['score'], 88)
        self.assertEqual(res['technical'], 90)
        self.assertIn("Python", res['skills'])
        self.assertIn("Docker", res['missing'])

    @patch('api.ai._call_raw_claude')
    def test_evaluate_interview_ai_unit(self, mock_claude):
        mock_response = json.dumps({
            "candidateName": "Jane Smith",
            "role": "Frontend Lead",
            "techScore": 36,
            "commScore": 28,
            "integrityScore": 27,
            "totalScore": 91,
            "verdict": "SUBMIT",
            "executiveSummary": "Outstanding frontend candidate with deep React knowledge.",
            "technicalStrengths": ["React 19 internals", "Web performance"],
            "technicalGaps": [],
            "communicationCritique": "Concise and well structured.",
            "questionScorecard": [
                {"qNum": 1, "score": 9, "feedback": "Great explanation of virtual DOM."}
            ],
            "round2Questions": ["How do you handle SSR hydration mismatches?"]
        })
        mock_claude.return_value = mock_response

        interview_data = {
            "candidateName": "Jane Smith",
            "role": "Frontend Lead",
            "responses": [
                {"qNum": 1, "q": "Explain React state", "transcript": "State in React is managed via useState."}
            ],
            "eyeContact": 88,
            "pauseCount": 1
        }
        res = ai.evaluate_interview_ai(interview_data, request_key="test-key")

        self.assertEqual(res['verdict'], 'SUBMIT')
        self.assertEqual(res['totalScore'], 91)
        self.assertEqual(res['techScore'], 36)

    @patch('api.ai.score_resume_ai')
    def test_ai_score_resume_endpoint(self, mock_score):
        mock_score.return_value = {
            "candidateName": "Alex Rivera",
            "role": "Full Stack Engineer",
            "score": 85,
            "technical": 88,
            "experience": 82,
            "domain": 85,
            "gap": "Good match.",
            "skills": ["React", "Python"],
            "missing": ["AWS"],
            "strengths": ["Full stack capability"],
            "redFlags": [],
            "executiveSummary": "Qualified candidate.",
            "suggestedQuestions": ["Describe your deployment pipeline."]
        }

        resp = self.client.post(
            '/api/ai/score-resume',
            data={
                "resumeText": "Experienced engineer skilled in React and Python.",
                "jdText": "Need React and Python developer.",
                "candidateName": "Alex Rivera",
                "role": "Full Stack Engineer",
                "saveToDb": True,
            },
            format='json'
        )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data['score'], 85)
        self.assertIn('dbRecord', resp.data)
        self.assertTrue(ResumeScore.objects.filter(name="Alex Rivera").exists())

    @patch('api.ai.evaluate_interview_ai')
    def test_ai_evaluate_interview_endpoint(self, mock_eval):
        rec = InterviewRecording.objects.create(
            candidate_name="Sam Taylor",
            candidate_email="sam@example.com",
            role="DevOps Engineer",
            verdict="HOLD"
        )

        mock_eval.return_value = {
            "candidateName": "Sam Taylor",
            "role": "DevOps Engineer",
            "techScore": 34,
            "commScore": 25,
            "integrityScore": 26,
            "totalScore": 85,
            "verdict": "SUBMIT",
            "executiveSummary": "Strong cloud infrastructure background.",
            "technicalStrengths": ["Docker", "Kubernetes"],
            "technicalGaps": [],
            "communicationCritique": "Clear communication.",
            "questionScorecard": [],
            "round2Questions": ["How do you handle multi-region failover?"]
        }

        resp = self.client.post(
            '/api/ai/evaluate-interview',
            data={
                "recordingId": rec.id,
                "candidateName": "Sam Taylor",
                "role": "DevOps Engineer",
                "responses": [{"qNum": 1, "transcript": "I manage Kubernetes clusters."}],
                "eyeContact": 90
            },
            format='json'
        )

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data['verdict'], 'SUBMIT')
        self.assertTrue(resp.data.get('recordingUpdated'))

        rec.refresh_from_db()
        self.assertEqual(rec.verdict, 'SUBMIT')
        self.assertEqual(rec.total_score, 85)
