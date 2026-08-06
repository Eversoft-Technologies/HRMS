"""
HRMS API views — a Django REST Framework port of the original Express server.

CRUD resources are implemented as DRF ``@api_view`` function views backed by
the serializers in ``serializers.py``. Request and response JSON shapes
(camelCase) match the Node API exactly so the existing React frontend works
unchanged.

A few helpers and endpoints are intentionally NOT DRF:
  * ``parse_body`` / ``err`` / ``make_initials`` / ``norm_email`` /
    ``app_user_dict`` are imported by ``auth_views`` and ``live_views`` and so
    are kept here.
  * ``recording_video`` handles a raw binary (video/webm) body, which DRF's
    JSON parser cannot consume, so it stays a plain ``csrf_exempt`` view.
  * ``spa_index`` serves the built React app for non-API routes.
"""
import hashlib
import json
import logging
import os
import re
import secrets
from datetime import datetime, time, timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import (
    BooleanField, Case, Count, IntegerField, OuterRef, Q, Subquery, Value, When,
)
from django.db.models.functions import Coalesce
from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt

from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import ai, mailer, social_poster
from .permissions import require_perm, require_admin, check_perm
from .timeutil import local_now, local_today
from .models import (
    AppUser,
    AttendanceEvent,
    Company,
    EmployeeAttendance,
    EmployeeTask,
    InterviewLink,
    InterviewRecording,
    JobPost,
    LeaveRequest,
    Module,
    Notification,
    Permission,
    PermissionGroup,
    QuestionSet,
    ResumeScore,
    Role,
    RolePermission,
    UserDocument,
    UserEmailConfig,
    UserProfile,
    WorkSubmission,
    Shift,
    ShiftAssignment,
    AttendanceCorrection,
    GeoFence,
    WfhRequest,
    WFHPolicy,
)
from .serializers import (
    DATETIME_FMT,
    AppUserSerializer,
    AttendanceEventSerializer,
    CompanySerializer,
    EmployeeAttendanceSerializer,
    EmployeeTaskSerializer,
    ModuleSerializer,
    NotificationSerializer,
    PermissionGroupSerializer,
    PermissionSerializer,
    RoleSerializer,
    InterviewLinkSerializer,
    InterviewRecordingSerializer,
    JobPostSerializer,
    LeaveRequestSerializer,
    QuestionSetSerializer,
    ResumeScoreSerializer,
    UserDocumentSerializer,
    UserEmailConfigSerializer,
    UserProfileSerializer,
    WorkSubmissionSerializer,
    ShiftSerializer,
    ShiftAssignmentSerializer,
    AttendanceCorrectionSerializer,
    GeoFenceSerializer,
    WfhRequestSerializer,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_body(request):
    try:
        return json.loads((request.body or b'{}').decode('utf-8') or '{}')
    except (ValueError, UnicodeDecodeError):
        return {}


def err(message, status=400):
    return JsonResponse({'message': message}, status=status)


def serializer_err(serializer, status=400):
    """Flatten DRF validation errors into the API's ``{'message': ...}`` shape."""
    msgs = []
    for field, errs in serializer.errors.items():
        first = errs[0] if isinstance(errs, (list, tuple)) and errs else errs
        msgs.append(f'{field}: {first}')
    return err('; '.join(msgs) or 'Invalid data', status)


def make_initials(name):
    parts = [p for p in re.split(r'\s+', (name or '').strip()) if p]
    return ''.join(p[0] for p in parts).upper()[:2]


def norm_email(value):
    return str(value or '').strip().lower()


def dt(value):
    return value.strftime('%Y-%m-%d %H:%M:%S') if value else None


def safe_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except ValueError:
            return []
    return []


def safe_json(value):
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        return None


def to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _resolve_recipient_email(request, fallback=None):
    email = norm_email(
        request.META.get('HTTP_X_USER_EMAIL')
        or request.META.get('HTTP_X_ACTOR_EMAIL')
        or ''
    )
    if not email:
        try:
            email = norm_email(request.GET.get('email') or request.data.get('email') or '')
        except Exception:
            email = ''
    if not email and fallback:
        email = norm_email(fallback)
    return email


def create_notification(recipient, title, message, notification_type='info', link=''):
    email = norm_email(recipient)
    if not email:
        return None
    return Notification.objects.create(
        recipient=email,
        title=title,
        message=message,
        notification_type=notification_type,
        link=link,
    )


def notify_approvers(perm_code, title, message, link=''):
    from .permissions import _is_super_admin, _user_has_perm, _resolve_role
    active_users = AppUser.objects.filter(status='active')
    for user in active_users:
        is_approver = False
        if _is_super_admin(user):
            is_approver = True
        elif _user_has_perm(user, perm_code):
            is_approver = True
        else:
            role = _resolve_role(user)
            role_name = (role.name or '').lower() if role else ''
            legacy_role = (user.role or '').lower()
            if 'hr' in legacy_role or 'admin' in legacy_role or 'hr' in role_name or 'manager' in role_name:
                is_approver = True
        
        if is_approver:
            create_notification(user.email, title, message, 'info', link)


# ---------------------------------------------------------------------------
# app_user_dict — kept for auth_views (which imports it). Mirrors
# AppUserSerializer's output exactly.
# ---------------------------------------------------------------------------
def app_user_dict(o):
    return {
        'id': o.id, 'name': o.full_name, 'email': o.email,
        'password': o.password, 'initials': o.initials,
        'role': o.role, 'status': o.status,
        'authProvider': o.auth_provider,
        'profilePic': o.profile_pic or '',
        'createdAt': dt(o.created_at),
    }


def resolve_color(type_value):
    v = str(type_value or '').lower()
    if 'contract' in v:
        return 'purple'
    if 'intern' in v:
        return 'orange'
    if 'part' in v:
        return 'green'
    return 'blue'


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'recruitment.view', 'POST': 'recruitment.create'})
def jobs(request):
    if request.method == 'GET':
        qs = JobPost.objects.all()
        # Optional query-param filters
        status = request.query_params.get('status')
        priority = request.query_params.get('priority')
        dept = request.query_params.get('dept')
        job_type = request.query_params.get('type')
        remote = request.query_params.get('remote')
        search = request.query_params.get('search')
        if status:
            qs = qs.filter(status=status)
        if priority:
            qs = qs.filter(priority=priority)
        if dept:
            qs = qs.filter(dept__icontains=dept)
        if job_type:
            qs = qs.filter(type=job_type)
        if remote and remote.lower() in ('true', '1'):
            qs = qs.filter(is_remote=True)
        if search:
            qs = qs.filter(Q(title__icontains=search) | Q(dept__icontains=search))
        return Response(JobPostSerializer(qs, many=True).data)

    body = request.data
    if not body.get('title') or not body.get('dept'):
        return err('title and dept are required')
    serializer = JobPostSerializer(data=body)
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    payload = serializer.data
    # Auto-post to the creator's linked social accounts (LinkedIn / X).
    # Non-fatal: a job is still created even if posting fails or isn't set up.
    if body.get('autoPost') is not False:
        # customFields aren't on the serializer output but the draft builder
        # uses them (skills, experience), so carry them through.
        draft_source = dict(payload)
        draft_source.setdefault('customFields', body.get('customFields') or {})
        payload['socialResults'] = _auto_post_job(
            draft_source, body.get('userEmail'), body.get('linkedinMessage'))
    return Response(payload, status=201)


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
@require_perm({'GET': 'recruitment.view', 'PATCH': 'recruitment.edit',
               'PUT': 'recruitment.edit', 'DELETE': 'recruitment.delete'})
def job_detail(request, pk):
    """Read / update / delete a single job. Used by the Job Board's inline
    status editor (PATCH {status, statusComment})."""
    job = JobPost.objects.filter(pk=pk).first()
    if not job:
        return err('Job not found', 404)
    if request.method == 'GET':
        return Response(JobPostSerializer(job).data)
    if request.method == 'DELETE':
        job.delete()
        return Response({'ok': True})

    data = request.data or {}
    text_fields = ['title', 'dept', 'location', 'type', 'salary', 'status', 'priority', 'description']
    changed = False
    for f in text_fields:
        if f in data:
            setattr(job, f, data[f] if data[f] is not None else '')
            changed = True
    if 'openings' in data:
        try:
            job.openings = max(1, int(data['openings']))
        except (TypeError, ValueError):
            pass
        changed = True
    if 'remote' in data:
        job.is_remote = bool(data['remote'])
        changed = True
    if 'statusComment' in data:
        job.status_comment = data['statusComment'] or ''
        changed = True
    if changed:
        job.save()
    return Response(JobPostSerializer(job).data)


def html_to_text(html):
    """Readable plain-text alternative for an HTML email body.

    The rich-text editor emits block tags (<div>, <p>, <li>), so stripping tags
    alone would run every line together in clients that show the text part.
    """
    if not html:
        return ''
    text = re.sub(r'(?i)<br\s*/?>', '\n', html)
    text = re.sub(r'(?i)</(div|p|li|tr|h[1-6])>', '\n', text)
    text = re.sub(r'(?i)<li[^>]*>', '• ', text)
    text = re.sub(r'<[^>]+>', '', text)
    for entity, char in (('&nbsp;', ' '), ('&amp;', '&'), ('&lt;', '<'),
                         ('&gt;', '>'), ('&quot;', '"'), ('&#39;', "'")):
        text = text.replace(entity, char)
    text = re.sub(r'[ \t]+\n', '\n', text)
    return re.sub(r'\n{3,}', '\n\n', text).strip()


def poster_contact(email):
    """Contact details for the closing block of a job announcement: the
    recruiter's own email plus the phone from their HRMS profile."""
    email = norm_email(email)
    if not email:
        return {}
    profile = UserProfile.objects.filter(email=email).first()
    user = AppUser.objects.filter(email=email).first()
    name = ''
    if profile:
        name = ' '.join(x for x in [profile.first_name, profile.last_name] if x).strip()
    if not name and user:
        name = user.full_name or ''
    return {
        'email': email,
        'phone': (profile.phone if profile else '') or '',
        'name': name,
    }


def _auto_post_job(job_payload, user_email=None, message=None):
    """Post the job to the creator's OWN linked social accounts.

    Never falls back to another user's credentials: a job must only ever appear
    on the profile of the person who created it. When the creator has nothing
    linked we return an explanatory skip result rather than an empty list, so
    the UI can tell them why nothing was posted.

    `message` is the text approved in the preview dialog; without it a fresh
    draft is built.
    """
    email = norm_email(user_email)
    if not email:
        return [{'platform': 'linkedin', 'ok': False, 'skipped': True,
                 'error': 'Could not identify the job creator, so nothing was posted.'}]

    cfg = UserEmailConfig.objects.filter(pk=email).first()
    social = safe_json(cfg.social) if cfg else None
    if not isinstance(social, dict) or not social:
        return [{'platform': 'linkedin', 'ok': False, 'skipped': True,
                 'error': 'No LinkedIn account connected. Connect yours in '
                          'Settings → Email Configuration.'}]
    try:
        return social_poster.post_job(job_payload, social, message=message,
                                      contact=poster_contact(email))
    except Exception as e:  # noqa: BLE001 - never break job creation on a posting error
        logger.warning('Social auto-post failed for %s: %s', email, e)
        return [{'platform': 'all', 'ok': False, 'error': str(e)}]


# ---------------------------------------------------------------------------
# Interviews
# ---------------------------------------------------------------------------
# Default duration (hours) from creation time before interview link expires
INTERVIEW_LINK_EXPIRY_HOURS = 24


def _generate_interview_tokens(interview_date_str, interview_time_str):
    """Generate unique candidate + recruiter access tokens and compute expiry.

    The link stays valid for 24 hours from creation (now), ensuring candidates
    can access it anytime within that window.
    """
    candidate_token = secrets.token_urlsafe(32)
    recruiter_token = secrets.token_urlsafe(32)

    # Expiry is 24 hours from now, so links don't expire prematurely
    # regardless of when the interview is scheduled.
    expiry = local_now() + timedelta(hours=INTERVIEW_LINK_EXPIRY_HOURS)

    return candidate_token, recruiter_token, expiry


def _public_origin(request, body=None):
    """Base URL the candidate's link must point at.

    The request host is whatever the *recruiter's* browser hit — often
    localhost — which produces a link no candidate can open. PUBLIC_BASE_URL
    overrides it for real deployments.
    """
    explicit = (body or {}).get('origin')
    if explicit:
        return str(explicit).rstrip('/')
    configured = os.environ.get('PUBLIC_BASE_URL', '').strip()
    if configured:
        return configured.rstrip('/')
    return _request_origin_from_meta(request)


def _send_interview_invitation(obj, origin, sender_email=None):
    """Email the candidate their single-use, tokenized interview link.

    Returns mailer's ``{'ok': bool, 'error': str}`` — callers decide whether a
    delivery failure should fail their request.
    """
    if not obj.email:
        return {'ok': False, 'error': 'Candidate has no email address'}

    candidate_url = f'{origin}/interview-access?token={obj.candidate_token}'

    when = ' at '.join(p for p in (obj.interview_date, obj.interview_time) if p) or 'To be confirmed'
    types = obj.interview_type
    if isinstance(types, (list, tuple)):
        types = ', '.join(str(t) for t in types)

    html = mailer.render_branded(
        greeting=obj.name,
        title='',
        intro=(
            f'We are pleased to inform you that your interview for the position of '
            f'<strong>{obj.role}</strong> at <strong>{mailer.BRAND_SHORT}</strong> has been '
            f'successfully scheduled. Please review the details below and make a note of the '
            f'date, time, and platform.'
        ),
        highlight_html=(
            mailer.render_details_card('Interview Details', [
                ('Position', obj.role),
                ('Interview Type', types),
                ('Interviewer', obj.interviewer or '—'),
                ('Date &amp; Time', when),
                ('Duration', obj.duration),
                ('Platform', obj.platform or 'To be confirmed'),
            ])
            + mailer.render_cta(candidate_url, 'Join Interview')
        ),
        footer=(
            'Please ensure you join the meeting at least <strong>5 minutes early</strong>. '
            'This link is valid for 24 hours and can only be used once. Should you need to '
            'reschedule or have any questions, please contact your recruiter.'
        ),
        logo_url=f'{origin}/logo.jpg',
    )
    text = (
        f'Hi {obj.name},\n\nYour interview for {obj.role} is scheduled on '
        f'{obj.interview_date} at {obj.interview_time}.\n\n'
        f'Join here: {candidate_url}\n\n'
        f'This link expires in 24 hours and can only be used once. '
        f'If you cannot join by then, contact your recruiter for a new link.'
    )
    return mailer.send_email(
        to=obj.email,
        subject=f'Interview Invitation — {obj.role}',
        html=html,
        text=text,
        sender_email=sender_email,
    )


@api_view(['GET', 'POST'])
@require_perm({'GET': 'recruitment.view', 'POST': 'recruitment.create'})
def interviews(request):
    if request.method == 'GET':
        # Newest first: the candidate portal matches an interview by email with
        # Array.find(), so the most recent row for a candidate must come first —
        # otherwise a stale older interview (with an old createdAt) is picked and
        # the link is wrongly shown as expired.
        qs = InterviewLink.objects.all().order_by('-id')
        return Response(InterviewLinkSerializer(qs, many=True).data)

    body = request.data
    name = body.get('name')
    email = body.get('email')
    role = body.get('role')
    interview_date = body.get('interviewDate')
    time = body.get('time')
    if not all([name, email, role, interview_date, time]):
        return err('name, email, role, interviewDate and time are required')

    serializer = InterviewLinkSerializer(data=body)
    if not serializer.is_valid():
        return serializer_err(serializer)
    c_token, r_token, expiry = _generate_interview_tokens(interview_date, time)
    serializer.save(candidate_token=c_token, recruiter_token=r_token, link_expires_at=expiry)
    obj = serializer.instance

    # Deliver the tokenized link server-side. A mail failure must not discard an
    # interview the recruiter already scheduled, so this is best-effort and the
    # outcome is reported back instead of raised.
    mail = _send_interview_invitation(
        obj, _public_origin(request, body), body.get('senderEmail')
    )
    if mail.get('ok'):
        obj.email_sent = True
        obj.save(update_fields=['email_sent'])

    if email:
        create_notification(
            email,
            'Interview scheduled',
            f"Your interview for {role or 'the role'} has been scheduled for {interview_date} at {time}.",
            'info',
            '/recruit/interview',
        )

    data = InterviewLinkSerializer(obj).data
    data['emailSent'] = bool(mail.get('ok'))
    if not mail.get('ok'):
        data['emailError'] = mail.get('error', 'unknown error')
    return Response(data, status=201)


