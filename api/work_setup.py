"""Work setup: home-location change requests and the profile summary.

Responsibilities stay distinct (see the plan in the PR):
  * WorkArrangement — where/when someone is expected to work (onsite/hybrid/remote)
  * ShiftAssignment — their working hours for a date range
  * WfhRequest      — approval to work remotely on specific dates
  * GeoFence        — location verification: office fences for onsite check-ins,
                      the employee's APPROVED home fence for WFH check-ins.
An approved home fence never grants WFH by itself, and an approved WFH request
never marks a check-in as verified by itself.

Home-location changes: the employee proposes; the approved fence stays in force
until someone holding attendance.approve_offsite approves the replacement. Nobody
reviews their own request. Every request is kept as audit history.
"""
from datetime import timedelta

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import (EmployeeAttendance, GeoFence, HomeLocationChange, ShiftAssignment,
                     WfhRequest, WorkArrangement)
from .permissions import check_perm
from .timeutil import local_now, local_today

REVIEW_PERM = 'attendance.approve_offsite'
DT = '%Y-%m-%d %H:%M:%S'
STATUS_NOT_SET, STATUS_PENDING, STATUS_APPROVED = 'Not set up', 'Pending review', 'Approved'
STATUS_REJECTED, STATUS_CHANGE = 'Rejected', 'Change requested'


def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400):
    return Response({'message': message}, status=status)


def _dt(v):
    return v.strftime(DT) if v else None


# --- home status --------------------------------------------------------------
def home_fence_row(email):
    """The employee's home fence row in any state (one per employee)."""
    return GeoFence.objects.filter(owner_email=_norm(email)).first()


def pending_change(email):
    return HomeLocationChange.objects.filter(email=_norm(email), kind=HomeLocationChange.CHANGE,
                                             status=HomeLocationChange.PENDING).first()


def home_status(email, fence=None, change=None):
    """One of: Not set up, Pending review, Approved, Rejected, Change requested."""
    fence = fence if fence is not None else home_fence_row(email)
    if fence is None:
        return STATUS_NOT_SET
    if fence.status == GeoFence.APPROVED:
        change = change if change is not None else pending_change(email)
        return STATUS_CHANGE if change else STATUS_APPROVED
    if fence.status == GeoFence.REJECTED:
        return STATUS_REJECTED
    return STATUS_PENDING


def change_json(c, show_location=True):
    d = {
        'id': c.id, 'email': c.email, 'kind': c.kind, 'status': c.status, 'reason': c.reason,
        'requestedBy': c.requested_by, 'requestedAt': _dt(c.requested_at),
        'reviewer': c.reviewer, 'reviewedAt': _dt(c.reviewed_at), 'reviewNote': c.review_note,
        'radiusMeters': c.radius_meters, 'capturedAccuracy': c.captured_accuracy,
        'captureMethod': c.capture_method or 'gps',
    }
    if show_location:
        d.update({'latitude': c.latitude, 'longitude': c.longitude, 'name': c.name,
                  'previous': c.previous or {}})
    return d


def _fence_snapshot(f):
    if f is None:
        return {}
    return {'latitude': f.latitude, 'longitude': f.longitude, 'radiusMeters': f.radius_meters,
            'name': f.name, 'status': f.status, 'reviewer': f.reviewer, 'reviewedAt': _dt(f.reviewed_at)}


def log_initial(fence, requested_by, accuracy=None):
    """Record (or refresh) the pending 'initial' history row for a home fence
    submitted before any approval existed."""
    row = HomeLocationChange.objects.filter(fence=fence, kind=HomeLocationChange.INITIAL,
                                            status=HomeLocationChange.PENDING).first()
    row = row or HomeLocationChange(fence=fence, kind=HomeLocationChange.INITIAL, email=_norm(fence.owner_email))
    row.status = HomeLocationChange.PENDING
    row.name, row.latitude, row.longitude = fence.name, fence.latitude, fence.longitude
    row.radius_meters, row.captured_accuracy = fence.radius_meters, accuracy
    row.capture_method = fence.capture_method or 'gps'
    row.requested_by = requested_by or fence.owner_email
    row.save()
    return row


def close_initial(fence, decision, reviewer):
    HomeLocationChange.objects.filter(fence=fence, kind=HomeLocationChange.INITIAL,
                                      status=HomeLocationChange.PENDING).update(
        status=decision, reviewer=reviewer or '', reviewed_at=local_now())


def request_change(email, requested_by, lat, lng, radius, accuracy, name, reason, capture_method='gps'):
    """File (or refresh) the one pending change for an approved fence. The fence
    itself is not touched."""
    fence = home_fence_row(email)
    row = pending_change(email) or HomeLocationChange(email=_norm(email), kind=HomeLocationChange.CHANGE)
    row.fence = fence
    row.status = HomeLocationChange.PENDING
    row.name = name or (fence.name if fence else '')
    row.latitude, row.longitude, row.radius_meters = lat, lng, radius
    row.captured_accuracy, row.reason = accuracy, reason
    row.capture_method = capture_method
    row.requested_by = requested_by or email
    row.previous = _fence_snapshot(fence)
    row.save()
    return row


