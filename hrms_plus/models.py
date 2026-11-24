"""Models of the hrms_plus app. People are referenced by email (house style
of the api app: AppUser / UserProfile are keyed by email)."""
from django.db import models

from api.timeutil import local_now


# ---------------------------------------------------------------------------
# Careers: public job board + applications into the HRMS
# ---------------------------------------------------------------------------
class JobApplication(models.Model):
    """An application submitted from the public careers page / embeddable
    widget (or added by a recruiter). The job is api.JobPost."""
    STATUSES = ('new', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')
    job = models.ForeignKey('api.JobPost', on_delete=models.CASCADE, related_name='applications')
    full_name = models.CharField(max_length=200)
    email = models.CharField(max_length=255, db_index=True)
    phone = models.CharField(max_length=40, default='', blank=True)
    location = models.CharField(max_length=200, default='', blank=True)
    linkedin_url = models.CharField(max_length=300, default='', blank=True)
    cover_letter = models.TextField(default='', blank=True)
    answers = models.JSONField(default=dict, blank=True)          # job custom questions
    resume_name = models.CharField(max_length=255, default='', blank=True)
    resume_mime = models.CharField(max_length=100, default='', blank=True)
    resume_data = models.TextField(default='', blank=True)        # base64 (house style)
    resume_sha256 = models.CharField(max_length=64, default='', blank=True, db_index=True)
    resume_score_id = models.IntegerField(null=True, blank=True)  # api.ResumeScore when scored
    source = models.CharField(max_length=30, default='careers')   # careers | widget | referral | manual
    source_detail = models.CharField(max_length=255, default='', blank=True)  # embedding site / referrer
    status = models.CharField(max_length=20, default='new', db_index=True)
    stage_note = models.TextField(default='', blank=True)
    consent = models.BooleanField(default=False)                  # privacy consent ticked
    ip_hash = models.CharField(max_length=64, default='', blank=True, db_index=True)  # rate limiting, no raw IP
    reviewed_by = models.CharField(max_length=255, default='', blank=True)
    created_at = models.DateTimeField(default=local_now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'job_applications'
        ordering = ['-id']
        indexes = [models.Index(fields=['job', 'status'])]


# ---------------------------------------------------------------------------
# Matrix reporting: lines besides UserProfile.manager_email (the line manager)
# ---------------------------------------------------------------------------
class ReportingLine(models.Model):
    """A secondary reporting relationship. The functional / people manager
    stays UserProfile.manager_email; this adds e.g. a project or scrum lead,
    with how much of the person's time that line takes."""
    KINDS = ('project', 'dotted', 'functional')
    email = models.CharField(max_length=255, db_index=True)        # the report
    lead_email = models.CharField(max_length=255, db_index=True)   # project / scrum lead
    kind = models.CharField(max_length=20, default='project')
    project = models.CharField(max_length=160, default='', blank=True)
    allocation_pct = models.PositiveSmallIntegerField(default=0)   # 0-100
    start_date = models.DateField(null=True, blank=True)
    end_date = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True, db_index=True)
    created_by = models.CharField(max_length=255, default='', blank=True)
    created_at = models.DateTimeField(default=local_now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'reporting_lines'
        ordering = ['email', '-allocation_pct']


# ---------------------------------------------------------------------------
# Goals & OKRs: Company -> Department -> Team -> Individual
# ---------------------------------------------------------------------------
class Objective(models.Model):
    LEVELS = ('company', 'department', 'team', 'individual')
    STATUSES = ('draft', 'active', 'completed', 'cancelled')
    period = models.CharField(max_length=10, db_index=True)        # e.g. 2026-Q4
    level = models.CharField(max_length=12, default='individual', db_index=True)
    title = models.CharField(max_length=255)
    description = models.TextField(default='', blank=True)
    owner_email = models.CharField(max_length=255, db_index=True)
    department = models.CharField(max_length=120, default='', blank=True, db_index=True)
    team_id = models.IntegerField(null=True, blank=True, db_index=True)   # api.Team
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='children')
    status = models.CharField(max_length=12, default='active', db_index=True)
    progress = models.FloatField(default=0)                        # 0-100, rolled up from KRs / children
    visibility = models.CharField(max_length=12, default='public')  # public | team | private
    created_by = models.CharField(max_length=255, default='', blank=True)
    created_at = models.DateTimeField(default=local_now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'okr_objectives'
        ordering = ['period', 'level', 'id']


class KeyResult(models.Model):
    METRICS = ('percent', 'number', 'currency', 'boolean', 'milestone')
    objective = models.ForeignKey(Objective, on_delete=models.CASCADE, related_name='key_results')
    title = models.CharField(max_length=255)
    metric = models.CharField(max_length=12, default='percent')
    start_value = models.FloatField(default=0)
    target_value = models.FloatField(default=100)
    current_value = models.FloatField(default=0)
    unit = models.CharField(max_length=20, default='', blank=True)
    owner_email = models.CharField(max_length=255, default='', blank=True, db_index=True)
    due_date = models.DateField(null=True, blank=True)
    weight = models.FloatField(default=1)
    progress = models.FloatField(default=0)                        # 0-100
    confidence = models.PositiveSmallIntegerField(default=7)       # 1-10, latest check-in
    created_at = models.DateTimeField(default=local_now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'okr_key_results'
        ordering = ['objective_id', 'id']


class OkrCheckIn(models.Model):
    """A weekly progress update on one key result."""
    key_result = models.ForeignKey(KeyResult, on_delete=models.CASCADE, related_name='check_ins')
    author_email = models.CharField(max_length=255)
    value = models.FloatField()
    progress = models.FloatField(default=0)
    confidence = models.PositiveSmallIntegerField(default=7)
    note = models.TextField(default='', blank=True)
    week = models.CharField(max_length=10, default='', blank=True, db_index=True)  # ISO week 2026-W47
    created_at = models.DateTimeField(default=local_now)

    class Meta:
        db_table = 'okr_check_ins'
        ordering = ['-created_at']


# ---------------------------------------------------------------------------
# IT asset life-cycle
# ---------------------------------------------------------------------------
class Asset(models.Model):
    """One physical or licensed asset in the inventory."""
    CATEGORIES = ('laptop', 'desktop', 'monitor', 'phone', 'tablet', 'peripheral',
                  'access_card', 'license', 'other')
    STATUSES = ('in_stock', 'assigned', 'repair', 'retired', 'lost')
    asset_tag = models.CharField(max_length=60, unique=True)
    category = models.CharField(max_length=20, default='laptop', db_index=True)
    name = models.CharField(max_length=200, default='', blank=True)      # "MacBook Pro 14"
    make = models.CharField(max_length=100, default='', blank=True)
    model = models.CharField(max_length=120, default='', blank=True)
    serial_number = models.CharField(max_length=120, default='', blank=True, db_index=True)
    purchase_date = models.DateField(null=True, blank=True)
    purchase_cost = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, default='INR')
    vendor = models.CharField(max_length=160, default='', blank=True)
    warranty_until = models.DateField(null=True, blank=True, db_index=True)
    license_seats = models.PositiveIntegerField(null=True, blank=True)   # licenses only
    license_expiry = models.DateField(null=True, blank=True, db_index=True)
    ownership = models.CharField(max_length=20, default='company')      # company | client | byod
    client_name = models.CharField(max_length=200, default='', blank=True)
    location = models.CharField(max_length=160, default='', blank=True)
    status = models.CharField(max_length=12, default='in_stock', db_index=True)
    condition = models.CharField(max_length=20, default='good')         # new | good | fair | damaged
    notes = models.TextField(default='', blank=True)
    custom = models.JSONField(default=dict, blank=True)
    created_by = models.CharField(max_length=255, default='', blank=True)
    created_at = models.DateTimeField(default=local_now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'it_assets'
        ordering = ['asset_tag']


class AssetAssignment(models.Model):
    """Who holds an asset (a license may have several active assignments)."""
    STATUSES = ('active', 'returned', 'lost', 'written_off')
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name='assignments')
    email = models.CharField(max_length=255, db_index=True)
    assigned_at = models.DateTimeField(default=local_now)
    assigned_by = models.CharField(max_length=255, default='', blank=True)
    expected_return = models.DateField(null=True, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)       # employee accepted custody
    returned_at = models.DateTimeField(null=True, blank=True)
    return_condition = models.CharField(max_length=20, default='', blank=True)
    received_by = models.CharField(max_length=255, default='', blank=True)
    status = models.CharField(max_length=12, default='active', db_index=True)
    recovery_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    separation_id = models.IntegerField(null=True, blank=True, db_index=True)   # api.Separation (F&F)
    allocation_id = models.IntegerField(null=True, blank=True)                  # api.ItAssetAllocation it came from
    note = models.TextField(default='', blank=True)

    class Meta:
        db_table = 'it_asset_assignments'
        ordering = ['-assigned_at']


class AssetEvent(models.Model):
    """Append-only history of an asset (created, assigned, returned, repair…)."""
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name='events')
    kind = models.CharField(max_length=30)
    actor = models.CharField(max_length=255, default='', blank=True)
    email = models.CharField(max_length=255, default='', blank=True)     # holder involved, if any
    note = models.TextField(default='', blank=True)
    data = models.JSONField(default=dict, blank=True)
    at = models.DateTimeField(default=local_now, db_index=True)

    class Meta:
        db_table = 'it_asset_events'
        ordering = ['-at', '-id']
