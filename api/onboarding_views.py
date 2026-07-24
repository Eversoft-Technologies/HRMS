"""
Onboarding API — work authorization, documents, and the candidate lifecycle.

Kept out of ``views.py`` (already 3,400+ lines) but follows its conventions
exactly: function-based ``@api_view`` + ``@require_perm``, the shared
``err``/``serializer_err``/``norm_email`` helpers, camelCase JSON, and flat
slash-free routes.

Two rules hold for every mutating endpoint here:

  1. It writes an ``OnboardingActivityLog`` row (the audit trail *and* the UI
     timeline are the same table), and
  2. it advances the matching ``OnboardingStatus`` stage,

both inside ``transaction.atomic()`` so a candidate can never be left with a
completed stage but no audit record of who completed it.

Files are stored base64 in the row, like ``UserDocument`` — this project has no
file-storage backend and DRF is configured JSON-parser-only.
"""
import base64
import binascii
from datetime import date, datetime, timedelta

from django.db import transaction
from django.db.models import Count, Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import (
    ONBOARDING_STAGES,
    AppUser,
    CandidateDocument,
    HrVerification,
    ItAssetAllocation,
    ManagerApproval,
    OnboardingActivityLog,
    OnboardingCandidate,
    OnboardingStatus,
    PayrollInformation,
    Role,
    UserProfile,
    WorkAuthorization,
    WorkAuthorizationDetail,
)
from .permissions import require_perm
from .serializers import (
    CandidateDocumentSerializer,
    HrVerificationSerializer,
    ItAssetAllocationSerializer,
    ManagerApprovalSerializer,
    OnboardingActivityLogSerializer,
    OnboardingCandidateSerializer,
    PayrollInformationSerializer,
    WorkAuthorizationSerializer,
)
from .views import (
    create_notification,
    err,
    make_initials,
    norm_email,
    notify_approvers,
    serializer_err,
    to_int,
)

# ---------------------------------------------------------------------------
# Domain rules
# ---------------------------------------------------------------------------

# The dynamic work-authorization form. Keys are the auth types offered in the
# UI dropdown; values are the fields that type is allowed to carry. Anything
# not listed is rejected, so a typo in the frontend surfaces as a 400 instead of
# silently writing junk into the JSON blob.
WORK_AUTH_FIELDS = {
    'H1B': ['petitionNumber', 'uscisReceipt', 'lcaNumber', 'visaExpiry'],
    'F1': ['university', 'sevisNumber', 'optStart', 'optEnd', 'cptDetails'],
    'GC EAD': ['eadNumber', 'issueDate', 'expiryDate'],
    'H4 EAD': ['h4ReceiptNumber', 'eadNumber', 'expiry'],
    # A US Citizen needs no work-authorization paperwork at all, and "Other"
    # is a free-form escape hatch for visa types we do not model yet.
    'US Citizen': [],
    'Other': ['visaType', 'visaNumber', 'issueDate', 'expiryDate', 'notes'],
}

AUTH_STATUSES = ['Active', 'Pending', 'Expired', 'Extension Filed', 'Transferred', 'Rejected']

# The candidate lifecycle status, as a flat pipeline. This is the value shown in
# the grid, filtered on, and set manually via "Change Status". The per-stage
# workflow (documents / verification / assets / payroll) tracks its own progress
# separately in OnboardingStatus rows; it no longer overwrites this field, so the
# status a user sets always stays authoritative (Rejected and the terminal
# "Onboarding Completed" are the only auto-writes — see verify/approve/activate).
CANDIDATE_STATUSES = [
    'New',
    'Offer Released',
    'Accepted',
    'Documents Pending',
    'Work Authorization Pending',
    'Verification Pending',
    'Payroll Pending',
    'IT Asset Pending',
    'Onboarding Completed',
    'Rejected',
]

# Documents. SSN plus one government photo ID are mandatory; the visa documents
# only apply to non-citizens, so they stay optional here and are enforced (or
# not) by the HR verification stage instead.
DOC_TYPES = ['ssn', 'driver_license', 'state_id', 'visa', 'i94']
MANDATORY_DOC_TYPES = ['ssn']
# Either of these satisfies the photo-ID requirement.
PHOTO_ID_DOC_TYPES = ['driver_license', 'state_id']

ALLOWED_DOC_MIMES = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
}
MAX_DOC_BYTES = 10 * 1024 * 1024  # 10 MB decoded

VERIFICATION_STATUSES = ['Pending', 'Approved', 'Rejected']
APPROVAL_ACTIONS = ['Approved', 'Rejected', 'Returned']
ASSET_SOURCES = ['Client', 'Eversoft']
ASSET_STATUSES = ['Assigned', 'Returned', 'Lost', 'Damaged']
EVERSOFT_ASSETS = ['Laptop', 'Monitor', 'Mouse', 'Keyboard', 'Dock', 'Bag', 'Headset']
PAYROLL_STATUSES = ['Pending', 'Completed']

# How far ahead a work authorization counts as "expiring soon" on the dashboard
# and in the alerts feed.
EXPIRY_WARNING_DAYS = 60


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _actor(request):
    """The acting user's email. Same header contract as permissions.py — there
    is no request.user to trust here."""
    return norm_email(
        request.META.get('HTTP_X_USER_EMAIL')
        or request.META.get('HTTP_X_ACTOR_EMAIL')
        or ''
    )


def _actor_name(email):
    if not email:
        return ''
    from .models import AppUser
    user = AppUser.objects.filter(email=email).first()
    return (user.full_name if user else '') or ''


