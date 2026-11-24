"""HTTP endpoints for overtime & comp-off (engine: attendance_ext/overtime.py).

GET  /api/attendance/overtime-records
        ?scope=mine (default) | team | all  &email= &status= &dayType= &from= &to= &month=YYYY-MM
        mine: the caller's own (or ?email= of someone the caller may view)
        team: the caller's reports + records routed to them; with attendance.edit
              everyone but the caller (the Approvals tab: &status=Pending)
        all : attendance.view or attendance.edit
POST /api/attendance/overtime-records/<pk>/decide   {action: approve|reject, minutes?, note?}
POST /api/attendance/overtime-records/batch         {action, ids: [..], note?}
GET  /api/attendance/overtime-summary?email=&month=YYYY-MM
        approved / payable / pending OT, comp-off earned, balance, used, expiring
POST /api/attendance/overtime-evaluate              {from, to, email?, dryRun?}   attendance.edit
        recompute a date range (max 92 days)
"""
import logging
from datetime import datetime

from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.models import OvertimeRecord
from api.timeutil import local_today

from . import overtime as ot
from . import policy as policy_mod

logger = logging.getLogger(__name__)

MAX_RANGE_DAYS = 92
MAX_BATCH = 100
EDIT_PERM = 'overtime.approve'
VIEW_PERMS = ('overtime.approve', 'attendance.audit')


def _err(message, status=400, code=None):
    d = {'message': message, 'error': message}
    if code:
        d['code'] = code
    return Response(d, status=status)


def _norm(v):
    return str(v or '').strip().lower()


def _caller(request):
    from api import permissions
    permissions._CACHE.clear()
    email, user = permissions._get_caller(request)
    if not email or not user or (user.status and user.status != 'active'):
        return None
    return _norm(email)


def _has(request, code):
    from api.permissions import check_perm
    return check_perm(request, code)[0]


def _can_view(request, caller, email):
    from api import org_views
    if caller == _norm(email):
        return True
    if any(_has(request, p) for p in VIEW_PERMS):
        return True
    return org_views.is_manager_of(caller, email)


