"""Goals & OKRs: the rules (progress maths, roll-up, permissions, visibility,
periods, check-ins, reminders, the weekly digest, copy-forward).

Cascade: company -> department -> team -> individual. An objective may be
aligned (``parent``) under any *visible* objective of a strictly higher level
in the same period, so the tree can never form a cycle.

Progress
    * percent / number / currency KR: (current - start) / (target - start),
      clamped to 0-100. A decreasing target (target < start, e.g. "cut churn
      from 8 to 3") works with the same formula. target == start is a
      "hold the line" KR: 100 while current >= target.
    * boolean KR: 0 or 100 (current >= 1 means done).
    * milestone KR: with linked tasks (api.EmployeeTask) it is the share of
      linked tasks whose stage is 'done' (current/target become done/total);
      without links it counts steps: current = steps done, target = steps.
    * objective: weighted average of its KRs (weight <= 0 counts as 0; all
      zero -> plain average); an objective with no KRs averages its
      non-cancelled children. Every KR edit / check-in / task change /
      alignment change re-computes up the whole parent chain.
    * status: an 'active' objective becomes 'completed' when its progress
      crosses into 100. Re-opening one at 100% sticks (only a crossing
      completes it again).

Task links of a milestone KR are stored as OkrCheckIn rows whose ``week`` is
LINK_WEEK ('TASK') and ``value`` the task id: models are frozen, KeyResult
has no JSON field, and these rows stay private to the OKR tables (cascade
with the KR) — unlike api.MasterDataSet, which the Form Builder lists and
lets anyone edit. Every check-in query excludes them.
"""
import re
from datetime import date, datetime, timedelta

from django.db import transaction
from django.db.models import Q
from django.db.models.signals import post_delete, post_save

from api.models import AppUser, EmployeeTask, Notification, Team, TeamMembership, UserProfile
from api.permissions import _CACHE as _PERM_CACHE, _get_caller, _is_super_admin, _user_has_perm
from api.timeutil import local_now

from .models import KeyResult, Objective, OkrCheckIn

PERM = 'okr.manage'
LEVELS = tuple(Objective.LEVELS)
RANK = {lvl: i for i, lvl in enumerate(LEVELS)}
METRICS = tuple(KeyResult.METRICS)
STATUSES = tuple(Objective.STATUSES)
VISIBILITIES = ('public', 'team', 'private')
LINK_WEEK = 'TASK'
AT_RISK_CONFIDENCE = 4        # confidence <= this is at risk
BEHIND_TOLERANCE = 15.0       # points behind the elapsed-time line before "behind schedule"
PERIOD_RE = re.compile(r'^(\d{4})-Q([1-4])$')
REMINDER_TITLE = 'OKR check-in due'
REMINDER_LINK = '/hr/perform/check-ins'


def norm(v):
    return str(v or '').strip().lower()


def today():
    return local_now().date()


# ---------------------------------------------------------------------------
# periods & weeks
# ---------------------------------------------------------------------------
def period_of(d):
    return f'{d.year}-Q{(d.month - 1) // 3 + 1}'


def current_period():
    return period_of(today())


def valid_period(p):
    return bool(PERIOD_RE.match(str(p or '')))


def period_bounds(p):
    m = PERIOD_RE.match(p)
    y, q = int(m.group(1)), int(m.group(2))
    start = date(y, 3 * (q - 1) + 1, 1)
    end = date(y + (1 if q == 4 else 0), (3 * q) % 12 + 1, 1) - timedelta(days=1)
    return start, end


def shift_period(p, n):
    m = PERIOD_RE.match(p)
    idx = int(m.group(1)) * 4 + int(m.group(2)) - 1 + n
    return f'{idx // 4}-Q{idx % 4 + 1}'


def period_choices():
    cur = current_period()
    out = {shift_period(cur, n) for n in (-2, -1, 0, 1, 2)}
    out |= set(Objective.objects.values_list('period', flat=True).distinct())
    return sorted((p for p in out if valid_period(p)), reverse=True)


def iso_week(d=None):
    d = d or today()
    if isinstance(d, datetime):
        d = d.date()
    y, w, _ = d.isocalendar()
    return f'{y}-W{w:02d}'


