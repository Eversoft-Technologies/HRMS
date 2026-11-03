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

# Defaults are current models. The previous defaults (Claude 3.5 Sonnet, retired
# 2025-10-28; Claude 3.5 Haiku, retired 2026-02-19) now get a 404 from the API,
# which this module reports as "AI unavailable". Override per environment with
# ANTHROPIC_MODEL / ANTHROPIC_VALIDATION_MODEL in the server .env.
GENERATION_MODEL = os.environ.get('ANTHROPIC_MODEL') or 'claude-opus-5-5'
VALIDATION_MODEL = os.environ.get('ANTHROPIC_VALIDATION_MODEL') or 'claude-haiku-5-5'

# Time budget for one scoring request. Production sits behind Passenger /
# LiteSpeed, which answers a body-less 502 when the app takes longer than the
# gateway allows, so every upstream call is bounded and the LangChain attempt
# and the direct-API fallback share one budget. Raise it with
# AI_REQUEST_BUDGET_SECONDS if the host permits longer requests.
AI_REQUEST_BUDGET_S = float(os.environ.get('AI_REQUEST_BUDGET_SECONDS') or 110)
AI_CONNECT_TIMEOUT_S = 10.0
AI_CALL_TIMEOUT_S = 60.0

_ai_status_cache = None
_ai_status_detail = ''


