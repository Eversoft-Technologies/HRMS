"""Attendance policy profiles + penalties API (workstream P).

    GET  /api/attendance/policies                   profiles (+ employee counts, built-in defaults)
    POST /api/attendance/policies                   create                       (attendance.policy.manage)
    GET/PATCH/DELETE /api/attendance/policies/<id>                               (writes: attendance.policy.manage)
    GET  /api/attendance/policies/assignments       individual assignments
    POST /api/attendance/policies/assignments       {profileId|null, emails:[..]} (attendance.policy.manage)
    GET|POST /api/attendance/policies/preview       who gets which profile; POST {draft} = with an
                                                    unsaved edit applied (nothing is written)
    GET  /api/attendance/policies/options           departments / locations / leave types / employees
    GET  /api/attendance/policies/resolve?email=    the rules that apply to one employee (self, or readers)
    GET  /api/attendance/penalties?month=YYYY-MM&email=&status=
    POST /api/attendance/penalties/<id>/waive       {note}     (manager of the employee or attendance.penalty.waive)
    POST /api/attendance/penalties/evaluate         {month, email?}  (attendance.policy.manage)

Reading profiles needs attendance.policy.view or attendance.policy.manage.
Profile edits are logged (logger 'api.attendance_ext.policy_views') with the
actor and the changed fields; created_by records the author.
"""
import logging

from django.db import IntegrityError, transaction
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api import permissions as perms
from api.models import AppUser, AttendancePenalty, AttendancePolicyAssignment, AttendancePolicyProfile, UserProfile
from api.timeutil import local_today

from . import penalties as pen
from .policy import BUILTIN, DRAFT_ID, FIELDS, PENALTY_ACTIONS, employees, preview, resolve

logger = logging.getLogger(__name__)

# RBAC (migration 0106): dedicated codes, editable per role in Access Control.
READ_CODES = ['attendance.policy.view', 'attendance.policy.manage']
WRITE_CODES = ['attendance.policy.manage']
# Seeing EVERYONE's penalties (pay-impacting). Others see their own and
# their direct reports'. attendance.view alone is not enough: the plain
# Employee role holds it.
PENALTY_ALL_CODES = ['attendance.policy.view', 'attendance.policy.manage', 'attendance.penalty.waive', 'attendance.audit']
WAIVE_CODES = ['attendance.penalty.waive']
META = ('name', 'description', 'is_default', 'is_active', 'priority', 'departments', 'locations')
BOOLS = {'use_shift_hours', 'count_early_outs', 'overtime_requires_approval', 'comp_off_enabled',
         'is_default', 'is_active'}
# (min, max) of every integer rule.
RANGES = {
    'full_day_minutes': (30, 1440), 'half_day_minutes': (0, 1440),
    'grace_checkin_minutes': (0, 240), 'grace_early_out_minutes': (0, 240),
    'late_half_day_after_minutes': (0, 720), 'free_lates_per_month': (0, 31),
    'short_leaves_per_month': (0, 31), 'short_leave_max_minutes': (0, 480),
    'regularize_within_days': (0, 90), 'overtime_daily_cap_minutes': (0, 1440),
    'overtime_weekly_cap_minutes': (0, 10080), 'comp_off_half_day_minutes': (0, 1440),
    'comp_off_full_day_minutes': (0, 1440), 'comp_off_expiry_days': (0, 730),
    'overtime_after_minutes': (0, 1440), 'priority': (-1000, 1000),
}


def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400, **extra):
    body = {'message': message}
    body.update(extra)
    return Response(body, status=status)


def _caller(request):
    perms._CACHE.clear()
    email, user = perms._get_caller(request)
    if user is not None and user.status != 'active':
        user = None
    return _norm(email), user


def _has(request, codes):
    allowed, _e, user = perms.check_perm(request, list(codes))
    return bool(allowed and user)


def _guard(request, codes):
    email, user = _caller(request)
    if not email or not user:
        return perms._auth_required(request)
    if not _has(request, codes):
        return _err("You don't have permission to perform this action. Required: " + ' or '.join(codes), 403,
                    code='PERMISSION_DENIED', required=codes[0])
    return None


def _names(emails=None):
    out = {}
    for u in AppUser.objects.all().only('email', 'full_name'):
        if u.email:
            out[_norm(u.email)] = u.full_name or ''
    for p in UserProfile.objects.all().only('email', 'first_name', 'last_name'):
        n = f'{p.first_name or ""} {p.last_name or ""}'.strip()
        if n and not out.get(_norm(p.email)):
            out[_norm(p.email)] = n
    return {k: (v or k.split('@')[0]) for k, v in out.items()}


