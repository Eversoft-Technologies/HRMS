"""Org structure: reporting lines and teams.

Two related but separate relationships:

* **Manager** — ``UserProfile.manager_email``, one per employee. Handles
  people reporting and HR approvals (e.g. leave). Validated: the manager must
  be a known employee, never the employee themselves, and never someone who
  already reports up to them (no cycles).
* **Team** — ``Team`` + ``TeamMembership``. An employee may be in several
  teams; each team has its own lead, who guides work (e.g. tasks).

Neither is the RBAC role, which only governs permissions.

Access: HR / admins (employee.edit) create teams, assign leads and manage
members. Anyone with employee.view can see every team. Everyone else sees only
the teams they belong to or lead.
"""
from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import AppUser, Team, TeamMembership, UserProfile
from .permissions import check_perm

MAX_CHAIN = 50


def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400):
    return Response({'message': message}, status=status)


def _caller(request):
    """(caller_email, user, has) — has(code) answers permission questions."""
    _, email, user = check_perm(request, 'employee.view')

    def has(code):
        return check_perm(request, code)[0]

    return _norm(email), user, has


def _auth_denied(email, user):
    if not email or not user:
        return _err('Authentication required. Please sign in again.', 401)
    if user.status != 'active':
        return _err('Permission denied: account is not active', 403)
    return None


# --- people ----------------------------------------------------------------
def known_emails():
    out = {_norm(e) for e in AppUser.objects.values_list('email', flat=True)}
    out |= {_norm(e) for e in UserProfile.objects.values_list('email', flat=True)}
    out.discard('')
    return out


def person_card(email, profiles=None, accounts=None):
    email = _norm(email)
    if not email:
        return None
    p = (profiles or {}).get(email) if profiles is not None else UserProfile.objects.filter(email__iexact=email).first()
    u = (accounts or {}).get(email) if accounts is not None else AppUser.objects.filter(email__iexact=email).first()
    if p is None and u is None:
        return None
    name = (f'{p.first_name} {p.last_name}'.strip() if p else '') or (u.full_name if u else '') or email.split('@')[0]
    parts = [w for w in name.split() if w]
    initials = ((parts[0][0] if parts else '') + (parts[-1][0] if len(parts) > 1 else '')).upper() or 'EM'
    employee_id = (u.employee_id if u else '') or (p.employee_id if p else '') or ''
    if not employee_id and u is not None:
        from .views import format_employee_number
        employee_id = format_employee_number(u.id)
    return {
        'key': str(u.id) if u else email,
        'email': email,
        'name': name,
        'initials': initials,
        'designation': (p.designation if p else '') or '',
        'department': (p.department if p else '') or '',
        'employeeId': employee_id,
    }


def reporting_tree(email, profiles=None):
    """Everyone below ``email`` in the reporting line (direct and indirect)."""
    profiles = profiles if profiles is not None else {_norm(p.email): p for p in UserProfile.objects.all()}
    under = {}
    for e, p in profiles.items():
        m = _norm(p.manager_email)
        if m and m != e:
            under.setdefault(m, []).append(e)
    seen, queue = set(), list(under.get(_norm(email), []))
    while queue and len(seen) < 5000:
        e = queue.pop()
        if e in seen or e == _norm(email):
            continue
        seen.add(e)
        queue.extend(under.get(e, []))
    return sorted(seen)


def people_maps():
    profiles = {_norm(p.email): p for p in UserProfile.objects.all()}
    accounts = {_norm(u.email): u for u in AppUser.objects.all()}
    return profiles, accounts


# --- reporting line --------------------------------------------------------
def manager_chain(email, profiles=None):
    """Emails above ``email``, nearest first (stops at a repeat or MAX_CHAIN)."""
    profiles = profiles if profiles is not None else {_norm(p.email): p for p in UserProfile.objects.all()}
    seen, chain, cur = {_norm(email)}, [], _norm(email)
    for _ in range(MAX_CHAIN):
        p = profiles.get(cur)
        nxt = _norm(p.manager_email) if p else ''
        if not nxt or nxt in seen:
            if nxt in seen and nxt:
                chain.append(nxt)
            break
        chain.append(nxt)
        seen.add(nxt)
        cur = nxt
    return chain


def validate_manager(employee_email, manager_email):
    """'' when acceptable, otherwise the reason it is not."""
    employee_email, manager_email = _norm(employee_email), _norm(manager_email)
    if not manager_email:
        return ''
    if manager_email == employee_email:
        return 'An employee cannot be their own manager.'
    if manager_email not in known_emails():
        return 'The manager must be an existing employee.'
    if employee_email in manager_chain(manager_email):
        return 'That would create a circular reporting line: the chosen manager already reports up to this employee.'
    return ''


