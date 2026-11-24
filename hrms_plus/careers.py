"""Careers: public job board, embeddable widget and the recruiter inbox.

Public (no sign-in, mounted under /api/ by hrms_plus/urls_careers.py):
  GET     /api/public/careers/jobs              Active jobs + facets (search, department, location, type, remote)
  GET     /api/public/careers/jobs/<id|code>    one job + its application questions + a signed form token
  POST    /api/public/careers/apply             submit an application (JSON, resume as base64)

Recruiters (recruitment.view / recruitment.edit):
  GET     /api/recruit/applications                    list (never carries the resume body)
  GET     /api/recruit/applications/meta               jobs / statuses / sources / permissions
  GET     /api/recruit/applications/<id>               detail + history
  PATCH   /api/recruit/applications/<id>               {status, note}  pipeline move
  GET     /api/recruit/applications/<id>/resume        the resume file (audited)
  POST    /api/recruit/applications/<id>/score         score the resume with the Resume Scoring engine
  POST    /api/recruit/applications/<id>/onboard       create an onboarding candidate (hired only)
  GET/PUT /api/recruit/careers/settings                careers page settings (MasterDataSet 'careers_settings')

Public-endpoint protections: Active jobs only and no internal fields; strict
input validation; resume checked by its bytes (PDF / DOCX, 5 MB); honeypot
field; signed form token enforcing a minimum fill time; per-IP rate limits on a
keyed hash of the IP (the raw IP is never stored); duplicate detection (same
email or same resume for the same job within 30 days); consent required;
cross-origin calls only from the configured allowed origins (never ``*``,
never with credentials).
"""
import base64
import hashlib
import hmac
import html
import io
import json
import logging
import re
import threading
import time
import zipfile
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.db.models import Count, F, Q
from django.http import HttpResponse
from django.utils.cache import patch_vary_headers
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.models import AppUser, CompanyDetail, JobFormTemplate, JobPost, MasterDataSet
from api.timeutil import local_now
from hrms_plus.models import JobApplication

logger = logging.getLogger(__name__)

SETTINGS_KEY = 'careers_settings'
DEFAULT_SETTINGS = {
    'enabled': True,
    'allowedOrigins': [],        # sites allowed to embed the widget / call the public API cross-origin
    'showSalary': False,
    'showApplicants': False,
    'privacyUrl': '',
    'intro': '',                 # short line under the careers page heading
    'publicFields': [],          # Job Form Builder custom field keys shown publicly
    'questions': [],             # default application questions (a job may override)
    'notifyEmails': [],          # extra recruiter mailboxes told about each application
    'rateLimitPerHour': 5,       # stored applications per IP hash per hour
    'minFillSeconds': 3,         # a human needs at least this long to fill the form
}
STATUSES = list(JobApplication.STATUSES)
SOURCES = ('careers', 'widget', 'referral', 'manual')
OPEN_STATUSES = ('new', 'screening', 'interview', 'offer')
TRANSITIONS = {
    'new': ['screening', 'rejected', 'withdrawn'],
    'screening': ['interview', 'rejected', 'withdrawn'],
    'interview': ['offer', 'rejected', 'withdrawn'],
    'offer': ['hired', 'rejected', 'withdrawn'],
    'hired': [],
    'rejected': ['screening'],      # re-open
    'withdrawn': ['screening'],
}
RESUME_MAX_MB = 5
MAX_BODY_BYTES = 8 * 1024 * 1024    # 5 MB file as base64 + the form
DUPLICATE_DAYS = 30
ATTEMPTS_PER_HOUR = 30              # any POST, valid or not, per IP hash
TOKEN_SALT = 'hrms_plus.careers.form'
TOKEN_MAX_AGE = 24 * 3600
QUESTION_TYPES = ('text', 'textarea', 'select', 'boolean', 'number', 'url', 'email')
ASYNC_SIDE_EFFECTS = True           # tests switch this off to run mail/notify inline
VIEW = 'recruitment.view'
EDIT = 'recruitment.edit'
EMPLOYMENT_TYPES = {
    'full-time': 'FULL_TIME', 'full time': 'FULL_TIME', 'part-time': 'PART_TIME', 'part time': 'PART_TIME',
    'contract': 'CONTRACTOR', 'contractor': 'CONTRACTOR', 'internship': 'INTERN', 'intern': 'INTERN',
    'temporary': 'TEMPORARY', 'freelance': 'CONTRACTOR',
}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _msg(message, status=400, code=None, **extra):
    body = {'ok': False, 'message': message}
    if code:
        body['code'] = code
    body.update(extra)
    return Response(body, status=status)


_CTRL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def clean_text(value, max_len, multiline=False):
    s = '' if value is None else str(value)
    s = _CTRL.sub('', s)
    if not multiline:
        s = re.sub(r'\s+', ' ', s)
    return s.strip()[:max_len + 1]    # one extra char so callers can detect "too long"


def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _bool(v):
    if isinstance(v, str):
        return v.strip().lower() in ('1', 'true', 'yes', 'on')
    return bool(v)


def _iso(v):
    if not v:
        return None
    try:
        return v.isoformat()
    except AttributeError:
        return str(v)


def _norm_origin(o):
    """'https://Example.com/' -> 'https://example.com'; None when it is not a bare http(s) origin."""
    s = str(o or '').strip().rstrip('/')
    if not s or s == '*':
        return None
    try:
        u = urlsplit(s)
    except ValueError:
        return None
    if u.scheme not in ('http', 'https') or not u.netloc or u.path or u.query or u.fragment or '@' in u.netloc:
        return None
    return f'{u.scheme}://{u.netloc.lower()}'


def _safe_url(v, max_len=300):
    s = clean_text(v, max_len)
    if not s:
        return ''
    try:
        u = urlsplit(s)
    except ValueError:
        return None
    if u.scheme not in ('http', 'https') or not u.netloc or len(s) > max_len:
        return None
    return s


def _hostname(v):
    s = str(v or '').strip().lower()[:255]
    if '://' in s:
        try:
            s = urlsplit(s).netloc
        except ValueError:
            return ''
    return s if re.fullmatch(r'[a-z0-9.\-:]{1,255}', s or '') else ''


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------
def _slug(s):
    return re.sub(r'[^a-z0-9]+', '_', str(s or '').lower()).strip('_')[:40]


def normalize_questions(raw):
    out, seen = [], set()
    for q in (raw if isinstance(raw, list) else [])[:20]:
        if not isinstance(q, dict):
            continue
        label = clean_text(q.get('label'), 200)[:200]
        if not label:
            continue
        key = _slug(q.get('key') or label) or f'q{len(out) + 1}'
        while key in seen:
            key = key + '_'
        seen.add(key)
        qtype = str(q.get('type') or 'text').lower()
        if qtype not in QUESTION_TYPES:
            qtype = 'text'
        item = {'key': key, 'label': label, 'type': qtype, 'required': _bool(q.get('required'))}
        if qtype == 'select':
            opts = q.get('options')
            if isinstance(opts, str):
                opts = [o for o in re.split(r'[\n;,]', opts)]
            opts = [clean_text(o.get('label', o.get('value')) if isinstance(o, dict) else o, 120)[:120]
                    for o in (opts or [])]
            item['options'] = [o for o in opts if o][:30]
            if not item['options']:
                item['type'] = 'text'
                item.pop('options')
        out.append(item)
    return out


