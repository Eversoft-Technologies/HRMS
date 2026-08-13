"""
Django REST Framework serializers for the HRMS API.

Every serializer reproduces the exact camelCase JSON contract the React
frontend depends on (previously emitted by the hand-written ``*_dict`` mappers
in ``views.py``). Field names are camelCase and mapped onto the snake_case
model columns via ``source=``; representation-only coercions (null -> '',
JSON-string parsing, int casting) are handled in ``to_representation`` so the
output is byte-for-byte compatible with the original Node/Express API.

These serializers are self-contained (no import from ``views``) to avoid a
circular import, since ``views`` imports from here.
"""
import json
import os

from rest_framework import serializers

from .models import (
    AppUser,
    AttendanceEvent,
    Company,
    EmployeeAttendance,
    EmployeeTask,
    Module,
    Notification,
    Permission,
    PermissionGroup,
    Role,
    InterviewLink,
    InterviewRecording,
    JobPost,
    LeaveRequest,
    QuestionSet,
    ResumeScore,
    UserDocument,
    UserEmailConfig,
    UserProfile,
    WorkSubmission,
    Shift,
    ShiftAssignment,
    AttendanceCorrection,
    GeoFence,
    WfhRequest,
    Break,
    BreakPolicy,
    LateCheckInAlert,
    LateCheckInPolicy,
    Overtime,
    OvertimePolicy,
    OvertimeBalance,
    WFHPolicy,
    OnboardingCandidate,
    WorkAuthorization,
    CandidateDocument,
    OnboardingActivityLog,
    OnboardingStatus,
    HrVerification,
    ManagerApproval,
    ItAssetAllocation,
    PayrollInformation,
    PayrollForm,
    CandidateFormSubmission,
    EmployeeCompensation,
    PayComponent,
    EmployeePayComponent,
    PayrollRun,
    Payslip,
    PayrollSetting,
)

# Datetime wire format used everywhere by the original API (naive, USE_TZ=False).
DATETIME_FMT = '%Y-%m-%d %H:%M:%S'
DATE_FMT = '%Y-%m-%d'


# ---------------------------------------------------------------------------
# Pure helpers (mirror the ones in views.py — kept local to avoid a circular
# import between views and serializers).
# ---------------------------------------------------------------------------
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


def make_initials(name):
    import re
    parts = [p for p in re.split(r'\s+', (name or '').strip()) if p]
    return ''.join(p[0] for p in parts).upper()[:2]


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
# Custom fields
# ---------------------------------------------------------------------------
class JSONStringField(serializers.Field):
    """A TextField column that stores a JSON-encoded value.

    Reads it back into a native Python object (returns ``None`` when the column
    is empty or not valid JSON); writes by ``json.dumps`` (``None`` when the
    incoming value is falsy), matching the original ``json.dumps``/``safe_json``
    behaviour for ``interview_questions``.
    """
    def to_representation(self, value):
        return safe_json(value)

    def to_internal_value(self, data):
        if not data:
            return None
        return json.dumps(data)


class InterviewTypeField(serializers.Field):
    """``interview_type`` column that the frontend treats as a list of strings.

    The React app always reads ``interviewType`` as an array (``.includes``,
    ``.join``, checkbox toggles) and sends it as an array on create. Storing it
    in the ``CharField`` column as a JSON-encoded list keeps that contract
    intact while remaining tolerant of legacy rows that hold a plain string
    (``"Technical"``) or a Python-repr list (``"['Technical']"``).
    """
    def to_representation(self, value):
        if value is None or value == '':
            return ['Technical']
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                if isinstance(parsed, list):
                    return parsed
            except ValueError:
                pass
            try:
                import ast
                parsed = ast.literal_eval(value)
                if isinstance(parsed, list):
                    return [str(v) for v in parsed]
            except (ValueError, SyntaxError):
                pass
            return [v.strip() for v in value.split(',') if v.strip()] or ['Technical']
        return [str(value)]

    def to_internal_value(self, data):
        if data is None or data == '':
            return 'Technical'
        if isinstance(data, list):
            return json.dumps([str(v) for v in data])
        return str(data)


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
class NotificationSerializer(serializers.ModelSerializer):
    notificationType = serializers.CharField(source='notification_type')
    isRead = serializers.BooleanField(source='is_read')
    createdAt = serializers.DateTimeField(source='created_at', read_only=True)

    class Meta:
        model = Notification
        fields = ['id', 'recipient', 'title', 'message', 'notificationType', 'isRead', 'link', 'createdAt']


class JobPostSerializer(serializers.ModelSerializer):
    remote = serializers.BooleanField(source='is_remote', required=False, default=False)
    description = serializers.CharField(
        required=False, allow_blank=True, allow_null=True, default='',
    )
    customFields = serializers.JSONField(source='custom_fields', required=False, default=dict)
    createdAt = serializers.DateTimeField(source='created_at', read_only=True)

    class Meta:
        model = JobPost
        fields = [
            'id', 'title', 'dept', 'location', 'type', 'salary', 'applicants',
            'color', 'description', 'openings', 'remote', 'status', 'priority',
            'customFields', 'createdAt',
        ]
        read_only_fields = ['id', 'applicants', 'color']
        extra_kwargs = {
            'location': {'required': False, 'default': ''},
            'type': {'required': False, 'default': 'Full-time'},
            'salary': {'required': False, 'default': ''},
            'openings': {'required': False, 'default': 1},
            'status': {'required': False, 'default': 'Active'},
            'priority': {'required': False, 'default': 'Normal'},
        }

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'title': instance.title,
            'dept': instance.dept,
            'location': instance.location,
            'type': instance.type,
            'salary': instance.salary,
            'applicants': instance.applicants,
            'color': instance.color,
            'description': instance.description or '',
            'openings': instance.openings,
            'remote': bool(instance.is_remote),
            'status': instance.status or 'Active',
            'statusComment': getattr(instance, 'status_comment', '') or '',
            'priority': instance.priority or 'Normal',
            'customFields': instance.custom_fields or {},
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }

    def create(self, validated_data):
        openings = to_int(validated_data.get('openings', 1), 1)
        validated_data['openings'] = openings if openings > 0 else 1
        validated_data['color'] = resolve_color(validated_data.get('type', 'Full-time'))
        validated_data['applicants'] = 0
        return super().create(validated_data)


# ---------------------------------------------------------------------------
# Interviews
# ---------------------------------------------------------------------------
class InterviewLinkSerializer(serializers.ModelSerializer):
    interviewDate = serializers.CharField(source='interview_date', required=False, allow_null=True, allow_blank=True)
    time = serializers.CharField(source='interview_time', required=False, allow_null=True, allow_blank=True)
    emailSent = serializers.BooleanField(source='email_sent', required=False, default=False)
    interviewType = InterviewTypeField(source='interview_type', required=False)
    interviewQuestions = JSONStringField(source='interview_questions', required=False)
    resumeText = serializers.CharField(source='resume_text', required=False, allow_blank=True, allow_null=True)
    jdText = serializers.CharField(source='jd_text', required=False, allow_blank=True, allow_null=True)
    techQuestionCount = serializers.IntegerField(source='tech_question_count', required=False)
    hrQuestionCount = serializers.IntegerField(source='hr_question_count', required=False)
    finalQuestionCount = serializers.IntegerField(source='final_question_count', required=False)
    codingDifficulty = serializers.JSONField(source='coding_difficulty', required=False, allow_null=True)

    class Meta:
        model = InterviewLink
        fields = [
            'id', 'name', 'initials', 'role', 'email', 'phone', 'score', 'status',
            'interviewDate', 'time', 'platform', 'link', 'outcome', 'emailSent',
            'interviewType', 'interviewer', 'duration', 'notes',
            'interviewQuestions', 'resumeText', 'jdText',
            'techQuestionCount', 'hrQuestionCount', 'finalQuestionCount',
            'codingDifficulty',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'phone': {'required': False, 'allow_blank': True, 'default': ''},
            'score': {'required': False, 'default': 0},
            'status': {'required': False, 'default': 'Scheduled'},
            'platform': {'required': False, 'allow_null': True},
            'link': {'required': False, 'allow_null': True},
            'outcome': {'required': False, 'allow_null': True},
            'interviewer': {'required': False, 'allow_blank': True, 'default': ''},
            'duration': {'required': False, 'default': '45 min'},
            'notes': {'required': False, 'allow_null': True, 'allow_blank': True},
            'initials': {'required': False, 'allow_blank': True},
        }

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'initials': instance.initials,
            'role': instance.role,
            'email': instance.email,
            'phone': instance.phone,
            'score': instance.score,
            'status': instance.status,
            'interviewDate': instance.interview_date,
            'time': instance.interview_time,
            'platform': instance.platform,
            'link': instance.link,
            'outcome': instance.outcome,
            'emailSent': bool(instance.email_sent),
            'interviewType': InterviewTypeField().to_representation(instance.interview_type),
            'interviewer': instance.interviewer,
            'duration': instance.duration,
            'notes': instance.notes,
            'notesUpdatedBy': instance.notes_updated_by or '',
            'notesUpdatedByEmail': instance.notes_updated_by_email or '',
            'notesUpdatedAt': instance.notes_updated_at.strftime(DATETIME_FMT) if instance.notes_updated_at else None,
            'interviewQuestions': safe_json(instance.interview_questions),
            'techQuestionCount': instance.tech_question_count,
            'hrQuestionCount': instance.hr_question_count,
            'finalQuestionCount': instance.final_question_count,
            'codingDifficulty': instance.coding_difficulty,
            'candidateToken': instance.candidate_token or '',
            'recruiterToken': instance.recruiter_token or '',
            'linkExpiresAt': instance.link_expires_at.strftime(DATETIME_FMT) if instance.link_expires_at else None,
            'completedAt': instance.completed_at.strftime(DATETIME_FMT) if instance.completed_at else None,
            'resumeText': instance.resume_text or '',
            'jdText': instance.jd_text or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }

    def create(self, validated_data):
        if not validated_data.get('initials'):
            validated_data['initials'] = make_initials(validated_data.get('name'))
        validated_data.setdefault('platform', 'Microsoft Teams')
        return super().create(validated_data)