def elapsed_pct(period, d=None, due=None):
    """How far through the KR's window we are (0-100): period start to its due
    date (or the period end)."""
    d = d or today()
    start, end = period_bounds(period)
    if due and due >= start:
        end = due
    if d <= start:
        return 0.0
    if d >= end:
        return 100.0
    return round((d - start).days * 100.0 / max(1, (end - start).days), 1)


# ---------------------------------------------------------------------------
# progress maths
# ---------------------------------------------------------------------------
def _clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, v))


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def ratio_progress(start, target, current):
    start, target, current = _f(start), _f(target), _f(current)
    if target == start:
        return 100.0 if current >= target else 0.0
    return round(_clamp((current - start) / (target - start) * 100.0), 2)


def linked_task_ids(kr):
    if not kr.pk:
        return []
    vals = OkrCheckIn.objects.filter(key_result=kr, week=LINK_WEEK).values_list('value', flat=True)
    return sorted({int(v) for v in vals})


def task_completion(ids):
    """(done, total) over the linked tasks that still exist."""
    qs = EmployeeTask.objects.filter(id__in=list(ids))
    total = qs.count()
    done = qs.filter(stage='done').count()
    return done, total


def kr_progress(kr, task_ids=None):
    if kr.metric == 'boolean':
        return 100.0 if _f(kr.current_value) >= 1 else 0.0
    if kr.metric == 'milestone':
        ids = linked_task_ids(kr) if task_ids is None else task_ids
        if ids:
            done, total = task_completion(ids)
            if total:
                return round(done * 100.0 / total, 2)
    return ratio_progress(kr.start_value, kr.target_value, kr.current_value)


def weighted_average(pairs):
    pairs = [(_f(p), _f(w, 1.0)) for p, w in pairs]
    if not pairs:
        return None
    total_w = sum(max(0.0, w) for _, w in pairs)
    if total_w <= 0:
        return sum(p for p, _ in pairs) / len(pairs)
    return sum(p * max(0.0, w) for p, w in pairs) / total_w


def objective_progress(obj):
    krs = list(KeyResult.objects.filter(objective=obj).values_list('progress', 'weight'))
    if krs:
        return round(weighted_average(krs), 2)
    kids = list(Objective.objects.filter(parent=obj).exclude(status='cancelled').values_list('progress', flat=True))
    if kids:
        return round(sum(kids) / len(kids), 2)
    return 0.0


def _apply_objective_progress(obj, new):
    old = obj.progress or 0.0
    fields = []
    if abs(new - old) > 1e-9:
        obj.progress = new
        fields.append('progress')
    if new >= 100 and old < 100 and obj.status == 'active':
        obj.status = 'completed'
        fields.append('status')
    if fields:
        obj.save(update_fields=fields + ['updated_at'])


def recalc_kr(kr, save=True):
    """Re-derive one KR's progress (and, for task-linked milestones, its
    current/target from the tasks). Returns True when something changed."""
    changed = []
    if kr.metric == 'milestone':
        ids = linked_task_ids(kr)
        if ids:
            done, total = task_completion(ids)
            if total and (kr.current_value != done or kr.target_value != total or kr.start_value != 0):
                kr.current_value, kr.target_value, kr.start_value = float(done), float(total), 0.0
                changed += ['current_value', 'target_value', 'start_value']
    p = kr_progress(kr)
    if abs((kr.progress or 0) - p) > 1e-9:
        kr.progress = p
        changed.append('progress')
    if changed and save and kr.pk:
        kr.save(update_fields=changed + ['updated_at'])
    return bool(changed)


def rollup(obj):
    """Recompute ``obj`` and every ancestor."""
    seen = set()
    while obj is not None and obj.pk not in seen:
        seen.add(obj.pk)
        _apply_objective_progress(obj, objective_progress(obj))
        obj = Objective.objects.filter(pk=obj.parent_id).first() if obj.parent_id else None


def refresh_milestones(objective_ids=None):
    """Bring task-linked milestone KRs up to date (tasks change on the task
    board, outside this module). Returns the number of KRs that moved."""
    links = OkrCheckIn.objects.filter(week=LINK_WEEK, key_result__metric='milestone')
    if objective_ids is not None:
        links = links.filter(key_result__objective_id__in=list(objective_ids))
    kr_ids = set(links.values_list('key_result_id', flat=True))
    moved = 0
    for kr in KeyResult.objects.filter(id__in=kr_ids).select_related('objective'):
        if recalc_kr(kr):
            moved += 1
            rollup(kr.objective)
    return moved