def _date(v):
    try:
        return datetime.strptime(str(v).strip()[:10], '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return None


def _month(v):
    try:
        y, m = str(v).strip()[:7].split('-')
        y, m = int(y), int(m)
        return (y, m) if 1 <= m <= 12 and 2000 <= y <= 2100 else None
    except (TypeError, ValueError):
        return None


@api_view(['GET'])
def records(request):
    from api import org_views
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    q = request.query_params
    scope = _norm(q.get('scope')) or 'mine'
    has_edit = _has(request, EDIT_PERM)
    qs = OvertimeRecord.objects.all()
    if scope == 'mine':
        email = _norm(q.get('email')) or caller
        if not _can_view(request, caller, email):
            return _err('You are not allowed to view this overtime.', 403)
        qs = qs.filter(email=email)
    elif scope == 'team':
        qs = qs.exclude(email=caller)
        if not has_edit:
            qs = qs.filter(Q(email__in=[_norm(e) for e in org_views.reports_of(caller)])
                           | Q(approver_email__iexact=caller))
        if q.get('email'):
            qs = qs.filter(email=_norm(q.get('email')))
    elif scope == 'all':
        if not any(_has(request, p) for p in VIEW_PERMS):
            return _err('Permission denied: overtime.approve', 403, 'PERMISSION_DENIED')
        if q.get('email'):
            qs = qs.filter(email=_norm(q.get('email')))
    else:
        return _err('scope must be mine, team or all.')
    status = str(q.get('status') or '').strip()
    if status and status.lower() != 'all':
        wanted = [s for s in ot.STATUSES if s.lower() in {x.strip().lower() for x in status.split(',')}]
        if not wanted:
            return _err('Unknown status.')
        qs = qs.filter(status__in=wanted)
    dtype = _norm(q.get('dayType'))
    if dtype:
        if dtype not in ot.DAY_TYPES:
            return _err('dayType must be working, weekend or holiday.')
        qs = qs.filter(day_type=dtype)
    month = _month(q.get('month')) if q.get('month') else None
    if q.get('month') and not month:
        return _err('month must be YYYY-MM.')
    if month:
        qs = qs.filter(date__year=month[0], date__month=month[1])
    frm, to = _date(q.get('from')), _date(q.get('to'))
    if frm:
        qs = qs.filter(date__gte=frm)
    if to:
        qs = qs.filter(date__lte=to)
    try:
        limit = max(1, min(int(q.get('limit') or 500), 2000))
    except ValueError:
        limit = 500
    rows = list(qs.order_by('-date', '-id')[:limit])
    items = [ot.to_dict(r, caller, has_edit) for r in rows]
    if scope == 'team' and not has_edit:
        items = [i for i in items if i['status'] != 'Pending' or i['canDecide']]
    return Response({'scope': scope, 'items': items, 'count': len(items), 'canEdit': has_edit,
                     'canViewAll': any(_has(request, p) for p in VIEW_PERMS),
                     'isManager': bool(org_views.reports_of(caller))})


def _decide_one(request, caller, pk, action, minutes, note, has_edit):
    rec = OvertimeRecord.objects.filter(pk=pk).first()
    if rec is None:
        return 404, {'message': 'Overtime record not found.'}
    if _norm(rec.email) == caller:
        return 403, {'message': 'You cannot approve or reject your own overtime.', 'code': 'SELF_APPROVAL'}
    if not ot.can_decide(caller, has_edit, rec):
        return 403, {'message': 'You are not allowed to decide this overtime.', 'code': 'PERMISSION_DENIED'}
    try:
        rec, emailed = ot.decide(pk, caller, action, minutes, note)
    except ot.Invalid as e:
        return e.status, {'message': str(e)}
    verb = 'approved' if rec.status == 'Approved' else 'rejected'
    return 200, {'success': True, 'message': f'Overtime {verb}.', 'emailed': emailed,
                 'record': ot.to_dict(rec, caller, has_edit)}


@api_view(['POST'])
def decide(request, pk):
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    b = request.data or {}
    status, data = _decide_one(request, caller, pk, b.get('action'), b.get('minutes'),
                               b.get('note') or b.get('reviewerNote'), _has(request, EDIT_PERM))
    if status != 200:
        data.setdefault('error', data.get('message'))
    return Response(data, status=status)


@api_view(['POST'])
def batch(request):
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    b = request.data or {}
    ids = b.get('ids') or []
    if not isinstance(ids, list) or not ids:
        return _err('Choose at least one overtime record.')
    if len(ids) > MAX_BATCH:
        return _err(f'At most {MAX_BATCH} records at a time.')
    action = _norm(b.get('action'))
    if action not in ('approve', 'reject'):
        return _err('action must be approve or reject.')
    has_edit = _has(request, EDIT_PERM)
    results, seen = [], set()
    for raw in ids:
        try:
            pk = int(raw)
        except (TypeError, ValueError):
            continue
        if pk in seen:
            continue
        seen.add(pk)
        status, data = _decide_one(request, caller, pk, action, None, b.get('note'), has_edit)
        results.append({'id': pk, 'ok': status == 200, 'status': status, 'message': data.get('message')})
    ok = sum(1 for r in results if r['ok'])
    return Response({'action': action, 'total': len(results), 'ok': ok, 'failed': len(results) - ok,
                     'results': results})


@api_view(['GET'])
def summary(request):
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    q = request.query_params
    email = _norm(q.get('email')) or caller
    if not _can_view(request, caller, email):
        return _err('You are not allowed to view this overtime.', 403)
    today = local_today()
    ym = _month(q.get('month')) if q.get('month') else (today.year, today.month)
    if not ym:
        return _err('month must be YYYY-MM.')
    try:
        with transaction.atomic():
            ot.expire(today, email=email)           # lazy: no cron needed for an accurate balance
    except Exception:
        logger.exception('overtime: lazy comp-off expiry failed for %s', email)
    data = ot.summary(email, ym[0], ym[1], today)
    data['policy'] = ot.policy_json(policy_mod.resolve(email))
    data['today'] = today.isoformat()
    return Response(data)


@api_view(['POST'])
def evaluate(request):
    caller = _caller(request)
    if not caller:
        return _err('Authentication required. Please sign in again.', 401)
    if not _has(request, EDIT_PERM):
        return _err('Permission denied: overtime.approve', 403, 'PERMISSION_DENIED')
    b = request.data or {}
    frm, to = _date(b.get('from')), _date(b.get('to'))
    if not frm or not to:
        return _err('from and to (YYYY-MM-DD) are required.')
    if to < frm:
        return _err('to must not be before from.')
    if (to - frm).days + 1 > MAX_RANGE_DAYS:
        return _err(f'Recompute at most {MAX_RANGE_DAYS} days at a time.')
    dry = str(b.get('dryRun') or '').lower() in ('1', 'true', 'yes')
    with transaction.atomic():
        out = ot.evaluate_range(frm, to, email=_norm(b.get('email')) or None, actor=caller)
        if dry:
            transaction.set_rollback(True)
    out.update({'from': frm.isoformat(), 'to': to.isoformat(), 'dryRun': dry})
    return Response(out)
