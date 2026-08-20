"""
Auto-post a new job opening to a user's linked social accounts.

Real platform APIs are called (LinkedIn UGC Posts + X/Twitter v2). Posting
requires an OAuth access token with write scope. For LinkedIn each user grants
this themselves via Settings -> Email Configuration -> Social Media Accounts
("Connect LinkedIn"), which runs the flow in api/linkedin_oauth.py.

Everything lives in the `user_email_config.social` JSON column. The bare
platform key holds the profile URL the user typed into Settings (a string, kept
that way because the React form binds an input straight to it); credentials go
in a `<platform>Auth` sidecar the form never touches:

    "social": {
      "linkedin": "https://linkedin.com/in/acme",
      "linkedinAuth": {
        "accessToken": "<OAuth2 token, scope w_member_social>",
        "authorUrn": "urn:li:person:XXXX",   // or urn:li:organization:XXXX
        "name": "Acme Recruiter",
        "expiresAt": "2026-09-20T10:00:00+00:00"
      },
      "twitter": "https://x.com/acme",
      "twitterAuth": {"accessToken": "<OAuth2 user token, scope tweet.write>"}
    }

A platform with only a URL (no token) is skipped with an explanatory note, so
the feature degrades gracefully until the user connects their account.
"""
import json
import re
from datetime import datetime, timezone as _timezone

import requests

LINKEDIN_POSTS_URL = 'https://api.linkedin.com/v2/ugcPosts'
TWITTER_TWEETS_URL = 'https://api.twitter.com/2/tweets'
TIMEOUT = 20

RECONNECT_HINT = ('LinkedIn rejected the token — reconnect your account in '
                  'Settings → Email Configuration.')


def _platform_cfg(social, key):
    """Merge a platform's profile URL with its OAuth sidecar into one dict.

    Also accepts the legacy shape where everything sat in a single dict under
    the platform key, so rows written before the sidecar split still post.
    """
    social = social or {}
    val = social.get(key)
    if isinstance(val, dict):
        cfg = dict(val)          # legacy combined shape
    elif isinstance(val, str):
        cfg = {'url': val}
    else:
        cfg = {}

    auth = social.get(key + 'Auth')
    if isinstance(auth, dict):
        cfg.update(auth)
    return cfg


def _is_expired(cfg):
    """True when a stored token's expiry has passed. Unknown expiry -> False,
    so we still try the call and let the platform be the judge."""
    raw = str(cfg.get('expiresAt') or '').strip()
    if not raw:
        return False
    try:
        parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_timezone.utc)
    return parsed <= datetime.now(_timezone.utc)


def _hashtag(text):
    """'Data Engineer' -> '#DataEngineer'. Empty for anything unusable."""
    words = re.findall(r'[A-Za-z0-9]+', str(text or ''))
    if not words:
        return ''
    return '#' + ''.join(w[:1].upper() + w[1:] for w in words)