def get_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        obj = MasterDataSet.objects.filter(key=SETTINGS_KEY).first()
        raw = obj.options if obj else None
        if isinstance(raw, list) and raw and isinstance(raw[0], dict):
            raw = raw[0]
        if isinstance(raw, dict):
            s.update(_clean_settings(raw, partial=True))
    except Exception:
        logger.exception('careers settings unreadable; using defaults')
    return s


def _clean_settings(values, partial=False):
    out = {}
    if 'enabled' in values:
        out['enabled'] = _bool(values['enabled'])
    for k in ('showSalary', 'showApplicants'):
        if k in values:
            out[k] = _bool(values[k])
    if 'allowedOrigins' in values:
        raw = values['allowedOrigins']
        if isinstance(raw, str):
            raw = re.split(r'[\s,]+', raw)
        origins = []
        for o in (raw or [])[:30]:
            n = _norm_origin(o)
            if n and n not in origins:
                origins.append(n)
        out['allowedOrigins'] = origins
    if 'privacyUrl' in values:
        out['privacyUrl'] = _safe_url(values['privacyUrl'], 500) or ''
    if 'intro' in values:
        out['intro'] = clean_text(values['intro'], 300)[:300]
    if 'publicFields' in values:
        out['publicFields'] = [k.strip()[:60] for k in (values['publicFields'] or [])
                               if isinstance(k, str) and k.strip()][:40]
    if 'questions' in values:
        out['questions'] = normalize_questions(values['questions'])
    if 'notifyEmails' in values:
        raw = values['notifyEmails']
        if isinstance(raw, str):
            raw = re.split(r'[\s,;]+', raw)
        emails = []
        for e in (raw or [])[:10]:
            e = str(e or '').strip().lower()
            try:
                validate_email(e)
            except ValidationError:
                continue
            if e not in emails:
                emails.append(e)
        out['notifyEmails'] = emails
    if 'rateLimitPerHour' in values:
        out['rateLimitPerHour'] = min(max(_to_int(values['rateLimitPerHour'], 5), 1), 100)
    if 'minFillSeconds' in values:
        out['minFillSeconds'] = min(max(_to_int(values['minFillSeconds'], 3), 0), 120)
    return out


def save_settings(values):
    s = get_settings()
    s.update(_clean_settings(values or {}))
    MasterDataSet.objects.update_or_create(key=SETTINGS_KEY, defaults={'label': 'Careers settings', 'options': s})
    return s


def public_base(request=None):
    base = (getattr(settings, 'HRMS_PUBLIC_URL', '') or '').rstrip('/')
    if base:
        return base
    if request is not None:
        return f'{request.scheme}://{request.get_host()}'
    return ''


# ---------------------------------------------------------------------------
# company + jobs (public view)
# ---------------------------------------------------------------------------
def company_info():
    c = CompanyDetail.objects.order_by('id').first()
    name = ((c.company_name or c.brand_name) if c else '') or 'Our company'
    return {
        'name': name,
        'website': _safe_url(c.website, 255) or '' if c else '',
        'hasLogo': True,
        'logoUrl': '/careers/logo',
    }


def public_jobs_qs():
    return JobPost.objects.filter(status__iexact='Active')


def find_public_job(ident):
    ident = str(ident or '').strip()
    if not ident or len(ident) > 40:
        return None
    qs = public_jobs_qs()
    if ident.isdigit():
        job = qs.filter(pk=int(ident)).first()
        if job:
            return job
    return qs.filter(code__iexact=ident).first()


def _template_fields():
    t = JobFormTemplate.objects.filter(is_active=True).first() or JobFormTemplate.objects.filter(name='Default').first()
    out = []
    for sec in (t.schema if t and isinstance(t.schema, list) else []):
        if isinstance(sec, dict) and isinstance(sec.get('fields'), list):
            out.extend(f for f in sec['fields'] if isinstance(f, dict))
        elif isinstance(sec, dict) and sec.get('key'):
            out.append(sec)
    return out


def custom_field_options():
    """Non-core Job Form Builder fields a recruiter may publish."""
    return [{'key': f.get('key'), 'label': f.get('label') or f.get('key'), 'public': bool(f.get('public'))}
            for f in _template_fields() if f.get('key') and not f.get('core')]


def _display_value(v):
    if v is None or v == '':
        return ''
    if isinstance(v, bool):
        return 'Yes' if v else 'No'
    if isinstance(v, (list, tuple)):
        return ', '.join(str(x.get('label', x.get('value', '')) if isinstance(x, dict) else x) for x in v if x not in (None, ''))
    if isinstance(v, dict):
        return str(v.get('display') or v.get('label') or '')
    return str(v)


def public_fields(job, s):
    allowed = set(s.get('publicFields') or [])
    values = job.custom_fields if isinstance(job.custom_fields, dict) else {}
    out = []
    for f in _template_fields():
        key = f.get('key')
        if not key or f.get('core') or key == 'applicationQuestions':
            continue
        if not (f.get('public') or key in allowed):
            continue
        val = _display_value(values.get(key))[:1000]
        if val:
            out.append({'label': str(f.get('label') or key)[:120], 'value': val})
    return out


def job_questions(job, s):
    cf = job.custom_fields if isinstance(job.custom_fields, dict) else {}
    if isinstance(cf.get('applicationQuestions'), list):
        return normalize_questions(cf['applicationQuestions'])
    return normalize_questions(s.get('questions') or [])


def job_url(job):
    return '/careers/' + (job.code or str(job.id))


def job_public(job, s, full=False):
    d = {
        'id': job.id,
        'code': job.code or '',
        'title': job.title,
        'department': job.dept or '',
        'location': job.location or '',
        'type': job.type or '',
        'remote': bool(job.is_remote),
        'openings': max(job.openings or 1, 1),
        'postedAt': _iso(job.created_at.date() if job.created_at else None),
        'url': job_url(job),
    }
    if s.get('showSalary') and job.salary:
        d['salary'] = job.salary
    if s.get('showApplicants'):
        d['applicants'] = job.applicants or 0
    if full:
        d['description'] = job.description or ''
        d['fields'] = public_fields(job, s)
        d['questions'] = job_questions(job, s)
    else:
        desc = re.sub(r'\s+', ' ', job.description or '').strip()
        d['summary'] = (desc[:180] + '…') if len(desc) > 180 else desc
    return d