def log_activity(candidate, event, actor_email='', comments='', old_value=None, new_value=None):
    """Append one audit/timeline row. Called by every mutating endpoint."""
    return OnboardingActivityLog.objects.create(
        candidate=candidate,
        event=event,
        actor_email=actor_email or '',
        actor_name=_actor_name(actor_email),
        comments=comments or '',
        old_value=old_value or {},
        new_value=new_value or {},
    )


def seed_stages(candidate):
    """Create the full stage checklist for a new candidate, so the UI can render
    every badge (mostly Pending) from the moment the record exists."""
    for stage in ONBOARDING_STAGES:
        OnboardingStatus.objects.get_or_create(
            candidate=candidate, stage=stage, defaults={'status': 'Pending'},
        )


def set_stage(candidate, stage, status, actor_email=''):
    """Move one stage to a new status, stamping started_at/completed_at."""
    row, _ = OnboardingStatus.objects.get_or_create(candidate=candidate, stage=stage)
    row.status = status
    row.updated_by = actor_email or ''
    now = datetime.now()
    if status == 'In Progress' and not row.started_at:
        row.started_at = now
    if status == 'Completed':
        row.started_at = row.started_at or now
        row.completed_at = now
    elif status != 'Completed':
        # Re-opening a stage (e.g. manager returns it for correction) must clear
        # the completion stamp, or the timeline would claim it is still done.
        row.completed_at = None
    row.save()
    return row


def get_candidate(pk):
    """Fetch a live (non-soft-deleted) candidate."""
    return OnboardingCandidate.objects.filter(pk=pk, is_deleted=False).first()


def decode_document(file_data, file_mime):
    """Validate an uploaded base64 document.

    Returns ``(size_bytes, cleaned_base64, error_message)``. Enforces the MIME
    allowlist and the 10 MB cap on the *decoded* bytes — base64 inflates by ~33%,
    so checking the encoded length would reject legitimate ~7.5 MB files.
    """
    mime = (file_mime or '').strip().lower()
    if mime not in ALLOWED_DOC_MIMES:
        return 0, '', 'Only PDF, PNG and JPG files are allowed'

    raw = str(file_data or '').strip()
    if not raw:
        return 0, '', 'fileData is required'

    # Browsers send "data:application/pdf;base64,JVBER..." — keep only the payload.
    if raw.startswith('data:'):
        parts = raw.split(',', 1)
        raw = parts[1] if len(parts) == 2 else ''

    try:
        decoded = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        return 0, '', 'fileData is not valid base64'

    if not decoded:
        return 0, '', 'Uploaded file is empty'
    if len(decoded) > MAX_DOC_BYTES:
        mb = len(decoded) / (1024 * 1024)
        return 0, '', f'File is {mb:.1f} MB — the maximum is 10 MB'

    return len(decoded), raw, ''


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------
def _next_candidate_code():
    """Return the next human-friendly candidate code, e.g. ``CAN0001``.

    The number is the highest code ever assigned across ALL candidates —
    including soft-deleted ones — plus one, so a code is never reused: the
    sequence only ever climbs and a deletion leaves a permanent gap instead
    of freeing its number for the next candidate. Deliberately does NOT use
    the primary key (which jumps around as unrelated rows are created); only
    the ``CAN****`` codes are considered.

    ``candidate_code`` is a display-only label (never used as a lookup key
    and not unique-constrained). Computed inside the caller's
    ``transaction.atomic()`` block.
    """
    highest = 0
    codes = (
        OnboardingCandidate.objects
        .filter(candidate_code__startswith='CAN')   # ALL candidates, incl. soft-deleted → never reuse
        .values_list('candidate_code', flat=True)
    )
    for code in codes:
        # Parse the numeric suffix; skip anything that isn't ``CAN<digits>``.
        try:
            n = int(code[3:])
        except (TypeError, ValueError):
            continue
        if n > highest:
            highest = n
    return 'CAN%04d' % (highest + 1)