# ---------------------------------------------------------------------------
# Resume Scores
# ---------------------------------------------------------------------------
class ResumeScoreSerializer(serializers.ModelSerializer):
    fileName = serializers.CharField(source='file_name', required=False, allow_null=True, allow_blank=True)
    # write_only + a real source: accepted on save and stored, but never echoed
    # in the list (the base64 blob would bloat every row). Retrieve via the
    # single-resume detail endpoint instead.
    fileMime = serializers.CharField(source='file_mime', write_only=True, required=False, allow_null=True, allow_blank=True)
    fileData = serializers.CharField(source='file_data', write_only=True, required=False, allow_null=True, allow_blank=True)
    resumeText = serializers.CharField(source='resume_text', required=False, allow_blank=True, allow_null=True)
    jdText = serializers.CharField(source='jd_text', required=False, allow_blank=True, allow_null=True)

    class Meta:
        model = ResumeScore
        fields = [
            'id', 'name', 'initials', 'role', 'score', 'technical', 'experience',
            'domain', 'gap', 'skills', 'missing', 'formatted', 'source',
            'uploaded', 'fileName', 'fileMime', 'fileData', 'resumeText', 'jdText',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'initials': {'required': False, 'allow_blank': True},
            'role': {'required': False, 'default': 'Software Professional'},
            'score': {'required': False, 'default': 0},
            'technical': {'required': False, 'default': 0},
            'experience': {'required': False, 'default': 0},
            'domain': {'required': False, 'default': 0},
            'gap': {'required': False, 'allow_blank': True, 'allow_null': True, 'default': ''},
            'skills': {'required': False},
            'missing': {'required': False},
            'source': {'required': False, 'default': 'Upload'},
            'formatted': {'required': False, 'default': False},
            'uploaded': {'required': False, 'default': True},
        }

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'initials': instance.initials,
            'role': instance.role,
            'score': to_int(instance.score),
            'technical': to_int(instance.technical),
            'experience': to_int(instance.experience),
            'domain': to_int(instance.domain),
            'gap': instance.gap,
            'skills': safe_list(instance.skills),
            'missing': safe_list(instance.missing),
            'formatted': bool(instance.formatted),
            'source': instance.source or 'Upload',
            'uploaded': bool(instance.uploaded),
            'fileName': instance.file_name,
            'resumeText': instance.resume_text,
            'jdText': instance.jd_text,
        }

    def create(self, validated_data):
        # Accept file uploads in resume scoring payloads without requiring a
        # separate document model for the same request shape.
        # Keep file_mime and file_data so they are stored in the DB row.
        if not validated_data.get('name') and validated_data.get('file_name'):
            validated_data['name'] = os.path.splitext(validated_data['file_name'])[0]
        if not validated_data.get('initials'):
            validated_data['initials'] = make_initials(validated_data.get('name'))
        skills = validated_data.get('skills')
        missing = validated_data.get('missing')
        validated_data['skills'] = skills if isinstance(skills, list) else []
        validated_data['missing'] = missing if isinstance(missing, list) else []
        return super().create(validated_data)

    def update(self, instance, validated_data):
        # Preserve file data on updates — only overwrite if new data supplied.
        if not validated_data.get('file_data'):
            validated_data.pop('file_data', None)
        if not validated_data.get('file_mime'):
            validated_data.pop('file_mime', None)
        if not validated_data.get('file_name'):
            validated_data.pop('file_name', None)
        skills = validated_data.get('skills')
        missing = validated_data.get('missing')
        if skills is not None:
            validated_data['skills'] = skills if isinstance(skills, list) else []
        if missing is not None:
            validated_data['missing'] = missing if isinstance(missing, list) else []
        return super().update(instance, validated_data)


# ---------------------------------------------------------------------------
# Interview Recordings
# ---------------------------------------------------------------------------
class InterviewRecordingSerializer(serializers.ModelSerializer):
    """Recording metadata (the list/create shape). The heavy ``recording_data``
    base64 blob is write-only here; the detail view adds it back explicitly."""
    candidateName = serializers.CharField(source='candidate_name')
    candidateEmail = serializers.CharField(source='candidate_email', required=False, allow_blank=True, default='')
    totalScore = serializers.IntegerField(source='total_score', required=False, default=0)
    techScore = serializers.IntegerField(source='tech_score', required=False, default=0)
    commScore = serializers.IntegerField(source='comm_score', required=False, default=0)
    integrityScore = serializers.IntegerField(source='integrity_score', required=False, default=0)
    recordingData = serializers.CharField(source='recording_data', required=False, allow_null=True, allow_blank=True, write_only=True)

    class Meta:
        model = InterviewRecording
        fields = [
            'id', 'candidateName', 'candidateEmail', 'role', 'duration', 'verdict',
            'totalScore', 'techScore', 'commScore', 'integrityScore',
            'transcript', 'responses', 'recordingData',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'role': {'required': False, 'allow_blank': True, 'default': ''},
            'duration': {'required': False, 'default': 0},
            'verdict': {'required': False, 'default': 'HOLD'},
            'transcript': {'required': False, 'allow_blank': True, 'allow_null': True, 'default': ''},
            'responses': {'required': False},
        }

    def to_representation(self, instance):
        # ``_has_video`` / ``_has_recording`` are annotated by the list queryset
        # (which defers the heavy columns); fall back to the columns otherwise.
        #
        # The fallback MUST stay lazy. getattr(obj, name, default) evaluates its
        # default eagerly, so `getattr(instance, '_has_video', instance.video_buffer)`
        # read the deferred LONGBLOB on every row even when the annotation was
        # present — one extra SELECT per row per column, pulling the whole video.
        # Six recordings meant twelve blob queries and ~74 MB over the wire, which
        # is what made GET /api/interview-recordings time out and 502 in production.
        has_video = getattr(instance, '_has_video', None)
        if has_video is None:                       # unannotated (detail view)
            # True when either binary LONGBLOB *or* legacy base64 column has data.
            has_video = (instance.video_buffer is not None
                         or instance.recording_data is not None)
        has_recording = getattr(instance, '_has_recording', None)
        if has_recording is None:
            has_recording = instance.recording_data is not None

        return {
            'id': instance.id,
            'candidateName': instance.candidate_name,
            'candidateEmail': instance.candidate_email,
            'role': instance.role,
            'duration': instance.duration,
            'verdict': instance.verdict,
            'totalScore': instance.total_score,
            'techScore': instance.tech_score,
            'commScore': instance.comm_score,
            'integrityScore': instance.integrity_score,
            'hasVideo': bool(has_video),
            'hasRecording': bool(has_recording),
            'transcript': instance.transcript,
            'responses': safe_list(instance.responses),
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }

    def create(self, validated_data):
        responses = validated_data.get('responses')
        validated_data['responses'] = responses if isinstance(responses, list) else []
        return super().create(validated_data)


