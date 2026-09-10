"""
AI interview-question generation, resume scoring, and interview evaluation using LangChain.

Supports LCEL (LangChain Expression Language) pipelines with ChatAnthropic and
structured output parsing, with automated retries and graceful error handling.
"""
import json
import logging
import os
import re
import time

import requests

logger = logging.getLogger(__name__)

ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
ANTHROPIC_VERSION = '2023-06-01'

GENERATION_MODEL = os.environ.get('ANTHROPIC_MODEL') or 'claude-sonnet-4-5'
VALIDATION_MODEL = os.environ.get('ANTHROPIC_VALIDATION_MODEL') or 'claude-haiku-4-5'

_ai_status_cache = None


class AIUnavailable(Exception):
    """Raised when the AI model cannot be reached or refuses a request."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


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


# ---------------------------------------------------------------------------
# LangChain Pipeline Initializers & Prompts
# ---------------------------------------------------------------------------
def _get_langchain_llm(request_key=None, max_tokens=3000):
    """Instantiate a LangChain ChatAnthropic model."""
    api_key = _api_key(request_key)
    if not api_key:
        raise AIUnavailable(
            'No Anthropic API key configured. Set ANTHROPIC_API_KEY in the server .env.',
            status=503,
        )
    try:
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(
            model=GENERATION_MODEL,
            anthropic_api_key=api_key,
            max_tokens=max_tokens,
            temperature=0.2,
        )
    except ImportError:
        return None


def _extract_json(text):
    """Extract valid JSON from output string, handling markdown code blocks."""
    if not text:
        return None
    cleaned = text.strip()
    m = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', cleaned)
    if m:
        cleaned = m.group(1).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        obj_match = re.search(r'(\{[\s\S]*\}|\[[\s\S]*\])', cleaned)
        if obj_match:
            try:
                return json.loads(obj_match.group(0))
            except Exception:
                pass
    return None


# ---------------------------------------------------------------------------
# Direct Anthropic Fallback with Retries
# ---------------------------------------------------------------------------
RETRY_STATUSES = frozenset({408, 409, 429, 500, 502, 503, 504, 529})
MAX_ATTEMPTS = 3


def _retry_delay(response, attempt):
    header = (response.headers or {}).get('retry-after') if response is not None else None
    if header:
        try:
            return min(float(header), 20.0)
        except (TypeError, ValueError):
            pass
    return 2.0 ** attempt


def _call_raw_claude(prompt, max_tokens=3000, request_key=None, system=None):
    api_key = _api_key(request_key)
    if not api_key:
        raise AIUnavailable(
            'No Anthropic API key configured. Set ANTHROPIC_API_KEY in the server .env.',
            status=503,
        )

    payload = {
        'model': GENERATION_MODEL,
        'max_tokens': max_tokens,
        'messages': [{'role': 'user', 'content': prompt}],
    }
    if system:
        payload['system'] = system

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
                json=payload,
                timeout=90,
            )
        except requests.RequestException as exc:
            last_error = f'Could not reach Anthropic API: {exc}'
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(_retry_delay(None, attempt))
                continue
            raise AIUnavailable(last_error)

        if upstream.ok:
            return upstream.json()['content'][0]['text']

        last_error = _upstream_error(upstream)
        if upstream.status_code in RETRY_STATUSES and attempt < MAX_ATTEMPTS - 1:
            time.sleep(_retry_delay(upstream, attempt))
            continue
        if upstream.status_code == 401:
            raise AIUnavailable('Anthropic API key is invalid.', status=401)
        raise AIUnavailable(last_error)

    raise AIUnavailable(last_error)


def _upstream_error(response):
    try:
        err = response.json().get('error') or {}
        detail = err.get('message') or err.get('type')
    except ValueError:
        detail = None
    detail = detail or (response.text or '')[:200]
    return f'Anthropic API error {response.status_code}: {detail}'


# ---------------------------------------------------------------------------
# LangChain LCEL Chains
# ---------------------------------------------------------------------------

def score_resume_ai(resume_text, jd_text, candidate_name='', role='', request_key=None):
    """Ultra-fast deep semantic resume evaluation using LangChain LCEL chain."""
    system_msg = "You are a senior technical hiring specialist. Evaluate the resume quickly and return compact JSON only."
    human_msg = """Perform a rapid, high-accuracy semantic evaluation of this resume against the Job Description.

