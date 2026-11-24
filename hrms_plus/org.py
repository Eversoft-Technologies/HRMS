"""Matrix reporting: project / scrum / dotted lines next to the line manager.

The line (people) manager stays ``UserProfile.manager_email`` — it alone routes
leave, WFH, timesheet and other approvals (api/org_views.approver_for). A
:class:`hrms_plus.models.ReportingLine` adds a *secondary* lead: a project or
scrum lead, a dotted line or a functional lead, with how much of the person's
time that line takes. Project leads get NO approval rights from a line; they
see their project team in My Team (members, presence, calendar, workload) but
never its approvals.

Endpoints (mounted under /api/ by hrms_plus/urls.py)
  GET    org/chart                 nodes + edges (line + project) for the SVG org chart
  GET    org/lines?email=          one person's lines, line manager and allocation split
  GET    org/lines?all=1           every line (HR), filters: project, lead, status=open|all
  POST   org/lines                 create  {email, leadEmail, kind, project, allocationPct, startDate, endDate}
  GET    org/lines/<id>
  PATCH  org/lines/<id>            update any of the fields above
  DELETE org/lines/<id>            end the line (soft: is_active=False, kept for history)
  POST   org/lines/bulk            {project, leadEmail, kind, startDate, endDate, people:[{email, allocationPct}]}
  GET    org/project-reports       the caller's project team as a lead (HR: ?lead=)
  GET    org/projects              project names in use (for pickers)

Who may do what
  * write: attendance.edit (HR) only -- not employee.edit, which the plain
    Employee role holds on real installs. Nobody changes their
    own lines (same rule as the manager change).
  * read one person's lines: the person, anyone above them in the line-manager
    chain, a lead of one of their current lines, and HR (the writers above plus
    attendance.audit).
  * the chart shows every current project edge (who leads whom on what) to all
    signed-in users, like the org tree itself; the allocation % only to the
    readers above.

Audit: there is no generic audit table in the project (AttendanceAuditLog and
PayrollAuditLog are domain specific), so every write is logged on the
``hrms.audit.org`` logger (actor, action, line id, before → after) and the row
keeps ``created_by``; the report and the lead get an in-app notification.
"""
import logging
from datetime import date, datetime

from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api import org_tree, org_views
from api.permissions import _CACHE, _get_caller, _user_has_perm

from .models import ReportingLine

logger = logging.getLogger(__name__)
audit_log = logging.getLogger('hrms.audit.org')

# HR only: the plain Employee role holds employee.edit on real installs.
WRITE_PERMS = ('attendance.edit',)
READ_ALL_PERMS = WRITE_PERMS + ('attendance.audit',)
KINDS = ReportingLine.KINDS
KIND_LABELS = {'project': 'Project / scrum lead', 'dotted': 'Dotted-line lead', 'functional': 'Functional lead'}
MAX_BULK = 200


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400, **extra):
    body = {'message': message}
    body.update(extra)
    return Response(body, status=status)


def _today():
    from api import views                      # the clock the rest of the app (and its tests) use
    return views.local_today()