# ---------------------------------------------------------------------------
# profiles
# ---------------------------------------------------------------------------
def profile_dict(p, counts=None):
    d = {'id': p.id, 'name': p.name, 'description': p.description or '', 'is_default': p.is_default,
         'is_active': p.is_active, 'priority': p.priority, 'departments': list(p.departments or []),
         'locations': list(p.locations or []), 'created_by': p.created_by or '',
         'created_at': p.created_at.strftime('%Y-%m-%d %H:%M:%S') if p.created_at else None,
         'updated_at': p.updated_at.strftime('%Y-%m-%d %H:%M:%S') if p.updated_at else None}
    for f in FIELDS:
        d[f] = getattr(p, f)
    d['penalty_leave_types'] = list(p.penalty_leave_types or [])
    if counts is not None:
        c = counts.get(p.id, {})
        d['employee_count'] = sum(c.values())
        d['counts'] = c
        d['assignment_count'] = AttendancePolicyAssignment.objects.filter(profile=p).count()
    return d


def _str_list(v, field, limit=200):
    if v is None:
        return []
    if isinstance(v, str):
        v = [x for x in v.split(',')]
    if not isinstance(v, (list, tuple)):
        raise ValueError(f'{field} must be a list.')
    out, seen = [], set()
    for x in v:
        s = str(x or '').strip()[:120]
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out[:limit]


def clean(data, instance=None):
    """{field: value} to write; raises ValueError with a user message."""
    out = {}
    for k in META + FIELDS:
        if k not in data:
            continue
        v = data[k]
        if k == 'name':
            v = str(v or '').strip()
            if not v:
                raise ValueError('Give the profile a name.')
            if len(v) > 100:
                raise ValueError('The name can be at most 100 characters.')
        elif k == 'description':
            v = str(v or '').strip()[:2000]
        elif k in BOOLS:
            v = v if isinstance(v, bool) else str(v).strip().lower() in ('1', 'true', 'yes', 'on')
        elif k in ('departments', 'locations', 'penalty_leave_types'):
            v = _str_list(v, k.replace('_', ' '))
        elif k == 'penalty_action':
            v = str(v or '').strip()
            if v not in PENALTY_ACTIONS:
                raise ValueError('Penalty action must be half_day_leave, lop_half_day or warning.')
        elif k == 'comp_off_leave_type':
            v = str(v or '').strip()[:60] or 'Comp Off'
        elif k in RANGES:
            if k == 'overtime_after_minutes' and (v is None or str(v).strip() == ''):
                v = None
            else:
                try:
                    v = int(float(v))
                except (TypeError, ValueError):
                    raise ValueError(f'{k.replace("_", " ").capitalize()} must be a number.')
                lo, hi = RANGES[k]
                if not lo <= v <= hi:
                    raise ValueError(f'{k.replace("_", " ").capitalize()} must be between {lo} and {hi}.')
        out[k] = v
    full = out.get('full_day_minutes', getattr(instance, 'full_day_minutes', BUILTIN['full_day_minutes']))
    half = out.get('half_day_minutes', getattr(instance, 'half_day_minutes', BUILTIN['half_day_minutes']))
    if half > full:
        raise ValueError('The half-day minimum cannot be longer than a full day.')
    return out


def _counts():
    counts = {}
    builtin = 0
    for _e, _p, pol in preview():
        if pol.profile_id is None:
            builtin += 1
            continue
        c = counts.setdefault(pol.profile_id, {})
        c[pol.source] = c.get(pol.source, 0) + 1
    return counts, builtin


def _unset_other_defaults(p):
    if p.is_default:
        AttendancePolicyProfile.objects.exclude(pk=p.pk).filter(is_default=True).update(is_default=False)