# ---------------------------------------------------------------------------
# Question Sets
# ---------------------------------------------------------------------------
class QuestionSetSerializer(serializers.ModelSerializer):
    questions = serializers.JSONField()

    class Meta:
        model = QuestionSet
        fields = ['id', 'questions']
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {'id': instance.id, 'questions': safe_list(instance.questions)}


# ---------------------------------------------------------------------------
# App Users (Settings -> User Access logins)
# ---------------------------------------------------------------------------
class AppUserSerializer(serializers.ModelSerializer):
    name = serializers.CharField(source='full_name')

    class Meta:
        model = AppUser
        fields = ['name', 'email', 'password', 'initials', 'role', 'status']
        extra_kwargs = {
            'initials': {'required': False, 'allow_blank': True},
            'role': {'required': False, 'default': 'admin'},
            'status': {'required': False, 'default': 'active'},
        }

    def to_representation(self, instance):
        # Keys match what the React app (services/usersApi.js + AuthContext) reads.
        return {
            'id': instance.id,
            'name': instance.full_name,
            'email': instance.email,
            'password': instance.password,
            'initials': instance.initials,
            'role': instance.role,
            'status': instance.status,
            'authProvider': instance.auth_provider,
            'profilePic': instance.profile_pic or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }

    def create(self, validated_data):
        if not validated_data.get('initials'):
            validated_data['initials'] = make_initials(validated_data.get('full_name'))
        return super().create(validated_data)


# ---------------------------------------------------------------------------
# User Settings: Profile / Email config / Documents
# ---------------------------------------------------------------------------
class UserProfileSerializer(serializers.ModelSerializer):
    firstName = serializers.CharField(source='first_name', required=False, allow_blank=True, default='')
    lastName = serializers.CharField(source='last_name', required=False, allow_blank=True, default='')
    altEmail = serializers.CharField(source='alt_email', required=False, allow_blank=True, default='')
    bloodGroup = serializers.CharField(source='blood_group', required=False, allow_blank=True, default='')
    profilePic = serializers.CharField(source='profile_pic', required=False, allow_blank=True, allow_null=True, default='')

    class Meta:
        model = UserProfile
        fields = [
            'email', 'firstName', 'lastName', 'phone', 'altEmail',
            'bloodGroup', 'department', 'designation', 'address', 'profilePic',
        ]
        extra_kwargs = {
            'phone': {'required': False, 'allow_blank': True, 'default': ''},
            'department': {'required': False, 'allow_blank': True, 'default': ''},
            'designation': {'required': False, 'allow_blank': True, 'default': ''},
            'address': {'required': False, 'allow_blank': True, 'allow_null': True, 'default': ''},
        }

    def to_representation(self, instance):
        return {
            'email': instance.email,
            'firstName': instance.first_name or '',
            'lastName': instance.last_name or '',
            'phone': instance.phone or '',
            'altEmail': instance.alt_email or '',
            'bloodGroup': instance.blood_group or '',
            'department': instance.department or '',
            'designation': instance.designation or '',
            'address': instance.address or '',
            'profilePic': instance.profile_pic or '',
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


class UserEmailConfigSerializer(serializers.ModelSerializer):
    email = serializers.CharField(source='user_email', read_only=True)
    smtpHost = serializers.CharField(source='smtp_host', required=False, allow_blank=True, default='')
    smtpPort = serializers.CharField(source='smtp_port', required=False, allow_blank=True, default='')
    smtpUser = serializers.CharField(source='smtp_user', required=False, allow_blank=True, default='')
    smtpPassword = serializers.CharField(source='smtp_password', required=False, allow_blank=True, default='')
    smtpSecure = serializers.BooleanField(source='smtp_secure', required=False, default=False)
    fromName = serializers.CharField(source='from_name', required=False, allow_blank=True, default='')
    fromEmail = serializers.CharField(source='from_email', required=False, allow_blank=True, default='')
    social = serializers.JSONField(required=False)

    class Meta:
        model = UserEmailConfig
        fields = [
            'email', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword',
            'smtpSecure', 'fromName', 'fromEmail', 'social',
        ]

    def to_representation(self, instance):
        return {
            'email': instance.user_email,
            'smtpHost': instance.smtp_host or '',
            'smtpPort': instance.smtp_port or '',
            'smtpUser': instance.smtp_user or '',
            'smtpPassword': instance.smtp_password or '',
            'smtpSecure': bool(instance.smtp_secure),
            'fromName': instance.from_name or '',
            'fromEmail': instance.from_email or '',
            'social': safe_json(instance.social) or {},
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


class UserDocumentSerializer(serializers.ModelSerializer):
    docType = serializers.CharField(source='doc_type')
    fileName = serializers.CharField(source='file_name', required=False, allow_blank=True, default='')
    fileMime = serializers.CharField(source='file_mime', required=False, allow_blank=True, default='')
    fileData = serializers.CharField(source='file_data', required=False, allow_null=True, allow_blank=True, write_only=True)

    class Meta:
        model = UserDocument
        fields = ['id', 'docType', 'fileName', 'fileMime', 'fileData']
        read_only_fields = ['id']

    def __init__(self, *args, **kwargs):
        # Pass ``include_data=True`` to also expose the (large) base64 fileData
        # in the output — matches document_dict(..., include_data=True).
        self._include_data = kwargs.pop('include_data', False)
        super().__init__(*args, **kwargs)

    def to_representation(self, instance):
        base = {
            'id': instance.id,
            'docType': instance.doc_type,
            'fileName': instance.file_name or '',
            'fileMime': instance.file_mime or '',
            'uploadedAt': instance.uploaded_at.strftime(DATETIME_FMT) if instance.uploaded_at else None,
        }
        if self._include_data:
            base['fileData'] = instance.file_data or ''
        return base


# ---------------------------------------------------------------------------
# Employees module
# ---------------------------------------------------------------------------
DATE_FMT = '%Y-%m-%d'


class EmployeeAttendanceSerializer(serializers.ModelSerializer):
    class Meta:
        model = EmployeeAttendance
        fields = [
            'id', 'email', 'employee_name', 'date', 'check_in', 'check_out',
            'device', 'status', 'worked_minutes', 'note',
            'shift_id', 'is_wfh', 'break_minutes', 'overtime_minutes',
            'late_minutes', 'early_exit_minutes', 'location_lat', 'location_lng',
            'geo_verified',
        ]
        read_only_fields = ['id']

    def to_representation(self, instance):
        checked_in = bool(
            instance.check_in
            and (instance.check_out is None or instance.check_in > instance.check_out)
        )
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'date': instance.date.strftime(DATE_FMT) if instance.date else None,
            'checkIn': instance.check_in.strftime(DATETIME_FMT) if instance.check_in else None,
            'checkOut': instance.check_out.strftime(DATETIME_FMT) if instance.check_out else None,
            'checkInTime': instance.check_in.strftime('%H:%M') if instance.check_in else None,
            'checkOutTime': instance.check_out.strftime('%H:%M') if instance.check_out else None,
            'checkedIn': checked_in,
            'device': instance.device or '',
            'status': instance.status,
            'presence': instance.presence or '',
            'workedMinutes': instance.worked_minutes,
            'note': instance.note or '',
            'shiftId': instance.shift_id,
            'isWfh': bool(instance.is_wfh),
            'breakMinutes': instance.break_minutes,
            'overtimeMinutes': instance.overtime_minutes,
            'lateMinutes': instance.late_minutes,
            'earlyExitMinutes': instance.early_exit_minutes,
            'locationLat': instance.location_lat,
            'locationLng': instance.location_lng,
            'geoVerified': bool(instance.geo_verified),
        }


class LeaveRequestSerializer(serializers.ModelSerializer):
    employee = serializers.CharField(source='employee_name', required=False, allow_blank=True, default='')
    fromDate = serializers.DateField(source='from_date')
    toDate = serializers.DateField(source='to_date')
    # Always derived from the date range — never taken from the client. The UI
    # was posting a hardcoded days:1, which won over the old "only if missing"
    # derivation and also skewed the leave balance (used = sum of days).
    days = serializers.IntegerField(read_only=True)

    class Meta:
        model = LeaveRequest
        fields = [
            'id', 'email', 'employee', 'type', 'fromDate', 'toDate',
            'days', 'reason', 'status', 'approver',
        ]
        read_only_fields = ['id', 'days']
        extra_kwargs = {
            'type': {'required': False, 'default': 'Casual Leave'},
            'reason': {'required': False, 'allow_blank': True, 'allow_null': True, 'default': ''},
            'status': {'required': False, 'default': 'Pending'},
            'approver': {'required': False, 'allow_blank': True, 'default': ''},
        }

    def validate(self, attrs):
        """Recompute ``days`` on every write, inclusive of both endpoints
        (2026-08-10 → 2026-08-12 is 3 days). On a partial update (e.g. an
        approval that only sends ``status``) fall back to the stored dates so
        the count stays consistent with whatever the range actually is."""
        from_date = attrs.get('from_date') or getattr(self.instance, 'from_date', None)
        to_date = attrs.get('to_date') or getattr(self.instance, 'to_date', None)

        if from_date and to_date:
            if to_date < from_date:
                raise serializers.ValidationError(
                    {'toDate': 'To date cannot be earlier than from date.'})
            attrs['days'] = (to_date - from_date).days + 1
        return attrs

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'type': instance.type,
            'fromDate': instance.from_date.strftime(DATE_FMT) if instance.from_date else None,
            'toDate': instance.to_date.strftime(DATE_FMT) if instance.to_date else None,
            'days': instance.days,
            'reason': instance.reason or '',
            'status': instance.status,
            'approver': instance.approver or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class EmployeeTaskSerializer(serializers.ModelSerializer):
    assigneeEmail = serializers.CharField(source='assignee_email', required=False, allow_blank=True, default='')
    createdBy = serializers.CharField(source='created_by', required=False, allow_blank=True, default='')

    class Meta:
        model = EmployeeTask
        fields = [
            'id', 'title', 'assignee', 'assigneeEmail', 'due', 'priority',
            'stage', 'description', 'createdBy',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'assignee': {'required': False, 'allow_blank': True, 'default': ''},
            'due': {'required': False, 'allow_blank': True, 'default': ''},
            'priority': {'required': False, 'default': 'medium'},
            'stage': {'required': False, 'default': 'todo'},
            'description': {'required': False, 'allow_blank': True, 'allow_null': True, 'default': ''},
        }

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'title': instance.title,
            'assignee': instance.assignee or '',
            'assigneeEmail': instance.assignee_email or '',
            'due': instance.due or '',
            'priority': instance.priority,
            'stage': instance.stage,
            'description': instance.description or '',
            'createdBy': instance.created_by or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class WorkSubmissionSerializer(serializers.ModelSerializer):
    employee = serializers.CharField(source='employee_name', required=False, allow_blank=True, default='')
    fileName = serializers.CharField(source='file_name', required=False, allow_blank=True, default='')
    aiScore = serializers.IntegerField(source='ai_score', required=False, default=0)

    class Meta:
        model = WorkSubmission
        fields = [
            'id', 'email', 'employee', 'title', 'type', 'date', 'summary',
            'link', 'fileName', 'status', 'reviewer', 'aiScore',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'type': {'required': False, 'allow_blank': True, 'default': 'Document'},
            'summary': {'required': False, 'allow_blank': True, 'allow_null': True, 'default': ''},
            'link': {'required': False, 'allow_blank': True, 'default': ''},
            'status': {'required': False, 'default': 'Pending'},
            'reviewer': {'required': False, 'allow_blank': True, 'default': ''},
        }

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'title': instance.title,
            'type': instance.type or 'Document',
            'date': instance.date.strftime(DATE_FMT) if instance.date else None,
            'submitted': instance.date.strftime(DATE_FMT) if instance.date else (
                instance.created_at.strftime(DATE_FMT) if instance.created_at else ''),
            'summary': instance.summary or '',
            'link': instance.link or '',
            'fileName': instance.file_name or '',
            'status': instance.status,
            'reviewer': instance.reviewer or '',
            'aiScore': instance.ai_score or 0,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }

    def create(self, validated_data):
        # Stamp the submission date server-side when the client didn't send one.
        if not validated_data.get('date'):
            from datetime import date as _date
            validated_data['date'] = _date.today()
        return super().create(validated_data)