def _on_task_change(sender, instance, **kwargs):
    try:
        kr_ids = set(OkrCheckIn.objects.filter(week=LINK_WEEK, value=float(instance.pk))
                     .values_list('key_result_id', flat=True))
        for kr in KeyResult.objects.filter(id__in=kr_ids, metric='milestone').select_related('objective'):
            if recalc_kr(kr):
                rollup(kr.objective)
    except Exception:       # a goal roll-up must never break saving a task
        pass


post_save.connect(_on_task_change, sender=EmployeeTask, dispatch_uid='okr_task_saved')
post_delete.connect(_on_task_change, sender=EmployeeTask, dispatch_uid='okr_task_deleted')


# ---------------------------------------------------------------------------
# who is who
# ---------------------------------------------------------------------------
class Ctx:
    """The caller plus lazily loaded org data used by the permission rules."""

    def __init__(self, email, user):
        self.email = norm(email)
        self.user = user
        self.admin = bool(user) and (_is_super_admin(user) or _user_has_perm(user, PERM))
        self._profiles = self._accounts = self._teams = self._members = None
        self._kr_owned = None

    @classmethod
    def from_request(cls, request):
        _PERM_CACHE.clear()
        email, user = _get_caller(request)
        if not email or not user or (user.status or 'active') != 'active':
            return None
        return cls(email, user)

    # org maps --------------------------------------------------------------
    @property
    def profiles(self):
        if self._profiles is None:
            self._profiles = {norm(p.email): p for p in UserProfile.objects.all()}
        return self._profiles

    @property
    def accounts(self):
        if self._accounts is None:
            self._accounts = {norm(u.email): u for u in AppUser.objects.all()}
        return self._accounts

    @property
    def teams(self):
        if self._teams is None:
            self._teams = {t.id: t for t in Team.objects.all()}
        return self._teams

    @property
    def members(self):
        if self._members is None:
            self._members = {}
            for tid, e in TeamMembership.objects.values_list('team_id', 'email'):
                self._members.setdefault(tid, set()).add(norm(e))
        return self._members

    def manager_of(self, email):
        p = self.profiles.get(norm(email))
        return norm(p.manager_email) if p else ''

    def dept_of(self, email):
        p = self.profiles.get(norm(email))
        return (p.department or '').strip() if p else ''

    def chain(self, email):
        out, seen, cur = [], {norm(email)}, norm(email)
        for _ in range(50):
            nxt = self.manager_of(cur)
            if not nxt or nxt in seen:
                break
            out.append(nxt)
            seen.add(nxt)
            cur = nxt
        return out

    def reports_tree(self, email):
        email = norm(email)
        under = {}
        for e, p in self.profiles.items():
            m = norm(p.manager_email)
            if m and m != e:
                under.setdefault(m, []).append(e)
        seen, queue = set(), list(under.get(email, []))
        while queue and len(seen) < 5000:
            e = queue.pop()
            if e in seen or e == email:
                continue
            seen.add(e)
            queue.extend(under.get(e, []))
        return seen

    def direct_reports(self, email):
        email = norm(email)
        return sorted(e for e, p in self.profiles.items() if norm(p.manager_email) == email and e != email)

    def team_lead(self, team_id):
        t = self.teams.get(team_id) if team_id else None
        return norm(t.lead_email) if t else ''

    def team_people(self, team_id):
        out = set(self.members.get(team_id, set()))
        lead = self.team_lead(team_id)
        if lead:
            out.add(lead)
        return out

    def teams_of(self, email):
        email = norm(email)
        return {tid for tid in self.teams if email in self.team_people(tid)}

    def led_teams(self, email=None):
        email = norm(email or self.email)
        return {tid for tid in self.teams if self.team_lead(tid) == email or
                (self.team_lead(tid) and self.manager_of(self.team_lead(tid)) == email)}

    def known(self, email):
        email = norm(email)
        return bool(email) and (email in self.accounts or email in self.profiles)

    def name(self, email):
        email = norm(email)
        if not email:
            return ''
        p, u = self.profiles.get(email), self.accounts.get(email)
        return ((f'{p.first_name} {p.last_name}'.strip() if p else '') or (u.full_name if u else '')
                or email.split('@')[0])

    @property
    def kr_owned(self):
        """Objective ids where the caller owns a key result."""
        if self._kr_owned is None:
            self._kr_owned = set(KeyResult.objects.filter(owner_email__iexact=self.email)
                                 .values_list('objective_id', flat=True))
        return self._kr_owned


