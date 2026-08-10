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

from django.conf import settings
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
    OnboardingSetting,
    OnboardingStatus,
    PayrollInformation,
    Role,
    UserProfile,
    WorkAuthorization,
    WorkAuthorizationDetail,
    PayrollForm,
    CandidateFormSubmission,
)
from .permissions import require_perm, _get_caller, _is_super_admin
from .serializers import (
    CandidateDocumentSerializer,
    HrVerificationSerializer,
    ItAssetAllocationSerializer,
    ManagerApprovalSerializer,
    OnboardingActivityLogSerializer,
    OnboardingCandidateSerializer,
    PayrollInformationSerializer,
    WorkAuthorizationSerializer,
    PayrollFormSerializer,
    CandidateFormSubmissionSerializer,
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
from . import mailer

# ---------------------------------------------------------------------------
# Domain rules
# ---------------------------------------------------------------------------

# The visa types offered in the UI dropdown. Deliberately still a constant:
# a candidate's auth_type is stored as this string, so renaming or removing a
# type would orphan existing rows. The FIELDS each type carries are admin-
# configurable (see WORK_AUTH_TYPE_FIELDS_KEY) — the types themselves are not.
AUTH_TYPES = ['F1', 'H1B', 'GC EAD', 'US Citizen', 'H4 EAD', 'Other']

# The per-visa-type fields a tenant starts with, as (key, label, type). These
# are only defaults: they are published into the work_auth_type_fields schema on
# first read, after which an admin owns them and nothing here is enforced.
# Note the keys are NOT unique across types (eadNumber appears in GC EAD and H4
# EAD; issueDate/expiryDate in GC EAD and Other) — each type has its own blob,
# so uniqueness is scoped per type rather than across the form.
DEFAULT_WORK_AUTH_TYPE_FIELDS = {
    'H1B': [
        ('petitionNumber', 'Petition Number', 'text'),
        ('uscisReceipt', 'USCIS Receipt', 'text'),
        ('lcaNumber', 'LCA Number', 'text'),
        ('visaExpiry', 'Visa Expiry', 'date'),
    ],
    'F1': [
        ('university', 'University', 'text'),
        ('sevisNumber', 'SEVIS Number', 'text'),
        ('optStart', 'OPT Start', 'date'),
        ('optEnd', 'OPT End', 'date'),
        ('cptDetails', 'CPT Details', 'text'),
    ],
    'GC EAD': [
        ('eadNumber', 'EAD Number', 'text'),
        ('issueDate', 'Issue Date', 'date'),
        ('expiryDate', 'Expiry Date', 'date'),
    ],
    'H4 EAD': [
        ('h4ReceiptNumber', 'H4 Receipt Number', 'text'),
        ('eadNumber', 'EAD Number', 'text'),
        ('expiry', 'Expiry', 'date'),
    ],
    # A US Citizen needs no work-authorization paperwork at all, and "Other"
    # is a free-form escape hatch for visa types we do not model yet.
    'US Citizen': [],
    'Other': [
        ('visaType', 'Visa Type', 'text'),
        ('visaNumber', 'Visa Number', 'text'),
        ('issueDate', 'Issue Date', 'date'),
        ('expiryDate', 'Expiry Date', 'date'),
        ('notes', 'Notes', 'textarea'),
    ],
}

AUTH_STATUSES = ['Active', 'Pending', 'Expired', 'Extension Filed', 'Transferred', 'Rejected']

CANDIDATE_STATUSES = [
    'Draft', 'Pending Verification', 'Pending Approval', 'Approved', 'Rejected', 'Onboarded',
]

# Documents. SSN plus one government photo ID are mandatory; the visa documents
# only apply to non-citizens, so they stay optional here and are enforced (or
# not) by the HR verification stage instead.
DOC_TYPES = ['ssn', 'driver_license', 'state_id', 'visa', 'i94', 'passport']
MANDATORY_DOC_TYPES = ['ssn']
# Either of these satisfies the photo-ID requirement.
PHOTO_ID_DOC_TYPES = ['driver_license', 'state_id']

# A document the uploader named themselves gets a derived doc_type under this
# prefix, which keeps it inside the same version chain / is_active machinery as
# the fixed types while staying trivially distinguishable from them.
CUSTOM_DOC_PREFIX = 'custom_'
# doc_type is CharField(40); the prefix and a version-safe margin come out of
# that budget.
MAX_CUSTOM_DOC_SLUG = 40 - len(CUSTOM_DOC_PREFIX)
MAX_CUSTOM_DOC_LABEL = 120

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
ASSET_STATUSES = ['Assigned', 'Returned', 'Lost', 'Damaged','pending','Delivered']
EVERSOFT_ASSETS = ['Laptop', 'Monitor', 'Mouse', 'Keyboard', 'Dock', 'Bag', 'Headset','Office365','Email_ID','Software License','ID_Card','Desktop','Mobile']
PAYROLL_STATUSES = ['Pending', 'Completed']

# How far ahead a work authorization counts as "expiring soon" on the dashboard
# and in the alerts feed.
EXPIRY_WARNING_DAYS = 60

# Admin-built New Candidate form (a job-builder-style sectioned schema).
CANDIDATE_FORM_KEY = 'candidate_form'
# Admin-built Work Authorization tab: the fixed fields (as ``core`` entries that
# map to WorkAuthorization columns) plus any extra fields, in one sectioned
# schema — the same shape and builder as the candidate form.
WORK_AUTH_FORM_KEY = 'work_auth_form'
# Admin-built per-visa-type fields. One section per entry in AUTH_TYPES; the
# section id/title IS the type name, and its fields are that type's ``details``.
WORK_AUTH_TYPE_FIELDS_KEY = 'work_auth_type_fields'
# The full field-type palette, matching the Job Post builder.
CUSTOM_FIELD_TYPES = [
    'text', 'textarea', 'number', 'date', 'select', 'multiselect', 'radio',
    'checkbox', 'email', 'phone', 'url', 'file', 'currency', 'salary',
    'boolean', 'rating', 'heading', 'richtext',
]
# Types whose value is constrained to a defined option list (inline or master data).
OPTION_FIELD_TYPES = {'select', 'multiselect', 'radio'}
# Types that carry no stored value.
NO_VALUE_TYPES = {'heading'}
# Core candidate fields map 1:1 onto OnboardingCandidate columns. When the
# builder includes them (marked ``core``) they are rendered as the form's fixed
# top section and validated as columns, never as custom_fields — so their keys
# are allowed in the schema even though they would otherwise be reserved.
CORE_FIELD_KEYS = {
    'firstName', 'lastName', 'email', 'phone', 'client', 'vendor', 'recruiter',
    'jobTitle', 'department', 'joiningDate',
}
# A custom (non-core) field may not shadow a core column or its value would
# silently never reach the column it appears to set.
RESERVED_FIELD_KEYS = {k.lower() for k in CORE_FIELD_KEYS} | {'status', 'id', 'name'}

# The Work Authorization tab's fixed fields. They map 1:1 onto WorkAuthorization
# columns and are carried in the schema as ``core`` so an admin can relabel,
# reorder and require them — but never delete them or change their type, which
# would break the tab (authType in particular drives the whole form).
WORK_AUTH_CORE_FIELDS = [
    {'key': 'authType', 'label': 'Work Authorization Type', 'type': 'select',
     'required': True, 'width': 'half', 'core': True},
    {'key': 'status', 'label': 'Status', 'type': 'select',
     'required': False, 'width': 'half', 'core': True},
    {'key': 'expiryDate', 'label': 'Expiry Date', 'type': 'date',
     'required': False, 'width': 'half', 'core': True},
    {'key': 'receiptNumber', 'label': 'Receipt / Case Number', 'type': 'text',
     'required': False, 'width': 'half', 'core': True},
    {'key': 'sponsorshipRequired', 'label': 'Sponsorship required', 'type': 'checkbox',
     'required': False, 'width': 'full', 'core': True},
]
WORK_AUTH_CORE_KEYS = [f['key'] for f in WORK_AUTH_CORE_FIELDS]

DEFAULT_WORK_AUTH_FORM = {'sections': [{
    'id': 'sec_work_auth',
    'title': 'Work Authorization',
    'fields': [dict(f) for f in WORK_AUTH_CORE_FIELDS],
}]}

# A custom (non-core) work-auth field may not shadow a WorkAuthorization column,
# or its value would silently never reach the column it appears to set. The
# per-visa-type keys are deliberately NOT reserved: they live in their own
# ``details`` blob, and since they are admin-editable, deriving this set from
# them would let one edit retroactively invalidate an existing custom field.
WORK_AUTH_RESERVED_KEYS = (
    {k.lower() for k in WORK_AUTH_CORE_KEYS}
    | {'details', 'customfields', 'id'}
)


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
# Custom candidate form (admin-built, sectioned — like the Job Post builder)
#
# Schema shape, stored under OnboardingSetting['candidate_form']:
#   {'sections': [ {'id', 'title', 'fields': [ {field descriptor} ]} ]}
# A field descriptor is {key, label, type, required, placeholder, help, width,
# options?}. get_candidate_form() returns the sectioned form; form_fields()
# flattens it to the descriptor list that validation and display work from.
# ---------------------------------------------------------------------------
# The default New Candidate form — the core fields, as a builder schema. Shown
# in the builder canvas (marked ``core``) and rendered as the form's fixed top
# section until an admin customises and publishes their own.
DEFAULT_CANDIDATE_FORM = {'sections': [{
    'id': 'sec_candidate',
    'title': 'Candidate Details',
    'fields': [
        {'key': 'firstName', 'label': 'First Name', 'type': 'text', 'required': True, 'width': 'half', 'core': True},
        {'key': 'lastName', 'label': 'Last Name', 'type': 'text', 'width': 'half', 'core': True},
        {'key': 'email', 'label': 'Email', 'type': 'email', 'required': True, 'width': 'half', 'core': True},
        {'key': 'phone', 'label': 'Phone', 'type': 'phone', 'width': 'half', 'core': True},
        {'key': 'client', 'label': 'Client', 'type': 'text', 'width': 'half', 'core': True},
        {'key': 'vendor', 'label': 'Vendor', 'type': 'text', 'width': 'half', 'core': True},
        {'key': 'recruiter', 'label': 'Recruiter', 'type': 'text', 'width': 'half', 'core': True},
        {'key': 'jobTitle', 'label': 'Job Title', 'type': 'text', 'width': 'half', 'core': True},
        {'key': 'department', 'label': 'Department', 'type': 'text', 'width': 'half', 'core': True},
        {'key': 'joiningDate', 'label': 'Joining Date', 'type': 'date', 'width': 'half', 'core': True},
    ],
}]}


def get_candidate_form():
    """The current sectioned form. Falls back to the default core-field form so
    the builder and the New Candidate form are never empty."""
    row = OnboardingSetting.objects.filter(pk=CANDIDATE_FORM_KEY).first()
    val = (row.value if row else None) or {}
    sections = val.get('sections') if isinstance(val, dict) else None
    if not sections:
        return {'sections': [dict(s) for s in DEFAULT_CANDIDATE_FORM['sections']]}
    return {'sections': sections}


def form_fields(form=None, include_core=False):
    """Flatten a sectioned form to a list of field descriptors.

    Core fields are excluded by default: they map to candidate columns and are
    validated there, not as custom_fields.
    """
    form = form or get_candidate_form()
    out = []
    for sec in form.get('sections', []):
        for f in sec.get('fields', []):
            if f.get('core') and not include_core:
                continue
            out.append(f)
    return out


def _ensure_core_fields(sections):
    """Re-add any core work-auth field an edit dropped.

    The tab cannot function without them — authType drives which per-type fields
    render, and the rest map to columns the dashboard queries. The builder hides
    the delete control for core fields, so this is a backstop against a
    hand-crafted PUT, not the primary guard.
    """
    present = {
        f.get('key') for s in sections for f in s.get('fields', []) if f.get('core')
    }
    missing = [dict(f) for f in WORK_AUTH_CORE_FIELDS if f['key'] not in present]
    if not missing:
        return sections
    sections = [dict(s, fields=list(s.get('fields', []))) for s in sections]
    if not sections:
        sections = [{'id': 'sec_work_auth', 'title': 'Work Authorization', 'fields': []}]
    sections[0]['fields'] = missing + sections[0]['fields']
    return sections


def get_work_auth_form():
    """The Work Authorization tab's schema: core fields plus any extra ones."""
    row = OnboardingSetting.objects.filter(pk=WORK_AUTH_FORM_KEY).first()
    val = (row.value if row else None) or {}
    sections = val.get('sections') if isinstance(val, dict) else None
    if not sections:
        return {'sections': [dict(s) for s in DEFAULT_WORK_AUTH_FORM['sections']]}
    return {'sections': _ensure_core_fields(sections)}


def work_auth_fields():
    """Flat descriptor list for the work-auth EXTRA fields (core excluded)."""
    return form_fields(get_work_auth_form())


def _default_work_auth_type_sections():
    return [{
        'id': t,
        'title': t,
        'fields': [
            {'key': k, 'label': label, 'type': ftype, 'required': False,
             'placeholder': '', 'help': '', 'width': 'half', 'core': False}
            for (k, label, ftype) in DEFAULT_WORK_AUTH_TYPE_FIELDS.get(t, [])
        ],
    } for t in AUTH_TYPES]


def get_work_auth_type_form():
    """The per-visa-type schema, as one section per entry in AUTH_TYPES.

    Always returns every type in AUTH_TYPES order, whatever is stored: sections
    for unknown types are dropped and missing ones come back empty, so a type
    added to the constant needs no migration and a stale stored type cannot
    resurrect a dropdown entry.
    """
    row = OnboardingSetting.objects.filter(pk=WORK_AUTH_TYPE_FIELDS_KEY).first()
    val = (row.value if row else None) or {}
    stored = val.get('sections') if isinstance(val, dict) else None
    if not stored:
        return {'sections': _default_work_auth_type_sections()}
    by_type = {s.get('id'): s for s in stored if isinstance(s, dict)}
    return {'sections': [
        {'id': t, 'title': t, 'fields': (by_type.get(t) or {}).get('fields', []) or []}
        for t in AUTH_TYPES
    ]}


def work_auth_type_fields(auth_type):
    """Flat descriptor list of the fields a given visa type carries."""
    for s in get_work_auth_type_form()['sections']:
        if s['id'] == auth_type:
            return s['fields']
    return []


def _master_options(master_key):
    """Resolve a Master Data list's option values (shared with the job builder)."""
    from .models import MasterDataSet
    m = MasterDataSet.objects.filter(key=master_key).first()
    if not m:
        return None
    return [
        (o.get('value') if isinstance(o, dict) else o)
        for o in (m.options or [])
    ]


def _norm_options(raw):
    """Accept ['A','B'] or [{'value','label'}] -> [{'value','label'}]."""
    out = []
    for o in raw or []:
        if isinstance(o, dict):
            v = str(o.get('value', o.get('label', ''))).strip()
            l = str(o.get('label', v)).strip()
        else:
            v = l = str(o).strip()
        if v:
            out.append({'value': v, 'label': l or v})
    return out


def _clean_field(f, i, seen, reserved=None):
    """Validate/normalise one field descriptor. Returns (field, error).

    Preserves the full job-builder descriptor (placeholder, help, width,
    defaultValue, conditional, masterKey, currency) so the two builders share a
    schema shape. ``reserved`` is the set of lowercased keys this form may not
    shadow — it differs per form (candidate columns vs work-auth columns).
    """
    reserved = RESERVED_FIELD_KEYS if reserved is None else reserved
    if not isinstance(f, dict):
        return None, f'field #{i + 1} is not an object'
    is_core = bool(f.get('core'))
    # Keep the key's case (clients send camelCase, e.g. employeeId); only the
    # reserved/duplicate checks are case-insensitive.
    key = str(f.get('key') or '').strip()
    label = str(f.get('label') or '').strip()
    ftype = str(f.get('type') or 'text').strip()
    if not label:
        return None, f'field #{i + 1} needs a label'
    if ftype not in CUSTOM_FIELD_TYPES:
        return None, f'"{label}" has unknown type "{ftype}"'
    if ftype in NO_VALUE_TYPES:
        # A heading is a visual divider — no key/value, no reserved check.
        return {'key': key or f'heading_{i}', 'label': label, 'type': ftype,
                'width': 'full', 'core': False}, ''
    if not key:
        return None, f'field #{i + 1} ("{label}") needs a key'
    if not key.replace('_', '').isalnum():
        return None, f'"{key}" — keys may only contain letters, numbers and underscores'
    if not is_core and key.lower() in reserved:
        return None, f'"{key}" is a reserved field name'
    if key.lower() in seen:
        return None, f'duplicate field key "{key}"'
    seen.add(key.lower())
    field = {
        'key': key,
        'label': label,
        'type': ftype,
        'required': bool(f.get('required')),
        'placeholder': str(f.get('placeholder') or '').strip(),
        'help': str(f.get('help') or '').strip(),
        'width': 'half' if f.get('width') == 'half' else 'full',
        'core': is_core,
    }
    if f.get('defaultValue') not in (None, ''):
        field['defaultValue'] = f['defaultValue']
    # Conditional show/hide rule (same shape as the job builder).
    cond = f.get('conditional')
    if isinstance(cond, dict) and cond.get('field'):
        field['conditional'] = {
            'field': str(cond['field']),
            'operator': str(cond.get('operator') or 'equals'),
            'value': cond.get('value', ''),
        }
    if f.get('currency') is not None:
        field['currency'] = bool(f['currency'])
    # A core select (authType, status) draws its options from the application,
    # not the schema — requiring inline options would reject the defaults.
    if ftype in OPTION_FIELD_TYPES and not is_core:
        master_key = str(f.get('masterKey') or '').strip()
        if master_key:
            field['masterKey'] = master_key   # options come from Master Data
        else:
            field['options'] = _norm_options(f.get('options'))
            if not field['options']:
                return None, f'"{key}" is a {ftype} field but has no options'
    return field, ''


def clean_candidate_form(raw, reserved=None, unique_per_section=False):
    """Validate and normalise an incoming sectioned form.

    Returns ``(form, error)``. Field keys are unique across the WHOLE form,
    since values are stored in one flat JSON object. ``reserved`` selects which
    key blocklist applies; see _clean_field.

    ``unique_per_section`` scopes that uniqueness to each section instead. The
    per-visa-type schema needs it: every type has its own ``details`` blob, and
    the same key legitimately appears in more than one type (eadNumber in both
    GC EAD and H4 EAD), so a form-wide check would reject the defaults.
    """
    if not isinstance(raw, dict):
        return None, 'form must be an object with a "sections" list'
    sections_in = raw.get('sections')
    if not isinstance(sections_in, list):
        return None, 'form.sections must be a list'

    seen = set()
    idx = 0
    out_sections = []
    for s in sections_in:
        if not isinstance(s, dict):
            return None, 'each section must be an object'
        if unique_per_section:
            seen = set()
        fields_out = []
        for f in s.get('fields', []) or []:
            field, error = _clean_field(f, idx, seen, reserved)
            idx += 1
            if error:
                return None, error
            fields_out.append(field)
        # Drop empty sections — they would render as a stray heading.
        if fields_out:
            out_sections.append({
                'id': str(s.get('id') or f'sec_{len(out_sections) + 1}'),
                'title': str(s.get('title') or '').strip(),
                'fields': fields_out,
            })
    return {'sections': out_sections}, ''


def _field_options(f):
    """Allowed option values for a field — from Master Data if masterKey is set,
    else the inline options. Returns None when the source is unknown (a deleted
    Master Data list), in which case membership is not enforced."""
    if f.get('masterKey'):
        return _master_options(f['masterKey'])
    return [o['value'] for o in f.get('options', [])]


def clean_custom_values(values, fields):
    """Validate submitted custom-field values against the flattened field list.

    Returns ``(cleaned, error)``. Drops unknown keys, enforces required fields,
    checks option membership (single and multi, incl. Master Data lists), and
    coerces numbers — so a stale form or a tampered payload cannot write junk
    into the JSON column.
    """
    values = values if isinstance(values, dict) else {}
    cleaned = {}
    for f in fields:
        ftype = f['type']
        if ftype in NO_VALUE_TYPES:
            continue
        key = f['key']
        raw = values.get(key)
        present = key in values and raw not in (None, '', [])
        if not present:
            if f.get('required'):
                return None, f"{f['label']} is required"
            continue
        if ftype == 'number':
            try:
                n = float(raw)
                cleaned[key] = int(n) if n == int(n) else n
            except (TypeError, ValueError):
                return None, f"{f['label']} must be a number"
        elif ftype == 'multiselect':
            allowed = _field_options(f)
            vals = raw if isinstance(raw, list) else [raw]
            picked = [str(v) for v in vals if str(v)]
            if allowed is not None:
                bad = [v for v in picked if v not in allowed]
                if bad:
                    return None, f"{f['label']}: {', '.join(bad)} not in the allowed options"
            cleaned[key] = picked
        elif ftype in ('select', 'radio'):
            allowed = _field_options(f)
            if allowed is not None and str(raw) not in allowed:
                return None, f"{f['label']}: \"{raw}\" is not an allowed option"
            cleaned[key] = str(raw)
        else:
            # text/textarea/richtext/email/phone/url/date/file/currency/salary/
            # boolean/checkbox/rating — stored as the string the form produced.
            cleaned[key] = str(raw)
    return cleaned, ''


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------
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

    payload = dict(body)
    payload['email'] = email
    serializer = OnboardingCandidateSerializer(data=payload)
    if not serializer.is_valid():
        return serializer_err(serializer)

    custom, cerror = clean_custom_values(body.get("customFields"), form_fields())
    if cerror:
        return err(cerror)

    DEFAULT_REQUESTED_DOCS = [
        {'type': 'ssn', 'label': 'SSN', 'required': True, 'sendToCandidate': True},
        {'type': 'driver_license', 'label': 'Driver License', 'required': False, 'sendToCandidate': True},
        {'type': 'state_id', 'label': 'State ID', 'required': False, 'sendToCandidate': False},
        {'type': 'visa', 'label': 'Visa (Work Authorization)', 'required': False, 'sendToCandidate': True},
        {'type': 'i94', 'label': 'I-94', 'required': False, 'sendToCandidate': True},
        {'type': 'passport', 'label': 'Passport', 'required': False, 'sendToCandidate': True}
    ]

    actor = _actor(request)
    with transaction.atomic():
        candidate = serializer.save(
            created_by=actor,
            custom_fields=custom,
            requested_docs=body.get('requestedDocs') or DEFAULT_REQUESTED_DOCS
        )
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

    # Merge custom fields onto whatever is already stored, so a partial update
    # that omits customFields leaves them untouched.
    custom = None
    if 'customFields' in body:
        merged = dict(candidate.custom_fields or {})
        merged.update(body.get('customFields') or {})
        custom, cerror = clean_custom_values(merged, form_fields())
        if cerror:
            return err(cerror)

    before = OnboardingCandidateSerializer(candidate).data
    serializer = OnboardingCandidateSerializer(candidate, data=body, partial=True)
    if not serializer.is_valid():
        return serializer_err(serializer)

    with transaction.atomic():
        if custom is not None:
            candidate.custom_fields = custom
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


@api_view(['GET', 'PUT'])
@require_perm({'GET': 'onboarding.view', 'PUT': 'onboarding.settings'})
def candidate_field_config(request):
    """The admin-built New Candidate form (sectioned, job-builder-style).

    GET is open to anyone who can view onboarding (the form needs it to render);
    PUT — editing the form — requires onboarding.settings. ``fields`` (the flat
    list) is returned alongside ``sections`` as a convenience for callers that
    only need to render or validate values.
    """
    if request.method == 'GET':
        form = get_candidate_form()
        # ``schema`` is the job-builder-compatible alias for ``sections``.
        return Response({
            'sections': form['sections'],
            'schema': form['sections'],
            'fields': form_fields(form),
        })

    # The builder posts {schema: [sections]}; accept {sections: [...]} too.
    payload = request.data
    if isinstance(payload.get('schema'), list):
        payload = {'sections': payload['schema']}
    form, error = clean_candidate_form(payload)
    if error:
        return err(error)
    actor = _actor(request)
    OnboardingSetting.objects.update_or_create(
        pk=CANDIDATE_FORM_KEY,
        defaults={'value': form, 'updated_by': actor},
    )
    return Response({
        'sections': form['sections'],
        'schema': form['sections'],
        'fields': form_fields(form),
    })


@api_view(['GET', 'PUT'])
@require_perm({'GET': 'onboarding.view', 'PUT': 'onboarding.settings'})
def work_auth_field_config(request):
    """The Work Authorization tab's schema — core fields plus extra ones.

    Twin of candidate_field_config, against WORK_AUTH_FORM_KEY. These apply to
    every candidate regardless of visa type; the fields that vary BY type live
    in work_auth_type_field_config instead.
    """
    if request.method == 'GET':
        form = get_work_auth_form()
        return Response({
            'sections': form['sections'],
            'schema': form['sections'],
            'fields': form_fields(form),
        })

    payload = request.data
    if isinstance(payload.get('schema'), list):
        payload = {'sections': payload['schema']}
    form, error = clean_candidate_form(payload, reserved=WORK_AUTH_RESERVED_KEYS)
    if error:
        return err(error)
    # Re-inject before storing, not just on read, so what is saved and returned
    # here is what a subsequent GET reports.
    form = {'sections': _ensure_core_fields(form['sections'])}
    OnboardingSetting.objects.update_or_create(
        pk=WORK_AUTH_FORM_KEY,
        defaults={'value': form, 'updated_by': _actor(request)},
    )
    return Response({
        'sections': form['sections'],
        'schema': form['sections'],
        'fields': form_fields(form),
    })


@api_view(['GET', 'PUT'])
@require_perm({'GET': 'onboarding.view', 'PUT': 'onboarding.settings'})
def work_auth_type_field_config(request):
    """The per-visa-type fields, as one section per type.

    Modelling each visa type as a section lets the existing form builder edit it
    unchanged. The set of types is fixed (see AUTH_TYPES), so sections cannot be
    added, removed or renamed here — only their fields.
    """
    if request.method == 'GET':
        form = get_work_auth_type_form()
        return Response({
            'sections': form['sections'],
            'schema': form['sections'],
            'types': AUTH_TYPES,
        })

    payload = request.data
    if isinstance(payload.get('schema'), list):
        payload = {'sections': payload['schema']}
    # Keys are scoped per type, and nothing is reserved: these live in their own
    # ``details`` blob, so they cannot collide with a WorkAuthorization column.
    form, error = clean_candidate_form(payload, reserved=set(), unique_per_section=True)
    if error:
        return err(error)
    # Normalise through the same reader the rest of the code uses, so an unknown
    # or missing type is reconciled against AUTH_TYPES before it is stored.
    by_type = {s['id']: s for s in form['sections']}
    sections = [
        {'id': t, 'title': t, 'fields': (by_type.get(t) or {}).get('fields', []) or []}
        for t in AUTH_TYPES
    ]
    OnboardingSetting.objects.update_or_create(
        pk=WORK_AUTH_TYPE_FIELDS_KEY,
        defaults={'value': {'sections': sections}, 'updated_by': _actor(request)},
    )
    return Response({'sections': sections, 'schema': sections, 'types': AUTH_TYPES})


@api_view(['GET', 'POST'])
@require_perm({'GET': 'onboarding.view', 'POST': 'onboarding.settings'})
def candidate_form_templates(request):
    """Saved New-Candidate form templates (twin of the job-form templates)."""
    from .models import OnboardingFormTemplate
    if request.method == 'GET':
        return Response([{
            'id': t.id, 'name': t.name, 'isActive': t.is_active,
            'fields': len(t.schema or []),
            'updatedAt': t.updated_at.strftime('%Y-%m-%d %H:%M') if t.updated_at else '',
        } for t in OnboardingFormTemplate.objects.all()])

    name = (request.data.get('name') or '').strip()
    if not name:
        return err('name is required')
    if OnboardingFormTemplate.objects.filter(name=name).exists():
        return err('A template with this name already exists', 409)
    schema = request.data.get('schema')
    t = OnboardingFormTemplate.objects.create(
        name=name,
        schema=schema if isinstance(schema, list) else [],
        created_by=_actor(request),
    )
    return Response({'id': t.id, 'name': t.name}, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'onboarding.view', 'PUT': 'onboarding.settings', 'DELETE': 'onboarding.settings'})
