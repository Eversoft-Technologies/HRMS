"""Task Tracker notifications: assignees, watchers and @mentions.

One place decides who hears about what happens to an issue
(``api/views.py`` tasks / task_detail and ``api/project_views.py`` comments
call in here), and every recipient gets at most ONE in-app notification and
ONE email per action, naming every reason that applies ("assigned you and
mentioned you").

Who is told
-----------
* created with an assignee      -> the assignee ("assigned")
* assignee changed              -> the new assignee ("assigned") and the
                                   previous one ("unassigned", told who has it now)
* status changed / closed /     -> the assignee and the watchers
  reopened
* comment added                 -> the assignee and the watchers ("comment")
* @mentions in the title, the   -> each mentioned active user, once per NEW
  description or a comment         mention (edits are diffed old vs new)
Nobody is told about their own action.

Mentions are the ``@email`` tokens the markdown editor inserts
(dist/dist/assets/hrms-projects.js acPick); a bare ``@word`` is resolved when
it names exactly one active user (email local part, or full name without
spaces). Mentions inside code spans / fences are ignored.

Channels and preferences (api/notification_prefs.py)
----------------------------------------------------
* in-app  -> ``create_notification(..., category='task_activity')``
* email   -> only when ``allows(email, 'task_emails')``; rendered with
  ``mailer.render_branded`` and sent with ``mailer.send_email`` after the
  transaction commits, on a daemon thread (``RUN_ASYNC = False`` runs it
  inline, for tests). A failed send is logged, never raised.

Every public function swallows its own errors: a notification problem must
never fail the request that changed the issue.
"""
import html
import json
import logging
import os
import re
import threading

from django.db import close_old_connections, transaction

logger = logging.getLogger(__name__)

RUN_ASYNC = True                 # tests switch this off to send inline
CATEGORY_INAPP = 'task_activity'
CATEGORY_EMAIL = 'task_emails'
EXCERPT_LEN = 300
ISSUE_PATH = '/employees/tasks/issue/%s'

DONE = ('done', 'complete', 'completed', 'closed')
STAGE_LABEL = {'todo': 'To Do', 'inprogress': 'In Progress', 'review': 'In Review', 'done': 'Done'}

_EMAIL_MENTION = re.compile(r'(?<![\w@/.])@([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)')
_WORD_MENTION = re.compile(r'(?<![\w@/.])@([A-Za-z0-9](?:[\w.-]*\w)?)(?![\w@])')
_FENCE = re.compile(r'(^|\n)\s*(`{3,}|~{3,})[^\n]*\n.*?(\n\s*\2[^\n]*|$)', re.S)
_CODE = re.compile(r'`[^`\n]*`')
_DATA_IMG = re.compile(r'!\[([^\]\n]*)\]\(data:[^)\s]*\)')
_DATA_URL = re.compile(r'data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+')


# ── helpers ───────────────────────────────────────────────────────────────
def _norm(v):
    return str(v or '').strip().lower()


def _stage(v):
    s = _norm(v).replace(' ', '').replace('_', '').replace('-', '')
    if s in DONE:
        return 'done'
    if s in ('review', 'inreview'):
        return 'review'
    if s in ('inprogress', 'progress', 'doing'):
        return 'inprogress'
    return 'todo'


def _strip_code(text):
    text = _FENCE.sub('\n', str(text or ''))
    return _CODE.sub(' ', text)


def mention_tokens(text):
    """(emails, words) mentioned in ``text`` (lower-cased, code ignored)."""
    clean = _strip_code(text)
    emails = {m.lower() for m in _EMAIL_MENTION.findall(clean)}
    words = {m.lower() for m in _WORD_MENTION.findall(clean)}
    return emails, words


def resolve_mentions(text):
    """Set of active users' emails mentioned in ``text``."""
    emails, words = mention_tokens(text)
    if not emails and not words:
        return set()
    from .models import AppUser
    out = set()
    if emails:
        out |= {_norm(e) for e in AppUser.objects.filter(status='active', email__in=list(emails))
                .values_list('email', flat=True)}
        if len(out) < len(emails):   # stored email in another case
            for e in emails - out:
                u = AppUser.objects.filter(status='active', email__iexact=e).values_list('email', flat=True).first()
                if u:
                    out.add(_norm(u))
    if words:
        by_local, by_name = {}, {}
        for email, name in AppUser.objects.filter(status='active').values_list('email', 'full_name'):
            e = _norm(email)
            by_local.setdefault(e.split('@')[0], set()).add(e)
            key = re.sub(r'\s+', '', _norm(name))
            if key:
                by_name.setdefault(key, set()).add(e)
        for w in words:
            hits = by_local.get(w, set()) | by_name.get(w, set())
            if len(hits) == 1:
                out |= hits
    return out


