"""Credit old interviews from the audit log.

``audit_logs`` is not a Django model — it predates this backend and nothing in
the current codebase writes to it any more — but it is still in the database and
it recorded ``interview.created`` with the actor's email. That is the only
surviving record of who scheduled an interview before ``created_by_email``
existed, so it is worth mining once.

Matching is deliberately conservative. An audit row carries the candidate's name
and role in ``detail`` and a timestamp written moments after the interview row,
so a candidate interview must agree on both fields and sit inside a narrow
window ending at the audit stamp. Where two interviews fit equally well the row
is left uncredited: the whole point of this column is that a name on it is
trustworthy, and a plausible guess is indistinguishable from a real attribution
once it is in the table.

Only rows with no creator are touched, so re-running changes nothing, and the
interviews this cannot match keep falling back to the dashboard's uncredited
bucket rather than being assigned to whoever was nearby.
"""

import json
from datetime import timedelta

from django.db import migrations

# The interview row is written first and the audit row moments later, so the
# window is mostly *before* the audit stamp. A few seconds of slack after it
# covers clock jitter between the two writes.
BEFORE = timedelta(minutes=10)
AFTER = timedelta(minutes=2)

# Two candidates inside the window are only separable if one is clearly closer.
AMBIGUITY_GAP = timedelta(seconds=60)


def _audit_rows(connection):
    """interview.created rows, or [] when the table is not in this database."""
    with connection.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_name = 'audit_logs'")
        if not cur.fetchone()[0]:
            return []
        cur.execute(
            "SELECT actor_email, target, CAST(detail AS CHAR), created_at "
            "FROM audit_logs WHERE action = 'interview.created' ORDER BY created_at")
        return cur.fetchall()


def forwards(apps, schema_editor):
    InterviewLink = apps.get_model('api', 'InterviewLink')
    AppUser = apps.get_model('api', 'AppUser')

    rows = _audit_rows(schema_editor.connection)
    if not rows:
        return

    names = {
        (u.email or '').strip().lower(): (u.full_name or '').strip()
        for u in AppUser.objects.all()
    }

    taken = set()
    for actor_email, target, detail, logged_at in rows:
        # Early rows recorded the actor in `target` and left `actor_email` empty.
        actor = ((actor_email or '').strip() or (target or '').strip()).lower()
        if not actor or '@' not in actor:
            continue
        try:
            info = json.loads(detail or '{}')
        except (TypeError, ValueError):
            continue
        name = str(info.get('name') or '').strip()
        role = str(info.get('role') or '').strip()
        if not name or not logged_at:
            continue

        candidates = [
            iv for iv in InterviewLink.objects.filter(
                created_by_email='',
                created_at__gte=logged_at - BEFORE,
                created_at__lte=logged_at + AFTER,
            )
            if iv.pk not in taken
            and (iv.name or '').strip().lower() == name.lower()
            and (not role or (iv.role or '').strip().lower() == role.lower())
        ]
        if not candidates:
            continue

        candidates.sort(key=lambda iv: abs(iv.created_at - logged_at))
        if len(candidates) > 1:
            gap = abs(candidates[1].created_at - logged_at) - abs(candidates[0].created_at - logged_at)
            if gap < AMBIGUITY_GAP:
                continue  # two equally good fits — credit neither

        match = candidates[0]
        match.created_by_email = actor
        match.created_by_name = names.get(actor) or actor.split('@')[0]
        match.save(update_fields=['created_by_email', 'created_by_name'])
        taken.add(match.pk)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0048_interview_created_by'),
    ]

    # Not reversible in any useful sense: reversing would have to know which
    # rows this filled in versus which were credited normally, and clearing
    # both would throw away real attributions.
    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
