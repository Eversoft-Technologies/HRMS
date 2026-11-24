"""My Team command center (Team Management Phase 1) — /api/my-team/*.

One page for a manager: what is waiting for their decision, where their
people are right now, the team's month and who is over- or under-loaded.

ONE unit with the existing features
-----------------------------------
Nothing here re-implements an approval rule. The inbox lists a request only
when the feature's OWN permission predicate says the caller may decide it,
and a decision is executed by dispatching an internal sub-request (same
identity headers: X-User-Email + Authorization) to the very endpoint the
feature's own page calls:

    leave          PUT  /api/leave/<id>                       views.leave_detail
    wfh            POST /api/attendance/wfh/approve|reject/    attendance_views.WFHRequestViewSet
    regularization POST /api/attendance/regularization/<id>/decide   regularization.decide
    short_leave    POST /api/attendance/short-leave/<id>/decide      short_leave.short_leave_decide
    timesheet      POST /api/timesheets/week/<id>/decide       timesheets.decide_week
    expense        POST /api/payroll/ess/expenses/<id>/decide  ess.expense_decide
    loan           POST /api/payroll/ess/loans/<id>/decide     ess.loan_decide
    offsite        POST /api/attendance/location-reviews       views.attendance_location_reviews
    recheckin      POST /api/attendance/recheckin/<id>/decide  views.attendance_recheckin_decide

so notifications, audit rows, attendance recalculation, fresh-sign-in checks
and every error message are exactly the feature's own. The hub only adds two
guards in front of every type: it refuses a decision on the caller's own
request, and on one that is no longer pending.

Live presence reuses /api/attendance/team (views.attendance_team, the Check
In/Out page's "Team Status Now" card) and layers leave, the employee's own
holiday calendar (attendance_ext/holidays.py) and weekends on top.

Who is "my team"
----------------
* default: the caller's direct reports (UserProfile.manager_email);
  ``indirect=1`` adds the whole reporting tree below them;
* ``teamId``: members of a Team the caller leads (HR: any team);
* ``scope=project``: people with a current matrix ReportingLine
  (hrms_plus.org) to the caller as project / scrum lead (HR: ``lead=<email>``).
  Members, presence, calendar and workload only — the inbox is always empty
  for this scope: a project lead has no approval rights, approvals stay with
  the line manager. Workload and members carry each person's allocation
  split ("60% Project Alpha, 40% line team") when the caller may see it;
* HR / admin (attendance.edit or attendance.audit): ``manager=<email>``, ``department=<name>`` or
  ``scope=all``. An HR caller with no reports defaults to ``all``.
Approval items routed to the caller by name (approver_email) are always in
their inbox, whatever the scope.

No salary data is returned. Expense / loan amounts are shown only to callers
holding expense.approve / payroll.loans.approve.
"""
import json
import logging
import re
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.db.models import Q
from django.test.client import RequestFactory
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import org_views
from .models import (AppUser, EmployeeAttendance, EmployeeLoan, EmployeeTask, ExpenseClaim, LeaveRequest,
                     Shift, ShiftAssignment, Team, TeamMembership, TimesheetEntry, TimesheetWeek, UserProfile,
                     WfhRequest)
from .permissions import _CACHE, _get_caller, _user_has_perm, check_perm

logger = logging.getLogger(__name__)

TYPES = ('leave', 'wfh', 'regularization', 'timesheet', 'expense', 'loan', 'offsite', 'overtime', 'short_leave',
         'recheckin')
TYPE_LABELS = {
    'short_leave': 'Short leave',
    'leave': 'Leave', 'wfh': 'Work from home', 'regularization': 'Regularization',
    'timesheet': 'Timesheet', 'expense': 'Expense claim', 'loan': 'Loan / advance',
    'offsite': 'Off-site check-in',
    'overtime': 'Overtime',
    'recheckin': 'Check-in after auto check-out',
}
LINKS = {
    'short_leave': '/employees/checkin',
    'leave': '/employees/leave',
    'wfh': '/employees/checkin?focus=Work+From+Home',
    'regularization': '/employees/checkin',
    'timesheet': '/timesheets',
    'expense': '/my-pay',
    'loan': '/my-pay',
    'offsite': '/employees/attendance',
    'overtime': '/attendance/overtime',
    'recheckin': '/employees/attendance',
}
# Rejecting these needs a reason — the underlying endpoint refuses without one.
NOTE_REQUIRED = {'timesheet', 'expense', 'loan'}
# LeaveRequest / WfhRequest have no column for a decision note.
NOTE_STORED = {'regularization', 'timesheet', 'expense', 'loan', 'offsite', 'overtime', 'short_leave', 'recheckin'}
MAX_BATCH = 100
LOAN_PERM = 'payroll.loans.approve'

WORKLOAD_DEFAULTS = {
    'maxHighTasks': 6,        # > this many open high-priority tasks → overloaded
    'maxWeekHours': 50,       # > this many hours in the week → overloaded
    'longDayHours': 10,       # a day over this many hours is a long day …
    'longDayRun': 3,          # … and this many in a row → overloaded
    'underPct': 50,           # < this % of expected hours …
    'underMaxTasks': 1,       # … with at most this many open tasks → under-utilized
}