def new_mentions(old_text, new_text):
    """Mentioned in ``new_text`` but not already in ``old_text``."""
    after = resolve_mentions(new_text)
    if not after:
        return set()
    return after - resolve_mentions(old_text)


def watchers_of(task):
    raw = getattr(task, 'watchers', '') or '[]'
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        data = [x for x in re.split(r'[,\s]+', str(raw)) if '@' in x]
    out = set()
    for w in data if isinstance(data, (list, tuple)) else []:
        e = _norm(w.get('email') if isinstance(w, dict) else w)
        if '@' in e:
            out.add(e)
    return out


def snapshot(task):
    """What task_updated() compares against; take it before saving."""
    return {
        'assignee_email': _norm(task.assignee_email),
        'assignee': task.assignee or '',
        'stage': task.stage or '',
        'title': task.title or '',
        'description': task.description or '',
    }


def _actor(request):
    try:
        from .permissions import _get_caller
        email, user = _get_caller(request)
        email = _norm(email)
        name = ((user.full_name if user else '') or email or 'Someone').strip()
        return email, name
    except Exception:
        return '', 'Someone'


def public_base(request=None):
    """Origin for links in emails: PUBLIC_BASE_URL, then settings.HRMS_PUBLIC_URL,
    then the request's own host; '' when none is known."""
    base = os.environ.get('PUBLIC_BASE_URL', '').strip()
    if not base:
        try:
            from django.conf import settings
            base = (getattr(settings, 'HRMS_PUBLIC_URL', '') or '').strip()
        except Exception:
            base = ''
    if not base and request is not None:
        try:
            base = request.build_absolute_uri('/')
        except Exception:
            base = ''
    return base.rstrip('/')


def excerpt(text, n=EXCERPT_LEN):
    t = _DATA_IMG.sub(lambda m: '[image: %s]' % (m.group(1) or 'image'), str(text or ''))
    t = _DATA_URL.sub('[file]', t).strip()
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t if len(t) <= n else t[:n].rstrip() + '…'


def _ref(task):
    return '#%s' % task.id


def _code(task):
    return '#%s%s' % (task.id, (' · ' + task.task_code) if task.task_code else '')


# ── recipients ────────────────────────────────────────────────────────────
class _Batch:
    """recipient -> ordered reasons, for one action."""

    ORDER = ('assigned', 'unassigned', 'mentioned', 'closed', 'reopened', 'status', 'comment')

    def __init__(self, task, actor_email, actor_name):
        self.task = task
        self.actor_email = actor_email
        self.actor_name = actor_name
        self.recips = {}
        self.data = {}
        self.body = ''           # excerpt source
        self.body_label = ''

    def add(self, email, reason):
        e = _norm(email)
        if not e or '@' not in e or e == self.actor_email:
            return
        rs = self.recips.setdefault(e, [])
        if reason not in rs:
            rs.append(reason)

    def active_only(self):
        if not self.recips:
            return
        from .models import AppUser
        ok = {_norm(e) for e in AppUser.objects.filter(status='active').filter(
            email__in=list(self.recips)).values_list('email', flat=True)}
        missing = [e for e in self.recips if e not in ok]
        for e in missing:      # case-insensitive fallback
            if not AppUser.objects.filter(status='active', email__iexact=e).exists():
                self.recips.pop(e, None)


def _sentences(b, reasons):
    t, who = b.task, b.actor_name
    title = '“%s”' % (t.title or 'an issue')
    out = []
    for r in _Batch.ORDER:
        if r not in reasons:
            continue
        if r == 'assigned':
            out.append('%s assigned you to %s.' % (who, title))
        elif r == 'unassigned':
            now = b.data.get('new_assignee') or 'someone else'
            out.append('%s reassigned %s to %s; it is no longer assigned to you.' % (who, title, now))
        elif r == 'mentioned':
            out.append('%s mentioned you in %s.' % (who, b.data.get('mention_where') or 'an issue'))
        elif r == 'closed':
            out.append('%s closed %s.' % (who, title))
        elif r == 'reopened':
            out.append('%s reopened %s.' % (who, title))
        elif r == 'status':
            out.append('%s moved %s from %s to %s.' % (who, title, b.data.get('from', ''), b.data.get('to', '')))
        elif r == 'comment':
            out.append('%s commented on %s.' % (who, title))
    return out