def _iso(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    return v.isoformat()


def _ident(request):
    """(email, user, error_response)."""
    _CACHE.clear()
    email, user = _get_caller(request)
    email = _norm(email)
    if not email or not user:
        return email, user, _err('Authentication required. Please sign in again.', 401)
    if (user.status or 'active') != 'active':
        return email, user, _err('Permission denied: account is not active', 403)
    return email, user, None


def _has_any(user, codes):
    return bool(user) and any(_user_has_perm(user, c) for c in codes)


def can_write(user):
    return _has_any(user, WRITE_PERMS)


def can_read_all(user):
    return _has_any(user, READ_ALL_PERMS)


def _people():
    """(profiles, accounts) keyed by lower-cased email (no big text columns)."""
    return org_tree._load()


def _exists_active(email, profiles, accounts):
    return (email in profiles or email in accounts) and org_tree._is_active(email, accounts)


def _card(email, profiles, accounts):
    c = org_views.person_card(email, profiles, accounts)
    if c:
        return c
    return {'key': email, 'email': email, 'name': email.split('@')[0] if email else '', 'initials': 'EM',
            'designation': '', 'department': '', 'employeeId': ''}


def _parse_date(v, label):
    """(date|None, error)."""
    if v in (None, ''):
        return None, ''
    if isinstance(v, date):
        return v, ''
    try:
        d = datetime.strptime(str(v).strip()[:10], '%Y-%m-%d').date()
    except ValueError:
        return None, f'{label} must be a date (YYYY-MM-DD).'
    if not 2000 <= d.year <= 2100:
        return None, f'{label} is out of range.'
    return d, ''


def _overlap(a_start, a_end, b_start, b_end):
    """Do two date ranges (None = open) overlap?"""
    return (a_start is None or b_end is None or a_start <= b_end) and \
           (b_start is None or a_end is None or b_start <= a_end)


def line_status(line, today=None):
    today = today or _today()
    if not line.is_active:
        return 'removed'
    if line.end_date and line.end_date < today:
        return 'ended'
    if line.start_date and line.start_date > today:
        return 'scheduled'
    return 'active'


def open_q(today):
    """Lines that are live now or start later (not removed, not ended)."""
    return Q(is_active=True) & (Q(end_date__isnull=True) | Q(end_date__gte=today))


def current_q(today):
    """Lines that are live today."""
    return open_q(today) & (Q(start_date__isnull=True) | Q(start_date__lte=today))


def current_lines(today=None):
    return ReportingLine.objects.filter(current_q(today or _today()))


def dto(line, profiles, accounts, today=None, with_pct=True):
    r, ld = _norm(line.email), _norm(line.lead_email)
    rc, lc = _card(r, profiles, accounts), _card(ld, profiles, accounts)
    d = {
        'id': line.id, 'email': r, 'name': rc['name'], 'initials': rc['initials'],
        'designation': rc['designation'], 'department': rc['department'],
        'leadEmail': ld, 'leadName': lc['name'], 'leadInitials': lc['initials'],
        'kind': line.kind, 'kindLabel': KIND_LABELS.get(line.kind, line.kind),
        'project': line.project or '',
        'startDate': _iso(line.start_date), 'endDate': _iso(line.end_date),
        'isActive': bool(line.is_active), 'status': line_status(line, today),
        'createdBy': line.created_by or '', 'createdAt': _iso(line.created_at), 'updatedAt': _iso(line.updated_at),
    }
    d['allocationPct'] = int(line.allocation_pct or 0) if with_pct else None
    return d


def allocation_summary(lines):
    """Split of a person's time from their CURRENT lines: project lines count,
    the rest is the line team. {projects:[{project, pct, leads}], projectPct,
    lineTeamPct, label}."""
    by = {}
    for l in lines:
        if l.kind != 'project':
            continue
        name = (l.project or 'Unnamed project').strip()
        g = by.setdefault(name.lower(), {'project': name, 'pct': 0, 'leads': []})
        g['pct'] += int(l.allocation_pct or 0)
        if _norm(l.lead_email) not in g['leads']:
            g['leads'].append(_norm(l.lead_email))
    projects = sorted(by.values(), key=lambda g: (-g['pct'], g['project'].lower()))
    total = min(100, sum(g['pct'] for g in projects))
    line_team = max(0, 100 - total)
    parts = [f"{g['pct']}% {g['project']}" for g in projects if g['pct']]
    if line_team or not parts:
        parts.append(f'{line_team}% line team')
    return {'projects': projects, 'projectPct': total, 'lineTeamPct': line_team, 'label': ', '.join(parts)}


def allocation_map(emails, today=None):
    """email -> allocation_summary for each email (current lines)."""
    emails = [_norm(e) for e in emails]
    per = {e: [] for e in emails}
    for l in current_lines(today).filter(email__in=emails):
        per.setdefault(_norm(l.email), []).append(l)
    return {e: allocation_summary(ls) for e, ls in per.items()}


def project_team(lead_email, today=None):
    """Emails with a current line led by ``lead_email`` (any kind)."""
    lead = _norm(lead_email)
    out = {_norm(e) for e in current_lines(today).filter(lead_email__iexact=lead).values_list('email', flat=True)}
    out.discard(lead)
    out.discard('')
    return sorted(out)


def line_viewer(caller, user, profiles, today=None):
    """f(email) -> may ``caller`` see that person's lines and allocation?"""
    caller = _norm(caller)
    if can_read_all(user):
        return lambda email: True
    below = set(org_views.reporting_tree(caller, profiles))
    led = set(project_team(caller, today))
    return lambda email: (_norm(email) == caller or _norm(email) in below or _norm(email) in led)


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------
def _clean(body, profiles, accounts, current=None, pending=(), today=None):
    """Validate a create (``current`` None) or update. ``pending`` are lines of
    the same request not yet saved (bulk). (clean_dict, error_message)."""
    today = today or _today()
    body = body or {}

    def pick(key, attr):
        if key in body:
            return body.get(key)
        return getattr(current, attr) if current is not None else None

    email = _norm(pick('email', 'email'))
    lead = _norm(pick('leadEmail', 'lead_email'))
    kind = _norm(pick('kind', 'kind')) or 'project'
    project = ' '.join(str(pick('project', 'project') or '').split())
    raw_pct = pick('allocationPct', 'allocation_pct')
    if not email:
        return None, 'email (the person who reports) is required.'
    if not lead:
        return None, 'leadEmail (the project / scrum lead) is required.'
    if email == lead:
        return None, 'A person cannot be their own project lead.'
    if kind not in KINDS:
        return None, 'kind must be one of: ' + ', '.join(KINDS) + '.'
    if kind == 'project' and not project:
        return None, 'Name the project.'
    if len(project) > 160:
        return None, 'The project name is too long (160 characters at most).'
    try:
        pct = int(float(raw_pct if raw_pct not in (None, '') else 0))
    except (TypeError, ValueError):
        return None, 'allocationPct must be a whole number between 0 and 100.'
    if not 0 <= pct <= 100:
        return None, 'allocationPct must be between 0 and 100.'
    start, why = _parse_date(pick('startDate', 'start_date'), 'Start date')
    if why:
        return None, why
    end, why = _parse_date(pick('endDate', 'end_date'), 'End date')
    if why:
        return None, why
    if start and end and end < start:
        return None, 'The end date is before the start date.'
    changed_end = current is None or 'endDate' in body
    if end and end < today and changed_end:
        return None, 'The end date is already in the past — remove the line instead.'
    for who, label in ((email, 'The person'), (lead, 'The lead')):
        if not _exists_active(who, profiles, accounts):
            return None, f'{label} ({who}) is not an active employee.'

    others = [l for l in ReportingLine.objects.filter(open_q(today), email__iexact=email)
              if current is None or l.id != current.id]
    others += [p for p in pending if p.email == email]
    for l in others:
        if _norm(l.lead_email) == lead and (l.project or '').strip().lower() == project.lower():
            return None, (f"{_card(email, profiles, accounts)['name']} already has an active line to "
                          f"{_card(lead, profiles, accounts)['name']}" + (f' on {project}' if project else '') + '.')
    if kind == 'project' and pct:
        used = sum(int(l.allocation_pct or 0) for l in others
                   if l.kind == 'project' and _overlap(l.start_date, l.end_date, start, end))
        if used + pct > 100:
            return None, (f"{_card(email, profiles, accounts)['name']} would be allocated {used + pct}% to projects "
                          f'at the same time (already {used}%); the total cannot exceed 100%.')
    return {'email': email, 'lead_email': lead, 'kind': kind, 'project': project, 'allocation_pct': pct,
            'start_date': start, 'end_date': end}, ''


# ---------------------------------------------------------------------------
# audit + notifications
# ---------------------------------------------------------------------------
def _snap(line):
    return {'email': line.email, 'lead': line.lead_email, 'kind': line.kind, 'project': line.project,
            'pct': line.allocation_pct, 'start': _iso(line.start_date), 'end': _iso(line.end_date),
            'active': line.is_active}


def _audit(actor, action, line, before=None):
    audit_log.info('reporting_line %s id=%s actor=%s before=%s after=%s', action, line.id, actor,
                   before, _snap(line))


def _notify(line, action, actor_name, profiles, accounts):
    try:
        from api.views import create_notification
        who = _card(line.email, profiles, accounts)['name']
        lead = _card(line.lead_email, profiles, accounts)['name']
        what = (line.project or KIND_LABELS.get(line.kind, 'a reporting line'))
        pct = f' ({line.allocation_pct}% of their time)' if line.kind == 'project' and line.allocation_pct else ''
        link = '/org-chart'
        if action == 'created':
            create_notification(line.email, 'New project lead',
                                f'{lead} is now your {KIND_LABELS.get(line.kind, "lead").lower()} for {what}{pct}. '
                                'Your line manager and approvals are unchanged.', 'info', link)
            create_notification(line.lead_email, 'New project team member',
                                f'{who} now reports to you on {what}{pct}. Approvals stay with their line manager.',
                                'info', link)
        elif action == 'removed':
            create_notification(line.email, 'Project line ended', f'You no longer report to {lead} on {what}.',
                                'info', link)
            create_notification(line.lead_email, 'Project line ended', f'{who} no longer reports to you on {what}.',
                                'info', link)
    except Exception:
        logger.exception('reporting line notification failed')


# ---------------------------------------------------------------------------
# chart
# ---------------------------------------------------------------------------
def chart_payload(request, caller, user):
    from api.permissions import check_perm
    today = _today()
    profiles, accounts = _people()
    tree = org_tree.build_tree(profiles, accounts)
    nodes = tree['nodes']
    sees = line_viewer(caller, user, profiles, today)
    edges = [{'from': n['parentEmail'], 'to': e, 'kind': 'line'} for e, n in nodes.items() if n['parentEmail']]
    projects, lead_n, rep_n = {}, {}, {}
    for l in current_lines(today).order_by('email', '-allocation_pct', 'id'):
        r, ld = _norm(l.email), _norm(l.lead_email)
        if r == ld or r not in nodes or ld not in nodes:
            continue
        edge = {'id': l.id, 'from': ld, 'to': r, 'kind': 'project', 'lineKind': l.kind,
                'project': l.project or KIND_LABELS.get(l.kind, ''), 'pct': None}
        if sees(r):
            edge['pct'] = int(l.allocation_pct or 0)
        edges.append(edge)
        key = edge['project']
        g = projects.setdefault(key.lower(), {'name': key, 'count': 0, 'leads': []})
        g['count'] += 1
        if ld not in g['leads']:
            g['leads'].append(ld)
        lead_n[ld] = lead_n.get(ld, 0) + 1
        rep_n[r] = rep_n.get(r, 0) + 1
    out = []
    for e, n in sorted(nodes.items(), key=lambda kv: kv[1]['name'].lower()):
        n = dict(n)
        n['projectReportsCount'] = lead_n.get(e, 0)
        n['projectLeadsCount'] = rep_n.get(e, 0)
        out.append(n)
    return {
        'nodes': out, 'roots': tree['roots'], 'unresolved': tree['unresolved'], 'edges': edges,
        'projects': sorted(projects.values(), key=lambda g: g['name'].lower()),
        'canEdit': bool(check_perm(request, 'employee.edit')[0]),
        'canEditLines': can_write(user),
        'canViewProfiles': bool(check_perm(request, ['employee.view', 'employee.edit'])[0]),
        'me': caller, 'today': _iso(today),
    }


@api_view(['GET'])
def chart(request):
    caller, user, denied = _ident(request)
    if denied:
        return denied
    return Response(chart_payload(request, caller, user))


# ---------------------------------------------------------------------------
# lines
# ---------------------------------------------------------------------------
def _person_view(caller, user, email, profiles, accounts, history=False):
    today = _today()
    p = profiles.get(email)
    mgr = _norm(p.manager_email) if p else ''
    qs = ReportingLine.objects.filter(email__iexact=email)
    if not history:
        qs = qs.filter(open_q(today))
    lines = list(qs.order_by('-is_active', '-allocation_pct', 'id'))
    cur = [l for l in lines if line_status(l, today) == 'active']
    out = {
        'person': _card(email, profiles, accounts),
        'lineManager': _card(mgr, profiles, accounts) if mgr and mgr != email else None,
        'lines': [dto(l, profiles, accounts, today) for l in lines],
        'allocation': allocation_summary(cur),
        'canEdit': can_write(user) and email != caller,
    }
    if email == caller or can_read_all(user):
        led = ReportingLine.objects.filter(open_q(today), lead_email__iexact=email).order_by('project', 'email')
        out['projectReports'] = [dto(l, profiles, accounts, today) for l in led]
    return out


@api_view(['GET', 'POST'])
def lines(request):
    caller, user, denied = _ident(request)
    if denied:
        return denied
    profiles, accounts = _people()
    if request.method == 'POST':
        return _create(request, caller, user, profiles, accounts)
    q = request.GET
    if str(q.get('all') or '').lower() in ('1', 'true', 'yes'):
        if not can_read_all(user):
            return _err('Permission denied: attendance.edit', 403)
        today = _today()
        qs = ReportingLine.objects.all()
        if str(q.get('status') or 'open').lower() != 'all':
            qs = qs.filter(open_q(today))
        if q.get('project'):
            qs = qs.filter(project__iexact=str(q.get('project')).strip())
        if q.get('lead'):
            qs = qs.filter(lead_email__iexact=_norm(q.get('lead')))
        rows = [dto(l, profiles, accounts, today) for l in qs.order_by('project', 'lead_email', 'email')[:2000]]
        return Response({'lines': rows, 'count': len(rows)})
    email = _norm(q.get('email')) or caller
    if email not in profiles and email not in accounts:
        return _err('Employee not found', 404)
    if not line_viewer(caller, user, profiles)(email):
        return _err('You can see the project lines of yourself and the people you manage or lead.', 403)
    history = str(q.get('history') or '').lower() in ('1', 'true', 'yes')
    return Response(_person_view(caller, user, email, profiles, accounts, history))


def _write_denied(caller, user, email):
    if not can_write(user):
        return _err('Permission denied: attendance.edit', 403)
    if email and _norm(email) == caller:
        return _err('Your own reporting lines are changed by another HR administrator.', 403)
    return None


def _create(request, caller, user, profiles, accounts):
    body = request.data or {}
    denied = _write_denied(caller, user, body.get('email'))
    if denied:
        return denied
    with transaction.atomic():
        list(ReportingLine.objects.select_for_update().filter(email__iexact=_norm(body.get('email'))))
        clean, why = _clean(body, profiles, accounts)
        if why:
            return _err(why)
        line = ReportingLine.objects.create(created_by=caller, **clean)
    _audit(caller, 'created', line)
    _notify(line, 'created', caller, profiles, accounts)
    return Response({'ok': True, 'line': dto(line, profiles, accounts),
                     'message': _created_msg(line, profiles, accounts)}, status=201)


def _created_msg(line, profiles, accounts):
    who = _card(line.email, profiles, accounts)['name']
    lead = _card(line.lead_email, profiles, accounts)['name']
    pct = f' ({line.allocation_pct}%)' if line.allocation_pct else ''
    on = f' on {line.project}' if line.project else ''
    return f'{who} now reports to {lead}{on}{pct}. Approvals stay with the line manager.'


@api_view(['GET', 'PUT', 'PATCH', 'DELETE'])
def line_detail(request, pk):
    caller, user, denied = _ident(request)
    if denied:
        return denied
    profiles, accounts = _people()
    line = ReportingLine.objects.filter(pk=pk).first()
    if line is None:
        return _err('Reporting line not found', 404)
    if request.method == 'GET':
        if not line_viewer(caller, user, profiles)(line.email) and _norm(line.lead_email) != caller:
            return _err('Reporting line not found', 404)
        return Response(dto(line, profiles, accounts))
    denied = _write_denied(caller, user, line.email)
    if denied:
        return denied
    before = _snap(line)
    if request.method == 'DELETE':
        if not line.is_active:
            return Response({'ok': True, 'changed': False, 'line': dto(line, profiles, accounts),
                             'message': 'That line was already removed.'})
        line.is_active = False
        line.save(update_fields=['is_active', 'updated_at'])
        _audit(caller, 'removed', line, before)
        _notify(line, 'removed', caller, profiles, accounts)
        who = _card(line.email, profiles, accounts)['name']
        lead = _card(line.lead_email, profiles, accounts)['name']
        return Response({'ok': True, 'changed': True, 'line': dto(line, profiles, accounts),
                         'message': f'{who} no longer reports to {lead}' +
                                    (f' on {line.project}.' if line.project else '.')})
    body = dict(request.data or {})
    if not line.is_active:
        return _err('That line was removed; add a new one instead.', 409)
    if 'email' in body and _norm(body['email']) != _norm(line.email):
        denied = _write_denied(caller, user, body['email'])
        if denied:
            return denied
    with transaction.atomic():
        list(ReportingLine.objects.select_for_update().filter(email__iexact=_norm(body.get('email') or line.email)))
        clean, why = _clean(body, profiles, accounts, current=line)
        if why:
            return _err(why)
        for k, v in clean.items():
            setattr(line, k, v)
        line.save()
    _audit(caller, 'updated', line, before)
    return Response({'ok': True, 'line': dto(line, profiles, accounts), 'message': 'Reporting line updated.'})


@api_view(['POST'])
def lines_bulk(request):
    """Assign several people to one project lead at once — all or nothing."""
    caller, user, denied = _ident(request)
    if denied:
        return denied
    if not can_write(user):
        return _err('Permission denied: attendance.edit', 403)
    body = request.data or {}
    people = body.get('people') or []
    if not isinstance(people, list) or not people:
        return _err('Add at least one person.')
    if len(people) > MAX_BULK:
        return _err(f'At most {MAX_BULK} people at a time.')
    profiles, accounts = _people()
    shared = {k: body.get(k) for k in ('leadEmail', 'kind', 'project', 'startDate', 'endDate')}
    errors, pending, seen = [], [], set()
    with transaction.atomic():
        emails = [_norm(p.get('email') if isinstance(p, dict) else p) for p in people]
        list(ReportingLine.objects.select_for_update().filter(email__in=[e for e in emails if e]))
        for raw in people:
            item = raw if isinstance(raw, dict) else {'email': raw}
            e = _norm(item.get('email'))
            if e in seen:
                errors.append({'email': e, 'message': 'Listed twice.'})
                continue
            seen.add(e)
            if e == caller:
                errors.append({'email': e, 'message': 'Your own reporting lines are changed by another HR administrator.'})
                continue
            data = dict(shared, email=e,
                        allocationPct=item.get('allocationPct', body.get('allocationPct')))
            clean, why = _clean(data, profiles, accounts, pending=pending)
            if why:
                errors.append({'email': e, 'message': why})
                continue
            pending.append(ReportingLine(created_by=caller, **clean))
        if errors:
            return Response({'ok': False, 'created': [], 'errors': errors,
                             'message': 'Nothing was saved: fix the rows below and try again.'}, status=400)
        created = []
        for line in pending:
            line.save()
            created.append(line)
    for line in created:
        _audit(caller, 'created (bulk)', line)
        _notify(line, 'created', caller, profiles, accounts)
    return Response({'ok': True, 'created': [dto(l, profiles, accounts) for l in created], 'errors': [],
                     'message': f'{len(created)} ' + ('person' if len(created) == 1 else 'people') +
                                ' added' + (f" to {shared['project']}" if shared.get('project') else '') + '.'},
                    status=201)


@api_view(['GET'])
def project_reports(request):
    """The people who report to a lead through a reporting line (the caller by default)."""
    caller, user, denied = _ident(request)
    if denied:
        return denied
    lead = _norm(request.GET.get('lead')) or caller
    if lead != caller and not can_read_all(user):
        return _err('Permission denied: attendance.edit', 403)
    profiles, accounts = _people()
    today = _today()
    rows = list(ReportingLine.objects.filter(open_q(today), lead_email__iexact=lead).order_by('project', 'email'))
    alloc = allocation_map({_norm(l.email) for l in rows}, today)
    out = []
    for l in rows:
        d = dto(l, profiles, accounts, today)
        d['allocation'] = alloc.get(_norm(l.email))
        out.append(d)
    return Response({'lead': _card(lead, profiles, accounts), 'lines': out,
                     'count': len({l['email'] for l in out if l['status'] == 'active'})})


@api_view(['GET'])
def projects(request):
    caller, user, denied = _ident(request)
    if denied:
        return denied
    by = {}
    for name, lead in ReportingLine.objects.filter(open_q(_today())).exclude(project='') \
            .values_list('project', 'lead_email'):
        g = by.setdefault(name.strip().lower(), {'name': name.strip(), 'count': 0, 'leads': set()})
        g['count'] += 1
        g['leads'].add(_norm(lead))
    rows = [{'name': g['name'], 'count': g['count'], 'leads': sorted(g['leads'])} for g in by.values()]
    return Response({'projects': sorted(rows, key=lambda g: g['name'].lower())})