@api_view(['PUT', 'PATCH'])
@require_perm('recruitment.edit')
def interview_detail(request, pk):
    obj = InterviewLink.objects.filter(pk=pk).first()
    if not obj:
        return err('Interview not found', 404)
    serializer = InterviewLinkSerializer(obj, data=request.data, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    return Response(serializer.data)


@api_view(['POST'])
def interview_note(request, pk):
    """Set/update a candidate's note. Intentionally ungated so ANY signed-in
    user can collaborate on the note; records who last edited it (name + email +
    timestamp) so the editor can show "last modified by"."""
    obj = InterviewLink.objects.filter(pk=pk).first()
    if not obj:
        return err('Interview not found', 404)
    body = request.data
    notes = body.get('notes')
    if notes is None:
        return err('notes is required')
    email = norm_email(body.get('email') or request.META.get('HTTP_X_USER_EMAIL') or '')
    name = str(body.get('name') or body.get('employee') or '').strip()
    obj.notes = notes
    obj.notes_updated_by = name or (email.split('@')[0] if email else '')
    obj.notes_updated_by_email = email
    obj.notes_updated_at = local_now()
    obj.save()
    return Response(InterviewLinkSerializer(obj).data)


@api_view(['POST'])
@require_perm('recruitment.edit')
def interviews_bulk_send_emails(request):
    """Send emails to multiple candidates (mark email_sent=True for their interviews)."""
    body = request.data
    interview_ids = body.get('interviewIds', [])
    if not isinstance(interview_ids, list) or len(interview_ids) == 0:
        return err('interviewIds array is required')

    qs = InterviewLink.objects.filter(id__in=interview_ids)
    if not qs.exists():
        return err('No interviews found with the provided IDs', 404)

    origin = _public_origin(request, body)
    sender_email = body.get('senderEmail')
    sent, failed = [], []
    for obj in qs:
        result = _send_interview_invitation(obj, origin, sender_email)
        if result.get('ok'):
            obj.email_sent = True
            obj.save(update_fields=['email_sent'])
            sent.append(obj.id)
        else:
            failed.append({'id': obj.id, 'email': obj.email,
                           'error': result.get('error', 'unknown error')})

    message = f'Emails sent to {len(sent)} candidate(s)'
    if failed:
        message += f'; {len(failed)} failed'

    return JsonResponse({
        'ok': not failed,
        'message': message,
        'count': len(sent),
        'failed': failed,
        'interviews': InterviewLinkSerializer(
            InterviewLink.objects.filter(id__in=interview_ids), many=True).data,
    }, status=200)


# ---------------------------------------------------------------------------
# Follow-up emails (Selected / Waitlisted / Rejected) — sent server-side
# ---------------------------------------------------------------------------
def render_placeholders(text, ctx):
    """Replace {{key}} (any inner spacing) with values from ctx.

    Applied on both the preview and the send path so a placeholder typed by
    hand resolves the same way in each.
    """
    if not text:
        return ''
    return re.sub(r'\{\{\s*([a-zA-Z_]+)\s*\}\}',
                  lambda m: str(ctx.get(m.group(1).strip().lower(), m.group(0))),
                  text)


def build_followup_html(subject, inner):
    """The exact HTML a candidate receives for a follow-up email.

    Both the preview endpoint and the send path call this, so what a recruiter
    sees in the preview is byte-for-byte what goes out.

    A body that is already a complete HTML document is sent verbatim — that is
    how a hand-written HTML template stays intact instead of being nested
    inside the branded wrapper.
    """
    inner = inner or ''
    head = inner.lstrip()[:200].lower()
    if head.startswith('<!doctype') or head.startswith('<html'):
        return inner
    return mailer.render_branded(
        title=subject,
        intro='',
        highlight_html=f'<div style="font-size:15px;line-height:1.7;color:#334155;">{inner}</div>',
    )


def _followup_template(outcome, name, role, start_phrase='the first week of next month'):
    role = role or 'the role'
    name = name or 'there'
    o = str(outcome or '').strip().lower()
    if o == 'selected':
        subject = f'Congratulations! Offer for {role} at Eversoft'
        body = (
            f'Dear {name},<br><br>'
            f'We are delighted to let you know that you have been <strong>selected</strong> for the '
            f'<strong>{role}</strong> position at Eversoft. The whole panel was impressed by your '
            f'performance during the interview.<br><br>'
            f'Our HR team will reach out shortly with your offer details and onboarding steps. '
            f'We are looking forward to having you join us, with a tentative start in {start_phrase}.<br><br>'
            f'Warm regards,<br>The Eversoft Talent Team'
        )
    elif o == 'waitlisted':
        subject = f'Your application for {role} at Eversoft'
        body = (
            f'Dear {name},<br><br>'
            f'Thank you for interviewing for the <strong>{role}</strong> position. You did really well, '
            f'and we have placed your application on our <strong>waitlist</strong>. Should a suitable '
            f'opening become available, we will be in touch right away.<br><br>'
            f'We genuinely appreciate the time and energy you invested in the process.<br><br>'
            f'Warm regards,<br>The Eversoft Talent Team'
        )
    else:  # rejected / default
        subject = f'Update on your application for {role} at Eversoft'
        body = (
            f'Dear {name},<br><br>'
            f'Thank you for taking the time to interview for the <strong>{role}</strong> position and for '
            f'your interest in Eversoft. After careful consideration, we have decided not to move forward '
            f'with your application at this time.<br><br>'
            f'This was a difficult decision — we encourage you to apply for future roles that match your '
            f'skills. We wish you the very best in your job search.<br><br>'
            f'Warm regards,<br>The Eversoft Talent Team'
        )
    return subject, body


@api_view(['POST'])
@require_perm('recruitment.edit')
def interview_send_followup(request):
    """Send a single follow-up email server-side (via the configured SMTP) and
    record the outcome on the interview row. Body:
        {interviewId, outcome}                      (looks up name/email/role)
      or {toEmail, toName, role, outcome}           (explicit)
      optional: senderEmail (whose SMTP to send from), subject, body
    """
    body = request.data
    outcome = body.get('outcome')
    obj = None
    interview_id = body.get('interviewId')
    if interview_id:
        obj = InterviewLink.objects.filter(pk=interview_id).first()
        if not obj:
            return err('Interview not found', 404)

    to_email = body.get('toEmail') or (obj.email if obj else None)
    to_name = body.get('toName') or (obj.name if obj else None)
    role = body.get('role') or (obj.role if obj else None)
    if not to_email:
        return err('toEmail (or a valid interviewId) is required')
    if not outcome:
        return err('outcome is required (Selected | Waitlisted | Rejected)')

    subject = body.get('subject')
    inner = body.get('body')
    if not subject or not inner:
        subject, inner = _followup_template(outcome, to_name, role)

    # Resolve any {{name}} / {{role}} still present, exactly as the preview
    # endpoint does — otherwise a hand-typed placeholder would preview
    # correctly but reach the candidate literally.
    ctx = {'name': to_name or 'there', 'role': role or 'the role',
           'company': 'Eversoft', 'outcome': outcome or ''}
    subject = render_placeholders(subject, ctx)
    inner = render_placeholders(inner, ctx)

    html = build_followup_html(subject, inner)
    result = mailer.send_email(
        to=to_email, subject=subject, html=html,
        text=html_to_text(inner),
        sender_email=body.get('senderEmail'),
    )
    if not result.get('ok'):
        return err('Could not send the follow-up email: ' + result.get('error', 'unknown error'), 502)

    if obj:
        obj.outcome = outcome
        obj.email_sent = True
        obj.save(update_fields=['outcome', 'email_sent'])
    if to_email:
        create_notification(
            to_email,
            'Interview update',
            f"Your interview follow-up for {role or 'the role'} has been sent: {outcome}.",
            'info',
            '/recruit/interview',
        )
    return Response({'ok': True, 'message': f'Follow-up sent to {to_name or to_email}.'})


# ---------------------------------------------------------------------------
# Interview token verification & link management
# ---------------------------------------------------------------------------
def _interview_already_taken(obj):
    """True once the candidate has actually sat the interview.

    ``completed_at`` is the only marker, because it is written in exactly one
    place — when a recording is saved. ``status`` used to count too, but it is a
    workflow label a recruiter can set by hand or in bulk, and doing so locked
    real candidates out of interviews they had never taken: they saw "Interview
    Already Completed" with no date, because ``completed_at`` was null.
    """
    return obj.completed_at is not None


@api_view(['POST'])
def interview_verify_token(request):
    """Verify a candidate or recruiter interview access token.

    POST /api/interviews/verify-token
    Body: {token: "<candidate_token or recruiter_token>"}

    Returns the interview details and whether the link is still valid.
    """
    body = request.data
    token = str(body.get('token') or '').strip()
    if not token:
        return err('token is required')

    # Determine token type (candidate or recruiter)
    obj = InterviewLink.objects.filter(candidate_token=token).first()
    token_type = 'candidate'
    if not obj:
        obj = InterviewLink.objects.filter(recruiter_token=token).first()
        token_type = 'recruiter'

    if not obj:
        return JsonResponse({'valid': False, 'reason': 'Token not found'}, status=404)

    now = local_now()

    # An interview may only be taken once. The recruiter link stays usable so
    # the interview can still be reviewed after the candidate is done.
    if token_type == 'candidate' and _interview_already_taken(obj):
        return JsonResponse({
            'valid': False,
            'reason': 'You have already completed this interview',
            'completedAt': dt(obj.completed_at),
            'interviewId': obj.id,
        })

    # Check expiry
    if obj.link_expires_at and now > obj.link_expires_at:
        # Auto-update status to Expired
        if obj.status not in ('Completed', 'Expired'):
            obj.status = 'Expired'
            obj.save(update_fields=['status'])
        return JsonResponse({
            'valid': False,
            'reason': 'Interview link has expired',
            'expiredAt': dt(obj.link_expires_at),
            'interviewId': obj.id,
        })

    # Mark as Active when first accessed
    if obj.status == 'Scheduled':
        obj.status = 'Active'
        obj.save(update_fields=['status'])

    data = InterviewLinkSerializer(obj).data
    data['tokenType'] = token_type
    data['valid'] = True
    return Response(data)


@api_view(['POST'])
def interview_complete(request):
    """Mark an interview as taken so the candidate link cannot be reused.

    POST /api/interviews/complete
    Body: {token: "<candidate_token>"}

    Public (the candidate is not signed in) — the candidate token is the
    credential. Idempotent: a repeat call reports the original completion.
    """
    token = str(request.data.get('token') or '').strip()
    if not token:
        return err('token is required')

    obj = InterviewLink.objects.filter(candidate_token=token).first()
    if not obj:
        return err('Interview not found', 404)

    if _interview_already_taken(obj):
        return Response({
            'ok': True,
            'alreadyCompleted': True,
            'completedAt': dt(obj.completed_at),
            'interviewId': obj.id,
        })

    obj.completed_at = local_now()
    obj.status = 'Completed'
    obj.save(update_fields=['completed_at', 'status'])
    return Response({
        'ok': True,
        'alreadyCompleted': False,
        'completedAt': dt(obj.completed_at),
        'interviewId': obj.id,
    })


@api_view(['POST'])
@require_perm('recruitment.edit')
def interview_regenerate_link(request, pk):
    """Regenerate candidate and recruiter tokens for an interview.

    POST /api/interviews/<id>/regenerate-link
    Body: {extendHours: 48}  (optional, default=24)
    """
    obj = InterviewLink.objects.filter(pk=pk).first()
    if not obj:
        return err('Interview not found', 404)

    body = request.data
    extend_hours = int(body.get('extendHours') or INTERVIEW_LINK_EXPIRY_HOURS)

    c_token = secrets.token_urlsafe(32)
    r_token = secrets.token_urlsafe(32)
    # Extend from interview date if available, otherwise from now
    *_, new_expiry = _generate_interview_tokens(
        obj.interview_date or '', obj.interview_time or ''
    )
    # Allow explicit override
    if body.get('extendHours'):
        new_expiry = local_now() + timedelta(hours=extend_hours)

    obj.candidate_token = c_token
    obj.recruiter_token = r_token
    obj.link_expires_at = new_expiry
    # Minting a fresh candidate token is the "let them sit it again" action, so
    # release the single-use latch or the new link would refuse on arrival.
    obj.completed_at = None
    if obj.status in ('Expired', 'Completed'):
        obj.status = 'Scheduled'
    obj.save(update_fields=[
        'candidate_token', 'recruiter_token', 'link_expires_at', 'completed_at', 'status',
    ])

    return Response({
        'ok': True,
        'candidateToken': c_token,
        'recruiterToken': r_token,
        'linkExpiresAt': dt(new_expiry),
        'message': 'Interview links regenerated successfully.',
    })


@api_view(['POST'])
@require_perm('recruitment.edit')
def interview_resend_invitation(request, pk):
    """Resend the interview invitation email to the candidate.

    POST /api/interviews/<id>/resend-invitation
    Body: {senderEmail, origin}  (optional)
    """
    obj = InterviewLink.objects.filter(pk=pk).first()
    if not obj:
        return err('Interview not found', 404)

    body = request.data
    origin = _public_origin(request, body)

    # Regenerate tokens before resending so the new link is fresh
    c_token = secrets.token_urlsafe(32)
    r_token = secrets.token_urlsafe(32)
    *_, new_expiry = _generate_interview_tokens(
        obj.interview_date or '', obj.interview_time or ''
    )
    obj.candidate_token = c_token
    obj.recruiter_token = r_token
    obj.link_expires_at = new_expiry
    obj.email_sent = False
    # See interview_regenerate_link: a fresh candidate token must not be
    # refused by the single-use latch left behind by an earlier sitting.
    obj.completed_at = None
    if obj.status in ('Expired', 'Completed'):
        obj.status = 'Scheduled'
    obj.save(update_fields=[
        'candidate_token', 'recruiter_token', 'link_expires_at', 'email_sent',
        'completed_at', 'status',
    ])

    recruiter_url = f'{origin}/interview-access?token={r_token}'

    result = _send_interview_invitation(obj, origin, body.get('senderEmail'))
    if not result.get('ok'):
        return err('Could not send invitation: ' + result.get('error', 'unknown error'), 502)

    obj.email_sent = True
    obj.save(update_fields=['email_sent'])

    if obj.email:
        create_notification(
            obj.email,
            'Interview invitation resent',
            'A fresh interview invitation link has been sent to you.',
            'info',
            '/recruit/interview',
        )

    return Response({
        'ok': True,
        'message': f'Invitation resent to {obj.email}.',
        'candidateToken': c_token,
        'recruiterToken': r_token,
        'recruiterUrl': recruiter_url,
    })


def _request_origin_from_meta(request):
    scheme = 'https' if request.is_secure() else request.scheme
    host = request.get_host()
    return f'{scheme}://{host}'


# ---------------------------------------------------------------------------
# Resume Scores
# ---------------------------------------------------------------------------
# Minimum qualifying score; resumes below this are not stored in the DB.
RESUME_SCORE_MIN = 75


def resume_content_hash(resume_text, file_data=''):
    """A stable fingerprint of a resume's content, for de-duplication.

    Prefers the normalised extracted text (whitespace-collapsed, lower-cased) so
    the same resume uploaded twice — or re-scored against a new JD — fingerprints
    identically. Falls back to the file bytes when there is no text, and returns
    '' when there is nothing to fingerprint (so blank rows never collide).
    """
    text = (resume_text or '').strip()
    if text:
        norm = re.sub(r'\s+', ' ', text).lower()
        return hashlib.sha256(norm.encode('utf-8')).hexdigest()
    if file_data:
        return hashlib.sha256(file_data.encode('utf-8')).hexdigest()
    return ''


def _below_threshold_response(score_val):
    # A non-2xx status so the frontend treats it as "not saved" (it only appends
    # a row on a 2xx record response).
    return Response(
        {
            'stored': False,
            'score': score_val,
            'threshold': RESUME_SCORE_MIN,
            'message': f'Score {score_val} is below the minimum of {RESUME_SCORE_MIN}; not stored.',
        },
        status=422,
    )


def _save_resume(serializer):
    """Persist one validated resume, de-duplicating by content fingerprint.

    Returns ``(data, created)``. If a resume with the same fingerprint already
    exists, its single row is updated in place (latest score/JD/file win) rather
    than inserting a duplicate.
    """
    vd = serializer.validated_data
    h = resume_content_hash(vd.get('resume_text'), vd.get('file_data'))
    existing = ResumeScore.objects.filter(content_hash=h).first() if h else None
    if existing:
        for field, val in vd.items():
            setattr(existing, field, val)
        existing.content_hash = h
        existing.save()
        return ResumeScoreSerializer(existing).data, False
    obj = serializer.save(content_hash=h)
    return ResumeScoreSerializer(obj).data, True


@api_view(['GET', 'POST'])
@require_perm({'GET': 'recruitment.view', 'POST': 'recruitment.create'})
def resume_scores(request):
    if request.method == 'GET':
        return Response(ResumeScoreSerializer(ResumeScore.objects.all(), many=True).data)

    body = request.data
    if isinstance(body, list):
        if len(body) == 0:
            return err('resume upload array is required')
        results = []
        for item in body:
            if not item.get('name') and item.get('fileName'):
                item['name'] = os.path.splitext(item.get('fileName'))[0]
            serializer = ResumeScoreSerializer(data=item)
            if not serializer.is_valid():
                return serializer_err(serializer)
            score_val = int(serializer.validated_data.get('score') or 0)
            if score_val < RESUME_SCORE_MIN:
                return _below_threshold_response(score_val)
            data, _created = _save_resume(serializer)
            results.append(data)
        return Response(results, status=201)

    if not body.get('name') and body.get('fileName'):
        body['name'] = os.path.splitext(body.get('fileName'))[0]
    if not body.get('name'):
        return err('name is required')
    serializer = ResumeScoreSerializer(data=body)
    if not serializer.is_valid():
        return serializer_err(serializer)

    # Only persist resumes that meet the qualifying score threshold.
    try:
        score_val = int(serializer.validated_data.get('score') or 0)
    except (TypeError, ValueError):
        score_val = 0
    if score_val < RESUME_SCORE_MIN:
        return _below_threshold_response(score_val)

    data, created = _save_resume(serializer)
    # 200 when we updated an existing (deduped) row, 201 when newly created; both
    # return the record, so the frontend appends/replaces it by id either way.
    return Response(data, status=201 if created else 200)


@api_view(['GET'])
@require_perm('recruitment.view')
def resume_score_detail(request, pk):
    """A single resume including its stored file — kept out of the list endpoint
    so the base64 blob is fetched only when actually viewing/downloading."""
    rs = ResumeScore.objects.filter(pk=pk).first()
    if not rs:
        return err('Resume not found', 404)
    return Response({
        'id': rs.id,
        'name': rs.name,
        'fileName': rs.file_name or '',
        'fileMime': rs.file_mime or '',
        'fileData': rs.file_data or '',
        'resumeText': rs.resume_text or '',
    })


@api_view(['GET'])
@require_perm('recruitment.view')
def resume_score_file(request, pk):
    """Serve the stored resume file (PDF/DOCX) as a download/inline view.

    Returns the raw decoded bytes with proper Content-Type so the browser can
    render a PDF inline or download a DOCX file directly.
    """
    import base64
    from django.http import HttpResponse

    rs = ResumeScore.objects.filter(pk=pk).first()
    if not rs:
        return HttpResponse('Resume not found', status=404)
    if not rs.file_data:
        return HttpResponse('No file stored for this resume', status=404)

    try:
        raw = base64.b64decode(rs.file_data)
    except Exception:
        return HttpResponse('Stored file data is corrupted', status=500)

    mime = rs.file_mime or 'application/octet-stream'
    file_name = rs.file_name or f'resume_{pk}'

    # Serve PDFs inline so the browser can display them; download DOCX files.
    if 'pdf' in mime.lower():
        disposition = f'inline; filename="{file_name}"'
    else:
        disposition = f'attachment; filename="{file_name}"'

    response = HttpResponse(raw, content_type=mime)
    response['Content-Disposition'] = disposition
    response['Content-Length'] = len(raw)
    # Allow cross-origin access if the frontend is served from a different port
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Expose-Headers'] = 'Content-Disposition'
    return response


# ---------------------------------------------------------------------------
# Interview Recordings
# ---------------------------------------------------------------------------
def _recording_list_qs():
    return InterviewRecording.objects.annotate(
        # ``_has_video`` is True when *either* storage column has data so that
        # legacy recordings (base64 recording_data only) still show the Play
        # button instead of "No video saved for this session".
        _has_video=Case(
            When(video_buffer__isnull=False, then=Value(True)),
            When(recording_data__isnull=False, then=Value(True)),
            default=Value(False), output_field=BooleanField(),
        ),
        _has_recording=Case(
            When(recording_data__isnull=False, then=Value(True)),
            default=Value(False), output_field=BooleanField(),
        ),
    ).defer('video_buffer', 'recording_data')


RECORDING_FIELD_MAP = {
    'candidateName': 'candidate_name', 'candidateEmail': 'candidate_email',
    'role': 'role', 'duration': 'duration', 'verdict': 'verdict',
    'totalScore': 'total_score', 'techScore': 'tech_score',
    'commScore': 'comm_score', 'integrityScore': 'integrity_score',
    'recordingData': 'recording_data', 'transcript': 'transcript',
    'responses': 'responses',
}


def _mark_interview_taken(email, role, total_score=None):
    """A saved recording means the candidate sat the interview — latch it so the
    candidate link cannot be reused. Scoped to email + role because one
    candidate may be interviewing for several roles at once.

    ``total_score`` carries the assessment result across from the recording.
    Without it the link keeps ``score`` at its 0 default, and the recruiter's
    Candidate Follow-up list renders a real interview as "Score: 0/100".
    """
    email = (email or '').strip()
    if not email:
        return
    qs = InterviewLink.objects.filter(email__iexact=email, completed_at__isnull=True)
    if role:
        qs = qs.filter(role__iexact=role.strip())
    obj = qs.order_by('-id').first()
    if obj:
        obj.completed_at = local_now()
        obj.status = 'Completed'
        fields = ['completed_at', 'status']
        try:
            if total_score is not None:
                obj.score = int(total_score)
                fields.append('score')
        except (TypeError, ValueError):
            pass
        obj.save(update_fields=fields)


@api_view(['GET', 'POST'])
# POST stays open: the candidate sitting the AI interview is not a signed-in
# user and has no AppUser row, so their end-of-session upload cannot carry an
# identity. Listing recordings still requires recruitment.view.
@require_perm({'GET': 'recruitment.view', 'POST': 'recruitment.create'},
              anonymous_methods=('POST',))
def recordings(request):
    if request.method == 'GET':
        return Response(InterviewRecordingSerializer(_recording_list_qs(), many=True).data)

    body = request.data
    if not body.get('candidateName'):
        return err('candidateName is required')
    serializer = InterviewRecordingSerializer(data=body)
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    _mark_interview_taken(body.get('candidateEmail'), body.get('role'), body.get('totalScore'))
    return Response(serializer.data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'recruitment.view', 'PUT': 'recruitment.edit', 'DELETE': 'recruitment.delete'})
