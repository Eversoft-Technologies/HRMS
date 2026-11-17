"""Interactive org tree.

The chart is drawn from exactly the data that routes managerial approvals:
``UserProfile.manager_email``. ``approverEmail`` on every node is computed with
the same rule as :func:`api.org_views.approver_for` (the linked manager, never
the person themselves), and changing a manager here writes the very same field
the HRIS profile editor writes, with the same validation
(:func:`api.org_views.validate_manager`). So the chart and the approval routing
cannot disagree.

  GET  /api/org/tree     any signed-in active user
       -> {nodes, roots, unresolved, canEdit, me}
  POST /api/org/manager  {email, managerEmail ('' clears)}; employee.edit
       -> {ok, node, message}
"""
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import AppUser, UserProfile
from .org_views import _auth_denied, _err, _norm, validate_manager
from .permissions import check_perm

_PROFILE_FIELDS = ('email', 'employee_id', 'first_name', 'last_name', 'department',
                   'designation', 'manager', 'manager_email')
_ACCOUNT_FIELDS = ('id', 'email', 'full_name', 'employee_id', 'status')


def _caller(request):
    _, email, user = check_perm(request, 'employee.view')
    return _norm(email), user


def _load():
    """(profiles, accounts) keyed by lower-cased email; two queries, no big text columns."""
    profiles = {_norm(p.email): p for p in UserProfile.objects.only(*_PROFILE_FIELDS)}
    accounts = {_norm(u.email): u for u in AppUser.objects.only(*_ACCOUNT_FIELDS)}
    profiles.pop('', None)
    accounts.pop('', None)
    return profiles, accounts


def _is_active(email, accounts):
    u = accounts.get(email)
    return u is None or (u.status or 'active') == 'active'


def _approver(email, profiles):
    """Same rule as org_views.approver_for, from the preloaded map."""
    p = profiles.get(email)
    mgr = _norm(p.manager_email) if p else ''
    return mgr if mgr and mgr != email else ''


def _initials(name):
    parts = [w for w in str(name or '').split() if w]
    return ((parts[0][0] if parts else '') + (parts[-1][0] if len(parts) > 1 else '')).upper() or 'EM'


def build_tree(profiles=None, accounts=None):
    """{'nodes': {email: node}, 'roots': [...], 'unresolved': [...]} of active people."""
    if profiles is None or accounts is None:
        profiles, accounts = _load()
    fmt = None
    nodes = {}
    for email in sorted(set(profiles) | set(accounts)):
        if not _is_active(email, accounts):
            continue
        p, u = profiles.get(email), accounts.get(email)
        name = ((f'{p.first_name} {p.last_name}'.strip() if p else '') or (u.full_name if u else '')
                or email.split('@')[0])
        employee_id = (u.employee_id if u else '') or (p.employee_id if p else '') or ''
        if not employee_id and u is not None:
            if fmt is None:
                from .views import employee_id_format
                fmt = employee_id_format()
            from .views import format_employee_number
            employee_id = format_employee_number(u.id, fmt)
        title = (p.designation if p else '') or ''
        nodes[email] = {
            'key': str(u.id) if u else email,
            'email': email,
            'name': name,
            'initials': _initials(name),
            'title': title,
            'designation': title,
            'department': (p.department if p else '') or '',
            'employeeId': employee_id,
            'managerEmail': _norm(p.manager_email) if p else '',
            'managerName': '',
            'approverEmail': _approver(email, profiles),
            'parentEmail': '',
            'managerIssue': '',
            'reportsCount': 0,
            'hasAccount': u is not None,
            'status': (u.status if u else 'active') or 'active',
        }

    # Parent = the linked manager when that is an active, known person.
    unresolved = []
    for email, n in nodes.items():
        mgr = n['managerEmail']
        if not mgr or mgr == email:
            continue
        if mgr in nodes:
            n['parentEmail'] = mgr
            n['managerName'] = nodes[mgr]['name']
        else:
            known = mgr in profiles or mgr in accounts
            n['managerIssue'] = ('The linked manager is no longer active.' if known
                                 else 'The linked manager is not a known employee.')
            unresolved.append(email)

    # Legacy data may hold a loop; cut it so everyone is still shown once.
    for email in nodes:
        seen, cur = [], email
        while cur and cur not in seen:
            seen.append(cur)
            cur = nodes[cur]['parentEmail']
        if cur:                                   # walked back into the chain
            nodes[cur]['parentEmail'] = ''
            nodes[cur]['managerIssue'] = 'Circular reporting line — shown at the top until it is fixed.'
            if cur not in unresolved:
                unresolved.append(cur)

    for n in nodes.values():
        if n['parentEmail']:
            nodes[n['parentEmail']]['reportsCount'] += 1
    roots = sorted((e for e, n in nodes.items() if not n['parentEmail']),
                   key=lambda e: nodes[e]['name'].lower())
    return {'nodes': nodes, 'roots': roots, 'unresolved': sorted(unresolved)}