# Display label + dot colour for each activity-log event type. Colours map to
# the React app's CSS vars (--success / --warn / --accent / --danger) so the
# frontend can render the timeline dots without any client-side lookup.
ATTENDANCE_EVENT_LABELS = {
    'check-in': 'Check In',
    'check-out': 'Check Out',
    'break-start': 'Break Start',
    'break-end': 'Break End',
    'remote-switch': 'Remote Switch',
    'office-switch': 'Office Switch',
}
ATTENDANCE_EVENT_COLORS = {
    'check-in': 'success',
    'check-out': 'danger',
    'break-start': 'warn',
    'break-end': 'success',
    'remote-switch': 'accent',
    'office-switch': 'success',
}


class AttendanceEventSerializer(serializers.ModelSerializer):
    """Serialises an activity-log event into exactly the shape the check-in
    page renders: ``{ time, event, location, color }`` plus raw fields."""

    class Meta:
        model = AttendanceEvent
        fields = ['id', 'email', 'employee_name', 'date', 'event', 'location', 'at']
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'type': instance.event,
            'event': ATTENDANCE_EVENT_LABELS.get(instance.event, instance.event),
            'location': instance.location or '—',
            'time': instance.at.strftime('%I:%M %p') if instance.at else '',
            'color': ATTENDANCE_EVENT_COLORS.get(instance.event, 'gray'),
            'at': instance.at.strftime(DATETIME_FMT) if instance.at else None,
            'latitude': instance.latitude,
            'longitude': instance.longitude,
            'geoFenceId': instance.geo_fence_id,
        }


# ===========================================================================
# RBAC serializers
# ---------------------------------------------------------------------------
# These read only fields already loaded by the view (annotated counts +
# select_related FKs), so serialising a list never fires a per-row query.
# ===========================================================================
class CompanySerializer(serializers.ModelSerializer):
    class Meta:
        model = Company
        fields = ['id', 'name', 'is_active']

    def to_representation(self, i):
        return {
            'id': i.id, 'name': i.name, 'isActive': i.is_active,
            'createdAt': i.created_at.strftime(DATETIME_FMT) if i.created_at else None,
        }


class ModuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Module
        fields = ['id', 'name', 'icon', 'order', 'is_active']

    def to_representation(self, i):
        return {
            'id': i.id, 'name': i.name, 'icon': i.icon or '',
            'order': i.order, 'isActive': i.is_active,
        }


class RoleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Role
        fields = ['id', 'name', 'description', 'is_active']
        extra_kwargs = {
            'description': {'required': False, 'allow_blank': True, 'default': ''},
            'is_active': {'required': False, 'default': True},
        }

    def to_representation(self, i):
        return {
            'id': i.id,
            'name': i.name,
            'description': i.description or '',
            'isActive': i.is_active,
            'status': 'Active' if i.is_active else 'Inactive',
            # ``permission_count`` / ``user_count`` come from the view's annotate();
            # fall back to a query only when unannotated (detail views).
            'permissionCount': getattr(i, 'permission_count', None)
                if getattr(i, 'permission_count', None) is not None
                else i.role_permissions.count(),
            'userCount': getattr(i, 'user_count', 0) or 0,
            'createdBy': (i.created_by.full_name if i.created_by_id and i.created_by else ''),
            'createdAt': i.created_at.strftime(DATETIME_FMT) if i.created_at else None,
        }


class PermissionGroupSerializer(serializers.ModelSerializer):
    module = serializers.PrimaryKeyRelatedField(
        queryset=Module.objects.all(), required=False, allow_null=True)

    class Meta:
        model = PermissionGroup
        fields = ['id', 'name', 'description', 'module', 'is_active']
        extra_kwargs = {
            'description': {'required': False, 'allow_blank': True, 'default': ''},
            'is_active': {'required': False, 'default': True},
        }

    def to_representation(self, i):
        return {
            'id': i.id,
            'name': i.name,
            'description': i.description or '',
            'moduleId': i.module_id,
            'module': (i.module.name if i.module_id and i.module else ''),
            'isActive': i.is_active,
            'permissionCount': getattr(i, 'permission_count', None)
                if getattr(i, 'permission_count', None) is not None
                else i.permissions.count(),
            'createdAt': i.created_at.strftime(DATETIME_FMT) if i.created_at else None,
        }