def recording_detail(request, pk):
    obj = InterviewRecording.objects.filter(pk=pk).first()
    if not obj:
        return err('Recording not found', 404)

    if request.method == 'GET':
        data = InterviewRecordingSerializer(obj).data
        data['recordingData'] = obj.recording_data
        return Response(data)

    if request.method == 'PUT':
        body = request.data
        changed = False
        for key, value in body.items():
            col = RECORDING_FIELD_MAP.get(key)
            if not col:
                continue
            if col == 'responses':
                setattr(obj, col, value if isinstance(value, list) else [])
            else:
                setattr(obj, col, value)
            changed = True
        if changed:
            obj.save()
        return Response({'ok': True, 'id': obj.id})

    # DELETE
    obj.delete()
    return Response({'ok': True})


def _extract_video_bytes(raw_data):
    """Extract binary video bytes from recording_data regardless of format:
    - Plain base64 string
    - Data URL string ('data:video/webm;base64,...')
    - JSON array of base64 strings or Data URLs
    - Raw binary bytes
    """
    if not raw_data:
        return b''

    if isinstance(raw_data, bytes):
        # Check if it's already a webm / mp4 binary blob
        if raw_data.startswith(b'\x1a\x45\xdf\xa3') or raw_data.startswith(b'\x00\x00\x00'):
            return raw_data
        try:
            raw_str = raw_data.decode('utf-8', errors='ignore')
        except Exception:
            return raw_data
    else:
        raw_str = str(raw_data).strip()

    if not raw_str:
        return b''

    import base64 as _b64

    def _decode_chunk(s):
        if not s or not isinstance(s, str):
            return b''
        s = s.strip()
        if ',' in s[:100]:
            s = s.split(',', 1)[1]
        s = s.strip().replace(' ', '+')
        pad = len(s) % 4
        if pad:
            s += '=' * (4 - pad)
        try:
            return _b64.b64decode(s)
        except Exception:
            try:
                return _b64.b64decode(s.encode('ascii', errors='ignore'))
            except Exception:
                return b''

    # 1. Try parsing as JSON (array of chunks or nested string)
    if raw_str.startswith('[') or raw_str.startswith('{') or raw_str.startswith('"'):
        try:
            parsed = json.loads(raw_str)
            if isinstance(parsed, list):
                chunks = [_decode_chunk(item) for item in parsed if item]
                combined = b''.join(chunks)
                if combined:
                    return combined
            elif isinstance(parsed, str):
                decoded = _decode_chunk(parsed)
                if decoded:
                    return decoded
        except Exception:
            pass

    # 2. Fallback: single base64 or Data-URL string
    return _decode_chunk(raw_str)


@csrf_exempt
def recording_video(request, pk):
    """Binary (video/webm) upload + download.

    POST: Stores raw binary video bytes directly into `video_buffer` LONGBLOB.
    GET: Serves uncorrupted binary video data with HTTP Range request support (206 Partial Content).
    """
    if request.method == 'POST':
        if not InterviewRecording.objects.filter(pk=pk).exists():
            return err('Recording not found', 404)
        data = request.body
        if not data:
            return err('Invalid or empty video payload')
        mime = (request.META.get('CONTENT_TYPE') or 'video/webm').split(';')[0]
        InterviewRecording.objects.filter(pk=pk).update(
            video_buffer=data,
            video_mime=mime,
        )
        return JsonResponse({'ok': True})

    if request.method != 'GET':
        return err('Method not allowed', 405)

    try:
        row = InterviewRecording.objects.filter(pk=pk).values_list('video_buffer', 'video_mime', 'recording_data').first()
        if not row:
            return err('Recording not found', 404)

        raw_buf, mime, rd = row
        video_bytes = b''

        if raw_buf:
            video_bytes = bytes(raw_buf)
        elif rd:
            video_bytes = _extract_video_bytes(rd)

        if not video_bytes:
            return err('No video data for this recording', 404)

        size = len(video_bytes)
        content_type = mime or 'video/webm'

        # --- parse optional Range header ---
        import re as _re
        range_header = request.headers.get('Range') or request.META.get('HTTP_RANGE') or ''
        _RANGE_RE = _re.compile(r'bytes=([0-9]*)-([0-9]*)', _re.I)
        match = _RANGE_RE.match(range_header.strip())

        if match:
            first, last = match.group(1), match.group(2)
            if first == '':
                length = int(last or 0)
                start = max(0, size - length)
                end = size - 1
            else:
                start = int(first)
                end = size - 1 if last == '' else min(int(last), size - 1)

            if start >= size or start > end:
                resp = HttpResponse(status=416)
                resp['Content-Range'] = f'bytes */{size}'
                resp['Accept-Ranges'] = 'bytes'
                return resp

            chunk = video_bytes[start:end + 1]
            resp = HttpResponse(chunk, status=206, content_type=content_type)
            resp['Content-Range'] = f'bytes {start}-{end}/{size}'
            resp['Content-Length'] = str(len(chunk))
        else:
            resp = HttpResponse(video_bytes, status=200, content_type=content_type)
            resp['Content-Length'] = str(size)

        resp['Accept-Ranges'] = 'bytes'
        resp['Cache-Control'] = 'public, max-age=31536000'
        return resp
    except Exception as exc:
        logger.error(f'Error serving video recording {pk}: {exc}', exc_info=True)
        return err(f'Video playback error: {exc}', 500)



# ---------------------------------------------------------------------------
# Question Sets
# ---------------------------------------------------------------------------
@api_view(['POST'])
def question_sets(request):
    body = request.data
    questions = body.get('questions')
    if not isinstance(questions, list) or len(questions) == 0:
        return JsonResponse({'error': 'questions array required'}, status=400)
    new_id = 'q_' + secrets.token_hex(4)
    QuestionSet.objects.create(id=new_id, questions=questions)
    return Response({'id': new_id})


@api_view(['GET'])
def question_set_detail(request, set_id):
    obj = QuestionSet.objects.filter(pk=set_id).first()
    if not obj:
        return JsonResponse({'error': 'Not found'}, status=404)
    return Response({'questions': safe_list(obj.questions)})


# ---------------------------------------------------------------------------
# AI proxy
# ---------------------------------------------------------------------------
@api_view(['GET'])
def ai_status(request):
    available = ai.check_ai_key_valid(request.headers.get('x-api-key'))
    return Response({'available': available})


@api_view(['POST'])
def ai_generate_questions(request):
    """Generate interview questions.

    Supports two modes:
      Legacy: {prompt: "..."}
      Enhanced: {resumeText, jdText, jobRole, experienceLevel, skills, candidateName, questionCount}
    """
    body = request.data
    prompt = body.get('prompt') or ''
    params = {
        'resumeText': body.get('resumeText') or body.get('resume_text') or '',
        'jdText': body.get('jdText') or body.get('jd_text') or '',
        'jobRole': body.get('jobRole') or body.get('job_role') or '',
        'experienceLevel': body.get('experienceLevel') or body.get('experience_level') or 'Mid-level',
        'skills': body.get('skills') or [],
        'candidateName': body.get('candidateName') or body.get('candidate_name') or '',
        'questionCount': body.get('questionCount') or body.get('question_count') or 10,
    }
    has_structured = any([params['resumeText'], params['jdText'], params['jobRole']])
    if not prompt and not has_structured:
        return JsonResponse({'error': {'message': 'prompt or structured params (resumeText/jdText/jobRole) are required'}}, status=400)

    try:
        payload = ai.generate_questions(
            prompt,
            request_key=request.headers.get('x-api-key'),
            params=params if has_structured else None,
        )
    except ai.AIUnavailable as exc:
        # Questions are AI-only now, so a failure is a failure — never dress it
        # up as a successful response.
        return JsonResponse({'error': {'message': exc.message}}, status=exc.status)

    return Response(payload)


# ---------------------------------------------------------------------------
# User Settings
# ---------------------------------------------------------------------------
@api_view(['POST','GET'])
@require_perm('settings.view', or_self=True)
def user_settings(request, email):
    email = norm_email(email)
    if not email:
        return err('email is required')
    profile = UserProfile.objects.filter(pk=email).first()
    email_cfg = UserEmailConfig.objects.filter(pk=email).first()
    docs = UserDocument.objects.filter(user_email=email)
    return Response({
        'profile': UserProfileSerializer(profile).data if profile else None,
        'emailConfig': UserEmailConfigSerializer(email_cfg).data if email_cfg else None,
        'documents': UserDocumentSerializer(docs, many=True).data,
    })


@api_view(['PUT'])
@require_perm('settings.manage', or_self=True)
def user_profile(request, email):
    email = norm_email(email)
    if not email:
        return err('email is required')
    body = request.data
    obj, _ = UserProfile.objects.update_or_create(
        email=email,
        defaults={
            'first_name': body.get('firstName', ''),
            'last_name': body.get('lastName', ''),
            'phone': body.get('phone', ''),
            'alt_email': body.get('altEmail', ''),
            'blood_group': body.get('bloodGroup', ''),
            'department': body.get('department', ''),
            'designation': body.get('designation', ''),
            'address': body.get('address', ''),
            'profile_pic': body.get('profilePic', ''),
        },
    )
    return Response(UserProfileSerializer(obj).data)


def _merge_social(email, incoming):
    """Overlay the Settings form's social values on the stored ones.

    The form owns ``social['<platform>']`` — a plain profile-URL string. OAuth
    credentials live beside it under ``social['<platform>Auth']``, a key the
    form never sends. Without this merge, saving Settings would silently wipe a
    user's LinkedIn connection (see api/linkedin_oauth.py).
    """
    if not isinstance(incoming, dict):
        incoming = {}
    cfg = UserEmailConfig.objects.filter(pk=email).first()
    stored = safe_json(cfg.social) if cfg else None
    if not isinstance(stored, dict):
        return incoming

    merged = dict(incoming)
    for key, value in stored.items():
        if key.endswith('Auth') and key not in merged:
            merged[key] = value
    return merged


@api_view(['PUT'])
@require_perm('settings.manage', or_self=True)
def user_email_config(request, email):
    email = norm_email(email)
    if not email:
        return err('email is required')
    body = request.data
    social = _merge_social(email, body.get('social', {}))
    obj, _ = UserEmailConfig.objects.update_or_create(
        user_email=email,
        defaults={
            'smtp_host': body.get('smtpHost', ''),
            'smtp_port': str(body.get('smtpPort', '') or ''),
            'smtp_user': body.get('smtpUser', ''),
            'smtp_password': body.get('smtpPassword', ''),
            'smtp_secure': bool(body.get('smtpSecure', False)),
            'from_name': body.get('fromName', ''),
            'from_email': body.get('fromEmail', ''),
            'social': social if isinstance(social, dict) else {},
        },
    )
    return Response(UserEmailConfigSerializer(obj).data)


@api_view(['POST'])
@require_perm('settings.manage', or_self=True)
def user_documents(request, email):
    email = norm_email(email)
    body = request.data
    doc_type = body.get('docType')
    file_data = body.get('fileData')
    if not email or not doc_type or not file_data:
        return err('email, docType and fileData are required')
    obj, _ = UserDocument.objects.update_or_create(
        user_email=email, doc_type=doc_type,
        defaults={
            'file_name': body.get('fileName', ''),
            'file_mime': body.get('fileMime', ''),
            'file_data': file_data,
        },
    )
    return Response(UserDocumentSerializer(obj).data, status=201)


@api_view(['GET', 'DELETE'])
@require_perm({'GET': 'settings.view', 'DELETE': 'settings.manage'}, or_self=True)
def user_document_detail(request, email, doc_type):
    email = norm_email(email)
    if request.method == 'GET':
        doc = UserDocument.objects.filter(user_email=email, doc_type=doc_type).first()
        if not doc:
            return err('Document not found', 404)
        return Response(UserDocumentSerializer(doc, include_data=True).data)

    # DELETE
    deleted, _ = UserDocument.objects.filter(user_email=email, doc_type=doc_type).delete()
    if deleted == 0:
        return err('Document not found', 404)
    return Response({'ok': True})


# ---------------------------------------------------------------------------
# App Users (Settings -> User Access logins)
# Backs services/usersApi.js: every login created in the app is stored in the
# `app_users` table so it persists in MySQL, not just browser localStorage.
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'settings.view', 'POST': 'settings.manage'})
def users(request):
    if request.method == 'GET':
        return Response(AppUserSerializer(AppUser.objects.all(), many=True).data)

    body = request.data
    name = str(body.get('name') or '').strip()
    email = norm_email(body.get('email'))
    password = body.get('password') or ''
    if not name or not email or not password:
        return err('name, email and password are required')
    if AppUser.objects.filter(email=email).exists():
        return err('A login with this email already exists', 409)
    serializer = AppUserSerializer(data={**body, 'name': name, 'email': email})
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    return Response(serializer.data, status=201)


@api_view(['PUT', 'DELETE'])
@require_perm({'PUT': 'settings.manage', 'DELETE': 'settings.manage'})
def user_detail(request, email):
    email = norm_email(email)
    if not email:
        return err('email is required')
    obj = AppUser.objects.filter(email=email).first()
    if not obj:
        return err('User not found', 404)

    if request.method == 'PUT':
        body = request.data
        if body.get('name'):
            obj.full_name = str(body['name']).strip()
            obj.initials = make_initials(obj.full_name)
        if body.get('password'):
            obj.password = body['password']
        if body.get('role'):
            obj.role = body['role']
        if body.get('status'):
            obj.status = body['status']
        obj.save()
        return Response(AppUserSerializer(obj).data)

    # DELETE
    obj.delete()
    return Response({'ok': True})


# ===========================================================================
# Employees module — Attendance / Check-In-Out · Leave · Tasks · Submissions
# ===========================================================================
# An employee whose first check-in lands after this time is marked "late".
ATTENDANCE_LATE_AFTER = (9, 30)  # 09:30

DEFAULT_LEAVE_ALLOWANCE = [
    ('Casual Leave', 12),
    ('Sick Leave', 12),
    ('Earned Leave', 15),
]