# ---------------------------------------------------------------------------
# permissions
# ---------------------------------------------------------------------------
def can_edit(ctx, o):
    """Create / edit / delete an objective (and its KRs). ``o`` may be an
    unsaved Objective (the rules are evaluated on the would-be state)."""
    if ctx.admin:
        return True
    if o.level in ('company', 'department'):
        return False
    if o.level == 'team':
        lead = ctx.team_lead(o.team_id)
        return bool(lead) and ctx.email in (lead, ctx.manager_of(lead))
    owner = norm(o.owner_email)
    return bool(owner) and (ctx.email == owner or ctx.manager_of(owner) == ctx.email)


def can_check_in(ctx, kr, obj=None):
    obj = obj or kr.objective
    return ctx.email in (norm(kr.owner_email), norm(obj.owner_email)) or can_edit(ctx, obj)


def can_view(ctx, o):
    if ctx.admin or o.visibility == 'public':
        return True
    owner = norm(o.owner_email)
    if ctx.email == owner or (owner and ctx.manager_of(owner) == ctx.email):
        return True
    if o.pk and o.pk in ctx.kr_owned:
        return True
    if can_edit(ctx, o):
        return True
    if o.visibility == 'private':
        return False
    # 'team': the owner's circle
    if ctx.email in ctx.chain(owner):
        return True
    if o.team_id and ctx.email in ctx.team_people(o.team_id):
        return True
    mine = ctx.dept_of(ctx.email).lower()
    if mine and o.department and o.department.strip().lower() == mine:
        return True
    my_mgr = ctx.manager_of(ctx.email)
    if my_mgr and (my_mgr == owner or my_mgr == ctx.manager_of(owner)):
        return True
    if ctx.teams_of(ctx.email) & ctx.teams_of(owner):
        return True
    return False


def can_see_person(ctx, email):
    """May the caller read ``email``'s OKR summary (My Team, digest)?"""
    email = norm(email)
    if ctx.admin or email == ctx.email:
        return True
    if ctx.email in ctx.chain(email):
        return True
    return any(email in ctx.team_people(t) for t in ctx.led_teams())


# ---------------------------------------------------------------------------
# check-ins
# ---------------------------------------------------------------------------
def real_check_ins(kr_or_qs=None):
    qs = OkrCheckIn.objects.exclude(week=LINK_WEEK)
    if isinstance(kr_or_qs, KeyResult):
        qs = qs.filter(key_result=kr_or_qs)
    return qs


@transaction.atomic
def record_check_in(ctx_email, kr, value=None, confidence=None, note='', when=None):
    """One check-in per KR per ISO week: a second one in the same week updates
    the first. Returns (check_in, created)."""
    kr = KeyResult.objects.select_for_update().select_related('objective').get(pk=kr.pk)
    when = when or local_now()
    week = iso_week(when)
    linked = kr.metric == 'milestone' and linked_task_ids(kr)
    if not linked:
        if value is None or value == '':
            raise ValueError('A value is required.')
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise ValueError('The value must be a number.')
        if kr.metric == 'boolean':
            value = 1.0 if value >= 1 else 0.0
        kr.current_value = value
    if confidence not in (None, ''):
        try:
            c = int(confidence)
        except (TypeError, ValueError):
            raise ValueError('Confidence must be 1-10.')
        if not 1 <= c <= 10:
            raise ValueError('Confidence must be 1-10.')
        kr.confidence = c
    kr.save(update_fields=['current_value', 'confidence', 'updated_at'])
    recalc_kr(kr)
    ci = real_check_ins(kr).filter(week=week).first()
    created = ci is None
    if created:
        ci = OkrCheckIn(key_result=kr, week=week)
    ci.author_email = norm(ctx_email)
    ci.value = kr.current_value
    ci.progress = kr.progress
    ci.confidence = kr.confidence
    ci.note = str(note or '')[:4000]
    ci.created_at = when
    ci.save()
    rollup(kr.objective)
    return ci, created


