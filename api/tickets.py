"""Help Desk tickets (Phase 3).

Employees raise categorised requests (HR, IT, Payroll, Facilities, Other);
agents — anyone whose role grants ``ticket.manage``, plus Super Admins — work
them through a status workflow with an SLA clock and an assignee.

Endpoints (routed in api/urls.py):
    GET        /api/tickets/meta              categories, agents, counts …
    GET/POST   /api/tickets                   list (scoped + filtered) / raise
    GET/PATCH  /api/tickets/<id>              detail + conversation / update
    POST       /api/tickets/<id>/comments     reply (agents may add internal notes)

Identity travels in the ``X-User-Email`` header like the rest of the API.
All times are naive datetimes on the business clock (``local_now``).
"""
from datetime import timedelta

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import AppUser, Ticket, TicketComment
from .permissions import _CACHE as _PERM_CACHE, _get_caller, _is_super_admin, _user_has_perm
from .timeutil import local_now

DATETIME_FMT = '%Y-%m-%d %H:%M:%S'
PERM = 'ticket.manage'

CATEGORIES = ['HR', 'IT', 'Payroll', 'Facilities', 'Other']
PRIORITIES = ['Low', 'Medium', 'High', 'Urgent']
STATUSES = ['Open', 'In Progress', 'Waiting', 'Resolved', 'Closed']
ACTIVE_STATUSES = ('Open', 'In Progress', 'Waiting')
DONE_STATUSES = ('Resolved', 'Closed')
SLA_HOURS = {'Urgent': 4, 'High': 8, 'Medium': 24, 'Low': 72}
REOPEN_DAYS = 7
NOTIFY_CAP = 20


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _norm(v):
    return str(v or '').strip().lower()


def _fmt(dt):
    return dt.strftime(DATETIME_FMT) if dt else None