def parse_date(value):
    """Parse a 'YYYY-MM-DD' string into a date (None if blank/invalid)."""
    if not value:
        return None
    try:
        return datetime.strptime(str(value).strip()[:10], '%Y-%m-%d').date()
    except (ValueError, TypeError):
        return None


# --- Attendance + Check-In / Check-Out -------------------------------------
@api_view(['GET'])
@require_perm('attendance.view', or_self=True)
def attendance(request):
    """List attendance rows, filterable by ?email=, ?date=, ?from=, ?to=."""
    qs = EmployeeAttendance.objects.all()
    email = norm_email(request.GET.get('email'))
    if email:
        qs = qs.filter(email=email)
    exact = parse_date(request.GET.get('date'))
    if exact:
        qs = qs.filter(date=exact)
    frm = parse_date(request.GET.get('from'))
    if frm:
        qs = qs.filter(date__gte=frm)
    to = parse_date(request.GET.get('to'))
    if to:
        qs = qs.filter(date__lte=to)
    return Response(EmployeeAttendanceSerializer(qs, many=True).data)


def _haversine_distance(lat1, lon1, lat2, lon2):
    import math
    R = 6371000.0  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2.0)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0)**2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


def _get_active_shift(email, date_val):
    # Check shift assignment
    assignment = ShiftAssignment.objects.filter(
        email=email,
        effective_from__lte=date_val
    ).filter(
        Q(effective_to__isnull=True) | Q(effective_to__gte=date_val)
    ).select_related('shift').first()

    if assignment and assignment.shift:
        return assignment.shift

    # Fallback to General Shift (id=1)
    fallback = Shift.objects.filter(id=1).first()
    if not fallback:
        fallback = Shift.objects.create(
            id=1,
            name='General Shift',
            start_time=time(9, 0),
            end_time=time(18, 0),
            break_minutes=60,
            grace_minutes=15,
            is_flexible=False,
            flex_hours_per_day=8.0,
            overtime_after_minutes=540,
            created_by='system'
        )
        # create() leaves whatever was passed in on the instance; only a
        # reload turns the TimeField into a real ``time``. Callers do
        # datetime.combine(date, shift.start_time), which rejects a string.
        fallback.refresh_from_db()
    return fallback


def _geofencing_enabled():
    """True once at least one active fence exists.

    Until an admin defines a fence there is nothing to be outside of, so the
    out-of-office review is skipped entirely — otherwise turning this code on
    would put every check-in in the company into a pending state.
    """
    return GeoFence.objects.filter(is_active=True).exists()


#: A phone indoors, or a desktop located from WiFi/IP, can report a position
#: hundreds of metres out. Trusting it blindly marks people who really are at
#: their desk as off-site. We widen the fence by the reading's own stated
#: accuracy, capped so a useless ±20 km fix cannot wave everybody through.
GEO_ACCURACY_ALLOWANCE_CAP_M = 750


def _locate_against_fences(lat, lng, accuracy=None):
    """Resolve a position against every active fence.

    Returns ``(is_inside, matched_fence, nearest_fence, distance_m)``. The
    distance and nearest fence are returned even on a miss so the caller can
    tell the employee how far out they were instead of just refusing them.
    """
    if lat is None or lng is None:
        return False, None, None, None

    allowance = 0.0
    if accuracy is not None:
        try:
            allowance = min(max(float(accuracy), 0.0), GEO_ACCURACY_ALLOWANCE_CAP_M)
        except (TypeError, ValueError):
            allowance = 0.0

    nearest, nearest_d = None, None
    for fence in GeoFence.objects.filter(is_active=True):
        dist = _haversine_distance(lat, lng, fence.latitude, fence.longitude)
        if nearest_d is None or dist < nearest_d:
            nearest, nearest_d = fence, dist
        if dist <= fence.radius_meters + allowance:
            return True, fence, fence, dist
    return False, None, nearest, nearest_d


def _location_help(lat, lng, accuracy, nearest, distance):
    """Say exactly why the check-in was not auto-verified.

    "You appear to be outside the office" is useless when the real problem is a
    denied permission or a 2 km WiFi fix — the employee is standing in the
    office and cannot act on it.
    """
    if lat is None or lng is None:
        return ('We could not read your location, so this check-in cannot be '
                'verified automatically. Allow location access in your browser '
                'and try again, or add a reason to send it to HR for approval.')
    if nearest is None:
        return ('No office location is configured to check against. Add a reason '
                'and HR will approve this check-in.')
    acc = f' Your position is accurate to about {round(accuracy)} m.' if accuracy else ''
    return (f'You are about {round(distance)} m from {nearest.name}, which covers '
            f'{nearest.radius_meters} m.{acc} Add a reason and HR will review it.')


def _check_geofence(lat, lng):
    """Back-compat wrapper: check-out and the event log only need a yes/no."""
    inside, fence, _nearest, _dist = _locate_against_fences(lat, lng)
    return inside, fence


def _check_geofence_legacy(lat, lng):
    if lat is None or lng is None:
        return False, None
    for fence in GeoFence.objects.filter(is_active=True):
        dist = _haversine_distance(lat, lng, fence.latitude, fence.longitude)
        if dist <= fence.radius_meters:
            return True, fence
    return False, None


def _is_checked_in(obj):
    """True when there is an open work session (checked in after last checkout)."""
    return bool(obj.check_in and (obj.check_out is None or obj.check_in > obj.check_out))