def direct_reports(email, profiles=None):
    email = _norm(email)
    profiles = profiles if profiles is not None else {_norm(p.email): p for p in UserProfile.objects.all()}
    return sorted(e for e, p in profiles.items() if _norm(p.manager_email) == email and e != email)


def is_manager_of(manager_email, employee_email):
    p = UserProfile.objects.filter(email__iexact=_norm(employee_email)).only('manager_email').first()
    return bool(p and _norm(p.manager_email) and _norm(p.manager_email) == _norm(manager_email))


# --- teams -----------------------------------------------------------------
def teams_for(email):
    email = _norm(email)
    ids = set(TeamMembership.objects.filter(email=email).values_list('team_id', flat=True))
    ids |= set(Team.objects.filter(lead_email=email).values_list('id', flat=True))
    return Team.objects.filter(id__in=ids)


def team_dict(team, profiles=None, accounts=None, with_members=True):
    if profiles is None or accounts is None:
        profiles, accounts = people_maps()
    members = [m.email for m in team.memberships.all()]
    d = {
        'id': team.id,
        'name': team.name,
        'department': team.department or '',
        'description': team.description or '',
        'status': team.status or 'active',
        'leadEmail': _norm(team.lead_email),
        'lead': person_card(team.lead_email, profiles, accounts),
        'memberCount': len(members),
        'createdBy': team.created_by or '',
        'createdAt': team.created_at.strftime('%Y-%m-%d %H:%M:%S') if team.created_at else None,
    }
    if with_members:
        d['members'] = [c for c in (person_card(e, profiles, accounts) or {'email': e, 'name': e, 'key': e,
                                                                          'initials': 'EM', 'designation': '',
                                                                          'department': ''}
                                    for e in members)]
    return d


def _can_see(team, email, has):
    if has('employee.view') or has('employee.edit'):
        return True
    return _norm(team.lead_email) == email or team.memberships.filter(email=email).exists()


def _clean_lead(lead):
    lead = _norm(lead)
    if lead and lead not in known_emails():
        return None, 'The team lead must be an existing employee.'
    return lead, ''


@api_view(['GET', 'POST'])
def teams(request):
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    profiles, accounts = people_maps()

    if request.method == 'GET':
        qs = Team.objects.prefetch_related('memberships')
        if not (has('employee.view') or has('employee.edit')):
            qs = qs.filter(id__in=teams_for(email).values('id'))
        target = _norm(request.GET.get('email'))
        if target:
            qs = qs.filter(id__in=teams_for(target).values('id'))
        status = request.GET.get('status')
        if status:
            qs = qs.filter(status=status)
        return Response([team_dict(t, profiles, accounts) for t in qs])

    if not has('employee.edit'):
        return _err('Permission denied: employee.edit', 403)
    body = request.data or {}
    name = ' '.join(str(body.get('name') or '').split())
    if not name:
        return _err('Team name is required.')
    if Team.objects.filter(name__iexact=name).exists():
        return _err('A team with this name already exists.', 409)
    lead, why = _clean_lead(body.get('leadEmail'))
    if why:
        return _err(why)
    members = [_norm(e) for e in (body.get('members') or []) if _norm(e)]
    unknown = [e for e in members if e not in known_emails()]
    if unknown:
        return _err('Not an employee: ' + ', '.join(unknown))
    with transaction.atomic():
        team = Team.objects.create(
            name=name,
            department=str(body.get('department') or '').strip(),
            description=str(body.get('description') or '').strip(),
            status='active',
            lead_email=lead,
            created_by=email,
        )
        for e in dict.fromkeys(members + ([lead] if lead else [])):
            TeamMembership.objects.get_or_create(team=team, email=e, defaults={'added_by': email})
    return Response(team_dict(team, profiles, accounts), status=201)


@api_view(['GET', 'PUT', 'DELETE'])
def team_detail(request, pk):
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    team = Team.objects.filter(pk=pk).prefetch_related('memberships').first()
    if not team or not _can_see(team, email, has):
        return _err('Team not found', 404)
    if request.method == 'GET':
        return Response(team_dict(team))
    if not has('employee.edit'):
        return _err('Permission denied: employee.edit', 403)
    if request.method == 'DELETE':
        team.delete()          # tasks keep their row; their team link is cleared
        return Response({'ok': True})

    body = request.data or {}
    if 'name' in body:
        name = ' '.join(str(body.get('name') or '').split())
        if not name:
            return _err('Team name is required.')
        if Team.objects.filter(name__iexact=name).exclude(pk=team.pk).exists():
            return _err('A team with this name already exists.', 409)
        team.name = name
    for key, field in (('department', 'department'), ('description', 'description')):
        if key in body:
            setattr(team, field, str(body.get(key) or '').strip())
    if 'status' in body:
        st = str(body.get('status') or '').strip().lower()
        if st not in ('active', 'archived'):
            return _err('Status must be active or archived.')
        team.status = st
    if 'leadEmail' in body:
        lead, why = _clean_lead(body.get('leadEmail'))
        if why:
            return _err(why)
        team.lead_email = lead
        if lead:
            TeamMembership.objects.get_or_create(team=team, email=lead, defaults={'added_by': email})
    team.save()
    return Response(team_dict(team))