@api_view(['GET', 'POST'])
def policies(request):
    if request.method == 'GET':
        denied = _guard(request, READ_CODES)
        if denied:
            return denied
        counts, builtin = _counts()
        rows = [profile_dict(p, counts) for p in AttendancePolicyProfile.objects.all().order_by('-is_default', 'name')]
        return Response({'profiles': rows, 'canManage': _has(request, WRITE_CODES), 'builtin': dict(BUILTIN),
                         'builtinCount': builtin, 'penaltyActions': list(PENALTY_ACTIONS),
                         'employeeCount': sum(r['employee_count'] for r in rows) + builtin})
    denied = _guard(request, WRITE_CODES)
    if denied:
        return denied
    actor, _u = _caller(request)
    try:
        values = clean(request.data or {})
    except ValueError as e:
        return _err(str(e))
    if 'name' not in values:
        return _err('Give the profile a name.')
    try:
        with transaction.atomic():
            p = AttendancePolicyProfile.objects.create(created_by=actor, **values)
            _unset_other_defaults(p)
    except IntegrityError:
        return _err('A profile with this name already exists.', 409)
    logger.info('attendance policy profile %s "%s" created by %s: %s', p.pk, p.name, actor, sorted(values))
    return Response(profile_dict(p, _counts()[0]), status=201)


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
def policy_detail(request, pk):
    p = AttendancePolicyProfile.objects.filter(pk=pk).first()
    if request.method == 'GET':
        denied = _guard(request, READ_CODES)
        if denied:
            return denied
        if not p:
            return _err('Profile not found.', 404)
        d = profile_dict(p, _counts()[0])
        names = _names()
        d['assignments'] = [{'email': a.email, 'name': names.get(_norm(a.email), a.email)}
                            for a in AttendancePolicyAssignment.objects.filter(profile=p).order_by('email')]
        return Response(d)
    denied = _guard(request, WRITE_CODES)
    if denied:
        return denied
    if not p:
        return _err('Profile not found.', 404)
    actor, _u = _caller(request)
    if request.method == 'DELETE':
        n_assign = AttendancePolicyAssignment.objects.filter(profile=p).count()
        name = p.name
        p.delete()
        logger.info('attendance policy profile %s "%s" deleted by %s (%s assignments removed)', pk, name, actor,
                    n_assign)
        return Response({'ok': True, 'removedAssignments': n_assign})
    try:
        values = clean(request.data or {}, p)
    except ValueError as e:
        return _err(str(e))
    changed = {k: (getattr(p, k), v) for k, v in values.items() if getattr(p, k) != v}
    for k, v in values.items():
        setattr(p, k, v)
    try:
        with transaction.atomic():
            p.save()
            _unset_other_defaults(p)
    except IntegrityError:
        return _err('A profile with this name already exists.', 409)
    if changed:
        logger.info('attendance policy profile %s "%s" changed by %s: %s', p.pk, p.name, actor,
                    '; '.join(f'{k}: {o!r} -> {n!r}' for k, (o, n) in sorted(changed.items())))
    return Response(dict(profile_dict(p, _counts()[0]), changed=sorted(changed)))


@api_view(['GET', 'POST'])
def assignments(request):
    if request.method == 'GET':
        denied = _guard(request, READ_CODES)
        if denied:
            return denied
        names = _names()
        rows = [{'email': a.email, 'name': names.get(_norm(a.email), a.email), 'profileId': a.profile_id,
                 'profileName': a.profile.name, 'assignedBy': a.assigned_by,
                 'assignedAt': a.assigned_at.strftime('%Y-%m-%d %H:%M:%S') if a.assigned_at else None}
                for a in AttendancePolicyAssignment.objects.select_related('profile').order_by('email')]
        return Response({'assignments': rows})
    denied = _guard(request, WRITE_CODES)
    if denied:
        return denied
    actor, _u = _caller(request)
    body = request.data or {}
    emails = body.get('emails') or ([body['email']] if body.get('email') else [])
    if not isinstance(emails, list) or not emails:
        return _err('Choose at least one employee.')
    emails = sorted({_norm(e) for e in emails if _norm(e)})
    if len(emails) > 1000:
        return _err('At most 1000 employees at a time.')
    pid = body.get('profileId')
    profile = None
    if pid not in (None, '', 0, '0'):
        profile = AttendancePolicyProfile.objects.filter(pk=pid).first()
        if not profile:
            return _err('Profile not found.', 404)
    known = set(employees()) | {_norm(e) for e in AppUser.objects.values_list('email', flat=True)}
    unknown = [e for e in emails if e not in known]
    if unknown:
        return _err('Unknown employee: ' + ', '.join(unknown[:5]))
    with transaction.atomic():
        if profile is None:
            n = AttendancePolicyAssignment.objects.filter(email__in=emails).delete()[0]
        else:
            n = 0
            for e in emails:
                AttendancePolicyAssignment.objects.update_or_create(
                    email=e, defaults={'profile': profile, 'assigned_by': actor})
                n += 1
    logger.info('attendance policy assignments by %s: %s -> %s', actor, emails,
                profile.name if profile else '(rule-based)')
    return Response({'ok': True, 'count': n, 'profileId': profile.id if profile else None})


@api_view(['GET', 'POST'])
def policy_preview(request):
    denied = _guard(request, READ_CODES)
    if denied:
        return denied
    draft = (request.data or {}).get('draft') if request.method == 'POST' else None
    if draft is not None and not isinstance(draft, dict):
        return _err('draft must be an object.')
    names = _names()
    rows, counts = [], {}
    for e, prof, pol in preview(draft):
        key = pol.profile_id if pol.profile_id is not None else 'builtin'
        counts[str(key)] = counts.get(str(key), 0) + 1
        rows.append({'email': e, 'name': names.get(e, e), 'department': prof.department or '',
                     'location': prof.location or '', 'profileId': pol.profile_id,
                     'profileName': pol.name, 'source': pol.source})
    return Response({'rows': rows, 'counts': counts, 'draftId': DRAFT_ID})