CANDIDATE: {candidate_name}
ROLE: {role}

JOB DESCRIPTION:
{jd_text}

CANDIDATE RESUME:
{resume_text}

Evaluate technical depth, production experience, and domain alignment.
Return ONLY valid JSON matching this schema:
{{
  "candidateName": "{candidate_name}",
  "role": "{role}",
  "score": <integer 0-100: overall match>,
  "technical": <integer 0-100: technical depth>,
  "experience": <integer 0-100: tenure & seniority>,
  "domain": <integer 0-100: domain fit>,
  "gap": "<2-sentence concise summary of match & gaps>",
  "skills": ["<matched skill 1>", "<matched skill 2>"],
  "missing": ["<missing skill 1>", "<missing skill 2>"],
  "strengths": ["<key strength 1>", "<key strength 2>"],
  "redFlags": ["<risk or gap 1>"],
  "executiveSummary": "<2-3 sentence executive hiring summary>"
}}"""

    cand_name = candidate_name or 'Candidate'
    role_title = role or 'Software Professional'
    jd_content = jd_text or '(Infer standard requirements from the role title)'

    # 1. Try LangChain LCEL execution with fast token limit
    llm = _get_langchain_llm(request_key=request_key, max_tokens=1000)
    if llm is not None:
        try:
            from langchain_core.prompts import ChatPromptTemplate
            from langchain_core.output_parsers import JsonOutputParser

            prompt_template = ChatPromptTemplate.from_messages([
                ("system", system_msg),
                ("human", human_msg),
            ])
            parser = JsonOutputParser()
            chain = prompt_template | llm | parser

            result = chain.invoke({
                "candidate_name": cand_name,
                "role": role_title,
                "jd_text": jd_content,
                "resume_text": resume_text,
            })
            if isinstance(result, dict):
                return result
        except Exception as exc:
            logger.warning("LangChain LCEL resume scoring fallback to raw Claude: %s", exc)

    # 2. Fallback to direct Claude API
    full_prompt = human_msg.format(
        candidate_name=cand_name,
        role=role_title,
        jd_text=jd_content,
        resume_text=resume_text,
    )
    raw_text = _call_raw_claude(full_prompt, max_tokens=2500, request_key=request_key, system=system_msg)
    parsed = _extract_json(raw_text)
    if not isinstance(parsed, dict):
        raise AIUnavailable('Claude returned invalid JSON format for resume scoring.')
    return parsed


def evaluate_interview_ai(interview_data, request_key=None):
    """Deep semantic interview evaluation using LangChain LCEL chain."""
    cand_name = interview_data.get('candidateName') or 'Candidate'
    role = interview_data.get('role') or 'Software Professional'
    jd_text = interview_data.get('jdText') or '(Infer requirements from role)'
    responses = interview_data.get('responses') or []
    eye_contact = interview_data.get('eyeContact', 75)
    pause_count = interview_data.get('pauseCount', 0)
    flags = interview_data.get('flags') or []

    system_msg = "You are an executive hiring committee leader. Evaluate candidate interview transcripts rigorously and return strict JSON only."
    human_msg = """Evaluate this completed candidate interview session against the role and job requirements.

CANDIDATE: {candidate_name}
TARGET ROLE: {role}

JOB DESCRIPTION:
{jd_text}

INTERVIEW QUESTION-BY-QUESTION RESPONSES & TRANSCRIPTS:
{responses_json}

PROCTORING & SESSION TELEMETRY:
- Average Eye Contact: {eye_contact}%
- Long Pauses (>5s): {pause_count}
- Focus / Tab Flags: {flags_count}