def due_key_results(email, period=None, week=None):
    """KRs ``email`` should update this week: theirs (or, unowned, on their
    objective), on an active objective of the period, not yet 100%, with no
    check-in this ISO week."""
    email = norm(email)
    period = period or current_period()
    week = week or iso_week()
    qs = (KeyResult.objects.select_related('objective')
          .filter(objective__period=period, objective__status='active', progress__lt=100)
          .filter(Q(owner_email__iexact=email) | (Q(owner_email='') & Q(objective__owner_email__iexact=email))))
    done = set(real_check_ins().filter(week=week, key_result__in=qs).values_list('key_result_id', flat=True))
    return [k for k in qs if k.pk not in done]


def _kr_responsible(kr):
    return norm(kr.owner_email) or norm(kr.objective.owner_email)


def send_checkin_reminders(when=None):
    """The Monday nudge: one in-app notification per person per ISO week.
    Returns the list of recipients notified."""
    d = when or today()
    week, period = iso_week(d), period_of(d)
    link = f'{REMINDER_LINK}?week={week}'
    krs = (KeyResult.objects.select_related('objective')
           .filter(objective__period=period, objective__status='active', progress__lt=100))
    done = set(real_check_ins().filter(week=week, key_result__in=krs).values_list('key_result_id', flat=True))
    by_person = {}
    for kr in krs:
        if kr.pk not in done:
            who = _kr_responsible(kr)
            if who:
                by_person.setdefault(who, []).append(kr)
    active = {norm(e) for e in AppUser.objects.filter(status='active').values_list('email', flat=True)}
    already = set(Notification.objects.filter(title=REMINDER_TITLE, link=link).values_list('recipient', flat=True))
    sent = []
    for email, items in sorted(by_person.items()):
        if email not in active or email in already:
            continue
        titles = ', '.join(k.title for k in items[:3]) + (f' and {len(items) - 3} more' if len(items) > 3 else '')
        Notification.objects.create(
            recipient=email, title=REMINDER_TITLE, notification_type='info', link=link,
            message=f'{len(items)} key result{"s" if len(items) != 1 else ""} to update this week ({week}): {titles}.')
        sent.append(email)
    return sent


_LAZY = {'week': None}


def maybe_remind_lazily():
    """Called when someone opens Goals: runs the week's reminder pass once per
    process per week, so reminders still go out where cron is not set up."""
    week = iso_week()
    if _LAZY['week'] == week:
        return
    _LAZY['week'] = week
    try:
        send_checkin_reminders()
    except Exception:
        _LAZY['week'] = None


# ---------------------------------------------------------------------------
# risk & history
# ---------------------------------------------------------------------------
def risk_reason(kr, period, d=None):
    if (kr.progress or 0) >= 100:
        return ''
    if (kr.confidence or 0) <= AT_RISK_CONFIDENCE:
        return f'low confidence ({kr.confidence}/10)'
    expected = elapsed_pct(period, d, kr.due_date)
    if (kr.progress or 0) + BEHIND_TOLERANCE < expected:
        return f'behind schedule ({round(kr.progress or 0)}% vs {round(expected)}% of time elapsed)'
    return ''


def kr_progress_as_of(kr, when):
    if kr.created_at and kr.created_at > when:
        return None
    ci = real_check_ins(kr).filter(created_at__lte=when).order_by('-created_at').first()
    if ci:
        return ci.progress
    if not real_check_ins(kr).exists():
        return kr.progress or 0.0          # never checked in: no known movement
    return ratio_progress(kr.start_value, kr.target_value, kr.start_value)


def objective_progress_as_of(obj, when, _depth=0):
    if obj.created_at and obj.created_at > when:
        return None
    pairs = [(p, k.weight) for k in obj.key_results.all() for p in [kr_progress_as_of(k, when)] if p is not None]
    if pairs:
        return round(weighted_average(pairs), 2)
    if obj.key_results.exists():
        return 0.0
    if _depth > 6:
        return obj.progress or 0.0
    kids = [objective_progress_as_of(c, when, _depth + 1) for c in obj.children.exclude(status='cancelled')]
    kids = [k for k in kids if k is not None]
    return round(sum(kids) / len(kids), 2) if kids else 0.0


