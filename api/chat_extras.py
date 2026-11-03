"""Team chat: access control and the Cliq-style extras.

Access control (``chat_guard``)
    Every chat endpoint used to trust an email taken from the request body or
    query string, so anyone could read any room or post as anyone. The guard
    resolves the caller from the signed-in session (X-User-Email, see
    api/permissions.py), refuses requests that claim to be somebody else, and
    requires membership of the room the request touches. File attachments are
    loaded by <img>/<video> tags, which cannot send headers, so their URLs carry
    a signed, expiring token instead (``attachment_url``).

WebSocket tickets
    The socket cannot see the session header either. A member asks
    /api/chat/ws-ticket/<room> for a short-lived signed ticket and connects with
    ``?ticket=``; the consumer only joins the room group for a valid ticket and
    always sends as the ticket's owner.

Extras
    reactions, @mention notifications, the Threads view, per-member unread
    counts, channel settings (rename / public-private), browse + join public
    channels, and the total unread count for the sidebar badge.
"""
import functools
import re


from django.core import signing
from django.db.models import Q
from django.http import JsonResponse
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import AppUser, ChatMember, ChatMessage, ChatReaction, ChatRoom
from .permissions import _CACHE as _PERM_CACHE, _get_caller

ATTACHMENT_SALT = 'hrms-chat-attachment'
ATTACHMENT_MAX_AGE = 7 * 24 * 3600
WS_SALT = 'hrms-chat-ws'
WS_TICKET_MAX_AGE = 300
IDENTITY_KEYS = ('email', 'sender_email', 'created_by')
MAX_EMOJI_LEN = 16
MENTION_EMAIL_RE = re.compile(r'@([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})')


def _norm(v):
    return str(v or '').strip().lower()


