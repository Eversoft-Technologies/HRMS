"""
Reusable candidate follow-up email templates.

    GET    /api/email-templates?outcome=Selected   list (seeds built-ins once)
    POST   /api/email-templates                    create
    GET    /api/email-templates/<id>               read
    PUT    /api/email-templates/<id>               update
    DELETE /api/email-templates/<id>               delete (built-ins reset instead)

Subject and body may contain {{name}}, {{role}}, {{company}} and {{outcome}};
`?name=&role=` on the list/read endpoints fills them in for a given candidate so
the drawer shows ready-to-send text.
"""
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import EmailTemplate
# render_placeholders lives in views so the send path and the preview share one
# definition — they must resolve placeholders identically.
from .views import err, render_placeholders

COMPANY = 'Eversoft'
OUTCOMES = ('Selected', 'Waitlisted', 'Rejected')


def _builtin_defaults():
    """The three shipped templates, sourced from views._followup_template so
    there is a single definition of the wording."""
    from .views import _followup_template
    out = []
    for outcome in OUTCOMES:
        subject, body = _followup_template(outcome, '{{name}}', '{{role}}')
        out.append({
            'name': f'{outcome} — default',
            'outcome': outcome,
            # _followup_template bakes the literal values in; re-templatise them.
            'subject': subject.replace(COMPANY, '{{company}}'),
            'body': body.replace(COMPANY, '{{company}}'),
        })
    return out


def seed_builtins():
    """Create the built-in templates once. Safe to call on every list."""
    for spec in _builtin_defaults():
        EmailTemplate.objects.get_or_create(
            name=spec['name'],
            defaults={
                'outcome': spec['outcome'],
                'subject': spec['subject'],
                'body': spec['body'],
                'is_builtin': True,
            },
        )


def _ctx(request):
    return {
        'name': (request.query_params.get('name') or '').strip() or 'there',
        'role': (request.query_params.get('role') or '').strip() or 'the role',
        'company': (request.query_params.get('company') or '').strip() or COMPANY,
        'outcome': (request.query_params.get('outcome') or '').strip(),
    }


def _dict(t, ctx=None):
    subject, body = t.subject, t.body
    if ctx:
        subject, body = render_placeholders(subject, ctx), render_placeholders(body, ctx)
    return {
        'id': t.id, 'name': t.name, 'outcome': t.outcome,
        'subject': subject, 'body': body,
        'isBuiltin': t.is_builtin,
        # The un-rendered source, so the editor can save placeholders back.
        'rawSubject': t.subject, 'rawBody': t.body,
        'updatedAt': t.updated_at.strftime('%Y-%m-%d %H:%M') if t.updated_at else '',
    }


@api_view(['GET', 'POST'])
def email_templates(request):
    if request.method == 'GET':
        seed_builtins()
        qs = EmailTemplate.objects.all()
        outcome = (request.query_params.get('outcome') or '').strip()
        if outcome:
            # Matching outcome first, then the ones that suit any outcome.
            qs = qs.filter(outcome__in=[outcome, ''])
        ctx = _ctx(request)
        rows = sorted(qs, key=lambda t: (t.outcome.lower() != outcome.lower(),
                                         not t.is_builtin, t.name.lower()))
        return Response([_dict(t, ctx) for t in rows])

    name = (request.data.get('name') or '').strip()
    if not name:
        return err('name is required')
    if EmailTemplate.objects.filter(name=name).exists():
        return err('A template with this name already exists', 409)
    t = EmailTemplate.objects.create(
        name=name,
        outcome=(request.data.get('outcome') or '').strip(),
        subject=(request.data.get('subject') or '').strip(),
        body=request.data.get('body') or '',
        created_by=(request.data.get('userEmail') or ''),
    )
    return Response(_dict(t), status=201)


@api_view(['POST'])
def email_template_preview(request):
    """Render the exact email a candidate would receive.

    Uses the same build_followup_html() the send path uses, so the preview is
    not an approximation — it is the message, including the branded wrapper
    (or verbatim, if the body is already a full HTML document).
    """
    from .views import build_followup_html, html_to_text

    data = request.data or {}
    ctx = {
        'name': (data.get('name') or '').strip() or 'there',
        'role': (data.get('role') or '').strip() or 'the role',
        'company': (data.get('company') or '').strip() or COMPANY,
        'outcome': (data.get('outcome') or '').strip(),
    }
    subject = render_placeholders(data.get('subject') or '', ctx)
    body = render_placeholders(data.get('body') or '', ctx)
    html = build_followup_html(subject, body)
    return Response({
        'subject': subject,
        'html': html,
        'text': html_to_text(body),
        # True when the body is a complete document, so the UI can say the
        # branded wrapper was skipped.
        'standalone': html == body,
    })


@api_view(['GET', 'PUT', 'DELETE'])
def email_template_detail(request, pk):
    t = EmailTemplate.objects.filter(pk=pk).first()
    if not t:
        return err('Template not found', 404)

    if request.method == 'GET':
        return Response(_dict(t, _ctx(request)))

    if request.method == 'DELETE':
        if t.is_builtin:
            # Keep the built-ins available; restore the shipped wording instead.
            for spec in _builtin_defaults():
                if spec['name'] == t.name:
                    t.subject, t.body = spec['subject'], spec['body']
                    t.save(update_fields=['subject', 'body', 'updated_at'])
                    return Response(_dict(t))
        t.delete()
        return Response({'ok': True})

    data = request.data or {}
    if 'name' in data:
        new_name = (data.get('name') or '').strip()
        if not new_name:
            return err('name cannot be empty')
        if EmailTemplate.objects.filter(name=new_name).exclude(pk=t.pk).exists():
            return err('A template with this name already exists', 409)
        t.name = new_name
    if 'outcome' in data:
        t.outcome = (data.get('outcome') or '').strip()
    if 'subject' in data:
        t.subject = (data.get('subject') or '').strip()
    if 'body' in data:
        t.body = data.get('body') or ''
    t.save()
    return Response(_dict(t))