def filter_jobs(params):
    qs = public_jobs_qs()
    q = clean_text(params.get('q') or params.get('search'), 100)
    if q:
        qs = qs.filter(Q(title__icontains=q) | Q(description__icontains=q) | Q(dept__icontains=q)
                       | Q(code__iexact=q) | Q(location__icontains=q))
    for param, field in (('department', 'dept'), ('location', 'location'), ('type', 'type')):
        v = clean_text(params.get(param), 120)
        if v:
            qs = qs.filter(**{f'{field}__iexact': v})
    remote = str(params.get('remote') or '').lower()
    if remote in ('1', 'true', 'yes', 'remote'):
        qs = qs.filter(is_remote=True)
    elif remote in ('0', 'false', 'no', 'onsite'):
        qs = qs.filter(is_remote=False)
    return qs.order_by('-created_at', '-id')


def facets():
    qs = public_jobs_qs()

    def vals(field):
        return sorted({v.strip() for v in qs.values_list(field, flat=True) if v and v.strip()}, key=str.lower)
    return {'departments': vals('dept'), 'locations': vals('location'), 'types': vals('type'),
            'hasRemote': qs.filter(is_remote=True).exists()}


def json_ld(job, company, base):
    """schema.org JobPosting for search engines."""
    data = {
        '@context': 'https://schema.org/',
        '@type': 'JobPosting',
        'title': job.title,
        'description': html.escape(job.description or job.title).replace('\n', '<br>'),
        'datePosted': _iso(job.created_at.date() if job.created_at else None),
        'hiringOrganization': {'@type': 'Organization', 'name': company['name']},
        'identifier': {'@type': 'PropertyValue', 'name': company['name'], 'value': job.code or str(job.id)},
        'directApply': True,
    }
    if company.get('website'):
        data['hiringOrganization']['sameAs'] = company['website']
    if base:
        data['hiringOrganization']['logo'] = base + '/careers/logo'
        data['url'] = base + job_url(job)
    et = EMPLOYMENT_TYPES.get((job.type or '').strip().lower())
    if et:
        data['employmentType'] = et
    if job.location:
        data['jobLocation'] = {'@type': 'Place', 'address': {'@type': 'PostalAddress', 'addressLocality': job.location}}
    if job.is_remote:
        data['jobLocationType'] = 'TELECOMMUTE'
    # Escape '<' so a description can never close the <script> element.
    return json.dumps(data, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


# ---------------------------------------------------------------------------
# origins / CORS
# ---------------------------------------------------------------------------
def origin_status(request, s=None):
    """('none' | 'self' | 'allowed' | 'denied', origin)."""
    origin = (request.headers.get('Origin') or '').strip()
    if not origin:
        return 'none', ''
    n = _norm_origin(origin)
    if not n:
        return 'denied', origin           # 'null', file://, garbage
    netloc = urlsplit(n).netloc
    if netloc == request.get_host().lower():
        return 'self', n
    pub = public_base()
    if pub and netloc == urlsplit(pub).netloc.lower():
        return 'self', n
    s = s or get_settings()
    if n in (s.get('allowedOrigins') or []):
        return 'allowed', n
    return 'denied', n


def with_cors(response, request, s=None):
    st, origin = origin_status(request, s)
    if st == 'allowed':
        response['Access-Control-Allow-Origin'] = origin
        response['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response['Access-Control-Allow-Headers'] = 'Content-Type'
        response['Access-Control-Max-Age'] = '600'
    patch_vary_headers(response, ('Origin',))
    return response


def _cors_signal(sender, request, **kwargs):
    """django-cors-headers hook: enable CORS on the public careers API only,
    and only for the configured origins (preflight answered by the middleware)."""
    try:
        if not request.path_info.startswith('/api/public/careers/'):
            return False
        return origin_status(request)[0] == 'allowed'
    except Exception:
        return False


try:
    from corsheaders.signals import check_request_enabled
    check_request_enabled.connect(_cors_signal, dispatch_uid='hrms_plus.careers.cors')
except Exception:  # pragma: no cover - corsheaders missing
    pass


def frame_ancestors(s):
    return "frame-ancestors 'self'" + ''.join(' ' + o for o in (s.get('allowedOrigins') or []))


# ---------------------------------------------------------------------------
# spam protection
# ---------------------------------------------------------------------------
def client_ip(request):
    fwd = request.META.get('HTTP_X_FORWARDED_FOR', '')
    return (fwd.split(',')[0].strip() if fwd else request.META.get('REMOTE_ADDR', ''))[:60]


def ip_hash(request):
    key = (settings.SECRET_KEY or 'careers').encode('utf-8')
    return hmac.new(key, ('careers-ip:' + client_ip(request)).encode('utf-8'), hashlib.sha256).hexdigest()


def form_token(job_id, issued=None):
    return signing.dumps({'j': int(job_id), 't': int(time.time() if issued is None else issued)}, salt=TOKEN_SALT)


def check_form_token(token, job_id, min_seconds):
    """'' when fine, else 'bad' | 'expired' | 'fast'."""
    if not token or not isinstance(token, str) or len(token) > 300:
        return 'bad'
    try:
        d = signing.loads(token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE)
    except signing.SignatureExpired:
        return 'expired'
    except signing.BadSignature:
        return 'bad'
    if not isinstance(d, dict) or d.get('j') != job_id:
        return 'bad'
    if time.time() - _to_int(d.get('t')) < min_seconds:
        return 'fast'
    return ''


def _attempt(iph):
    """Counts every POST per IP hash; True when over the hourly cap."""
    key = 'careers:att:' + iph[:32]
    try:
        n = cache.get(key)
        if n is None:
            cache.set(key, 1, 3600)
            return False
        n = cache.incr(key)
        return n > ATTEMPTS_PER_HOUR
    except Exception:
        return False


# ---------------------------------------------------------------------------
# resume validation + text extraction
# ---------------------------------------------------------------------------
RESUME_TYPES = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}


def _is_docx(raw):
    if not raw.startswith(b'PK\x03\x04'):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            names = z.namelist()
    except (zipfile.BadZipFile, ValueError, OSError):
        return False
    return '[Content_Types].xml' in names and any(n.startswith('word/') for n in names)


def check_resume(obj):
    """(raw_bytes, mime, safe_name, '') or (None, '', '', error)."""
    if not isinstance(obj, dict):
        return None, '', '', 'Please attach your resume (PDF or DOCX).'
    name = clean_text(obj.get('name'), 255).replace('\\', '/').split('/')[-1]
    name = re.sub(r'[^\w.\- ()]+', '_', name)[:150] or 'resume'
    ext = ('.' + name.rsplit('.', 1)[-1].lower()) if '.' in name else ''
    if ext not in RESUME_TYPES:
        return None, '', '', 'Only PDF or DOCX resumes are accepted.'
    data = str(obj.get('data') or '')
    if data.startswith('data:') and ',' in data[:200]:
        data = data.split(',', 1)[1]
    if not data:
        return None, '', '', 'Please attach your resume (PDF or DOCX).'
    if len(data) > (RESUME_MAX_MB * 1024 * 1024 * 4) // 3 + 16:
        return None, '', '', f'Resumes must be {RESUME_MAX_MB} MB or smaller.'
    if ext == '.pdf':
        from api.payroll_ext.security import check_upload
        raw, error = check_upload(data, 'application/pdf', RESUME_MAX_MB)
        if error:
            return None, '', '', ('The file is not a valid PDF.' if 'match' in error else error)
        return raw, RESUME_TYPES[ext], name, ''
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception:
        return None, '', '', 'The file could not be read.'
    if not raw:
        return None, '', '', 'The file is empty.'
    if len(raw) > RESUME_MAX_MB * 1024 * 1024:
        return None, '', '', f'Resumes must be {RESUME_MAX_MB} MB or smaller.'
    if not _is_docx(raw):
        return None, '', '', 'The file is not a valid DOCX document.'
    return raw, RESUME_TYPES[ext], name, ''


def extract_text(raw, mime):
    """Plain text of a PDF / DOCX resume ('' when unreadable). Bounded work."""
    try:
        if mime == 'application/pdf':
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(raw))
            parts = []
            for page in reader.pages[:15]:
                parts.append(page.extract_text() or '')
            return '\n'.join(parts)[:60000]
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            info = z.getinfo('word/document.xml')
            if info.file_size > 20 * 1024 * 1024:
                return ''
            xml = z.read(info).decode('utf-8', 'ignore')
        xml = re.sub(r'</w:p>', '\n', xml)
        xml = re.sub(r'<w:tab/>', '\t', xml)
        text = re.sub(r'<[^>]+>', '', xml)
        return html.unescape(text)[:60000]
    except Exception:
        logger.info('careers: resume text extraction failed', exc_info=True)
        return ''