# --- change-request endpoints ---------------------------------------------------
@api_view(['GET'])
def home_changes(request):
    """History / queue of home-location requests.
    HR (attendance.approve_offsite) sees everyone's; others see only their own."""
    allowed, caller, user = check_perm(request, REVIEW_PERM)
    caller = _norm(caller)
    if not caller or not user:
        return _err('Authentication required. Please sign in again.', 401)
    qs = HomeLocationChange.objects.all()
    email = _norm(request.GET.get('email'))
    if not allowed:
        if email and email != caller:
            return _err('Permission denied: ' + REVIEW_PERM, 403)
        email = caller
    if email:
        qs = qs.filter(email=email)
    status = request.GET.get('status')
    if status:
        qs = qs.filter(status=status)
    kind = request.GET.get('kind')
    if kind:
        qs = qs.filter(kind=kind)
    return Response([change_json(c) for c in qs[:300]])


@api_view(['POST'])
def home_change_decide(request, pk):
    """Approve or reject a proposed home-location change. Approval is the only
    path that updates the active home fence."""
    allowed, caller, user = check_perm(request, REVIEW_PERM)
    caller = _norm(caller)
    if not caller or not user:
        return _err('Authentication required. Please sign in again.', 401)
    if not allowed:
        return _err('Permission denied: ' + REVIEW_PERM, 403)
    row = HomeLocationChange.objects.filter(pk=pk, kind=HomeLocationChange.CHANGE).first()
    if row is None:
        return _err('Change request not found', 404)
    if row.status != HomeLocationChange.PENDING:
        return _err(f'This request was already {row.status.lower()}.', 409)
    if _norm(row.email) == caller:
        return _err('You cannot review your own home-location request.', 403)
    body = request.data or {}
    decision = str(body.get('decision') or '').strip().title()
    if decision not in (HomeLocationChange.APPROVED, HomeLocationChange.REJECTED):
        return _err('decision must be Approved or Rejected')
    note = str(body.get('note') or '').strip()
    now = local_now()
    fence = home_fence_row(row.email)
    row.previous = _fence_snapshot(fence)
    if decision == HomeLocationChange.APPROVED:
        if fence is None:
            fence = GeoFence(owner_email=row.email, created_by=row.requested_by)
        fence.name = row.name or fence.name or f'Home — {row.email}'
        fence.latitude, fence.longitude, fence.radius_meters = row.latitude, row.longitude, row.radius_meters
        fence.captured_accuracy = row.captured_accuracy
        fence.capture_method = row.capture_method or 'gps'
        fence.is_active = True
        fence.status = GeoFence.APPROVED
        fence.reviewer, fence.reviewed_at = caller, now
        fence.save()
        row.fence = fence
    row.status, row.reviewer, row.reviewed_at, row.review_note = decision, caller, now, note
    row.save()
    from .org_views import notify
    notify(row.email, f'Home location change {decision.lower()}',
           ('Your new home location is now used to verify work-from-home check-ins.'
            if decision == HomeLocationChange.APPROVED else
            'Your home location change was rejected; your previously approved location stays in use.')
           + (f' Note: {note}' if note else ''), '/employees/attendance')
    return Response(change_json(row))


@api_view(['DELETE'])
def home_change_cancel(request, pk):
    """The requester withdraws their own pending change."""
    _a, caller, user = check_perm(request, REVIEW_PERM)
    caller = _norm(caller)
    if not caller or not user:
        return _err('Authentication required. Please sign in again.', 401)
    row = HomeLocationChange.objects.filter(pk=pk, kind=HomeLocationChange.CHANGE).first()
    if row is None or _norm(row.email) != caller:
        return _err('Change request not found', 404)
    if row.status != HomeLocationChange.PENDING:
        return _err(f'This request was already {row.status.lower()}.', 409)
    row.status, row.reviewed_at, row.reviewer = HomeLocationChange.CANCELLED, local_now(), caller
    row.save()
    return Response(change_json(row))


# --- profile summary ------------------------------------------------------------
def _arr_json(a):
    if a is None:
        return None
    from .views import WEEKDAY_NAMES
    return {
        'arrangement': a.arrangement,
        'remoteWeekdays': [WEEKDAY_NAMES[d][:3] for d in sorted(a.weekday_set())],
        'remoteDaysPerWeek': a.remote_days_per_week,
        'effectiveFrom': a.effective_from.isoformat() if a.effective_from else None,
        'effectiveTo': a.effective_to.isoformat() if a.effective_to else None,
    }


