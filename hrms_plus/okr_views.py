"""Goals & OKRs API (rules live in hrms_plus/okr.py; routes in urls_okr.py).

    GET          /api/okr/meta                      periods, levels, my teams, reports, canManage
    GET/POST     /api/okr/objectives                list (?tree=1 nested) / create
    GET/PATCH/DELETE /api/okr/objectives/<id>       detail (KRs, history, breadcrumb) / edit / delete
    POST         /api/okr/objectives/<id>/key-results
    PATCH/DELETE /api/okr/key-results/<id>
    GET/POST     /api/okr/key-results/<id>/check-ins  history / weekly check-in (upsert per ISO week)
    GET/PUT      /api/okr/key-results/<id>/tasks      milestone task links
    GET          /api/okr/tasks?q=&kr=              tasks the caller may link
    GET          /api/okr/alignment-options?level=&period=&exclude=
    GET          /api/okr/check-ins/due             this week's due list for the caller
    GET          /api/okr/summary?email= | ?team=   person / team summary (My Team)
    GET          /api/okr/my-team                   per-report summaries for a manager / lead
    POST         /api/okr/copy-forward              copy unfinished objectives to the next quarter

Identity: X-User-Email (api.permissions._get_caller). Visibility is enforced on
every read; writes follow okr.can_edit / okr.can_check_in.
"""
from datetime import date

from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.models import EmployeeTask

from . import okr
from .models import KeyResult, Objective, OkrCheckIn

norm = okr.norm