def _headline(b, reasons):
    who, ref = b.actor_name, _ref(b.task)
    first = next((r for r in _Batch.ORDER if r in reasons), 'comment')
    return {
        'assigned': '%s assigned you %s' % (who, ref),
        'unassigned': '%s was reassigned' % ref,
        'mentioned': '%s mentioned you in %s' % (who, ref),
        'closed': '%s closed %s' % (who, ref),
        'reopened': '%s reopened %s' % (who, ref),
        'status': '%s moved %s to %s' % (who, ref, b.data.get('to', '')),
        'comment': '%s commented on %s' % (who, ref),
    }[first]


def _why(reasons):
    bits = []
    if 'assigned' in reasons or 'unassigned' in reasons:
        bits.append('you are (or were) the assignee')
    if 'mentioned' in reasons:
        bits.append('you were mentioned')
    if not bits:
        bits.append('you are assigned to or watching this issue')
    return ' and '.join(bits)


# Banner per event: title, subtitle, badge glyph, badge colour, "… By" row.
_HERO = {
    'closed': ('Issue Closed', 'An assigned issue has been successfully closed.', '&#10003;', '#22c55e', 'Closed By'),
    'reopened': ('Issue Reopened', 'A closed issue has been opened again.', '&#8635;', '#f59e0b', 'Reopened By'),
    'assigned': ('Issue Assigned to You', 'You are now the assignee of this issue.', '&#10148;', '#60a5fa', 'Assigned By'),
    'unassigned': ('Issue Reassigned', 'This issue is no longer assigned to you.', '&#8644;', '#94a3b8', 'Reassigned By'),
    'mentioned': ('You Were Mentioned', 'Someone mentioned you in an issue.', '@', '#a78bfa', 'Mentioned By'),
    'status': ('Issue Status Updated', 'An issue you follow has moved to a new status.', '&#8635;', '#38bdf8', 'Updated By'),
    'comment': ('New Comment', 'There is a new comment on an issue you follow.', '&#9993;', '#38bdf8', 'Commented By'),
}
_STAGE_TONE = {'todo': ('gray', '&#9675;'), 'inprogress': ('amber', '&#9680;'), 'review': ('blue', '&#9673;'),
               'done': ('green', '&#10003;')}
_PRIO_TONE = {'urgent': ('red', '&#8593;'), 'high': ('red', '&#8593;'), 'medium': ('amber', '&#8594;'),
              'low': ('gray', '&#8595;')}


def _lead_html(b, reasons):
    """The lead sentence(s), the actor in bold, e.g. **Ann** has closed the issue “x”."""
    esc = html.escape
    t, who = b.task, '<strong>%s</strong>' % esc(b.actor_name or 'Someone')
    title = '“%s”' % esc(t.title or 'an issue')
    out = []
    for r in _Batch.ORDER:
        if r not in reasons:
            continue
        if r == 'assigned':
            out.append('%s assigned you to the issue %s.' % (who, title))
        elif r == 'unassigned':
            now = esc(b.data.get('new_assignee') or 'someone else')
            out.append('%s reassigned the issue %s to %s; it is no longer assigned to you.' % (who, title, now))
        elif r == 'mentioned':
            out.append('%s mentioned you in %s.' % (who, esc(b.data.get('mention_where') or 'an issue')))
        elif r == 'closed':
            out.append('%s has closed the issue %s.' % (who, title))
        elif r == 'reopened':
            out.append('%s has reopened the issue %s.' % (who, title))
        elif r == 'status':
            out.append('%s moved the issue %s from <strong>%s</strong> to <strong>%s</strong>.'
                       % (who, title, esc(b.data.get('from', '')), esc(b.data.get('to', ''))))
        elif r == 'comment' and 'mentioned' not in reasons:   # the mention sentence already says it
            out.append('%s commented on the issue %s.' % (who, title))
    return ' '.join(out)


def _first_name(email):
    try:
        from .models import AppUser
        u = AppUser.objects.filter(email__iexact=email).only('full_name').first()
        name = (u.full_name or '').strip() if u else ''
    except Exception:
        name = ''
    return name.split()[0] if name else ''