_RF = RequestFactory()
_FORWARD_META = ('HTTP_X_USER_EMAIL', 'HTTP_X_ACTOR_EMAIL', 'HTTP_AUTHORIZATION', 'REMOTE_ADDR',
                 'HTTP_USER_AGENT', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP')


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _now():
    # The clock the reused attendance views use (tests patch api.views.local_now).
    from . import views
    return views.local_now()


def _today():
    return _now().date()


def _iso(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(v, date):
        return v.isoformat()
    return str(v)


def _money(v):
    try:
        return float(Decimal(v or 0).quantize(Decimal('0.01')))
    except Exception:
        return None


def _has(user, code):
    return bool(user) and _user_has_perm(user, code)


#: Who may look at ANY team (manager=/department=/scope=all). Not
#: employee.view: the plain Employee role holds it (and on some installs
#: employee.edit/create too) for the directory, which would let every employee
#: browse everyone's presence, leave and workload. Attendance management is
#: held only by HR and Super Admin.
VIEW_ALL_PERMS = ('attendance.edit', 'attendance.audit')


def _can_view_all(user):
    return any(_has(user, c) for c in VIEW_ALL_PERMS)


def _ident(request):
    """(email, user, error_response)."""
    _CACHE.clear()
    email, user = _get_caller(request)
    email = _norm(email)
    if not email or not user:
        return email, user, _err('Authentication required. Please sign in again.', 401, 'AUTH_REQUIRED')
    if (user.status or 'active') != 'active':
        return email, user, _err('Permission denied: account is not active', 403, 'FORBIDDEN')
    return email, user, None


def _int(v, default, lo, hi):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


# ---------------------------------------------------------------------------
# internal dispatch to an existing endpoint
# ---------------------------------------------------------------------------
def _call(request, caller, method, path, view, body=None, **kwargs):
    """Run ``view`` as if the caller's browser had called ``path`` itself:
    same identity headers, same client address. (status, data)."""
    meta = {k: request.META[k] for k in _FORWARD_META if request.META.get(k)}
    meta.setdefault('HTTP_X_USER_EMAIL', caller)
    if method == 'GET':
        sub = _RF.get(path, data=body or {}, **meta)
    else:
        sub = getattr(_RF, method.lower())(path, data=json.dumps(body or {}),
                                           content_type='application/json', **meta)
    resp = view(sub, **kwargs)
    data = getattr(resp, 'data', None)
    if data is None:
        try:
            data = json.loads(resp.content or b'null')
        except Exception:
            data = None
    _CACHE.clear()
    return resp.status_code, data


def _message(data, fallback):
    if isinstance(data, dict):
        for k in ('message', 'error', 'detail'):
            if data.get(k):
                return str(data[k])
    return fallback


# ---------------------------------------------------------------------------
# who is "my team"
# ---------------------------------------------------------------------------
class Scope:
    def __init__(self):
        self.kind = 'reports'
        self.label = 'My direct reports'
        self.emails = []          # [] = nobody; None = everybody (HR "all")
        self.indirect = False
        self.manager = ''
        self.department = ''
        self.team_id = None
        self.lead = ''

    def contains(self, email):
        return self.emails is None or _norm(email) in self._set

    def finish(self, caller, inactive):
        if self.emails is not None:
            self.emails = sorted({_norm(e) for e in self.emails if _norm(e)} - {caller} - inactive)
            self._set = set(self.emails)
        return self

    def json(self):
        return {'kind': self.kind, 'label': self.label, 'indirect': self.indirect, 'manager': self.manager,
                'department': self.department, 'teamId': self.team_id, 'lead': self.lead,
                'approvals': self.kind != 'project',
                'count': None if self.emails is None else len(self.emails)}


def _people():
    profiles, accounts = org_views.people_maps()
    inactive = {e for e, u in accounts.items() if (u.status or 'active') != 'active'}
    return profiles, accounts, inactive


def _led_teams(caller):
    return list(Team.objects.filter(lead_email__iexact=caller, status='active').order_by('name'))


def _matrix():
    """hrms_plus.org (matrix reporting lines), or None when the app is absent."""
    try:
        from hrms_plus import org
        return org
    except Exception:          # pragma: no cover - hrms_plus not installed
        logger.debug('matrix reporting unavailable', exc_info=True)
        return None


def _project_team(lead):
    m = _matrix()
    return m.project_team(lead) if m else []


def _allocations(caller, user, scope, profiles, emails):
    """email -> allocation split ("60% Project Alpha, 40% line team") for the
    people in ``emails`` whose project lines the caller may see."""
    m = _matrix()
    if not m or not emails:
        return {}
    try:
        # Line managers (any level above), the person's project leads and HR
        # see the split; a team lead only for people they manage or lead.
        sees = m.line_viewer(caller, user, profiles)
        return m.allocation_map([e for e in emails if sees(e)])
    except Exception:
        logger.exception('my-team allocations failed')
        return {}


def resolve_scope(request, caller, user, profiles, accounts, inactive):
    """(Scope, error_response)."""
    q = request.GET
    can_all = _can_view_all(user)
    s = Scope()
    s.indirect = str(q.get('indirect') or '').lower() in ('1', 'true', 'yes')
    team_id, manager = q.get('teamId'), _norm(q.get('manager'))
    department, kind = str(q.get('department') or '').strip(), _norm(q.get('scope'))

    def tree_of(m):
        return org_views.reporting_tree(m, profiles) if s.indirect else org_views.direct_reports(m, profiles)

    if team_id not in (None, ''):
        team = Team.objects.filter(pk=team_id).first() if str(team_id).isdigit() else None
        if not team or not (can_all or _norm(team.lead_email) == caller):
            return None, _err('Team not found', 404)
        s.kind, s.team_id, s.label = 'team', team.id, f'Team: {team.name}'
        s.emails = list(TeamMembership.objects.filter(team=team).values_list('email', flat=True))
    elif manager and manager != caller:
        if not can_all:
            return None, _err('Permission denied: attendance.edit', 403, 'PERMISSION_DENIED')
        card = org_views.person_card(manager, profiles, accounts)
        s.kind, s.manager = 'manager', manager
        s.label = f"{card['name'] if card else manager}'s team"
        s.emails = tree_of(manager)
    elif department:
        if not can_all:
            return None, _err('Permission denied: attendance.edit', 403, 'PERMISSION_DENIED')
        s.kind, s.department, s.label = 'department', department, f'Department: {department}'
        s.emails = [e for e, p in profiles.items() if (p.department or '').strip().lower() == department.lower()]
    elif kind == 'project':
        # People with a current ReportingLine to the caller as their project /
        # scrum lead. Members, presence, calendar and workload only: a project
        # lead gets NO approval rights from it (see inbox()).
        lead = _norm(q.get('lead')) or caller
        if lead != caller and not can_all:
            return None, _err('Permission denied: attendance.edit', 403, 'PERMISSION_DENIED')
        s.kind, s.lead = 'project', lead
        if lead == caller:
            s.label = 'My project team'
        else:
            card = org_views.person_card(lead, profiles, accounts)
            s.label = f"{card['name'] if card else lead}'s project team"
        s.emails = _project_team(lead)
    elif kind == 'all' or (kind != 'reports' and can_all and not org_views.direct_reports(caller, profiles)):
        if not can_all:
            return None, _err('Permission denied: attendance.edit', 403, 'PERMISSION_DENIED')
        s.kind, s.label = 'all', 'Everyone'
        s.emails = sorted(set(profiles) | set(accounts))
    else:
        s.kind = 'reports'
        s.label = 'My reporting tree' if s.indirect else 'My direct reports'
        s.emails = tree_of(caller)
    return s.finish(caller, inactive), None


def _card(email, profiles, accounts):
    c = org_views.person_card(email, profiles, accounts)
    if c:
        return c
    return {'key': email, 'email': email, 'name': email.split('@')[0], 'initials': (email[:2] or 'EM').upper(),
            'designation': '', 'department': '', 'employeeId': ''}


# ---------------------------------------------------------------------------
# inbox: listing
# ---------------------------------------------------------------------------
def _in_scope_q(scope, caller, approver_field):
    """Rows of people in scope, plus rows routed to the caller by name."""
    if scope.emails is None:
        return Q()
    return Q(email__in=scope.emails) | Q(**{approver_field + '__iexact': caller})


def _item(kind, obj_id, email, name, title, detail, submitted, **extra):
    d = {
        'key': f'{kind}:{obj_id}', 'type': kind, 'typeLabel': TYPE_LABELS[kind], 'id': obj_id,
        'email': _norm(email), 'name': name or email, 'title': title, 'detail': detail,
        'submittedAt': _iso(submitted), 'link': LINKS[kind],
        'noteRequired': kind in NOTE_REQUIRED, 'noteStored': kind in NOTE_STORED,
    }
    d.update(extra)
    return d


def _days_label(n):
    return f'{n} day' + ('' if n == 1 else 's')


def _inbox_leave(ctx):
    req, caller, scope = ctx['request'], ctx['caller'], ctx['scope']
    qs = LeaveRequest.objects.filter(status='Pending').exclude(email__iexact=caller) \
        .filter(_in_scope_q(scope, caller, 'approver_email')).order_by('from_date', 'id')[:300]
    out = []
    for r in qs:
        if not org_views.can_decide(req, 'leave.action', r.email, r.approver_email)[0]:
            continue
        out.append(_item('leave', r.id, r.email, r.employee_name or ctx['name'](r.email), r.type,
                         _days_label(r.days), r.created_at, fromDate=_iso(r.from_date), toDate=_iso(r.to_date),
                         days=r.days, reason=r.reason or ''))
    return out


def _inbox_wfh(ctx):
    req, caller, scope = ctx['request'], ctx['caller'], ctx['scope']
    qs = WfhRequest.objects.filter(status='Pending').exclude(email__iexact=caller) \
        .filter(_in_scope_q(scope, caller, 'approver_email')).order_by('from_date', 'id')[:300]
    out = []
    for r in qs:
        # The same gate attendance_views._wfh_approver applies.
        if not org_views.can_decide(req, 'attendance.approve_wfh', r.email, r.approver_email)[0]:
            continue
        out.append(_item('wfh', r.id, r.email, r.employee_name or ctx['name'](r.email), 'Work from home',
                         _days_label(r.days), r.created_at, fromDate=_iso(r.from_date), toDate=_iso(r.to_date),
                         days=r.days, reason=r.reason or ''))
    return out


def _inbox_regularization(ctx):
    from .attendance_ext import missed_punch as mp
    from .attendance_ext import regularization as reg
    scope, caller = ctx['scope'], ctx['caller']
    pol = mp.policy()
    out = []
    for c in reg.queue_rows(ctx['request'], 'Pending'):          # the feature's own queue
        if not (scope.contains(c.email) or _norm(c.reviewer_email) == caller):
            continue
        d = reg.dto(c, pol=pol)
        times = ' → '.join(x for x in (d['requestedCheckInLabel'] and 'in ' + d['requestedCheckInLabel'],
                                        d['requestedCheckOutLabel'] and 'out ' + d['requestedCheckOutLabel']) if x)
        out.append(_item('regularization', c.id, c.email, d['employee'] or ctx['name'](c.email),
                         d['kindLabel'] or 'Regularization', times or d['issueLabel'] or '', c.created_at,
                         fromDate=d['date'], toDate=d['date'], reason=' — '.join(
                             x for x in (d['reasonLabel'], d['reason']) if x), late=d['late']))
    return out


def _inbox_timesheet(ctx):
    from . import timesheets as ts
    caller, user, scope = ctx['caller'], ctx['user'], ctx['scope']
    qs = TimesheetWeek.objects.filter(status='Submitted').exclude(email__iexact=caller) \
        .filter(_in_scope_q(scope, caller, 'approver_email')).order_by('week_start', 'id')[:300]
    out = []
    for w in qs:
        if not ts._can_decide(caller, user, w):
            continue
        out.append(_item('timesheet', w.id, w.email, w.employee_name or ctx['name'](w.email),
                         'Week of ' + w.week_start.isoformat(), f'{float(w.total_hours or 0):g} h', w.submitted_at,
                         fromDate=_iso(w.week_start), toDate=_iso(w.week_start + timedelta(days=6)),
                         hours=float(w.total_hours or 0)))
    return out


def _inbox_expense(ctx):
    from .payroll_ext import ess
    caller, user, scope = ctx['caller'], ctx['user'], ctx['scope']
    show_amount = _has(user, 'expense.approve')
    qs = ExpenseClaim.objects.filter(status='submitted').exclude(email__iexact=caller).defer('receipt_data') \
        .filter(_in_scope_q(scope, caller, 'approver_email')).order_by('created_at', 'id')[:300]
    out = []
    for c in qs:
        if not ess._can_decide_claim(caller, user, c):
            continue
        extra = {'fromDate': _iso(c.expense_date), 'toDate': _iso(c.expense_date),
                 'reason': c.description or '', 'hasReceipt': bool(c.receipt_name or c.receipt_mime)}
        if show_amount:
            extra.update(amount=_money(c.amount), currency=c.currency or 'INR')
        out.append(_item('expense', c.id, c.email, c.employee_name or ctx['name'](c.email),
                         ess.EXPENSE_CATEGORIES.get(c.category, c.category), '', c.created_at, **extra))
    return out


def _inbox_loan(ctx):
    caller, user, scope = ctx['caller'], ctx['user'], ctx['scope']
    if not _has(user, LOAN_PERM):            # ess.loan_decide: only this permission decides
        return []
    qs = EmployeeLoan.objects.filter(status='requested').exclude(email__iexact=caller)
    if scope.emails is not None:
        qs = qs.filter(email__in=scope.emails)
    out = []
    for l in qs.order_by('created_at', 'id')[:300]:
        out.append(_item('loan', l.id, l.email, l.employee_name or ctx['name'](l.email),
                         'Salary advance' if l.kind == 'advance' else 'Loan',
                         f'{l.tenure_months} month' + ('' if l.tenure_months == 1 else 's'), l.created_at,
                         amount=_money(l.principal), currency='INR', reason=l.reason or ''))
    return out


def _inbox_offsite(ctx):
    caller, scope = ctx['caller'], ctx['scope']
    if not check_perm(ctx['request'], 'attendance.approve_offsite')[0]:
        return []
    qs = EmployeeAttendance.objects.filter(location_status='Pending').exclude(email__iexact=caller)
    if scope.emails is not None:
        qs = qs.filter(email__in=scope.emails)
    out = []
    for r in qs.order_by('-date', '-id')[:200]:
        out.append(_item('offsite', r.id, r.email, r.employee_name or ctx['name'](r.email),
                         'Check-in outside the office', r.check_in.strftime('%I:%M %p') if r.check_in else '',
                         r.check_in, fromDate=_iso(r.date), toDate=_iso(r.date), reason=r.location_reason or ''))
    return out


def _inbox_overtime(ctx):
    # Overtime records awaiting approval (attendance_ext/overtime.py): the
    # employee's manager / routed approver, or attendance.edit — never self.
    from .attendance_ext import overtime as ot
    from .models import OvertimeRecord
    caller, scope, req = ctx['caller'], ctx['scope'], ctx['request']
    has_edit = check_perm(req, 'attendance.edit')[0]
    qs = OvertimeRecord.objects.filter(status='Pending').exclude(email__iexact=caller)         .filter(_in_scope_q(scope, caller, 'approver_email')).order_by('date', 'id')[:300]
    out = []
    for r in qs:
        if not ot.can_decide(caller, has_edit, r):
            continue
        what = f'{ot.hm(r.overtime_minutes)} overtime' + (f' ({r.day_type})' if r.day_type != 'working' else '')
        out.append(_item('overtime', r.id, r.email, r.employee_name or ctx['name'](r.email), 'Overtime', what,
                         r.created_at, fromDate=_iso(r.date), toDate=_iso(r.date), minutes=r.overtime_minutes,
                         workedMinutes=r.worked_minutes, dayType=r.day_type, reason=r.note or ''))
    return out


def _inbox_short_leave(ctx):
    # Short leave / permission (attendance_ext/short_leave.py): the feature's
    # own queue — the manager / routed approver, or attendance.edit.
    from .attendance_ext import short_leave as sl
    scope, caller = ctx['scope'], ctx['caller']
    out = []
    for r in sl.queue_rows(ctx['request'], 'Pending'):
        if not (scope.contains(r.email) or _norm(r.approver_email) == caller):
            continue
        d = sl.dto(r)
        out.append(_item('short_leave', r.id, r.email, r.employee_name or ctx['name'](r.email),
                         d['kindLabel'], f"{d['fromLabel']} – {d['toLabel']} ({r.minutes} min)", r.created_at,
                         fromDate=d['date'], toDate=d['date'], minutes=r.minutes, leaveKind=r.kind,
                         reason=r.reason or ''))
    return out


def _inbox_recheckin(ctx):
    # Checked in again after an automatic (left the office) check-out
    # (views._recheckin_gate): the employee's manager, or attendance.edit.
    caller, scope, req = ctx['caller'], ctx['scope'], ctx['request']
    has_edit = check_perm(req, 'attendance.edit')[0]
    qs = EmployeeAttendance.objects.filter(recheckin_status='Pending').exclude(email__iexact=caller)
    if scope.emails is not None:
        qs = qs.filter(email__in=scope.emails)
    out = []
    for r in qs.order_by('recheckin_at', 'id')[:200]:
        if not (has_edit or org_views.is_manager_of(caller, r.email)):
            continue
        auto = r.auto_checkout_at.strftime('%I:%M %p') if r.auto_checkout_at else ''
        back = r.recheckin_at.strftime('%I:%M %p') if r.recheckin_at else ''
        detail = f'Auto checked out {auto}, back {back}'
        out.append(_item('recheckin', r.id, r.email, r.employee_name or ctx['name'](r.email),
                         'Check-in after automatic check-out', detail, r.recheckin_at,
                         fromDate=_iso(r.date), toDate=_iso(r.date), reason=r.recheckin_reason or '',
                         heldMinutes=r.recheckin_held_minutes or 0))
    return out


_LISTERS = {
    'recheckin': _inbox_recheckin,
    'short_leave': _inbox_short_leave,
    'leave': _inbox_leave, 'wfh': _inbox_wfh, 'regularization': _inbox_regularization,
    'timesheet': _inbox_timesheet, 'expense': _inbox_expense, 'loan': _inbox_loan, 'offsite': _inbox_offsite,
    'overtime': _inbox_overtime,
}


def build_inbox(request, caller, user, scope, profiles, accounts, types=TYPES):
    def name(e):
        return _card(_norm(e), profiles, accounts)['name']

    if scope is not None and scope.kind == 'project':
        return [], {}           # a project lead decides nothing for their project team
    ctx ={'request': request, 'caller': caller, 'user': user, 'scope': scope, 'name': name}
    items, errors = [], {}
    for t in types:
        try:
            items.extend(_LISTERS[t](ctx))
        except Exception as e:          # one broken feature must not blank the whole inbox
            logger.exception('my-team inbox: %s failed', t)
            errors[t] = str(e)[:200]
    items.sort(key=lambda i: (i['submittedAt'] or '', i['key']))
    return items, errors


# ---------------------------------------------------------------------------
# inbox: deciding (through the feature's own endpoint)
# ---------------------------------------------------------------------------
def _load(kind, pk):
    """(subject_email, is_pending, current_status) or None."""
    model, pending = {
        'leave': (LeaveRequest, 'Pending'), 'wfh': (WfhRequest, 'Pending'),
        'timesheet': (TimesheetWeek, 'Submitted'), 'expense': (ExpenseClaim, 'submitted'),
        'loan': (EmployeeLoan, 'requested'),
    }.get(kind, (None, None))
    if kind == 'regularization':
        from .models import AttendanceCorrection
        o = AttendanceCorrection.objects.filter(pk=pk).only('email', 'status').first()
        return (o.email, o.status == 'Pending', o.status) if o else None
    if kind == 'short_leave':
        from .models import ShortLeaveRequest
        o = ShortLeaveRequest.objects.filter(pk=pk).only('email', 'status').first()
        return (o.email, o.status == 'Pending', o.status) if o else None
    if kind == 'overtime':
        from .models import OvertimeRecord
        o = OvertimeRecord.objects.filter(pk=pk).only('email', 'status').first()
        return (o.email, o.status == 'Pending', o.status) if o else None
    if kind == 'recheckin':
        o = EmployeeAttendance.objects.filter(pk=pk).only('email', 'recheckin_status').first()
        return (o.email, o.recheckin_status == 'Pending', o.recheckin_status or 'not awaiting approval') if o else None
    if kind == 'offsite':
        o = EmployeeAttendance.objects.filter(pk=pk).only('email', 'location_status').first()
        return (o.email, o.location_status == 'Pending', o.location_status or 'not under review') if o else None
    qs = model.objects.filter(pk=pk)
    if model is ExpenseClaim:
        qs = qs.defer('receipt_data')
    o = qs.only('email', 'status').first()
    return (o.email, o.status == pending, o.status) if o else None


def _dispatch(request, caller, kind, pk, action, note):
    from . import timesheets, views
    approve = action == 'approve'
    if kind == 'leave':
        return _call(request, caller, 'PUT', f'/api/leave/{pk}', views.leave_detail,
                     {'status': 'Approved' if approve else 'Rejected'}, pk=pk)
    if kind == 'wfh':
        from .attendance_views import WFHRequestViewSet
        act = 'approve_request' if approve else 'reject_request'
        view = WFHRequestViewSet.as_view({'post': act})
        return _call(request, caller, 'POST', '/api/attendance/wfh/%s/' % ('approve' if approve else 'reject'),
                     view, {'requestId': pk})
    if kind == 'regularization':
        from .attendance_ext import regularization as reg
        return _call(request, caller, 'POST', f'/api/attendance/regularization/{pk}/decide',
                     reg.regularization_decide, {'action': action, 'reviewerNote': note}, pk=pk)
    if kind == 'timesheet':
        return _call(request, caller, 'POST', f'/api/timesheets/week/{pk}/decide', timesheets.decide_week,
                     {'action': action, 'note': note}, pk=pk)
    if kind == 'expense':
        from .payroll_ext import ess
        return _call(request, caller, 'POST', f'/api/payroll/ess/expenses/{pk}/decide', ess.expense_decide,
                     {'action': action, 'note': note}, pk=pk)
    if kind == 'loan':
        from .payroll_ext import ess
        return _call(request, caller, 'POST', f'/api/payroll/ess/loans/{pk}/decide', ess.loan_decide,
                     {'action': action, 'note': note}, pk=pk)
    if kind == 'offsite':
        return _call(request, caller, 'POST', '/api/attendance/location-reviews', views.attendance_location_reviews,
                     {'id': pk, 'decision': 'Approved' if approve else 'Rejected', 'note': note})
    if kind == 'recheckin':
        return _call(request, caller, 'POST', f'/api/attendance/recheckin/{pk}/decide',
                     views.attendance_recheckin_decide, {'action': action, 'note': note}, pk=pk)
    if kind == 'overtime':
        from .attendance_ext import overtime_views
        return _call(request, caller, 'POST', f'/api/attendance/overtime-records/{pk}/decide',
                     overtime_views.decide, {'action': action, 'note': note}, pk=pk)
    if kind == 'short_leave':
        from .attendance_ext import short_leave as sl
        return _call(request, caller, 'POST', f'/api/attendance/short-leave/{pk}/decide', sl.short_leave_decide,
                     {'action': action, 'reviewerNote': note}, pk=pk)
    return 400, {'message': 'Unknown request type.'}


def decide_one(request, caller, kind, pk, action, note=''):
    """{'key','type','id','ok','status','message'} — never raises."""
    out = {'key': f'{kind}:{pk}', 'type': kind, 'id': pk, 'ok': False}
    kind = _norm(kind)
    action = _norm(action)
    note = str(note or '').strip()[:1000]
    if kind not in TYPES:
        return dict(out, status=400, message='Unknown request type.')
    if action not in ('approve', 'reject'):
        return dict(out, status=400, message='action must be approve or reject.')
    try:
        pk = int(pk)
    except (TypeError, ValueError):
        return dict(out, status=400, message='Invalid id.')
    found = _load(kind, pk)
    if not found:
        return dict(out, status=404, message=f'{TYPE_LABELS[kind]} request not found.')
    subject, pending, current = found
    if _norm(subject) == caller:
        return dict(out, status=403, code='SELF_APPROVAL',
                    message='You cannot approve or reject your own request.')
    if not pending:
        return dict(out, status=409, message=f'This {TYPE_LABELS[kind].lower()} request is already '
                                             f'{str(current or "decided").lower()}.')
    if action == 'reject' and kind in NOTE_REQUIRED and not note:
        return dict(out, status=400, message='Give a reason for rejecting this request.')
    try:
        status, data = _dispatch(request, caller, kind, pk, action, note)
    except Exception as e:
        logger.exception('my-team decide %s:%s failed', kind, pk)
        return dict(out, status=500, message=f'Could not complete the decision: {str(e)[:200]}')
    ok = 200 <= status < 300
    verb = 'approved' if action == 'approve' else 'rejected'
    msg = _message(data, f'{TYPE_LABELS[kind]} {verb}.' if ok else f'Could not {action} this request.')
    if ok and isinstance(data, dict) and data.get('message') is None:
        msg = f'{TYPE_LABELS[kind]} {verb}.'
    res = dict(out, ok=ok, status=status, message=msg)
    if isinstance(data, dict) and data.get('code'):
        res['code'] = data['code']
    return res


# ---------------------------------------------------------------------------
# presence
# ---------------------------------------------------------------------------
BUCKETS = (('office', 'In office'), ('remote', 'WFH / remote'), ('break', 'On break / away'),
           ('leave', 'On leave'), ('notin', 'Not checked in yet'), ('out', 'Checked out'),
           ('holiday', 'Holiday'), ('off', 'Off (non-working day)'))


_DAY_KEYS = ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')


def work_days():
    """Weekday numbers (Mon=0) of the company work week (Settings > General,
    CompanyDetail.work_week — what HRMSCompany.workWeek() shows), Mon–Fri
    when unset. Read-only: never creates the company row."""
    try:
        from .models import CompanyDetail
        obj = CompanyDetail.objects.only('work_week').first()
        week = obj.work_week if obj is not None else None
        if isinstance(week, str):
            week = json.loads(week or '[]')
        out = {_DAY_KEYS.index(str(d).strip()[:3].lower()) for d in (week or [])
               if str(d).strip()[:3].lower() in _DAY_KEYS}
        if out:
            return out
    except Exception:
        logger.debug('work week lookup failed', exc_info=True)
    return {0, 1, 2, 3, 4}


def _shift_starts(emails, day):
    """email -> (start_time, grace_minutes) without creating anything."""
    out = {}
    rows = (ShiftAssignment.objects.filter(email__in=emails, effective_from__lte=day)
            .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=day))
            .select_related('shift').order_by('email', '-effective_from', '-id'))
    for a in rows:
        if _norm(a.email) not in out and a.shift:
            out[_norm(a.email)] = a.shift
    fallback = Shift.objects.filter(id=1).first()
    return {e: out.get(e, fallback) for e in emails}


