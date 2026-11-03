"""Per-user notification preferences (Settings > Notifications).

Each category can be switched off by the person who receives it. Senders tag
a notification with its category (``create_notification(..., category=...)``)
and it is simply not delivered to anyone who switched that category off.
Untagged notifications (security, account, attendance, tasks, ...) are always
delivered.

``active`` says whether the app currently sends anything in that category, so
the settings page can be honest about toggles that have nothing to control
yet; the stored choice applies as soon as such notifications exist.
"""
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import NotificationPreference
from .permissions import require_perm

# key, label, channels actually used, default, currently sent?
CATEGORIES = [
    ('payroll_approvals', 'Payroll approval reminders', 'In-app', True, False),
    ('attrition_risk', 'Attrition risk alerts', 'In-app', True, False),
    ('leave_approvals', 'Leave request approvals', 'In-app', True, True),
    ('job_applications', 'New job applications', 'In-app', False, False),
    ('survey_reports', 'Survey completion reports', 'In-app', True, False),
    ('compliance_deadlines', 'Compliance deadline alerts', 'In-app', True, False),
    ('onboarding_milestones', 'Onboarding milestone nudges', 'In-app', True, True),
    ('ai_digest', 'AI insight digest', 'In-app (weekly)', False, False),
]
KEYS = {c[0] for c in CATEGORIES}
DEFAULTS = {c[0]: c[3] for c in CATEGORIES}


def _norm(v):
    return str(v or '').strip().lower()


def prefs_for(email):
    """Effective {category: bool} for a user (stored choices over defaults)."""
    row = NotificationPreference.objects.filter(pk=_norm(email)).first()
    stored = row.prefs if row and isinstance(row.prefs, dict) else {}
    return {k: bool(stored[k]) if k in stored else DEFAULTS[k] for k in DEFAULTS}


def allows(email, category):
    """Should a ``category`` notification reach ``email``? Unknown/None = yes."""
    if not category or category not in KEYS:
        return True
    try:
        return prefs_for(email)[category]
    except Exception:
        return True   # a preferences problem must never swallow notifications


def _payload(email):
    p = prefs_for(email)
    return {
        'email': _norm(email),
        'categories': [{
            'key': k, 'label': label, 'channels': channels, 'default': default,
            'active': active, 'enabled': p[k],
        } for k, label, channels, default, active in CATEGORIES],
    }


@api_view(['GET', 'PUT'])
@require_perm({'GET': 'settings.view', 'PUT': 'settings.manage'}, or_self=True)
def notification_preferences(request, email):
    """GET: the user's preferences. PUT {prefs: {key: bool}}: update some or all.
    Everyone manages their own; changing someone else's needs settings.manage."""
    email = _norm(email)
    if not email:
        return Response({'message': 'email is required'}, status=400)
    if request.method == 'PUT':
        incoming = request.data.get('prefs') if hasattr(request.data, 'get') else None
        if not isinstance(incoming, dict) or not incoming:
            return Response({'message': 'prefs must be an object of {category: true/false}'}, status=400)
        unknown = [k for k in incoming if k not in KEYS]
        if unknown:
            return Response({'message': 'Unknown notification category: ' + ', '.join(sorted(unknown))}, status=400)
        if any(not isinstance(v, bool) for v in incoming.values()):
            return Response({'message': 'Each preference must be true or false.'}, status=400)
        row, _ = NotificationPreference.objects.get_or_create(email=email, defaults={'prefs': {}})
        prefs = dict(row.prefs or {})
        prefs.update(incoming)
        row.prefs = prefs
        row.save()
    return Response(_payload(email))