# ---------------------------------------------------------------------------
# application validation
# ---------------------------------------------------------------------------
def validate_application(body, questions):
    """(clean_dict, errors_dict)."""
    errors, out = {}, {}
    name = clean_text(body.get('fullName') or body.get('name'), 200)
    if len(name) < 2:
        errors['fullName'] = 'Please enter your full name.'
    elif len(name) > 200:
        errors['fullName'] = 'Name is too long.'
    out['full_name'] = name[:200]

    email = clean_text(body.get('email'), 255).lower()
    try:
        if len(email) > 254:
            raise ValidationError('long')
        validate_email(email)
    except ValidationError:
        errors['email'] = 'Please enter a valid email address.'
    out['email'] = email[:255]

    phone = clean_text(body.get('phone'), 40)
    if phone and not re.fullmatch(r'[0-9+()\-. ]{5,40}', phone):
        errors['phone'] = 'Please enter a valid phone number.'
    out['phone'] = phone[:40]

    loc = clean_text(body.get('location'), 200)
    if len(loc) > 200:
        errors['location'] = 'Location is too long.'
    out['location'] = loc[:200]

    li = _safe_url(body.get('linkedinUrl') or body.get('linkedin'), 300)
    if li is None:
        errors['linkedinUrl'] = 'Please enter a full link starting with https://'
    out['linkedin_url'] = li or ''

    cover = clean_text(body.get('coverLetter'), 10000, multiline=True)
    if len(cover) > 10000:
        errors['coverLetter'] = 'Cover letter must be 10,000 characters or fewer.'
    out['cover_letter'] = cover[:10000]

    raw_answers = body.get('answers') if isinstance(body.get('answers'), dict) else {}
    answers = {}
    for q in questions:
        k = q['key']
        v = raw_answers.get(k)
        if q['type'] == 'boolean':
            v = 'Yes' if _bool(v) else ('No' if v not in (None, '') else '')
        else:
            v = clean_text(v, 2000, multiline=q['type'] == 'textarea')
        if not v:
            if q['required']:
                errors['answers.' + k] = 'This question is required.'
            continue
        if len(v) > 2000:
            errors['answers.' + k] = 'Answer is too long.'
        elif q['type'] == 'select' and v not in q.get('options', []):
            errors['answers.' + k] = 'Please choose one of the options.'
        elif q['type'] == 'number' and not re.fullmatch(r'-?\d+(\.\d+)?', v):
            errors['answers.' + k] = 'Please enter a number.'
        elif q['type'] == 'url' and not _safe_url(v, 2000):
            errors['answers.' + k] = 'Please enter a full link starting with https://'
        elif q['type'] == 'email':
            try:
                validate_email(v)
            except ValidationError:
                errors['answers.' + k] = 'Please enter a valid email address.'
        answers[k] = {'label': q['label'], 'value': v[:2000]}
    out['answers'] = answers
    return out, errors


# ---------------------------------------------------------------------------
# side effects: mail + in-app notifications
# ---------------------------------------------------------------------------
def _recruiter_emails(cap=25):
    from api.payroll_ext.security import has_perm
    from api.permissions import _CACHE
    _CACHE.clear()
    out = []
    for u in AppUser.objects.select_related('role_ref').filter(status='active').order_by('id'):
        try:
            if has_perm(u, EDIT):
                out.append(u.email.lower())
        except Exception:
            continue
        if len(out) >= cap:
            break
    return out


# ---------------------------------------------------------------------------
# applicant confirmation email (recorded, so failures are visible + resendable)
# ---------------------------------------------------------------------------
CONFIRM_PURPOSE = 'application_ack'


def send_confirmation(app, actor=''):
    """Email the applicant their confirmation and record the outcome as a
    ChannelDelivery row (channel 'email', purpose 'application_ack', ref = id).

    mailer.send_email reports failure in its return value instead of raising,
    so the result is checked here: a failed send is logged with the
    provider's reason and shown to recruiters, who can resend it.
    Returns {'ok': bool, 'error': str}."""
    from api import mailer
    from api.models import ChannelDelivery
    company = company_info()['name']
    job = app.job
    e = html.escape
    base = public_base()
    jobs_link = (f'<p style="margin:12px 0 0;"><a href="{e(base)}/careers">See other open roles</a></p>' if base else '')
    try:
        body = mailer.render_branded(
            title='Application received',
            intro=(f'Hi {e(app.full_name)}, thank you for applying for <b>{e(job.title)}</b> at {e(company)}. '
                   'Our recruiting team will review your application and get back to you if your profile is a match.'),
            highlight_html=(f'<p style="font-size:13px;color:#64748b;margin:0;">Reference: APP-{app.id:06d}</p>'
                            + jobs_link),
            company=company, signoff=True)
        res = mailer.send_email(app.email, f'We received your application: {job.title}', html=body) or {}
    except Exception as exc:                                   # never let mail break the flow
        logger.exception('careers: applicant confirmation crashed for %s', app.id)
        res = {'ok': False, 'error': f'{type(exc).__name__}: {exc}'}
    ok = bool(res.get('ok'))
    error = '' if ok else str(res.get('error') or 'Unknown email error')[:250]
    if not ok:
        logger.warning('careers: applicant confirmation NOT sent for APP-%06d: %s', app.id, error)
    try:
        ChannelDelivery.objects.create(channel='email', recipient=app.email, email=app.email, purpose=CONFIRM_PURPOSE,
                                       ref=str(app.id), status='sent' if ok else 'failed',
                                       provider_ref=(actor or 'system')[:100], error=error)
    except Exception:
        logger.exception('careers: could not record confirmation delivery for %s', app.id)
    return {'ok': ok, 'error': error}