def build_presence(request, caller, scope, profiles, accounts):
    from . import views
    from .attendance_ext.holidays import HolidayResolver
    now = _now()
    today = now.date()
    emails = scope.emails if scope.emails is not None else sorted(
        (set(profiles) | set(accounts)) - {caller})
    status_code, team_rows = _call(request, caller, 'GET', '/api/attendance/team', views.attendance_team)
    team = {_norm(r.get('email')): r for r in (team_rows or []) if isinstance(r, dict)} if status_code == 200 else {}
    atts = {_norm(a.email): a for a in EmployeeAttendance.objects.filter(date=today, email__in=emails)}
    leave = {}
    for r in LeaveRequest.objects.filter(email__in=emails, from_date__lte=today, to_date__gte=today,
                                         status__in=('Approved', 'Pending')).order_by('status'):
        leave.setdefault(_norm(r.email), r)          # 'Approved' sorts first
    wfh = {_norm(r.email) for r in WfhRequest.objects.filter(email__in=emails, status='Approved',
                                                             from_date__lte=today, to_date__gte=today)}
    resolver = HolidayResolver()
    shifts = _shift_starts(emails, today)
    weekend = today.weekday() not in work_days()
    counts = {k: 0 for k, _ in BUCKETS}
    rows = []
    for e in emails:
        card = _card(e, profiles, accounts)
        tr = team.get(e) or {}
        label = tr.get('status') or 'Offline'
        att = atts.get(e)
        lv = leave.get(e)
        hol = None
        try:
            if resolver.is_holiday(e, today):
                hol = next((h['name'] for h in resolver.holidays_for(e, today, today) if h.get('off')), 'Holiday')
        except Exception:
            logger.debug('holiday lookup failed for %s', e, exc_info=True)
        if label not in ('Offline', 'Absent'):                # checked in right now
            if label == 'In Office':
                b = 'office'
            elif label == 'Remote':
                b = 'remote'
            elif label == 'In Break':
                b = 'break'
            else:   # a personal status (Busy / Do not disturb …): place by where they work today
                b = 'remote' if ((att and att.is_wfh) or e in wfh) else 'office'
        elif att and att.check_in:
            b = 'out'
        elif lv is not None and lv.status == 'Approved':
            b = 'leave'
        elif hol:
            b = 'holiday'
        elif weekend:
            b = 'off'
        else:
            b = 'notin'
        counts[b] += 1
        shift = shifts.get(e)
        late = False
        if b == 'notin' and shift is not None and shift.start_time and not shift.is_flexible:
            late = now > datetime.combine(today, shift.start_time) + timedelta(minutes=shift.grace_minutes or 0)
        rows.append({
            'email': e, 'name': card['name'], 'initials': card['initials'], 'designation': card['designation'],
            'department': card['department'], 'bucket': b, 'status': label,
            'presence': tr.get('presence') or '', 'since': tr.get('since') or '',
            'checkIn': _iso(att.check_in) if att and att.check_in else None,
            'checkOut': _iso(att.check_out) if att and att.check_out else None,
            'leaveType': lv.type if lv is not None else '', 'leaveStatus': lv.status if lv is not None else '',
            'holiday': hol or '', 'wfhApproved': e in wfh,
            'shiftStart': shift.start_time.strftime('%H:%M') if shift is not None and shift.start_time else '',
            'late': late,
        })
    order = {k: i for i, (k, _) in enumerate(BUCKETS)}
    rows.sort(key=lambda r: (order[r['bucket']], r['name'].lower()))
    return {'date': today.isoformat(), 'generatedAt': _iso(now), 'counts': counts,
            'buckets': [{'key': k, 'label': l} for k, l in BUCKETS], 'members': rows}