def _err(message, status=400, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _ctx(request):
    ctx = okr.Ctx.from_request(request)
    if ctx is None:
        return None, _err('Please sign in to use Goals.', 401, 'AUTH_REQUIRED')
    return ctx, None


def _period(request, data=None):
    p = ((data or {}).get('period') if data else None) or request.GET.get('period') or okr.current_period()
    return p if okr.valid_period(p) else None


def _date(v):
    if v in (None, ''):
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise ValueError('Dates must be YYYY-MM-DD.')


def _num(v, name, default=None):
    if v in (None, ''):
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        raise ValueError(f'{name} must be a number.')


# ---------------------------------------------------------------------------
# serialisation
# ---------------------------------------------------------------------------
def kr_dict(ctx, kr, obj, period, history=False):
    owner = okr._kr_responsible(kr) if kr.objective_id else norm(kr.owner_email)
    d = {
        'id': kr.pk, 'objectiveId': kr.objective_id, 'title': kr.title, 'metric': kr.metric,
        'startValue': kr.start_value, 'targetValue': kr.target_value, 'currentValue': kr.current_value,
        'unit': kr.unit, 'ownerEmail': norm(kr.owner_email), 'ownerName': ctx.name(kr.owner_email),
        'responsible': owner, 'responsibleName': ctx.name(owner),
        'dueDate': kr.due_date.isoformat() if kr.due_date else None, 'weight': kr.weight,
        'progress': round(kr.progress or 0, 1), 'confidence': kr.confidence,
        'expected': okr.elapsed_pct(period, None, kr.due_date),
        'risk': okr.risk_reason(kr, period),
        'canCheckIn': okr.can_check_in(ctx, kr, obj),
    }
    if kr.metric == 'milestone':
        d['taskIds'] = okr.linked_task_ids(kr)
    if history:
        cis = list(okr.real_check_ins(kr).order_by('-created_at')[:26])
        d['checkIns'] = [ci_dict(ctx, c) for c in cis]
        d['checkedInThisWeek'] = any(c.week == okr.iso_week() for c in cis)
    return d


def ci_dict(ctx, c):
    return {'id': c.pk, 'week': c.week, 'value': c.value, 'progress': round(c.progress or 0, 1),
            'confidence': c.confidence, 'note': c.note, 'author': norm(c.author_email),
            'authorName': ctx.name(c.author_email), 'at': c.created_at.strftime('%Y-%m-%d %H:%M:%S')}


def obj_dict(ctx, o, krs=None):
    krs = list(o.key_results.all()) if krs is None else krs
    team = ctx.teams.get(o.team_id) if o.team_id else None
    risks = sum(1 for k in krs if okr.risk_reason(k, o.period))
    return {
        'id': o.pk, 'period': o.period, 'level': o.level, 'title': o.title, 'description': o.description,
        'ownerEmail': norm(o.owner_email), 'ownerName': ctx.name(o.owner_email),
        'department': o.department, 'teamId': o.team_id, 'teamName': team.name if team else '',
        'parentId': o.parent_id, 'status': o.status, 'progress': round(o.progress or 0, 1),
        'visibility': o.visibility, 'createdBy': o.created_by,
        'krCount': len(krs), 'atRisk': risks,
        'confidence': round(sum(k.confidence for k in krs) / len(krs), 1) if krs else None,
        'minConfidence': min((k.confidence for k in krs), default=None),
        'canEdit': okr.can_edit(ctx, o),
        'updatedAt': o.updated_at.strftime('%Y-%m-%d %H:%M:%S') if o.updated_at else None,
    }


def breadcrumb(ctx, o):
    out, seen, cur = [], {o.pk}, o.parent
    while cur is not None and cur.pk not in seen:
        seen.add(cur.pk)
        if okr.can_view(ctx, cur):
            out.append({'id': cur.pk, 'title': cur.title, 'level': cur.level, 'progress': round(cur.progress or 0, 1)})
        cur = cur.parent
    return list(reversed(out))


# ---------------------------------------------------------------------------
# filtering
# ---------------------------------------------------------------------------
def visible_objectives(ctx, period, request=None):
    qs = Objective.objects.filter(period=period)
    g = request.GET if request is not None else {}
    if g.get('level') in okr.LEVELS:
        qs = qs.filter(level=g.get('level'))
    if g.get('status') in okr.STATUSES:
        qs = qs.filter(status=g.get('status'))
    if g.get('department'):
        qs = qs.filter(department__iexact=g.get('department'))
    if g.get('team'):
        try:
            qs = qs.filter(team_id=int(g.get('team')))
        except ValueError:
            pass
    if g.get('owner'):
        qs = qs.filter(owner_email__iexact=norm(g.get('owner')))
    if g.get('q'):
        qs = qs.filter(Q(title__icontains=g.get('q')) | Q(description__icontains=g.get('q')))
    scope = g.get('scope') or ('mine' if g.get('mine') in ('1', 'true') else '')
    if scope == 'mine':
        qs = qs.filter(Q(owner_email__iexact=ctx.email) | Q(pk__in=ctx.kr_owned))
    elif scope == 'myteam':
        people = set(ctx.direct_reports(ctx.email))
        led = ctx.led_teams()
        for t in led:
            people |= ctx.team_people(t)
        people.discard(ctx.email)
        qs = qs.filter(Q(owner_email__in=people) | Q(team_id__in=led))
    objs = [o for o in qs.order_by('id') if okr.can_view(ctx, o)]
    return objs


def nest(rows):
    by_id = {r['id']: dict(r, children=[]) for r in rows}
    roots = []
    for r in rows:
        node = by_id[r['id']]
        parent = by_id.get(r['parentId'])
        (parent['children'] if parent else roots).append(node)
    order = {lvl: i for i, lvl in enumerate(okr.LEVELS)}

    def sort(nodes):
        nodes.sort(key=lambda n: (order.get(n['level'], 9), n['title'].lower()))
        for n in nodes:
            sort(n['children'])
    sort(roots)
    return roots


# ---------------------------------------------------------------------------
# payload -> objective
# ---------------------------------------------------------------------------
def _apply_objective(ctx, o, data, creating):
    """Validate ``data`` onto ``o`` (not saved). Raises ValueError."""
    def has(k):
        return k in data
    if creating or has('title'):
        title = str(data.get('title') or '').strip()
        if not title:
            raise ValueError('A title is required.')
        o.title = title[:255]
    if has('description'):
        o.description = str(data.get('description') or '')[:8000]
    if creating:
        o.period = data.get('period') or okr.current_period()
    elif has('period') and data.get('period') != o.period:
        if o.children.exists():
            raise ValueError('Move or detach the aligned objectives before changing the period.')
        o.period = data.get('period')
    if not okr.valid_period(o.period):
        raise ValueError('Period must look like 2026-Q4.')
    if creating or has('level'):
        lvl = data.get('level') or o.level or 'individual'
        if lvl not in okr.LEVELS:
            raise ValueError('Unknown level.')
        if not creating and lvl != o.level:
            kids = o.children.values_list('level', flat=True)
            if any(okr.RANK.get(k, 9) <= okr.RANK[lvl] for k in kids):
                raise ValueError('Aligned objectives must sit below this level; detach them first.')
        o.level = lvl
    if creating or has('ownerEmail'):
        owner = norm(data.get('ownerEmail')) or (o.owner_email if not creating else '') or ctx.email
        if not ctx.known(owner):
            raise ValueError('The owner must be an existing employee.')
        o.owner_email = owner
    if creating or has('department'):
        dept = str(data.get('department') or '').strip()
        o.department = (dept or (ctx.dept_of(o.owner_email) if creating else ''))[:120]
    if creating or has('teamId'):
        tid = data.get('teamId')
        if tid in (None, '', 0, '0'):
            o.team_id = None
        else:
            try:
                tid = int(tid)
            except (TypeError, ValueError):
                raise ValueError('Unknown team.')
            if tid not in ctx.teams:
                raise ValueError('Unknown team.')
            o.team_id = tid
            if creating and not str(data.get('department') or '').strip():
                o.department = ctx.teams[tid].department or o.department
    if o.level == 'department' and not o.department:
        raise ValueError('A department objective needs a department.')
    if o.level == 'team' and not o.team_id:
        raise ValueError('A team objective needs a team.')
    if creating or has('visibility'):
        vis = data.get('visibility') or o.visibility or 'public'
        if vis not in okr.VISIBILITIES:
            raise ValueError('Visibility must be public, team or private.')
        o.visibility = vis
    if creating or has('status'):
        st = data.get('status') or o.status or 'active'
        if st not in okr.STATUSES:
            raise ValueError('Unknown status.')
        o.status = st
    if creating or has('parentId'):
        pid = data.get('parentId')
        if pid in (None, '', 0, '0'):
            o.parent = None
        else:
            try:
                parent = Objective.objects.filter(pk=int(pid)).first()
            except (TypeError, ValueError):
                parent = None
            if parent is None or not okr.can_view(ctx, parent):
                raise ValueError('That objective to align under was not found.')
            if parent.period != o.period:
                raise ValueError('Align under an objective of the same period.')
            if okr.RANK[parent.level] >= okr.RANK[o.level]:
                raise ValueError('Align under a higher-level objective (company > department > team > individual).')
            o.parent = parent
    elif o.parent_id:
        parent = o.parent
        if parent.period != o.period or okr.RANK[parent.level] >= okr.RANK[o.level]:
            raise ValueError('The aligned parent no longer fits this objective; change the alignment too.')


def _apply_kr(ctx, kr, data, creating):
    def has(k):
        return k in data
    if creating or has('title'):
        title = str(data.get('title') or '').strip()
        if not title:
            raise ValueError('A key result needs a title.')
        kr.title = title[:255]
    if creating or has('metric'):
        m = data.get('metric') or kr.metric or 'percent'
        if m not in okr.METRICS:
            raise ValueError('Unknown metric.')
        kr.metric = m
    defaults = {'percent': (0, 100), 'boolean': (0, 1), 'milestone': (0, 1)}.get(kr.metric, (0, 100))
    if creating or has('startValue'):
        kr.start_value = _num(data.get('startValue'), 'Start value', defaults[0])
    if creating or has('targetValue'):
        kr.target_value = _num(data.get('targetValue'), 'Target value', defaults[1])
    if creating or has('currentValue'):
        kr.current_value = _num(data.get('currentValue'), 'Current value', kr.start_value)
    if kr.metric == 'boolean':
        kr.start_value, kr.target_value = 0.0, 1.0
        kr.current_value = 1.0 if (kr.current_value or 0) >= 1 else 0.0
    if kr.metric == 'milestone' and (kr.target_value or 0) < 1:
        kr.target_value = 1.0
    if has('unit') or creating:
        kr.unit = str(data.get('unit') or '')[:20]
    if has('ownerEmail') or creating:
        owner = norm(data.get('ownerEmail'))
        if owner and not ctx.known(owner):
            raise ValueError('The key result owner must be an existing employee.')
        kr.owner_email = owner
    if has('dueDate') or creating:
        kr.due_date = _date(data.get('dueDate'))
    if has('weight') or creating:
        w = _num(data.get('weight'), 'Weight', 1.0)
        if w < 0 or w > 100:
            raise ValueError('Weight must be between 0 and 100.')
        kr.weight = w
    if has('confidence') or creating:
        c = int(_num(data.get('confidence'), 'Confidence', kr.confidence or 7))
        if not 1 <= c <= 10:
            raise ValueError('Confidence must be 1-10.')
        kr.confidence = c


# ---------------------------------------------------------------------------
# views
# ---------------------------------------------------------------------------
@api_view(['GET'])
def okr_meta(request):
    ctx, err = _ctx(request)
    if err:
        return err
    okr.maybe_remind_lazily()
    my_teams = sorted(ctx.teams_of(ctx.email) | ctx.led_teams())
    reports = ctx.direct_reports(ctx.email)
    depts = sorted({(p.department or '').strip() for p in ctx.profiles.values() if (p.department or '').strip()} |
                   {(t.department or '').strip() for t in ctx.teams.values() if (t.department or '').strip()})
    return Response({
        'me': ctx.email, 'myName': ctx.name(ctx.email), 'myDepartment': ctx.dept_of(ctx.email),
        'canManage': ctx.admin, 'currentPeriod': okr.current_period(), 'periods': okr.period_choices(),
        'week': okr.iso_week(), 'levels': list(okr.LEVELS), 'metrics': list(okr.METRICS),
        'statuses': list(okr.STATUSES), 'visibilities': list(okr.VISIBILITIES),
        'departments': depts,
        'teams': [{'id': t.id, 'name': t.name, 'department': t.department, 'lead': okr.norm(t.lead_email),
                   'mine': t.id in my_teams, 'canLead': t.id in ctx.led_teams() or ctx.admin}
                  for t in sorted(ctx.teams.values(), key=lambda t: t.name.lower()) if t.status != 'archived'],
        'reports': [{'email': e, 'name': ctx.name(e)} for e in reports],
        'isManager': bool(reports) or bool(ctx.led_teams()),
        'people': [{'email': e, 'name': ctx.name(e)} for e in sorted(set(ctx.accounts) | set(ctx.profiles))
                   if ctx.admin or e == ctx.email or e in reports or ctx.manager_of(e) == ctx.email
                   or any(e in ctx.team_people(t) for t in ctx.led_teams())][:2000],
        'atRiskConfidence': okr.AT_RISK_CONFIDENCE,
    })


@api_view(['GET', 'POST'])
def objectives(request):
    ctx, err = _ctx(request)
    if err:
        return err
    if request.method == 'GET':
        period = _period(request)
        if not period:
            return _err('Period must look like 2026-Q4.')
        okr.refresh_milestones(Objective.objects.filter(period=period).values_list('id', flat=True))
        objs = visible_objectives(ctx, period, request)
        krs = {}
        for k in KeyResult.objects.filter(objective_id__in=[o.pk for o in objs]):
            krs.setdefault(k.objective_id, []).append(k)
        rows = [obj_dict(ctx, o, krs.get(o.pk, [])) for o in objs]
        if request.GET.get('tree') in ('1', 'true'):
            return Response({'period': period, 'tree': nest(rows), 'count': len(rows)})
        return Response({'period': period, 'results': rows, 'count': len(rows)})
    data = request.data or {}
    o = Objective(created_by=ctx.email, status='active')
    try:
        _apply_objective(ctx, o, data, creating=True)
    except ValueError as e:
        return _err(str(e))
    if not okr.can_edit(ctx, o):
        return _err(_deny_text(o), 403, 'PERMISSION_DENIED')
    o.save()
    for raw in (data.get('keyResults') or [])[:20]:
        kr = KeyResult(objective=o)
        try:
            _apply_kr(ctx, kr, raw or {}, creating=True)
        except ValueError as e:
            o.delete()
            return _err(str(e))
        kr.save()
        okr.recalc_kr(kr)
    okr.rollup(o)
    o.refresh_from_db()
    return Response(_detail(ctx, o), status=201)


def _deny_text(o):
    return {
        'company': 'Only OKR managers can set company objectives.',
        'department': 'Only OKR managers can set department objectives.',
        'team': 'Only the team lead or their manager can set team objectives.',
    }.get(o.level, 'You can only set objectives for yourself or your direct reports.')


def _detail(ctx, o):
    period = o.period
    krs = list(o.key_results.all())
    d = obj_dict(ctx, o, krs)
    d['keyResults'] = [kr_dict(ctx, k, o, period, history=True) for k in krs]
    d['breadcrumb'] = breadcrumb(ctx, o)
    d['children'] = [obj_dict(ctx, c) for c in o.children.all().order_by('level', 'title') if okr.can_view(ctx, c)]
    d['expected'] = okr.elapsed_pct(period)
    return d


def _get_obj(ctx, pk):
    o = Objective.objects.filter(pk=pk).select_related('parent').first()
    if o is None or not okr.can_view(ctx, o):
        return None, _err('Objective not found.', 404)
    return o, None


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
def objective_detail(request, pk):
    ctx, err = _ctx(request)
    if err:
        return err
    o, err = _get_obj(ctx, pk)
    if err:
        return err
    if request.method == 'GET':
        okr.refresh_milestones([o.pk])
        o.refresh_from_db()
        return Response(_detail(ctx, o))
    if not okr.can_edit(ctx, o):
        return _err(_deny_text(o), 403, 'PERMISSION_DENIED')
    old_parent = o.parent
    if request.method == 'DELETE':
        o.delete()
        if old_parent:
            okr.rollup(old_parent)
        return Response({'deleted': pk})
    data = request.data or {}
    try:
        _apply_objective(ctx, o, data, creating=False)
    except ValueError as e:
        return _err(str(e))
    if not okr.can_edit(ctx, o):        # e.g. moved to a level the caller cannot own
        return _err(_deny_text(o), 403, 'PERMISSION_DENIED')
    o.save()
    okr.rollup(o)
    if old_parent and old_parent.pk != o.parent_id:
        okr.rollup(old_parent)
    o.refresh_from_db()
    return Response(_detail(ctx, o))


@api_view(['POST'])
def objective_key_results(request, pk):
    ctx, err = _ctx(request)
    if err:
        return err
    o, err = _get_obj(ctx, pk)
    if err:
        return err
    if not okr.can_edit(ctx, o):
        return _err(_deny_text(o), 403, 'PERMISSION_DENIED')
    kr = KeyResult(objective=o)
    try:
        _apply_kr(ctx, kr, request.data or {}, creating=True)
    except ValueError as e:
        return _err(str(e))
    kr.save()
    okr.recalc_kr(kr)
    okr.rollup(o)
    return Response(kr_dict(ctx, kr, o, o.period, history=True), status=201)


def _get_kr(ctx, pk):
    kr = KeyResult.objects.filter(pk=pk).select_related('objective').first()
    if kr is None or not okr.can_view(ctx, kr.objective):
        return None, _err('Key result not found.', 404)
    return kr, None


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
def key_result_detail(request, pk):
    ctx, err = _ctx(request)
    if err:
        return err
    kr, err = _get_kr(ctx, pk)
    if err:
        return err
    o = kr.objective
    if request.method == 'GET':
        return Response(kr_dict(ctx, kr, o, o.period, history=True))
    if not okr.can_edit(ctx, o):
        return _err(_deny_text(o), 403, 'PERMISSION_DENIED')
    if request.method == 'DELETE':
        kr.delete()
        okr.rollup(o)
        return Response({'deleted': pk})
    try:
        _apply_kr(ctx, kr, request.data or {}, creating=False)
    except ValueError as e:
        return _err(str(e))
    kr.save()
    okr.recalc_kr(kr)
    okr.rollup(o)
    return Response(kr_dict(ctx, kr, o, o.period, history=True))


@api_view(['GET', 'POST'])
def key_result_check_ins(request, pk):
    ctx, err = _ctx(request)
    if err:
        return err
    kr, err = _get_kr(ctx, pk)
    if err:
        return err
    if request.method == 'GET':
        return Response({'results': [ci_dict(ctx, c) for c in okr.real_check_ins(kr).order_by('-created_at')[:104]]})
    if not okr.can_check_in(ctx, kr):
        return _err('Only the key result owner, the objective owner or their manager can check in.', 403,
                    'PERMISSION_DENIED')
    if kr.objective.status in ('cancelled',):
        return _err('This objective is cancelled.')
    d = request.data or {}
    try:
        ci, created = okr.record_check_in(ctx.email, kr, d.get('value'), d.get('confidence'), d.get('note', ''))
    except ValueError as e:
        return _err(str(e))
    kr.refresh_from_db()
    o = Objective.objects.get(pk=kr.objective_id)
    return Response({'checkIn': ci_dict(ctx, ci), 'created': created,
                     'keyResult': kr_dict(ctx, kr, o, o.period, history=True),
                     'objective': obj_dict(ctx, o)}, status=201 if created else 200)


def _task_dict(t):
    return {'id': t.id, 'title': t.title, 'code': t.task_code, 'stage': t.stage, 'assignee': t.assignee,
            'assigneeEmail': norm(t.assignee_email), 'due': t.due, 'progress': t.progress}


def _visible_tasks(ctx, kr=None):
    qs = EmployeeTask.objects.all()
    if ctx.admin:
        return qs
    people = {ctx.email} | ctx.reports_tree(ctx.email)
    if kr is not None:
        people.add(okr._kr_responsible(kr))
    led = ctx.led_teams()
    return qs.filter(Q(assignee_email__in=people) | Q(created_by__iexact=ctx.email) |
                     Q(team_lead_email__iexact=ctx.email) | Q(team_id__in=led))


@api_view(['GET', 'PUT', 'POST'])
def key_result_tasks(request, pk):
    ctx, err = _ctx(request)
    if err:
        return err
    kr, err = _get_kr(ctx, pk)
    if err:
        return err
    if request.method != 'GET':
        if not okr.can_check_in(ctx, kr):
            return _err('Only the key result owner, the objective owner or their manager can link tasks.', 403,
                        'PERMISSION_DENIED')
        if kr.metric != 'milestone':
            return _err('Only milestone key results follow tasks.')
        raw = (request.data or {}).get('taskIds') or []
        try:
            ids = sorted({int(x) for x in raw})[:200]
        except (TypeError, ValueError):
            return _err('taskIds must be a list of task ids.')
        allowed = set(_visible_tasks(ctx, kr).filter(id__in=ids).values_list('id', flat=True))
        keep = set(okr.linked_task_ids(kr))
        if set(ids) - allowed - keep:
            return _err('Some of those tasks were not found.', 404)
        OkrCheckIn.objects.filter(key_result=kr, week=okr.LINK_WEEK).exclude(value__in=[float(i) for i in ids]).delete()
        for tid in set(ids) - keep:
            OkrCheckIn.objects.create(key_result=kr, author_email=ctx.email, value=float(tid), week=okr.LINK_WEEK)
        if not ids:
            kr.current_value = min(kr.current_value or 0, kr.target_value or 1)
            kr.save(update_fields=['current_value', 'updated_at'])
        okr.recalc_kr(kr)
        okr.rollup(kr.objective)
        kr.refresh_from_db()
    ids = okr.linked_task_ids(kr)
    tasks = [_task_dict(t) for t in EmployeeTask.objects.filter(id__in=ids).order_by('id')]
    o = Objective.objects.get(pk=kr.objective_id)
    return Response({'tasks': tasks, 'keyResult': kr_dict(ctx, kr, o, o.period, history=True)})


@api_view(['GET'])
def linkable_tasks(request):
    ctx, err = _ctx(request)
    if err:
        return err
    kr = None
    if request.GET.get('kr'):
        kr, err = _get_kr(ctx, request.GET.get('kr'))
        if err:
            return err
    qs = _visible_tasks(ctx, kr)
    q = (request.GET.get('q') or '').strip()
    if q:
        qs = qs.filter(Q(title__icontains=q) | Q(task_code__icontains=q) | Q(assignee__icontains=q))
    return Response({'results': [_task_dict(t) for t in qs.order_by('-id')[:100]]})


@api_view(['GET'])
def alignment_options(request):
    ctx, err = _ctx(request)
    if err:
        return err
    period = _period(request)
    if not period:
        return _err('Period must look like 2026-Q4.')
    level = request.GET.get('level') or 'individual'
    if level not in okr.LEVELS:
        return _err('Unknown level.')
    exclude = request.GET.get('exclude')
    out = []
    for o in Objective.objects.filter(period=period).exclude(status='cancelled').order_by('level', 'title'):
        if okr.RANK[o.level] < okr.RANK[level] and str(o.pk) != str(exclude) and okr.can_view(ctx, o):
            out.append({'id': o.pk, 'title': o.title, 'level': o.level, 'ownerName': ctx.name(o.owner_email),
                        'department': o.department, 'teamId': o.team_id, 'progress': round(o.progress or 0, 1)})
    return Response({'results': out})


@api_view(['GET'])
def check_ins_due(request):
    ctx, err = _ctx(request)
    if err:
        return err
    period = okr.current_period()
    week = okr.iso_week()
    okr.refresh_milestones(Objective.objects.filter(period=period).values_list('id', flat=True))
    due = okr.due_key_results(ctx.email, period, week)
    done = (KeyResult.objects.select_related('objective')
            .filter(objective__period=period, objective__status='active')
            .filter(Q(owner_email__iexact=ctx.email) | (Q(owner_email='') & Q(objective__owner_email__iexact=ctx.email)))
            .filter(check_ins__week=week).distinct())
    return Response({
        'period': period, 'week': week,
        'due': [dict(kr_dict(ctx, k, k.objective, period, history=True), objectiveTitle=k.objective.title,
                     objectiveLevel=k.objective.level) for k in due],
        'done': [dict(kr_dict(ctx, k, k.objective, period), objectiveTitle=k.objective.title,
                      objectiveLevel=k.objective.level) for k in done],
    })


def person_summary(ctx, email, period):
    email = norm(email)
    objs = [o for o in Objective.objects.filter(period=period, owner_email__iexact=email).exclude(status='cancelled')
            if okr.can_view(ctx, o)]
    krs = list(KeyResult.objects.select_related('objective').filter(objective__period=period)
               .exclude(objective__status='cancelled')
               .filter(Q(owner_email__iexact=email) | (Q(owner_email='') & Q(objective__owner_email__iexact=email))))
    krs = [k for k in krs if okr.can_view(ctx, k.objective)]
    risks = [{'id': k.pk, 'title': k.title, 'objectiveId': k.objective_id, 'objective': k.objective.title,
              'progress': round(k.progress or 0, 1), 'confidence': k.confidence,
              'reason': okr.risk_reason(k, period)} for k in krs if okr.risk_reason(k, period)]
    last = okr.real_check_ins().filter(key_result__in=[k.pk for k in krs]).order_by('-created_at').first()
    week = okr.iso_week()
    due = [k for k in krs if k.objective.status == 'active' and (k.progress or 0) < 100
           and not okr.real_check_ins(k).filter(week=week).exists()] if period == okr.current_period() else []
    return {
        'email': email, 'name': ctx.name(email), 'period': period,
        'objectives': [{'id': o.pk, 'title': o.title, 'level': o.level, 'progress': round(o.progress or 0, 1),
                        'status': o.status} for o in objs],
        'objectiveCount': len(objs),
        'avgProgress': round(sum(o.progress or 0 for o in objs) / len(objs), 1) if objs else None,
        'krCount': len(krs), 'atRisk': risks, 'checkInsDue': len(due),
        'lastCheckIn': last.created_at.strftime('%Y-%m-%d %H:%M:%S') if last else None,
    }


@api_view(['GET'])
def summary(request):
    ctx, err = _ctx(request)
    if err:
        return err
    period = _period(request)
    if not period:
        return _err('Period must look like 2026-Q4.')
    if request.GET.get('team'):
        try:
            tid = int(request.GET.get('team'))
        except ValueError:
            return _err('Unknown team.')
        if tid not in ctx.teams:
            return _err('Unknown team.', 404)
        people = ctx.team_people(tid)
        if not (ctx.admin or ctx.email in people or tid in ctx.led_teams()):
            return _err('You can only see teams you belong to or lead.', 403, 'PERMISSION_DENIED')
        objs = [o for o in Objective.objects.filter(period=period, team_id=tid).exclude(status='cancelled')
                if okr.can_view(ctx, o)]
        members = [person_summary(ctx, e, period) for e in sorted(people)]
        return Response({'team': {'id': tid, 'name': ctx.teams[tid].name, 'lead': ctx.team_lead(tid)},
                         'period': period, 'teamObjectives': [obj_dict(ctx, o) for o in objs],
                         'members': members})
    email = norm(request.GET.get('email')) or ctx.email
    if not okr.can_see_person(ctx, email):
        return _err('You can only see your own goals or your team\'s.', 403, 'PERMISSION_DENIED')
    return Response(person_summary(ctx, email, period))


@api_view(['GET'])
def my_team(request):
    ctx, err = _ctx(request)
    if err:
        return err
    period = _period(request)
    if not period:
        return _err('Period must look like 2026-Q4.')
    people = set(ctx.direct_reports(ctx.email))
    led = ctx.led_teams()
    for t in led:
        people |= ctx.team_people(t)
    people.discard(ctx.email)
    rows = sorted((person_summary(ctx, e, period) for e in people), key=lambda r: r['name'].lower())
    team_objs = [o for o in Objective.objects.filter(period=period, team_id__in=led).exclude(status='cancelled')
                 if okr.can_view(ctx, o)]
    return Response({'period': period, 'members': rows,
                     'teams': [{'id': t, 'name': ctx.teams[t].name} for t in sorted(led)],
                     'teamObjectives': [obj_dict(ctx, o) for o in team_objs]})


@api_view(['POST'])
def copy_forward(request):
    ctx, err = _ctx(request)
    if err:
        return err
    data = request.data or {}
    period = data.get('period') or okr.current_period()
    if not okr.valid_period(period):
        return _err('Period must look like 2026-Q4.')
    ids = data.get('objectiveIds') or None
    try:
        ids = [int(i) for i in ids] if ids else None
    except (TypeError, ValueError):
        return _err('objectiveIds must be ids.')
    nxt, created, skipped = okr.copy_unfinished(ctx, period, ids)
    return Response({'period': nxt, 'created': [obj_dict(ctx, o) for o in created], 'skipped': skipped,
                     'message': f'Copied {len(created)} objective(s) to {nxt}.'
                                + (f' {len(skipped)} already there.' if skipped else '')})