def confirmation_status(app):
    from api.models import ChannelDelivery
    rows = list(ChannelDelivery.objects.filter(channel='email', purpose=CONFIRM_PURPOSE, ref=str(app.id))
                .order_by('-id')[:5])
    if not rows:
        return {'status': 'unknown', 'attempts': 0}
    last = rows[0]
    return {'status': last.status, 'at': last.created_at.isoformat() if last.created_at else None,
            'error': last.error, 'by': '' if last.provider_ref == 'system' else last.provider_ref,
            'attempts': len(rows)}


def _after_apply(app_id):
    from api import mailer
    from api.views import create_notification
    app = JobApplication.objects.select_related('job').filter(pk=app_id).first()
    if not app:
        return
    company = company_info()['name']
    job = app.job
    e = html.escape
    send_confirmation(app)
    title = 'New job application'
    message = f'{app.full_name} applied for {job.title} ({job.code or job.id}) via {app.source}.'
    link = f'/recruit/applications/{app.id}'
    for em in _recruiter_emails():
        try:
            create_notification(em, title, message, 'info', link)
        except Exception:
            pass
    extra = get_settings().get('notifyEmails') or []
    if extra:
        try:
            base = public_base()
            body = mailer.render_branded(
                title=title,
                intro=f'{e(app.full_name)} ({e(app.email)}) applied for <b>{e(job.title)}</b> via {e(app.source)}.',
                highlight_html=(f'<p><a href="{e(base + link)}">Open the application</a></p>' if base else ''),
                company=company)
            for em in extra:
                mailer.send_email(em, f'New application: {job.title}', html=body)
        except Exception:
            logger.exception('careers: recruiter email failed for %s', app_id)


def _run_side_effects(app_id):
    if not ASYNC_SIDE_EFFECTS:
        _after_apply(app_id)
        return

    def run():
        try:
            _after_apply(app_id)
        finally:
            from django.db import connection
            connection.close()
    threading.Thread(target=run, daemon=True, name='careers-apply-mail').start()


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def _disabled(request, s):
    return with_cors(_msg('The careers page is not available.', 404, 'CAREERS_DISABLED'), request, s)


def _origin_refused(request):
    return _msg('This website is not allowed to load these jobs.', 403, 'ORIGIN_NOT_ALLOWED')


@api_view(['GET', 'OPTIONS'])
def public_jobs(request):
    s = get_settings()
    st, _ = origin_status(request, s)
    if st == 'denied':
        return _origin_refused(request)
    if request.method == 'OPTIONS':
        return with_cors(Response(status=204), request, s)
    if not s['enabled']:
        return _disabled(request, s)
    qs = filter_jobs(request.query_params)
    total = qs.count()
    limit = min(max(_to_int(request.query_params.get('limit'), 50), 1), 100)
    offset = max(_to_int(request.query_params.get('offset'), 0), 0)
    resp = Response({
        'ok': True,
        'company': company_info(),
        'total': total,
        'jobs': [job_public(j, s) for j in qs[offset:offset + limit]],
        'facets': facets(),
        'privacyUrl': s.get('privacyUrl') or '',
    })
    resp['Cache-Control'] = 'public, max-age=60'
    return with_cors(resp, request, s)


@api_view(['GET', 'OPTIONS'])
def public_job_detail(request, ident):
    s = get_settings()
    st, _ = origin_status(request, s)
    if st == 'denied':
        return _origin_refused(request)
    if request.method == 'OPTIONS':
        return with_cors(Response(status=204), request, s)
    if not s['enabled']:
        return _disabled(request, s)
    job = find_public_job(ident)
    if not job:
        return with_cors(_msg('This job is no longer open.', 404, 'JOB_NOT_FOUND'), request, s)
    resp = Response({
        'ok': True,
        'company': company_info(),
        'job': job_public(job, s, full=True),
        'formToken': form_token(job.id),
        'privacyUrl': s.get('privacyUrl') or '',
        'maxResumeMb': RESUME_MAX_MB,
    })
    resp['Cache-Control'] = 'no-store'
    return with_cors(resp, request, s)