class PermissionSerializer(serializers.ModelSerializer):
    group = serializers.PrimaryKeyRelatedField(
        queryset=PermissionGroup.objects.all(), required=False, allow_null=True)

    class Meta:
        model = Permission
        fields = ['id', 'name', 'code', 'description', 'group', 'is_active']
        extra_kwargs = {
            'description': {'required': False, 'allow_blank': True, 'default': ''},
            'is_active': {'required': False, 'default': True},
        }

    def to_representation(self, i):
        return {
            'id': i.id,
            'name': i.name,
            'code': i.code,
            'description': i.description or '',
            'isActive': i.is_active,
            'groupId': i.group_id,
            'group': (i.group.name if i.group_id and i.group else ''),
            'module': (i.group.module.name if i.group_id and i.group and i.group.module_id and i.group.module else ''),
        }


# ===========================================================================
# Advanced Attendance Management — Serializers
# ===========================================================================

class ShiftSerializer(serializers.ModelSerializer):
    startTime = serializers.TimeField(source='start_time')
    endTime = serializers.TimeField(source='end_time')
    breakMinutes = serializers.IntegerField(source='break_minutes', required=False, default=60)
    graceMinutes = serializers.IntegerField(source='grace_minutes', required=False, default=15)
    isFlexible = serializers.BooleanField(source='is_flexible', required=False, default=False)
    flexHoursPerDay = serializers.FloatField(source='flex_hours_per_day', required=False, default=8.0)
    overtimeAfterMinutes = serializers.IntegerField(source='overtime_after_minutes', required=False, default=540)
    isNightShift = serializers.BooleanField(source='is_night_shift', required=False, default=False)
    isActive = serializers.BooleanField(source='is_active', required=False, default=True)
    createdBy = serializers.CharField(source='created_by', required=False, allow_blank=True, default='')

    class Meta:
        model = Shift
        fields = [
            'id', 'name', 'startTime', 'endTime', 'breakMinutes', 'graceMinutes',
            'isFlexible', 'flexHoursPerDay', 'overtimeAfterMinutes', 'isNightShift',
            'isActive', 'createdBy'
        ]
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'startTime': instance.start_time.strftime('%H:%M') if instance.start_time else '09:00',
            'endTime': instance.end_time.strftime('%H:%M') if instance.end_time else '18:00',
            'breakMinutes': instance.break_minutes,
            'graceMinutes': instance.grace_minutes,
            'isFlexible': bool(instance.is_flexible),
            'flexHoursPerDay': instance.flex_hours_per_day,
            'overtimeAfterMinutes': instance.overtime_after_minutes,
            'isNightShift': bool(instance.is_night_shift),
            'isActive': bool(instance.is_active),
            'createdBy': instance.created_by or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class ShiftAssignmentSerializer(serializers.ModelSerializer):
    effectiveFrom = serializers.DateField(source='effective_from')
    effectiveTo = serializers.DateField(source='effective_to', required=False, allow_null=True)
    createdBy = serializers.CharField(source='created_by', required=False, allow_blank=True, default='')
    shiftName = serializers.SerializerMethodField()

    class Meta:
        model = ShiftAssignment
        fields = ['id', 'email', 'shift', 'effectiveFrom', 'effectiveTo', 'createdBy', 'shiftName']
        read_only_fields = ['id']

    def get_shiftName(self, obj):
        return obj.shift.name if obj.shift else ''

    def to_representation(self, instance):
        ret = super().to_representation(instance)
        if instance.effective_from:
            ret['effectiveFrom'] = instance.effective_from.strftime(DATE_FMT)
        if instance.effective_to:
            ret['effectiveTo'] = instance.effective_to.strftime(DATE_FMT)
        else:
            ret['effectiveTo'] = None
        ret['createdAt'] = instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None
        return ret


class AttendanceCorrectionSerializer(serializers.ModelSerializer):
    employee = serializers.CharField(source='employee_name', required=False, allow_blank=True, default='')
    attendanceDate = serializers.DateField(source='attendance_date')
    requestedCheckIn = serializers.DateTimeField(source='requested_check_in', required=False, allow_null=True)
    requestedCheckOut = serializers.DateTimeField(source='requested_check_out', required=False, allow_null=True)
    reviewerNote = serializers.CharField(source='reviewer_note', required=False, allow_blank=True, allow_null=True, default='')
    reviewedAt = serializers.DateTimeField(source='reviewed_at', read_only=True)

    class Meta:
        model = AttendanceCorrection
        fields = [
            'id', 'email', 'employee', 'attendanceDate', 'requestedCheckIn',
            'requestedCheckOut', 'reason', 'status', 'reviewer', 'reviewerNote',
            'reviewedAt'
        ]
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'attendanceDate': instance.attendance_date.strftime(DATE_FMT) if instance.attendance_date else None,
            'requestedCheckIn': instance.requested_check_in.strftime(DATETIME_FMT) if instance.requested_check_in else None,
            'requestedCheckOut': instance.requested_check_out.strftime(DATETIME_FMT) if instance.requested_check_out else None,
            'reason': instance.reason or '',
            'status': instance.status,
            'reviewer': instance.reviewer or '',
            'reviewerNote': instance.reviewer_note or '',
            'reviewedAt': instance.reviewed_at.strftime(DATETIME_FMT) if instance.reviewed_at else None,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class GeoFenceSerializer(serializers.ModelSerializer):
    radiusMeters = serializers.IntegerField(source='radius_meters', required=False, default=200)
    isActive = serializers.BooleanField(source='is_active', required=False, default=True)
    createdBy = serializers.CharField(source='created_by', required=False, allow_blank=True, default='')

    class Meta:
        model = GeoFence
        fields = ['id', 'name', 'latitude', 'longitude', 'radiusMeters', 'isActive', 'createdBy']
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'latitude': instance.latitude,
            'longitude': instance.longitude,
            'radiusMeters': instance.radius_meters,
            'isActive': bool(instance.is_active),
            'createdBy': instance.created_by or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class WfhRequestSerializer(serializers.ModelSerializer):
    employee = serializers.CharField(source='employee_name', required=False, allow_blank=True, default='')
    fromDate = serializers.DateField(source='from_date')
    toDate = serializers.DateField(source='to_date')

    class Meta:
        model = WfhRequest
        fields = ['id', 'email', 'employee', 'fromDate', 'toDate', 'days', 'reason', 'status', 'approver']
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'fromDate': instance.from_date.strftime(DATE_FMT) if instance.from_date else None,
            'toDate': instance.to_date.strftime(DATE_FMT) if instance.to_date else None,
            'days': instance.days,
            'reason': instance.reason or '',
            'status': instance.status,
            'approver': instance.approver or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


# ===========================================================================
# Break Management Serializers
# ===========================================================================

class BreakPolicySerializer(serializers.ModelSerializer):
    maxBreakMinutesPerDay = serializers.IntegerField(source='max_break_minutes_per_day')
    minBreakMinutes = serializers.IntegerField(source='min_break_minutes')
    maxBreakMinutes = serializers.IntegerField(source='max_break_minutes')
    isPaid = serializers.BooleanField(source='is_paid')
    isActive = serializers.BooleanField(source='is_active')

    class Meta:
        model = BreakPolicy
        fields = ['id', 'name', 'maxBreakMinutesPerDay', 'minBreakMinutes', 'maxBreakMinutes', 'isPaid', 'isActive']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'maxBreakMinutesPerDay': instance.max_break_minutes_per_day,
            'minBreakMinutes': instance.min_break_minutes,
            'maxBreakMinutes': instance.max_break_minutes,
            'isPaid': instance.is_paid,
            'isActive': instance.is_active,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class BreakSerializer(serializers.ModelSerializer):
    breakStart = serializers.DateTimeField(source='break_start')
    breakEnd = serializers.DateTimeField(source='break_end', required=False, allow_null=True)
    breakType = serializers.CharField(source='break_type')
    isPaid = serializers.BooleanField(source='is_paid')
    breakMinutes = serializers.IntegerField(source='break_minutes', required=False, default=0)

    class Meta:
        model = Break
        fields = ['id', 'email', 'employee', 'date', 'breakStart', 'breakEnd', 'breakType', 'reason', 'isPaid', 'breakMinutes', 'status']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'date': instance.date.strftime('%Y-%m-%d') if instance.date else None,
            'breakStart': instance.break_start.strftime(DATETIME_FMT) if instance.break_start else None,
            'breakEnd': instance.break_end.strftime(DATETIME_FMT) if instance.break_end else None,
            'breakType': instance.break_type,
            'reason': instance.reason or '',
            'isPaid': instance.is_paid,
            'breakMinutes': instance.break_minutes,
            'status': instance.status,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


# ===========================================================================
# Late Check-In Alert Serializers
# ===========================================================================