@api_view(['GET', 'POST'])
@require_perm({'GET': 'onboarding.view', 'POST': 'onboarding.create'})
def candidates(request):
    if request.method == 'GET':
        qs = OnboardingCandidate.objects.filter(is_deleted=False).select_related(
            'work_authorization', 'hr_verification', 'payroll',
        ).prefetch_related('stages')

        status_f = request.query_params.get('status')
        department = request.query_params.get('department')
        client = request.query_params.get('client')
        recruiter = request.query_params.get('recruiter')
        auth_type = request.query_params.get('authType')
        search = request.query_params.get('search')

        if status_f:
            qs = qs.filter(status=status_f)
        if department:
            qs = qs.filter(department__icontains=department)
        if client:
            qs = qs.filter(client__icontains=client)
        if recruiter:
            qs = qs.filter(recruiter__icontains=recruiter)
        if auth_type:
            qs = qs.filter(work_authorization__auth_type=auth_type)
        if search:
            from django.db.models import Q
            qs = qs.filter(
                Q(first_name__icontains=search)
                | Q(last_name__icontains=search)
                | Q(email__icontains=search)
                | Q(job_title__icontains=search)
            )

        total = qs.count()
        page = max(1, to_int(request.query_params.get('page'), 1))
        page_size = to_int(request.query_params.get('pageSize'), 25)
        page_size = min(max(page_size, 1), 200)  # a runaway pageSize would dump the table
        start = (page - 1) * page_size
        items = OnboardingCandidateSerializer(qs[start:start + page_size], many=True).data
        return Response({
            'items': items, 'total': total, 'page': page, 'pageSize': page_size,
        })

    body = request.data
    email = norm_email(body.get('email'))
    if not body.get('firstName') or not email:
        return err('firstName and email are required')
    if OnboardingCandidate.objects.filter(email=email, is_deleted=False).exists():
        return err('A candidate with this email is already being onboarded', 409)

    # A "Save Draft" sends status Draft; a "Submit Candidate" sends
    # 'Pending Verification'. Reject anything outside the known set so a bad
    # client value cannot land an unrecognised status in the table.
    req_status = body.get('status') or 'New'
    if req_status not in CANDIDATE_STATUSES:
        return err(f"status must be one of: {', '.join(CANDIDATE_STATUSES)}")

    payload = dict(body)
    payload['email'] = email
    serializer = OnboardingCandidateSerializer(data=payload)
    if not serializer.is_valid():
        return serializer_err(serializer)

    # A date of birth in the future is always a data-entry error.
    dob = serializer.validated_data.get('dob')
    if dob and dob > date.today():
        return err('Date of birth cannot be in the future')

    actor = _actor(request)
    with transaction.atomic():
        candidate = serializer.save(created_by=actor)
        # Assign the human-friendly code from the CAN-code sequence (see
        # _next_candidate_code) rather than the primary key. The sequence spans
        # all candidates incl. soft-deleted ones, so codes are never reused —
        # deleting candidates leaves permanent gaps; it does not restart at
        # CAN0001.
        if not candidate.candidate_code:
            candidate.candidate_code = _next_candidate_code()
            candidate.save(update_fields=['candidate_code'])
        seed_stages(candidate)
        set_stage(candidate, 'candidate_created', 'Completed', actor)
        set_stage(candidate, 'work_authorization', 'In Progress', actor)
        log_activity(
            candidate, 'Candidate Created', actor,
            comments=f'Candidate {candidate.first_name} {candidate.last_name}'.strip(),
            new_value={'email': candidate.email, 'status': candidate.status},
        )
    return Response(OnboardingCandidateSerializer(candidate).data, status=201)


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
@require_perm({
    'GET': 'onboarding.view',
    'PATCH': 'onboarding.edit',
    'PUT': 'onboarding.edit',
    'DELETE': 'onboarding.delete',
})
def candidate_detail(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    if request.method == 'GET':
        return Response(OnboardingCandidateSerializer(candidate).data)

    actor = _actor(request)

    if request.method == 'DELETE':
        # Soft delete: the audit trail and documents must outlive the record.
        with transaction.atomic():
            candidate.is_deleted = True
            candidate.deleted_at = datetime.now()
            candidate.deleted_by = actor
            candidate.save()
            log_activity(candidate, 'Candidate Deleted', actor)
        return Response({'ok': True})

    body = request.data
    if 'status' in body and body['status'] not in CANDIDATE_STATUSES:
        return err(f"status must be one of: {', '.join(CANDIDATE_STATUSES)}")
    if 'email' in body:
        body = dict(body)
        body['email'] = norm_email(body.get('email'))

    before = OnboardingCandidateSerializer(candidate).data
    serializer = OnboardingCandidateSerializer(candidate, data=body, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)

    dob = serializer.validated_data.get('dob')
    if dob and dob > date.today():
        return err('Date of birth cannot be in the future')

    with transaction.atomic():
        candidate = serializer.save()
        after = OnboardingCandidateSerializer(candidate).data
        changed = {k: after[k] for k in after if k in before and before[k] != after[k]}
        if changed:
            log_activity(
                candidate, 'Candidate Updated', actor,
                old_value={k: before[k] for k in changed},
                new_value=changed,
            )
    return Response(OnboardingCandidateSerializer(candidate).data)


@api_view(['GET'])
@require_perm('onboarding.view')
def candidate_timeline(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)
    logs = candidate.activity_logs.all()
    return Response(OnboardingActivityLogSerializer(logs, many=True).data)


# ---------------------------------------------------------------------------
# Work authorization
# ---------------------------------------------------------------------------
@api_view(['GET', 'PUT'])
@require_perm({'GET': 'onboarding.view', 'PUT': 'onboarding.edit'})
def candidate_work_authorization(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    auth = WorkAuthorization.objects.filter(candidate=candidate).first()

    if request.method == 'GET':
        if not auth:
            return Response({})
        return Response(WorkAuthorizationSerializer(auth).data)

    body = request.data
    auth_type = (body.get('authType') or '').strip()
    if auth_type not in WORK_AUTH_FIELDS:
        return err(f"authType must be one of: {', '.join(WORK_AUTH_FIELDS)}")

    status_val = (body.get('status') or 'Pending').strip()
    if status_val not in AUTH_STATUSES:
        return err(f"status must be one of: {', '.join(AUTH_STATUSES)}")

    # Reject unknown keys rather than quietly storing them — the details blob is
    # schemaless, so this validation is the only thing standing between a
    # frontend typo and unqueryable garbage.
    incoming = body.get('details') or {}
    if not isinstance(incoming, dict):
        return err('details must be an object')
    allowed = WORK_AUTH_FIELDS[auth_type]
    unknown = [k for k in incoming if k not in allowed]
    if unknown:
        return err(
            f"Unknown field(s) for {auth_type}: {', '.join(sorted(unknown))}. "
            f"Allowed: {', '.join(allowed) or 'none'}"
        )

    actor = _actor(request)
    before = WorkAuthorizationSerializer(auth).data if auth else {}

    serializer = WorkAuthorizationSerializer(auth, data=body, partial=bool(auth))
    if not serializer.is_valid():
        return serializer_err(serializer)

    with transaction.atomic():
        auth = serializer.save(candidate=candidate)
        WorkAuthorizationDetail.objects.update_or_create(
            work_authorization=auth, defaults={'details': incoming},
        )
        auth.refresh_from_db()
        set_stage(candidate, 'work_authorization', 'Completed', actor)
        set_stage(candidate, 'documents', 'In Progress', actor)
        log_activity(
            candidate, 'Work Authorization Updated', actor,
            comments=f'{auth_type} ({status_val})',
            old_value=before,
            new_value=WorkAuthorizationSerializer(auth).data,
        )
    return Response(WorkAuthorizationSerializer(auth).data)


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'onboarding.view', 'POST': 'onboarding.edit'})
def candidate_documents(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    if request.method == 'GET':
        # Only the current version of each document, unless history is asked for.
        qs = candidate.documents.all()
        if request.query_params.get('all') not in ('1', 'true'):
            qs = qs.filter(is_active=True)
        return Response(CandidateDocumentSerializer(qs, many=True).data)

    body = request.data
    doc_type = (body.get('docType') or '').strip().lower()
    if doc_type not in DOC_TYPES:
        return err(f"docType must be one of: {', '.join(DOC_TYPES)}")

    size, cleaned, error = decode_document(body.get('fileData'), body.get('fileMime'))
    if error:
        return err(error)

    actor = _actor(request)
    with transaction.atomic():
        # Uploading over an existing doc supersedes it rather than overwriting:
        # the old row stays as version history, just flagged inactive.
        previous = candidate.documents.filter(doc_type=doc_type, is_active=True).first()
        version = (previous.version + 1) if previous else 1
        if previous:
            previous.is_active = False
            previous.save()

        doc = CandidateDocument.objects.create(
            candidate=candidate,
            doc_type=doc_type,
            file_name=(body.get('fileName') or '').strip(),
            file_mime=(body.get('fileMime') or '').strip().lower(),
            file_size=size,
            file_data=cleaned,
            version=version,
            is_active=True,
            uploaded_by=actor,
        )
        set_stage(candidate, 'documents', 'In Progress', actor)
        log_activity(
            candidate,
            'Document Replaced' if previous else 'Document Uploaded', actor,
            comments=f'{doc_type} (v{version})',
            new_value={'docType': doc_type, 'fileName': doc.file_name, 'version': version},
        )
    return Response(CandidateDocumentSerializer(doc).data, status=201)


@api_view(['GET', 'DELETE'])
@require_perm({'GET': 'onboarding.view', 'DELETE': 'onboarding.edit'})
def candidate_document_detail(request, pk, doc_id):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)
    doc = candidate.documents.filter(pk=doc_id).first()
    if not doc:
        return err('Document not found', 404)

    if request.method == 'GET':
        # The base64 payload is only ever sent on an explicit single-document
        # read — never in a list, which would be megabytes per row.
        return Response(CandidateDocumentSerializer(doc, include_data=True).data)

    actor = _actor(request)
    with transaction.atomic():
        doc_type, version = doc.doc_type, doc.version
        doc.delete()
        # Promote the previous version back to current, so deleting a bad
        # re-upload restores the document it replaced instead of leaving a hole.
        restored = candidate.documents.filter(doc_type=doc_type).order_by('-version').first()
        if restored and not restored.is_active:
            restored.is_active = True
            restored.save()
        log_activity(
            candidate, 'Document Deleted', actor,
            comments=f'{doc_type} (v{version})',
            old_value={'docType': doc_type, 'version': version},
        )
    return Response({'ok': True})