# ---------------------------------------------------------------------------
# calendar
# ---------------------------------------------------------------------------
_DUE_FORMATS = ('%Y-%m-%d', '%Y/%m/%d', '%d-%m-%Y', '%d/%m/%Y', '%m/%d/%Y', '%d %b %Y', '%d %B %Y',
                '%b %d, %Y', '%B %d, %Y', '%b %d %Y', '%B %d %Y', '%d.%m.%Y')


def parse_due(v):
    """EmployeeTask.due is free text as the UI sent it — parse defensively."""
    s = ' '.join(str(v or '').strip().split())
    if not s:
        return None
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})', s)          # ISO, with or without a time part
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    s = s.split('T')[0]
    for fmt in _DUE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _month_bounds(month):
    m = re.match(r'^(\d{4})-(\d{1,2})$', str(month or '').strip())
    today = _today()
    y, mo = (int(m.group(1)), int(m.group(2))) if m else (today.year, today.month)
    if not (1 <= mo <= 12 and 1900 <= y <= 2200):
        y, mo = today.year, today.month
    start = date(y, mo, 1)
    end = (date(y + 1, 1, 1) if mo == 12 else date(y, mo + 1, 1)) - timedelta(days=1)
    return start, end


def _safe_day(y, m, d):
    try:
        return date(y, m, d)
    except ValueError:
        return date(y, m, 28)        # 29 Feb in a non-leap year