class LateCheckInPolicySerializer(serializers.ModelSerializer):
    lateThresholdMinutes = serializers.IntegerField(source='late_threshold_minutes')
    escalationCount = serializers.IntegerField(source='escalation_count')
    isActive = serializers.BooleanField(source='is_active')

    class Meta:
        model = LateCheckInPolicy
        fields = ['id', 'name', 'lateThresholdMinutes', 'escalationCount', 'isActive']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'lateThresholdMinutes': instance.late_threshold_minutes,
            'escalationCount': instance.escalation_count,
            'isActive': instance.is_active,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class LateCheckInAlertSerializer(serializers.ModelSerializer):
    lateMinutes = serializers.IntegerField(source='late_minutes')
    checkInTime = serializers.DateTimeField(source='check_in_time')
    shiftStartTime = serializers.DateTimeField(source='shift_start_time')
    isExcused = serializers.BooleanField(source='is_excused')
    excusedBy = serializers.CharField(source='excused_by')
    excusedAt = serializers.DateTimeField(source='excused_at', required=False, allow_null=True)

    class Meta:
        model = LateCheckInAlert
        fields = ['id', 'email', 'employee', 'date', 'lateMinutes', 'checkInTime', 'shiftStartTime', 'reason', 'isExcused', 'excusedBy', 'excusedAt', 'escalated']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'date': instance.date.strftime('%Y-%m-%d') if instance.date else None,
            'lateMinutes': instance.late_minutes,
            'checkInTime': instance.check_in_time.strftime(DATETIME_FMT) if instance.check_in_time else None,
            'shiftStartTime': instance.shift_start_time.strftime(DATETIME_FMT) if instance.shift_start_time else None,
            'reason': instance.reason or '',
            'isExcused': instance.is_excused,
            'excusedBy': instance.excused_by or '',
            'excusedAt': instance.excused_at.strftime(DATETIME_FMT) if instance.excused_at else None,
            'escalated': instance.escalated,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


# ===========================================================================
# Overtime Management Serializers
# ===========================================================================

class OvertimePolicySerializer(serializers.ModelSerializer):
    overtimeThresholdMinutes = serializers.IntegerField(source='overtime_threshold_minutes')
    dailyMaxOvertimeMinutes = serializers.IntegerField(source='daily_max_overtime_minutes')
    weeklyMaxOvertimeMinutes = serializers.IntegerField(source='weekly_max_overtime_minutes')
    isActive = serializers.BooleanField(source='is_active')
    requiresApproval = serializers.BooleanField(source='requires_approval')

    class Meta:
        model = OvertimePolicy
        fields = ['id', 'name', 'overtimeThresholdMinutes', 'dailyMaxOvertimeMinutes', 'weeklyMaxOvertimeMinutes', 'isActive', 'requiresApproval']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'overtimeThresholdMinutes': instance.overtime_threshold_minutes,
            'dailyMaxOvertimeMinutes': instance.daily_max_overtime_minutes,
            'weeklyMaxOvertimeMinutes': instance.weekly_max_overtime_minutes,
            'isActive': instance.is_active,
            'requiresApproval': instance.requires_approval,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class OvertimeSerializer(serializers.ModelSerializer):
    shiftHours = serializers.FloatField(source='shift_hours')
    workedHours = serializers.FloatField(source='worked_hours')
    overtimeHours = serializers.FloatField(source='overtime_hours')
    overtimeType = serializers.CharField(source='overtime_type')
    approvalNote = serializers.CharField(source='approval_note', required=False, allow_blank=True)
    approvedAt = serializers.DateTimeField(source='approved_at', required=False, allow_null=True)

    class Meta:
        model = Overtime
        fields = ['id', 'email', 'employee', 'date', 'shiftHours', 'workedHours', 'overtimeHours', 'overtimeType', 'status', 'approver', 'approvalNote', 'approvedAt']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'date': instance.date.strftime('%Y-%m-%d') if instance.date else None,
            'shiftHours': instance.shift_hours,
            'workedHours': instance.worked_hours,
            'overtimeHours': instance.overtime_hours,
            'overtimeType': instance.overtime_type,
            'status': instance.status,
            'approver': instance.approver or '',
            'approvalNote': instance.approval_note or '',
            'approvedAt': instance.approved_at.strftime(DATETIME_FMT) if instance.approved_at else None,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class OvertimeBalanceSerializer(serializers.ModelSerializer):
    totalOvertimeHours = serializers.FloatField(source='total_overtime_hours')
    compOffHours = serializers.FloatField(source='comp_off_hours')
    cashPayoutHours = serializers.FloatField(source='cash_payout_hours')

    class Meta:
        model = OvertimeBalance
        fields = ['id', 'email', 'employee', 'period', 'totalOvertimeHours', 'compOffHours', 'cashPayoutHours']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'email': instance.email,
            'employee': instance.employee_name or '',
            'period': instance.period,
            'totalOvertimeHours': instance.total_overtime_hours,
            'compOffHours': instance.comp_off_hours,
            'cashPayoutHours': instance.cash_payout_hours,
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


# ===========================================================================
# WFH Policy Serializer
# ===========================================================================

class WFHPolicySerializer(serializers.ModelSerializer):
    maxWfhDaysPerWeek = serializers.IntegerField(source='max_wfh_days_per_week')
    maxWfhDaysPerMonth = serializers.IntegerField(source='max_wfh_days_per_month')
    requiresApproval = serializers.BooleanField(source='requires_approval')
    minAdvanceNoticeDays = serializers.IntegerField(source='min_advance_notice_days')
    isActive = serializers.BooleanField(source='is_active')

    class Meta:
        model = WFHPolicy
        fields = ['id', 'name', 'maxWfhDaysPerWeek', 'maxWfhDaysPerMonth', 'requiresApproval', 'minAdvanceNoticeDays', 'isActive']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'name': instance.name,
            'maxWfhDaysPerWeek': instance.max_wfh_days_per_week,
            'maxWfhDaysPerMonth': instance.max_wfh_days_per_month,
            'requiresApproval': instance.requires_approval,
            'minAdvanceNoticeDays': instance.min_advance_notice_days,
            'isActive': instance.is_active,
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