def work_setup_summary(email, can_see_location):
    """Bounded read-only summary for the employee profile."""
    from .views import _get_active_shift, arrangement_for
    email = _norm(email)
    today = local_today()

    current = arrangement_for(email, today)
    upcoming = (WorkArrangement.objects.filter(email=email, effective_from__gt=today)
                .order_by('effective_from').first())

    assignment = (ShiftAssignment.objects.select_related('shift')
                  .filter(email=email, effective_from__lte=today)
                  .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=today))
                  .order_by('-effective_from', '-id').first())
    shift = assignment.shift if assignment else _get_active_shift(email, today)
    shift_json = None
    if shift is not None:
        shift_json = {
            'name': shift.name,
            'start': shift.start_time.strftime('%H:%M') if shift.start_time else '',
            'end': shift.end_time.strftime('%H:%M') if shift.end_time else '',
            'flexible': bool(shift.is_flexible),
            'flexHours': shift.flex_hours_per_day if shift.is_flexible else None,
            'effectiveFrom': assignment.effective_from.isoformat() if assignment else None,
            'effectiveTo': assignment.effective_to.isoformat() if assignment and assignment.effective_to else None,
            'isDefault': assignment is None,
        }

    wfh = (WfhRequest.objects.filter(email=email, to_date__gte=today - timedelta(days=30))
           .order_by('-from_date')[:5])
    wfh_json = [{'id': w.id, 'fromDate': w.from_date.isoformat() if w.from_date else None,
                 'toDate': w.to_date.isoformat() if w.to_date else None, 'status': w.status,
                 'approver': w.approver or ''} for w in wfh]

    fence = home_fence_row(email)
    change = pending_change(email)
    home = {
        'status': home_status(email, fence, change),
        'updatedAt': _dt((fence.reviewed_at or fence.created_at) if fence else None),
        'reviewer': fence.reviewer if fence else '',
        'pendingChange': change_json(change, can_see_location) if change else None,
    }
    if fence is not None:
        home['captureMethod'] = fence.capture_method or 'gps'
    if fence is not None and can_see_location:
        home.update({'latitude': fence.latitude, 'longitude': fence.longitude,
                     'radiusMeters': fence.radius_meters, 'name': fence.name})

    att = EmployeeAttendance.objects.filter(email=email, date=today).first()
    today_json = None
    if att is not None:
        today_json = {
            'checkedIn': bool(att.check_in) and not att.check_out,
            'mode': 'WFH' if att.is_wfh else 'Onsite',
            'locationVerified': bool(att.geo_verified),
            'locationStatus': att.location_status or '',
        }
    return {
        'arrangement': _arr_json(current),
        'upcomingArrangement': _arr_json(upcoming),
        'shift': shift_json,
        'wfh': wfh_json,
        'home': home,
        'today': today_json,
        'canSeeLocation': bool(can_see_location),
    }


# --- data issues for HR review ---------------------------------------------------
def setup_issues():
    """Inconsistent work-setup data, listed for HR instead of being guessed at."""
    from .org_views import known_emails
    known = known_emails()
    out = []
    open_asg = {}
    for a in ShiftAssignment.objects.filter(effective_to__isnull=True).order_by('email', 'effective_from'):
        open_asg.setdefault(_norm(a.email), []).append(a)
    for email, rows in open_asg.items():
        if len(rows) > 1:
            out.append({'kind': 'Overlapping shift assignments', 'id': rows[-1].id, 'employee': email,
                        'name': f'{len(rows)} open-ended assignments', 'status': 'Needs HR'})
    for a in ShiftAssignment.objects.all():
        if _norm(a.email) not in known:
            out.append({'kind': 'Shift for unknown employee', 'id': a.id, 'employee': a.email,
                        'name': a.shift.name if a.shift_id else '', 'status': 'Needs HR'})
    for a in WorkArrangement.objects.filter(effective_to__isnull=True):
        if _norm(a.email) not in known:
            out.append({'kind': 'Arrangement for unknown employee', 'id': a.id, 'employee': a.email,
                        'name': a.arrangement, 'status': 'Needs HR'})
        elif a.arrangement == WorkArrangement.HYBRID and not a.weekday_set() and not a.remote_days_per_week:
            out.append({'kind': 'Hybrid with no remote days', 'id': a.id, 'employee': a.email,
                        'name': 'hybrid', 'status': 'Needs HR'})
    stale = local_now() - timedelta(days=14)
    for f in GeoFence.objects.exclude(owner_email='').filter(status=GeoFence.PENDING, created_at__lt=stale):
        out.append({'kind': 'Home location pending > 14 days', 'id': f.id, 'employee': f.owner_email,
                    'name': f.name, 'status': 'Pending'})
    return out