def _email(b, to, reasons, base):
    from . import mailer
    t = b.task
    esc = html.escape
    url = (base + ISSUE_PATH % t.id) if base else ''
    sentences = _sentences(b, reasons)
    first = next((r for r in _Batch.ORDER if r in reasons), 'comment')
    hero_title, hero_sub, badge, badge_color, by_label = _HERO[first]
    st = _stage(t.stage)
    stage = STAGE_LABEL.get(st, t.stage or '')
    s_tone, s_icon = _STAGE_TONE.get(st, ('gray', ''))
    prio = (t.priority or '').strip().lower()
    p_tone, p_icon = _PRIO_TONE.get(prio, ('gray', ''))
    due = t.due or (t.target_date.isoformat() if getattr(t, 'target_date', None) else '')
    project = t.project.name if t.project_id and t.project else ''
    details = [
        ('&#9776;', 'Issue', esc(_code(t))),
        ('&#9998;', 'Title', esc(t.title or '')),
        ('&#9634;', 'Project', mailer.render_pill(esc(project), 'sky') if project else ''),
        ('&#10003;', 'Status', mailer.render_pill((s_icon + ' ' if s_icon else '') + esc(stage), s_tone) if stage else ''),
        ('&#8593;', 'Priority', mailer.render_pill((p_icon + ' ' if p_icon else '') + esc(prio.capitalize()), p_tone) if prio else ''),
        ('&#9719;', 'Due', esc(due)),
        ('&#9787;', 'Assignee', esc(t.assignee or t.assignee_email or '')),
        ('&#8618;', by_label, esc(b.actor_name or '')),
    ]
    extra = ''
    ex = excerpt(b.body)
    if ex:
        extra = (
            '<div style="font-size:12px;font-weight:700;letter-spacing:0.8px;color:#64748b;text-transform:uppercase;'
            'margin:0 0 6px;">%s</div>'
            '<div style="border-left:3px solid #cbd5e1;background:#f8fafc;border-radius:0 8px 8px 0;padding:12px 16px;'
            'margin:0 0 24px;color:#334155;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;">%s</div>'
        ) % (esc(b.body_label or 'Excerpt'), esc(ex).replace('\n', '<br>'))
    if not url:
        extra += ('<p style="font-size:13px;color:#475569;margin:0 0 18px;text-align:center;">Open HRMS &rsaquo; '
                  'Task Tracker and search for <strong>%s</strong>.</p>' % esc(_ref(t)))
    name = _first_name(to)
    reason_html = ('You are receiving this email because %s. To stop these emails, update your notification '
                   'preferences in HRMS (%s).') % (esc(_why(reasons)),
                   ('<a href="%s/settings" style="color:#334155;">Settings &rsaquo; Notifications</a>' % esc(base))
                   if base else 'Settings &rsaquo; Notifications')
    page = mailer.render_notification(
        title=hero_title, subtitle=hero_sub, badge=badge, badge_color=badge_color,
        greeting='Hi %s,' % esc(name or 'there'), lead_html=_lead_html(b, reasons),
        details_title='Issue Details', details=details, extra_html=extra,
        cta_url=esc(url), cta_label='View Issue %s' % esc(_ref(t)), reason_html=reason_html, base_url=base)
    headline = _headline(b, reasons)
    subject = ('%s: %s' % (headline, t.title or ''))[:180]
    text = '\n'.join(['%s — %s' % (hero_title, hero_sub), ''] + sentences + ([''] + [ex] if ex else []) +
                     ([''] + [url] if url else []))
    return {'to': to, 'subject': subject, 'html': page, 'text': text}


# ── delivery ──────────────────────────────────────────────────────────────
def _send_all(messages):
    from . import mailer
    for m in messages:
        try:
            res = mailer.send_email(m['to'], m['subject'], html=m['html'], text=m['text'])
            if not (isinstance(res, dict) and res.get('ok')):
                logger.warning('Task email to %s failed: %s', m['to'],
                               (res or {}).get('error') if isinstance(res, dict) else res)
        except Exception:
            logger.exception('Task email to %s failed', m.get('to'))


def _run_safely(messages):
    try:
        _send_all(messages)
    except Exception:
        logger.exception('Task email batch failed')
    finally:
        if RUN_ASYNC:
            close_old_connections()


def _dispatch(messages):
    if not messages:
        return

    def go():
        if RUN_ASYNC:
            threading.Thread(target=_run_safely, args=(messages,), daemon=True, name='task-mail').start()
        else:
            _run_safely(messages)
    transaction.on_commit(go)