@api_view(['POST', 'OPTIONS'])
def public_apply(request):
    s = get_settings()
    st, origin = origin_status(request, s)
    if st == 'denied':
        return _origin_refused(request)

    def reply(r):
        r['Cache-Control'] = 'no-store'
        return with_cors(r, request, s)
    if request.method == 'OPTIONS':
        return reply(Response(status=204))
    if not s['enabled']:
        return _disabled(request, s)
    if _to_int(request.META.get('CONTENT_LENGTH'), 0) > MAX_BODY_BYTES:
        return reply(_msg('The application is too large. Resumes must be 5 MB or smaller.', 413, 'TOO_LARGE'))
    iph = ip_hash(request)
    if _attempt(iph):
        return reply(_msg('Too many attempts. Please try again in an hour.', 429, 'RATE_LIMITED'))
    try:
        body = request.data
    except Exception:
        return reply(_msg('Send the application as JSON.', 400, 'BAD_REQUEST'))
    if not isinstance(body, dict):
        return reply(_msg('Send the application as JSON.', 400, 'BAD_REQUEST'))

    # Honeypot: a field people never see. Bots fill every input.
    if str(body.get('website') or body.get('hp') or '').strip():
        return reply(_msg('Your application could not be submitted.', 400, 'SPAM_SUSPECTED'))

    job = find_public_job(body.get('jobId') or body.get('job'))
    if not job:
        return reply(_msg('This job is no longer open.', 404, 'JOB_NOT_FOUND'))

    tok = check_form_token(body.get('formToken'), job.id, s['minFillSeconds'])
    if tok == 'fast':
        return reply(_msg('That was quick! Please take a moment to review your application, then submit again.',
                          400, 'TOO_FAST'))
    if tok:
        return reply(_msg('This form has expired. Please reload the page and try again.', 400, 'FORM_EXPIRED'))

    since_hour = local_now() - timedelta(hours=1)
    if JobApplication.objects.filter(ip_hash=iph, created_at__gte=since_hour).count() >= s['rateLimitPerHour']:
        return reply(_msg('You have sent several applications in a short time. Please try again later.',
                          429, 'RATE_LIMITED'))

    clean, errors = validate_application(body, job_questions(job, s))
    if not _bool(body.get('consent')):
        errors['consent'] = 'Please agree to the privacy notice so we can process your application.'
    raw, mime, rname, rerr = check_resume(body.get('resume'))
    if rerr:
        errors['resume'] = rerr
    if errors:
        code = 'CONSENT_REQUIRED' if list(errors) == ['consent'] else 'VALIDATION_FAILED'
        first = next(iter(errors.values()))
        return reply(_msg(first if len(errors) == 1 else 'Please fix the highlighted fields.', 400, code,
                          errors=errors))

    sha = hashlib.sha256(raw).hexdigest()
    since = local_now() - timedelta(days=DUPLICATE_DAYS)
    dup = JobApplication.objects.filter(job=job, created_at__gte=since).filter(
        Q(email=clean['email']) | Q(resume_sha256=sha)).exclude(status='withdrawn').exists()
    if dup:
        return reply(_msg("You've already applied for this job. Our team will be in touch — there's no need to "
                          'apply again.', 409, 'ALREADY_APPLIED'))

    source = str(body.get('source') or 'careers').lower()
    if source not in ('careers', 'widget', 'referral'):
        source = 'careers'
    detail = urlsplit(origin).netloc if st == 'allowed' else _hostname(body.get('sourceDetail'))
    if st == 'allowed':
        source = 'widget' if source == 'careers' else source

    with transaction.atomic():
        app = JobApplication.objects.create(
            job=job, resume_name=rname, resume_mime=mime, resume_data=base64.b64encode(raw).decode('ascii'),
            resume_sha256=sha, source=source, source_detail=detail, status='new', consent=True, ip_hash=iph,
            **clean)
        JobPost.objects.filter(pk=job.pk).update(applicants=F('applicants') + 1)
        transaction.on_commit(lambda: _run_side_effects(app.id))
    return reply(Response({
        'ok': True, 'id': app.id, 'reference': f'APP-{app.id:06d}',
        'message': f'Thank you, {clean["full_name"].split(" ")[0]}! Your application for {job.title} has been received.',
        'email': clean['email'],
    }, status=201))


# ---------------------------------------------------------------------------
# resume parsing: pre-fill the apply form (nothing is stored)
# ---------------------------------------------------------------------------
PARSES_PER_HOUR = 20


def _parse_attempt(iph):
    """True when this IP hash has parsed too many resumes this hour."""
    key = 'careers:parse:' + iph[:32]
    try:
        n = cache.get(key)
        if n is None:
            cache.set(key, 1, 3600)
            return False
        return cache.incr(key) > PARSES_PER_HOUR
    except Exception:
        return False


@api_view(['POST', 'OPTIONS'])
def public_parse_resume(request):
    """Read contact details out of a resume so the form can pre-fill them.

    Same gates as applying (careers enabled, widget origin allowed, size cap,
    real PDF / DOCX by content) plus its own hourly rate limit. The file is
    parsed in memory and discarded: no row, no log of its contents."""
    s = get_settings()
    st, _origin = origin_status(request, s)
    if st == 'denied':
        return _origin_refused(request)

    def reply(r):
        r['Cache-Control'] = 'no-store'
        return with_cors(r, request, s)
    if request.method == 'OPTIONS':
        return reply(Response(status=204))
    if not s['enabled']:
        return _disabled(request, s)
    if _to_int(request.META.get('CONTENT_LENGTH'), 0) > MAX_BODY_BYTES:
        return reply(_msg('Resumes must be 5 MB or smaller.', 413, 'TOO_LARGE'))
    if _parse_attempt(ip_hash(request)):
        return reply(_msg('Too many resumes read from this network. Please fill the form in by hand.',
                          429, 'RATE_LIMITED'))
    try:
        body = request.data
    except Exception:
        body = None
    if not isinstance(body, dict):
        return reply(_msg('Send the resume as JSON.', 400, 'BAD_REQUEST'))
    raw, mime, _name, rerr = check_resume(body.get('resume'))
    if rerr:
        return reply(_msg(rerr, 400, 'BAD_RESUME', errors={'resume': rerr}))
    from .resume_parser import parse_resume_text
    text = extract_text(raw, mime)
    if not text.strip():
        return reply(Response({'ok': True, 'fields': {}, 'readable': False,
                               'message': "We couldn't read text from this file (it may be a scanned image). "
                                          'Please fill in your details.'}))
    fields = parse_resume_text(text)
    fields = {k: v for k, v in fields.items() if v not in ('', None, [])}
    return reply(Response({'ok': True, 'fields': fields, 'readable': True}))


# ---------------------------------------------------------------------------
# recruiter API
# ---------------------------------------------------------------------------
def _require(request, perm):
    from api.payroll_ext.security import require
    return require(request, perm)


def _can(user, perm):
    from api.payroll_ext.security import has_perm
    return has_perm(user, perm)


def _audit(action, app, request, email, changes=None, notes=''):
    from api.payroll_ext.security import audit
    audit(action, 'job_application', app.id, request=request, email=email, changes=changes or {}, notes=notes)


def app_row(a):
    return {
        'id': a.id,
        'reference': f'APP-{a.id:06d}',
        'jobId': a.job_id,
        'jobCode': a.job.code if a.job_id else '',
        'jobTitle': a.job.title if a.job_id else '',
        'fullName': a.full_name,
        'email': a.email,
        'phone': a.phone,
        'location': a.location,
        'source': a.source,
        'sourceDetail': a.source_detail,
        'status': a.status,
        'resumeName': a.resume_name,
        'hasResume': bool(a.resume_sha256),
        'resumeScoreId': a.resume_score_id,
        'createdAt': _iso(a.created_at),
        'updatedAt': _iso(a.updated_at),
    }


def _list_qs(params):
    qs = JobApplication.objects.select_related('job').defer('resume_data', 'cover_letter', 'answers')
    job = _to_int(params.get('job'), 0)
    if job:
        qs = qs.filter(job_id=job)
    src = str(params.get('source') or '').strip().lower()
    if src:
        qs = qs.filter(source=src)
    q = clean_text(params.get('q'), 100)
    if q:
        qs = qs.filter(Q(full_name__icontains=q) | Q(email__icontains=q) | Q(phone__icontains=q))
    for param, op in (('from', 'gte'), ('to', 'lte')):
        v = str(params.get(param) or '').strip()
        if v:
            try:
                d = datetime.strptime(v[:10], '%Y-%m-%d').date()
            except ValueError:
                continue
            qs = qs.filter(**{f'created_at__date__{op}': d})
    return qs