def candidate_form_template_detail(request, pk):
    from .models import OnboardingFormTemplate
    t = OnboardingFormTemplate.objects.filter(pk=pk).first()
    if not t:
        return err('Template not found', 404)
    if request.method == 'GET':
        return Response({'id': t.id, 'name': t.name, 'isActive': t.is_active, 'schema': t.schema or []})
    if request.method == 'DELETE':
        if t.is_active:
            return err('Cannot delete the active form — activate another template first.', 409)
        t.delete()
        return Response({'ok': True})

    body = request.data
    if isinstance(body.get('schema'), list):
        t.schema = body['schema']
    name = (body.get('name') or '').strip()
    if name and name != t.name and not OnboardingFormTemplate.objects.filter(name=name).exclude(pk=t.pk).exists():
        t.name = name
    if body.get('activate'):
        # Activating a template also publishes it as the live New Candidate form.
        form, error = clean_candidate_form({'sections': t.schema or []})
        if error:
            return err(f'Template is invalid: {error}')
        OnboardingFormTemplate.objects.exclude(pk=t.pk).update(is_active=False)
        t.is_active = True
        OnboardingSetting.objects.update_or_create(
            pk=CANDIDATE_FORM_KEY, defaults={'value': form, 'updated_by': _actor(request)},
        )
    t.save()
    return Response({'id': t.id, 'name': t.name, 'isActive': t.is_active, 'schema': t.schema})


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
def _check_core_required(body, form):
    """Enforce ``required`` on the core work-auth fields an admin marked.

    Returns an error string, or '' when the payload is fine. Booleans are
    skipped: an unticked checkbox is a legitimate answer, so "required" on one
    would be unsatisfiable.
    """
    for f in form_fields(form, include_core=True):
        if not (f.get('core') and f.get('required')):
            continue
        if f['type'] in ('checkbox', 'boolean'):
            continue
        if body.get(f['key']) in (None, '', []):
            return f"{f['label']} is required"
    return ''


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
    if auth_type not in AUTH_TYPES:
        return err(f"authType must be one of: {', '.join(AUTH_TYPES)}")

    status_val = (body.get('status') or 'Pending').strip()
    if status_val not in AUTH_STATUSES:
        return err(f"status must be one of: {', '.join(AUTH_STATUSES)}")

    form = get_work_auth_form()
    error = _check_core_required(body, form)
    if error:
        return err(error)

    # Reject unknown keys rather than quietly storing them — the details blob is
    # schemaless, so this validation is the only thing standing between a
    # frontend typo and unqueryable garbage. The allowed set is now admin-built
    # rather than hardcoded, but it is enforced exactly as strictly.
    incoming = body.get('details') or {}
    if not isinstance(incoming, dict):
        return err('details must be an object')
    type_fields = work_auth_type_fields(auth_type)
    allowed = [f['key'] for f in type_fields]
    unknown = [k for k in incoming if k not in allowed]
    if unknown:
        return err(
            f"Unknown field(s) for {auth_type}: {', '.join(sorted(unknown))}. "
            f"Allowed: {', '.join(allowed) or 'none'}"
        )
    details, error = clean_custom_values(incoming, type_fields)
    if error:
        return err(error)

    # The admin-built extra fields apply to every auth type, so they are
    # validated against their own schema rather than the per-type whitelist.
    custom, error = clean_custom_values(body.get('customFields'), form_fields(form))
    if error:
        return err(error)

    # Values whose field is no longer configured for this type — because an admin
    # removed or renamed it, or the candidate switched visa type — are carried
    # through untouched rather than dropped. They stop rendering, but re-adding a
    # field with the same key brings the value back.
    existing_detail = getattr(auth, 'detail', None) if auth else None
    kept = {
        k: v for k, v in ((existing_detail.details if existing_detail else None) or {}).items()
        if k not in allowed
    }
    details = {**kept, **details}

    actor = _actor(request)
    before = WorkAuthorizationSerializer(auth).data if auth else {}

    serializer = WorkAuthorizationSerializer(auth, data=body, partial=bool(auth))
    if not serializer.is_valid():
        return serializer_err(serializer)

    with transaction.atomic():
        auth = serializer.save(candidate=candidate, custom_fields=custom)
        WorkAuthorizationDetail.objects.update_or_create(
            work_authorization=auth, defaults={'details': details},
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
def custom_doc_slug(label):
    """Derive a stable ``custom_<slug>`` doc_type from a user-supplied name.

    Returns ``(doc_type, error)``. The slug is what makes re-uploading under the
    same name supersede the previous file (version+1) instead of creating a
    second row the verifier would see twice — so it must be deterministic.
    """
    label = (label or '').strip()
    if not label:
        return '', 'label is required for a custom document'
    if len(label) > MAX_CUSTOM_DOC_LABEL:
        return '', f'label must be {MAX_CUSTOM_DOC_LABEL} characters or fewer'
    slug = ''.join(ch if ch.isalnum() else '_' for ch in label.lower()).strip('_')
    while '__' in slug:
        slug = slug.replace('__', '_')
    slug = slug[:MAX_CUSTOM_DOC_SLUG].strip('_')
    if not slug:
        return '', 'label must contain at least one letter or number'
    doc_type = CUSTOM_DOC_PREFIX + slug
    # A custom document named "SSN" would collide with the fixed type and land
    # in its version chain, so reject rather than silently merge.
    if doc_type in DOC_TYPES or slug in DOC_TYPES:
        return '', f'"{label}" is a built-in document type — pick another name'
    return doc_type, ''


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
    # A custom document is named by the uploader; its docType is derived from
    # that name rather than chosen from the fixed list.
    is_custom = bool(body.get('isCustom'))
    label = (body.get('label') or '').strip()
    if is_custom:
        doc_type, error = custom_doc_slug(label)
        if error:
            return err(error)
    else:
        doc_type = (body.get('docType') or '').strip().lower()
        if doc_type not in DOC_TYPES:
            return err(f"docType must be one of: {', '.join(DOC_TYPES)}")
        label = ''

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
            # Re-uploading keeps the original name so the whole version chain
            # reads consistently rather than renaming itself retroactively.
            label=(previous.label if previous and previous.label else label),
            is_custom=is_custom,
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
            comments=f'{doc.label or doc_type} (v{version})',
            new_value={'docType': doc_type, 'label': doc.label,
                       'fileName': doc.file_name, 'version': version},
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
    # Custom doc_types are per-candidate, so they cannot be validated against a
    # constant — existence on this candidate is the check.
    if doc_type not in DOC_TYPES and not doc_type.startswith(CUSTOM_DOC_PREFIX):
        return err(f"docType must be one of: {', '.join(DOC_TYPES)}")
    qs = candidate.documents.filter(doc_type=doc_type).order_by('-version')
    if not qs.exists():
        return err('Document not found', 404)
    return Response(CandidateDocumentSerializer(qs, many=True).data)


# ---------------------------------------------------------------------------
# HR verification
# ---------------------------------------------------------------------------
def missing_mandatory_docs(candidate):
    """Which required documents are still absent."""
    present = set(
        candidate.documents.filter(is_active=True).values_list('doc_type', flat=True)
    )
    present_labels = set(
        candidate.documents.filter(is_active=True, is_custom=True).values_list('label', flat=True)
    )
    present_labels_lower = {l.lower() for l in present_labels if l}

    req_list = candidate.requested_docs or []
    if not req_list:
        missing = [d for d in MANDATORY_DOC_TYPES if d not in present]
        if not (present & set(PHOTO_ID_DOC_TYPES)):
            missing.append('driver_license or state_id')
        return missing

    missing = []
    for item in req_list:
        if item.get('required') and item.get('sendToCandidate'):
            t = item['type']
            lbl = item.get('label', '')
            
            uploaded = False
            if t in present or f"custom_{t}" in present:
                uploaded = True
            elif lbl and lbl.lower() in present_labels_lower:
                uploaded = True
                
            if not uploaded:
                if t in PHOTO_ID_DOC_TYPES:
                    other_type = 'state_id' if t == 'driver_license' else 'driver_license'
                    if other_type in present:
                        continue
                missing.append(lbl or t)
    return missing


def custom_docs(candidate):
    """The candidate's custom documents, as ``[{docType, label}]``.

    Custom documents are ad-hoc, so the verification checklist cannot be a
    constant like CHECKS — it has to be derived per candidate.
    """
    return [
        {'docType': d.doc_type, 'label': d.label or d.doc_type}
        for d in candidate.documents.filter(is_custom=True, is_active=True)
                                    .order_by('uploaded_at')
    ]


def clean_custom_verified(raw, candidate):
    """Keep only tick-boxes that correspond to a live custom document.

    A document can be deleted after it was ticked; carrying that stale True
    forward would show a checked box against a document that is not there.
    """
    raw = raw if isinstance(raw, dict) else {}
    live = {d['docType'] for d in custom_docs(candidate)}
    return {k: bool(v) for k, v in raw.items() if k in live}


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
        # The custom checklist is per-candidate, so the UI is told what to render.
        data['customDocuments'] = custom_docs(candidate)
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

    now = datetime.now()
    # requested_on is stamped once, when the check is first raised; completed_on
    # only once HR has actually decided, so a Pending save leaves it empty.
    extra = {}
    if not (verification and verification.requested_on) and 'requestedOn' not in body:
        extra['requested_on'] = now
    if status_val in ('Approved', 'Rejected') and 'completedOn' not in body:
        extra['completed_on'] = now
    elif status_val == 'Pending' and 'completedOn' not in body:
        extra['completed_on'] = None

    with transaction.atomic():
        verification = serializer.save(
            candidate=candidate, verified_by=actor, verified_at=now,
            custom_verified=clean_custom_verified(body.get('customVerified'), candidate),
            **extra,
        )
        if status_val == 'Approved':
            # HR signing off IS what closes the documents stage: an upload alone
            # only means a file arrived, not that it was the right one.
            set_stage(candidate, 'documents', 'Completed', actor)
            set_stage(candidate, 'hr_verification', 'Completed', actor)
            set_stage(candidate, 'manager_approval', 'In Progress', actor)
            candidate.status = 'Pending Approval'
        elif status_val == 'Rejected':
            set_stage(candidate, 'hr_verification', 'Rejected', actor)
            candidate.status = 'Rejected'
        else:
            set_stage(candidate, 'hr_verification', 'In Progress', actor)
            candidate.status = 'Pending Verification'
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
    data['customDocuments'] = custom_docs(candidate)
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
            candidate.status = 'Approved'
        elif action == 'Rejected':
            set_stage(candidate, 'manager_approval', 'Rejected', actor)
            candidate.status = 'Rejected'
        else:  # Returned for correction — reopen the verification stage.
            set_stage(candidate, 'manager_approval', 'Pending', actor)
            set_stage(candidate, 'hr_verification', 'In Progress', actor)
            candidate.status = 'Pending Verification'
            if verification:
                verification.status = 'Pending'
                verification.save()
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

    # -------------------------------------------------------------------
    # Validation to enforce HR verification and manager approval before asset allocation.
    # Users cannot allocate assets until HR Verification and Manager Approval are completed.
    # -------------------------------------------------------------------
    # if request.method == 'GET':
    #     return Response(ItAssetAllocationSerializer(candidate.asset_allocations.all(), many=True).data)
    
    # hr_stage = candidate.stages.filter(stage='hr_verification').first()

    # if not hr_stage or hr_stage.status != 'Completed':
    #     return err('Cannot allocate assets until HR verification is completed.',409,)

    
    # manager_stage = candidate.stages.filter(stage='manager_approval').first()

    # if not manager_stage or manager_stage.status != 'Completed':
    #     return err('Cannot allocate assets until manager approval is completed.',409,)

    # -------------------------------------------------------------------

    if request.method == 'GET':
        return Response(ItAssetAllocationSerializer(candidate.asset_allocations.all(), many=True).data)

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
    if candidate.status == 'Onboarded':
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
        candidate.status = 'Onboarded'
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
            status='Onboarded', updated_at__year=y, updated_at__month=m,
        ).count()
        monthly.append({'month': f'{y}-{m:02d}', 'count': n})

    stage_counts = dict(
        OnboardingStatus.objects.filter(candidate__is_deleted=False)
        .values_list('status').annotate(n=Count('id')).values_list('status', 'n')
    )

    return Response({
        'cards': {
            'totalCandidates': live.count(),
            'pendingVerification': by_status.get('Pending Verification', 0),
            'pendingApproval': by_status.get('Pending Approval', 0),
            'completedOnboarding': by_status.get('Onboarded', 0),
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
        
        req_list = c.requested_docs or []
        if not req_list:
            req_list = [
                {'type': 'ssn', 'label': 'SSN', 'required': True, 'sendToCandidate': True},
                {'type': 'driver_license', 'label': 'Driver License', 'required': False, 'sendToCandidate': True},
                {'type': 'state_id', 'label': 'State ID', 'required': False, 'sendToCandidate': False},
                {'type': 'visa', 'label': 'Visa (Work Authorization)', 'required': False, 'sendToCandidate': True},
                {'type': 'i94', 'label': 'I-94', 'required': False, 'sendToCandidate': True},
                {'type': 'passport', 'label': 'Passport', 'required': False, 'sendToCandidate': True}
            ]
            
        docs_data = {}
        for t in DOC_TYPES:
            docs_data[t] = {
                'fileName': by_type[t].file_name,
                'version': by_type[t].version,
                'uploadedAt': by_type[t].uploaded_at.strftime('%Y-%m-%d %H:%M:%S') if by_type[t].uploaded_at else None,
                'id': by_type[t].id,
            } if t in by_type else None

        for item in req_list:
            t = item['type']
            if t.startswith('custom_') or t not in DOC_TYPES:
                doc = by_type.get(t) or by_type.get(f"custom_{t}")
                if not doc:
                    for d in active:
                        if d.label and d.label.lower() == item.get('label', '').lower():
                            doc = d
                            break
                docs_data[t] = {
                    'fileName': doc.file_name,
                    'version': doc.version,
                    'uploadedAt': doc.uploaded_at.strftime('%Y-%m-%d %H:%M:%S') if doc.uploaded_at else None,
                    'id': doc.id,
                } if doc else None

        sent_items = [item for item in req_list if item.get('sendToCandidate')]
        uploaded_count = 0
        for item in sent_items:
            t = item['type']
            if t in by_type or f"custom_{t}" in by_type:
                uploaded_count += 1
            else:
                for d in active:
                    if d.doc_type == t or d.doc_type == f"custom_{t}" or (d.label and d.label.lower() == item.get('label', '').lower()):
                        uploaded_count += 1
                        break

        row = _who(c)
        row.update({
            'docs': docs_data,
            'requestedDocs': req_list,
            'uploaded': uploaded_count,
            'totalRequested': len(sent_items),
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
            'verificationId': v.id if v else None,
            'employeeId': (v.employee_id or '') if v else '',
            'verificationType': (v.verification_type or '') if v else '',
            'vendorName': (v.vendor_name or '') if v else '',
            'requestedOn': v.requested_on.strftime('%Y-%m-%d %H:%M:%S') if (v and v.requested_on) else None,
            'completedOn': v.completed_on.strftime('%Y-%m-%d %H:%M:%S') if (v and v.completed_on) else None,
            'reportPath': (v.report_path or '') if v else '',
            'status': (v.status or 'Pending') if v else 'Pending',
            'ssnVerified': bool(v.ssn_verified) if v else False,
            'driverLicenseVerified': bool(v.driver_license_verified) if v else False,
            'stateIdVerified': bool(v.state_id_verified) if v else False,
            'visaVerified': bool(v.visa_verified) if v else False,
            'i94Verified': bool(v.i94_verified) if v else False,
            'passportVerified': bool(v.passport_verified) if v else False,
            'identityVerified': bool(v.identity_verified) if v else False,
            'educationVerified': bool(v.education_verified) if v else False,
            'employmentVerified': bool(v.employment_verified) if v else False,
            'addressVerified': bool(v.address_verified) if v else False,
            'criminalVerified': bool(v.criminal_verified) if v else False,
            'referenceVerified': bool(v.reference_verified) if v else False,
            'checked': sum([
                bool(v.ssn_verified), bool(v.driver_license_verified),
                bool(v.state_id_verified), bool(v.visa_verified), bool(v.i94_verified),
                bool(v.passport_verified),
            ]) if v else 0,
            # Counted separately from the documents: the two lists answer
            # different questions, so a combined "8 / 12" would say nothing.
            'backgroundChecked': sum([
                bool(v.identity_verified), bool(v.education_verified),
                bool(v.employment_verified), bool(v.address_verified),
                bool(v.criminal_verified), bool(v.reference_verified),
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


# ===========================================================================
# Electronic Payroll Forms & Signature Portal APIs
# ===========================================================================

import uuid

@api_view(['POST'])
@require_perm('onboarding.edit')
def send_portal_link(request, pk):
    """Generate a secure onboarding/payroll forms portal link and email it to the candidate."""
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)

    token = uuid.uuid4().hex
    candidate.portal_token = token
    candidate.portal_token_expires_at = datetime.now() + timedelta(days=7)
    candidate.save()

    # Build the portal URL.  In production the admin sets HRMS_PUBLIC_URL in
    # .env (e.g. https://hrms.eversoftit.com) so the candidate receives a link
    # that works on their machine, not just on the local dev server.
    public_base = getattr(settings, 'HRMS_PUBLIC_URL', '').rstrip('/')
    if not public_base:
        scheme = request.scheme
        host = request.get_host()
        public_base = f"{scheme}://{host}"
    portal_url = f"{public_base}/onboarding/fill?token={token}"

    subject = "Action Required: Complete your Onboarding & Payroll Forms"
    today_str = datetime.now().strftime("%B %d, %Y")
    joining_date_str = candidate.joining_date.strftime("%B %d, %Y") if candidate.joining_date else "—"

    # Logo URL
    logo_url = f"{public_base}/logo.jpg"

    # The candidate's own onboarding details — Position/Department/Joining Date,
    # never the recruiter or other internal fields. A row is shown only when the
    # candidate actually has that value; blank fields are left out entirely.
    details_list = []
    if candidate.job_title:
        details_list.append(('Position', candidate.job_title))
    if candidate.department:
        details_list.append(('Department', candidate.department))
    if candidate.joining_date:
        details_list.append(('Joining Date', joining_date_str))

    rows_html = ""
    for i, (label, val) in enumerate(details_list):
        is_last = i == len(details_list) - 1
        border_style = "" if is_last else 'border-bottom:1px solid #f1f5f9;'
        rows_html += f"""
                      <tr>
                        <td width="30%" style="font-weight:600;padding:8px 0;color:#64748b;{border_style}">{label}</td>
                        <td style="padding:8px 0;color:#1e293b;{border_style}">{val}</td>
                      </tr>
        """

    card_html = ""
    if details_list:
        card_html = f"""
              <!-- Details Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;background-color:#fafcfb;">
                <!-- Card Header -->
                <tr>
                  <td style="background-color:#eefcf7;padding:12px 16px;border-bottom:1px solid #e2e8f0;">
                    <div style="font-size:11px;font-weight:800;color:#007f56;letter-spacing:1px;text-transform:uppercase;">Onboarding Details</div>
                  </td>
                </tr>
                <!-- Card Rows -->
                <tr>
                  <td style="padding:8px 16px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:1.8;color:#475569;">
                      {rows_html}
                    </table>
                  </td>
                </tr>
              </table>
        """

    social_html = (
        '<div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;">'
        '  <span style="display:inline-block;width:32px;height:32px;border-radius:50%;background:#0f9d58;color:#fff;text-align:center;line-height:32px;font-weight:bold;font-size:14px;margin:0 4px;">W</span>'
        '  <span style="display:inline-block;width:32px;height:32px;border-radius:50%;background:#0077b5;color:#fff;text-align:center;line-height:32px;font-weight:bold;font-size:14px;margin:0 4px;">in</span>'
        '  <span style="display:inline-block;width:32px;height:32px;border-radius:50%;background:#1877f2;color:#fff;text-align:center;line-height:32px;font-weight:bold;font-size:14px;margin:0 4px;">f</span>'
        '</div>'
    )

    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,0.06);border:1px solid #e2e8f0;">
          <!-- Teal Header Banner -->
          <tr>
            <td style="background:linear-gradient(135deg,#007f56 0%,#0f9d58 100%);padding:20px 30px;vertical-align:middle;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="54" style="vertical-align:middle;">
                    <!-- Logo container -->
                    <img src="{logo_url}" alt="Logo" style="width:44px;height:44px;border-radius:8px;object-fit:contain;background:#ffffff;border:1.5px solid #e2e8f0;display:block;">
                  </td>
                  <td style="vertical-align:middle;padding-left:12px;color:#ffffff;">
                    <div style="font-size:18px;font-weight:800;letter-spacing:0.5px;line-height:1.2;">EverSoft Technologies LLC</div>
                    <div style="font-size:12px;opacity:0.85;margin-top:2px;font-weight:500;">Human Resources Department</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content Body -->
          <tr>
            <td style="padding:32px 30px;color:#1e293b;">
              <!-- Date -->
              <div style="font-size:13px;color:#94a3b8;margin-bottom:18px;font-weight:600;">{today_str}</div>
              
              <!-- Salutation -->
              <p style="font-size:15px;margin:0 0 16px;line-height:1.5;">Dear <strong style="color:#0f9d58;">{candidate.first_name} {candidate.last_name}</strong>,</p>
              
              <!-- Intro -->
              <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 24px;">
                We are pleased to inform you that your onboarding setup at <strong>EverSoft Technologies</strong> has been successfully initiated. Please review the details below and proceed to complete your required documents and payroll forms in our candidate portal.
              </p>
              
              {card_html}
              
              <!-- Join Button -->
              <div style="text-align:center;margin:28px 0;">
                <a href="{portal_url}" style="background-color:#0f9d58;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;box-shadow:0 4px 12px rgba(15,157,88,0.25);">
                  Join Onboarding Portal
                </a>
              </div>
              
              <!-- Copy URL Hint -->
              <p style="font-size:12px;color:#94a3b8;text-align:center;margin:0 0 6px;">If the button above does not work, copy and paste this URL into your browser:</p>
              <p style="font-size:11px;text-align:center;word-break:break-all;margin:0 0 24px;">
                <a href="{portal_url}" style="color:#0f9d58;text-decoration:underline;">{portal_url}</a>
              </p>
              
              <!-- Guidelines -->
              <p style="font-size:13.5px;line-height:1.6;color:#475569;margin:0 0 16px;">
                Please ensure you complete the onboarding steps at least <strong>3 days prior</strong> to your joining date. If you have any questions or face any issues, please reply directly to this email.
              </p>
              
              <p style="font-size:13.5px;line-height:1.6;color:#475569;margin:0 0 24px;">
                We wish you all the best for your onboarding.
              </p>
              
              <!-- Sign-off -->
              <div style="font-size:14px;line-height:1.5;color:#475569;">
                Warm regards,<br>
                <strong style="color:#1e293b;">EverSoft HR Team</strong><br>
                <span style="color:#64748b;font-size:12.5px;">EverSoft Technologies</span>
              </div>
              
              <!-- Social Icons -->
              {social_html}
            </td>
          </tr>
          
          <!-- Bottom Footer -->
          <tr>
            <td style="background-color:#f8fafc;padding:16px 30px;text-align:center;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0;">
              This is a secure automated notification. Please do not reply directly to this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

    text_details = ""
    for label, val in details_list:
        text_details += f"{label}: {val}\n"
    text = f"Hello {candidate.first_name}, welcome to the team!\n\nPlease click this link to access your onboarding portal: {portal_url}\n\n{text_details}\nWarm regards,\nEverSoft HR Team"

    actor = _actor(request)
    result = mailer.send_email(to=candidate.email, subject=subject, html=html, text=text, sender_email=actor)
    if not result.get('ok'):
        return err(result.get('error') or 'Email sending failed', 400)
    
    log_activity(
        candidate, 'Portal Link Sent', actor,
        comments=f'Secure portal link sent to {candidate.email}'
    )
    return Response({'ok': True, 'mailer': result})


@api_view(['GET'])
def public_candidate_forms(request):
    """Public endpoint for candidates to view assigned forms on the portal."""
    token = request.query_params.get('token') or request.headers.get('X-Candidate-Token')
    if not token:
        return err('Token is required', 400)
    
    candidate = OnboardingCandidate.objects.filter(portal_token=token, is_deleted=False).first()
    if not candidate:
        return err('Invalid token', 404)
    
    if candidate.portal_token_expires_at and datetime.now() > candidate.portal_token_expires_at:
        return err('Token expired', 400)

    # List all active forms
    forms = PayrollForm.objects.filter(is_active=True)
    forms_data = []
    for f in forms:
        sub = CandidateFormSubmission.objects.filter(candidate=candidate, form=f).first()
        forms_data.append({
            'id': f.id,
            'name': f.name,
            'fileName': f.file_name,
            'fileMime': f.file_mime,
            'schema': f.schema or [],
            'isSubmitted': sub is not None,
            'submittedAt': sub.signed_at.strftime('%Y-%m-%d %H:%M:%S') if sub and sub.signed_at else None,
            'mode': sub.mode if sub else None,
        })

    # List all uploaded documents
    docs_qs = candidate.documents.filter(is_active=True)
    uploaded_docs = []
    for doc in docs_qs:
        uploaded_docs.append({
            'id': doc.id,
            'docType': doc.doc_type,
            'label': doc.label,
            'fileName': doc.file_name,
            'fileSize': doc.file_size,
            'uploadedAt': doc.uploaded_at.strftime('%Y-%m-%d %H:%M:%S') if doc.uploaded_at else None,
        })
    
    return Response({
        'candidate': {
            'id': candidate.id,
            'firstName': candidate.first_name or '',
            'lastName': candidate.last_name or '',
            'name': ' '.join(p for p in [candidate.first_name or '', candidate.last_name or ''] if p).strip(),
            'email': candidate.email or '',
            'jobTitle': candidate.job_title or '',
            'department': candidate.department or '',
            'joiningDate': candidate.joining_date.strftime('%Y-%m-%d') if candidate.joining_date else None,
            'requestedDocs': candidate.requested_docs or [],
        },
        'forms': forms_data,
        'uploadedDocs': uploaded_docs
    })


@api_view(['POST'])
def public_upload_document(request):
    """Public endpoint for candidates to upload requested onboarding documents."""
    token = request.data.get('token') or request.headers.get('X-Candidate-Token')
    if not token:
        return err('Token is required', 400)
    
    candidate = OnboardingCandidate.objects.filter(portal_token=token, is_deleted=False).first()
    if not candidate:
        return err('Invalid token', 404)
    if candidate.portal_token_expires_at and datetime.now() > candidate.portal_token_expires_at:
        return err('Token expired', 400)

    body = request.data
    is_custom = bool(body.get('isCustom'))
    label = (body.get('label') or '').strip()
    
    if is_custom:
        doc_type, error = custom_doc_slug(label)
        if error:
            return err(error)
    else:
        doc_type = (body.get('docType') or '').strip().lower()
        # Ensure it is in the candidate's requested_docs checklist
        requested_list = candidate.requested_docs or []
        req_item = next((item for item in requested_list if item.get('type') == doc_type), None)
        if not req_item:
            # Check if there is a custom document with this docType slug
            req_item = next((item for item in requested_list if custom_doc_slug(item.get('label'))[0] == doc_type), None)
            if not req_item:
                return err(f"Document type '{doc_type}' is not requested from you.")
        if label == '':
            label = req_item.get('label') or doc_type.upper()

    size, cleaned, error = decode_document(body.get('fileData'), body.get('fileMime'))
    if error:
        return err(error)

    with transaction.atomic():
        previous = candidate.documents.filter(doc_type=doc_type, is_active=True).first()
        version = (previous.version + 1) if previous else 1
        if previous:
            previous.is_active = False
            previous.save()

        doc = CandidateDocument.objects.create(
            candidate=candidate,
            doc_type=doc_type,
            label=(previous.label if previous and previous.label else label),
            is_custom=is_custom,
            file_name=(body.get('fileName') or '').strip(),
            file_mime=(body.get('fileMime') or '').strip().lower(),
            file_size=size,
            file_data=cleaned,
            version=version,
            uploaded_by="Candidate (Portal)",
        )

        log_activity(
            candidate, 'Document Uploaded', 'Candidate (Portal)',
            comments=f"Uploaded onboarding document: {doc.label or doc.doc_type}",
            new_value={'docType': doc_type, 'documentId': doc.id}
        )

    return Response({'ok': True, 'documentId': doc.id})



@api_view(['GET'])
def public_form_template_detail(request, form_id):
    """Public endpoint to fetch a single blank form template (including its base64 file data)."""
    token = request.query_params.get('token') or request.headers.get('X-Candidate-Token')
    if not token:
        return err('Token is required', 400)
    candidate = OnboardingCandidate.objects.filter(portal_token=token, is_deleted=False).first()
    if not candidate:
        return err('Invalid token', 404)
    if candidate.portal_token_expires_at and datetime.now() > candidate.portal_token_expires_at:
        return err('Token expired', 400)

    form = PayrollForm.objects.filter(pk=form_id, is_active=True).first()
    if not form:
        return err('Form not found', 404)
    
    return Response({
        'id': form.id,
        'name': form.name,
        'fileName': form.file_name,
        'fileMime': form.file_mime,
        'fileData': form.file_data,
        'schema': form.schema or [],
    })


@api_view(['POST'])
def public_submit_form(request):
    """Public endpoint for candidates to submit completed form data and signatures (digital or offline)."""
    token = request.data.get('token') or request.headers.get('X-Candidate-Token')
    if not token:
        return err('Token is required', 400)
    
    candidate = OnboardingCandidate.objects.filter(portal_token=token, is_deleted=False).first()
    if not candidate:
        return err('Invalid token', 404)
    if candidate.portal_token_expires_at and datetime.now() > candidate.portal_token_expires_at:
        return err('Token expired', 400)

    body = request.data
    form_id = to_int(body.get('formId'))
    form = PayrollForm.objects.filter(pk=form_id, is_active=True).first()
    if not form:
        return err('Form template not found', 404)

    file_data = body.get('fileData')
    file_mime = body.get('fileMime') or 'application/pdf'
    file_name = body.get('fileName') or f"{form.name}_completed.pdf"

    # Decode base64 to check/clean it
    size, cleaned, error = decode_document(file_data, file_mime)
    if error:
        return err(error)

    # Delete any previous submission for this form to allow re-submission/overwriting
    CandidateFormSubmission.objects.filter(candidate=candidate, form=form).delete()

    mode = body.get('mode') or 'digital'
    sub = CandidateFormSubmission.objects.create(
        candidate=candidate,
        form=form,
        filled_data=body.get('filledData') or {},
        signature_data=body.get('signatureData') or '',
        signed_at=datetime.now(),
        file_name=file_name,
        file_mime=file_mime,
        file_size=size,
        file_data=cleaned,
        mode=mode,
    )

    # Check if all active payroll forms have been completed
    total_active = PayrollForm.objects.filter(is_active=True).count()
    completed_count = CandidateFormSubmission.objects.filter(candidate=candidate, form__is_active=True).count()

    with transaction.atomic():
        # Update onboarding status stage if all are submitted
        if total_active > 0 and completed_count >= total_active:
            set_stage(candidate, 'payroll', 'Completed', 'Candidate (Portal)')
        else:
            set_stage(candidate, 'payroll', 'In Progress', 'Candidate (Portal)')
        
        log_activity(
            candidate, 'Form Submitted', f"Candidate ({mode})",
            comments=f"Submitted completed form: {form.name} ({mode})",
            new_value={'formName': form.name, 'mode': mode, 'submissionId': sub.id}
        )

    return Response({'ok': True, 'submissionId': sub.id})


@api_view(['GET', 'POST'])
@require_perm({'GET': 'onboarding.view', 'POST': 'onboarding.edit'})
def payroll_templates(request):
    """List or upload blank payroll form templates (admin side)."""
    if request.method == 'GET':
        forms = PayrollForm.objects.all()
        return Response(PayrollFormSerializer(forms, many=True).data)

    # Only Admins can upload new templates
    _, caller = _get_caller(request)
    is_admin = False
    if caller:
        if _is_super_admin(caller):
            is_admin = True
        elif caller.role_ref and 'admin' in caller.role_ref.name.lower():
            is_admin = True
        elif (caller.role or '').lower() == 'admin':
            is_admin = True

    if not is_admin:
        return err('Only administrators have permission to add payroll form templates', 403)

    body = request.data
    name = (body.get('name') or '').strip()
    if not name:
        return err('Name is required')
    if PayrollForm.objects.filter(name=name).exists():
        return err('A payroll form template with this name already exists', 409)

    file_data = body.get('fileData')
    file_mime = body.get('fileMime') or 'application/pdf'
    file_name = body.get('fileName') or f"{name}.pdf"

    size, cleaned, error = decode_document(file_data, file_mime)
    if error:
        return err(error)

    form = PayrollForm.objects.create(
        name=name,
        file_name=file_name,
        file_mime=file_mime,
        file_data=cleaned,
        schema=body.get('schema') or [],
        created_by=_actor(request),
    )
    return Response(PayrollFormSerializer(form).data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': 'onboarding.view', 'PUT': 'onboarding.edit', 'DELETE': 'onboarding.edit'})
def payroll_template_detail(request, pk):
    """View details, update metadata, or delete a payroll form template."""
    form = PayrollForm.objects.filter(pk=pk).first()
    if not form:
        return err('Form not found', 404)

    if request.method == 'GET':
        # Return complete serialized details (including fileData)
        ser = PayrollFormSerializer(form)
        data = ser.data
        data['fileData'] = form.file_data
        return Response(data)

    # Only Admins can modify or delete templates
    _, caller = _get_caller(request)
    is_admin = False
    if caller:
        if _is_super_admin(caller):
            is_admin = True
        elif caller.role_ref and 'admin' in caller.role_ref.name.lower():
            is_admin = True
        elif (caller.role or '').lower() == 'admin':
            is_admin = True

    if not is_admin:
        return err('Only administrators have permission to modify or delete payroll form templates', 403)

    if request.method == 'DELETE':
        if form.submissions.exists():
            form.is_active = False
            form.save()
        else:
            form.delete()
        return Response({'ok': True})

    body = request.data
    if 'name' in body:
        form.name = body['name'].strip()
    if 'schema' in body:
        form.schema = body['schema']
    if 'isActive' in body:
        form.is_active = bool(body['isActive'])
    form.save()
    return Response(PayrollFormSerializer(form).data)


@api_view(['GET'])
@require_perm('onboarding.view')
def candidate_form_submissions(request, pk):
    """View forms submitted by a candidate (admin side)."""
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)
    
    submissions = CandidateFormSubmission.objects.filter(candidate=candidate)
    data = []
    for sub in submissions:
        data.append({
            'id': sub.id,
            'formId': sub.form_id,
            'formName': sub.form.name,
            'filledData': sub.filled_data,
            'signatureData': sub.signature_data,
            'signedAt': sub.signed_at.strftime('%Y-%m-%d %H:%M:%S') if sub.signed_at else None,
            'fileName': sub.file_name,
            'fileMime': sub.file_mime,
            'fileSize': sub.file_size,
            'mode': sub.mode,
        })
    return Response(data)


@api_view(['GET'])
@require_perm('onboarding.view')
def candidate_submission_pdf(request, pk, sub_id):
    """Retrieve the signed/completed PDF file of a candidate's submission (admin side)."""
    candidate = get_candidate(pk)
    if not candidate:
        return err('Candidate not found', 404)
    sub = CandidateFormSubmission.objects.filter(pk=sub_id, candidate=candidate).first()
    if not sub:
        return err('Submission not found', 404)
    return Response({
        'id': sub.id,
        'fileName': sub.file_name,
        'fileMime': sub.file_mime,
        'fileData': sub.file_data,
    })


@api_view(['POST'])
def public_complete_portal(request):
    """Complete onboarding and invalidate the token so candidate cannot access it again."""
    token = request.data.get('token') or request.headers.get('X-Candidate-Token')
    if not token:
        return err('Token is required', 400)
    
    candidate = OnboardingCandidate.objects.filter(portal_token=token, is_deleted=False).first()
    if not candidate:
        return err('Invalid token', 404)
    
    # Invalidate token immediately
    candidate.portal_token = None
    candidate.portal_token_expires_at = None
    
    # Mark status as Pending Verification if Draft
    if candidate.status in ['Draft', 'Pending Verification']:
        candidate.status = 'Pending Verification'
    
    candidate.save()
    return Response({'ok': True, 'message': 'Onboarding successfully completed.'})