def build_calendar(caller, scope, profiles, accounts, month, birthdays=False):
    from .attendance_ext.holidays import HolidayResolver
    start, end = _month_bounds(month)
    emails = scope.emails if scope.emails is not None else sorted((set(profiles) | set(accounts)) - {caller})
    name = {e: _card(e, profiles, accounts)['name'] for e in emails}
    items = []

    def span(a, b):
        return _iso(max(a, start)), _iso(min(b, end))

    for r in LeaveRequest.objects.filter(email__in=emails, status__in=('Approved', 'Pending'),
                                         from_date__lte=end, to_date__gte=start):
        a, b = span(r.from_date, r.to_date)
        items.append({'kind': 'leave', 'date': a, 'end': b, 'email': _norm(r.email), 'name': name.get(_norm(r.email), r.email),
                      'title': r.type, 'status': r.status})
    for r in WfhRequest.objects.filter(email__in=emails, status__in=('Approved', 'Pending'),
                                       from_date__lte=end, to_date__gte=start):
        a, b = span(r.from_date, r.to_date)
        items.append({'kind': 'wfh', 'date': a, 'end': b, 'email': _norm(r.email), 'name': name.get(_norm(r.email), r.email),
                      'title': 'Work from home', 'status': r.status})
    # Holidays: each member's own calendar; one entry per (date, holiday) with who observes it.
    resolver, hol = HolidayResolver(), {}
    for e in emails:
        try:
            for h in resolver.holidays_for(e, start, end):
                if resolver.calendar_for(e) is not None and not h.get('off') and not h.get('optional'):
                    continue
                key = (h['date'], h['name'])
                g = hol.setdefault(key, {'kind': 'holiday', 'date': h['date'], 'end': h['date'], 'title': h['name'],
                                         'optional': bool(h.get('optional')), 'off': bool(h.get('off')),
                                         'calendar': h.get('calendar') or '', 'people': []})
                g['people'].append(name[e])
        except Exception:
            logger.debug('calendar holidays failed for %s', e, exc_info=True)
    for g in hol.values():
        g['count'] = len(g['people'])
        g['people'] = sorted(g['people'])[:50]
        items.append(g)
    # Work anniversaries (UserProfile.start_date).
    for e in emails:
        p = profiles.get(e)
        sd = p.start_date if p else None
        if not sd or sd.year >= start.year:
            continue
        if sd.month == start.month:
            d = _safe_day(start.year, sd.month, sd.day)
            yrs = start.year - sd.year
            items.append({'kind': 'anniversary', 'date': _iso(d), 'end': _iso(d), 'email': e, 'name': name[e],
                          'title': f'{yrs} year' + ('' if yrs == 1 else 's') + ' at the company'})
    # Birthdays: the only source is the onboarding form (OnboardingCandidate.dob) — opt-in.
    available = 0
    try:
        from .models import OnboardingCandidate
        dob = {}
        for row in (OnboardingCandidate.objects.filter(email__in=emails, is_deleted=False, dob__isnull=False)
                    .order_by('id').values_list('email', 'dob')):
            dob[_norm(row[0])] = row[1]
        available = len(dob)
        if birthdays:
            for e, d0 in dob.items():
                if e in name and d0.month == start.month:
                    d = _safe_day(start.year, d0.month, d0.day)
                    items.append({'kind': 'birthday', 'date': _iso(d), 'end': _iso(d), 'email': e,
                                  'name': name[e], 'title': 'Birthday'})
    except Exception:
        logger.debug('birthday lookup failed', exc_info=True)
    # Task deadlines (open tasks; EmployeeTask.due is free text).
    today = _today()
    for t in EmployeeTask.objects.filter(assignee_email__in=emails).exclude(stage='done') \
            .only('id', 'title', 'due', 'priority', 'stage', 'assignee_email', 'task_code'):
        d = parse_due(t.due)
        if d and start <= d <= end:
            e = _norm(t.assignee_email)
            items.append({'kind': 'deadline', 'date': _iso(d), 'end': _iso(d), 'email': e, 'name': name.get(e, e),
                          'title': t.title, 'priority': t.priority or 'medium', 'stage': t.stage,
                          'overdue': d < today, 'taskId': t.id})
    order = {'holiday': 0, 'leave': 1, 'wfh': 2, 'deadline': 3, 'anniversary': 4, 'birthday': 5}
    items.sort(key=lambda i: (i['date'], order.get(i['kind'], 9), i.get('name') or i.get('title') or ''))
    return {'month': start.strftime('%Y-%m'), 'start': _iso(start), 'end': _iso(end), 'items': items,
            'birthdaysIncluded': bool(birthdays), 'birthdaysAvailable': available,
            'birthdaySource': 'onboarding form (date of birth)'}