def _deny(message, status, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return JsonResponse(body, status=status)


def _now():
    from .views import _chat_now
    return _chat_now()


def is_member(room_id, email):
    return bool(email) and ChatMember.objects.filter(room_id=room_id, employee_email=email).exists()


# ---------------------------------------------------------------------------
# signed attachment links
# ---------------------------------------------------------------------------
def attachment_url(msg_id):
    token = signing.TimestampSigner(salt=ATTACHMENT_SALT).sign(str(msg_id))
    return f'/api/chat/attachment/{msg_id}?t={token}'


def attachment_token_ok(msg_id, token):
    if not token:
        return False
    try:
        value = signing.TimestampSigner(salt=ATTACHMENT_SALT).unsign(token, max_age=ATTACHMENT_MAX_AGE)
    except signing.BadSignature:
        return False
    return value == str(msg_id)


# ---------------------------------------------------------------------------
# the guard
# ---------------------------------------------------------------------------
def chat_guard(membership=True, room_param=None, allow_signed_attachment=False):
    """Decorator for chat views (place it under ``@api_view``).

    membership: require the caller to be a member of the room named by the
    ``room_id`` URL kwarg, or of the room of the ``msg_id`` message, or (with
    ``room_param``) of the room id given in the query string / body."""
    def deco(view):
        @functools.wraps(view)
        def wrapper(request, *args, **kwargs):
            _PERM_CACHE.clear()
            if allow_signed_attachment and 'msg_id' in kwargs and \
                    attachment_token_ok(kwargs['msg_id'], request.GET.get('t')):
                return view(request, *args, **kwargs)

            email, user = _get_caller(request)
            if not email or not user or (user.status or 'active') != 'active':
                return _deny('Please sign in to use chat.', 401, 'AUTH_REQUIRED')

            sources = [request.GET]
            try:
                data = getattr(request, 'data', None)
            except Exception:   # no / unsupported body (e.g. a bare POST to join)
                data = None
            if hasattr(data, 'get'):
                sources.append(data)
            for src in sources:
                for key in IDENTITY_KEYS:
                    claimed = _norm(src.get(key))
                    if claimed and claimed != email:
                        return _deny('You can only use chat as yourself.', 403, 'IDENTITY_MISMATCH')

            # Views fall back to X-Actor-Email when no email is given: pin it to
            # the verified caller (and drop Django's cached header view).
            raw = getattr(request, '_request', request)
            raw.META['HTTP_X_ACTOR_EMAIL'] = email
            raw.__dict__.pop('headers', None)

            if membership:
                room_id = kwargs.get('room_id')
                if room_id is None and 'msg_id' in kwargs:
                    room_id = (ChatMessage.objects.filter(id=kwargs['msg_id'])
                               .values_list('room_id', flat=True).first())
                if room_id is None and room_param:
                    room_id = request.GET.get(room_param) or (data.get(room_param) if hasattr(data, 'get') else None)
                if room_id not in (None, '') and ChatRoom.objects.filter(id=room_id).exists() \
                        and not is_member(room_id, email):
                    return _deny('You are not part of this chat.', 403, 'NOT_A_MEMBER')
            request.chat_email = email
            return view(request, *args, **kwargs)
        return wrapper
    return deco


# ---------------------------------------------------------------------------
# WebSocket tickets
# ---------------------------------------------------------------------------
def make_ws_ticket(email, room_id):
    return signing.dumps({'e': email, 'r': int(room_id)}, salt=WS_SALT)


def read_ws_ticket(ticket, room_id):
    """The ticket owner's email when the ticket is valid for ``room_id`` and
    they are (still) a member; otherwise None."""
    if not ticket:
        return None
    try:
        data = signing.loads(ticket, salt=WS_SALT, max_age=WS_TICKET_MAX_AGE)
    except signing.BadSignature:
        return None
    try:
        if int(data.get('r')) != int(room_id):
            return None
    except (TypeError, ValueError):
        return None
    email = _norm(data.get('e'))
    if not email or not is_member(room_id, email):
        return None
    return email


@api_view(['GET'])
@chat_guard()
def chat_ws_ticket(request, room_id):
    return Response({'ticket': make_ws_ticket(request.chat_email, room_id), 'expiresIn': WS_TICKET_MAX_AGE})


# ---------------------------------------------------------------------------
# unread (per member, from last_read_at — not the shared is_read flag)
# ---------------------------------------------------------------------------
def unread_counts(viewer, room_ids=None):
    """{room_id: unread} for ``viewer``: messages from others, not deleted,
    newer than the viewer's last read time (or join time)."""
    mems = ChatMember.objects.filter(employee_email=viewer)
    if room_ids is not None:
        mems = mems.filter(room_id__in=list(room_ids))
    cond = Q()
    any_room = False
    for m in mems:
        part = Q(room_id=m.room_id)
        # The chat tables store whole seconds. Reading at T covers what was
        # there at T (strictly newer = unread); joining at T reads nothing, so
        # a message posted in that same second still counts.
        if m.last_read_at:
            part &= Q(created_at__gt=m.last_read_at)
        elif m.joined_at:
            part &= Q(created_at__gte=m.joined_at)
        cond |= part
        any_room = True
    if not any_room:
        return {}
    from django.db.models import Count
    rows = (ChatMessage.objects.filter(cond, is_deleted=False).exclude(sender_email=viewer)
            .values('room_id').annotate(n=Count('id')).values_list('room_id', 'n'))
    return dict(rows)


@api_view(['GET'])
@chat_guard(membership=False)
def chat_unread_total(request):
    counts = unread_counts(request.chat_email)
    groups = set(ChatRoom.objects.filter(id__in=[r for r, n in counts.items() if n], is_group=True)
                 .values_list('id', flat=True))
    return Response({
        'total': sum(counts.values()),
        'rooms': sum(1 for v in counts.values() if v),
        'direct': sum(n for r, n in counts.items() if r not in groups),
        'channels': sum(n for r, n in counts.items() if r in groups),
    })


# ---------------------------------------------------------------------------
# reactions
# ---------------------------------------------------------------------------
def _names_for(emails):
    names = {}
    for e, n in AppUser.objects.filter(email__in=list(emails)).values_list('email', 'full_name'):
        names[_norm(e)] = (n or '').strip()
    return names


def reactions_for(message_ids):
    """{message_id: [{emoji, count, emails, names}]} in first-reacted order."""
    out = {}
    rows = list(ChatReaction.objects.filter(message_id__in=list(message_ids))
                .order_by('created_at', 'id').values_list('message_id', 'emoji', 'email'))
    if not rows:
        return out
    names = _names_for({r[2] for r in rows})
    for mid, emoji, email in rows:
        groups = out.setdefault(mid, [])
        g = next((x for x in groups if x['emoji'] == emoji), None)
        if g is None:
            g = {'emoji': emoji, 'count': 0, 'emails': [], 'names': []}
            groups.append(g)
        g['count'] += 1
        g['emails'].append(email)
        g['names'].append(names.get(email) or email.split('@')[0])
    return out


def _valid_emoji(value):
    value = str(value or '').strip()
    if not value or len(value) > MAX_EMOJI_LEN:
        return ''
    if any(ch.isalnum() or ch in '<>"\'&' for ch in value):
        return ''
    return value


@api_view(['POST'])
@chat_guard()
def chat_message_react(request, msg_id):
    """Toggle the caller's reaction. Body: {emoji, on?} (``on`` forces add/remove)."""
    msg = ChatMessage.objects.filter(id=msg_id).first()
    if not msg or msg.is_deleted:
        return _deny('Message not found', 404)
    emoji = _valid_emoji((request.data or {}).get('emoji'))
    if not emoji:
        return _deny('Choose an emoji to react with.', 400)
    email = request.chat_email
    existing = ChatReaction.objects.filter(message_id=msg.id, email=email, emoji=emoji).first()
    want = (request.data or {}).get('on')
    want = (existing is None) if want is None else bool(want)
    if want and existing is None:
        ChatReaction.objects.create(message_id=msg.id, room_id=msg.room_id, email=email, emoji=emoji,
                                    created_at=timezone.now())
    elif not want and existing is not None:
        existing.delete()
    summary = reactions_for([msg.id]).get(msg.id, [])
    from .views import _broadcast_event
    _broadcast_event(msg.room_id, {'type': 'reaction_update', 'id': msg.id, 'reactions': summary})
    return Response({'id': msg.id, 'reactions': summary})


# ---------------------------------------------------------------------------
# @mentions
# ---------------------------------------------------------------------------
def notify_mentions(room, msg, explicit=None):
    """Notify room members mentioned in ``msg`` — via the composer's list of
    picked people (``explicit``) and/or literal ``@email`` in the text. Only
    members of the room, never the sender, at most once each."""
    members = set(ChatMember.objects.filter(room_id=room.id).values_list('employee_email', flat=True))
    wanted = {_norm(e) for e in (explicit or []) if _norm(e)}
    wanted |= {_norm(m) for m in MENTION_EMAIL_RE.findall(msg.message or '')}
    targets = sorted((wanted & {_norm(m) for m in members}) - {_norm(msg.sender_email)})
    if not targets:
        return []
    from .views import create_notification
    who = msg.sender_name or (msg.sender_email or '').split('@')[0]
    where = f'#{room.name}' if room.is_group else 'a direct message'
    text = (msg.message or '').strip()
    preview = (text[:140] + '…') if len(text) > 140 else text
    for email in targets:
        create_notification(email, f'{who} mentioned you in {where}', preview or 'Open the chat to see the message.',
                            'info', f'/employees/chat?room={room.id}&msg={msg.id}')
    return targets


# ---------------------------------------------------------------------------
# Threads view
# ---------------------------------------------------------------------------
def _room_label(room, viewer):
    if room.is_group:
        return '#' + (room.name or 'channel')
    other = (ChatMember.objects.filter(room_id=room.id).exclude(employee_email=viewer)
             .values_list('employee_email', flat=True).first())
    if not other:
        return 'Direct message'
    from .views import _display_name_for
    return _display_name_for(other) or other


@api_view(['GET'])
@chat_guard(membership=False)
def chat_threads(request):
    """Threads the caller takes part in (started the message or replied to it),
    newest activity first."""
    me = request.chat_email
    room_ids = list(ChatMember.objects.filter(employee_email=me).values_list('room_id', flat=True))
    if not room_ids:
        return Response([])
    replies = list(ChatMessage.objects.filter(room_id__in=room_ids, reply_to_id__isnull=False, is_deleted=False)
                   .order_by('-created_at').values('reply_to_id', 'sender_email', 'sender_name', 'created_at')[:3000])
    by_parent = {}
    for r in replies:
        by_parent.setdefault(r['reply_to_id'], []).append(r)
    parents = {p.id: p for p in ChatMessage.objects.filter(id__in=list(by_parent), room_id__in=room_ids)
               .defer('attachment_data').select_related('room')}
    from .views import _fmt_dt
    out = []
    for pid, reps in by_parent.items():
        p = parents.get(pid)
        if not p:
            continue
        involved = _norm(p.sender_email) == me or any(_norm(r['sender_email']) == me for r in reps)
        if not involved:
            continue
        last = reps[0]
        text = '' if p.is_deleted else (p.message or (f'\U0001F4CE {p.attachment_name}' if p.attachment_name else ''))
        out.append({
            'room_id': p.room_id,
            'room_label': _room_label(p.room, me),
            'is_group': bool(p.room.is_group),
            'parent': {'id': p.id, 'sender_email': p.sender_email, 'sender_name': p.sender_name,
                       'text': text[:300], 'created_at': _fmt_dt(p.created_at), 'is_deleted': bool(p.is_deleted)},
            'reply_count': len(reps),
            'participants': sorted({r['sender_name'] or r['sender_email'] for r in reps})[:6],
            'last_reply_at': _fmt_dt(last['created_at']),
            'last_reply_sender': last['sender_name'] or last['sender_email'],
            'sort': last['created_at'],
        })
    out.sort(key=lambda x: x['sort'], reverse=True)
    for item in out:
        item.pop('sort', None)
    return Response(out[:50])


# ---------------------------------------------------------------------------
# My Pins
# ---------------------------------------------------------------------------
@api_view(['GET'])
@chat_guard(membership=False)
def chat_my_pins(request):
    """Messages the caller pinned that are still active (30-day window), in
    rooms they are still part of — newest pin first."""
    me = request.chat_email
    room_ids = list(ChatMember.objects.filter(employee_email=me).values_list('room_id', flat=True))
    now = _now()
    qs = (ChatMessage.objects.filter(room_id__in=room_ids, is_pinned=True, is_deleted=False, pinned_by__iexact=me)
          .filter(Q(pin_expires_at__isnull=True) | Q(pin_expires_at__gt=now))
          .defer('attachment_data').select_related('room').order_by('-pinned_at', '-id')[:100])
    from .views import _fmt_dt
    labels = {}
    out = []
    for m in qs:
        if m.room_id not in labels:
            labels[m.room_id] = _room_label(m.room, me)
        out.append({
            'id': m.id, 'room_id': m.room_id, 'room_label': labels[m.room_id], 'is_group': bool(m.room.is_group),
            'sender_email': m.sender_email, 'sender_name': m.sender_name,
            'text': (m.message or (f'📎 {m.attachment_name}' if m.attachment_name else ''))[:300],
            'created_at': _fmt_dt(m.created_at), 'pinned_at': _fmt_dt(m.pinned_at) if m.pinned_at else None,
            'pin_expires_at': _fmt_dt(m.pin_expires_at) if m.pin_expires_at else None,
        })
    return Response(out)


# ---------------------------------------------------------------------------
# public channels: browse + join
# ---------------------------------------------------------------------------
@api_view(['GET'])
@chat_guard(membership=False)
def chat_browse_channels(request):
    me = request.chat_email
    mine = set(ChatMember.objects.filter(employee_email=me).values_list('room_id', flat=True))
    rooms = ChatRoom.objects.filter(is_group=True, is_private=False).exclude(id__in=mine).order_by('name')
    counts = {}
    for rid in ChatMember.objects.filter(room_id__in=[r.id for r in rooms]).values_list('room_id', flat=True):
        counts[rid] = counts.get(rid, 0) + 1
    return Response([{'id': r.id, 'name': r.name, 'members': counts.get(r.id, 0), 'created_by': r.created_by}
                     for r in rooms])


@api_view(['POST'])
@chat_guard(membership=False)
def chat_join_channel(request, room_id):
    room = ChatRoom.objects.filter(id=room_id).first()
    if not room or not room.is_group:
        return _deny('Channel not found', 404)
    me = request.chat_email
    if not is_member(room.id, me):
        if room.is_private:
            return _deny('This channel is private. Ask a channel admin to add you.', 403)
        ChatMember.objects.create(employee_email=me, room=room, joined_at=_now(), is_admin=False)
    from .views import _room_payload
    return Response(_room_payload(room, me))