def _err(message, status=400, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _auth(request):
    """(email, user, is_agent) or a 401 Response."""
    _PERM_CACHE.clear()
    email, user = _get_caller(request)
    if not email or not user or (user.status or 'active') != 'active':
        return None, _err('Please sign in to use the help desk.', 401, 'AUTH_REQUIRED')
    agent = _is_super_admin(user) or _user_has_perm(user, PERM)
    return (email, user, agent), None


def _is_agent_user(user):
    return bool(user) and (user.status or 'active') == 'active' and (
        _is_super_admin(user) or _user_has_perm(user, PERM))


def _agents():
    out = []
    for u in AppUser.objects.select_related('role_ref').filter(status='active').order_by('full_name', 'email'):
        if _is_agent_user(u):
            out.append({'email': _norm(u.email), 'name': u.full_name or u.email.split('@')[0]})
    return out


def _person_name(email, user=None):
    try:
        from .org_views import person_card
        card = person_card(email)
        if card and card.get('name'):
            return card['name']
    except Exception:
        pass
    if user is None:
        user = AppUser.objects.filter(email__iexact=email).first()
    return (user.full_name if user else '') or (email.split('@')[0] if email else '')


def _notify(emails, title, message, ticket, skip=None):
    from .views import create_notification
    link = '/tickets/%d' % ticket.id
    seen = set()
    for e in emails:
        e = _norm(e)
        if not e or e in seen or (skip and e == _norm(skip)):
            continue
        seen.add(e)
        try:
            create_notification(e, title, message, 'info', link)
        except Exception:
            pass


def _notify_handlers(ticket, title, message, skip=None):
    """The assignee, or — while unassigned — every agent (capped)."""
    if ticket.assignee_email:
        targets = [ticket.assignee_email]
    else:
        targets = [a['email'] for a in _agents() if a['email'] != _norm(skip)][:NOTIFY_CAP]
    _notify(targets, title, message, ticket, skip=skip)


def _event(ticket, email, name, body):
    TicketComment.objects.create(ticket=ticket, kind='event', author_email=email,
                                 author_name=name, body=body, created_at=local_now())


def sla_info(t, now=None):
    now = now or local_now()
    due = t.sla_due_at
    if not due:
        return {'state': 'on_track', 'minutesLeft': None}
    if t.status in DONE_STATUSES:
        end = t.resolved_at or t.closed_at or now
        return {'state': 'met' if end <= due else 'breached', 'minutesLeft': None}
    left = (due - now).total_seconds() / 60.0
    minutes = int(left) if left >= 0 else -int(-left)
    if left < 0:
        return {'state': 'breached', 'minutesLeft': minutes}
    if t.status == 'Waiting':
        return {'state': 'paused', 'minutesLeft': minutes}
    window = max(1, (t.sla_hours or 24) * 60)
    return {'state': 'due_soon' if left < window * 0.25 else 'on_track', 'minutesLeft': minutes}


def serialize_ticket(t, now=None):
    return {
        'id': t.id,
        'code': t.code,
        'category': t.category,
        'subject': t.subject,
        'description': t.description,
        'priority': t.priority,
        'status': t.status,
        'requesterEmail': t.requester_email,
        'requesterName': t.requester_name,
        'assigneeEmail': t.assignee_email,
        'assigneeName': t.assignee_name,
        'slaHours': t.sla_hours,
        'slaDueAt': _fmt(t.sla_due_at),
        'firstResponseAt': _fmt(t.first_response_at),
        'resolvedAt': _fmt(t.resolved_at),
        'closedAt': _fmt(t.closed_at),
        'createdAt': _fmt(t.created_at),
        'updatedAt': _fmt(t.updated_at),
        'sla': sla_info(t, now),
    }


def serialize_comment(c):
    return {
        'id': c.id,
        'kind': c.kind,
        'authorEmail': c.author_email,
        'authorName': c.author_name,
        'body': c.body,
        'internal': bool(c.internal),
        'createdAt': _fmt(c.created_at),
    }


def _visible_qs(email, agent):
    qs = Ticket.objects.all()
    if not agent:
        qs = qs.filter(Q(requester_email=email) | Q(assignee_email=email))
    return qs


def _can_reopen(t, now):
    if t.status not in DONE_STATUSES:
        return False
    stamps = [d for d in (t.resolved_at, t.closed_at) if d]
    last = max(stamps) if stamps else t.updated_at
    return bool(last) and now - last <= timedelta(days=REOPEN_DAYS)


def _get_visible(pk, email, agent):
    t = Ticket.objects.filter(pk=pk).first()
    if not t:
        return None
    if agent or t.requester_email == email or t.assignee_email == email:
        return t
    return None


def _detail_payload(t, email, agent):
    now = local_now()
    comments = t.comments.all()
    if not agent:
        comments = comments.filter(internal=False)
    data = serialize_ticket(t, now)
    is_req = t.requester_email == email
    data['comments'] = [serialize_comment(c) for c in comments]
    data['permissions'] = {
        'canManage': agent,
        'isRequester': is_req,
        'canComment': agent or is_req or t.assignee_email == email,
        'canInternal': agent,
        'canClose': is_req and t.status != 'Closed',
        'canReopen': is_req and _can_reopen(t, now),
    }
    return data


def _apply_status(t, new, now):
    """Move ``t`` to ``new`` and stamp/clear resolution times. Returns True if changed."""
    old = t.status
    if new == old:
        return False
    t.status = new
    if new == 'Resolved':
        t.resolved_at = t.resolved_at or now
        t.closed_at = None
    elif new == 'Closed':
        t.resolved_at = t.resolved_at or now
        t.closed_at = now
    else:   # back to an active state: a reopen clears the resolution
        t.resolved_at = None
        t.closed_at = None
    return True


# ---------------------------------------------------------------------------
# views
# ---------------------------------------------------------------------------
@api_view(['GET'])
def ticket_meta(request, *args, **kwargs):
    who, resp = _auth(request)
    if resp:
        return resp
    email, user, agent = who
    now = local_now()
    vis = _visible_qs(email, agent)
    active = vis.filter(status__in=ACTIVE_STATUSES)
    return Response({
        'categories': CATEGORIES,
        'priorities': PRIORITIES,
        'statuses': STATUSES,
        'slaHours': SLA_HOURS,
        'canManage': agent,
        'me': {'email': email, 'name': user.full_name or ''},
        'agents': _agents() if agent else [],
        'counts': {
            'open': active.count(),
            'assignedToMe': Ticket.objects.filter(assignee_email=email, status__in=ACTIVE_STATUSES).count(),
            'overdue': active.filter(sla_due_at__lt=now).count(),
            'mine': Ticket.objects.filter(requester_email=email, status__in=ACTIVE_STATUSES).count(),
        },
    })


@api_view(['GET', 'POST'])
def tickets(request, *args, **kwargs):
    who, resp = _auth(request)
    if resp:
        return resp
    email, user, agent = who
    if request.method == 'POST':
        return _create(request, email, user, agent)

    p = request.GET
    scope = (p.get('scope') or ('all' if agent else 'mine')).lower()
    qs = _visible_qs(email, agent)
    if scope == 'mine':
        qs = qs.filter(requester_email=email)
    elif scope == 'assigned':
        qs = qs.filter(assignee_email=email)
    status = (p.get('status') or '').strip()
    if status == 'active':
        qs = qs.filter(status__in=ACTIVE_STATUSES)
    elif status:
        qs = qs.filter(status=status)
    if p.get('category'):
        qs = qs.filter(category=p.get('category').strip())
    if p.get('priority'):
        qs = qs.filter(priority=p.get('priority').strip())
    q = (p.get('q') or '').strip()
    if q:
        qs = qs.filter(Q(subject__icontains=q) | Q(code__icontains=q) |
                       Q(requester_name__icontains=q) | Q(requester_email__icontains=q))
    now = local_now()
    if str(p.get('overdue') or '').lower() in ('1', 'true', 'yes'):
        qs = qs.filter(status__in=ACTIVE_STATUSES, sla_due_at__lt=now)
    total = qs.count()
    rows = [serialize_ticket(t, now) for t in qs.order_by('-updated_at', '-id')[:500]]
    return Response({'tickets': rows, 'total': total})


def _create(request, email, user, agent):
    d = request.data or {}
    category = str(d.get('category') or '').strip()
    priority = str(d.get('priority') or 'Medium').strip()
    subject = str(d.get('subject') or '').strip()
    description = str(d.get('description') or '').strip()
    if category not in CATEGORIES:
        return _err('Choose a category: ' + ', '.join(CATEGORIES) + '.')
    if priority not in PRIORITIES:
        return _err('Choose a priority: ' + ', '.join(PRIORITIES) + '.')
    if not subject:
        return _err('A subject is required.')
    if len(subject) > 255:
        return _err('The subject must be 255 characters or fewer.')
    now = local_now()
    hours = SLA_HOURS[priority]
    name = _person_name(email, user)
    t = Ticket.objects.create(
        category=category, subject=subject, description=description, priority=priority,
        status='Open', requester_email=email, requester_name=name,
        sla_hours=hours, sla_due_at=now + timedelta(hours=hours),
        created_at=now, updated_at=now,
    )
    t.code = 'TK-%05d' % t.id
    t.save(update_fields=['code'])
    _event(t, email, name, 'Ticket raised')
    _notify_handlers(t, 'New ticket %s' % t.code,
                     '%s raised a %s %s ticket: %s' % (name, priority, category, subject), skip=email)
    return Response(_detail_payload(t, email, agent), status=201)


@api_view(['GET', 'PATCH'])
def ticket_detail(request, pk, *args, **kwargs):
    who, resp = _auth(request)
    if resp:
        return resp
    email, user, agent = who
    t = _get_visible(pk, email, agent)
    if not t:
        return _err('Ticket not found.', 404)
    if request.method == 'GET':
        return Response(_detail_payload(t, email, agent))

    d = request.data or {}
    now = local_now()
    actor_name = _person_name(email, user)
    events = []
    old_status = t.status
    assigned_to = None

    if not agent:
        # A requester may only close their ticket, or reopen it within a week.
        if t.requester_email != email:
            return _err('Only help desk agents can update this ticket.', 403, 'FORBIDDEN')
        extra = [k for k in d.keys() if k not in ('status', 'actorEmail')]
        if extra:
            return _err('Only help desk agents can change %s.' % ', '.join(sorted(extra)), 403, 'FORBIDDEN')
        new = str(d.get('status') or '').strip()
        if new == 'Closed':
            if t.status == 'Closed':
                return _err('This ticket is already closed.')
        elif new == 'Open':
            if not _can_reopen(t, now):
                return _err('A ticket can be reopened only within %d days of being resolved or closed.'
                            % REOPEN_DAYS, 403, 'FORBIDDEN')
        else:
            return _err('You can only close or reopen your ticket.', 403, 'FORBIDDEN')
        if _apply_status(t, new, now):
            events.append('Status: %s → %s' % (old_status, new))
    else:
        if 'status' in d:
            new = str(d.get('status') or '').strip()
            if new not in STATUSES:
                return _err('Unknown status.')
            if _apply_status(t, new, now):
                events.append('Status: %s → %s' % (old_status, new))
        if 'priority' in d:
            pr = str(d.get('priority') or '').strip()
            if pr not in PRIORITIES:
                return _err('Unknown priority.')
            if pr != t.priority:
                events.append('Priority: %s → %s' % (t.priority, pr))
                t.priority = pr
                t.sla_hours = SLA_HOURS[pr]
                t.sla_due_at = (t.created_at or now) + timedelta(hours=t.sla_hours)
        if 'category' in d:
            cat = str(d.get('category') or '').strip()
            if cat not in CATEGORIES:
                return _err('Unknown category.')
            if cat != t.category:
                events.append('Category: %s → %s' % (t.category, cat))
                t.category = cat
        if 'assigneeEmail' in d or 'assignee' in d:
            ae = _norm(d.get('assigneeEmail') if 'assigneeEmail' in d else d.get('assignee'))
            if ae != t.assignee_email:
                if ae:
                    u = AppUser.objects.select_related('role_ref').filter(email__iexact=ae).first()
                    if not _is_agent_user(u):
                        return _err('The assignee must be an active help desk agent.')
                    t.assignee_email = ae
                    t.assignee_name = _person_name(ae, u)
                    events.append('Assigned to %s' % t.assignee_name)
                    assigned_to = ae
                else:
                    t.assignee_email = ''
                    t.assignee_name = ''
                    events.append('Unassigned')

    if not events:
        return Response(_detail_payload(t, email, agent))
    t.updated_at = now
    t.save()
    for body in events:
        _event(t, email, actor_name, body)

    if assigned_to:
        _notify([assigned_to], 'Ticket %s assigned to you' % t.code,
                '%s assigned you "%s".' % (actor_name, t.subject), t, skip=email)
    if t.status != old_status:
        _notify([t.requester_email], 'Ticket %s: %s' % (t.code, t.status),
                'Your ticket "%s" moved from %s to %s.' % (t.subject, old_status, t.status), t, skip=email)
        if not agent:   # requester closed/reopened: tell whoever is handling it
            _notify_handlers(t, 'Ticket %s: %s' % (t.code, t.status),
                             '%s changed "%s" to %s.' % (actor_name, t.subject, t.status), skip=email)
    return Response(_detail_payload(t, email, agent))


@api_view(['POST'])
def ticket_comments(request, pk, *args, **kwargs):
    who, resp = _auth(request)
    if resp:
        return resp
    email, user, agent = who
    t = _get_visible(pk, email, agent)
    if not t:
        return _err('Ticket not found.', 404)
    d = request.data or {}
    body = str(d.get('body') or '').strip()
    if not body:
        return _err('Write a reply first.')
    internal = str(d.get('internal')).lower() in ('true', '1', 'yes')
    if internal and not agent:
        return _err('Only help desk agents can add internal notes.', 403, 'FORBIDDEN')
    is_req = t.requester_email == email
    now = local_now()
    name = _person_name(email, user)
    TicketComment.objects.create(ticket=t, kind='comment', author_email=email, author_name=name,
                                 body=body, internal=internal, created_at=now)
    fields = ['updated_at']
    t.updated_at = now
    staff_reply = (agent or t.assignee_email == email) and not is_req
    if staff_reply and not internal and not t.first_response_at:
        t.first_response_at = now
        fields.append('first_response_at')
    moved = False
    if is_req and not staff_reply and t.status == 'Waiting':
        t.status = 'In Progress'
        fields.append('status')
        moved = True
    t.save(update_fields=fields)
    if moved:
        _event(t, email, name, 'Status: Waiting → In Progress')

    snippet = body if len(body) <= 140 else body[:137] + '...'
    if staff_reply and not internal:
        _notify([t.requester_email], 'Reply on %s' % t.code, '%s: %s' % (name, snippet), t, skip=email)
    elif is_req:
        _notify_handlers(t, 'Reply on %s' % t.code, '%s: %s' % (name, snippet), skip=email)
    return Response(_detail_payload(t, email, agent), status=201)
