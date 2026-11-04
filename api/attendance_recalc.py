"""Recalculate worked time / overtime for closed attendance days.

Days saved before multi-session days added up kept only their last session.
Each day is rebuilt from its check-in / check-out events (each session minus
its own breaks). Used by ``manage.py recalc_attendance`` and by Attendance
Administration › Recalculate Hours (GET = preview, POST = apply).

Safety rules (both entry points):
  * preview first; nothing changes until an explicit apply;
  * the default range starts on the 1st of the current month — earlier
    (possibly already paid) months must be asked for explicitly;
  * a day whose event trail does not pair up is reported and left alone;
  * every applied change is recorded on that day's timeline.
"""
from datetime import datetime

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .permissions import require_perm


def month_start(today=None):
    from .timeutil import local_today
    return (today or local_today()).replace(day=1)


def parse_day(s, default):
    if not s:
        return default
    return datetime.strptime(str(s).strip()[:10], '%Y-%m-%d').date()


def preview(d_from, d_to, email=None):
    """([(att, new_worked, new_overtime)], [skipped att]) for closed days in range."""
    from . import views as v
    from .models import EmployeeAttendance, Shift
    qs = (EmployeeAttendance.objects
          .filter(date__gte=d_from, date__lte=d_to, check_in__isnull=False, check_out__isnull=False)
          .order_by('date', 'email'))
    if email:
        qs = qs.filter(email=email.strip().lower())
    changes, skipped = [], []
    for att in qs:
        if v._is_checked_in(att):
            continue
        worked = v._recompute_worked(att)
        if worked is None:
            skipped.append(att)
            continue
        shift = (Shift.objects.filter(pk=att.shift_id).first() if att.shift_id else None) \
            or v._get_active_shift(att.email, att.date)
        ot = v._overtime_for(worked, shift)
        if worked != (att.worked_minutes or 0) or ot != (att.overtime_minutes or 0):
            changes.append((att, worked, ot))
    return changes, skipped


def apply(changes, actor=''):
    from . import views as v
    from .models import AttendanceEvent
    from .timeutil import local_now
    now = local_now()
    with transaction.atomic():
        for att, worked, ot in changes:
            note = (f'{actor + ": " if actor else ""}worked {v._fmt_dur(att.worked_minutes or 0)} → '
                    f'{v._fmt_dur(worked)} (all sessions)')
            att.worked_minutes, att.overtime_minutes = worked, ot
            att.save(update_fields=['worked_minutes', 'overtime_minutes'])
            AttendanceEvent.objects.create(email=att.email, employee_name=att.employee_name, date=att.date,
                                           event='recalculated', location=note[:120], at=now)


def _row(att, worked=None, ot=None):
    d = {'id': att.id, 'date': att.date.isoformat(), 'email': att.email,
         'employee': att.employee_name or att.email.split('@')[0]}
    if worked is not None:
        d.update({'oldWorkedMinutes': att.worked_minutes or 0, 'newWorkedMinutes': worked,
                  'oldOvertimeMinutes': att.overtime_minutes or 0, 'newOvertimeMinutes': ot})
    return d


@api_view(['GET', 'POST'])
@require_perm('attendance.edit')
def attendance_recalculate(request):
    """GET ?from=&to=&email= → what would change (nothing is written).
    POST {from, to, email, expect, allowClosedMonths} → write it. ``expect`` is
    the number of changes the preview showed: if the data moved since, the
    apply is refused so nobody writes figures they have not seen."""
    from .views import err, _actor_identity
    src = request.query_params if request.method == 'GET' else (request.data or {})
    first = month_start()
    try:
        from .timeutil import local_today
        d_from = parse_day(src.get('from'), first)
        d_to = parse_day(src.get('to'), local_today())
    except ValueError:
        return err('Dates must be YYYY-MM-DD.')
    if d_from > d_to:
        return err('"From" must be on or before "To".')
    email = (src.get('email') or '').strip().lower() or None
    closed = d_from < first
    changes, skipped = preview(d_from, d_to, email)

    if request.method == 'POST':
        if closed and not src.get('allowClosedMonths'):
            return err(f'The range starts before {first:%d %b %Y}. Earlier months may already be paid — '
                       f'confirm that you want to change them.', 400)
        try:
            expect = int(src.get('expect'))
        except (TypeError, ValueError):
            return err('Preview first, then apply the changes you saw.')
        if expect != len(changes):
            return Response({'message': f'The records changed since the preview ({expect} → {len(changes)} '
                                        f'days). Preview again before applying.', 'code': 'PREVIEW_STALE'},
                            status=409)
        actor, _name = _actor_identity(request)
        apply(changes, actor or '')
        return Response({'applied': len(changes), 'skipped': [_row(a) for a in skipped],
                         'from': d_from.isoformat(), 'to': d_to.isoformat()})

    return Response({
        'from': d_from.isoformat(), 'to': d_to.isoformat(), 'email': email or '',
        'monthStart': first.isoformat(), 'includesClosedMonths': closed,
        'changes': [_row(a, w, o) for a, w, o in changes],
        'skipped': [_row(a) for a in skipped],
    })
