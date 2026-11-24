"""Leave ledger endpoints (accrual, manual adjustments, year-end rollover).

GET  /api/leave/ledger?email=&year=     entries + balances (self, or HR)
POST /api/leave/ledger/adjust           {email, type, days, note, year?, effectiveDate?}   HR
POST /api/leave/accrual/run             {upto?, email?}                                     HR
POST /api/leave/rollover                {year, dryRun (default true)}                      HR
GET  /api/leave/ledger/people           active employees for the HR picker                 HR

HR = Super Admin, or a role with settings.manage or leave.action.
Identity is the X-User-Email header (api/permissions.py).
"""
from datetime import date

from django.http import JsonResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.permissions import _get_caller, _is_super_admin, _user_has_perm, _CACHE
from api.timeutil import local_today

from . import leave_accrual as la


def _err(message, status=400):
    return Response({'message': message}, status=status)


def _caller(request):
    _CACHE.clear()
    email, user = _get_caller(request)
    return (email or '').strip().lower(), user


def _is_hr(user):
    return bool(user) and (_is_super_admin(user) or _user_has_perm(user, 'settings.manage')
                           or _user_has_perm(user, 'leave.action'))


def _guard(request, self_email=None):
    """(caller_email, error_response). HR always passes; anyone else only for
    their own email when self_email is given."""
    email, user = _caller(request)
    if not email or not user:
        return email, JsonResponse({'message': 'Sign in to continue.', 'code': 'AUTH_REQUIRED'}, status=401)
    if _is_hr(user) or (self_email and self_email == email):
        return email, None
    return email, JsonResponse({'message': "You don't have permission to perform this action. "
                                           'Required: leave.action or settings.manage',
                                'code': 'PERMISSION_DENIED', 'required': 'leave.action'}, status=403)


def _year(v, default):
    try:
        y = int(v) if v not in (None, '') else default
    except (TypeError, ValueError):
        return None
    return y if 1900 <= y <= 2200 else None


@api_view(['GET'])
def ledger(request):
    from api.models import LeaveLedgerEntry
    email = (request.GET.get('email') or '').strip().lower()
    if not email:
        return _err('email is required')
    _, denied = _guard(request, self_email=email)
    if denied:
        return denied
    today = local_today()
    year = _year(request.GET.get('year'), today.year)
    if year is None:
        return _err('year must be between 1900 and 2200')
    from api.models import LeaveRequest
    pol, bl = la.balances(email, year, today=today)
    rows = LeaveLedgerEntry.objects.filter(email=email, year=year).order_by('effective_date', 'id')
    # The leave taken against the balances — the same requests (approved =
    # used, pending shown apart) views._leave_usage counts, so the per-type
    # "used" in `balances` is exactly the sum of these rows.
    leaves = LeaveRequest.objects.filter(email=email, from_date__year=year,
                                         status__in=('Approved', 'Pending')).order_by('from_date', 'id')
    return Response({'email': email, 'year': year, 'balances': bl,
                     'entries': [la.entry_dict(e) for e in rows],
                     'leaves': [{'id': lr.id, 'type': lr.type, 'status': lr.status, 'days': lr.days or 0,
                                 'fromDate': lr.from_date.isoformat() if lr.from_date else None,
                                 'toDate': lr.to_date.isoformat() if lr.to_date else None}
                                for lr in leaves],
                     'enforceBalance': pol['enforceBalance']})


@api_view(['POST'])
def adjust(request):
    actor, denied = _guard(request)
    if denied:
        return denied
    b = request.data or {}
    email = str(b.get('email') or '').strip().lower()
    if not email or '@' not in email:
        return _err('Choose an employee.')
    rule = la.find_rule(b.get('type'))
    if not rule:
        return _err('Choose one of the leave types in the leave policy.')
    if rule.get('days') is None:
        return _err(f'"{rule["name"]}" has no limit — there is no balance to adjust.')
    try:
        days = float(b.get('days'))
    except (TypeError, ValueError):
        return _err('Days must be a number (negative to deduct).')
    if days == 0 or abs(days) > la.LIMIT or round(days * 2) != days * 2:
        return _err(f'Days must be a non-zero multiple of 0.5 between -{la.LIMIT} and {la.LIMIT}.')
    note = ' '.join(str(b.get('note') or '').split())
    if len(note) < 3:
        return _err('Add a note saying why (it is kept in the ledger).')
    if len(note) > 255:
        return _err('Keep the note under 255 characters.')
    eff = la._date(b.get('effectiveDate')) if b.get('effectiveDate') else local_today()
    if eff is None:
        return _err('effectiveDate must be YYYY-MM-DD.')
    year = _year(b.get('year'), eff.year)
    if year is None:
        return _err('year must be between 1900 and 2200')
    row = la.adjust(email, rule['name'], days, note, actor, year=year, effective_date=eff)
    return Response({'entry': la.entry_dict(row), 'balance': la.balance(email, rule['name'], year)}, status=201)


@api_view(['POST'])
def accrual_run(request):
    _, denied = _guard(request)
    if denied:
        return denied
    b = request.data or {}
    upto = la._date(b.get('upto')) if b.get('upto') else local_today()
    if upto is None or upto > local_today():
        return _err('upto must be a date (YYYY-MM-DD) no later than today.')
    one = str(b.get('email') or '').strip().lower()
    emails = [one] if one else la.employee_emails(upto.year)
    created = 0
    for e in emails:
        created += len(la.accrue(e, upto))
    return Response({'upto': upto.isoformat(), 'employees': len(emails), 'entries': created})


@api_view(['POST'])
def rollover(request):
    actor, denied = _guard(request)
    if denied:
        return denied
    b = request.data or {}
    today = local_today()
    year = _year(b.get('year'), today.year - 1)
    if year is None:
        return _err('year must be between 1900 and 2200')
    dry = b.get('dryRun', True) not in (False, 'false', '0', 0)
    if not dry and date(year, 12, 31) > today:
        return _err(f'{year} has not ended yet — run the preview, and roll it over from 31 Dec {year}.')
    one = str(b.get('email') or '').strip().lower()
    out = la.year_end_rollover(year, emails=[one] if one else None, dry_run=dry, actor=actor)
    return Response(out)


@api_view(['GET'])
def people(request):
    from api.models import AppUser
    _, denied = _guard(request)
    if denied:
        return denied
    rows = AppUser.objects.filter(status='active').order_by('full_name').values('email', 'full_name')
    return Response([{'email': (r['email'] or '').lower(), 'name': r['full_name'] or r['email']} for r in rows])
