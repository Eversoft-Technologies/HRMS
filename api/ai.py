"""
AI interview-question generation.

Every question comes from Claude. There is no local generator: a canned
fallback returned the same questions on every "Regenerate" and, because it was
substituted silently, nobody could tell the AI had stopped working. Transient
failures are retried; anything else is raised as AIUnavailable for the caller
to surface.
"""
import logging
import os
import time

import requests

logger = logging.getLogger(__name__)

ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
ANTHROPIC_VERSION = '2023-06-01'

# The legacy Claude 3/3.5 snapshot names return 404 not_found_error for this
# account. Use current-generation models the key can access; override via env
# if the available models change.
GENERATION_MODEL = os.environ.get('ANTHROPIC_MODEL') or 'claude-sonnet-4-5'
VALIDATION_MODEL = os.environ.get('ANTHROPIC_VALIDATION_MODEL') or 'claude-haiku-4-5'

_ai_status_cache = None


def _api_key(request_key=None):
    return request_key or os.environ.get('VITE_ANTHROPIC_API_KEY') or os.environ.get('ANTHROPIC_API_KEY')


def check_ai_key_valid(request_key=None):
    """Validate a key with a 1-token ping. Caches the env-key result."""
    global _ai_status_cache
    api_key = _api_key(request_key)
    if not api_key:
        return False
    if not request_key and _ai_status_cache is not None:
        return _ai_status_cache
    try:
        resp = requests.post(
            ANTHROPIC_URL,
            headers={
                'Content-Type': 'application/json',
                'x-api-key': api_key,
                'anthropic-version': ANTHROPIC_VERSION,
            },
            json={
                'model': VALIDATION_MODEL,
                'max_tokens': 1,
                'messages': [{'role': 'user', 'content': 'hi'}],
            },
            timeout=15,
        )
        valid = resp.ok
        if not request_key:
            _ai_status_cache = valid
        return valid
    except requests.RequestException:
        return False


def build_enhanced_prompt(params):
    """Build a rich, structured prompt from candidate and job data.

    params keys (all optional, fall back to prompt if absent):
      resume_text, jd_text, experience_level, skills (list), job_role,
      candidate_name, question_count (int, default 10)
    """
    resume_text = (params.get('resumeText') or params.get('resume_text') or '').strip()
    jd_text = (params.get('jdText') or params.get('jd_text') or '').strip()
    experience_level = str(params.get('experienceLevel') or params.get('experience_level') or 'Mid-level').strip()
    skills = params.get('skills') or []
    job_role = str(params.get('jobRole') or params.get('job_role') or 'Software Engineer').strip()
    candidate_name = str(params.get('candidateName') or params.get('candidate_name') or 'the candidate').strip()
    count = int(params.get('questionCount') or params.get('question_count') or 10)

    skills_str = ', '.join(skills) if skills else 'as identified from the resume and JD'

    prompt = f"""You are an expert technical interviewer. Generate exactly {count} targeted interview questions for the following candidate and position.

CANDIDATE: {candidate_name}
JOB ROLE: {job_role}
EXPERIENCE LEVEL: {experience_level}
KEY SKILLS: {skills_str}

JOB DESCRIPTION:
{jd_text or '(Not provided — infer from job role and skills)'}

CANDIDATE RESUME:
{resume_text or '(Not provided — generate role-appropriate questions)'}

Generate a balanced set of {count} interview questions covering ALL of these categories:
1. Technical Questions (skills from both resume and JD)
2. Experience-Based Questions (from candidate's projects and work history)
3. Scenario-Based Questions (practical, role-specific problem-solving)
4. Behavioral Questions (teamwork, leadership, communication, adaptability)
5. Gap Analysis Questions (skills or experience missing from JD requirements)

Rules:
- Every question must be specific to this candidate's background and the job role.
- Vary difficulty: mix Easy, Medium, and Hard questions.
- For technical questions, reference actual technologies from the resume/JD.
- For experience questions, reference specific projects or roles from the resume.
- For gap questions, target skills listed in the JD but absent from the resume.
- Return ONLY a valid JSON array of question strings, no explanations, no markdown.

Example format:
["Question 1 text?", "Question 2 text?", ...]"""

    return prompt


class AIUnavailable(Exception):
    """Claude could not produce questions. Callers must surface this — there is
    no canned fallback, so a silent swallow would serve the same stale questions
    on every regenerate without anyone noticing."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


# 429 and 5xx (notably 529 overloaded_error) are transient — retry before giving up.
RETRY_STATUSES = frozenset({408, 409, 429, 500, 502, 503, 504, 529})
MAX_ATTEMPTS = 3


def _retry_delay(response, attempt):
    """Honour Retry-After when the API sends it, else exponential backoff."""
    header = (response.headers or {}).get('retry-after') if response is not None else None
    if header:
        try:
            return min(float(header), 20.0)
        except (TypeError, ValueError):
            pass
    return 2.0 ** attempt


def generate_questions(prompt, request_key=None, params=None):
    """Return the raw Anthropic payload (content[0].text holds the JSON array).

    If params dict is provided with structured data (resumeText, jdText, etc.)
    a rich prompt is built server-side and used instead of the raw prompt string.

    Raises AIUnavailable when Claude cannot be reached or refuses the request.
    """
    # Use structured params to build a richer prompt when available
    if params and (params.get('resumeText') or params.get('jdText') or params.get('jobRole')):
        prompt = build_enhanced_prompt(params)

    api_key = _api_key(request_key)
    if not api_key:
        raise AIUnavailable(
            'No Anthropic API key configured. Set ANTHROPIC_API_KEY in the server .env.',
            status=503,
        )

    last_error = 'unknown error'
    for attempt in range(MAX_ATTEMPTS):
        try:
            upstream = requests.post(
                ANTHROPIC_URL,
                headers={
                    'Content-Type': 'application/json',
                    'x-api-key': api_key,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                json={
                    'model': GENERATION_MODEL,
                    'max_tokens': 3000,
                    'messages': [{'role': 'user', 'content': prompt}],
                },
                timeout=90,
            )
        except requests.RequestException as exc:
            last_error = f'Could not reach the Anthropic API: {exc}'
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(_retry_delay(None, attempt))
                continue
            raise AIUnavailable(last_error)

        if upstream.ok:
            return upstream.json()

        last_error = _upstream_error(upstream)
        logger.warning(
            'Anthropic %s on attempt %d/%d: %s',
            upstream.status_code, attempt + 1, MAX_ATTEMPTS, last_error,
        )
        if upstream.status_code in RETRY_STATUSES and attempt < MAX_ATTEMPTS - 1:
            time.sleep(_retry_delay(upstream, attempt))
            continue
        if upstream.status_code == 401:
            raise AIUnavailable('Anthropic API key is invalid.', status=401)
        raise AIUnavailable(last_error)

    raise AIUnavailable(last_error)


def _upstream_error(response):
    """Pull Anthropic's own error message out of the response body."""
    try:
        err = response.json().get('error') or {}
        detail = err.get('message') or err.get('type')
    except ValueError:
        detail = None
    detail = detail or (response.text or '')[:200]
    return f'Anthropic API error {response.status_code}: {detail}'