# ---------------------------------------------------------------------------
# workload
# ---------------------------------------------------------------------------
def _expected_day_minutes(shift):
    if shift is None:
        return 480
    try:
        if shift.is_flexible:
            return int((shift.flex_hours_per_day or 8) * 60)
        return max(int(shift.total_work_minutes()), 60)
    except Exception:
        return 480


def thresholds_from(q):
    t = dict(WORKLOAD_DEFAULTS)
    for k, (lo, hi) in {'maxHighTasks': (0, 500), 'maxWeekHours': (1, 168), 'longDayHours': (1, 24),
                        'longDayRun': (1, 7), 'underPct': (0, 100), 'underMaxTasks': (0, 500)}.items():
        if q.get(k) not in (None, ''):
            t[k] = _int(q.get(k), t[k], lo, hi)
    return t


def build_workload(caller, scope, profiles, accounts, week, thresholds):
    from .attendance_ext.holidays import HolidayResolver
    today = _today()
    try:
        anchor = datetime.strptime(str(week or '')[:10], '%Y-%m-%d').date()
    except ValueError:
        anchor = today
    ws = anchor - timedelta(days=anchor.weekday())
    we = ws + timedelta(days=6)
    emails = scope.emails if scope.emails is not None else sorted((set(profiles) | set(accounts)) - {caller})
    # Days that count toward "expected": Mon–Fri up to yesterday for the running week.
    last = min(we, today - timedelta(days=1)) if ws <= today <= we else we
    tasks = {}
    for e, pri, due in EmployeeTask.objects.filter(assignee_email__in=emails).exclude(stage='done') \
            .values_list('assignee_email', 'priority', 'due'):
        t = tasks.setdefault(_norm(e), {'high': 0, 'medium': 0, 'low': 0, 'overdue': 0})
        p = _norm(pri) if _norm(pri) in ('high', 'medium', 'low') else 'medium'
        t[p] += 1
        d = parse_due(due)
        if d and d < today:
            t['overdue'] += 1
    att = {}
    for a in EmployeeAttendance.objects.filter(email__in=emails, date__gte=ws, date__lte=we):
        att.setdefault(_norm(a.email), {})[a.date] = a
    ts_hours = {}
    for e, h in TimesheetEntry.objects.filter(email__in=emails, date__gte=ws, date__lte=we) \
            .values_list('email', 'hours'):
        ts_hours[_norm(e)] = ts_hours.get(_norm(e), 0.0) + float(h or 0)
    ts_status = {_norm(w.email): w.status for w in TimesheetWeek.objects.filter(email__in=emails, week_start=ws)}
    leave_days = {}
    for r in LeaveRequest.objects.filter(email__in=emails, status='Approved', from_date__lte=we, to_date__gte=ws):
        d = max(r.from_date, ws)
        while d <= min(r.to_date, we):
            leave_days.setdefault(_norm(r.email), set()).add(d)
            d += timedelta(days=1)
    resolver = HolidayResolver()
    shifts = _shift_starts(emails, min(ws, today))
    wdays = work_days()
    th = thresholds
    rows = []
    for e in emails:
        card = _card(e, profiles, accounts)
        days = att.get(e, {})
        t = tasks.get(e, {'high': 0, 'medium': 0, 'low': 0, 'overdue': 0})
        open_total = t['high'] + t['medium'] + t['low']
        att_minutes = sum(int(a.worked_minutes or 0) for a in days.values())
        att_hours = round(att_minutes / 60.0, 1)
        tsh = round(ts_hours.get(e, 0.0), 1)
        hours = max(att_hours, tsh)
        ot_days = sum(1 for a in days.values() if (a.overtime_minutes or 0) > 0)
        long_limit = th['longDayHours'] * 60
        run = best = 0
        d = ws
        while d <= we:
            a = days.get(d)
            if a is not None and (a.worked_minutes or 0) > long_limit:
                run += 1
                best = max(best, run)
            else:
                run = 0
            d += timedelta(days=1)
        try:
            hol = resolver.holiday_dates(e, ws, we)
        except Exception:
            hol = frozenset()
        off = leave_days.get(e, set())
        n_work = 0
        d = ws
        while d <= last:
            if d.weekday() in wdays and d not in hol and d not in off:
                n_work += 1
            d += timedelta(days=1)
        expected = round(n_work * _expected_day_minutes(shifts.get(e)) / 60.0, 1)
        pct = round(hours / expected * 100) if expected else None
        flags = []
        if t['high'] > th['maxHighTasks']:
            flags.append({'kind': 'overloaded', 'reason': f"{t['high']} open high-priority tasks "
                                                          f"(limit {th['maxHighTasks']:g})"})
        if hours > th['maxWeekHours']:
            flags.append({'kind': 'overloaded', 'reason': f'{hours:g} h logged this week '
                                                          f"(limit {th['maxWeekHours']:g} h)"})
        if best >= th['longDayRun']:
            flags.append({'kind': 'overloaded', 'reason': f'{best} consecutive days over '
                                                          f"{th['longDayHours']:g} h"})
        if pct is not None and pct < th['underPct'] and open_total <= th['underMaxTasks']:
            flags.append({'kind': 'underutilized', 'reason': f'{pct}% of the {expected:g} h expected so far '
                                                             f'and {open_total} open task'
                                                             + ('' if open_total == 1 else 's')})
        weighted = t['high'] + 0.5 * t['medium'] + 0.25 * t['low']
        task_load = weighted / th['maxHighTasks'] * 100 if th['maxHighTasks'] else 0
        week_hours_load = hours / th['maxWeekHours'] * 100 if th['maxWeekHours'] else 0
        load = max(pct or 0, task_load, week_hours_load)
        state = 'overloaded' if any(f['kind'] == 'overloaded' for f in flags) else \
            ('underutilized' if flags else 'ok')
        rows.append({
            'email': e, 'name': card['name'], 'initials': card['initials'], 'designation': card['designation'],
            'tasks': dict(t, open=open_total), 'hours': hours, 'attendanceHours': att_hours,
            'timesheetHours': tsh, 'timesheetStatus': ts_status.get(e, 'Not started'),
            'expectedHours': expected, 'utilization': pct, 'overtimeDays': ot_days, 'longestLongRun': best,
            'load': int(min(round(load), 200)), 'state': state, 'flags': flags,
        })
    rank = {'overloaded': 0, 'underutilized': 1, 'ok': 2}
    rows.sort(key=lambda r: (rank[r['state']], -r['load'], r['name'].lower()))
    return {'weekStart': _iso(ws), 'weekEnd': _iso(we), 'expectedThrough': _iso(last) if last >= ws else None,
            'thresholds': th, 'members': rows,
            'counts': {k: sum(1 for r in rows if r['state'] == k) for k in rank}}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def _setup(request):
    """(caller, user, scope, profiles, accounts, error_response)."""
    caller, user, denied = _ident(request)
    if denied:
        return None, None, None, None, None, denied
    profiles, accounts, inactive = _people()
    scope, denied = resolve_scope(request, caller, user, profiles, accounts, inactive)
    if denied:
        return None, None, None, None, None, denied
    return caller, user, scope, profiles, accounts, None