@api_view(['GET'])
def org_tree(request, *args, **kwargs):
    email, user = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    tree = build_tree()
    nodes = sorted(tree['nodes'].values(), key=lambda n: n['name'].lower())
    return Response({
        'nodes': nodes,
        'roots': tree['roots'],
        'unresolved': tree['unresolved'],
        'canEdit': bool(check_perm(request, 'employee.edit')[0]),
        'canViewProfiles': bool(check_perm(request, ['employee.view', 'employee.edit'])[0]),
        'me': email,
    })


@api_view(['POST'])
def set_manager(request, *args, **kwargs):
    email, user = _caller(request)
    denied = _auth_denied(email, user)
    if denied:
        return denied
    if not check_perm(request, 'employee.edit')[0]:
        return _err('Permission denied: employee.edit', 403)

    body = request.data or {}
    target = _norm(body.get('email'))
    if not target:
        return _err('email is required')
    if 'managerEmail' not in body:
        return _err('managerEmail is required (use "" to clear it)')
    mgr = _norm(body.get('managerEmail'))
    if target == email:
        # Same rule as the profile editor: your own reporting line is set by someone else.
        return _err('Your own reporting line is changed by another HR administrator.', 403)

    profiles, accounts = _load()
    if target not in profiles and target not in accounts:
        return _err('Employee not found', 404)
    why = validate_manager(target, mgr)
    if why:
        return _err(why)
    if mgr and not _is_active(mgr, accounts):
        return _err('The manager must be an active employee.')

    tree = build_tree(profiles, accounts)
    node = tree['nodes'].get(target)
    old = _approver(target, profiles)
    if old == mgr:
        return Response({'ok': True, 'changed': False, 'node': node, 'message': 'No change: that is already the manager.'})

    profile = UserProfile.objects.filter(email__iexact=target).first()
    if profile is None:
        # An account created in Settings > User Access has no HRIS row yet
        # (mirrors the HRIS profile editor).
        acct = AppUser.objects.filter(email__iexact=target).first()
        parts = (acct.full_name or '').split() if acct else []
        profile = UserProfile.objects.create(
            email=target,
            employee_id=(acct.employee_id if acct else '') or '',
            first_name=parts[0] if parts else '',
            last_name=' '.join(parts[1:]),
            profile_pic=(acct.profile_pic if acct else '') or '',
        )
    mgr_node = tree['nodes'].get(mgr) if mgr else None
    profile.manager_email = mgr
    profile.manager = mgr_node['name'] if mgr_node else ''     # display name kept in step
    profile.save(update_fields=['manager_email', 'manager', 'updated_at'])

    profiles, accounts = _load()
    tree = build_tree(profiles, accounts)
    node = tree['nodes'].get(target)
    who = node['name'] if node else target
    mgr_name = mgr_node['name'] if mgr_node else ''
    old_name = tree['nodes'][old]['name'] if old in tree['nodes'] else old

    from .views import create_notification
    link = '/org-chart'
    if mgr:
        create_notification(target, 'Your manager has changed',
                            f'{mgr_name} is now your manager. New leave, WFH and timesheet requests go to {mgr_name}.',
                            'info', link)
        create_notification(mgr, 'New direct report',
                            f'{who} now reports to you. You will receive their leave, WFH and timesheet requests.',
                            'info', link)
    else:
        create_notification(target, 'Your manager has been removed',
                            'You no longer have a manager linked. HR will handle your requests until one is set.',
                            'info', link)
    if old and old != mgr:
        create_notification(old, 'Reporting line changed',
                            f'{who} no longer reports to you.', 'info', link)

    msg = (f'{who} now reports to {mgr_name}.' if mgr else f'{who} no longer has a manager.')
    if old:
        msg += (f' Requests already pending with {old_name} stay with them; '
                f'only new requests follow the new reporting line.')
    return Response({'ok': True, 'changed': True, 'node': node, 'previousManagerEmail': old, 'message': msg})