@api_view(['GET'])
def policy_options(request):
    denied = _guard(request, READ_CODES)
    if denied:
        return denied
    people = employees()
    names = _names()
    deps = sorted({(p.department or '').strip() for p in people.values() if (p.department or '').strip()},
                  key=str.lower)
    locs = sorted({(p.location or '').strip() for p in people.values() if (p.location or '').strip()},
                  key=str.lower)
    try:
        from api.views import _leave_policy
        leave_types = [t['name'] for t in _leave_policy()['types']]
    except Exception:
        leave_types = ['Casual Leave', 'Sick Leave', 'Earned Leave']
    return Response({
        'departments': deps, 'locations': locs, 'leaveTypes': leave_types,
        'penaltyActions': [{'value': 'half_day_leave', 'label': 'Deduct ½ day leave (LOP if no balance)'},
                           {'value': 'lop_half_day', 'label': '½ day Loss of Pay'},
                           {'value': 'warning', 'label': 'Warning only'}],
        'employees': [{'email': e, 'name': names.get(e, e), 'department': p.department or '',
                       'location': p.location or '', 'employeeId': p.employee_id or ''}
                      for e, p in sorted(people.items(), key=lambda kv: names.get(kv[0], kv[0]).lower())],
    })


@api_view(['GET'])
def policy_resolve(request):
    email, user = _caller(request)
    if not email or not user:
        return perms._auth_required(request)
    target = _norm(request.query_params.get('email')) or email
    if target != email and not _has(request, READ_CODES):
        return _err('You can only see your own attendance policy.', 403)
    return Response(dict(resolve(target).as_dict(), email=target))


# ---------------------------------------------------------------------------
# penalties
# ---------------------------------------------------------------------------
def _can_waive(request, caller, p):
    from api import org_views
    if caller == _norm(p.email):
        return False
    return _has(request, WAIVE_CODES) or org_views.is_manager_of(caller, p.email)


@api_view(['GET'])
def penalty_list(request):
    from api import org_views
    caller, user = _caller(request)
    if not caller or not user:
        return perms._auth_required(request)
    q = request.query_params
    qs = AttendancePenalty.objects.all()
    see_all = _has(request, PENALTY_ALL_CODES)
    if not see_all:
        allowed = {caller} | {_norm(e) for e in org_views.reports_of(caller)}
        qs = qs.filter(email__in=allowed)
    month = str(q.get('month') or '').strip()
    if month:
        try:
            pen.parse_period(month)
        except ValueError:
            return _err('month must be YYYY-MM.')
        qs = qs.filter(period=month[:7])
    email = _norm(q.get('email'))
    if email:
        qs = qs.filter(email__iexact=email)
    status = _norm(q.get('status'))
    if status:
        qs = qs.filter(status=status)
    rows = list(qs.order_by('-date', '-id')[:1000])
    names = _names()
    out = []
    for p in rows:
        d = pen.dto(p, names)
        d['canWaive'] = p.status != 'waived' and not (p.status == 'lop' and p.paid_run_id) \
            and _can_waive(request, caller, p)
        out.append(d)
    summary = {}
    for p in rows:
        summary[p.status] = summary.get(p.status, 0) + 1
    return Response({'results': out, 'count': len(out), 'summary': summary, 'seeAll': see_all,
                     'month': month[:7] if month else ''})


@api_view(['POST'])
def penalty_waive(request, pk):
    caller, user = _caller(request)
    if not caller or not user:
        return perms._auth_required(request)
    p = AttendancePenalty.objects.filter(pk=pk).first()
    if not p:
        return _err('Penalty not found.', 404)
    if caller == _norm(p.email):
        return _err('You cannot waive your own penalty.', 403, code='SELF_APPROVAL')
    if not _can_waive(request, caller, p):
        return _err("Only the employee's manager or HR (attendance.penalty.waive) can waive a penalty.", 403)
    try:
        p = pen.waive(p, caller, (request.data or {}).get('note'))
    except pen.Refused as e:
        return _err(str(e), e.status)
    return Response({'ok': True, 'message': 'Penalty waived.', 'penalty': pen.dto(p, _names())})


@api_view(['POST'])
def penalty_evaluate(request):
    denied = _guard(request, WRITE_CODES)
    if denied:
        return denied
    body = request.data or {}
    month = str(body.get('month') or local_today().strftime('%Y-%m'))
    try:
        y, m = pen.parse_period(month)
    except ValueError:
        return _err('month must be YYYY-MM.')
    email = _norm(body.get('email'))
    emails = [email] if email else pen.month_emails(y, m)
    created = removed = 0
    for e in emails:
        r = pen.evaluate_month(e, y, m)
        created += len(r['created'])
        removed += len(r['removed'])
    return Response({'ok': True, 'month': f'{y:04d}-{m:02d}', 'employees': len(emails), 'created': created,
                     'removed': removed})