# ---------------------------------------------------------------------------
# Onboarding module
#
# Same contract as the rest of the API: camelCase out, snake_case columns, and a
# full ``to_representation`` so nullable columns coerce to '' rather than
# leaking None into the UI.
# ---------------------------------------------------------------------------
class OnboardingCandidateSerializer(serializers.ModelSerializer):
    firstName = serializers.CharField(source='first_name', required=False, allow_blank=True, default='')
    lastName = serializers.CharField(source='last_name', required=False, allow_blank=True, default='')
    jobTitle = serializers.CharField(source='job_title', required=False, allow_blank=True, default='')
    joiningDate = serializers.DateField(source='joining_date', required=False, allow_null=True)
    # candidate_code is server-generated (see onboarding_views.candidates) — never
    # accepted from the client, so it is declared read-only here.
    candidateCode = serializers.CharField(source='candidate_code', read_only=True)
    # dob/gender/address/manager share the model field name, so NO source= (DRF
    # forbids source equal to the field name and raises on bind otherwise).
    dob = serializers.DateField(required=False, allow_null=True)
    gender = serializers.CharField(required=False, allow_blank=True, default='')
    address = serializers.CharField(required=False, allow_blank=True, default='')
    manager = serializers.CharField(required=False, allow_blank=True, default='')
    workLocation = serializers.CharField(source='work_location', required=False, allow_blank=True, default='')
    interviewId = serializers.PrimaryKeyRelatedField(
        source='interview', queryset=InterviewLink.objects.all(),
        required=False, allow_null=True,
    )
    portalToken = serializers.CharField(source='portal_token', read_only=True)
    requestedDocs = serializers.JSONField(source='requested_docs', required=False)

    class Meta:
        model = OnboardingCandidate
        fields = [
            'id', 'candidateCode', 'firstName', 'lastName', 'email', 'phone',
            'dob', 'gender', 'address', 'client', 'vendor', 'recruiter', 'jobTitle',
            'department', 'manager', 'workLocation', 'joiningDate', 'status', 'interviewId',
            'portalToken', 'requestedDocs',
        ]
        read_only_fields = ['id', 'candidateCode']
        extra_kwargs = {
            'phone': {'required': False, 'allow_blank': True, 'default': ''},
            'client': {'required': False, 'allow_blank': True, 'default': ''},
            'vendor': {'required': False, 'allow_blank': True, 'default': ''},
            'recruiter': {'required': False, 'allow_blank': True, 'default': ''},
            'department': {'required': False, 'allow_blank': True, 'default': ''},
            'status': {'required': False, 'default': 'Draft'},
        }

    def to_representation(self, instance):
        auth = getattr(instance, 'work_authorization', None)
        verification = getattr(instance, 'hr_verification', None)
        payroll = getattr(instance, 'payroll', None)
        full_name = ' '.join(
            p for p in [instance.first_name or '', instance.last_name or ''] if p
        ).strip()
        return {
            'id': instance.id,
            'candidateCode': instance.candidate_code or '',
            'firstName': instance.first_name or '',
            'lastName': instance.last_name or '',
            'name': full_name,
            'email': instance.email or '',
            'phone': instance.phone or '',
            'dob': instance.dob.strftime(DATE_FMT) if instance.dob else None,
            'gender': instance.gender or '',
            'address': instance.address or '',
            'client': instance.client or '',
            'vendor': instance.vendor or '',
            'recruiter': instance.recruiter or '',
            'jobTitle': instance.job_title or '',
            'department': instance.department or '',
            'manager': instance.manager or '',
            'workLocation': instance.work_location or '',
            'joiningDate': instance.joining_date.strftime(DATE_FMT) if instance.joining_date else None,
            'status': instance.status or 'Draft',
            'interviewId': instance.interview_id,
            'customFields': instance.custom_fields or {},
            'requestedDocs': instance.requested_docs or [],
            # The portal link's expiry, so the Paper Forms tab can show how long
            # the candidate has left without a second call.
            'portalToken': instance.portal_token or None,
            'portalTokenExpiresAt': (
                instance.portal_token_expires_at.strftime(DATETIME_FMT)
                if instance.portal_token_expires_at else None
            ),
            # Denormalised summaries so the candidates table renders from one
            # call instead of an extra fetch per row.
            'authType': (auth.auth_type or '') if auth else '',
            'authStatus': (auth.status or '') if auth else '',
            'authExpiryDate': auth.expiry_date.strftime(DATE_FMT) if (auth and auth.expiry_date) else None,
            'verificationStatus': (verification.status or 'Pending') if verification else 'Pending',
            'payrollStatus': (payroll.status or 'Pending') if payroll else 'Pending',
            'stages': [
                {
                    'stage': s.stage,
                    'status': s.status or 'Pending',
                    'completedAt': s.completed_at.strftime(DATETIME_FMT) if s.completed_at else None,
                }
                for s in instance.stages.all()
            ],
            'createdBy': instance.created_by or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


class WorkAuthorizationSerializer(serializers.ModelSerializer):
    """The authorization plus its type-specific ``details`` blob, flattened into
    one object. The split across two tables is a storage concern, not an API one."""
    authType = serializers.CharField(source='auth_type', required=False, allow_blank=True, default='')
    expiryDate = serializers.DateField(source='expiry_date', required=False, allow_null=True)
    receiptNumber = serializers.CharField(source='receipt_number', required=False, allow_blank=True, default='')
    sponsorshipRequired = serializers.BooleanField(source='sponsorship_required', required=False, default=False)

    class Meta:
        model = WorkAuthorization
        fields = ['id', 'authType', 'status', 'expiryDate', 'receiptNumber', 'sponsorshipRequired']
        read_only_fields = ['id']
        extra_kwargs = {'status': {'required': False, 'default': 'Pending'}}

    def to_representation(self, instance):
        detail = getattr(instance, 'detail', None)
        return {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'authType': instance.auth_type or '',
            'status': instance.status or 'Pending',
            'expiryDate': instance.expiry_date.strftime(DATE_FMT) if instance.expiry_date else None,
            'receiptNumber': instance.receipt_number or '',
            'sponsorshipRequired': bool(instance.sponsorship_required),
            'details': (detail.details or {}) if detail else {},
            'customFields': instance.custom_fields or {},
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


class CandidateDocumentSerializer(serializers.ModelSerializer):
    """Mirrors UserDocumentSerializer: the heavy base64 blob is withheld from list
    output and only included when ``include_data=True`` is passed."""
    docType = serializers.CharField(source='doc_type')
    fileName = serializers.CharField(source='file_name', required=False, allow_blank=True, default='')
    fileMime = serializers.CharField(source='file_mime', required=False, allow_blank=True, default='')
    fileData = serializers.CharField(source='file_data', required=False, allow_blank=True, write_only=True)

    class Meta:
        model = CandidateDocument
        fields = ['id', 'docType', 'fileName', 'fileMime', 'fileData']
        read_only_fields = ['id']

    def __init__(self, *args, **kwargs):
        self._include_data = kwargs.pop('include_data', False)
        super().__init__(*args, **kwargs)

    def to_representation(self, instance):
        base = {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'docType': instance.doc_type,
            # Custom documents carry their own name; the fixed types are
            # labelled by the frontend from its DOC_TYPES list.
            'label': instance.label or '',
            'isCustom': bool(instance.is_custom),
            'fileName': instance.file_name or '',
            'fileMime': instance.file_mime or '',
            'fileSize': instance.file_size or 0,
            'version': instance.version or 1,
            'isActive': bool(instance.is_active),
            'uploadedBy': instance.uploaded_by or '',
            'uploadedAt': instance.uploaded_at.strftime(DATETIME_FMT) if instance.uploaded_at else None,
        }
        if self._include_data:
            base['fileData'] = instance.file_data or ''
        return base


class OnboardingActivityLogSerializer(serializers.ModelSerializer):
    """One audit row = one timeline entry; the UI renders these directly."""
    class Meta:
        model = OnboardingActivityLog
        fields = ['id', 'event', 'comments']
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'event': instance.event or '',
            'actorEmail': instance.actor_email or '',
            'actorName': instance.actor_name or '',
            'comments': instance.comments or '',
            'oldValue': instance.old_value or {},
            'newValue': instance.new_value or {},
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class OnboardingStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = OnboardingStatus
        fields = ['id', 'stage', 'status']
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'stage': instance.stage,
            'status': instance.status or 'Pending',
            'startedAt': instance.started_at.strftime(DATETIME_FMT) if instance.started_at else None,
            'completedAt': instance.completed_at.strftime(DATETIME_FMT) if instance.completed_at else None,
            'updatedBy': instance.updated_by or '',
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


class HrVerificationSerializer(serializers.ModelSerializer):
    ssnVerified = serializers.BooleanField(source='ssn_verified', required=False, default=False)
    driverLicenseVerified = serializers.BooleanField(source='driver_license_verified', required=False, default=False)
    stateIdVerified = serializers.BooleanField(source='state_id_verified', required=False, default=False)
    visaVerified = serializers.BooleanField(source='visa_verified', required=False, default=False)
    i94Verified = serializers.BooleanField(source='i94_verified', required=False, default=False)

    class Meta:
        model = HrVerification
        fields = [
            'id', 'ssnVerified', 'driverLicenseVerified', 'stateIdVerified',
            'visaVerified', 'i94Verified', 'status', 'remarks',
        ]
        read_only_fields = ['id']
        extra_kwargs = {
            'status': {'required': False, 'default': 'Pending'},
            'remarks': {'required': False, 'allow_blank': True, 'default': ''},
        }

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'ssnVerified': bool(instance.ssn_verified),
            'driverLicenseVerified': bool(instance.driver_license_verified),
            'stateIdVerified': bool(instance.state_id_verified),
            'visaVerified': bool(instance.visa_verified),
            'i94Verified': bool(instance.i94_verified),
            'customVerified': instance.custom_verified or {},
            'status': instance.status or 'Pending',
            'remarks': instance.remarks or '',
            'verifiedBy': instance.verified_by or '',
            'verifiedAt': instance.verified_at.strftime(DATETIME_FMT) if instance.verified_at else None,
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


class ManagerApprovalSerializer(serializers.ModelSerializer):
    """Append-only: an approval history, not a single mutable verdict."""
    class Meta:
        model = ManagerApproval
        fields = ['id', 'action', 'comments']
        read_only_fields = ['id']

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'action': instance.action or '',
            'comments': instance.comments or '',
            'approver': instance.approver or '',
            'actedAt': instance.acted_at.strftime(DATETIME_FMT) if instance.acted_at else None,
        }


class ItAssetAllocationSerializer(serializers.ModelSerializer):
    assetSource = serializers.CharField(source='asset_source', required=False, default='Eversoft')
    clientName = serializers.CharField(source='client_name', required=False, allow_blank=True, default='')
    assetId = serializers.CharField(source='asset_id', required=False, allow_blank=True, default='')
    issuedDate = serializers.DateField(source='issued_date', required=False, allow_null=True)
    assets = serializers.JSONField(required=False, default=list)

    class Meta:
        model = ItAssetAllocation
        fields = ['id', 'assetSource', 'clientName', 'assets', 'assetId', 'issuedDate', 'status']
        read_only_fields = ['id']
        extra_kwargs = {'status': {'required': False, 'default': 'Assigned'}}

    def to_representation(self, instance):
        return {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'assetSource': instance.asset_source or 'Eversoft',
            'clientName': instance.client_name or '',
            'assets': instance.assets or [],
            'assetId': instance.asset_id or '',
            'issuedDate': instance.issued_date.strftime(DATE_FMT) if instance.issued_date else None,
            'status': instance.status or 'Assigned',
            'allocatedBy': instance.allocated_by or '',
            'createdAt': instance.created_at.strftime(DATETIME_FMT) if instance.created_at else None,
        }


class PayrollInformationSerializer(serializers.ModelSerializer):
    """Bank details.

    ``accountNumber`` is **masked to its last 4 digits on read**. The full value
    is writeable but never round-trips back out, so an account number cannot leak
    through a screenshot, a browser cache, or the audit log. Callers that need to
    change it send a new one; there is no reason to ever read it back in full.
    """
    bankName = serializers.CharField(source='bank_name', required=False, allow_blank=True, default='')
    accountNumber = serializers.CharField(source='account_number', required=False, allow_blank=True, default='', write_only=True)
    routingNumber = serializers.CharField(source='routing_number', required=False, allow_blank=True, default='')
    taxState = serializers.CharField(source='tax_state', required=False, allow_blank=True, default='')
    directDeposit = serializers.BooleanField(source='direct_deposit', required=False, default=False)

    class Meta:
        model = PayrollInformation
        fields = [
            'id', 'bankName', 'accountNumber', 'routingNumber', 'taxState',
            'directDeposit', 'status',
        ]
        read_only_fields = ['id']
        extra_kwargs = {'status': {'required': False, 'default': 'Pending'}}

    def to_representation(self, instance):
        acct = (instance.account_number or '').strip()
        masked = ('*' * max(0, len(acct) - 4)) + acct[-4:] if acct else ''
        return {
            'id': instance.id,
            'candidateId': instance.candidate_id,
            'bankName': instance.bank_name or '',
            'accountNumberMasked': masked,
            'hasAccountNumber': bool(acct),
            'routingNumber': instance.routing_number or '',
            'taxState': instance.tax_state or '',
            'directDeposit': bool(instance.direct_deposit),
            'status': instance.status or 'Pending',
            'completedBy': instance.completed_by or '',
            'updatedAt': instance.updated_at.strftime(DATETIME_FMT) if instance.updated_at else None,
        }


class PayrollFormSerializer(serializers.ModelSerializer):
    fileName = serializers.CharField(source='file_name', required=False, allow_blank=True, default='')
    fileMime = serializers.CharField(source='file_mime', required=False, allow_blank=True, default='')
    fileData = serializers.CharField(source='file_data', required=False, allow_blank=True, default='', write_only=True)
    isActive = serializers.BooleanField(source='is_active', required=False, default=True)
    createdBy = serializers.CharField(source='created_by', read_only=True)
    createdAt = serializers.DateTimeField(source='created_at', read_only=True, format=DATETIME_FMT)

    class Meta:
        model = PayrollForm
        fields = ['id', 'name', 'fileName', 'fileMime', 'fileData', 'schema', 'isActive', 'createdBy', 'createdAt']


class CandidateFormSubmissionSerializer(serializers.ModelSerializer):
    candidateId = serializers.PrimaryKeyRelatedField(source='candidate', queryset=OnboardingCandidate.objects.all())
    formId = serializers.PrimaryKeyRelatedField(source='form', queryset=PayrollForm.objects.all())
    filledData = serializers.JSONField(source='filled_data', required=False, default=dict)
    signatureData = serializers.CharField(source='signature_data', required=False, allow_blank=True, default='')
    signedAt = serializers.DateTimeField(source='signed_at', required=False, allow_null=True, format=DATETIME_FMT)
    fileName = serializers.CharField(source='file_name', required=False, allow_blank=True, default='')
    fileMime = serializers.CharField(source='file_mime', required=False, allow_blank=True, default='application/pdf')
    fileSize = serializers.IntegerField(source='file_size', read_only=True)
    fileData = serializers.CharField(source='file_data', required=False, allow_blank=True, default='', write_only=True)
    createdAt = serializers.DateTimeField(source='created_at', read_only=True, format=DATETIME_FMT)

    class Meta:
        model = CandidateFormSubmission
        fields = [
            'id', 'candidateId', 'formId', 'filledData', 'signatureData', 'signedAt',
            'fileName', 'fileMime', 'fileSize', 'fileData', 'mode', 'createdAt'
        ]

    def to_representation(self, instance):
        ret = super().to_representation(instance)
        # Convert foreign keys to simple ints in camelCase output
        ret['candidateId'] = instance.candidate_id
        ret['formId'] = instance.form_id
        return ret


# ===========================================================================
# Core Payroll Serializers
# ===========================================================================

class EmployeeCompensationSerializer(serializers.ModelSerializer):
    class Meta:
        model = EmployeeCompensation
        fields = '__all__'


class PayComponentSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayComponent
        fields = '__all__'


class EmployeePayComponentSerializer(serializers.ModelSerializer):
    componentDetails = PayComponentSerializer(source='component', read_only=True)

    class Meta:
        model = EmployeePayComponent
        fields = '__all__'


class PayslipSerializer(serializers.ModelSerializer):
    class Meta:
        model = Payslip
        fields = '__all__'


class PayrollRunSerializer(serializers.ModelSerializer):
    payslips = PayslipSerializer(many=True, read_only=True)

    class Meta:
        model = PayrollRun
        fields = '__all__'


class PayrollSettingSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayrollSetting
        fields = '__all__'


# ==========================================================================
# Employee Chat serializers (appended by chat-module integration)
# ==========================================================================
from .models import ChatRoom, ChatMember, ChatMessage, ChatMeeting  # noqa: E402

class ChatRoomSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatRoom
        fields = "__all__"


class ChatMemberSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatMember
        fields = "__all__"


class ChatMessageSerializer(serializers.ModelSerializer):
    room_name = serializers.CharField(
        source="room.name",
        read_only=True,
    )
    message = serializers.SerializerMethodField()
    attachment_url = serializers.SerializerMethodField()
    age_seconds = serializers.SerializerMethodField()

    class Meta:
        model = ChatMessage
        fields = [
            "id",
            "sender_email",
            "sender_name",
            "message",
            "is_read",
            "created_at",
            "age_seconds",
            "room",
            "room_name",
            "edited",
            "edited_at",
            "is_deleted",
            "attachment_name",
            "attachment_type",
            "attachment_url",
        ]

    def get_message(self, obj):
        # Hide the original text once a message is deleted.
        return "" if getattr(obj, "is_deleted", False) else obj.message

    def get_age_seconds(self, obj):
        # How long ago the message was sent, computed entirely server-side so
        # it's immune to timezone differences between server and browser. The
        # frontend uses this for correct time display and the edit window.
        if not obj.created_at:
            return None
        try:
            from datetime import datetime as _dt
            return max(0, int((_dt.now() - obj.created_at).total_seconds()))
        except Exception:
            return None

    def get_attachment_url(self, obj):
        # Serve the file bytes on demand rather than shipping them in every
        # message list. Empty when deleted or when there's no attachment.
        if getattr(obj, "is_deleted", False):
            return ""
        if getattr(obj, "attachment_path", None) or obj.attachment_data:
            return f"/api/chat/attachment/{obj.id}"
        return ""


class ChatMeetingSerializer(serializers.ModelSerializer):
    room_name = serializers.CharField(source="room.name", read_only=True)
    attendees_list = serializers.SerializerMethodField()

    class Meta:
        model = ChatMeeting
        fields = [
            "id",
            "room",
            "room_name",
            "title",
            "description",
            "scheduled_at",
            "duration_minutes",
            "created_by",
            "created_by_name",
            "join_url",
            "attendees",
            "attendees_list",
            "created_at",
        ]

    def get_attendees_list(self, obj):
        raw = obj.attendees or ""