@api_view(['GET'])
def recruit_applications(request):
    email, user, err = _require(request, VIEW)
    if err:
        return err
    base = _list_qs(request.query_params)
    counts = {r['status']: r['n'] for r in base.values('status').annotate(n=Count('id'))}
    qs = base
    status = str(request.query_params.get('status') or '').strip().lower()
    if status == 'open':
        qs = qs.filter(status__in=OPEN_STATUSES)
    elif status:
        qs = qs.filter(status=status)
    total = qs.count()
    page = max(_to_int(request.query_params.get('page'), 1), 1)
    size = min(max(_to_int(request.query_params.get('pageSize'), 50), 1), 200)
    items = [app_row(a) for a in qs.order_by('-created_at', '-id')[(page - 1) * size: page * size]]
    return Response({'items': items, 'total': total, 'page': page, 'pageSize': size,
                     'counts': {k: counts.get(k, 0) for k in STATUSES}})


@api_view(['GET'])
def recruit_meta(request):
    email, user, err = _require(request, VIEW)
    if err:
        return err
    job_ids = set(JobApplication.objects.values_list('job_id', flat=True).distinct())
    jobs = JobPost.objects.filter(Q(status__iexact='Active') | Q(pk__in=job_ids)).order_by('title')
    return Response({
        'jobs': [{'id': j.id, 'code': j.code, 'title': j.title, 'status': j.status} for j in jobs],
        'statuses': STATUSES, 'sources': list(SOURCES), 'transitions': TRANSITIONS,
        'canEdit': _can(user, EDIT), 'canOnboard': _can(user, EDIT) and _can(user, 'onboarding.create'),
        'publicBase': public_base(request),
    })


def _history(app):
    try:
        from api.models import PayrollAuditLog
        rows = PayrollAuditLog.objects.filter(entity_type='job_application', entity_id=str(app.id)).order_by('-created_at')[:50]
        return [{'action': r.action, 'by': r.actor_email, 'at': _iso(r.created_at), 'changes': r.changes,
                 'note': r.notes} for r in rows]
    except Exception:
        return []


def app_detail(app, user=None):
    from api.models import OnboardingCandidate, ResumeScore
    d = app_row(app)
    d.update({
        'linkedinUrl': app.linkedin_url,
        'coverLetter': app.cover_letter,
        'answers': app.answers or {},
        'stageNote': app.stage_note,
        'reviewedBy': app.reviewed_by,
        'consent': app.consent,
        'resumeMime': app.resume_mime,
        'resumeSize': (len(app.resume_data) * 3) // 4 if app.resume_data else 0,
        'next': TRANSITIONS.get(app.status, []),
        'history': _history(app),
    })
    d['score'] = None
    if app.resume_score_id:
        rs = ResumeScore.objects.filter(pk=app.resume_score_id).defer('file_data', 'resume_text', 'jd_text').first()
        if rs:
            d['score'] = {'id': rs.id, 'score': rs.score, 'technical': rs.technical, 'experience': rs.experience,
                          'domain': rs.domain, 'gap': rs.gap or '', 'skills': rs.skills or [],
                          'missing': rs.missing or [], 'aiEvaluated': bool(getattr(rs, 'ai_evaluated', False))}
    oc = OnboardingCandidate.objects.filter(email__iexact=app.email, is_deleted=False).first()
    d['onboarding'] = {'id': oc.id, 'code': oc.candidate_code, 'status': oc.status} if oc else None
    d['confirmation'] = confirmation_status(app)
    return d


def _get_app(pk):
    return JobApplication.objects.select_related('job').filter(pk=pk).first()


@api_view(['GET', 'PATCH'])
def recruit_application_detail(request, pk):
    if request.method == 'GET':
        email, user, err = _require(request, VIEW)
        if err:
            return err
        app = _get_app(pk)
        if not app:
            return _msg('Application not found.', 404, 'NOT_FOUND')
        return Response(app_detail(app, user))

    email, user, err = _require(request, EDIT)
    if err:
        return err
    app = _get_app(pk)
    if not app:
        return _msg('Application not found.', 404, 'NOT_FOUND')
    body = request.data if isinstance(request.data, dict) else {}
    new = str(body.get('status') or '').strip().lower()
    note = clean_text(body.get('note'), 2000, multiline=True)[:2000]
    if new not in STATUSES:
        return _msg('Choose a valid status.', 400, 'INVALID_STATUS')
    if new not in TRANSITIONS.get(app.status, []):
        return _msg(f'An application in "{app.status}" cannot move to "{new}".', 400, 'INVALID_TRANSITION',
                    allowed=TRANSITIONS.get(app.status, []))
    if new == 'rejected' and len(note) < 3:
        return _msg('Add a short note explaining the rejection.', 400, 'NOTE_REQUIRED')
    old = app.status
    app.status = new
    if note:
        app.stage_note = note
    app.reviewed_by = email
    app.save(update_fields=['status', 'stage_note', 'reviewed_by', 'updated_at'])
    _audit('careers.status', app, request, email, {'from': old, 'to': new}, note)
    return Response(app_detail(app, user))


@api_view(['GET'])
def recruit_application_resume(request, pk):
    email, user, err = _require(request, VIEW)
    if err:
        return err
    app = _get_app(pk)
    if not app or not app.resume_data:
        return _msg('Resume not found.', 404, 'NOT_FOUND')
    try:
        raw = base64.b64decode(app.resume_data)
    except Exception:
        return _msg('The stored resume is unreadable.', 500, 'CORRUPT')
    _audit('careers.resume_download', app, request, email, {'file': app.resume_name})
    name = re.sub(r'[^\w.\- ()]+', '_', app.resume_name or 'resume')[:150]
    mime = app.resume_mime if app.resume_mime in RESUME_TYPES.values() else 'application/octet-stream'
    resp = HttpResponse(raw, content_type=mime)
    inline = request.query_params.get('inline') == '1' and mime == 'application/pdf'
    resp['Content-Disposition'] = ('inline' if inline else 'attachment') + f'; filename="{name}"'
    resp['X-Content-Type-Options'] = 'nosniff'
    resp['Cache-Control'] = 'no-store'
    resp['Content-Security-Policy'] = "default-src 'none'; sandbox"
    return resp


@api_view(['POST'])
def recruit_application_resend_confirmation(request, pk):
    """Send the applicant's confirmation email again (e.g. after fixing the
    mail settings). recruitment.edit; the outcome is recorded and returned."""
    email, user, err = _require(request, 'recruitment.edit')
    if err:
        return err
    app = _get_app(pk)
    if not app:
        return _msg('Application not found.', 404, 'NOT_FOUND')
    res = send_confirmation(app, actor=email)
    _audit('confirmation_resent', app, request, email, notes='sent' if res['ok'] else 'failed: ' + res['error'][:120])
    if not res['ok']:
        return _msg('The confirmation email could not be sent: ' + res['error'], 502, 'EMAIL_FAILED',
                    confirmation=confirmation_status(app))
    return Response({'ok': True, 'confirmation': confirmation_status(app)})


