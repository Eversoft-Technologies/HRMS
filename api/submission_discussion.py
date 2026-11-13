"""Cross-team discussion on a work submission: collaborators + a comment thread.

Who can see a submission (and so its file and thread):
    HR (submission.view_all), the submitter, the routed reviewer, and anyone
    added as a collaborator.
Who can add or remove collaborators:
    HR, the submitter and the routed reviewer.
Who can comment:
    anyone who can see the submission.

Being a collaborator never grants approve / reject: that stays with
submission.action (see submission_detail in api/views.py).
"""
from django.db.models import Q
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import SubmissionCollaborator, SubmissionComment, WorkSubmission
from .permissions import check_perm

MAX_COMMENT = 4000
DT = '%Y-%m-%d %H:%M:%S'


def _norm(v):
    return str(v or '').strip().lower()


def _err(message, status=400):
    return Response({'message': message}, status=status)


def caller_of(request):
    """(email, user, sees_all) for the signed-in caller."""
    sees_all, email, user = check_perm(request, 'submission.view_all')
    return _norm(email), user, sees_all


def visible_q(email):
    """Queryset filter: submissions this (non-HR) person may see."""
    email = _norm(email) or '~'
    return Q(email=email) | Q(reviewer_email=email) | Q(collaborators__email=email)


def can_view(sub, email, sees_all):
    email = _norm(email)
    if sees_all:
        return True
    if not email:
        return False
    return (_norm(sub.email) == email or _norm(sub.reviewer_email) == email
            or sub.collaborators.filter(email=email).exists())


def can_manage(sub, email, sees_all):
    email = _norm(email)
    return bool(sees_all or (email and email in (_norm(sub.email), _norm(sub.reviewer_email))))


def participants(sub):
    """Everyone with a stake in the thread (for notifications)."""
    people = {_norm(sub.email), _norm(sub.reviewer_email)}
    people |= {_norm(e) for e in sub.collaborators.values_list('email', flat=True)}
    people |= {_norm(e) for e in sub.comments.values_list('author_email', flat=True)}
    people.discard('')
    return people


def _card(email):
    from .org_views import person_card
    return person_card(email) or {'email': email, 'name': email, 'initials': (email[:1] or '?').upper(),
                                  'key': email, 'designation': '', 'department': '', 'employeeId': ''}


def _comment_dict(c):
    return {'id': c.id, 'authorEmail': c.author_email, 'authorName': c.author_name or c.author_email,
            'body': c.body, 'createdAt': c.created_at.strftime(DT) if c.created_at else None}


def _thread(sub, email, sees_all):
    cards = []
    for e in sub.collaborators.values_list('email', flat=True):
        cards.append(_card(e))
    return {
        'id': sub.id,
        'title': sub.title,
        'status': sub.status,
        'submitter': _card(sub.email),
        'reviewer': _card(sub.reviewer_email) if sub.reviewer_email else None,
        'teamName': sub.team.name if sub.team_id and sub.team else '',
        'collaborators': cards,
        'comments': [_comment_dict(c) for c in sub.comments.all()],
        'canManage': can_manage(sub, email, sees_all),
    }


def _load(request, pk):
    email, user, sees_all = caller_of(request)
    if not email or not user:
        return None, None, None, _err('Authentication required. Please sign in again.', 401)
    sub = WorkSubmission.objects.filter(pk=pk).select_related('team').first()
    if sub is None or not can_view(sub, email, sees_all):
        return None, None, None, _err('Submission not found', 404)
    return sub, email, sees_all, None


@api_view(['GET'])
def thread(request, pk):
    """The submission's people and comments."""
    sub, email, sees_all, denied = _load(request, pk)
    if denied:
        return denied
    return Response(_thread(sub, email, sees_all))


@api_view(['POST'])
def comments(request, pk):
    sub, email, sees_all, denied = _load(request, pk)
    if denied:
        return denied
    body = str((request.data or {}).get('body') or '').strip()
    if not body:
        return _err('Write a comment first.')
    if len(body) > MAX_COMMENT:
        return _err(f'Comments are limited to {MAX_COMMENT} characters.')
    me = _card(email)
    c = SubmissionComment.objects.create(submission=sub, author_email=email, author_name=me['name'], body=body)
    from .org_views import notify
    for person in participants(sub) - {email}:
        notify(person, 'New comment on a work submission',
               f"{me['name']} commented on '{sub.title}': {body[:120]}",
               '/employees/submissions')
    return Response(_comment_dict(c), status=201)


@api_view(['POST'])
def collaborators(request, pk):
    sub, email, sees_all, denied = _load(request, pk)
    if denied:
        return denied
    if not can_manage(sub, email, sees_all):
        return _err('Only the submitter, the reviewer or HR can add people to this discussion.', 403)
    data = request.data or {}
    emails = data.get('emails') or ([data.get('email')] if data.get('email') else [])
    emails = [_norm(e) for e in emails if _norm(e)]
    if not emails:
        return _err('Choose someone to add.')
    from .org_views import known_emails, notify
    known = known_emails()
    unknown = [e for e in emails if e not in known]
    if unknown:
        return _err('Not an employee: ' + ', '.join(unknown))
    me = _card(email)
    for e in emails:
        if e in (_norm(sub.email), _norm(sub.reviewer_email)):
            continue                      # already part of it
        _, created = SubmissionCollaborator.objects.get_or_create(submission=sub, email=e, defaults={'added_by': email})
        if created:
            notify(e, 'Added to a work submission discussion',
                   f"{me['name']} added you to the discussion on '{sub.title}'.", '/employees/submissions')
    return Response(_thread(sub, email, sees_all), status=201)


@api_view(['DELETE'])
def collaborator_detail(request, pk, member):
    sub, email, sees_all, denied = _load(request, pk)
    if denied:
        return denied
    member = _norm(member)
    # Managers may remove anyone; a collaborator may leave on their own.
    if not (can_manage(sub, email, sees_all) or member == email):
        return _err('Only the submitter, the reviewer or HR can remove people.', 403)
    deleted, _ = SubmissionCollaborator.objects.filter(submission=sub, email=member).delete()
    if not deleted:
        return _err('Not a collaborator on this submission', 404)
    if member == email and not can_view(sub, email, sees_all):
        return Response({'ok': True, 'left': True})
    return Response(_thread(sub, email, sees_all))