# ---------------------------------------------------------------------------
# weekly digest for managers / department heads
# ---------------------------------------------------------------------------
def digest_recipients(ctx, period):
    """Managers (anyone with reports), team leads and owners of department
    objectives this period."""
    out = {norm(p.manager_email) for p in ctx.profiles.values() if norm(p.manager_email)}
    out |= {ctx.team_lead(t) for t in ctx.teams if ctx.team_lead(t)}
    out |= {norm(e) for e in Objective.objects.filter(period=period, level='department')
            .values_list('owner_email', flat=True)}
    active = {norm(e) for e in AppUser.objects.filter(status='active').values_list('email', flat=True)}
    return sorted(e for e in out if e in active)


def digest_scope(ctx, manager):
    manager = norm(manager)
    people = set(ctx.reports_tree(manager))
    teams = {t for t in ctx.teams if ctx.team_lead(t) == manager}
    for t in teams:
        people |= ctx.team_people(t)
    depts = set(Objective.objects.filter(level='department', owner_email__iexact=manager)
                .exclude(department='').values_list('department', flat=True))
    if depts:
        low = {d.strip().lower() for d in depts}
        people |= {e for e, p in ctx.profiles.items() if (p.department or '').strip().lower() in low}
    people.discard(manager)
    return people, teams, depts


def build_digest(manager, period=None, when=None, ctx=None):
    ctx = ctx or Ctx(manager, AppUser.objects.filter(email__iexact=norm(manager)).first())
    when = when or local_now()
    d = when.date() if isinstance(when, datetime) else when
    period = period or period_of(d)
    people, teams, depts = digest_scope(ctx, manager)
    q = Q(owner_email__in=people) | Q(team_id__in=teams)
    if depts:
        q |= Q(level='department', department__in=depts)
    objs = list(Objective.objects.filter(period=period, status__in=('active', 'completed')).filter(q)
                .order_by('level', 'title'))
    week_ago = datetime.combine(d, datetime.min.time()) - timedelta(days=7) if not isinstance(when, datetime) \
        else when - timedelta(days=7)
    rows, risks = [], []
    for o in objs:
        before = objective_progress_as_of(o, week_ago)
        rows.append({'id': o.pk, 'title': o.title, 'level': o.level, 'owner': norm(o.owner_email),
                     'ownerName': ctx.name(o.owner_email), 'progress': round(o.progress or 0, 1),
                     'delta': None if before is None else round((o.progress or 0) - before, 1),
                     'status': o.status})
        for kr in o.key_results.all():
            why = risk_reason(kr, period, d)
            if why:
                risks.append({'objective': o.title, 'objectiveId': o.pk, 'kr': kr.title, 'krId': kr.pk,
                              'owner': _kr_responsible(kr), 'ownerName': ctx.name(_kr_responsible(kr)),
                              'progress': round(kr.progress or 0, 1), 'confidence': kr.confidence,
                              'reason': why})
    avg = round(sum(r['progress'] for r in rows) / len(rows), 1) if rows else 0.0
    return {'manager': norm(manager), 'managerName': ctx.name(manager), 'period': period, 'week': iso_week(d),
            'objectives': rows, 'atRisk': risks, 'avgProgress': avg, 'people': len(people)}