@api_view(['POST'])
def team_members(request, pk):
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    if not has('employee.edit'):
        return _err('Permission denied: employee.edit', 403)
    team = Team.objects.filter(pk=pk).first()
    if not team:
        return _err('Team not found', 404)
    body = request.data or {}
    emails = body.get('emails') or ([body.get('email')] if body.get('email') else [])
    emails = [_norm(e) for e in emails if _norm(e)]
    if not emails:
        return _err('email is required')
    unknown = [e for e in emails if e not in known_emails()]
    if unknown:
        return _err('Not an employee: ' + ', '.join(unknown))
    for e in emails:
        TeamMembership.objects.get_or_create(team=team, email=e, defaults={'added_by': email})
    return Response(team_dict(team), status=201)


@api_view(['DELETE'])
def team_member_detail(request, pk, member):
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    if not has('employee.edit'):
        return _err('Permission denied: employee.edit', 403)
    team = Team.objects.filter(pk=pk).first()
    if not team:
        return _err('Team not found', 404)
    member = _norm(member)
    if member and member == _norm(team.lead_email):
        return _err('Assign a different team lead before removing the current one.', 409)
    deleted, _ = TeamMembership.objects.filter(team=team, email=member).delete()
    if not deleted:
        return _err('Not a member of this team', 404)
    return Response(team_dict(team))


@api_view(['GET'])
def org_people(request):
    """Picker list for the manager / lead / member dropdowns."""
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    if not (has('employee.view') or has('employee.edit')):
        return _err('Permission denied: employee.view', 403)
    profiles, accounts = people_maps()
    rows = []
    for e in sorted(set(profiles) | set(accounts)):
        u = accounts.get(e)
        if u is not None and (u.status or 'active') != 'active':
            continue
        card = person_card(e, profiles, accounts)
        if card:
            card['managerEmail'] = _norm(profiles[e].manager_email) if e in profiles else ''
            rows.append(card)
    rows.sort(key=lambda r: r['name'].lower())
    return Response(rows)


@api_view(['GET'])
def manager_review(request):
    """Profiles whose manager is still free text that matched nobody, or
    points at someone who no longer exists — for HR to resolve."""
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    if not has('employee.edit'):
        return _err('Permission denied: employee.edit', 403)
    profiles, accounts = people_maps()
    known = set(profiles) | set(accounts)
    by_name = {}
    for e in known:
        c = person_card(e, profiles, accounts)
        if c:
            by_name.setdefault(c['name'].lower(), []).append(c)
    rows = []
    for e, p in profiles.items():
        text = ' '.join((p.manager or '').split())
        link = _norm(p.manager_email)
        if link and link in known:
            continue
        if not text and not link:
            continue
        rows.append({
            'employee': person_card(e, profiles, accounts),
            'managerText': text,
            'managerEmail': link,
            'reason': 'Linked manager no longer exists' if link else
                      ('Name matches several employees' if len(by_name.get(text.lower(), [])) > 1
                       else 'No employee with this name'),
            'candidates': by_name.get(text.lower(), [])[:5],
        })
    rows.sort(key=lambda r: r['employee']['name'].lower())
    return Response(rows)


# --- approval routing --------------------------------------------------------
# One rule for every approval workflow:
#   * people-related requests (leave, WFH, attendance corrections, overtime)
#     route to the employee's linked manager;
#   * team-work requests (work submissions) route to the team lead;
#   * the module permission (e.g. leave.action) still lets HR decide anything.
# A manager or lead never gains rights over themselves, and team membership or
# leadership alone never grants a module permission.
def approver_for(email):
    """The employee's linked manager email ('' when there is none)."""
    email = _norm(email)
    p = UserProfile.objects.filter(email__iexact=email).only('manager_email').first()
    mgr = _norm(p.manager_email) if p else ''
    return mgr if mgr and mgr != email else ''


def can_decide(request, perm, subject_email, assigned_email=''):
    """(allowed, caller_email, error_response) for approving / rejecting a
    request filed by ``subject_email``. Allowed with ``perm``, or as the
    request's assigned approver, or as the subject's direct manager — but
    never on your own request through the manager route."""
    allowed, caller_email, user = check_perm(request, perm)
    caller_email = _norm(caller_email)
    if not caller_email or not user:
        return False, caller_email, _err('Authentication required. Please sign in again.', 401)
    if allowed:
        return True, caller_email, None
    subject = _norm(subject_email)
    if subject and subject != caller_email and (
            caller_email == _norm(assigned_email) or is_manager_of(caller_email, subject)):
        return True, caller_email, None
    return False, caller_email, _err(f'Permission denied: {perm}', 403)