def _as_list(value):
    """custom_fields values arrive as a list, or a comma/newline-separated
    string depending on the form field type."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [p.strip() for p in re.split(r'[\n,;|]+', value) if p.strip()]
    return []


def build_message(job, contact=None):
    """Draft LinkedIn announcement for a job.

    This is only a starting point — the recruiter reviews and edits it in the
    preview dialog before anything is published, so erring toward including a
    field is better than omitting it.

    `contact` is an optional {'email','phone','name'} for the closing block.
    """
    title = (job.get('title') or 'New role').strip()
    custom = job.get('customFields') or job.get('custom_fields') or {}
    if not isinstance(custom, dict):
        custom = {}

    def field(*names):
        for n in names:
            v = custom.get(n)
            if v not in (None, '', []):
                return v
        return ''

    bits = []
    tag = _hashtag(title)
    bits.append(f'\U0001f6a8 We’re Hiring | {tag or title} \U0001f6a8')

    desc = (job.get('description') or '').strip()
    if desc:
        # Descriptions pasted from Word/email carry runs of blank lines that
        # look like padding once rendered on LinkedIn.
        desc = re.sub(r'[ \t]+\n', '\n', desc)
        desc = re.sub(r'\n{3,}', '\n\n', desc)
        bits.append(desc)

    # ---- facts block -------------------------------------------------------
    facts = [f'Position: {title}']
    location = (job.get('location') or '').strip()
    if job.get('remote') or job.get('is_remote'):
        location = f'{location} (Remote)' if location else 'Remote'
    if location:
        facts.append(f'\U0001f4cd Location: {location}')
    exp = str(field('experience', 'exp', 'years_of_experience') or '').strip()
    if exp:
        # A bare number reads better as "5+ Years"; ranges pass through as-is.
        facts.append(f'\U0001f4bc Experience: {exp}+ Years' if exp.isdigit()
                     else f'\U0001f4bc Experience: {exp}')
    jtype = (job.get('type') or '').strip()
    if jtype:
        facts.append(f'\U0001f552 Employment Type: {jtype}')
    edu = str(field('education', 'qualification') or '').strip()
    if edu:
        facts.append(f'\U0001f393 Education: {edu}')
    salary = (job.get('salary') or '').strip()
    if salary:
        facts.append(f'\U0001f4b0 {salary}')
    openings = job.get('openings')
    if isinstance(openings, int) and openings > 1:
        facts.append(f'\U0001f465 Openings: {openings}')
    bits.append('\n'.join(facts))

    # ---- responsibilities / skills ----------------------------------------
    resp = _as_list(field('responsibilities', 'key_responsibilities', 'duties'))
    if resp:
        bits.append('Key Responsibilities:\n' + '\n'.join(f'◆ {r}' for r in resp))

    skills = _as_list(field('skills', 'required_skills', 'skill'))
    if skills:
        bits.append('Required Skills:\n' + '\n'.join(f'✔ {s}' for s in skills))

    # ---- contact -----------------------------------------------------------
    contact = contact or {}
    email, phone = (contact.get('email') or '').strip(), (contact.get('phone') or '').strip()
    if email or phone:
        lines = ['\U0001f4cc Interested candidates, please DM your resume or share it to:']
        if email:
            lines.append(f'\U0001f4e7 {email}')
        if phone:
            lines.append(f'\U0001f4de {phone}')
        bits.append('\n'.join(lines))

    # ---- hashtags ----------------------------------------------------------
    tags, seen = [], set()
    for raw in [title] + skills[:6] + [job.get('dept'), 'Hiring', 'HiringNow', 'Jobs', 'TechHiring']:
        t = _hashtag(raw)
        if t and t.lower() not in seen:
            seen.add(t.lower())
            tags.append(t)
    bits.append(' '.join(tags))

    return '\n\n'.join(b for b in bits if b)


def _post_linkedin(cfg, message):
    token = cfg.get('accessToken')
    author = cfg.get('authorUrn')
    if not token or not author:
        return {'platform': 'linkedin', 'ok': False, 'skipped': True,
                'error': 'No LinkedIn account connected. Connect yours in '
                         'Settings → Email Configuration.'}
    if _is_expired(cfg):
        return {'platform': 'linkedin', 'ok': False, 'skipped': True,
                'error': 'Your LinkedIn connection has expired — reconnect it in '
                         'Settings → Email Configuration.'}
    payload = {
        'author': author,
        'lifecycleState': 'PUBLISHED',
        'specificContent': {
            'com.linkedin.ugc.ShareContent': {
                'shareCommentary': {'text': message},
                'shareMediaCategory': 'NONE',
            }
        },
        'visibility': {'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'},
    }
    try:
        r = requests.post(
            LINKEDIN_POSTS_URL,
            headers={
                'Authorization': f'Bearer {token}',
                'Content-Type': 'application/json',
                'X-Restli-Protocol-Version': '2.0.0',
            },
            data=json.dumps(payload),
            timeout=TIMEOUT,
        )
        if r.ok:
            return {'platform': 'linkedin', 'ok': True,
                    'id': r.headers.get('x-restli-id') or r.headers.get('X-RestLi-Id')}
        # A revoked or expired token reads as 401/403; tell the user what to do
        # about it rather than dumping the raw API response.
        if r.status_code in (401, 403):
            return {'platform': 'linkedin', 'ok': False, 'expired': True,
                    'error': RECONNECT_HINT}
        return {'platform': 'linkedin', 'ok': False,
                'error': f'{r.status_code}: {r.text[:300]}'}
    except requests.RequestException as e:
        return {'platform': 'linkedin', 'ok': False, 'error': str(e)}


def _post_twitter(cfg, message):
    token = cfg.get('accessToken')
    if not token:
        return {'platform': 'twitter', 'ok': False, 'skipped': True,
                'error': 'No X/Twitter accessToken configured.'}
    try:
        r = requests.post(
            TWITTER_TWEETS_URL,
            headers={
                'Authorization': f'Bearer {token}',
                'Content-Type': 'application/json',
            },
            data=json.dumps({'text': message[:280]}),
            timeout=TIMEOUT,
        )
        if r.ok:
            data = (r.json() or {}).get('data', {})
            return {'platform': 'twitter', 'ok': True, 'id': data.get('id')}
        return {'platform': 'twitter', 'ok': False,
                'error': f'{r.status_code}: {r.text[:300]}'}
    except requests.RequestException as e:
        return {'platform': 'twitter', 'ok': False, 'error': str(e)}


_POSTERS = {
    'linkedin': _post_linkedin,
    'twitter': _post_twitter,
}


def post_job(job, social, message=None, contact=None):
    """Post `job` to every linked platform that has credentials.

    `message` is the text the recruiter approved in the preview dialog; when
    omitted we fall back to a freshly built draft.
    Returns a list of per-platform result dicts.
    """
    message = (message or '').strip() or build_message(job, contact)
    results = []
    for key, poster in _POSTERS.items():
        cfg = _platform_cfg(social, key)
        # Only attempt platforms the user has set up at all (URL or token present).
        if not cfg:
            continue
        results.append(poster(cfg, message))
    return results
