"""
api/project_views.py
=============================================================================
Endpoints for Multi-Project Management and Cross-Team Collaboration.
"""
from decimal import Decimal
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .permissions import require_perm
from .models import Project, ProjectMilestone, ProjectStatusUpdate, Team, EmployeeTask, TimesheetEntry
from .serializers import ProjectSerializer, ProjectMilestoneSerializer, ProjectStatusUpdateSerializer


def _err(msg, status=400):
    return Response({'message': msg, 'error': msg}, status=status)


@api_view(['GET', 'POST'])
@require_perm({'GET': ['project.view', 'employee.view'], 'POST': 'project.create'})
def projects_list(request):
    """List all projects or create a new project."""
    if request.method == 'GET':
        qs = Project.objects.all().prefetch_related('contributing_teams', 'milestones', 'tasks', 'status_updates')
        status = request.GET.get('status')
        if status:
            qs = qs.filter(status=status)
        team_id = request.GET.get('teamId')
        if team_id:
            qs = qs.filter(contributing_teams__id=team_id)
        # Archived projects are hidden unless asked for: ?archived=all|only.
        archived = str(request.GET.get('archived') or '').strip().lower()
        if archived == 'only':
            qs = qs.filter(archived_at__isnull=False)
        elif archived not in ('all', '1', 'true'):
            qs = qs.filter(archived_at__isnull=True)
        serializer = ProjectSerializer(qs, many=True)
        return Response(serializer.data)

    body = request.data or {}
    name = (body.get('name') or '').strip()
    if not name:
        return _err('Project name is required')

    code = (body.get('projectCode') or '').strip().upper()
    if not code:
        import time
        code = base = f"PRJ-{int(time.time())}"
        n = 1
        while Project.objects.filter(project_code=code).exists():   # two created in the same second
            n += 1
            code = f"{base}-{n}"

    if Project.objects.filter(project_code=code).exists():
        return _err(f'Project with code "{code}" already exists')

    data = {**body, 'projectCode': code}
    # The creator owns the project unless someone else is named.
    caller_email, _ = _caller(request)
    if caller_email:
        if not str(data.get('createdBy') or '').strip():
            data['createdBy'] = caller_email
        if not str(data.get('projectManager') or '').strip():
            data['projectManager'] = caller_email
    serializer = ProjectSerializer(data=data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=400)

    project = serializer.save()
    if 'contributingTeamIds' in body and isinstance(body['contributingTeamIds'], list):
        teams = Team.objects.filter(id__in=body['contributingTeamIds'])
        project.contributing_teams.set(teams)

    return Response(ProjectSerializer(project).data, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@require_perm({'GET': ['project.view', 'employee.view'], 'PUT': ['project.view', 'employee.view'], 'DELETE': 'project.delete'})
def project_detail(request, pk):
    """Retrieve, update or delete a specific project."""
    project = Project.objects.filter(pk=pk).first()
    if not project:
        return _err('Project not found', 404)

    if request.method == 'GET':
        return Response(ProjectSerializer(project).data)

    if request.method == 'DELETE':
        return _delete_project(request, project)

    if not _can_manage_project(request, project):
        return _err("You don't have permission to edit this project (project.edit).", 403)
    body = request.data or {}
    if 'projectManager' in body and str(body.get('projectManager') or '').strip().lower() \
            != (project.project_manager or '').strip().lower():
        from .permissions import check_perm
        if not check_perm(request, ['project.edit', 'project.manage'])[0]:
            return _err("Only project editors can change a project's manager (project.edit).", 403)
    if 'projectCode' in body and str(body.get('projectCode') or '') != (project.project_code or ''):
        return _err('The project code cannot be changed.', 400)
    serializer = ProjectSerializer(project, data=body, partial=True)
    if not serializer.is_valid():
        return Response(serializer.errors, status=400)

    project = serializer.save()
    if 'contributingTeamIds' in body and isinstance(body['contributingTeamIds'], list):
        teams = Team.objects.filter(id__in=body['contributingTeamIds'])
        project.contributing_teams.set(teams)

    return Response(ProjectSerializer(project).data)


@api_view(['GET', 'POST'])
@require_perm({'GET': ['project.view', 'employee.view'], 'POST': ['project.edit', 'project.manage']})
def project_milestones(request, pk):
    """List or create milestones for a project."""
    project = Project.objects.filter(pk=pk).first()
    if not project:
        return _err('Project not found', 404)

    if request.method == 'GET':
        milestones = project.milestones.all()
        return Response(ProjectMilestoneSerializer(milestones, many=True).data)

    body = request.data or {}
    title = (body.get('title') or '').strip()
    if not title:
        return _err('Milestone title is required')

    milestone = ProjectMilestone.objects.create(
        project=project,
        title=title,
        due_date=body.get('dueDate') or None,
        is_completed=bool(body.get('isCompleted', False)),
        sort_order=int(body.get('sortOrder', 0) or 0)
    )
    return Response(ProjectMilestoneSerializer(milestone).data, status=201)


@api_view(['GET'])
@require_perm({'GET': ['project.view', 'employee.view']})
def project_burndown(request, pk):
    """Calculate allocated budget hours vs logged timesheet hours."""
    project = Project.objects.filter(pk=pk).first()
    if not project:
        return _err('Project not found', 404)

    # Match timesheets by project name or project code or linked tasks
    task_ids = list(project.tasks.values_list('id', flat=True))
    from django.db.models import Q, Sum
    ts_qs = TimesheetEntry.objects.filter(
        Q(project=project.name) | Q(project=project.project_code) | Q(task_id__in=task_ids)
    )

    total_spent = ts_qs.aggregate(total=Sum('hours'))['total'] or Decimal('0.00')
    allocated = project.allocated_hours or Decimal('0.00')
    remaining = max(Decimal('0.00'), allocated - total_spent)

    return Response({
        'projectId': project.id,
        'projectCode': project.project_code,
        'name': project.name,
        'allocatedHours': float(allocated),
        'spentHours': float(total_spent),
        'remainingHours': float(remaining),
        'burnRatePercent': round(float(total_spent / allocated * 100), 1) if allocated > 0 else 0.0,
        'entryCount': ts_qs.count()
    })


@api_view(['GET', 'POST'])
@require_perm({'GET': 'employee.view', 'POST': 'employee.view'}, or_self=True)
def task_comments(request, pk):
    """Retrieve or add threaded GitHub-style comments on an issue/task."""
    task = EmployeeTask.objects.filter(pk=pk).first()
    if not task:
        return _err('Task not found', 404)

    if request.method == 'GET':
        comments = task.comments.all()
        from .serializers import TaskCommentSerializer
        return Response(TaskCommentSerializer(comments, many=True).data)

    body = request.data or {}
    text = (body.get('body') or '').strip()
    if not text:
        return _err('Comment body is required')

    from .permissions import _get_caller
    caller_email, user = _get_caller(request)
    author_email = caller_email or body.get('authorEmail') or 'user@company.com'
    author_name = (user.full_name if user else None) or body.get('authorName') or author_email

    from .models import TaskComment
    comment = TaskComment.objects.create(
        task=task,
        author_email=author_email,
        author_name=author_name,
        comment_type=body.get('commentType', 'comment'),
        body=text
    )

    # Assignee + watchers + @mentioned people (in-app and email, once each).
    from . import task_notify
    task_notify.comment_added(request, task, comment)

    from .serializers import TaskCommentSerializer
    return Response(TaskCommentSerializer(comment).data, status=201)


@api_view(['POST'])
@require_perm({'POST': 'employee.view'}, or_self=True)
def task_reaction(request, task_pk, comment_pk):
    """Toggle an emoji reaction (+1, heart, rocket, eyes) on a comment."""
    from .models import TaskComment
    comment = TaskComment.objects.filter(pk=comment_pk, task_id=task_pk).first()
    if not comment:
        return _err('Comment not found', 404)

    import json
    try:
        reactions = json.loads(comment.reactions or '{}')
    except Exception:
        reactions = {}

    emoji = (request.data.get('emoji') or '+1').strip()
    from .permissions import _get_caller
    caller_email, _ = _get_caller(request)
    user_email = caller_email or request.data.get('email') or 'user@company.com'

    users = reactions.get(emoji, [])
    if user_email in users:
        users.remove(user_email)
    else:
        users.append(user_email)
    reactions[emoji] = users

    comment.reactions = json.dumps(reactions)
    comment.save(update_fields=['reactions'])
    return Response({'reactions': reactions})


@api_view(['PATCH', 'DELETE'])
@require_perm({'PATCH': 'employee.view', 'DELETE': 'employee.view'}, or_self=True)
def task_comment_detail(request, task_pk, comment_pk):
    """Edit (PATCH {body}: its author only) or delete a comment. Its author may
    delete it; so may anyone holding task.delete (a moderator). Timeline
    events cannot be changed."""
    from .models import TaskComment
    from .permissions import _get_caller, check_perm
    comment = TaskComment.objects.filter(pk=comment_pk, task_id=task_pk).select_related('task').first()
    if not comment:
        return _err('Comment not found', 404)
    if comment.comment_type != 'comment':
        return _err('Timeline events cannot be ' + ('edited.' if request.method == 'PATCH' else 'deleted.'), 409)
    caller_email, _ = _get_caller(request)
    own = bool(caller_email) and (comment.author_email or '').strip().lower() == caller_email
    if request.method == 'PATCH':
        if not own:
            return _err('You can only edit your own comments.', 403)
        text = str((request.data or {}).get('body') or '').strip()
        if not text:
            return _err('Comment body is required')
        old = comment.body or ''
        comment.body = text
        comment.save(update_fields=['body'])
        from . import task_notify
        task_notify.comment_edited(request, comment.task, comment, old)
        from .serializers import TaskCommentSerializer
        return Response(TaskCommentSerializer(comment).data)
    if not own:
        allowed, _, _ = check_perm(request, 'task.delete')
        if not allowed:
            return _err('You can only delete your own comments.', 403)
    comment.delete()
    return Response({'ok': True})


# --- Project status updates (GitHub Projects-style) -------------------------

def _caller(request):
    """(email, display name) of the signed-in caller."""
    from .permissions import _get_caller
    email, user = _get_caller(request)
    return email or '', ((user.full_name if user else '') or email or '')


def _can_manage_project(request, project):
    """Who may edit a project (details, README, archive) and post status
    updates: holders of project.edit / project.manage and the project's own
    manager."""
    from .permissions import check_perm
    email, _ = _caller(request)
    if email and (project.project_manager or '').strip().lower() == email:
        return True
    allowed, _, _ = check_perm(request, ['project.edit', 'project.manage'])
    return allowed


@api_view(['GET', 'POST'])
@require_perm({'GET': ['project.view', 'employee.view'], 'POST': ['project.view', 'employee.view']})
def project_status_updates(request, pk):
    """List a project's status updates (newest first) or post a new one."""
    project = Project.objects.filter(pk=pk).first()
    if not project:
        return _err('Project not found', 404)
    if request.method == 'GET':
        return Response(ProjectStatusUpdateSerializer(project.status_updates.all(), many=True).data)
    if not _can_manage_project(request, project):
        return _err('Only the project manager or someone who can edit projects can post status updates.', 403)
    serializer = ProjectStatusUpdateSerializer(data=request.data or {})
    if not serializer.is_valid():
        return Response(serializer.errors, status=400)
    email, name = _caller(request)
    upd = serializer.save(project=project, author_email=email, author_name=name)
    return Response(ProjectStatusUpdateSerializer(upd).data, status=201)


@api_view(['PATCH', 'PUT', 'DELETE'])
@require_perm({'PATCH': ['project.view', 'employee.view'], 'PUT': ['project.view', 'employee.view'], 'DELETE': ['project.view', 'employee.view']})
def project_status_update_detail(request, pk, uid):
    """Edit or delete a status update: its author, the project manager, or
    anyone who can edit projects."""
    upd = ProjectStatusUpdate.objects.filter(pk=uid, project_id=pk).select_related('project').first()
    if not upd:
        return _err('Status update not found', 404)
    email, _ = _caller(request)
    own = bool(email) and (upd.author_email or '').strip().lower() == email
    if not own and not _can_manage_project(request, upd.project):
        return _err('You can only change your own status updates.', 403)
    if request.method == 'DELETE':
        upd.delete()
        return Response({'ok': True})
    serializer = ProjectStatusUpdateSerializer(upd, data=request.data or {}, partial=True)
    if not serializer.is_valid():
        return Response(serializer.errors, status=400)
    upd = serializer.save()
    return Response(ProjectStatusUpdateSerializer(upd).data)


# --- Remove a project: archive / unarchive / delete -------------------------
import logging as _logging

_log = _logging.getLogger(__name__)


def _truthy(v):
    return str(v).strip().lower() in ('1', 'true', 'yes', 'on') if v is not None else False


def _delete_project(request, project):
    """DELETE /api/projects/<id> {confirmName, deleteTodoIssues}.

    GitHub-style: the caller types the project's name to confirm. Its issues
    are kept and unlinked from the project (project and milestone cleared);
    with deleteTodoIssues the ones still in To Do are deleted instead - the
    same rule as DELETE /api/tasks/<id> (only To Do; needs task.delete). The
    project's views, custom fields (and their values), milestones and status
    updates go with it."""
    from django.db import transaction
    from .permissions import check_perm
    body = request.data if hasattr(request.data, 'get') else {}
    confirm = body.get('confirmName', request.GET.get('confirmName'))
    if str(confirm or '').strip() != (project.name or '').strip():
        return _err('Type the project name exactly to confirm deleting it.', 400)
    delete_todo = _truthy(body.get('deleteTodoIssues', request.GET.get('deleteTodoIssues')))
    if delete_todo:
        allowed, _, _ = check_perm(request, 'task.delete')
        if not allowed:
            return _err("You don't have permission to delete issues (task.delete).", 403)
    actor, actor_name = _caller(request)
    pid, name, code = project.id, project.name, project.project_code
    manager = (project.project_manager or '').strip().lower()
    with transaction.atomic():
        deleted = 0
        if delete_todo:
            todo = EmployeeTask.objects.filter(project=project, stage='todo')
            deleted = todo.count()
            todo.delete()
        unlinked = EmployeeTask.objects.filter(project=project).update(project=None, milestone=None)
        project.delete()
    # Audit trail: who removed what (there is no generic audit table).
    _log.warning('AUDIT project.delete: %s "%s" (id %s) deleted by %s; %s issue(s) unlinked, '
                 '%s To Do issue(s) deleted', code, name, pid, actor or 'unknown', unlinked, deleted)
    if manager and manager != actor:
        try:
            from .views import create_notification
            create_notification(manager, f'Project “{name}” was deleted',
                                f'{actor_name or actor} deleted the project {code} “{name}”. '
                                f'{unlinked} issue(s) were kept without a project'
                                + (f' and {deleted} To Do issue(s) were deleted.' if deleted else '.'),
                                'warning', '/employees/tasks')
        except Exception:
            _log.exception('Could not notify the manager of deleted project %s', code)
    return Response({'ok': True, 'message': f'Project “{name}” deleted.',
                     'unlinked': unlinked, 'deleted': deleted})


def _set_archived(request, pk, archived):
    from django.utils import timezone
    project = Project.objects.filter(pk=pk).first()
    if not project:
        return _err('Project not found', 404)
    if not _can_manage_project(request, project):
        return _err("You don't have permission to archive this project (project.edit).", 403)
    project.archived_at = (project.archived_at or timezone.now()) if archived else None
    project.save(update_fields=['archived_at', 'updated_at'])
    actor, _ = _caller(request)
    _log.info('AUDIT project.%s: %s by %s', 'archive' if archived else 'unarchive', project.project_code, actor)
    return Response(ProjectSerializer(project).data)


@api_view(['POST'])
@require_perm({'POST': ['project.view', 'employee.view']})
def project_archive(request, pk):
    """POST /api/projects/<id>/archive (same gate as editing a project).
    Archived projects drop out of the default project list; nothing is lost."""
    return _set_archived(request, pk, True)


@api_view(['POST'])
@require_perm({'POST': ['project.view', 'employee.view']})
def project_unarchive(request, pk):
    """POST /api/projects/<id>/unarchive."""
    return _set_archived(request, pk, False)


# --- Saved views and project fields (GitHub Projects v2) ---------------------
import datetime as _dt
import math as _math
import re as _re
import secrets as _secrets

# Built-in field ids a view may show (hrms-projects.js FIELD_DEFS) and the
# names a custom field may not reuse.
BUILTIN_FIELDS = ('title', 'assignees', 'status', 'labels', 'milestone', 'type', 'reviewers', 'parent',
                  'subissues', 'created', 'updated', 'closed', 'priority', 'start', 'target', 'effort',
                  'team', 'due')
RESERVED_FIELD_NAMES = {
    'title', 'assignees', 'assignee', 'status', 'labels', 'label', 'milestone', 'type', 'reviewers',
    'reviewer', 'parent issue', 'parent', 'sub-issues progress', 'sub-issues', 'created', 'updated', 'closed',
    'priority', 'start date', 'target date', 'effort', 'team', 'due date', 'due', 'repository',
    'linked pull requests',
}
FIELD_COLORS = ('gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple')
VIEW_LAYOUTS = ('table', 'board', 'roadmap')
_FIELD_ID = _re.compile(r'^(?:[a-z]{2,12}|f:\d{1,9})$')
_DEFAULT_VIEWS = (('Table', 'table'), ('Board', 'board'), ('Roadmap', 'roadmap'))


def _can_configure(request, project):
    """Who may change a project's views and fields: holders of project.edit /
    project.manage and the project's own manager."""
    return _can_manage_project(request, project)


def _clean_view_config(raw):
    """(config, error). Unknown keys are dropped; values are checked."""
    if raw in (None, ''):
        return {}, ''
    if not isinstance(raw, dict):
        return None, 'config must be an object.'
    out = {}
    if 'fields' in raw:
        f = raw['fields']
        if not isinstance(f, list) or len(f) > 80 or any(not isinstance(x, str) or not _FIELD_ID.match(x) for x in f):
            return None, 'config.fields must be a list of field ids.'
        seen = []
        for x in f:
            if x != 'title' and x not in seen:
                seen.append(x)
        out['fields'] = seen
    if 'widths' in raw:
        w = raw['widths']
        if not isinstance(w, dict) or len(w) > 100:
            return None, 'config.widths must be an object of {field: pixels}.'
        clean = {}
        for k, v in w.items():
            if not isinstance(k, str) or not _FIELD_ID.match(k) or isinstance(v, bool) or not isinstance(v, (int, float)):
                return None, 'config.widths must be an object of {field: pixels}.'
            clean[k] = int(max(48, min(900, v)))
        out['widths'] = clean
    for key, allowed in (('dir', ('asc', 'desc')), ('state', ('open', 'closed', 'all')),
                         ('zoom', ('week', 'month', 'quarter'))):
        if key in raw and raw[key] not in (None, ''):
            if raw[key] not in allowed:
                return None, 'config.%s must be one of: %s' % (key, ', '.join(allowed))
            out[key] = raw[key]
    for key in ('sort', 'group', 'tgroup'):
        if key in raw and raw[key] is not None:
            v = str(raw[key])
            if v and not (_FIELD_ID.match(v) or v == 'none'):
                return None, 'config.%s is not a field id.' % key
            out[key] = v
    if 'q' in raw:
        q = str(raw['q'] or '')
        if len(q) > 500:
            return None, 'config.q must be 500 characters or fewer.'
        out['q'] = q
    return out, ''


def _view_dict(v):
    return {'id': v.id, 'projectId': v.project_id, 'name': v.name, 'layout': v.layout,
            'config': v.config if isinstance(v.config, dict) else {}, 'position': v.position,
            'createdBy': v.created_by or '',
            'updatedAt': v.updated_at.isoformat() if v.updated_at else None}


def _project_or_404(pk):
    return Project.objects.filter(pk=pk).first()


@api_view(['GET', 'POST'])
@require_perm({'GET': ['project.view', 'employee.view'], 'POST': ['project.view', 'employee.view']})
def project_views_list(request, pk):
    """GET: the project's saved views (a Table, Board and Roadmap view are
    created the first time a project is opened). POST {name, layout, config}:
    a new view, shared with everyone who can see the project."""
    from .models import ProjectView
    project = _project_or_404(pk)
    if not project:
        return _err('Project not found', 404)
    if request.method == 'GET':
        views = list(project.views.all())
        if not views:
            for i, (name, layout) in enumerate(_DEFAULT_VIEWS):
                ProjectView.objects.get_or_create(project=project, name=name,
                                                  defaults={'layout': layout, 'position': i, 'created_by': 'system'})
            views = list(project.views.all())
        return Response([_view_dict(v) for v in views])
    if not _can_configure(request, project):
        return _err("You don't have permission to change this project's views.", 403)
    body = request.data if hasattr(request.data, 'get') else {}
    layout = str(body.get('layout') or 'table')
    if layout not in VIEW_LAYOUTS:
        return _err('layout must be table, board or roadmap.')
    config, why = _clean_view_config(body.get('config'))
    if why:
        return _err(why)
    name = ' '.join(str(body.get('name') or '').split())[:100] or 'View %d' % (project.views.count() + 1)
    last = project.views.order_by('-position').values_list('position', flat=True).first()
    email, _ = _caller(request)
    v = ProjectView.objects.create(project=project, name=name, layout=layout, config=config,
                                   position=(last + 1) if last is not None else 0, created_by=email)
    return Response(_view_dict(v), status=201)


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
@require_perm({'GET': ['project.view', 'employee.view'], 'PATCH': ['project.view', 'employee.view'], 'PUT': ['project.view', 'employee.view'], 'DELETE': ['project.view', 'employee.view']})
def project_view_detail(request, pk, vid):
    """Rename / change layout / save config / reorder (PATCH) or delete a view.
    The last view of a project cannot be deleted."""
    from .models import ProjectView
    v = ProjectView.objects.filter(pk=vid, project_id=pk).select_related('project').first()
    if not v:
        return _err('View not found', 404)
    if request.method == 'GET':
        return Response(_view_dict(v))
    if not _can_configure(request, v.project):
        return _err("You don't have permission to change this project's views.", 403)
    if request.method == 'DELETE':
        if ProjectView.objects.filter(project_id=pk).count() <= 1:
            return _err('A project needs at least one view.', 409)
        v.delete()
        return Response({'ok': True})
    body = request.data if hasattr(request.data, 'get') else {}
    if 'name' in body:
        name = ' '.join(str(body.get('name') or '').split())[:100]
        if not name:
            return _err('View name is required.')
        v.name = name
    if 'layout' in body:
        if body['layout'] not in VIEW_LAYOUTS:
            return _err('layout must be table, board or roadmap.')
        v.layout = body['layout']
    if 'config' in body:
        config, why = _clean_view_config(body.get('config'))
        if why:
            return _err(why)
        v.config = config
    if 'position' in body:
        try:
            v.position = int(body['position'])
        except (TypeError, ValueError):
            return _err('position must be a number.')
    v.save()
    return Response(_view_dict(v))


def _iterations(opts):
    try:
        start = _dt.date.fromisoformat(str(opts.get('start')))
    except (TypeError, ValueError):
        return []
    weeks = int(opts.get('weeks') or 2)
    count = int(opts.get('count') or 6)
    out = []
    for i in range(count):
        s = start + _dt.timedelta(weeks=weeks * i)
        e = s + _dt.timedelta(days=7 * weeks - 1)
        out.append({'id': s.isoformat(), 'title': 'Iteration %d' % (i + 1), 'start': s.isoformat(), 'end': e.isoformat()})
    return out


def _field_dict(f):
    opts = f.options if isinstance(f.options, dict) else {}
    d = {'id': f.id, 'projectId': f.project_id, 'name': f.name, 'type': f.field_type,
         'options': opts, 'position': f.position}
    if f.field_type == 'iteration':
        d['iterations'] = _iterations(opts)
    return d


def _clean_options(field_type, raw, old=None):
    """(options, error) for a field of ``field_type``."""
    raw = raw if raw is not None else {}
    if field_type == 'single_select':
        choices = raw.get('choices') if isinstance(raw, dict) else raw
        if not isinstance(choices, list) or not choices:
            return None, 'A single select field needs at least one option.'
        if len(choices) > 50:
            return None, 'A single select field can have at most 50 options.'
        old_ids = {c.get('id') for c in ((old or {}).get('choices') or []) if isinstance(c, dict)}
        out, names = [], set()
        for c in choices:
            if isinstance(c, str):
                c = {'name': c}
            if not isinstance(c, dict):
                return None, 'Each option needs a name.'
            name = ' '.join(str(c.get('name') or '').split())[:60]
            if not name:
                return None, 'Each option needs a name.'
            if name.lower() in names:
                return None, 'Option "%s" is listed twice.' % name
            names.add(name.lower())
            color = c.get('color') or 'gray'
            if color not in FIELD_COLORS:
                return None, 'Option colours: ' + ', '.join(FIELD_COLORS)
            cid = c.get('id') if c.get('id') in old_ids else _secrets.token_hex(4)
            out.append({'id': cid, 'name': name, 'color': color,
                        'description': str(c.get('description') or '')[:120]})
        return {'choices': out}, ''
    if field_type == 'iteration':
        if not isinstance(raw, dict):
            return None, 'Iteration options must be an object.'
        try:
            weeks = int(raw.get('weeks') or 2)
            count = int(raw.get('count') or 6)
        except (TypeError, ValueError):
            return None, 'Iteration length and count must be numbers.'
        if not 1 <= weeks <= 8:
            return None, 'An iteration lasts 1 to 8 weeks.'
        if not 1 <= count <= 52:
            return None, 'Between 1 and 52 iterations.'
        start = raw.get('start') or ''
        try:
            start = _dt.date.fromisoformat(str(start)) if start else None
        except ValueError:
            return None, 'Iteration start must be a date (YYYY-MM-DD).'
        if start is None:
            today = _dt.date.today()
            start = today - _dt.timedelta(days=today.weekday())
        return {'weeks': weeks, 'count': count, 'start': start.isoformat()}, ''
    return {}, ''


def _name_problem(project, name, exclude_id=None):
    if not name:
        return 'Field name is required.'
    if name.lower() in RESERVED_FIELD_NAMES:
        return '"%s" is a built-in field. Choose another name.' % name
    qs = project.fields.filter(name__iexact=name)
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    if qs.exists():
        return 'This project already has a field named "%s".' % name
    return ''


def _prune_values(field):
    """Drop values that no longer fit the field's options (removed option,
    iteration outside the new range)."""
    if field.field_type == 'single_select':
        ok = {c['id'] for c in (field.options or {}).get('choices') or []}
    elif field.field_type == 'iteration':
        ok = {i['id'] for i in _iterations(field.options or {})}
    else:
        return 0
    stale = [v.id for v in field.values.all() if v.value not in ok]
    if stale:
        from .models import TaskFieldValue
        TaskFieldValue.objects.filter(pk__in=stale).delete()
    return len(stale)


@api_view(['GET', 'POST'])
@require_perm({'GET': ['project.view', 'employee.view'], 'POST': ['project.view', 'employee.view']})
def project_fields_list(request, pk):
    """GET: the project's custom fields. POST {name, type, options}: a new
    field (text | number | date | single_select | iteration)."""
    from .models import ProjectField
    project = _project_or_404(pk)
    if not project:
        return _err('Project not found', 404)
    if request.method == 'GET':
        return Response([_field_dict(f) for f in project.fields.all()])
    if not _can_configure(request, project):
        return _err("You don't have permission to change this project's fields.", 403)
    body = request.data if hasattr(request.data, 'get') else {}
    name = ' '.join(str(body.get('name') or '').split())[:100]
    why = _name_problem(project, name)
    if why:
        return _err(why)
    ftype = str(body.get('type') or body.get('fieldType') or 'text')
    if ftype not in ProjectField.TYPES:
        return _err('type must be one of: ' + ', '.join(ProjectField.TYPES))
    opts, why = _clean_options(ftype, body.get('options'))
    if why:
        return _err(why)
    last = project.fields.order_by('-position').values_list('position', flat=True).first()
    email, _ = _caller(request)
    f = ProjectField.objects.create(project=project, name=name, field_type=ftype, options=opts,
                                    position=(last + 1) if last is not None else 0, created_by=email)
    return Response(_field_dict(f), status=201)


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
@require_perm({'GET': ['project.view', 'employee.view'], 'PATCH': ['project.view', 'employee.view'], 'PUT': ['project.view', 'employee.view'], 'DELETE': ['project.view', 'employee.view']})
def project_field_detail(request, pk, fid):
    """Rename / change options / reorder (PATCH) or delete a field (its values
    on every issue go with it). The type cannot change."""
    from .models import ProjectField
    f = ProjectField.objects.filter(pk=fid, project_id=pk).select_related('project').first()
    if not f:
        return _err('Field not found', 404)
    if request.method == 'GET':
        return Response(_field_dict(f))
    if not _can_configure(request, f.project):
        return _err("You don't have permission to change this project's fields.", 403)
    if request.method == 'DELETE':
        n = f.values.count()
        f.delete()
        return Response({'ok': True, 'valuesRemoved': n})
    body = request.data if hasattr(request.data, 'get') else {}
    new_type = body.get('type') or body.get('fieldType')
    if new_type and new_type != f.field_type:
        return _err("A field's type cannot be changed. Create a new field instead.")
    if 'name' in body:
        name = ' '.join(str(body.get('name') or '').split())[:100]
        why = _name_problem(f.project, name, exclude_id=f.id)
        if why:
            return _err(why)
        f.name = name
    if 'options' in body:
        opts, why = _clean_options(f.field_type, body.get('options'), old=f.options or {})
        if why:
            return _err(why)
        f.options = opts
    if 'position' in body:
        try:
            f.position = int(body['position'])
        except (TypeError, ValueError):
            return _err('position must be a number.')
    f.save()
    removed = _prune_values(f) if 'options' in body else 0
    d = _field_dict(f)
    d['valuesRemoved'] = removed
    return Response(d)


def clean_field_value(field, value):
    """(value or None, error) for storing ``value`` in ``field``."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, ''
    t = field.field_type
    if t == 'text':
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            return None, 'Text expected.'
        v = str(value).strip()
        if len(v) > 1024:
            return None, 'Text must be 1024 characters or fewer.'
        return v, ''
    if t == 'number':
        if isinstance(value, bool):
            return None, 'A number is required.'
        try:
            v = float(str(value).strip()) if isinstance(value, str) else float(value)
        except (TypeError, ValueError):
            return None, 'A number is required.'
        if not _math.isfinite(v) or abs(v) > 1e12:
            return None, 'A number is required.'
        return (int(v) if v == int(v) else v), ''
    if t == 'date':
        try:
            return _dt.date.fromisoformat(str(value).strip()[:10]).isoformat(), ''
        except ValueError:
            return None, 'A date (YYYY-MM-DD) is required.'
    if t == 'single_select':
        choices = (field.options or {}).get('choices') or []
        for c in choices:
            if value == c.get('id'):
                return c['id'], ''
        for c in choices:
            if str(value).strip().lower() == str(c.get('name', '')).lower():
                return c['id'], ''
        return None, "Pick one of the field's options."
    if t == 'iteration':
        for it in _iterations(field.options or {}):
            if str(value) in (it['id'], it['title']):
                return it['id'], ''
        return None, "Pick one of the field's iterations."
    return None, 'Unknown field type.'


@api_view(['PUT', 'DELETE'])
@require_perm({'PUT': 'task.edit', 'DELETE': 'task.edit'})
def task_field_value(request, task_pk, fid):
    """PUT {value}: set a project field on an issue (null/'' clears it);
    DELETE clears it. The field must belong to the issue's project."""
    from django.utils import timezone
    from .models import ProjectField, TaskFieldValue
    task = EmployeeTask.objects.filter(pk=task_pk).first()
    if not task:
        return _err('Task not found', 404)
    field = ProjectField.objects.filter(pk=fid).first()
    if not field:
        return _err('Field not found', 404)
    if task.project_id != field.project_id:
        return _err('This field belongs to another project. Move the issue to that project first.')
    value = None
    if request.method == 'PUT':
        body = request.data if hasattr(request.data, 'get') else {}
        if 'value' not in body:
            return _err('value is required (null clears it).')
        value, why = clean_field_value(field, body.get('value'))
        if why:
            return _err(why)
    if value is None:
        TaskFieldValue.objects.filter(task=task, field=field).delete()
    else:
        TaskFieldValue.objects.update_or_create(task=task, field=field, defaults={'value': value})
    EmployeeTask.objects.filter(pk=task.pk).update(updated_at=timezone.now())
    values = {str(k): v for k, v in TaskFieldValue.objects.filter(task=task).values_list('field_id', 'value')}
    return Response({'taskId': task.id, 'fieldId': field.id, 'value': value, 'fields': values})