def _types_param(request):
    raw = str(request.GET.get('types') or request.GET.get('type') or '').strip()
    if not raw:
        return TYPES
    want = [t for t in (_norm(x) for x in raw.split(',')) if t in TYPES]
    return tuple(want) or TYPES


@api_view(['GET'])
def summary(request):
    """For the sidebar: {isManager, show, pending, byType, canViewAll, directReports, leadsTeams}."""
    caller, user, denied = _ident(request)
    if denied:
        return denied
    profiles, accounts, inactive = _people()
    direct = [e for e in org_views.direct_reports(caller, profiles) if e not in inactive]
    teams = [t for t in _led_teams(caller)
             if TeamMembership.objects.filter(team=t).exclude(email__iexact=caller).exists()]
    can_all = _can_view_all(user)
    scope, err = resolve_scope(request, caller, user, profiles, accounts, inactive)
    items = []
    if not err:
        items, _errors = build_inbox(request, caller, user, scope, profiles, accounts)
    by_type = {t: 0 for t in TYPES}
    for i in items:
        by_type[i['type']] += 1
    is_manager = bool(direct or teams)
    # Project leads get the hub (their project team) but no approvals.
    project = [e for e in _project_team(caller) if e not in inactive]
    return Response({'isManager': is_manager, 'show': bool(is_manager or can_all or items or project),
                     'pending': len(items), 'byType': by_type, 'canViewAll': can_all,
                     'directReports': len(direct), 'leadsTeams': len(teams), 'leadsProjects': len(project)})


