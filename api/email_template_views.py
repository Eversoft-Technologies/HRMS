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

COMPANY = 'EverSoft Technologies LLC'
OUTCOMES = ('Selected', 'Waitlisted', 'Rejected')
TEMPLATE_LABELS = {
    'Selected': ('Selected — Offer', 'Selected — Formal Letter', 'Selected — Welcome'),
    'Waitlisted': (
        'Waitlisted — Reserve Shortlist',
        'Waitlisted — Decision Delayed',
        'Waitlisted — Active Pipeline',
    ),
    'Rejected': (
        'Rejected — Standard Decline',
        'Rejected — With Feedback',
        'Rejected — Future Opportunities',
    ),
}
TEMPLATE_ORDER = {
    name: index
    for index, name in enumerate(
        label for outcome in OUTCOMES for label in TEMPLATE_LABELS[outcome]
    )
}


def _builtin_defaults():
    """The three shipped variants for each follow-up outcome."""
    from .views import _followup_template
    variants = {
        'Selected': [
            (
                'Your Formal Offer — {{company}}',
                'Dear {{name}},<br><br>On behalf of {{company}}, it is with great pleasure that we '
                'extend to you this formal offer of employment for the position of '
                '<strong>{{role}}</strong>.<br><br>Your background, expertise, and the professionalism '
                'you demonstrated throughout the selection process made a lasting impression. We are '
                'confident this is the beginning of a rewarding and long-term partnership.<br><br>'
                '<strong>OFFER SUMMARY</strong><br><ul>'
                '<li>Position: {{role}}</li>'
                '<li>Department: As detailed in your formal offer</li>'
                '<li>Start Date: As stated in your formal offer</li>'
                '<li>Annual Compensation: As detailed in your formal offer</li>'
                '<li>Employment Type: As detailed in your formal offer</li>'
                '<li>Reporting To: As detailed in your formal offer</li></ul>'
                'Please review all details and confirm your acceptance by the deadline stated in your '
                'formal offer. Your recruiter will follow up with the formal documents shortly.<br><br>'
                'With great pleasure,<br>{{company}} Talent Team',
            ),
            (
                'Welcome to the {{company}} Family!',
                'Dear {{name}},<br><br>The offer has been confirmed, and we could not be more thrilled. '
                'Welcome to {{company}}! You are joining a team that values curiosity, collaboration, '
                'and impact.<br><br>As our new <strong>{{role}}</strong>, you will have the opportunity '
                'to work on meaningful challenges alongside driven people. We are genuinely excited to '
                'see what we will build together.<br><br>'
                '<strong>YOUR ONBOARDING JOURNEY</strong><br><ol>'
                '<li>Documents &amp; Verification: HR will reach out to complete paperwork within 48 hours.</li>'
                '<li>Equipment Setup: Your laptop and access credentials will be ready before Day 1.</li>'
                '<li>First Day: On the date stated in your offer, meet your team, attend orientation, and get settled in.</li>'
                '<li>30-Day Check-in: Meet 1:1 with your manager to align on goals and expectations.</li></ol>'
                'Questions before Day 1? Reach out to your recruiter. We are here for you every step of the way.'
                '<br><br>With excitement and warmth,<br>{{company}} Talent Team',
            ),
        ],
        'Waitlisted': [
            (
                'A Brief Update on Your Application — {{company}}',
                'Dear {{name}},<br><br>We want to reach out regarding your interview for the '
                '<strong>{{role}}</strong> position and provide a transparent update on where things stand.'
                '<br><br>Our hiring decision has been temporarily paused due to internal team '
                'restructuring. This is in no way a reflection of your candidacy: you remain among our '
                'strongest applicants, and we hold your application in high regard.<br><br>'
                '<strong>EXPECTED TIMELINE</strong><br><ul>'
                '<li>Current status: Decision on hold while internal review is in progress.</li>'
                '<li>Next update: Your assigned recruiter will share the decision timeline with you.</li>'
                '<li>Your position: Priority candidate; no re-interview is needed.</li>'
                '<li>Point of contact: Your assigned recruiter.</li></ul>'
                'We sincerely apologize for the uncertainty and appreciate your patience. Your assigned '
                'recruiter will share a final decision as soon as the review is complete.<br><br>'
                'With transparency and respect,<br>{{company}} Talent Team',
            ),
            (
                "You're in Our Active Talent Pipeline — {{company}}",
                'Dear {{name}},<br><br>We wanted to personally reach out following your interview for '
                'the <strong>{{role}}</strong> position. While we have filled the immediate opening, '
                'we are actively exploring additional opportunities and your profile is the kind of '
                'talent we are looking for.<br><br>You have been added to our Active Talent Pipeline, '
                'a curated group of high-potential candidates we consider as new opportunities emerge. '
                'This is a deliberate decision by our hiring team.<br><br>'
                '<strong>WHAT BEING IN THE PIPELINE MEANS</strong><br><ul>'
                '<li>Priority access: You can skip the initial screening for a future matched role.</li>'
                '<li>Direct notification: Your recruiter will contact you before matched roles are publicly posted.</li>'
                '<li>Dedicated contact: Your assigned recruiter remains your point of contact.</li>'
                '<li>Active for six months from the date of this update.</li></ul>'
                'Thank you for considering {{company}}. We look forward to finding the right opportunity.'
                '<br><br>With optimism and appreciation,<br>{{company}} Talent Team',
            ),
        ],
        'Rejected': [
            (
                'Your Application Outcome & Feedback — {{company}}',
                'Dear {{name}},<br><br>Thank you for interviewing for the '
                '<strong>{{role}}</strong> role at {{company}}. We valued the time you dedicated and '
                'the thoughtful answers you shared throughout the process.<br><br>'
                'After careful deliberation, we have decided to proceed with another candidate whose '
                'experience more closely aligns with our current needs. If you would like a personalized '
                'feedback summary on your interview, please contact your assigned recruiter.<br><br>'
                'We hope that feedback will support your continued growth. We would genuinely welcome '
                'your application for a future role at {{company}}.<br><br>'
                'With respect and gratitude,<br>{{company}} Talent Team',
            ),
            (
                "We'd Love to Stay in Touch — {{company}}",
                'Dear {{name}},<br><br>Thank you for interviewing for the '
                '<strong>{{role}}</strong> position. Your conversation left a genuine impression on our '
                'team. We have moved forward with a candidate whose experience more closely matched the '
                'immediate requirements of this role.<br><br>'
                'We would like to keep the relationship open. As {{company}} grows, the right opportunity '
                'for someone with your background may be just around the corner.<br><br>'
                '<strong>STAY CONNECTED WITH {{company}}</strong><br><ul>'
                '<li>Your profile will remain active in our talent pool for 12 months.</li>'
                '<li>Subscribe to our careers page for new openings.</li>'
                '<li>Follow {{company}} on LinkedIn for company news.</li>'
                '<li>Reach out to your assigned recruiter if a new role interests you.</li></ul>'
                'We wish you the very best in your search and hope our paths cross again soon.'
                '<br><br>With warm regards,<br>{{company}} Talent Team',
            ),
        ],
    }
    out = []
    for outcome in OUTCOMES:
        subject, body = _followup_template(outcome, '{{name}}', '{{role}}')
        defaults = [(subject, body)] + variants[outcome]
        for index, (variant_subject, variant_body) in enumerate(defaults):
            out.append({
            'name': TEMPLATE_LABELS[outcome][index],
                'outcome': outcome,
                # The base helper uses the literal company name; store a token instead.
                'subject': variant_subject.replace('EverSoft Technologies LLC', '{{company}}'),
                'body': variant_body.replace('EverSoft Technologies LLC', '{{company}}'),
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
        include_all_outcomes = request.query_params.get('allOutcomes') == '1'
        if outcome and not include_all_outcomes:
            # Matching outcome first, then the ones that suit any outcome.
            qs = qs.filter(outcome__in=[outcome, ''])
        ctx = _ctx(request)
        rows = sorted(qs, key=lambda t: (t.outcome.lower() != outcome.lower(),
                                         not t.is_builtin,
                                         TEMPLATE_ORDER.get(t.name, len(TEMPLATE_ORDER)),
                                         t.name.lower()))
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