class AIUnavailable(Exception):
    """Raised when the AI model cannot be reached or refuses a request."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


def _api_key(request_key=None):
    """The key for an AI call.

    ``request_key`` is for server-side callers only (tests, key validation).
    HTTP views must never pass a browser-supplied value here: the key always
    comes from the server-managed source (see api/ai_settings.py: the key saved
    in Settings > AI Settings, else ANTHROPIC_API_KEY, else the deprecated
    VITE_ANTHROPIC_API_KEY)."""
    if request_key:
        return request_key
    from .ai_settings import active_key
    return active_key()


def reset_status_cache():
    """Forget the cached key check (called after the key is saved/rotated/removed)."""
    global _ai_status_cache, _ai_status_detail
    _ai_status_cache = None
    _ai_status_detail = ''


def check_ai_key_valid(request_key=None):
    """Validate the active key with a 1-token ping. The result is cached per
    key fingerprint, so a rotation (even from another server process) is
    re-checked instead of serving a stale answer."""
    global _ai_status_cache, _ai_status_detail
    api_key = _api_key(request_key)
    if not api_key:
        if not request_key:
            _ai_status_detail = ('No Anthropic API key configured. Save one in Settings > AI Settings '
                                 'or set ANTHROPIC_API_KEY on the server.')
        return False
    from .ai_settings import fingerprint as _fp
    fp = _fp(api_key)
    if not request_key and _ai_status_cache is not None and _ai_status_cache[0] == fp:
        return _ai_status_cache[1]
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
            _ai_status_cache = (fp, valid)
            _ai_status_detail = 'ok' if valid else _upstream_error(resp)
        return valid
    except requests.RequestException as exc:
        if not request_key:
            _ai_status_detail = f'Could not reach Anthropic API: {exc}'
        return False


def ai_status_detail():
    """Why the last environment-key check failed, for /api/ai/status."""
    return _ai_status_detail


# ---------------------------------------------------------------------------
# LangChain Pipeline Initializers & Prompts
# ---------------------------------------------------------------------------
def _get_langchain_llm(request_key=None, max_tokens=3000, timeout=None):
    """Instantiate a LangChain ChatAnthropic model."""
    api_key = _api_key(request_key)
    if not api_key:
        raise AIUnavailable(
            'No Anthropic API key configured. Save one in Settings > AI Settings or set ANTHROPIC_API_KEY on the server.',
            status=503,
        )
    try:
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(
            model=GENERATION_MODEL,
            anthropic_api_key=api_key,
            max_tokens=max_tokens,
            temperature=0.2,
            # The SDK default is a 10-minute timeout with 2 retries, which is
            # what let a slow upstream run past the production gateway limit.
            default_request_timeout=timeout or AI_CALL_TIMEOUT_S,
            max_retries=0,
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
MAX_ATTEMPTS = 2


def _retry_delay(response, attempt):
    header = (response.headers or {}).get('retry-after') if response is not None else None
    if header:
        try:
            return min(float(header), 20.0)
        except (TypeError, ValueError):
            pass
    return 2.0 ** attempt


def _call_raw_claude(prompt, max_tokens=3000, request_key=None, system=None, deadline=None):
    api_key = _api_key(request_key)
    if not api_key:
        raise AIUnavailable(
            'No Anthropic API key configured. Save one in Settings > AI Settings or set ANTHROPIC_API_KEY on the server.',
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
        # `deadline` (time.monotonic()) is what is left of the request budget
        # after any earlier attempt; never start a call that cannot finish.
        budget = (deadline - time.monotonic()) if deadline else AI_CALL_TIMEOUT_S
        if budget < AI_CONNECT_TIMEOUT_S:
            raise AIUnavailable(
                f'{last_error}; no time left in the request budget to retry' if attempt
                else 'Request time budget exhausted before the Anthropic call')
        try:
            upstream = requests.post(
                ANTHROPIC_URL,
                headers={
                    'Content-Type': 'application/json',
                    'x-api-key': api_key,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                json=payload,
                timeout=(AI_CONNECT_TIMEOUT_S, min(AI_CALL_TIMEOUT_S, budget)),
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

    full_prompt = (
        "Perform a rapid, high-accuracy semantic evaluation of this resume against the Job Description.\n\n"
        f"CANDIDATE: {cand_name}\n"
        f"ROLE: {role_title}\n\n"
        "JOB DESCRIPTION:\n"
        f"{jd_content}\n\n"
        "CANDIDATE RESUME:\n"
        f"{resume_text}\n\n"
        "Evaluate technical depth, production experience, and domain alignment.\n"
        "Return ONLY valid JSON matching this schema:\n"
        "{\n"
        f'  "candidateName": "{cand_name}",\n'
        f'  "role": "{role_title}",\n'
        '  "score": <integer 0-100: overall match>,\n'
        '  "technical": <integer 0-100: technical depth>,\n'
        '  "experience": <integer 0-100: tenure & seniority>,\n'
        '  "domain": <integer 0-100: domain fit>,\n'
        '  "gap": "<2-sentence concise summary of match & gaps>",\n'
        '  "skills": ["<matched skill 1>", "<matched skill 2>"],\n'
        '  "missing": ["<missing skill 1>", "<missing skill 2>"],\n'
        '  "strengths": ["<key strength 1>", "<key strength 2>"],\n'
        '  "redFlags": ["<risk or gap 1>"],\n'
        '  "executiveSummary": "<2-3 sentence executive hiring summary>"\n'
        "}"
    )

    deadline = time.monotonic() + AI_REQUEST_BUDGET_S
    last_error = ''

    # 1. Try LangChain LCEL execution with fast token limit
    llm = _get_langchain_llm(request_key=request_key, max_tokens=1500, timeout=AI_CALL_TIMEOUT_S)
    if llm is not None:
        try:
            from langchain_core.messages import HumanMessage, SystemMessage
            from langchain_core.output_parsers import JsonOutputParser

            parser = JsonOutputParser()
            chain = llm | parser

            result = chain.invoke([
                SystemMessage(content=system_msg),
                HumanMessage(content=full_prompt),
            ])
            if isinstance(result, dict) and ('score' in result or 'skills' in result):
                return result
        except Exception as exc:
            last_error = str(exc)
            logger.warning("LangChain LCEL resume scoring fallback to raw Claude: %s", exc)

    # 2. Direct Claude API, then the keyword heuristic when the API itself is
    #    down. Configuration problems (no key, bad key) are never papered over:
    #    they surface to the caller so the operator sees them.
    try:
        raw_text = _call_raw_claude(full_prompt, max_tokens=2500, request_key=request_key,
                                    system=system_msg, deadline=deadline)
        parsed = _extract_json(raw_text)
        if isinstance(parsed, dict) and ('score' in parsed or 'skills' in parsed):
            return parsed
        last_error = 'Claude returned no parsable JSON'
    except AIUnavailable as exc:
        if exc.status in (401, 503):
            raise
        last_error = exc.message
    except Exception as exc:
        last_error = str(exc)

    logger.warning("Direct Claude scoring failed: %s; using heuristic analyzer fallback", last_error)
    return _heuristic_with_notice(resume_text, jd_text, cand_name, role_title, last_error)


def _heuristic_with_notice(resume_text, jd_text, cand_name, role_title, reason):
    """The keyword estimate, flagged so the API response, the stored row and
    the UI all say it is not an AI evaluation and why."""
    result = _fallback_heuristic_score(resume_text, jd_text, candidate_name=cand_name, role=role_title)
    result['aiFallback'] = True
    result['aiError'] = reason or 'AI service unavailable'
    return result


def _fallback_heuristic_score(resume_text, jd_text, candidate_name='', role=''):
    """High-accuracy fallback evaluation when Claude API is unreachable or rate-limited."""
    SKILLS = [
        "Python", "JavaScript", "TypeScript", "React", "Node.js", "Django", "SQL",
        "HTML", "CSS", "AWS", "Docker", "Kubernetes", "Git", "REST APIs", "GraphQL",
        "PostgreSQL", "MySQL", "MongoDB", "Redis", "Linux", "CI/CD", "Agile",
        "Power BI", "Data Visualization", "Application Support", "Incident Resolution",
        "Technical Support", "Troubleshooting", "Issue Diagnosis", "Root-Cause Analysis"
    ]
    r_lower = resume_text.lower()
    j_lower = jd_text.lower() if jd_text else ""

    matched = [s for s in SKILLS if s.lower() in r_lower and (not j_lower or s.lower() in j_lower)]
    if not matched:
        matched = [s for s in SKILLS if s.lower() in r_lower][:6]

    missing = [s for s in SKILLS if j_lower and s.lower() in j_lower and s.lower() not in r_lower]

    exp_matches = re.findall(r'(\d+)\+?\s*(?:years?|yrs?)', resume_text, re.IGNORECASE)
    years = max([int(x) for x in exp_matches]) if exp_matches else 3

    tc = min(98, max(55, len(matched) * 12 + 20))
    exp_score = min(98, max(60, years * 14))
    dom_score = min(95, max(50, int(tc * 0.6 + exp_score * 0.4)))
    overall = int(tc * 0.45 + exp_score * 0.35 + dom_score * 0.20)

    strengths = [
        f"Solid background in {matched[0]}" if matched else "Demonstrated domain competence",
        f"{years}+ years practical experience in technical roles",
    ]
    if len(matched) > 1:
        strengths.append(f"Demonstrated proficiency across {', '.join(matched[:3])}")

    red_flags = []
    if missing:
        red_flags.append(f"Gaps identified in JD-specific skills: {', '.join(missing[:3])}")
    else:
        red_flags.append("Limited depth in cloud infrastructure architectures")

    cand = candidate_name or 'Candidate'
    role_name = role or 'Technical Professional'

    exec_summary = (
        f"{cand} shows strong capabilities for {role_name} with {years}+ years of relevant experience. "
        f"Demonstrates practical hands-on proficiency in {', '.join(matched[:3]) if matched else 'core requirements'}, "
        f"offering a strong match for immediate team integration."
    )

    gap_summary = (
        f"Matched {len(matched)} key requirements. "
        f"{'Focus onboarding on ' + ', '.join(missing[:2]) if missing else 'All core skills adequately covered in profile.'}"
    )

    return {
        "candidateName": cand,
        "role": role_name,
        "score": overall,
        "technical": tc,
        "experience": exp_score,
        "domain": dom_score,
        "gap": gap_summary,
        "skills": matched[:8],
        "missing": missing[:5],
        "strengths": strengths,
        "redFlags": red_flags,
        "executiveSummary": exec_summary
    }


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
