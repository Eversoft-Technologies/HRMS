"""Scheduled attendance alerts: late/absent notices and the HR digest.

Kept out of views.py so it can be driven by cron (``manage.py attendance_alerts``)
without importing the request layer, and so each rule is testable on its own by
passing an explicit ``now``.

Every rule is idempotent. The commands are expected to run repeatedly — every
15 minutes for the late sweep — and an employee must not be mailed twice for
the same day. That is what the ``*_alert_sent_at`` stamps are for.
"""
import logging

from django.db.models import Q

from . import mailer
from .models import AppUser, EmployeeAttendance, Shift, ShiftAssignment, WfhRequest
from .timeutil import local_now

logger = logging.getLogger(__name__)


def _active_shift(email, on_date):
    """Same resolution the check-in uses: assignment first, else the default."""
    assignment = (ShiftAssignment.objects
                  .filter(email=email, effective_from__lte=on_date)
                  .filter(Q(effective_to__isnull=True) | Q(effective_to__gte=on_date))
                  .select_related('shift').first())
    if assignment and assignment.shift:
        return assignment.shift
    return Shift.objects.filter(id=1).first() or Shift.objects.filter(is_active=True).first()


def _staff():
    """Everyone expected to clock in. Excludes deactivated accounts."""
    return AppUser.objects.filter(status='active')


def _on_leave_or_wfh(email, on_date):
    return WfhRequest.objects.filter(
        email=email, status='Approved',
        from_date__lte=on_date, to_date__gte=on_date,
    ).exists()


def run_late_sweep(now=None, dry_run=False):
    """Notify anyone past their shift start + grace who has not checked in.

    Returns the list of emails notified. Safe to run every few minutes: the
    ``late_alert_sent_at`` stamp makes it once per person per day.
    """
    now = now or local_now()
    today = now.date()
    notified = []

    for user in _staff():
        email = (user.email or '').strip()
        if not email:
            continue

        shift = _active_shift(email, today)
        if not shift or shift.is_flexible:
            continue                      # nothing to be late for

        from datetime import datetime, timedelta
        start = datetime.combine(today, shift.start_time)
        deadline = start + timedelta(minutes=shift.grace_minutes or 0)
        if now < deadline:
            continue                      # still within grace

        row = EmployeeAttendance.objects.filter(email=email, date=today).first()
        if row and row.check_in:
            continue                      # already in
        if row and row.late_alert_sent_at:
            continue                      # already told them today
        if _on_leave_or_wfh(email, today):
            continue                      # approved WFH is not "absent"

        late_by = int((now - deadline).total_seconds() // 60)
        if dry_run:
            notified.append(email)
            continue

        if row is None:
            row = EmployeeAttendance.objects.create(
                email=email, employee_name=user.full_name or '', date=today, status='absent',
            )

        _send_late_mail(user, row, shift, late_by)
        row.late_alert_sent_at = now
        row.status = row.status or 'absent'
        row.save(update_fields=['late_alert_sent_at', 'status'])
        notified.append(email)

    return notified


def _send_late_mail(user, row, shift, late_by):
    hours, minutes = divmod(max(late_by, 0), 60)
    late_text = (f'{hours}h {minutes}m' if hours else f'{minutes} minutes')
    try:
        html = mailer.render_branded(
            greeting=user.full_name or user.email,
            title='We have not seen your check-in today',
            intro=(
                f'Your shift started at <strong>{shift.start_time:%H:%M}</strong> and there is '
                f'no check-in recorded, now {late_text} past the grace period.<br><br>'
                'If you are working, please check in. If you are on leave or unwell, '
                'let your manager know so the day can be recorded correctly.'
            ),
            highlight_html=mailer.render_details_card('Today', [
                ('Date', f'{row.date:%d %B %Y}'),
                ('Shift', shift.name),
                ('Expected by', f'{shift.start_time:%H:%M} (+{shift.grace_minutes or 0} min grace)'),
            ]),
        )
        mailer.send_email(
            to=user.email,
            subject='No check-in recorded for today',
            html=html,
            text=(f'Your shift started at {shift.start_time:%H:%M} and no check-in is '
                  f'recorded ({late_text} past grace).'),
        )
    except Exception:
        logger.exception('late alert mail failed for %s', user.email)

    from .views import create_notification
    create_notification(
        user.email, 'No check-in recorded',
        f'Your shift started at {shift.start_time:%H:%M}. Please check in.',
        'warning', '/employees/attendance',
    )


def collect_digest(now=None):
    """The numbers behind the HR digest, as plain data so it can be asserted."""
    now = now or local_now()
    today = now.date()

    rows = EmployeeAttendance.objects.filter(date=today)
    pending = EmployeeAttendance.objects.filter(location_status='Pending')

    checked_in = [r for r in rows if r.check_in]
    still_open = [r for r in checked_in if not r.check_out]
    late = [r for r in rows if (r.late_minutes or 0) > 0]
    long_days = [r for r in rows if (r.worked_minutes or 0) >= 540]

    expected = _staff().count()
    absent = max(expected - len(checked_in), 0)

    return {
        'date': today,
        'expected': expected,
        'checkedIn': len(checked_in),
        'absent': absent,
        'late': len(late),
        'stillOpen': len(still_open),
        'longDays': len(long_days),
        'pendingApprovals': pending.count(),
        'pendingRows': list(pending.order_by('-date')[:20]),
        'lateRows': late[:20],
    }


def send_hr_digest(now=None, recipients=None):
    """Mail HR one summary of the day. Returns the addresses it went to."""
    now = now or local_now()
    data = collect_digest(now)

    if recipients is None:
        from .permissions import _is_super_admin, _user_has_perm
        recipients = [
            u.email for u in _staff()
            if u.email and (_is_super_admin(u) or _user_has_perm(u, 'attendance.view'))
        ]
    recipients = sorted(set(r for r in recipients if r))
    if not recipients:
        logger.warning('attendance digest: nobody holds attendance.view')
        return []

    pending_html = ''
    if data['pendingRows']:
        pending_html = '<div style="font-size:13px;margin:0 0 6px;font-weight:700">' \
                       'Waiting on you</div><ul style="margin:0 0 18px;padding-left:18px;' \
                       'font-size:13px;color:#475569;line-height:1.7">' + ''.join(
            f'<li>{r.employee_name or r.email} — {r.date:%d %b} — '
            f'&ldquo;{(r.location_reason or "")[:80]}&rdquo;</li>'
            for r in data['pendingRows']
        ) + '</ul>'

    html = mailer.render_branded(
        title=f'Attendance summary — {data["date"]:%d %B %Y}',
        intro='Here is where today stands.',
        highlight_html=(
            mailer.render_details_card('Today', [
                ('Expected', data['expected']),
                ('Checked in', data['checkedIn']),
                ('Not checked in', data['absent']),
                ('Late', data['late']),
                ('Still checked in', data['stillOpen']),
                ('Over 9 hours', data['longDays']),
                ('Off-site approvals waiting', data['pendingApprovals']),
            ]) + pending_html
        ),
        footer='Sent once a day. Approvals are actioned in Attendance Settings.',
        signoff=False,
    )
    text = (f"Attendance {data['date']:%d %b %Y} — checked in {data['checkedIn']}/"
            f"{data['expected']}, late {data['late']}, still open {data['stillOpen']}, "
            f"approvals waiting {data['pendingApprovals']}.")

    for addr in recipients:
        try:
            mailer.send_email(to=addr, subject=text.split(' — ')[0], html=html, text=text)
        except Exception:
            logger.exception('digest mail failed for %s', addr)
    return recipients