def _deliver(b, request=None):
    """One in-app notification and (if allowed) one email per recipient."""
    if not b.recips:
        return {}
    b.active_only()
    if not b.recips:
        return {}
    from .views import create_notification
    from .notification_prefs import allows
    base = public_base(request)
    link = ISSUE_PATH % b.task.id
    emails = []
    for to, reasons in b.recips.items():
        try:
            headline = _headline(b, reasons)
            msg = ' '.join(_sentences(b, reasons))
            ex = excerpt(b.body, 120)
            if ex:
                msg += ' “%s”' % ex.replace('\n', ' ')
            create_notification(to, headline[:255], msg, 'info', link, category=CATEGORY_INAPP)
        except Exception:
            logger.exception('Task in-app notification to %s failed', to)
        try:
            if allows(to, CATEGORY_EMAIL):
                emails.append(_email(b, to, reasons, base))
        except Exception:
            logger.exception('Task email to %s could not be prepared', to)
    _dispatch(emails)
    return dict(b.recips)


# ── public entry points ───────────────────────────────────────────────────
def task_created(request, task):
    try:
        email, name = _actor(request)
        b = _Batch(task, email, name)
        b.body, b.body_label = task.description or '', 'Description'
        if task.assignee_email:
            b.add(task.assignee_email, 'assigned')
        for m in resolve_mentions('%s\n%s' % (task.title or '', task.description or '')):
            b.add(m, 'mentioned')
        b.data['mention_where'] = 'the issue “%s”' % (task.title or '')
        return _deliver(b, request)
    except Exception:
        logger.exception('task_created notifications failed for task %s', getattr(task, 'id', None))
        return {}


def task_updated(request, task, before):
    try:
        email, name = _actor(request)
        b = _Batch(task, email, name)
        old_a, new_a = _norm(before.get('assignee_email')), _norm(task.assignee_email)
        if new_a != old_a:
            if new_a:
                b.add(new_a, 'assigned')
            if old_a:
                b.data['new_assignee'] = task.assignee or new_a or 'nobody'
                b.add(old_a, 'unassigned')
        old_s, new_s = _stage(before.get('stage')), _stage(task.stage)
        if old_s != new_s:
            reason = 'closed' if new_s == 'done' else ('reopened' if old_s == 'done' else 'status')
            b.data['from'], b.data['to'] = STAGE_LABEL.get(old_s, old_s), STAGE_LABEL.get(new_s, new_s)
            for w in ({new_a} if new_a else set()) | watchers_of(task):
                b.add(w, reason)
        old_text = '%s\n%s' % (before.get('title') or '', before.get('description') or '')
        new_text = '%s\n%s' % (task.title or '', task.description or '')
        if new_text != old_text:
            fresh = new_mentions(old_text, new_text)
            for m in fresh:
                b.add(m, 'mentioned')
            if fresh:
                b.data['mention_where'] = 'the issue “%s”' % (task.title or '')
                b.body, b.body_label = task.description or '', 'Description'
        if not b.body and 'assigned' in sum(b.recips.values(), []):
            b.body, b.body_label = task.description or '', 'Description'
        return _deliver(b, request)
    except Exception:
        logger.exception('task_updated notifications failed for task %s', getattr(task, 'id', None))
        return {}


def comment_added(request, task, comment):
    try:
        if (comment.comment_type or 'comment') != 'comment':
            return {}
        email, name = _actor(request)
        if not email:
            email = _norm(comment.author_email)
            name = comment.author_name or email
        b = _Batch(task, email, name)
        b.body, b.body_label = comment.body or '', 'Comment'
        for w in ({_norm(task.assignee_email)} if task.assignee_email else set()) | watchers_of(task):
            b.add(w, 'comment')
        for m in resolve_mentions(comment.body):
            b.add(m, 'mentioned')
        b.data['mention_where'] = 'a comment on “%s”' % (task.title or '')
        return _deliver(b, request)
    except Exception:
        logger.exception('comment_added notifications failed for task %s', getattr(task, 'id', None))
        return {}


def comment_edited(request, task, comment, old_body):
    try:
        email, name = _actor(request)
        b = _Batch(task, email or _norm(comment.author_email), name)
        b.body, b.body_label = comment.body or '', 'Comment'
        for m in new_mentions(old_body, comment.body):
            b.add(m, 'mentioned')
        b.data['mention_where'] = 'a comment on “%s”' % (task.title or '')
        return _deliver(b, request)
    except Exception:
        logger.exception('comment_edited notifications failed for task %s', getattr(task, 'id', None))
        return {}
