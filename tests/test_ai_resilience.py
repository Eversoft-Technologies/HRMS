import os
import time
from unittest.mock import MagicMock, patch

from django.test import Client, SimpleTestCase, TestCase

from api import ai
from api.models import AppUser, ResumeScore

# Model IDs Anthropic no longer serves; a default pointing at one of these turns
# every scoring call into a 404 "AI unavailable".
RETIRED_MODELS = {
    'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307',
    'claude-3-7-sonnet-20250219',
}

A_KEY = {'ANTHROPIC_API_KEY': 'test-key', 'VITE_ANTHROPIC_API_KEY': ''}
NO_KEY = {'ANTHROPIC_API_KEY': '', 'VITE_ANTHROPIC_API_KEY': ''}


def upstream(status, body=None, text=''):
    resp = MagicMock()
    resp.ok = 200 <= status < 300
    resp.status_code = status
    resp.headers = {}
    resp.json.return_value = body if body is not None else {}
    resp.text = text
    return resp


class AiCallBoundsTests(SimpleTestCase):
    """Production answers a body-less 502 when a request outlives the gateway,
    so every upstream call must be bounded and share one budget."""

    def test_default_models_are_current(self):
        self.assertNotIn(ai.GENERATION_MODEL, RETIRED_MODELS)
        self.assertNotIn(ai.VALIDATION_MODEL, RETIRED_MODELS)

    @patch.dict(os.environ, A_KEY)
    @patch('api.ai.requests.post')
    def test_direct_call_uses_the_remaining_budget(self, post):
        post.return_value = upstream(200, {'content': [{'text': '{"score": 1}'}]})
        ai._call_raw_claude('p', deadline=time.monotonic() + 30)
        connect, read = post.call_args.kwargs['timeout']
        self.assertEqual(connect, ai.AI_CONNECT_TIMEOUT_S)
        self.assertLessEqual(read, 30)
        self.assertLessEqual(read, ai.AI_CALL_TIMEOUT_S)

    @patch.dict(os.environ, A_KEY)
    @patch('api.ai.requests.post')
    def test_direct_call_refuses_to_start_without_time(self, post):
        with self.assertRaises(ai.AIUnavailable) as cm:
            ai._call_raw_claude('p', deadline=time.monotonic() + 3)
        self.assertEqual(cm.exception.status, 502)
        post.assert_not_called()

    @patch.dict(os.environ, A_KEY)
    @patch('api.ai.time.sleep')
    @patch('api.ai.requests.post')
    def test_direct_call_retries_at_most_twice_on_overload(self, post, _sleep):
        post.return_value = upstream(529, {'error': {'message': 'Overloaded'}})
        with self.assertRaises(ai.AIUnavailable) as cm:
            ai._call_raw_claude('p')
        self.assertEqual(post.call_count, ai.MAX_ATTEMPTS)
        self.assertEqual(ai.MAX_ATTEMPTS, 2)
        self.assertIn('529', cm.exception.message)

    @patch.dict(os.environ, A_KEY)
    def test_langchain_client_is_bounded(self):
        with patch('langchain_anthropic.ChatAnthropic') as chat:
            ai._get_langchain_llm(timeout=42)
        kwargs = chat.call_args.kwargs
        self.assertEqual(kwargs['default_request_timeout'], 42)
        self.assertEqual(kwargs['max_retries'], 0)
        self.assertEqual(kwargs['model'], ai.GENERATION_MODEL)


class AiFallbackTests(SimpleTestCase):
    """The keyword heuristic stands in only for an API that is down, and says so."""

    @patch.dict(os.environ, A_KEY)
    @patch('api.ai._get_langchain_llm', return_value=None)
    @patch('api.ai._call_raw_claude')
    def test_api_outage_falls_back_with_a_notice(self, raw, _llm):
        raw.side_effect = ai.AIUnavailable('Anthropic API error 404: model not found')
        result = ai.score_resume_ai('Python developer with Django and SQL experience.', 'Need Django.', 'Priya', 'Backend')
        self.assertTrue(result['aiFallback'])
        self.assertIn('404', result['aiError'])
        self.assertIn('score', result)
        self.assertEqual(result['candidateName'], 'Priya')

    @patch.dict(os.environ, A_KEY)
    @patch('api.ai._get_langchain_llm', return_value=None)
    @patch('api.ai._call_raw_claude')
    def test_bad_key_is_not_masked_by_the_heuristic(self, raw, _llm):
        raw.side_effect = ai.AIUnavailable('Anthropic API key is invalid.', status=401)
        with self.assertRaises(ai.AIUnavailable) as cm:
            ai.score_resume_ai('Resume text long enough to score.', 'JD', 'A', 'B')
        self.assertEqual(cm.exception.status, 401)

    @patch.dict(os.environ, NO_KEY)
    def test_missing_key_surfaces_as_503(self):
        with self.assertRaises(ai.AIUnavailable) as cm:
            ai.score_resume_ai('Resume text long enough to score.', 'JD', 'A', 'B')
        self.assertEqual(cm.exception.status, 503)

    @patch.dict(os.environ, A_KEY)
    @patch('api.ai._get_langchain_llm', return_value=None)
    @patch('api.ai._call_raw_claude', return_value='{"score": 77, "technical": 70, "skills": ["Django"]}')
    def test_real_answer_carries_no_fallback_flag(self, _raw, _llm):
        result = ai.score_resume_ai('Resume text long enough to score.', 'JD', 'A', 'B')
        self.assertEqual(result['score'], 77)
        self.assertNotIn('aiFallback', result)


class AiEndpointTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@example.com', full_name='Admin', password='x', role='admin')
        self.client = Client(HTTP_X_USER_EMAIL='admin@example.com')

    @patch('api.ai.score_resume_ai')
    def test_fallback_row_is_not_marked_ai_evaluated(self, score):
        score.return_value = {
            'candidateName': 'Ravi', 'role': 'Dev', 'score': 40, 'technical': 40, 'experience': 40,
            'domain': 40, 'gap': 'g', 'skills': [], 'missing': [], 'strengths': [], 'redFlags': [],
            'executiveSummary': 's', 'aiFallback': True, 'aiError': 'Could not reach Anthropic API',
        }
        res = self.client.post(
            '/api/ai/score-resume',
            data={'resumeText': 'Resume text long enough to score here.', 'jdText': 'JD', 'name': 'Ravi', 'saveToDb': True},
            content_type='application/json')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()['aiFallback'])
        row = ResumeScore.objects.get(name='Ravi')
        self.assertFalse(row.ai_evaluated)

    @patch('api.ai.ai_status_detail', return_value='Anthropic API error 404: model: claude-3-5-sonnet-20241022')
    @patch('api.ai.check_ai_key_valid', return_value=False)
    def test_status_endpoint_explains_a_failure(self, _valid, _detail):
        res = self.client.get('/api/ai/status')
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertFalse(body['available'])
        self.assertEqual(body['model'], ai.GENERATION_MODEL)
        self.assertIn('404', body['detail'])

    @patch('api.ai.check_ai_key_valid', return_value=True)
    def test_status_endpoint_reports_ok(self, _valid):
        body = self.client.get('/api/ai/status').json()
        self.assertTrue(body['available'])
        self.assertEqual(body['detail'], 'ok')