@api_view(['POST'])
@require_perm('attendance.create', or_self=True)
def attendance_check_in(request):
    """Start a work session with shift, WFH, and geofence tracking."""
    body = request.data
    email = norm_email(body.get('email'))
    if not email:
        return err('email is required')
    now = local_now()
    obj, created = EmployeeAttendance.objects.get_or_create(email=email, date=now.date())
    name = body.get('employee') or body.get('name') or ''
    if name:
        obj.employee_name = name
    if body.get('device'):
        obj.device = body.get('device')

    # Get active shift
    shift = _get_active_shift(email, now.date())
    obj.shift_id = shift.id

    # WFH verification
    is_wfh = bool(body.get('isWfh') or body.get('is_wfh') or False)
    has_approved_wfh = WfhRequest.objects.filter(
        email=email,
        status='Approved',
        from_date__lte=now.date(),
        to_date__gte=now.date()
    ).exists()
    if has_approved_wfh:
        is_wfh = True
    obj.is_wfh = is_wfh

    # GPS / Geofence verification
    lat = body.get('latitude')
    lng = body.get('longitude')
    try:
        lat = float(lat) if lat is not None else None
        lng = float(lng) if lng is not None else None
    except (ValueError, TypeError):
        lat = None
        lng = None

    try:
        accuracy = float(body.get('accuracy')) if body.get('accuracy') is not None else None
    except (ValueError, TypeError):
        accuracy = None

    fence_obj = None
    reason = str(body.get('locationReason') or body.get('reason') or '').strip()
    needs_review = False
    if is_wfh:
        # Working from home is exactly the case the fence does not apply to.
        obj.geo_verified = True
        obj.location_status = ''
        loc_desc = 'Home'
    elif not _geofencing_enabled():
        # No active fences configured — there is nothing to be outside of, so
        # enforcing would lock out every employee on day one.
        obj.geo_verified = False
        if lat is not None and lng is not None:
            obj.location_lat, obj.location_lng = lat, lng
        loc_desc = 'Office'
    else:
        is_inside, fence_obj, nearest, distance = _locate_against_fences(lat, lng, accuracy)
        if lat is not None and lng is not None:
            obj.location_lat, obj.location_lng = lat, lng
        else:
            # Do NOT keep yesterday's coordinates on the row — a stale position
            # makes an unverified day look like it was measured.
            obj.location_lat = obj.location_lng = None
        obj.geo_verified = is_inside

        if is_inside and fence_obj is not None:
            # Do not erase a decision HR already made today. Checking in from
            # inside the fence later left location_status='' while reviewer and
            # reviewed_at stayed set — an approval with no record of what was
            # approved.
            if obj.location_status not in ('Approved', 'Rejected'):
                obj.location_status = ''
            loc_desc = fence_obj.name
        elif obj.location_status == 'Approved':
            # HR already cleared today's off-site check-in. Keep the verified
            # flag their approval set — the line above reset it from the raw
            # fence test, which is still (correctly) a miss.
            obj.geo_verified = True
            loc_desc = 'Outside office (approved)'
        elif obj.location_status == 'Pending':
            return Response({
                'message': 'Your off-site check-in is waiting for HR approval. '
                           'You will be able to check in once it is approved.',
                'code': 'LOCATION_APPROVAL_PENDING',
                'status': 'Pending',
                'reason': obj.location_reason or '',
            }, status=409)
        elif not reason:
            # Persist the position (or its absence) even though we are refusing:
            # leaving an old fix on the row would show HR a location this
            # attempt never actually reported.
            obj.save(update_fields=['location_lat', 'location_lng', 'geo_verified'])
            return Response({
                'message': _location_help(lat, lng, accuracy, nearest, distance),
                'code': 'LOCATION_REASON_REQUIRED',
                'needsReason': True,
                'hasPosition': lat is not None and lng is not None,
                'accuracy': accuracy,
                'distance': round(distance) if distance is not None else None,
                'fence': nearest.name if nearest else None,
                'fenceRadius': nearest.radius_meters if nearest else None,
                'fenceLat': nearest.latitude if nearest else None,
                'fenceLng': nearest.longitude if nearest else None,
            }, status=422)
        else:
            # Record the request and stop. Per the agreed flow the employee is
            # NOT checked in until HR approves; they retry afterwards.
            obj.location_reason = reason
            obj.location_status = 'Pending'
            obj.location_reviewer = ''
            obj.location_reviewed_at = None
            obj.save()
            notify_approvers(
                'attendance.edit',
                'Off-site check-in awaiting approval',
                f'{obj.employee_name or email} asked to check in '
                + (f'{round(distance)} m from {nearest.name}' if (distance is not None and nearest)
                   else 'from an unverified location')
                + f'. Reason: "{reason}"',
                '/attendance',
            )
            create_notification(
                email,
                'Approval requested',
                'Your off-site check-in has been sent to HR. You can check in once it is approved.',
                'info',
                '/employees/attendance',
            )
            return Response({
                'message': 'Your request has been sent to HR. You will be able to '
                           'check in once it is approved.',
                'code': 'LOCATION_APPROVAL_REQUESTED',
                'status': 'Pending',
            }, status=202)

    # Status (present/late) based on first check-in
    if created:
        if shift.is_flexible:
            obj.late_minutes = 0
            obj.status = 'present'
        else:
            shift_start = datetime.combine(now.date(), shift.start_time)
            grace_start = shift_start + timedelta(minutes=shift.grace_minutes)
            if now > grace_start:
                diff_min = int((now - shift_start).total_seconds() // 60)
                obj.late_minutes = max(diff_min, 0)
                obj.status = 'late'
            else:
                obj.late_minutes = 0
                obj.status = 'present'

    # Start a new session
    obj.check_in = now
    obj.save()

    # Create event
    AttendanceEvent.objects.create(
        email=email, employee_name=obj.employee_name, date=now.date(),
        event='check-in', location=loc_desc,
        latitude=lat, longitude=lng,
        geo_fence_id=fence_obj.id if fence_obj else None,
        at=now,
    )

    if needs_review:
        # The employee is in; HR decides afterwards whether the location stands.
        notify_approvers(
            'attendance.edit',
            'Out-of-office check-in needs approval',
            f'{obj.employee_name or email} checked in outside the office at '
            f'{now.strftime("%H:%M")}. Reason given: "{reason}"',
            '/attendance',
        )

    create_notification(
        email,
        'Checked in',
        f'You have successfully checked in for today at {loc_desc}.',
        'success',
        '/employees/attendance',
    )
    return Response(EmployeeAttendanceSerializer(obj).data, status=201)


@api_view(['POST'])
@require_perm('attendance.create', or_self=True)
def attendance_check_out(request):
    """Close the open work session, calculating early exit and overtime."""
    body = request.data
    email = norm_email(body.get('email'))
    if not email:
        return err('email is required')
    now = local_now()
    obj = EmployeeAttendance.objects.filter(email=email, date=now.date()).first()
    if not obj:
        return err('No check-in found for today', 404)

    # GPS check for event
    lat = body.get('latitude')
    lng = body.get('longitude')
    try:
        lat = float(lat) if lat is not None else None
        lng = float(lng) if lng is not None else None
    except (ValueError, TypeError):
        lat = None
        lng = None

    fence_obj = None
    if obj.is_wfh:
        loc_desc = 'Home'
    else:
        if lat is not None and lng is not None:
            is_inside, fence_obj = _check_geofence(lat, lng)
            loc_desc = fence_obj.name if fence_obj else 'Unverified Location'
        else:
            loc_desc = 'Office'

    # Close session
    if _is_checked_in(obj):
        session = max(int((now - obj.check_in).total_seconds() // 60), 0)
        obj.worked_minutes = (obj.worked_minutes or 0) + session

    # Checking out mid-break → close the open break and accrue its time.
    if _is_break_label(obj.presence):
        last_start = AttendanceEvent.objects.filter(
            email=email, date=now.date(), event='break-start'
        ).order_by('-at').first()
        if last_start:
            brk_min = int((now - last_start.at).total_seconds() // 60)
            obj.break_minutes = (obj.break_minutes or 0) + max(brk_min, 0)
        AttendanceEvent.objects.create(
            email=email, employee_name=obj.employee_name, date=now.date(),
            event='break-end', location=loc_desc, at=now,
        )

    obj.check_out = now
    obj.presence = ''
    obj.presence_at = now
    # The browser can close a session when the employee leaves the geofence.
    # Stamping it keeps an auto-closed day distinguishable from one the person
    # ended themselves, which matters if they dispute the hours.
    if str(body.get('auto') or '').lower() in ('1', 'true', 'yes', 'geofence'):
        obj.auto_checkout_at = now
        if not obj.note:
            obj.note = 'Auto checked out — left the office geofence'

    # Calculations based on active shift
    shift = _get_active_shift(email, now.date())
    if shift.is_flexible:
        req_minutes = int(shift.flex_hours_per_day * 60)
        if obj.worked_minutes > req_minutes:
            obj.overtime_minutes = obj.worked_minutes - req_minutes
        else:
            obj.overtime_minutes = 0
        obj.early_exit_minutes = max(req_minutes - obj.worked_minutes, 0)
    else:
        shift_end = datetime.combine(now.date(), shift.end_time)
        if now < shift_end:
            obj.early_exit_minutes = int((shift_end - now).total_seconds() // 60)
        else:
            obj.early_exit_minutes = 0

        if obj.worked_minutes > shift.overtime_after_minutes:
            obj.overtime_minutes = obj.worked_minutes - shift.overtime_after_minutes
        else:
            obj.overtime_minutes = 0

    obj.save()

    AttendanceEvent.objects.create(
        email=email, employee_name=obj.employee_name, date=now.date(),
        event='check-out', location=loc_desc,
        latitude=lat, longitude=lng,
        geo_fence_id=fence_obj.id if fence_obj else None,
        at=now,
    )

    create_notification(
        email,
        'Checked out',
        'Your work session has been closed for today.',
        'info',
        '/employees/attendance',
    )
    _maybe_send_long_day_alert(obj, shift)
    return Response(EmployeeAttendanceSerializer(obj).data)


def _maybe_send_long_day_alert(obj, shift):
    """Email the employee once when today's work passes the shift's OT threshold.

    ``overtime_after_minutes`` defaults to 540 (9 hours). ``overtime_alert_sent_at``
    makes this at-most-once per person per day, so repeated check-outs — or the
    presence poller — cannot spam them. Delivery failure is swallowed: a mail
    problem must never break a check-out.
    """
    try:
        threshold = int(getattr(shift, 'overtime_after_minutes', 540) or 540)
        if (obj.worked_minutes or 0) < threshold or obj.overtime_alert_sent_at:
            return
        hours, minutes = divmod(int(obj.worked_minutes), 60)
        over_h, over_m = divmod(max(int(obj.worked_minutes) - threshold, 0), 60)
        html = mailer.render_branded(
            greeting=obj.employee_name or obj.email,
            title='You have worked over %d hours today' % (threshold // 60),
            intro=(
                f'Our records show <strong>{hours}h {minutes}m</strong> of work logged '
                f'for {obj.date:%d %B %Y}, which is {over_h}h {over_m}m beyond the '
                f'{threshold // 60}-hour mark for your shift.<br><br>'
                'Please make sure you take adequate rest. If this is incorrect, '
                'raise an attendance correction and HR will review it.'
            ),
            highlight_html=mailer.render_details_card('Today\'s Attendance', [
                ('Date', f'{obj.date:%d %B %Y}'),
                ('Worked', f'{hours}h {minutes}m'),
                ('Overtime', f'{over_h}h {over_m}m'),
                ('Shift', getattr(shift, 'name', '') or '—'),
            ]),
        )
        result = mailer.send_email(
            to=obj.email,
            subject=f'You have worked {hours}h {minutes}m today',
            html=html,
            text=(f'You have logged {hours}h {minutes}m on {obj.date:%d %B %Y}, '
                  f'{over_h}h {over_m}m beyond your {threshold // 60}-hour shift mark.'),
        )
        if result.get('ok'):
            obj.overtime_alert_sent_at = local_now()
            obj.save(update_fields=['overtime_alert_sent_at'])
        create_notification(
            obj.email,
            'Long working day',
            f'You have logged {hours}h {minutes}m today. Please take adequate rest.',
            'warning',
            '/employees/attendance',
        )
    except Exception:
        logger.exception('Could not send the long-day alert for %s', obj.email)


@api_view(['GET'])
@require_perm('attendance.view', or_self=True)
def attendance_geofence_check(request):
    """Is this position inside a fence? Used by the in-tab geofence watcher.

    Read-only and cheap so it can be polled. ``uncertain`` is the important
    field: a fix too vague to judge must not be treated as "left the office",
    or someone at their desk gets checked out by a bad WiFi reading.
    """
    email = norm_email(request.GET.get('email') or _resolve_recipient_email(request, ''))
    try:
        lat = float(request.GET.get('latitude'))
        lng = float(request.GET.get('longitude'))
    except (TypeError, ValueError):
        return Response({'enforced': _geofencing_enabled(), 'uncertain': True})
    try:
        accuracy = float(request.GET.get('accuracy'))
    except (TypeError, ValueError):
        accuracy = None

    if not _geofencing_enabled():
        return Response({'enforced': False, 'inside': True, 'uncertain': False})

    today = local_today()
    wfh = bool(email) and (
        WfhRequest.objects.filter(email=email, status='Approved',
                                  from_date__lte=today, to_date__gte=today).exists()
        or EmployeeAttendance.objects.filter(email=email, date=today, is_wfh=True).exists()
    )

    inside, fence, nearest, distance = _locate_against_fences(lat, lng, accuracy)
    # A reading whose error bar is wider than how far outside they appear tells
    # us nothing. Report it as uncertain rather than "outside".
    uncertain = bool(
        not inside and accuracy and nearest and distance is not None
        and (distance - (nearest.radius_meters or 0)) < accuracy
    )
    return Response({
        'enforced': True,
        'wfh': wfh,
        'inside': inside,
        'uncertain': uncertain,
        'distance': round(distance) if distance is not None else None,
        'fence': (fence or nearest).name if (fence or nearest) else None,
        'accuracy': accuracy,
    })


@api_view(['GET', 'POST'])
@require_perm({'GET': 'attendance.view', 'POST': 'attendance.edit'})
def attendance_location_reviews(request):
    """Out-of-geofence check-ins awaiting an HR/admin decision.

    GET  -> the pending queue (?status= to see decided ones).
    POST -> {id, decision: Approved|Rejected, note} records the decision and
            tells the employee. Approving sets geo_verified so the day stops
            reading as unverified in attendance reports.
    """
    if request.method == 'GET':
        status_filter = (request.GET.get('status') or 'Pending').strip()
        qs = EmployeeAttendance.objects.exclude(location_status='')
        if status_filter and status_filter.lower() != 'all':
            qs = qs.filter(location_status=status_filter)
        rows = qs.order_by('-date', '-id')[:200]
        return Response([{
            'id': r.id,
            'email': r.email,
            'employee': r.employee_name,
            'date': r.date.strftime('%Y-%m-%d') if r.date else None,
            'checkIn': r.check_in.strftime(DATETIME_FMT) if r.check_in else None,
            'reason': r.location_reason or '',
            'status': r.location_status,
            'reviewer': r.location_reviewer or '',
            'reviewedAt': r.location_reviewed_at.strftime(DATETIME_FMT) if r.location_reviewed_at else None,
            'latitude': r.location_lat,
            'longitude': r.location_lng,
        } for r in rows])

    body = request.data
    obj = EmployeeAttendance.objects.filter(pk=body.get('id')).first()
    if not obj:
        return err('Attendance record not found', 404)
    decision = str(body.get('decision') or '').strip().title()
    if decision not in ('Approved', 'Rejected'):
        return err('decision must be Approved or Rejected')
    if not obj.location_status:
        return err('This check-in is not awaiting a location review')

    from .permissions import _get_caller
    caller, _user = _get_caller(request)
    obj.location_status = decision
    obj.location_reviewer = caller or ''
    obj.location_reviewed_at = local_now()
    if decision == 'Approved':
        obj.geo_verified = True
    obj.save(update_fields=[
        'location_status', 'location_reviewer', 'location_reviewed_at', 'geo_verified',
    ])

    note = str(body.get('note') or '').strip()
    create_notification(
        obj.email,
        f'Out-of-office check-in {decision.lower()}',
        (f'Your check-in on {obj.date:%d %b %Y} from outside the office was '
         f'{decision.lower()} by {caller or "HR"}.' + (f' Note: {note}' if note else '')),
        'success' if decision == 'Approved' else 'warning',
        '/employees/attendance',
    )
    return Response({'ok': True, 'id': obj.id, 'status': obj.location_status})


@api_view(['GET'])
@require_perm('attendance.view', or_self=True)
def attendance_today(request):
    """Today's attendance snapshot for ?email= (used by the check-in widget)."""
    email = norm_email(request.GET.get('email'))
    if not email:
        return err('email is required')
    obj = EmployeeAttendance.objects.filter(email=email, date=local_now().date()).first()
    if not obj:
        return Response({
            'email': email, 'date': local_now().strftime('%Y-%m-%d'),
            'checkedIn': False, 'checkIn': None, 'checkOut': None,
            'workedMinutes': 0, 'status': 'absent',
            'isWfh': False, 'breakMinutes': 0, 'overtimeMinutes': 0,
            'lateMinutes': 0, 'earlyExitMinutes': 0, 'geoVerified': False,
        })
    return Response(EmployeeAttendanceSerializer(obj).data)


@api_view(['PUT', 'DELETE'])
@require_perm({'PUT': 'attendance.edit', 'DELETE': 'attendance.delete'})
def attendance_detail(request, pk):
    """Manual edit / removal of an attendance row (HR/admin)."""
    obj = EmployeeAttendance.objects.filter(pk=pk).first()
    if not obj:
        return err('Attendance record not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    serializer = EmployeeAttendanceSerializer(obj, data=request.data, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    return Response(serializer.data)


# --- Activity Log + Team Status (attendance_events) ------------------------
# Valid activity-log event types (mirrors ATTENDANCE_EVENT_LABELS).
ATTENDANCE_EVENT_TYPES = (
    'check-in', 'check-out', 'break-start', 'break-end',
    'remote-switch', 'office-switch',
)

# Presence labels (chosen from the STATUS picker) that count as an active break:
# they accrue break time and surface as "In Break" on the Team Status panel.
BREAK_PRESENCE_LABELS = {'away', 'coffee break', 'on break', 'in break'}
IN_BREAK_LABEL = 'In Break'


def _is_break_label(label):
    """True when a presence label means the employee is on a break."""
    return str(label or '').strip().lower() in BREAK_PRESENCE_LABELS


def _looks_remote(location):
    """Mirrors the location test in _presence_for(): these read as "Remote"."""
    loc = str(location or '').strip().lower()
    return 'home' in loc or 'remote' in loc


def remote_switch_check(email, day=None):
    """May ``email`` work remotely on ``day``? Returns (allowed, reason).

    Switching to remote used to be unguarded — anyone could POST a
    ``remote-switch`` event and be marked Remote, which made the whole WFH
    request/approval workflow advisory. It is allowed only when one of these
    holds:

      1. an APPROVED WfhRequest covers the day, or
      2. the user holds ``attendance.remote`` (standing remote/hybrid staff and
         admins who don't file a request each time), or
      3. the active WFH policy does not require approval at all.
    """
    from .permissions import _user_has_perm

    day = day or local_now().date()

    approved = WfhRequest.objects.filter(
        email=email, status='Approved', from_date__lte=day, to_date__gte=day,
    ).exists()
    if approved:
        return True, 'approved WFH request'

    user = AppUser.objects.select_related('role_ref').filter(email=email).first()
    if _user_has_perm(user, 'attendance.remote'):
        return True, 'attendance.remote permission'

    policy = WFHPolicy.objects.filter(is_active=True).first()
    if policy and not policy.requires_approval:
        return True, 'policy does not require approval'

    return False, (
        'You need an approved work-from-home request for today before switching '
        'to remote. Submit a WFH request, or ask an admin to grant you remote access.'
    )


@api_view(['GET', 'POST'])
@require_perm({'GET': 'attendance.view', 'POST': 'attendance.create'}, or_self=True)
def attendance_events(request):
    """GET: today's (or ?date=) activity-log events for ?email=.
    POST: append an event (break / mode switch) to the signed-in user's day with GPS."""
    if request.method == 'GET':
        day = parse_date(request.GET.get('date')) or local_now().date()
        qs = AttendanceEvent.objects.filter(date=day)
        email = norm_email(request.GET.get('email'))
        if email:
            qs = qs.filter(email=email)
        return Response(AttendanceEventSerializer(qs, many=True).data)

    body = request.data
    email = norm_email(body.get('email'))
    event = str(body.get('event') or body.get('type') or '').strip()
    if not email:
        return err('email is required')
    if event not in ATTENDANCE_EVENT_TYPES:
        return err('event must be one of: ' + ', '.join(ATTENDANCE_EVENT_TYPES))

    # Gate anything that would land the user in a Remote presence. That is the
    # explicit remote-switch, but also a check-in / office-switch carrying a
    # "Home"/"Remote" location, which _presence_for() reads as Remote just the
    # same — gating only the former would leave that loophole open.
    if event == 'remote-switch' or _looks_remote(body.get('location')):
        allowed, reason = remote_switch_check(email)
        if not allowed:
            return JsonResponse({'message': reason, 'code': 'wfh_not_approved'}, status=403)

    lat = body.get('latitude')
    lng = body.get('longitude')
    try:
        lat = float(lat) if lat is not None else None
        lng = float(lng) if lng is not None else None
    except (ValueError, TypeError):
        lat = None
        lng = None

    fence_obj = None
    if lat is not None and lng is not None:
        _, fence_obj = _check_geofence(lat, lng)

    now = local_now()
    obj = AttendanceEvent.objects.create(
        email=email,
        employee_name=body.get('employee') or body.get('name') or '',
        date=now.date(),
        event=event,
        location=fence_obj.name if fence_obj else str(body.get('location') or '').strip(),
        latitude=lat,
        longitude=lng,
        geo_fence_id=fence_obj.id if fence_obj else None,
        at=now,
    )

    # Manage live presence & break duration
    if event in ('break-start', 'break-end'):
        att = EmployeeAttendance.objects.filter(email=email, date=now.date()).first()
        if att:
            if event == 'break-start':
                att.presence = 'Away'
            else:
                att.presence = ''
                # Calculate break minutes since last break-start today
                last_start = AttendanceEvent.objects.filter(
                    email=email, date=now.date(), event='break-start'
                ).order_by('-at').first()
                if last_start:
                    brk_min = int((now - last_start.at).total_seconds() // 60)
                    att.break_minutes = (att.break_minutes or 0) + max(brk_min, 0)
            att.presence_at = now
            att.save()

    return Response(AttendanceEventSerializer(obj).data, status=201)


@api_view(['POST'])
@require_perm('attendance.create', or_self=True)
def attendance_presence(request):
    """Set the signed-in employee's live presence (the STATUS picker:
    Available / Away / Busy / Do not disturb / ...). Valid only while checked
    in. Selecting 'Away' logs a Break Start on the activity log (and leaving
    'Away' logs a Break End) so the timeline stays consistent."""
    body = request.data
    email = norm_email(body.get('email'))
    label = str(body.get('label') or '').strip()
    if not email:
        return err('email is required')
    if not label:
        return err('label is required')
    now = local_now()
    att = EmployeeAttendance.objects.filter(email=email, date=now.date()).first()
    if not att or not _is_checked_in(att):
        return err('Presence can only be set while checked in', 409)
    prev = att.presence or ''
    was_break = _is_break_label(prev)
    now_break = _is_break_label(label)
    name = att.employee_name or body.get('employee') or body.get('name') or ''
    if now_break and not was_break:
        # Starting a break (Away / Coffee break / …) → log the start on the timeline.
        AttendanceEvent.objects.create(
            email=email, employee_name=name, date=now.date(),
            event='break-start', location='', at=now,
        )
    elif was_break and not now_break:
        # Ending a break → log the end and accrue the elapsed break time so it
        # shows on the check-in card as "Break taken today".
        AttendanceEvent.objects.create(
            email=email, employee_name=name, date=now.date(),
            event='break-end',
            location=('Home' if att.device == 'mobile' else 'Office'), at=now,
        )
        last_start = AttendanceEvent.objects.filter(
            email=email, date=now.date(), event='break-start'
        ).order_by('-at').first()
        if last_start:
            brk_min = int((now - last_start.at).total_seconds() // 60)
            att.break_minutes = (att.break_minutes or 0) + max(brk_min, 0)
    att.presence = label
    att.presence_at = now
    att.save()
    return Response(EmployeeAttendanceSerializer(att).data)


def _team_status(event, att):
    """Live status label + 'since' datetime for the Team Status panel. An
    explicit presence choice (STATUS picker / break) wins; otherwise we fall
    back to the location implied by the latest activity event. Checked-out or
    no-show employees are Absent."""
    if att is None or not _is_checked_in(att):
        return 'Absent', None
    if att.presence:
        # A break-type status (Away / Coffee break / …) shows as "In Break";
        # every other choice shows its own label verbatim.
        if _is_break_label(att.presence):
            return IN_BREAK_LABEL, (att.presence_at or att.check_in)
        return att.presence, (att.presence_at or att.check_in)
    if event is not None:
        e = event.event
        if e in ('check-in', 'office-switch', 'break-end'):
            loc = (event.location or '').lower()
            remote = 'home' in loc or 'remote' in loc
            return ('Remote' if remote else 'In Office'), event.at
        if e == 'remote-switch':
            return 'Remote', event.at
        if e == 'break-start':
            return IN_BREAK_LABEL, event.at
    return ('Remote' if att.device == 'mobile' else 'In Office'), att.check_in


@api_view(['GET'])
def attendance_team(request):
    """Live presence snapshot for the whole team (Team Status Now panel).
    Status per person comes from their latest activity event today, else from
    their attendance record; everyone else is shown as Absent.

    Intentionally ungated: every employee may see their team's presence on the
    Check In/Out page (it exposes only name + coarse status + since-time, no
    sensitive data), so the attendance.view permission is not required here."""
    today = local_now().date()

    # Latest event per email today (queryset is ordered by ``at`` ascending, so
    # the last write per email wins) + the best name we have seen for them.
    latest_event = {}
    event_name = {}
    for ev in AttendanceEvent.objects.filter(date=today):
        latest_event[ev.email] = ev
        if ev.employee_name:
            event_name[ev.email] = ev.employee_name
    today_att = {a.email: a for a in EmployeeAttendance.objects.filter(date=today)}

    # Roster = all app users, plus any email that has activity but no login row.
    roster = [(u.email, u.full_name) for u in AppUser.objects.all()]
    known = {e for e, _ in roster}
    for email in set(list(latest_event.keys()) + list(today_att.keys())):
        if email not in known:
            att = today_att.get(email)
            roster.append((email, event_name.get(email) or (att.employee_name if att else '')))

    priority = {'In Office': 0, 'Remote': 1, 'In Break': 2, 'Absent': 3}
    rows = []
    for email, name in roster:
        att = today_att.get(email)
        status, since_dt = _team_status(latest_event.get(email), att)
        display = (name or event_name.get(email)
                   or (att.employee_name if att else '') or email.split('@')[0])
        rows.append({
            'email': email,
            'name': display,
            'status': status,
            'since': since_dt.strftime('%I:%M %p') if since_dt else '—',
        })
    rows.sort(key=lambda r: (priority.get(r['status'], 9), r['name'].lower()))
    return Response(rows)


# --- Leave Management ------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'leave.view', 'POST': 'leave.create'}, or_self=True)
def leave(request):
    if request.method == 'GET':
        qs = LeaveRequest.objects.all()
        email = norm_email(request.GET.get('email'))
        if email:
            qs = qs.filter(email=email)
        status_filter = request.GET.get('status')
        if status_filter:
            qs = qs.filter(status=status_filter)
        return Response(LeaveRequestSerializer(qs, many=True).data)

    body = request.data
    email = norm_email(body.get('email'))
    if not email:
        return err('email is required')
    if not body.get('fromDate') or not body.get('toDate'):
        return err('fromDate and toDate are required')
    serializer = LeaveRequestSerializer(data={**body, 'email': email})
    if not serializer.is_valid():
        return serializer_err(serializer)
    inst = serializer.save()
    create_notification(
        email,
        'Leave request submitted',
        'Your leave request has been submitted and is awaiting approval.',
        'info',
        '/employees/leave',
    )
    emp_name = inst.employee_name or email
    notify_approvers(
        'leave.action',
        'New leave request',
        f"{emp_name} has requested leave ({inst.type}) from {inst.from_date} to {inst.to_date}.",
        '/employees/leave',
    )
    return Response(serializer.data, status=201)


@api_view(['PUT', 'DELETE'])
@require_perm({'PUT': 'leave.action', 'DELETE': 'leave.delete'})
def leave_detail(request, pk):
    obj = LeaveRequest.objects.filter(pk=pk).first()
    if not obj:
        return err('Leave request not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    serializer = LeaveRequestSerializer(obj, data=request.data, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    new_status = str(request.data.get('status') or '').strip()
    if new_status and new_status.lower() in {'approved', 'rejected'}:
        create_notification(
            obj.email,
            'Leave request update',
            f"Your leave request has been {new_status.lower()}.",
            'success' if new_status.lower() == 'approved' else 'warning',
            '/employees/leave',
        )
    return Response(serializer.data)


@api_view(['GET'])
@require_perm('leave.view', or_self=True)
def leave_balance(request):
    """Per-type leave balance for ?email= (allowance − approved days)."""
    email = norm_email(request.GET.get('email'))
    if not email:
        return err('email is required')
    used = {}
    for lr in LeaveRequest.objects.filter(email=email, status='Approved'):
        used[lr.type] = used.get(lr.type, 0) + (lr.days or 0)
    balances = [
        {'type': typ, 'allowance': allowance,
         'used': used.get(typ, 0), 'remaining': max(allowance - used.get(typ, 0), 0)}
        for typ, allowance in DEFAULT_LEAVE_ALLOWANCE
    ]
    return Response({'email': email, 'balances': balances})


# --- Notifications --------------------------------------------------------
@api_view(['GET'])
def notifications(request):
    email = _resolve_recipient_email(request)
    if not email:
        return Response([])
    qs = Notification.objects.filter(recipient=email)
    unread_only = str(request.GET.get('unreadOnly') or request.GET.get('unread') or '').strip().lower()
    if unread_only in {'1', 'true', 'yes', 'on'}:
        qs = qs.filter(is_read=False)
    limit = request.GET.get('limit')
    if limit:
        try:
            qs = qs[:int(limit)]
        except ValueError:
            pass
    return Response(NotificationSerializer(qs, many=True).data)


@api_view(['POST'])
def notification_read(request, pk):
    email = _resolve_recipient_email(request)
    if not email:
        return err('email is required')
    obj = Notification.objects.filter(pk=pk, recipient=email).first()
    if not obj:
        return err('Notification not found', 404)
    obj.is_read = True
    obj.save()
    return Response(NotificationSerializer(obj).data)


@api_view(['DELETE'])
def notification_delete(request, pk):
    email = _resolve_recipient_email(request)
    if not email:
        return err('email is required')
    obj = Notification.objects.filter(pk=pk, recipient=email).first()
    if not obj:
        return err('Notification not found', 404)
    obj.delete()
    return Response({'ok': True, 'id': pk})


@api_view(['POST'])
def notifications_delete_batch(request):
    email = _resolve_recipient_email(request)
    if not email:
        return err('email is required')
    ids = request.data.get('ids') if hasattr(request, 'data') else []
    if not isinstance(ids, list):
        return err('ids must be a list')
    normalized = [int(i) for i in ids if str(i).isdigit()]
    qs = Notification.objects.filter(recipient=email, pk__in=normalized)
    deleted = qs.count()
    qs.delete()
    return Response({'ok': True, 'deleted': deleted})


@api_view(['POST'])
def notifications_read_all(request):
    email = _resolve_recipient_email(request)
    if not email:
        return Response({'ok': True, 'count': 0})
    count = Notification.objects.filter(recipient=email, is_read=False).update(is_read=True)
    return Response({'ok': True, 'count': count})


# --- Task Tracker ----------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'employee.view', 'POST': 'employee.create'}, or_self=True)
def tasks(request):
    if request.method == 'GET':
        qs = EmployeeTask.objects.all()
        assignee = request.GET.get('assignee')
        if assignee:
            qs = qs.filter(assignee=assignee)
        assignee_email = norm_email(request.GET.get('assigneeEmail'))
        if assignee_email:
            qs = qs.filter(assignee_email=assignee_email)
        stage = request.GET.get('stage')
        if stage:
            qs = qs.filter(stage=stage)
        return Response(EmployeeTaskSerializer(qs, many=True).data)

    body = request.data
    if not body.get('title'):
        return err('title is required')
    serializer = EmployeeTaskSerializer(data=body)
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    assignee_email = norm_email(body.get('assigneeEmail') or body.get('assignee') or '')
    if assignee_email:
        create_notification(
            assignee_email,
            'New task assigned',
            f"You have been assigned a new task: {body.get('title', 'Task')}",
            'info',
            '/employees/tasks',
        )
    return Response(serializer.data, status=201)


@api_view(['PUT', 'DELETE'])
@require_perm({'PUT': 'employee.edit', 'DELETE': 'employee.delete'})
def task_detail(request, pk):
    obj = EmployeeTask.objects.filter(pk=pk).first()
    if not obj:
        return err('Task not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    serializer = EmployeeTaskSerializer(obj, data=request.data, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)
    serializer.save()
    return Response(serializer.data)


# --- Work Submissions ------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'employee.view', 'POST': 'employee.create'}, or_self=True)
def submissions(request):
    if request.method == 'GET':
        qs = WorkSubmission.objects.all()
        email = norm_email(request.GET.get('email'))
        if email:
            qs = qs.filter(email=email)
        status_filter = request.GET.get('status')
        if status_filter:
            qs = qs.filter(status=status_filter)
        return Response(WorkSubmissionSerializer(qs, many=True).data)

    body = request.data
    email = norm_email(body.get('email'))
    if not email:
        return err('email is required')
    if not body.get('title'):
        return err('title is required')
    serializer = WorkSubmissionSerializer(data={**body, 'email': email})
    if not serializer.is_valid():
        return serializer_err(serializer)
    inst = serializer.save()
    create_notification(
        email,
        'Work submission created',
        f"Your work submission '{inst.title}' has been submitted for review.",
        'info',
        '/employees/submissions',
    )
    emp_name = inst.employee_name or email
    notify_approvers(
        'submission.action',
        'New work submission',
        f"{emp_name} has submitted a new work item: '{inst.title}'.",
        '/employees/submissions',
    )
    return Response(serializer.data, status=201)


@api_view(['PUT', 'DELETE'])
@require_perm({'DELETE': 'employee.delete'})   # PUT is gated manually below
def submission_detail(request, pk):
    obj = WorkSubmission.objects.filter(pk=pk).first()
    if not obj:
        return err('Submission not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})

    # A PUT that approves/rejects the submission needs the single "action"
    # permission (submission.action); any other edit needs employee.edit. This
    # lets a reviewer approve OR reject without granting full edit rights.
    status_val = str(request.data.get('status') or '').strip().lower()
    if status_val == 'approved':
        need, verb = 'submission.action', 'approve'
    elif status_val == 'rejected':
        need, verb = 'submission.action', 'reject'
    else:
        need, verb = 'employee.edit', 'edit'
    allowed, caller_email, user = check_perm(request, need)
    if caller_email and user and not allowed:
        return err(f"You don't have permission to {verb} work submissions.", 403)

    serializer = WorkSubmissionSerializer(obj, data=request.data, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)
    inst = serializer.save()
    new_status = str(request.data.get('status') or '').strip()
    if new_status.lower() in {'approved', 'rejected'} and obj.email:
        create_notification(
            obj.email,
            'Work submission update',
            f"Your work submission '{inst.title}' has been {new_status.lower()}.",
            'success' if new_status.lower() == 'approved' else 'warning',
            '/employees/submissions',
        )
    # Stamp the reviewer on an approve/reject when the client didn't supply one.
    if need != 'employee.edit' and not str(request.data.get('reviewer') or '').strip() and user:
        inst.reviewer = user.full_name
        inst.save(update_fields=['reviewer', 'updated_at'])
    return Response(WorkSubmissionSerializer(inst).data)


# ---------------------------------------------------------------------------
# Public client config (exposes safe, non-secret settings to the frontend)
# ---------------------------------------------------------------------------
@api_view(['GET'])
def client_config(request):
    """Return public configuration needed by the frontend JS.
    Only expose values that are safe to be public (e.g. OAuth client IDs).
    """
    import os
    return Response({
        'googleClientId': os.environ.get('GOOGLE_CLIENT_ID', ''),
        # Whether per-user LinkedIn linking is available at all. Only the
        # boolean is published — never the client id or secret.
        'linkedinConfigured': bool(
            getattr(settings, 'LINKEDIN_CLIENT_ID', '')
            and getattr(settings, 'LINKEDIN_CLIENT_SECRET', '')
        ),
    })


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@api_view(['GET'])
def health(request):
    return Response({
        'ok': True, 'mode': 'mysql', 'database': settings.DATABASES['default']['NAME'],
        'jobs': JobPost.objects.count(),
        'interviews': InterviewLink.objects.count(),
        'resumeScores': ResumeScore.objects.count(),
        'recordings': InterviewRecording.objects.count(),
        'appUsers': AppUser.objects.count(),
    })


# ---------------------------------------------------------------------------
# SPA fallback — serve the built React index.html for all non-API routes.
# ---------------------------------------------------------------------------
_INDEX_BYTES = None


def _no_store(response):
    """Stop browsers caching index.html.

    index.html is the version manifest: it is what points at
    /assets/<file>.js?v=N. Cached, the browser keeps requesting the previous
    ?v= URLs and serves those from cache too, so a deploy appears to do nothing
    — every asset silently stays on the old version until a hard refresh. The
    <meta http-equiv="Cache-Control"> tags in the document do not control HTTP
    caching; only these headers do. The assets themselves stay cacheable, which
    is the point of the ?v= query string.
    """
    response['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response['Pragma'] = 'no-cache'
    response['Expires'] = '0'
    return response


def spa_index(request):
    global _INDEX_BYTES
    index_path = settings.REACT_BUILD_DIR / 'index.html'
    if not index_path.exists():
        return HttpResponse(
            '<h1>React build not found</h1>'
            f'<p>Expected {index_path}. Run <code>npm run build</code> in the '
            'project root, or set REACT_BUILD_DIR in .env.</p>',
            status=200, content_type='text/html',
        )
    if _INDEX_BYTES is None or settings.DEBUG:
        _INDEX_BYTES = index_path.read_bytes()

    # If it is the candidate portal route, strip the React app script tag so React router doesn't boot and redirect to /login
    path = request.path.rstrip('/')
    if path == '/onboarding/fill':
        html_str = _INDEX_BYTES.decode('utf-8')
        import re
        html_str = re.sub(r'<script type="module" crossorigin src="/assets/index-[^"]+"></script>', '', html_str)
        return _no_store(HttpResponse(html_str.encode('utf-8'), content_type='text/html'))

    return _no_store(HttpResponse(_INDEX_BYTES, content_type='text/html'))



# ===========================================================================
# Role-Based Access Control (RBAC) endpoints
# ---------------------------------------------------------------------------
# Every list/detail query touches the database the minimum number of times: FK
# columns are pulled with select_related, per-row counts use correlated
# Subqueries (no cartesian join blow-up from multiple annotate Counts), and bulk
# grant/revoke uses bulk_create(ignore_conflicts) / bulk delete in one txn.
# ===========================================================================
def _sub_count(model, fk_field):
    """A correlated COUNT(*) subquery for ``model.<fk_field> == outer.pk``.
    Cheaper and join-safe versus annotate(Count(..., distinct=True)) when a row
    needs more than one independent count."""
    return Coalesce(
        Subquery(
            model.objects.filter(**{fk_field: OuterRef('pk')})
            .order_by().values(fk_field).annotate(c=Count('*')).values('c')[:1],
            output_field=IntegerField(),
        ),
        0,
    )


def _actor_user(request):
    """Resolve the acting admin (roles.created_by) from the actor header or body."""
    em = request.META.get('HTTP_X_ACTOR_EMAIL') or ''
    if not em:
        try:
            em = request.data.get('actorEmail') or request.data.get('createdBy') or ''
        except Exception:
            em = ''
    em = norm_email(em)
    return AppUser.objects.filter(email=em).first() if em else None


def _with_module(data):
    d = dict(data)
    if 'moduleId' in d and 'module' not in d:
        d['module'] = d.get('moduleId')
    return d


def _with_group(data, group_id=None):
    d = dict(data)
    if group_id is not None:
        d['group'] = group_id
    elif 'groupId' in d and 'group' not in d:
        d['group'] = d.get('groupId')
    return d


def _role_annot():
    return dict(
        permission_count=_sub_count(RolePermission, 'role'),
        user_count=_sub_count(AppUser, 'role_ref'),
    )


# --- Dashboard stats -------------------------------------------------------
@api_view(['GET'])
@require_admin
def rbac_stats(request):
    """Super-Admin dashboard counters. User totals come from one aggregate; the
    rest are index-only COUNT(*) on distinct tables."""
    u = AppUser.objects.aggregate(total=Count('id'), active=Count('id', filter=Q(status='active')))
    return Response({
        'totalUsers': u['total'] or 0,
        'activeUsers': u['active'] or 0,
        'totalRoles': Role.objects.count(),
        'permissionGroups': PermissionGroup.objects.count(),
        'permissions': Permission.objects.count(),
        'modules': Module.objects.count(),
    })


# --- Roles -----------------------------------------------------------------
@api_view(['GET', 'POST'])
@require_admin
def roles(request):
    if request.method == 'GET':
        qs = Role.objects.select_related('created_by').annotate(**_role_annot()).order_by('name')
        if request.GET.get('active') in ('1', 'true', 'True'):
            qs = qs.filter(is_active=True)
        return Response(RoleSerializer(qs, many=True).data)

    ser = RoleSerializer(data=request.data)
    if not ser.is_valid():
        return serializer_err(ser)
    if Role.objects.filter(name=ser.validated_data.get('name')).exists():
        return err('A role with this name already exists', 409)
    role = ser.save(created_by=_actor_user(request))
    role = Role.objects.select_related('created_by').annotate(**_role_annot()).get(pk=role.pk)
    return Response(RoleSerializer(role).data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_admin
def role_detail(request, pk):
    obj = Role.objects.filter(pk=pk).first()
    if not obj:
        return err('Role not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = RoleSerializer(obj, data=request.data, partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        ser.save()
    obj = Role.objects.select_related('created_by').annotate(**_role_annot()).get(pk=pk)
    return Response(RoleSerializer(obj).data)


@api_view(['POST'])
@require_admin
def role_groups(request, pk):
    """Assign permission GROUPS to a role — grants every permission in those
    groups. One query fetches all target permission ids; a single bulk_create
    (ignore_conflicts) adds the missing grants."""
    role = Role.objects.filter(pk=pk).first()
    if not role:
        return err('Role not found', 404)
    ids = request.data.get('groupIds') or request.data.get('groups') or []
    ids = [int(x) for x in ids if str(x).isdigit()]
    mode = str(request.data.get('mode') or 'add').lower()
    perm_ids = list(
        Permission.objects.filter(group_id__in=ids, is_active=True).values_list('id', flat=True))
    with transaction.atomic():
        if mode == 'replace':
            RolePermission.objects.filter(role=role).delete()
            have = set()
        else:
            have = set(RolePermission.objects.filter(role=role).values_list('permission_id', flat=True))
        to_add = [RolePermission(role_id=role.id, permission_id=pid) for pid in perm_ids if pid not in have]
        if to_add:
            RolePermission.objects.bulk_create(to_add, ignore_conflicts=True)
    total = RolePermission.objects.filter(role=role).count()
    return Response({'ok': True, 'roleId': role.id, 'added': len(to_add), 'permissionCount': total})


@api_view(['GET', 'POST'])
@require_admin
def role_permissions_view(request, pk):
    """GET: the role's permissions grouped by module->group (single query).
    POST: replace the role's grants with the given permissionIds (bulk)."""
    role = Role.objects.filter(pk=pk).first()
    if not role:
        return err('Role not found', 404)

    if request.method == 'POST':
        ids = request.data.get('permissionIds') or request.data.get('permissions') or []
        valid = set(Permission.objects.filter(
            id__in=[int(x) for x in ids if str(x).isdigit()]).values_list('id', flat=True))
        with transaction.atomic():
            RolePermission.objects.filter(role=role).exclude(permission_id__in=valid).delete()
            have = set(RolePermission.objects.filter(role=role).values_list('permission_id', flat=True))
            to_add = [RolePermission(role_id=role.id, permission_id=i) for i in valid if i not in have]
            if to_add:
                RolePermission.objects.bulk_create(to_add, ignore_conflicts=True)

    perms = (Permission.objects
             .filter(role_permissions__role_id=role.id)
             .select_related('group', 'group__module')
             .order_by('group__module__order', 'group_id', 'id'))
    groups, order = {}, []
    for p in perms:
        gid = p.group_id
        if gid not in groups:
            groups[gid] = {
                'groupId': gid,
                'group': p.group.name if p.group_id and p.group else 'Ungrouped',
                'module': (p.group.module.name if p.group_id and p.group and p.group.module_id and p.group.module else ''),
                'permissions': [],
            }
            order.append(gid)
        groups[gid]['permissions'].append({'id': p.id, 'name': p.name, 'code': p.code})
    return Response({
        'roleId': role.id,
        'role': role.name,
        'total': sum(len(groups[g]['permissions']) for g in order),
        'groups': [groups[g] for g in order],
    })


# --- Permission Groups -----------------------------------------------------
@api_view(['GET', 'POST'])
@require_admin
def permission_groups(request):
    if request.method == 'GET':
        qs = (PermissionGroup.objects.select_related('module')
              .annotate(permission_count=_sub_count(Permission, 'group')).order_by('name'))
        module = request.GET.get('module')
        if module:
            qs = qs.filter(module_id=int(module)) if str(module).isdigit() else qs.filter(module__name=module)
        return Response(PermissionGroupSerializer(qs, many=True).data)

    ser = PermissionGroupSerializer(data=_with_module(request.data))
    if not ser.is_valid():
        return serializer_err(ser)
    grp = ser.save()
    grp = PermissionGroup.objects.select_related('module').annotate(
        permission_count=_sub_count(Permission, 'group')).get(pk=grp.pk)
    return Response(PermissionGroupSerializer(grp).data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_admin
def permission_group_detail(request, pk):
    obj = PermissionGroup.objects.filter(pk=pk).first()
    if not obj:
        return err('Permission group not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = PermissionGroupSerializer(obj, data=_with_module(request.data), partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        ser.save()
    obj = PermissionGroup.objects.select_related('module').annotate(
        permission_count=_sub_count(Permission, 'group')).get(pk=pk)
    data = PermissionGroupSerializer(obj).data
    if request.method == 'GET':
        perms = obj.permissions.select_related('group', 'group__module').order_by('id')
        data = {**data, 'permissions': PermissionSerializer(perms, many=True).data}
    return Response(data)


@api_view(['POST'])
@require_admin
def permission_group_permissions(request, pk):
    """Add a permission to a group: attach an existing one (permissionId) or
    create a new permission inside the group."""
    grp = PermissionGroup.objects.filter(pk=pk).first()
    if not grp:
        return err('Permission group not found', 404)
    pid = request.data.get('permissionId')
    if pid:
        Permission.objects.filter(pk=pid).update(group_id=grp.id)
        p = Permission.objects.select_related('group', 'group__module').filter(pk=pid).first()
        if not p:
            return err('Permission not found', 404)
        return Response(PermissionSerializer(p).data)
    ser = PermissionSerializer(data=_with_group(request.data, grp.id))
    if not ser.is_valid():
        return serializer_err(ser)
    p = ser.save()
    p = Permission.objects.select_related('group', 'group__module').get(pk=p.pk)
    return Response(PermissionSerializer(p).data, status=201)


# --- Permissions -----------------------------------------------------------
@api_view(['GET', 'POST'])
@require_admin
def permissions(request):
    if request.method == 'GET':
        qs = Permission.objects.select_related('group', 'group__module').order_by('group_id', 'id')
        # Hide retired permissions (e.g. the old leave/submission approve+reject,
        # replaced by a single "action" permission) unless explicitly requested.
        if str(request.GET.get('includeInactive') or '').lower() not in ('1', 'true', 'yes'):
            qs = qs.filter(is_active=True)
        g = request.GET.get('group')
        if g:
            qs = qs.filter(group_id=int(g)) if str(g).isdigit() else qs.filter(group__name=g)
        return Response(PermissionSerializer(qs, many=True).data)
    ser = PermissionSerializer(data=_with_group(request.data))
    if not ser.is_valid():
        return serializer_err(ser)
    p = ser.save()
    p = Permission.objects.select_related('group', 'group__module').get(pk=p.pk)
    return Response(PermissionSerializer(p).data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_admin
def permission_detail(request, pk):
    obj = Permission.objects.filter(pk=pk).first()
    if not obj:
        return err('Permission not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = PermissionSerializer(obj, data=_with_group(request.data), partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        ser.save()
    obj = Permission.objects.select_related('group', 'group__module').get(pk=pk)
    return Response(PermissionSerializer(obj).data)


# --- Modules / Companies ---------------------------------------------------
@api_view(['GET', 'POST'])
@require_admin
def modules(request):
    if request.method == 'GET':
        return Response(ModuleSerializer(Module.objects.all(), many=True).data)
    ser = ModuleSerializer(data=request.data)
    if not ser.is_valid():
        return serializer_err(ser)
    ser.save()
    return Response(ser.data, status=201)


@api_view(['GET', 'POST'])
@require_admin
def companies(request):
    if request.method == 'GET':
        return Response(CompanySerializer(Company.objects.all(), many=True).data)
    ser = CompanySerializer(data=request.data)
    if not ser.is_valid():
        return serializer_err(ser)
    ser.save()
    return Response(ser.data, status=201)


# --- Effective permissions for the signed-in user --------------------------
@api_view(['GET'])
def my_permissions(request):
    """The permission codes a user's role grants — the single query the
    frontend/API uses for "Check Permissions". Resolves via role_ref, else maps
    the legacy role string onto a seeded role."""
    email = norm_email(request.GET.get('email'))
    user = AppUser.objects.select_related('role_ref').filter(email=email).first() if email else None
    role = user.role_ref if (user and user.role_ref_id) else None
    if user and role is None:
        name = {'admin': 'Super Admin', 'hr': 'HR Manager', 'recruitment': 'HR Executive'}.get(
            (user.role or '').lower())
        if name:
            role = Role.objects.filter(name=name).first()
    # Super Admin bypasses permission checks — it always holds EVERY permission,
    # even if its stored grants were edited down, so an admin can never lock
    # themselves out of a module. An explicitly assigned role (role_ref) is
    # authoritative: the legacy 'admin' string only grants Super Admin for
    # accounts that have NO role_ref (otherwise assigning a limited role would
    # be ignored and the user would keep full access).
    if user and user.role_ref_id:
        is_super = bool(role and role.name == 'Super Admin')
    else:
        is_super = (role and role.name == 'Super Admin') or (user and (user.role or '').lower() == 'admin')
    if is_super:
        codes = list(Permission.objects.filter(is_active=True).values_list('code', flat=True))
        return Response({
            'email': email, 'role': (role.name if role else 'Super Admin'),
            'roleId': (role.id if role else None), 'superAdmin': True, 'permissions': codes,
        })
    if not role:
        return Response({'email': email, 'role': None, 'roleId': None, 'permissions': []})
    codes = list(Permission.objects.filter(
        role_permissions__role=role, is_active=True).values_list('code', flat=True))
    return Response({'email': email, 'role': role.name, 'roleId': role.id, 'permissions': codes})


# --- RBAC user management (create a login and assign an RBAC role) ----------
def _legacy_from_role(name):
    """Best-effort map an RBAC role name onto the coarse legacy role string
    (admin | hr | recruitment) that drives the older UI gates. role_ref stays
    authoritative for permissions."""
    n = (name or '').lower()
    if 'admin' in n:
        return 'admin'
    if 'hr' in n or 'manager' in n:
        return 'hr'
    return 'recruitment'


@api_view(['GET', 'POST'])
@require_admin
def rbac_users(request):
    if request.method == 'GET':
        qs = AppUser.objects.select_related('role_ref').order_by('full_name', 'id')
        return Response([{
            'id': u.id,
            'name': u.full_name,
            'email': u.email,
            'initials': u.initials,
            'role': (u.role_ref.name if u.role_ref_id and u.role_ref else _legacy_from_role(u.role)),
            'roleId': u.role_ref_id,
            'status': u.status,
        } for u in qs])

    body = request.data
    name = str(body.get('name') or '').strip()
    email = norm_email(body.get('email'))
    password = body.get('password') or ''
    role_id = body.get('roleId') or body.get('role_id')
    if not name or not email or not password:
        return err('name, email and password are required')
    if len(password) < 6:
        return err('Password must be at least 6 characters')
    if not role_id:
        return err('role is required')
    role = Role.objects.filter(pk=role_id).first()
    if not role:
        return err('Selected role not found', 404)
    if AppUser.objects.filter(email=email).exists():
        return err('A user with this email already exists', 409)
    u = AppUser.objects.create(
        full_name=name,
        email=email,
        password=password,
        initials=make_initials(name),
        role=_legacy_from_role(role.name),
        role_ref=role,
        status='active',
    )
    return Response({
        'id': u.id, 'name': u.full_name, 'email': u.email, 'initials': u.initials,
        'role': role.name, 'roleId': role.id, 'status': u.status,
    }, status=201)


@api_view(['PUT', 'DELETE'])
@require_admin
def rbac_user_detail(request, pk):
    u = AppUser.objects.filter(pk=pk).first()
    if not u:
        return err('User not found', 404)
    if request.method == 'DELETE':
        u.delete()
        return Response({'ok': True})
    body = request.data
    if body.get('roleId') or body.get('role_id'):
        role = Role.objects.filter(pk=body.get('roleId') or body.get('role_id')).first()
        if role:
            u.role_ref = role
            u.role = _legacy_from_role(role.name)
    if body.get('name'):
        u.full_name = str(body['name']).strip()
        u.initials = make_initials(u.full_name)
    if body.get('password'):
        u.password = body['password']
    if body.get('status'):
        u.status = body['status']
    u.save()
    return Response({
        'id': u.id, 'name': u.full_name, 'email': u.email,
        'role': (u.role_ref.name if u.role_ref_id and u.role_ref else u.role),
        'roleId': u.role_ref_id, 'status': u.status,
    })


# ===========================================================================
# Recruitment KPI Dashboard
# ---------------------------------------------------------------------------
# GET /api/recruitment/kpis
#   ?scope=me   — individual view (caller's own interviews)
#   ?scope=all  — org-wide admin view (requires recruitment.view)
#   ?range=week|month|quarter|all  — time window filter (default: all)
#
# All data comes from existing tables — no schema changes needed.
# ===========================================================================
from django.db.models import Avg, FloatField, Max, Min, Sum
from django.db.models.functions import TruncDate, TruncMonth, TruncWeek


def _pct(numerator, denominator):
    """Safe percentage rounded to 1 dp."""
    if not denominator:
        return 0.0
    return round(numerator / denominator * 100, 1)


def _fmt_duration(avg_seconds):
    """Format average seconds into 'Xm Ys' string."""
    if avg_seconds is None:
        return '—'
    s = int(avg_seconds)
    m, sec = divmod(s, 60)
    if m:
        return f'{m}m {sec}s'
    return f'{sec}s'


def _date_filter(qs, field, range_param):
    """Filter a queryset by a date field based on the ?range= param."""
    now = local_now()
    if range_param == 'week':
        cutoff = now - timedelta(days=7)
    elif range_param == 'month':
        cutoff = now - timedelta(days=30)
    elif range_param == 'quarter':
        cutoff = now - timedelta(days=90)
    else:
        return qs  # 'all' — no filter
    return qs.filter(**{f'{field}__gte': cutoff})


@api_view(['GET'])
@require_perm('recruitment.view')
def recruitment_kpis(request):
    """
    Recruitment KPI dashboard data.

    scope=me   → individual recruiter view (filtered by X-User-Email as interviewer)
    scope=all  → admin view (requires admin role)
    range=week|month|quarter|all → time window
    """
    from .permissions import _user_has_perm
    scope = request.GET.get('scope', 'me')
    range_param = request.GET.get('range', 'all')
    role_param = request.GET.get('role', '')
    interviewer_param = request.GET.get('interviewer', '')
    dept_param = request.GET.get('dept', '')
    
    # Tab-specific new filters
    interview_type_param = request.GET.get('interview_type', '')
    status_param = request.GET.get('status', '')
    outcome_param = request.GET.get('outcome', '')
    source_param = request.GET.get('source', '')
    verdict_param = request.GET.get('verdict', '')
    job_type_param = request.GET.get('job_type', '')

    # Resolve caller
    caller_email = norm_email(
        request.META.get('HTTP_X_USER_EMAIL') or request.META.get('HTTP_X_ACTOR_EMAIL') or ''
    )
    caller_user = AppUser.objects.select_related('role_ref').filter(email=caller_email).first() if caller_email else None

    # Each scope is its own permission, so a custom role can be granted one
    # without the other (previously this was a hardcoded list of role names and
    # the RBAC editor had no say in it).
    can_org = _user_has_perm(caller_user, 'recruitment.kpi.view_org')
    can_own = _user_has_perm(caller_user, 'recruitment.kpi.view_own')

    if scope == 'all' and not can_org:
        return JsonResponse(
            {'message': 'You do not have permission to view org-wide KPIs.'}, status=403)
    if scope != 'all' and not (can_own or can_org):
        return JsonResponse(
            {'message': 'You do not have permission to view the KPI dashboard.'}, status=403)

    # Collect lists of all available options for filters (BEFORE filtering base querysets)
    all_roles = sorted(list(set([x for x in InterviewLink.objects.values_list('role', flat=True) if x])))
    all_interviewers = sorted(list(set([x for x in InterviewLink.objects.values_list('interviewer', flat=True) if x])))
    all_depts = sorted(list(set([x for x in JobPost.objects.values_list('dept', flat=True) if x])))
    all_interview_types = sorted(list(set([x for x in InterviewLink.objects.values_list('interview_type', flat=True) if x])))
    all_statuses = sorted(list(set([x for x in InterviewLink.objects.values_list('status', flat=True) if x])))
    all_outcomes = sorted(list(set([x for x in InterviewLink.objects.values_list('outcome', flat=True) if x])))
    all_sources = sorted(list(set([x for x in ResumeScore.objects.values_list('source', flat=True) if x])))
    all_verdicts = sorted(list(set([x for x in InterviewRecording.objects.values_list('verdict', flat=True) if x])))
    all_job_types = sorted(list(set([x for x in JobPost.objects.values_list('type', flat=True) if x])))

    # ── Base querysets ────────────────────────────────────────────────────
    il_qs = InterviewLink.objects.all()
    rs_qs = ResumeScore.objects.all()
    ir_qs = InterviewRecording.objects.all()
    jp_qs = JobPost.objects.all()

    # Apply scope & interviewer filter
    if scope == 'me' and caller_email:
        il_qs = il_qs.filter(interviewer__iexact=caller_email)
        # ResumeScore has no interviewer field — filter by role name via interviews
        roles_for_user = il_qs.values_list('role', flat=True).distinct()
        rs_qs = rs_qs.filter(role__in=roles_for_user)
        # InterviewRecording has no direct interviewer — use candidate_email match
        emails_for_user = il_qs.values_list('email', flat=True).distinct()
        ir_qs = ir_qs.filter(candidate_email__in=emails_for_user)
    elif scope == 'all' and interviewer_param:
        il_qs = il_qs.filter(interviewer__iexact=interviewer_param)
        roles_for_user = il_qs.values_list('role', flat=True).distinct()
        rs_qs = rs_qs.filter(role__in=roles_for_user)
        emails_for_user = il_qs.values_list('email', flat=True).distinct()
        ir_qs = ir_qs.filter(candidate_email__in=emails_for_user)

    # Apply role filter
    if role_param:
        il_qs = il_qs.filter(role__iexact=role_param)
        rs_qs = rs_qs.filter(role__iexact=role_param)
        ir_qs = ir_qs.filter(role__iexact=role_param)
        jp_qs = jp_qs.filter(title__iexact=role_param)

    # Apply department filter
    if dept_param:
        jp_qs = jp_qs.filter(dept__iexact=dept_param)
        roles_in_dept = JobPost.objects.filter(dept__iexact=dept_param).values_list('title', flat=True).distinct()
        il_qs = il_qs.filter(role__in=roles_in_dept)
        rs_qs = rs_qs.filter(role__in=roles_in_dept)
        ir_qs = ir_qs.filter(role__in=roles_in_dept)

    # Apply tab-specific new filters
    if interview_type_param:
        il_qs = il_qs.filter(interview_type__iexact=interview_type_param)
    if status_param:
        il_qs = il_qs.filter(status__iexact=status_param)
    if outcome_param:
        il_qs = il_qs.filter(outcome__iexact=outcome_param)
    if source_param:
        rs_qs = rs_qs.filter(source__iexact=source_param)
    if verdict_param:
        ir_qs = ir_qs.filter(verdict__iexact=verdict_param)
    if job_type_param:
        jp_qs = jp_qs.filter(type__iexact=job_type_param)

    # Apply time range to interview_links (created_at)
    il_qs = _date_filter(il_qs, 'created_at', range_param)
    rs_qs = _date_filter(rs_qs, 'created_at', range_param)
    ir_qs = _date_filter(ir_qs, 'created_at', range_param)
    jp_qs = _date_filter(jp_qs, 'created_at', range_param)

    # ── Pipeline KPIs ────────────────────────────────────────────────────
    total_interviews = il_qs.count()

    status_counts = {}
    for row in il_qs.values('status').annotate(c=Count('id')):
        status_counts[row['status'] or 'Unknown'] = row['c']

    outcome_counts = {}
    for row in il_qs.values('outcome').annotate(c=Count('id')):
        key = row['outcome'] or 'Pending'
        outcome_counts[key] = outcome_counts.get(key, 0) + row['c']

    emails_sent = il_qs.filter(email_sent=True).count()
    emails_pending = il_qs.filter(email_sent=False).count()
    pending_outcome = il_qs.filter(outcome__isnull=True).exclude(status='Pending').count()

    selected = outcome_counts.get('Selected', 0)
    rejected = outcome_counts.get('Rejected', 0)
    waitlisted = outcome_counts.get('Waitlisted', 0)
    shortlist_rate = _pct(selected, total_interviews)
    rejection_rate = _pct(rejected, total_interviews)
    waitlist_rate = _pct(waitlisted, total_interviews)

    avg_candidate_score = il_qs.aggregate(v=Avg('score'))['v']
    avg_candidate_score = round(float(avg_candidate_score), 1) if avg_candidate_score else 0.0

    interview_type_counts = {}
    for row in il_qs.values('interview_type').annotate(c=Count('id')):
        interview_type_counts[row['interview_type'] or 'General'] = row['c']

    # ── Resume Scoring KPIs ───────────────────────────────────────────────
    total_resumes = rs_qs.count()
    high_match = rs_qs.filter(score__gte=75).count()

    rs_agg = rs_qs.aggregate(
        avg_score=Avg('score'),
        avg_technical=Avg('technical'),
        avg_experience=Avg('experience'),
        avg_domain=Avg('domain'),
    )

    def _r(v):
        return round(float(v), 1) if v is not None else 0.0

    source_counts = {}
    for row in rs_qs.values('source').annotate(c=Count('id')):
        source_counts[row['source'] or 'Unknown'] = row['c']

    # ── Recording KPIs ────────────────────────────────────────────────────
    total_recordings = ir_qs.count()

    verdict_counts = {}
    for row in ir_qs.values('verdict').annotate(c=Count('id')):
        verdict_counts[row['verdict'] or 'HOLD'] = row['c']

    ir_agg = ir_qs.aggregate(
        avg_total=Avg('total_score'),
        avg_tech=Avg('tech_score'),
        avg_comm=Avg('comm_score'),
        avg_integrity=Avg('integrity_score'),
        avg_duration=Avg('duration'),
    )

    # ── Trend data (last 12 weeks / 12 months) ────────────────────────────
    weekly_trend = []
    monthly_shortlist = []

    if range_param in ('all', 'quarter'):
        # Weekly trend — last 12 weeks
        twelve_weeks_ago = local_now() - timedelta(weeks=12)
        weekly_rows = (
            InterviewLink.objects.filter(created_at__gte=twelve_weeks_ago)
            .annotate(week=TruncWeek('created_at'))
            .values('week')
            .annotate(total=Count('id'), selected=Count('id', filter=Q(outcome='Selected')))
            .order_by('week')
        )
        if scope == 'me' and caller_email:
            weekly_rows = weekly_rows.filter(interviewer__iexact=caller_email)
        for row in weekly_rows:
            weekly_trend.append({
                'week': row['week'].strftime('%Y-%m-%d') if row['week'] else None,
                'total': row['total'],
                'selected': row['selected'],
            })

    # Monthly trend — last 12 months
    twelve_months_ago = local_now() - timedelta(days=365)
    monthly_rows_qs = InterviewLink.objects.filter(created_at__gte=twelve_months_ago)
    if scope == 'me' and caller_email:
        monthly_rows_qs = monthly_rows_qs.filter(interviewer__iexact=caller_email)
    monthly_rows = (
        monthly_rows_qs
        .annotate(month=TruncMonth('created_at'))
        .values('month')
        .annotate(total=Count('id'), selected=Count('id', filter=Q(outcome='Selected')))
        .order_by('month')
    )
    for row in monthly_rows:
        monthly_shortlist.append({
            'month': row['month'].strftime('%Y-%m') if row['month'] else None,
            'total': row['total'],
            'selected': row['selected'],
            'shortlistRate': _pct(row['selected'], row['total']),
        })

    # ── Admin-only KPIs ───────────────────────────────────────────────────
    jobs_data = None
    recruiter_stats = None

    if scope == 'all':
        # Jobs breakdown
        total_jobs = jp_qs.count()
        total_openings = jp_qs.aggregate(s=Sum('openings'))['s'] or 0
        dept_counts = {}
        for row in jp_qs.values('dept').annotate(c=Count('id')):
            dept_counts[row['dept'] or 'Unknown'] = row['c']
        remote_count = jp_qs.filter(is_remote=True).count()
        onsite_count = jp_qs.filter(is_remote=False).count()
        job_type_counts = {}
        for row in jp_qs.values('type').annotate(c=Count('id')):
            job_type_counts[row['type'] or 'Full-time'] = row['c']

        jobs_data = {
            'totalJobs': total_jobs,
            'totalOpenings': total_openings,
            'byDepartment': [{'dept': k, 'count': v} for k, v in sorted(dept_counts.items(), key=lambda x: -x[1])],
            'byType': [{'type': k, 'count': v} for k, v in sorted(job_type_counts.items(), key=lambda x: -x[1])],
            'remote': remote_count,
            'onsite': onsite_count,
        }

        # Per-recruiter breakdown
        recruiter_rows = (
            InterviewLink.objects.all()
            if range_param == 'all'
            else _date_filter(InterviewLink.objects.all(), 'created_at', range_param)
        )
        per_recruiter = (
            recruiter_rows
            .exclude(interviewer='')
            .values('interviewer')
            .annotate(
                total=Count('id'),
                selected=Count('id', filter=Q(outcome='Selected')),
                rejected=Count('id', filter=Q(outcome='Rejected')),
                avg_score=Avg('score'),
            )
            .order_by('-total')[:20]
        )
        recruiter_stats = []
        for row in per_recruiter:
            recruiter_stats.append({
                'interviewer': row['interviewer'],
                'total': row['total'],
                'selected': row['selected'],
                'rejected': row['rejected'],
                'shortlistRate': _pct(row['selected'], row['total']),
                'avgScore': round(float(row['avg_score']), 1) if row['avg_score'] else 0.0,
            })

    # ── Assemble response ─────────────────────────────────────────────────
    response = {
        'scope': scope,
        'range': range_param,
        'filters': {
            'roles': all_roles,
            'interviewers': all_interviewers,
            'departments': all_depts,
            'interview_types': all_interview_types,
            'statuses': all_statuses,
            'outcomes': all_outcomes,
            'sources': all_sources,
            'verdicts': all_verdicts,
            'job_types': all_job_types,
        },
        'pipeline': {
            'total': total_interviews,
            'byStatus': [{'status': k, 'count': v} for k, v in sorted(status_counts.items(), key=lambda x: -x[1])],
            'byOutcome': [{'outcome': k, 'count': v} for k, v in sorted(outcome_counts.items(), key=lambda x: -x[1])],
            'byInterviewType': [{'type': k, 'count': v} for k, v in sorted(interview_type_counts.items(), key=lambda x: -x[1])],
            'emailsSent': emails_sent,
            'emailsPending': emails_pending,
            'pendingOutcome': pending_outcome,
            'shortlistRate': shortlist_rate,
            'rejectionRate': rejection_rate,
            'waitlistRate': waitlist_rate,
            'avgCandidateScore': avg_candidate_score,
        },
        'resumeScoring': {
            'total': total_resumes,
            'highMatch': high_match,
            'highMatchRate': _pct(high_match, total_resumes),
            'avgScore': _r(rs_agg['avg_score']),
            'avgTechnical': _r(rs_agg['avg_technical']),
            'avgExperience': _r(rs_agg['avg_experience']),
            'avgDomain': _r(rs_agg['avg_domain']),
            'bySource': [{'source': k, 'count': v} for k, v in sorted(source_counts.items(), key=lambda x: -x[1])],
        },
        'recordings': {
            'total': total_recordings,
            'byVerdict': [{'verdict': k, 'count': v} for k, v in sorted(verdict_counts.items(), key=lambda x: -x[1])],
            'avgTotalScore': _r(ir_agg['avg_total']),
            'avgTechScore': _r(ir_agg['avg_tech']),
            'avgCommScore': _r(ir_agg['avg_comm']),
            'avgIntegrityScore': _r(ir_agg['avg_integrity']),
            'avgDuration': _fmt_duration(ir_agg['avg_duration']),
        },
        'trends': {
            'weekly': weekly_trend,
            'monthly': monthly_shortlist,
        },
    }

    if jobs_data is not None:
        response['jobs'] = jobs_data
    if recruiter_stats is not None:
        response['recruiterStats'] = recruiter_stats

    return Response(response)


# ===========================================================================
# Advanced Attendance Management — View functions
# ===========================================================================

@api_view(['GET', 'POST'])
@require_perm({'GET': 'settings.view', 'POST': 'settings.manage'})
def shifts(request):
    if request.method == 'GET':
        qs = Shift.objects.all()
        return Response(ShiftSerializer(qs, many=True).data)
    # POST
    ser = ShiftSerializer(data=request.data)
    if not ser.is_valid():
        return serializer_err(ser)
    ser.save(created_by=_resolve_recipient_email(request, 'system'))
    return Response(ser.data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'settings.view', 'PUT': 'settings.manage', 'DELETE': 'settings.manage'})
def shift_detail(request, pk):
    obj = Shift.objects.filter(pk=pk).first()
    if not obj:
        return err('Shift not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = ShiftSerializer(obj, data=request.data, partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        ser.save()
        return Response(ser.data)
    return Response(ShiftSerializer(obj).data)


@api_view(['GET', 'POST'])
@require_perm({'GET': 'employee.view', 'POST': 'settings.manage'})
def shift_assignments(request):
    if request.method == 'GET':
        qs = ShiftAssignment.objects.select_related('shift').all()
        email = norm_email(request.GET.get('email'))
        if email:
            qs = qs.filter(email=email)
        return Response(ShiftAssignmentSerializer(qs, many=True).data)
    # POST
    ser = ShiftAssignmentSerializer(data=request.data)
    if not ser.is_valid():
        return serializer_err(ser)
    ser.save(created_by=_resolve_recipient_email(request, 'system'))
    return Response(ser.data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'employee.view', 'PUT': 'settings.manage', 'DELETE': 'settings.manage'})
def shift_assignment_detail(request, pk):
    obj = ShiftAssignment.objects.filter(pk=pk).first()
    if not obj:
        return err('Assignment not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = ShiftAssignmentSerializer(obj, data=request.data, partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        ser.save()
        return Response(ser.data)
    return Response(ShiftAssignmentSerializer(obj).data)


@api_view(['GET', 'POST'])
@require_perm({'GET': 'attendance.view', 'POST': 'settings.manage'})
def attendance_geofences(request):
    if request.method == 'GET':
        qs = GeoFence.objects.all()
        return Response(GeoFenceSerializer(qs, many=True).data)
    # POST
    ser = GeoFenceSerializer(data=request.data)
    if not ser.is_valid():
        return serializer_err(ser)
    ser.save(created_by=_resolve_recipient_email(request, 'system'))
    return Response(ser.data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'attendance.view', 'PUT': 'settings.manage', 'DELETE': 'settings.manage'})
def attendance_geofence_detail(request, pk):
    obj = GeoFence.objects.filter(pk=pk).first()
    if not obj:
        return err('Geofence not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = GeoFenceSerializer(obj, data=request.data, partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        ser.save()
        return Response(ser.data)
    return Response(GeoFenceSerializer(obj).data)


@api_view(['GET', 'POST'])
@require_perm({'GET': 'attendance.view', 'POST': 'attendance.create'}, or_self=True)
def wfh_requests(request):
    if request.method == 'GET':
        qs = WfhRequest.objects.all()
        email = norm_email(request.GET.get('email'))
        if email:
            qs = qs.filter(email=email)
        return Response(WfhRequestSerializer(qs, many=True).data)
    # POST
    body = request.data
    email = norm_email(body.get('email'))
    if not email:
        return err('email is required')
    ser = WfhRequestSerializer(data=body)
    if not ser.is_valid():
        return serializer_err(ser)
    inst = ser.save()
    notify_approvers(
        'settings.manage',
        'New WFH Request',
        f"{inst.employee_name or email} has requested WFH from {inst.from_date} to {inst.to_date}.",
        '/employees/attendance',
    )
    return Response(ser.data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'attendance.view', 'PUT': 'settings.manage', 'DELETE': 'attendance.delete'})
def wfh_request_detail(request, pk):
    obj = WfhRequest.objects.filter(pk=pk).first()
    if not obj:
        return err('WFH request not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = WfhRequestSerializer(obj, data=request.data, partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        inst = ser.save()
        status_val = request.data.get('status')
        if status_val in ('Approved', 'Rejected'):
            create_notification(
                obj.email,
                f'WFH Request {status_val}',
                f'Your WFH request has been {status_val.lower()} by HR.',
                'success' if status_val == 'Approved' else 'warning',
                '/employees/attendance',
            )
        return Response(ser.data)
    return Response(WfhRequestSerializer(obj).data)


@api_view(['GET', 'POST'])
@require_perm({'GET': 'attendance.view', 'POST': 'attendance.create'}, or_self=True)
def attendance_corrections(request):
    if request.method == 'GET':
        qs = AttendanceCorrection.objects.all()
        email = norm_email(request.GET.get('email'))
        if email:
            qs = qs.filter(email=email)
        return Response(AttendanceCorrectionSerializer(qs, many=True).data)
    # POST
    body = request.data
    email = norm_email(body.get('email'))
    if not email:
        return err('email is required')
    ser = AttendanceCorrectionSerializer(data=body)
    if not ser.is_valid():
        return serializer_err(ser)
    inst = ser.save()
    notify_approvers(
        'settings.manage',
        'New Attendance Correction Request',
        f"{inst.employee_name or email} has requested a correction for {inst.attendance_date}.",
        '/employees/attendance',
    )
    return Response(ser.data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'attendance.view', 'PUT': 'settings.manage', 'DELETE': 'attendance.delete'})
def attendance_correction_detail(request, pk):
    obj = AttendanceCorrection.objects.filter(pk=pk).first()
    if not obj:
        return err('Correction request not found', 404)
    if request.method == 'DELETE':
        obj.delete()
        return Response({'ok': True})
    if request.method == 'PUT':
        ser = AttendanceCorrectionSerializer(obj, data=request.data, partial=True)
        if not ser.is_valid():
            return serializer_err(ser)
        inst = ser.save()
        status_val = request.data.get('status')
        if status_val == 'Approved':
            att, created = EmployeeAttendance.objects.get_or_create(
                email=inst.email,
                date=inst.attendance_date
            )
            if inst.requested_check_in:
                att.check_in = inst.requested_check_in
            if inst.requested_check_out:
                att.check_out = inst.requested_check_out

            shift = _get_active_shift(inst.email, inst.attendance_date)
            att.shift_id = shift.id
            if att.check_in and att.check_out:
                att.worked_minutes = max(int((att.check_out - att.check_in).total_seconds() // 60), 0)

                if shift.is_flexible:
                    req_min = int(shift.flex_hours_per_day * 60)
                    att.overtime_minutes = max(att.worked_minutes - req_min, 0)
                    att.early_exit_minutes = max(req_min - att.worked_minutes, 0)
                    att.late_minutes = 0
                    att.status = 'present'
                else:
                    shift_start = datetime.combine(inst.attendance_date, shift.start_time)
                    grace_start = shift_start + timedelta(minutes=shift.grace_minutes)
                    if att.check_in > grace_start:
                        att.late_minutes = int((att.check_in - shift_start).total_seconds() // 60)
                        att.status = 'late'
                    else:
                        att.late_minutes = 0
                        att.status = 'present'

                    shift_end = datetime.combine(inst.attendance_date, shift.end_time)
                    if att.check_out < shift_end:
                        att.early_exit_minutes = int((shift_end - att.check_out).total_seconds() // 60)
                    else:
                        att.early_exit_minutes = 0

                    if att.worked_minutes > shift.overtime_after_minutes:
                        att.overtime_minutes = att.worked_minutes - shift.overtime_after_minutes
                    else:
                        att.overtime_minutes = 0
            att.save()

            create_notification(
                obj.email,
                'Attendance Correction Approved',
                f'Your attendance correction for {inst.attendance_date} was approved and applied.',
                'success',
                '/employees/attendance',
            )
        elif status_val == 'Rejected':
            create_notification(
                obj.email,
                'Attendance Correction Rejected',
                f'Your attendance correction for {inst.attendance_date} was rejected.',
                'warning',
                '/employees/attendance',
            )
        return Response(ser.data)
    return Response(AttendanceCorrectionSerializer(obj).data)


@api_view(['GET'])
@require_perm('attendance.view', or_self=True)
def attendance_overtime(request):
    """Retrieve list of attendance records with overtime_minutes > 0."""
    qs = EmployeeAttendance.objects.filter(overtime_minutes__gt=0)
    email = norm_email(request.GET.get('email'))
    if email:
        qs = qs.filter(email=email)
    frm = parse_date(request.GET.get('from'))
    if frm:
        qs = qs.filter(date__gte=frm)
    to = parse_date(request.GET.get('to'))
    if to:
        qs = qs.filter(date__lte=to)
    return Response(EmployeeAttendanceSerializer(qs, many=True).data)


@api_view(['POST'])
@require_perm('settings.manage')
def attendance_auto_correct(request):
    """Scan all active users, identify missing checkout for past dates and auto checkout at shift end."""
    today = local_now().date()

    updated_count = 0
    records = EmployeeAttendance.objects.filter(
        date__lt=today,
        date__gte=today - timedelta(days=7),
        check_in__isnull=False,
        check_out__isnull=True
    )
    for rec in records:
        shift = _get_active_shift(rec.email, rec.date)
        checkout_dt = datetime.combine(rec.date, shift.end_time)
        rec.check_out = checkout_dt
        rec.worked_minutes = max(int((checkout_dt - rec.check_in).total_seconds() // 60), 0)

        if shift.is_flexible:
            req_min = int(shift.flex_hours_per_day * 60)
            rec.overtime_minutes = max(rec.worked_minutes - req_min, 0)
            rec.early_exit_minutes = max(req_min - rec.worked_minutes, 0)
        else:
            rec.early_exit_minutes = 0
            if rec.worked_minutes > shift.overtime_after_minutes:
                rec.overtime_minutes = rec.worked_minutes - shift.overtime_after_minutes

        rec.note = '[Auto Corrected Checkout]'
        rec.save()
        updated_count += 1

        create_notification(
            rec.email,
            'Auto Attendance Correction',
            f'Your missing checkout on {rec.date} has been automatically corrected to shift end.',
            'info',
            '/employees/attendance'
        )
    return Response({'ok': True, 'correctedCount': updated_count})


@api_view(['GET'])
@require_perm('attendance.view', or_self=True)
def attendance_analytics(request):
    """Comprehensive high-performance analytics payload."""
    from django.db.models import Sum
    email = norm_email(request.GET.get('email'))
    range_param = request.GET.get('range', 'month')

    now = local_now().date()
    if range_param == 'week':
        days_back = 7
    elif range_param == 'quarter':
        days_back = 90
    else:
        days_back = 30

    start_date = now - timedelta(days=days_back)

    qs = EmployeeAttendance.objects.filter(date__gte=start_date, date__lte=now)
    if email:
        qs = qs.filter(email=email)

    total_records = qs.count()
    if total_records == 0:
        return Response({
            'attendanceRate': 0.0,
            'lateRate': 0.0,
            'wfhRate': 0.0,
            'avgWorkedHours': 0.0,
            'totalOvertimeHours': 0.0,
            'trends': [],
        })

    late_count = qs.filter(status='late').count()
    wfh_count = qs.filter(is_wfh=True).count()

    agg = qs.aggregate(
        total_worked=Sum('worked_minutes'),
        total_ot=Sum('overtime_minutes')
    )

    total_worked_hours = round((agg['total_worked'] or 0) / 60.0, 1)
    total_ot_hours = round((agg['total_ot'] or 0) / 60.0, 1)
    avg_worked_hours = round(total_worked_hours / total_records, 1)

    headcount = AppUser.objects.count()
    if email:
        headcount = 1

    expected_days = days_back
    if headcount == 0:
        headcount = 1
    total_expected = expected_days * headcount
    if total_expected == 0:
        total_expected = 1

    attendance_rate = round((total_records / total_expected) * 100, 1)
    late_rate = round((late_count / total_records) * 100, 1)
    wfh_rate = round((wfh_count / total_records) * 100, 1)

    from django.db.models import Avg
    trend_qs = qs.values('date').annotate(
        count=Count('id'),
        wfh=Count('id', filter=Q(is_wfh=True)),
        late=Count('id', filter=Q(status='late')),
        avg_worked=Avg('worked_minutes')
    ).order_by('date')

    trends = []
    for r in trend_qs:
        trends.append({
            'date': r['date'].strftime('%Y-%m-%d'),
            'attendanceRate': round((r['count'] / headcount) * 100, 1),
            'wfhRate': round((r['wfh'] / r['count']) * 100, 1) if r['count'] else 0.0,
            'lateRate': round((r['late'] / r['count']) * 100, 1) if r['count'] else 0.0,
            'avgWorkedHours': round((r['avg_worked'] or 0) / 60.0, 1),
        })

    return Response({
        'attendanceRate': min(attendance_rate, 100.0),
        'lateRate': late_rate,
        'wfhRate': wfh_rate,
        'avgWorkedHours': avg_worked_hours,
        'totalOvertimeHours': total_ot_hours,
        'trends': trends,
    })