def render_digest(digest, origin=''):
    from html import escape as h

    from api.mailer import render_branded
    rows = ''.join(
        f'<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0">{h(r["title"])}'
        f'<div style="color:#64748b;font-size:12px">{h(r["level"].title())} · {h(r["ownerName"])}</div></td>'
        f'<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">'
        f'{r["progress"]:.0f}%</td>'
        f'<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;'
        f'color:{"#16a34a" if (r["delta"] or 0) > 0 else ("#dc2626" if (r["delta"] or 0) < 0 else "#64748b")}">'
        f'{"new" if r["delta"] is None else ("%+.0f" % r["delta"])}</td></tr>'
        for r in digest['objectives'])
    table = ('<table style="width:100%;border-collapse:collapse;font-size:14px">'
             '<tr><th style="text-align:left;padding:6px 8px">Objective</th>'
             '<th style="text-align:right;padding:6px 8px">Progress</th>'
             '<th style="text-align:right;padding:6px 8px">7-day</th></tr>' + rows + '</table>')
    risk = ''
    if digest['atRisk']:
        risk = ('<h3 style="margin:18px 0 6px;font-size:15px;color:#b45309">At-risk key results</h3><ul style="padding-left:18px">'
                + ''.join(f'<li style="margin:4px 0"><b>{h(r["kr"])}</b> — {h(r["objective"])} '
                          f'({h(r["ownerName"])}): {h(r["reason"])}</li>' for r in digest['atRisk']) + '</ul>')
    link = f'{origin.rstrip("/")}/hr/perform/team' if origin else ''
    cta = (f'<p style="margin-top:18px"><a href="{h(link)}" style="background:#0f9d58;color:#fff;padding:9px 16px;'
           f'border-radius:6px;text-decoration:none">Open team goals</a></p>') if link else ''
    intro = (f'Here is how your teams\' goals moved this week ({digest["week"]}, {digest["period"]}): '
             f'{len(digest["objectives"])} objective(s), average progress {digest["avgProgress"]:.0f}%, '
             f'{len(digest["atRisk"])} key result(s) at risk.')
    html = render_branded('Weekly OKR digest', intro, table + risk + cta,
                          greeting=f'Hi {digest["managerName"] or "there"},')
    text_lines = [intro, ''] + [f'- {r["title"]} ({r["ownerName"]}): {r["progress"]:.0f}% '
                                f'({"new" if r["delta"] is None else "%+.0f" % r["delta"]})'
                                for r in digest['objectives']]
    if digest['atRisk']:
        text_lines += ['', 'At risk:'] + [f'- {r["kr"]} — {r["objective"]}: {r["reason"]}' for r in digest['atRisk']]
    subject = f'Weekly OKR digest · {digest["period"]} · {len(digest["atRisk"])} at risk'
    return subject, html, '\n'.join(text_lines)


def send_weekly_digests(period=None, when=None, only=None, dry_run=False, origin=''):
    """Email each manager / department head a digest of their teams' OKRs.
    Returns [{'to', 'objectives', 'atRisk', 'ok', 'error'}]."""
    from api.mailer import send_email
    when = when or local_now()
    d = when.date() if isinstance(when, datetime) else when
    period = period or period_of(d)
    ctx = Ctx('', None)
    out = []
    targets = [norm(only)] if only else digest_recipients(ctx, period)
    for manager in targets:
        dg = build_digest(manager, period, when, ctx=ctx)
        if not dg['objectives']:
            continue
        row = {'to': manager, 'objectives': len(dg['objectives']), 'atRisk': len(dg['atRisk']), 'ok': True, 'error': ''}
        if not dry_run:
            subject, html, text = render_digest(dg, origin)
            try:
                res = send_email(manager, subject, html=html, text=text) or {}
            except Exception as exc:     # one bad mailbox must not stop the run
                res = {'ok': False, 'error': str(exc)}
            row['ok'] = bool(res.get('ok'))
            row['error'] = res.get('error', '') or ''
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# copy unfinished to the next quarter
# ---------------------------------------------------------------------------
@transaction.atomic
def copy_unfinished(ctx, period, ids=None):
    nxt = shift_period(period, 1)
    qs = Objective.objects.filter(period=period, progress__lt=100).exclude(status__in=('completed', 'cancelled'))
    if ids:
        qs = qs.filter(pk__in=ids)
    objs = sorted((o for o in qs if can_edit(ctx, o)), key=lambda o: (RANK.get(o.level, 9), o.pk))
    mapping, created, skipped = {}, [], []
    for o in objs:
        dup = Objective.objects.filter(period=nxt, level=o.level, owner_email=o.owner_email, title=o.title).first()
        if dup:
            mapping[o.pk] = dup
            skipped.append(o.pk)
            continue
        parent = mapping.get(o.parent_id)
        new = Objective.objects.create(
            period=nxt, level=o.level, title=o.title, description=o.description, owner_email=o.owner_email,
            department=o.department, team_id=o.team_id, parent=parent, status='active',
            visibility=o.visibility, created_by=ctx.email)
        for kr in o.key_results.filter(progress__lt=100):
            links = linked_task_ids(kr)
            nk = KeyResult.objects.create(
                objective=new, title=kr.title, metric=kr.metric, start_value=kr.start_value,
                target_value=kr.target_value, current_value=kr.current_value, unit=kr.unit,
                owner_email=kr.owner_email, due_date=None, weight=kr.weight, confidence=kr.confidence)
            for tid in links:
                OkrCheckIn.objects.create(key_result=nk, author_email=ctx.email, value=tid, week=LINK_WEEK)
            recalc_kr(nk)
        mapping[o.pk] = new
        created.append(new)
    for new in created:
        rollup(new)
    return nxt, created, skipped