@api_view(['POST'])
def recruit_application_score(request, pk):
    """Score the resume against the job with the Resume Scoring engine
    (api.ai.score_resume_ai; keyword heuristic if the model is down) and save
    it as an api.ResumeScore row, like the Resume Scoring page does."""
    email, user, err = _require(request, EDIT)
    if err:
        return err
    app = _get_app(pk)
    if not app or not app.resume_data:
        return _msg('This application has no resume to score.', 404, 'NOT_FOUND')
    from api import ai
    from api.serializers import ResumeScoreSerializer
    from api.views import _save_resume
    raw = base64.b64decode(app.resume_data)
    text = extract_text(raw, app.resume_mime).strip()
    if len(text) < 20:
        return _msg('No readable text was found in this resume (it may be a scanned image).', 422, 'NO_TEXT')
    job = app.job
    try:
        result = ai.score_resume_ai(resume_text=text, jd_text=job.description or '', candidate_name=app.full_name,
                                    role=job.title)
    except ai.AIUnavailable as exc:
        return _msg(exc.message, 503, 'AI_UNAVAILABLE')
    except Exception as exc:
        logger.exception('careers: scoring failed for %s', pk)
        return _msg(f'Scoring failed: {exc}', 502, 'SCORING_FAILED')
    initials = ''.join(p[0] for p in app.full_name.split()[:2]).upper()[:10]
    payload = {
        'name': app.full_name, 'initials': initials, 'role': job.title,
        'score': _to_int(result.get('score')), 'technical': _to_int(result.get('technical')),
        'experience': _to_int(result.get('experience')), 'domain': _to_int(result.get('domain')),
        'gap': result.get('gap') or '', 'skills': result.get('skills') or [], 'missing': result.get('missing') or [],
        'source': 'Careers', 'fileName': app.resume_name, 'fileMime': app.resume_mime, 'fileData': app.resume_data,
        'resumeText': text, 'jdText': job.description or '', 'aiSummary': result.get('executiveSummary') or '',
        'aiStrengths': result.get('strengths') or [], 'aiGaps': result.get('redFlags') or [],
        'aiEvaluated': not result.get('aiFallback'), 'jobCode': job.code or '',
    }
    ser = ResumeScoreSerializer(data=payload)
    if not ser.is_valid():
        return _msg('The score could not be saved.', 400, 'SCORE_INVALID', errors=ser.errors)
    data, _created = _save_resume(ser)
    app.resume_score_id = data.get('id')
    app.save(update_fields=['resume_score_id', 'updated_at'])
    _audit('careers.score', app, request, email, {'score': payload['score'], 'resumeScoreId': app.resume_score_id})
    return Response(app_detail(app, user))


DEFAULT_REQUESTED_DOCS = [  # mirrors onboarding_views.candidates (a local constant there)
    {'type': 'ssn', 'label': 'SSN', 'required': True, 'sendToCandidate': True},
    {'type': 'driver_license', 'label': 'Driver License', 'required': False, 'sendToCandidate': True},
    {'type': 'state_id', 'label': 'State ID', 'required': False, 'sendToCandidate': False},
    {'type': 'visa', 'label': 'Visa (Work Authorization)', 'required': False, 'sendToCandidate': True},
    {'type': 'i94', 'label': 'I-94', 'required': False, 'sendToCandidate': True},
    {'type': 'passport', 'label': 'Passport', 'required': False, 'sendToCandidate': True},
]


@api_view(['POST'])
def recruit_application_onboard(request, pk):
    """Create the onboarding candidate for a hired applicant, with the same
    helpers onboarding_views.candidates uses (serializer, CAN-code sequence,
    stage seeding, activity log)."""
    email, user, err = _require(request, EDIT)
    if err:
        return err
    if not _can(user, 'onboarding.create'):
        return _msg("You don't have permission to do this. Required: onboarding.create", 403, 'PERMISSION_DENIED')
    app = _get_app(pk)
    if not app:
        return _msg('Application not found.', 404, 'NOT_FOUND')
    if app.status != 'hired':
        return _msg('Only hired applicants can be moved to onboarding.', 400, 'NOT_HIRED')
    from api import onboarding_views as ob
    from api.models import OnboardingCandidate
    from api.serializers import OnboardingCandidateSerializer
    existing = OnboardingCandidate.objects.filter(email__iexact=app.email, is_deleted=False).first()
    if existing:
        return _msg(f'{app.full_name} is already in onboarding ({existing.candidate_code}).', 409, 'ALREADY_ONBOARDING',
                    candidateId=existing.id, candidateCode=existing.candidate_code)
    parts = app.full_name.split(' ', 1)
    payload = {'firstName': parts[0][:120], 'lastName': (parts[1] if len(parts) > 1 else '')[:120],
               'email': app.email.lower(), 'phone': app.phone, 'jobTitle': app.job.title,
               'department': app.job.dept or '', 'workLocation': app.job.location or '', 'recruiter': email,
               'address': app.location or ''}
    ser = OnboardingCandidateSerializer(data=payload)
    if not ser.is_valid():
        return _msg('The onboarding candidate could not be created.', 400, 'INVALID', errors=ser.errors)
    with transaction.atomic():
        cand = ser.save(created_by=email, custom_fields={}, requested_docs=DEFAULT_REQUESTED_DOCS)
        if not cand.candidate_code:
            cand.candidate_code = ob._next_candidate_code()
            cand.save(update_fields=['candidate_code'])
        ob.seed_stages(cand)
        ob.set_stage(cand, 'candidate_created', 'Completed', email)
        ob.set_stage(cand, 'work_authorization', 'In Progress', email)
        ob.log_activity(cand, 'Candidate Created', email,
                        comments=f'From job application APP-{app.id:06d} ({app.job.title})',
                        new_value={'email': cand.email, 'status': cand.status})
    _audit('careers.onboard', app, request, email, {'candidateId': cand.id, 'candidateCode': cand.candidate_code})
    return Response({'ok': True, 'candidateId': cand.id, 'candidateCode': cand.candidate_code,
                     'link': '/onboarding', 'application': app_detail(app, user)}, status=201)


@api_view(['GET', 'PUT'])
def recruit_careers_settings(request):
    if request.method == 'GET':
        email, user, err = _require(request, VIEW)
    else:
        email, user, err = _require(request, EDIT)
    if err:
        return err
    if request.method == 'PUT':
        body = request.data if isinstance(request.data, dict) else {}
        before = get_settings()
        s = save_settings(body)
        changed = {k: s[k] for k in s if s.get(k) != before.get(k)}
        try:
            from api.payroll_ext.security import audit
            audit('careers.settings', 'careers_settings', 'careers', request=request, email=email, changes=changed)
        except Exception:
            pass
    else:
        s = get_settings()
    base = public_base(request)
    return Response({'settings': s, 'customFields': custom_field_options(), 'canEdit': _can(user, EDIT),
                     'urls': {'base': base, 'careers': base + '/careers', 'widget': base + '/careers/widget.js'}})