Evaluate technical correctness, clarity of communication, STAR structure, and integrity.
Return ONLY a valid JSON object matching this exact schema:
{{
  "candidateName": "{candidate_name}",
  "role": "{role}",
  "techScore": <integer 0-40: technical depth and correctness score>,
  "commScore": <integer 0-30: communication clarity, structure, and pacing score>,
  "integrityScore": <integer 0-30: proctoring and credibility score>,
  "totalScore": <integer 0-100: composite sum>,
  "verdict": "SUBMIT" | "HOLD" | "REJECT",
  "executiveSummary": "<2-3 paragraph detailed briefing for the hiring manager>",
  "technicalStrengths": ["<demonstrated competency 1>", "<demonstrated competency 2>"],
  "technicalGaps": ["<weak or missing competency 1>", "<competency 2>"],
  "communicationCritique": "<evaluation of communication tone, articulation, and conciseness>",
  "questionScorecard": [
    {{
      "qNum": 1,
      "score": <integer 0-10>,
      "feedback": "<concise feedback on the candidate's answer>"
    }}
  ],
  "round2Questions": [
    "<targeted follow-up technical question 1 to probe weak areas>",
    "<targeted follow-up question 2>"
  ]
}}"""

    responses_str = json.dumps(responses, indent=2)

    # 1. Try LangChain LCEL execution
    llm = _get_langchain_llm(request_key=request_key, max_tokens=3000)
    if llm is not None:
        try:
            from langchain_core.prompts import ChatPromptTemplate
            from langchain_core.output_parsers import JsonOutputParser

            prompt_template = ChatPromptTemplate.from_messages([
                ("system", system_msg),
                ("human", human_msg),
            ])
            parser = JsonOutputParser()
            chain = prompt_template | llm | parser

            result = chain.invoke({
                "candidate_name": cand_name,
                "role": role,
                "jd_text": jd_text,
                "responses_json": responses_str,
                "eye_contact": eye_contact,
                "pause_count": pause_count,
                "flags_count": len(flags),
            })
            if isinstance(result, dict):
                return result
        except Exception as exc:
            logger.warning("LangChain LCEL interview evaluation fallback to raw Claude: %s", exc)

    # 2. Fallback to direct Claude API
    full_prompt = human_msg.format(
        candidate_name=cand_name,
        role=role,
        jd_text=jd_text,
        responses_json=responses_str,
        eye_contact=eye_contact,
        pause_count=pause_count,
        flags_count=len(flags),
    )
    raw_text = _call_raw_claude(full_prompt, max_tokens=3000, request_key=request_key, system=system_msg)
    parsed = _extract_json(raw_text)
    if not isinstance(parsed, dict):
        raise AIUnavailable('Claude returned invalid JSON format for interview evaluation.')
    return parsed


def build_enhanced_prompt(params):
    """Build a rich prompt for question generation."""
    resume_text = (params.get('resumeText') or params.get('resume_text') or '').strip()
    jd_text = (params.get('jdText') or params.get('jd_text') or '').strip()
    experience_level = str(params.get('experienceLevel') or params.get('experience_level') or 'Mid-level').strip()
    skills = params.get('skills') or []
    job_role = str(params.get('jobRole') or params.get('job_role') or 'Software Engineer').strip()
    candidate_name = str(params.get('candidateName') or params.get('candidate_name') or 'the candidate').strip()
    count = int(params.get('questionCount') or params.get('question_count') or 10)

    skills_str = ', '.join(skills) if skills else 'as identified from the resume and JD'

    return f"""You are an expert technical interviewer. Generate exactly {count} targeted interview questions for the following candidate and position.

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

Return ONLY a valid JSON array of {count} objects matching this exact format:
[
  {{
    "id": 1,
    "category": "Technical",
    "difficulty": "Medium",
    "question": "The question text",
    "sampleAnswer": "Key points expected in a strong answer",
    "skillTested": "Specific skill or competency",
    "rationale": "Why this question is relevant to this candidate/role"
  }}
]"""


def generate_questions(prompt, request_key=None, params=None):
    """Generate interview questions using LangChain chain or direct Claude."""
    if params and (params.get('resumeText') or params.get('jdText') or params.get('jobRole')):
        prompt = build_enhanced_prompt(params)

    # Try LangChain
    llm = _get_langchain_llm(request_key=request_key, max_tokens=3000)
    if llm is not None:
        try:
            from langchain_core.prompts import PromptTemplate
            from langchain_core.output_parsers import JsonOutputParser

            pt = PromptTemplate.from_template("{prompt}")
            parser = JsonOutputParser()
            chain = pt | llm | parser
            result = chain.invoke({"prompt": prompt})
            return {"content": [{"text": json.dumps(result)}]}
        except Exception as exc:
            logger.warning("LangChain question gen fallback to raw Claude: %s", exc)

    raw_text = _call_raw_claude(prompt, max_tokens=3000, request_key=request_key)
    return {"content": [{"text": raw_text}]}