def reports_of(email):
    """Emails whose linked manager is ``email``."""
    return list(UserProfile.objects.filter(manager_email__iexact=_norm(email))
                .exclude(email__iexact=_norm(email)).values_list('email', flat=True))


def team_member_emails(team_id):
    return list(TeamMembership.objects.filter(team_id=team_id).values_list('email', flat=True))


def notify(email, title, message, link='', category=None):
    if not email:
        return
    from .views import create_notification
    create_notification(email, title, message, 'info', link, category=category)


def pick_team(email, team_id, require_choice=True):
    """(team, error) for work done by ``email``.

    An explicit ``team_id`` must be an active team the person belongs to.
    Without one: a single active membership is used; several are an error
    when ``require_choice`` (the caller must choose); none means no team."""
    email = _norm(email)
    if team_id not in (None, ''):
        team = Team.objects.filter(pk=team_id).first()
        if team is None:
            return None, 'Team not found.'
        if team.status != 'active':
            return None, f'The team "{team.name}" is archived. Choose an active team.'
        if email and not (team.memberships.filter(email=email).exists() or _norm(team.lead_email) == email):
            return None, f'{email} is not a member of the team "{team.name}".'
        return team, ''
    if not email:
        return None, ''
    mine = list(teams_for(email).filter(status='active')[:3])
    if len(mine) == 1:
        return mine[0], ''
    if len(mine) > 1 and require_choice:
        return None, 'This person belongs to several teams. Choose the team this belongs to.'
    return None, ''


def eligible_reviewers(team=None):
    """Who may be picked as a work-submission reviewer: the team lead plus
    anyone whose role can action submissions (Super Admins included)."""
    from .permissions import _is_super_admin, _user_has_perm
    out = []
    if team is not None and team.lead_email:
        out.append(_norm(team.lead_email))
    for u in AppUser.objects.filter(status='active').select_related('role_ref'):
        e = _norm(u.email)
        if e not in out and (_is_super_admin(u) or _user_has_perm(u, 'submission.action')):
            out.append(e)
    return out


@api_view(['GET'])
def org_approver(request):
    """The read-only approver shown on a request form: ?email= (default: the
    caller) -> {manager: card|null}."""
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    target = _norm(request.GET.get('email')) or email
    if target != email and not (has('employee.view') or has('leave.action')):
        return _err('Permission denied: employee.view', 403)
    mgr = approver_for(target)
    return Response({'email': target, 'manager': person_card(mgr) if mgr else None})


@api_view(['GET'])
def org_reviewers(request):
    """Eligible reviewers for a work submission, ?teamId= puts the lead first."""
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    team = Team.objects.filter(pk=request.GET.get('teamId')).first() if request.GET.get('teamId') else None
    profiles, accounts = people_maps()
    rows = []
    for e in eligible_reviewers(team):
        card = person_card(e, profiles, accounts)
        if card:
            card['isLead'] = bool(team and _norm(team.lead_email) == e)
            rows.append(card)
    return Response(rows)


@api_view(['GET'])
def org_unresolved(request):
    """Legacy free-text names that could not be linked to a person, for HR."""
    email, user, has = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    if not has('employee.edit'):
        return _err('Permission denied: employee.edit', 403)
    from .models import AttendanceCorrection, EmployeeTask, LeaveRequest, WfhRequest, WorkSubmission
    out = []

    def add(kind, rid, who, text, status):
        out.append({'kind': kind, 'id': rid, 'employee': who, 'name': text, 'status': status})

    for t in EmployeeTask.objects.exclude(team_lead='').filter(team_lead_email='')[:200]:
        add('Task team lead', t.id, t.assignee_email or t.assignee, t.team_lead, t.stage)
    for s in WorkSubmission.objects.exclude(reviewer='').filter(reviewer_email='')[:200]:
        add('Submission reviewer', s.id, s.email, s.reviewer, s.status)
    for r in LeaveRequest.objects.filter(approver_email='')[:200]:
        if r.status == 'Pending' or r.approver:
            add('Leave approver', r.id, r.email, r.approver or '(no manager linked)', r.status)
    for r in WfhRequest.objects.filter(approver_email='', status='Pending')[:200]:
        add('WFH approver', r.id, r.email, r.approver or '(no manager linked)', r.status)
    for r in AttendanceCorrection.objects.filter(reviewer_email='', status='Pending')[:200]:
        add('Correction reviewer', r.id, r.email, r.reviewer or '(no manager linked)', r.status)
    from .work_setup import setup_issues
    out.extend(setup_issues())
    return Response(out)