@api_view(['GET'])
def members(request):
    caller, user, scope, profiles, accounts, denied = _setup(request)
    if denied:
        return denied
    can_all = _can_view_all(user)
    direct = set(org_views.direct_reports(caller, profiles))
    emails = scope.emails if scope.emails is not None else sorted((set(profiles) | set(accounts)) - {caller})
    rows = []
    for e in emails:
        c = dict(_card(e, profiles, accounts))
        p = profiles.get(e)
        c['managerEmail'] = _norm(p.manager_email) if p else ''
        c['isDirect'] = e in direct
        c['startDate'] = _iso(p.start_date) if p and p.start_date else None
        rows.append(c)
    alloc = _allocations(caller, user, scope, profiles, [r['email'] for r in rows])
    for r in rows:
        r['allocation'] = alloc.get(r['email'])
    rows.sort(key=lambda r: r['name'].lower())
    project_team = _project_team(caller)
    teams_qs = Team.objects.filter(status='active').order_by('name') if can_all else \
        Team.objects.filter(status='active', lead_email__iexact=caller).order_by('name')
    options = {'teams': [{'id': t.id, 'name': t.name} for t in teams_qs[:300]]}
    if can_all:
        mgrs = sorted({_norm(p.manager_email) for p in profiles.values() if _norm(p.manager_email)})
        options['managers'] = sorted(
            [{'email': m, 'name': _card(m, profiles, accounts)['name']} for m in mgrs if m != caller],
            key=lambda x: x['name'].lower())
        options['departments'] = sorted({(p.department or '').strip() for p in profiles.values()
                                         if (p.department or '').strip()}, key=str.lower)
    me = _card(caller, profiles, accounts)
    return Response({'me': me, 'canViewAll': can_all, 'isManager': bool(direct) or bool(_led_teams(caller)),
                     'directReports': len(direct), 'leadsProjects': len(project_team),
                     'scope': scope.json(), 'members': rows, 'options': options})


@api_view(['GET'])
def inbox(request):
    caller, user, scope, profiles, accounts, denied = _setup(request)
    if denied:
        return denied
    items, errors = build_inbox(request, caller, user, scope, profiles, accounts, _types_param(request))
    by_type = {t: 0 for t in TYPES}
    for i in items:
        by_type[i['type']] += 1
    note = ('Project leads do not approve requests: leave, WFH, timesheets and the rest stay with each '
            "person's line manager.") if scope.kind == 'project' else ''
    return Response({'scope': scope.json(), 'items': items, 'count': len(items), 'byType': by_type, 'note': note,
                     'types': [{'value': t, 'label': TYPE_LABELS[t]} for t in TYPES],
                     'canSeeAmounts': {'expense': _has(user, 'expense.approve'), 'loan': _has(user, LOAN_PERM)},
                     'errors': errors})


@api_view(['POST'])
def inbox_decide(request):
    caller, user, denied = _ident(request)
    if denied:
        return denied
    body = request.data or {}
    kind, pk = body.get('type'), body.get('id')
    if not kind and body.get('key') and ':' in str(body.get('key')):
        kind, pk = str(body['key']).split(':', 1)
    res = decide_one(request, caller, kind, pk, body.get('action'), body.get('note'))
    return Response(res, status=200 if res['ok'] else res['status'])


@api_view(['POST'])
def inbox_batch(request):
    """{action, note?, items:[{type,id}|{key}]} → per-item results; partial failures allowed."""
    caller, user, denied = _ident(request)
    if denied:
        return denied
    body = request.data or {}
    raw = body.get('items') or []
    if not isinstance(raw, list) or not raw:
        return _err('Choose at least one request.')
    if len(raw) > MAX_BATCH:
        return _err(f'At most {MAX_BATCH} requests at a time.')
    action = _norm(body.get('action'))
    if action not in ('approve', 'reject'):
        return _err('action must be approve or reject.')
    results, seen = [], set()
    for it in raw:
        if isinstance(it, str):
            it = {'key': it}
        if not isinstance(it, dict):
            continue
        kind, pk = it.get('type'), it.get('id')
        if not kind and it.get('key') and ':' in str(it.get('key')):
            kind, pk = str(it['key']).split(':', 1)
        k = f'{_norm(kind)}:{pk}'
        if k in seen:
            continue
        seen.add(k)
        results.append(decide_one(request, caller, kind, pk, action, it.get('note') or body.get('note')))
    ok = sum(1 for r in results if r['ok'])
    return Response({'action': action, 'total': len(results), 'ok': ok, 'failed': len(results) - ok,
                     'results': results})


@api_view(['GET'])
def presence(request):
    caller, user, scope, profiles, accounts, denied = _setup(request)
    if denied:
        return denied
    data = build_presence(request, caller, scope, profiles, accounts)
    data['scope'] = scope.json()
    return Response(data)


@api_view(['GET'])
def calendar(request):
    caller, user, scope, profiles, accounts, denied = _setup(request)
    if denied:
        return denied
    birthdays = str(request.GET.get('birthdays') or '').lower() in ('1', 'true', 'yes')
    data = build_calendar(caller, scope, profiles, accounts, request.GET.get('month'), birthdays)
    data['scope'] = scope.json()
    return Response(data)


@api_view(['GET'])
def workload(request):
    caller, user, scope, profiles, accounts, denied = _setup(request)
    if denied:
        return denied
    data = build_workload(caller, scope, profiles, accounts, request.GET.get('week'),
                          thresholds_from(request.GET))
    alloc = _allocations(caller, user, scope, profiles, [r['email'] for r in data['members']])
    for r in data['members']:
        r['allocation'] = alloc.get(r['email'])        # None: not visible to the caller
    data['showAllocation'] = any(a and a['projects'] for a in alloc.values()) or scope.kind == 'project'
    data['scope'] = scope.json()
    return Response(data)