@api_view(['GET'])
@require_perm('onboarding.view')
def candidate_document_versions(request, pk, doc_type):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)
    doc_type = (doc_type or '').strip().lower()
    if doc_type not in DOC_TYPES:
        return err(f"docType must be one of: {', '.join(DOC_TYPES)}")
    qs = candidate.documents.filter(doc_type=doc_type).order_by('-version')
    return Response(CandidateDocumentSerializer(qs, many=True).data)


# ---------------------------------------------------------------------------
# HR verification
# ---------------------------------------------------------------------------
def missing_mandatory_docs(candidate):
    """Which required documents are still absent.

    SSN is required outright. A photo ID is required, but either a driver
    licence *or* a state ID satisfies it — a candidate should not be blocked for
    lacking both when they only ever needed one.
    """
    present = set(
        candidate.documents.filter(is_active=True).values_list('doc_type', flat=True)
    )
    missing = [d for d in MANDATORY_DOC_TYPES if d not in present]
    if not (present & set(PHOTO_ID_DOC_TYPES)):
        missing.append('driver_license or state_id')
    return missing


@api_view(['GET', 'POST'])
@require_perm({'GET': 'onboarding.view', 'POST': 'onboarding.verify'})
def candidate_verification(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    verification = HrVerification.objects.filter(candidate=candidate).first()

    if request.method == 'GET':
        data = HrVerificationSerializer(verification).data if verification else {}
        # The UI needs to know what is still outstanding before HR can approve.
        data['missingDocuments'] = missing_mandatory_docs(candidate)
        return Response(data)

    body = request.data
    status_val = (body.get('status') or 'Pending').strip()
    if status_val not in VERIFICATION_STATUSES:
        return err(f"status must be one of: {', '.join(VERIFICATION_STATUSES)}")

    # Approving with a mandatory document missing would let a candidate through
    # the gate this stage exists to guard.
    if status_val == 'Approved':
        missing = missing_mandatory_docs(candidate)
        if missing:
            return err(f"Cannot approve — missing required document(s): {', '.join(missing)}")

    if status_val == 'Rejected' and not (body.get('remarks') or '').strip():
        return err('remarks are required when rejecting a verification')

    actor = _actor(request)
    before = HrVerificationSerializer(verification).data if verification else {}

    serializer = HrVerificationSerializer(verification, data=body, partial=bool(verification))
    if not serializer.is_valid():
        return serializer_err(serializer)

    with transaction.atomic():
        verification = serializer.save(
            candidate=candidate, verified_by=actor, verified_at=datetime.now(),
        )
        if status_val == 'Approved':
            # HR signing off IS what closes the documents stage: an upload alone
            # only means a file arrived, not that it was the right one.
            set_stage(candidate, 'documents', 'Completed', actor)
            set_stage(candidate, 'hr_verification', 'Completed', actor)
            set_stage(candidate, 'manager_approval', 'In Progress', actor)
        elif status_val == 'Rejected':
            set_stage(candidate, 'hr_verification', 'Rejected', actor)
            # Rejection is unambiguous, so it is one of the two auto-writes.
            candidate.status = 'Rejected'
        else:
            set_stage(candidate, 'hr_verification', 'In Progress', actor)
        # NOTE: the candidate's pipeline status is user-driven (Change Status);
        # the verification stage tracks its own progress and no longer overwrites it.
        candidate.save()

        log_activity(
            candidate, f'HR Verification {status_val}', actor,
            comments=(body.get('remarks') or '').strip(),
            old_value=before, new_value=HrVerificationSerializer(verification).data,
        )

    if status_val == 'Approved':
        notify_approvers(
            'onboarding.approve',
            'Onboarding approval pending',
            f'{candidate.first_name} {candidate.last_name}'.strip()
            + ' passed HR verification and is awaiting your approval.',
            link=f'/onboarding/candidates/{candidate.id}',
        )

    data = HrVerificationSerializer(verification).data
    data['missingDocuments'] = missing_mandatory_docs(candidate)
    return Response(data)


# ---------------------------------------------------------------------------
# Manager approval
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'onboarding.view', 'POST': 'onboarding.approve'})
def candidate_approval(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    if request.method == 'GET':
        return Response(ManagerApprovalSerializer(candidate.approvals.all(), many=True).data)

    body = request.data
    action = (body.get('action') or '').strip()
    if action not in APPROVAL_ACTIONS:
        return err(f"action must be one of: {', '.join(APPROVAL_ACTIONS)}")

    comments = (body.get('comments') or '').strip()
    if action in ('Rejected', 'Returned') and not comments:
        return err(f'comments are required when the action is "{action}"')

    # A manager should not be able to approve someone HR has not cleared — that
    # would let the verification gate be skipped entirely.
    verification = HrVerification.objects.filter(candidate=candidate).first()
    if action == 'Approved' and (not verification or verification.status != 'Approved'):
        return err('Cannot approve — HR verification is not complete', 409)

    actor = _actor(request)
    with transaction.atomic():
        approval = ManagerApproval.objects.create(
            candidate=candidate, action=action, comments=comments, approver=actor,
        )
        if action == 'Approved':
            set_stage(candidate, 'manager_approval', 'Completed', actor)
            set_stage(candidate, 'it_assets', 'In Progress', actor)
        elif action == 'Rejected':
            set_stage(candidate, 'manager_approval', 'Rejected', actor)
            candidate.status = 'Rejected'
        else:  # Returned for correction — reopen the verification stage.
            set_stage(candidate, 'manager_approval', 'Pending', actor)
            set_stage(candidate, 'hr_verification', 'In Progress', actor)
            if verification:
                verification.status = 'Pending'
                verification.save()
        # Pipeline status stays user-driven; only a rejection auto-writes it.
        candidate.save()
        log_activity(
            candidate, f'Manager {action}', actor, comments=comments,
            new_value={'action': action},
        )

    # Tell the recruiter who owns this candidate what happened.
    if candidate.created_by:
        create_notification(
            candidate.created_by,
            f'Onboarding {action.lower()}',
            f'{candidate.first_name} {candidate.last_name}'.strip()
            + f' was {action.lower()} by {actor}.'
            + (f' Comments: {comments}' if comments else ''),
            'success' if action == 'Approved' else 'warning',
            link=f'/onboarding/candidates/{candidate.id}',
        )

    return Response(ManagerApprovalSerializer(approval).data, status=201)


# ---------------------------------------------------------------------------
# IT asset allocation
# ---------------------------------------------------------------------------
@api_view(['GET', 'POST'])
@require_perm({'GET': 'onboarding.view', 'POST': 'onboarding.assets'})
def candidate_assets(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    if request.method == 'GET':
        return Response(
            ItAssetAllocationSerializer(candidate.asset_allocations.all(), many=True).data
        )

    body = request.data
    source = (body.get('assetSource') or 'Eversoft').strip()
    if source not in ASSET_SOURCES:
        return err(f"assetSource must be one of: {', '.join(ASSET_SOURCES)}")

    status_val = (body.get('status') or 'Assigned').strip()
    if status_val not in ASSET_STATUSES:
        return err(f"status must be one of: {', '.join(ASSET_STATUSES)}")

    # A client-owned asset with no client name is untraceable when it has to go
    # back at the end of the engagement.
    if source == 'Client' and not (body.get('clientName') or '').strip():
        return err('clientName is required for client-owned assets')

    assets = body.get('assets') or []
    if not isinstance(assets, list):
        return err('assets must be a list')
    unknown = [a for a in assets if a not in EVERSOFT_ASSETS]
    if source == 'Eversoft' and unknown:
        return err(
            f"Unknown asset(s): {', '.join(map(str, sorted(unknown)))}. "
            f"Allowed: {', '.join(EVERSOFT_ASSETS)}"
        )

    actor = _actor(request)
    serializer = ItAssetAllocationSerializer(data=body)
    if not serializer.is_valid():
        return serializer_err(serializer)

    with transaction.atomic():
        allocation = serializer.save(candidate=candidate, allocated_by=actor)
        set_stage(candidate, 'it_assets', 'Completed', actor)
        set_stage(candidate, 'payroll', 'In Progress', actor)
        log_activity(
            candidate, 'IT Assets Allocated', actor,
            comments=f"{source}: {', '.join(assets) or allocation.asset_id or '-'}",
            new_value=ItAssetAllocationSerializer(allocation).data,
        )
    return Response(ItAssetAllocationSerializer(allocation).data, status=201)


@api_view(['PATCH', 'DELETE'])
@require_perm('onboarding.assets')
def candidate_asset_detail(request, pk, asset_id):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)
    allocation = candidate.asset_allocations.filter(pk=asset_id).first()
    if not allocation:
        return err('Asset allocation not found', 404)

    actor = _actor(request)

    if request.method == 'DELETE':
        with transaction.atomic():
            log_activity(
                candidate, 'IT Asset Allocation Removed', actor,
                old_value=ItAssetAllocationSerializer(allocation).data,
            )
            allocation.delete()
        return Response({'ok': True})

    status_val = (request.data.get('status') or '').strip()
    if status_val and status_val not in ASSET_STATUSES:
        return err(f"status must be one of: {', '.join(ASSET_STATUSES)}")

    before = ItAssetAllocationSerializer(allocation).data
    serializer = ItAssetAllocationSerializer(allocation, data=request.data, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)

    with transaction.atomic():
        allocation = serializer.save()
        log_activity(
            candidate, 'IT Asset Updated', actor,
            comments=f'status: {allocation.status}',
            old_value=before, new_value=ItAssetAllocationSerializer(allocation).data,
        )
    return Response(ItAssetAllocationSerializer(allocation).data)


# ---------------------------------------------------------------------------
# Payroll
#
# NOTE: GET is gated on onboarding.payroll, not onboarding.view. Bank details
# are the one part of a candidate's record that a Manager or an IT Admin has no
# business reading, and this is what enforces that.
# ---------------------------------------------------------------------------
@api_view(['GET', 'PUT'])
@require_perm('onboarding.payroll')
def candidate_payroll(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    payroll = PayrollInformation.objects.filter(candidate=candidate).first()

    if request.method == 'GET':
        return Response(PayrollInformationSerializer(payroll).data if payroll else {})

    body = request.data
    status_val = (body.get('status') or 'Pending').strip()
    if status_val not in PAYROLL_STATUSES:
        return err(f"status must be one of: {', '.join(PAYROLL_STATUSES)}")

    if status_val == 'Completed':
        for field, label in (('bankName', 'bankName'), ('accountNumber', 'accountNumber'),
                             ('routingNumber', 'routingNumber'), ('taxState', 'taxState')):
            if not (body.get(field) or '').strip():
                return err(f'{label} is required to complete payroll')

    actor = _actor(request)
    before = PayrollInformationSerializer(payroll).data if payroll else {}

    serializer = PayrollInformationSerializer(payroll, data=body, partial=bool(payroll))
    if not serializer.is_valid():
        return serializer_err(serializer)

    with transaction.atomic():
        payroll = serializer.save(candidate=candidate, completed_by=actor)
        set_stage(
            candidate, 'payroll',
            'Completed' if status_val == 'Completed' else 'In Progress', actor,
        )
        log_activity(
            candidate, f'Payroll {status_val}', actor,
            # The audit log deliberately stores the MASKED representation — an
            # account number must not survive in the activity trail.
            old_value=before, new_value=PayrollInformationSerializer(payroll).data,
        )
    return Response(PayrollInformationSerializer(payroll).data)


# ---------------------------------------------------------------------------
# Activation — the terminal state: the candidate becomes a real employee.
# ---------------------------------------------------------------------------
@api_view(['POST'])
@require_perm('onboarding.edit')
def candidate_activate(request, pk):
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)
    if candidate.status == 'Onboarding Completed':
        return err('Candidate is already onboarded', 409)

    # Every gate must be closed before someone becomes an employee. Without this
    # check, /activate would be a way to bypass the entire workflow.
    required = ['work_authorization', 'documents', 'hr_verification',
                'manager_approval', 'it_assets', 'payroll']
    done = set(
        candidate.stages.filter(stage__in=required, status='Completed')
        .values_list('stage', flat=True)
    )
    outstanding = [s for s in required if s not in done]
    if outstanding:
        return err(
            'Cannot activate — these stages are not complete: '
            + ', '.join(s.replace('_', ' ') for s in outstanding),
            409,
        )

    actor = _actor(request)
    with transaction.atomic():
        # Provision the login account. get_or_create so re-running against an
        # existing employee email adopts the account instead of colliding on the
        # unique index.
        user, created = AppUser.objects.get_or_create(
            email=candidate.email,
            defaults={
                'full_name': f'{candidate.first_name} {candidate.last_name}'.strip(),
                'initials': make_initials(f'{candidate.first_name} {candidate.last_name}'),
                'role': 'employee',
                'status': 'active',
                'role_ref': Role.objects.filter(name='Employee').first(),
            },
        )
        UserProfile.objects.update_or_create(
            email=candidate.email,
            defaults={
                'first_name': candidate.first_name or '',
                'last_name': candidate.last_name or '',
                'phone': candidate.phone or '',
                'department': candidate.department or '',
                'designation': candidate.job_title or '',
            },
        )
        candidate.status = 'Onboarding Completed'
        candidate.save()
        set_stage(candidate, 'activated', 'Completed', actor)
        log_activity(
            candidate, 'Employee Activated', actor,
            comments=('Login account created' if created else 'Existing login account linked'),
            new_value={'email': candidate.email, 'appUserId': user.id},
        )

    create_notification(
        candidate.email, 'Welcome to Eversoft',
        'Your onboarding is complete and your employee account is now active.',
        'success',
    )
    return Response({
        'ok': True,
        'candidate': OnboardingCandidateSerializer(candidate).data,
        'appUserId': user.id,
        'accountCreated': created,
    })


# ---------------------------------------------------------------------------
# Dashboard & alerts
# ---------------------------------------------------------------------------
@api_view(['GET'])
@require_perm('onboarding.view')
def onboarding_dashboard(request):
    live = OnboardingCandidate.objects.filter(is_deleted=False)
    today = date.today()
    soon = today + timedelta(days=EXPIRY_WARNING_DAYS)

    by_status = dict(
        live.values_list('status').annotate(n=Count('id')).values_list('status', 'n')
    )
    by_auth_type = dict(
        WorkAuthorization.objects.filter(candidate__is_deleted=False)
        .values_list('auth_type').annotate(n=Count('id')).values_list('auth_type', 'n')
    )

    expiring = live.filter(
        work_authorization__expiry_date__isnull=False,
        work_authorization__expiry_date__lte=soon,
        work_authorization__expiry_date__gte=today,
    ).count()

    # "Missing documents" means missing a MANDATORY doc, not merely having fewer
    # than five — a US citizen legitimately has no visa or I-94.
    missing_docs = sum(1 for c in live.prefetch_related('documents') if missing_mandatory_docs(c))

    # Onboarded candidates per month, last 6 months, for the trend chart.
    monthly = []
    for i in range(5, -1, -1):
        month = (today.replace(day=1) - timedelta(days=1)) if i else today
        y, m = today.year, today.month - i
        while m <= 0:
            m += 12
            y -= 1
        n = live.filter(
            status='Onboarding Completed', updated_at__year=y, updated_at__month=m,
        ).count()
        monthly.append({'month': f'{y}-{m:02d}', 'count': n})

    stage_counts = dict(
        OnboardingStatus.objects.filter(candidate__is_deleted=False)
        .values_list('status').annotate(n=Count('id')).values_list('status', 'n')
    )

    total = live.count()
    completed = by_status.get('Onboarding Completed', 0)
    rejected = by_status.get('Rejected', 0)
    return Response({
        'cards': {
            # The four headline cards from the spec.
            'totalCandidates': total,
            'pendingCandidates': total - completed - rejected,   # anything still in flight
            'completedCandidates': completed,
            'rejectedCandidates': rejected,
            # Extra operational counters (kept for the alerts strip / drill-downs).
            'missingDocuments': missing_docs,
            'expiringWorkAuth': expiring,
            'itAssetsPending': live.filter(stages__stage='it_assets', stages__status__in=['Pending', 'In Progress']).count(),
            'payrollPending': live.filter(stages__stage='payroll', stages__status__in=['Pending', 'In Progress']).count(),
        },
        'charts': {
            'workAuthDistribution': [{'label': k or 'Not set', 'count': v} for k, v in by_auth_type.items()],
            'candidateStatus': [{'label': k, 'count': v} for k, v in by_status.items()],
            'onboardingProgress': [{'label': k, 'count': v} for k, v in stage_counts.items()],
            'monthlyOnboarded': monthly,
        },
        'recent': {
            'candidates': OnboardingCandidateSerializer(
                live.select_related('work_authorization', 'hr_verification', 'payroll')
                .prefetch_related('stages')[:5], many=True,
            ).data,
            'documents': CandidateDocumentSerializer(
                CandidateDocument.objects.filter(
                    candidate__is_deleted=False, is_active=True,
                )[:5], many=True,
            ).data,
            'approvals': ManagerApprovalSerializer(
                ManagerApproval.objects.filter(
                    candidate__is_deleted=False, action='Approved',
                )[:5], many=True,
            ).data,
        },
    })


# ---------------------------------------------------------------------------
# Stage list endpoints
#
# One per sidebar page. Each returns the rows that page is actually about —
# a documents view wants document coverage, not a candidate roster — and each
# resolves in a single query rather than N+1 fetches per candidate.
# ---------------------------------------------------------------------------
def _live():
    return OnboardingCandidate.objects.filter(is_deleted=False)


def _who(c):
    return {
        'candidateId': c.id,
        'candidate': f'{c.first_name} {c.last_name}'.strip() or c.email,
        'email': c.email,
        'jobTitle': c.job_title or '',
        'department': c.department or '',
    }


@api_view(['GET'])
@require_perm('onboarding.view')
def work_authorization_list(request):
    """Visa status and expiry across all candidates.

    Candidates with no authorization yet are included deliberately — they are
    precisely the ones needing action, and omitting them would hide the work.
    """
    today = date.today()
    out = []
    for c in _live().select_related('work_authorization__detail'):
        a = getattr(c, 'work_authorization', None)
        row = _who(c)
        detail = getattr(a, 'detail', None) if a else None
        days = (a.expiry_date - today).days if (a and a.expiry_date) else None
        row.update({
            'authType': (a.auth_type or '') if a else '',
            'status': (a.status or '') if a else '',
            'expiryDate': a.expiry_date.strftime('%Y-%m-%d') if (a and a.expiry_date) else None,
            'daysToExpiry': days,
            'receiptNumber': (a.receipt_number or '') if a else '',
            'sponsorshipRequired': bool(a.sponsorship_required) if a else False,
            'details': (detail.details or {}) if detail else {},
        })
        out.append(row)
    return Response(out)


@api_view(['GET'])
@require_perm('onboarding.view')
def documents_list(request):
    """Document coverage per candidate — which are in, which are still missing."""
    out = []
    for c in _live().prefetch_related('documents'):
        active = [d for d in c.documents.all() if d.is_active]
        by_type = {d.doc_type: d for d in active}
        row = _who(c)
        row.update({
            'docs': {
                t: {
                    'fileName': by_type[t].file_name,
                    'version': by_type[t].version,
                    'uploadedAt': by_type[t].uploaded_at.strftime('%Y-%m-%d %H:%M:%S'),
                    'id': by_type[t].id,
                } if t in by_type else None
                for t in DOC_TYPES
            },
            'uploaded': len(active),
            'missing': missing_mandatory_docs(c),
            'totalVersions': c.documents.count(),
        })
        out.append(row)
    return Response(out)


@api_view(['GET'])
@require_perm('onboarding.view')
def verifications_list(request):
    """The HR verification queue."""
    out = []
    for c in _live().select_related('hr_verification').prefetch_related('documents'):
        v = getattr(c, 'hr_verification', None)
        row = _who(c)
        missing = missing_mandatory_docs(c)
        row.update({
            'status': (v.status or 'Pending') if v else 'Pending',
            'ssnVerified': bool(v.ssn_verified) if v else False,
            'driverLicenseVerified': bool(v.driver_license_verified) if v else False,
            'stateIdVerified': bool(v.state_id_verified) if v else False,
            'visaVerified': bool(v.visa_verified) if v else False,
            'i94Verified': bool(v.i94_verified) if v else False,
            'checked': sum([
                bool(v.ssn_verified), bool(v.driver_license_verified),
                bool(v.state_id_verified), bool(v.visa_verified), bool(v.i94_verified),
            ]) if v else 0,
            'remarks': (v.remarks or '') if v else '',
            'verifiedBy': (v.verified_by or '') if v else '',
            'verifiedAt': v.verified_at.strftime('%Y-%m-%d %H:%M:%S') if (v and v.verified_at) else None,
            'missing': missing,
            'blocked': bool(missing),
        })
        out.append(row)
    return Response(out)


@api_view(['GET'])
@require_perm('onboarding.view')
def asset_allocations_list(request):
    """One row per allocation, not per candidate — a person can hold a client
    laptop and an Eversoft laptop at once, and IT needs to see both."""
    out = []
    for c in _live().prefetch_related('asset_allocations'):
        allocs = list(c.asset_allocations.all())
        if not allocs:
            row = _who(c)
            row.update({
                'allocationId': None, 'assetSource': '', 'clientName': '',
                'assets': [], 'assetId': '', 'issuedDate': None,
                'status': 'Not allocated', 'allocatedBy': '',
            })
            out.append(row)
            continue
        for a in allocs:
            row = _who(c)
            row.update({
                'allocationId': a.id,
                'assetSource': a.asset_source or '',
                'clientName': a.client_name or '',
                'assets': a.assets or [],
                'assetId': a.asset_id or '',
                'issuedDate': a.issued_date.strftime('%Y-%m-%d') if a.issued_date else None,
                'status': a.status or 'Assigned',
                'allocatedBy': a.allocated_by or '',
            })
            out.append(row)
    return Response(out)


@api_view(['GET'])
@require_perm('onboarding.payroll')
def payroll_list(request):
    """Bank/tax details across candidates.

    Gated on onboarding.payroll, NOT onboarding.view — this is the one list a
    Manager or IT Admin must never see. Account numbers are masked here exactly
    as they are on the detail endpoint.
    """
    out = []
    for c in _live().select_related('payroll'):
        p = getattr(c, 'payroll', None)
        acct = (p.account_number or '').strip() if p else ''
        row = _who(c)
        row.update({
            'bankName': (p.bank_name or '') if p else '',
            'accountNumberMasked': ('*' * max(0, len(acct) - 4)) + acct[-4:] if acct else '',
            'routingNumber': (p.routing_number or '') if p else '',
            'taxState': (p.tax_state or '') if p else '',
            'directDeposit': bool(p.direct_deposit) if p else False,
            'status': (p.status or 'Pending') if p else 'Pending',
            'completedBy': (p.completed_by or '') if p else '',
        })
        out.append(row)
    return Response(out)


@api_view(['GET'])
@require_perm('onboarding.view')
def onboarding_alerts(request):
    """Everything needing human attention, newest deadline first."""
    live = OnboardingCandidate.objects.filter(is_deleted=False)
    today = date.today()
    soon = today + timedelta(days=EXPIRY_WARNING_DAYS)
    alerts = []

    expiring = live.filter(
        work_authorization__expiry_date__isnull=False,
        work_authorization__expiry_date__lte=soon,
    ).select_related('work_authorization')
    for c in expiring:
        auth = c.work_authorization
        days = (auth.expiry_date - today).days
        alerts.append({
            'type': 'expired' if days < 0 else 'expiring',
            'severity': 'error' if days < 0 else 'warning',
            'candidateId': c.id,
            'candidate': f'{c.first_name} {c.last_name}'.strip(),
            'message': (
                f'{auth.auth_type} expired {abs(days)} day(s) ago' if days < 0
                else f'{auth.auth_type} expires in {days} day(s)'
            ),
            'date': auth.expiry_date.strftime('%Y-%m-%d'),
            'days': days,
        })

    for c in live.prefetch_related('documents'):
        missing = missing_mandatory_docs(c)
        if missing:
            alerts.append({
                'type': 'missing_document',
                'severity': 'warning',
                'candidateId': c.id,
                'candidate': f'{c.first_name} {c.last_name}'.strip(),
                'message': f"Missing document(s): {', '.join(missing)}",
                'date': None,
                'days': None,
            })

    # Soonest deadline first; alerts with no date sort last.
    alerts.sort(key=lambda a: (a['days'] is None, a['days'] if a['days'] is not None else 0))
    return Response(alerts)
