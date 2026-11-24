"""Day-by-day attendance history for one employee (profile > Attendance).

GET /api/attendance/history?email=&from=YYYY-MM-DD&to=YYYY-MM-DD
        [&status=present,late,…][&mode=office|wfh][&issues=1]
        [&page=1&pageSize=20][&export=csv]

Unlike /api/attendance (which lists stored rows only), every calendar day in
the range gets a row, so days with no punch are visible too:

    present | late | half-day | absent   from the stored attendance row
    working                              today, checked in, not out yet
    leave                                an approved leave covers the day
    holiday                              a day off on the employee's own calendar
    weekend                              outside the company work week
    pending                              today, not checked in yet
    absent                               a past working day with no record

A day with a late / early-out penalty (attendance_ext/penalties.py) carries
it in ``penalty`` ({id, kind, status, days, leaveType, label}) and its label
in ``detail`` (e.g. "Late arrival penalty: 0.5 day Casual Leave").

Same access rule as /api/attendance: attendance.view, or the employee
themselves. Days before the joining date and after today are left out.
"""
import csv
import io
from datetime import date, datetime, timedelta

from django.http import HttpResponse
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api.models import AttendancePenalty, EmployeeAttendance, LeaveRequest, UserProfile
from api.permissions import require_perm
from api.timeutil import local_today

MAX_DAYS = 366
PAGE_SIZES = (10, 20, 50, 100)
STATUSES = ('present', 'late', 'half-day', 'absent', 'working', 'leave', 'holiday', 'weekend', 'pending')
ISSUE_STATUSES = {'late', 'half-day', 'absent'}


def _parse(v):
    try:
        return datetime.strptime(str(v or '').strip()[:10], '%Y-%m-%d').date()
    except ValueError:
        return None


def _hm(dt):
    if not dt:
        return ''
    if timezone.is_aware(dt):
        dt = timezone.localtime(dt)
    return dt.strftime('%H:%M')


def _norm_status(s):
    s = (s or '').strip().lower().replace('_', '-').replace(' ', '-')
    return {'halfday': 'half-day', 'half': 'half-day', 'on-time': 'present'}.get(s, s or 'present')


def build_days(email, start, end, today=None):
    """All day rows for [start, end] (newest first). Pure read."""
    from api.team_hub import work_days
    from api.attendance_ext.holidays import HolidayResolver
    today = today or local_today()
    end = min(end, today)
    prof = UserProfile.objects.filter(email__iexact=email).only('start_date').first()
    if prof and prof.start_date and prof.start_date > start:
        start = prof.start_date
    if start > end:
        return []
    rows = {r.date: r for r in EmployeeAttendance.objects.filter(email__iexact=email, date__gte=start, date__lte=end)}
    leaves = list(LeaveRequest.objects.filter(email__iexact=email, status__iexact='approved',
                                              from_date__lte=end, to_date__gte=start)
                  .only('from_date', 'to_date', 'type'))
    try:
        hol = {}
        for h in HolidayResolver().holidays_for(email, start, end):
            if h.get('off'):
                d = h['date'] if isinstance(h['date'], date) else _parse(h['date'])
                if d:
                    hol[d] = h.get('name') or 'Holiday'
    except Exception:
        hol = {}
    week = work_days()
    pens = {}
    for p in AttendancePenalty.objects.filter(email__iexact=email, date__gte=start, date__lte=end).order_by('id'):
        pens.setdefault(p.date, []).append(p)
    out = []
    d = end
    while d >= start:
        r = rows.get(d)
        leave = next((lv for lv in leaves if lv.from_date <= d <= lv.to_date), None)
        item = {'date': d.isoformat(), 'weekday': d.strftime('%a'), 'checkIn': '', 'checkOut': '',
                'workedMinutes': 0, 'breakMinutes': 0, 'overtimeMinutes': 0, 'lateMinutes': 0,
                'mode': '', 'geoVerified': False, 'punchIssue': '', 'note': '', 'detail': ''}
        if r is not None:
            status = _norm_status(r.status)
            if d == today and r.check_in and not r.check_out:
                status = 'working'
            item.update({
                'checkIn': _hm(r.check_in), 'checkOut': _hm(r.check_out),
                'workedMinutes': r.worked_minutes or 0, 'breakMinutes': r.break_minutes or 0,
                'overtimeMinutes': r.overtime_minutes or 0, 'lateMinutes': r.late_minutes or 0,
                'mode': 'wfh' if r.is_wfh else ('office' if r.check_in else ''),
                'geoVerified': bool(r.geo_verified), 'punchIssue': getattr(r, 'punch_issue', '') or '',
                'note': (r.note or '')[:200],
            })
            if r.is_auto_checked_out:
                item['detail'] = 'Auto checked out'
            if leave is not None:
                item['detail'] = (item['detail'] + ' · ' if item['detail'] else '') + (leave.type or 'Leave')
        elif leave is not None:
            status, item['detail'] = 'leave', leave.type or 'Leave'
        elif d in hol:
            status, item['detail'] = 'holiday', hol[d]
        elif d.weekday() not in week:
            status = 'weekend'
        elif d == today:
            status = 'pending'
        else:
            status = 'absent'
        if d in pens:
            from .penalties import short_label
            labels = [short_label(p) for p in pens[d]]
            item['penalty'] = [{'id': p.id, 'kind': p.kind, 'status': p.status, 'days': float(p.days or 0),
                                'leaveType': p.leave_type or '', 'label': short_label(p)} for p in pens[d]]
            item['detail'] = ' · '.join(x for x in [item['detail']] + labels if x)
        item['status'] = status
        out.append(item)
        d -= timedelta(days=1)
    return out


def _filter(days, params):
    statuses = {s.strip().lower() for s in str(params.get('status') or '').split(',') if s.strip()}
    statuses &= set(STATUSES)
    mode = str(params.get('mode') or '').lower()
    issues = str(params.get('issues') or '') in ('1', 'true', 'yes')
    out = []
    for x in days:
        if statuses and x['status'] not in statuses:
            continue
        if mode in ('office', 'wfh') and x['mode'] != mode:
            continue
        if issues and not (x['status'] in ISSUE_STATUSES or x['punchIssue']):
            continue
        out.append(x)
    return out


def _csv_cell(v):
    s = str(v if v is not None else '')
    return "'" + s if s[:1] in ('=', '+', '-', '@', '\t', '\r') else s


def _mins(m):
    m = int(m or 0)
    return f'{m // 60}h {m % 60:02d}m' if m else ''


@api_view(['GET'])
@require_perm('attendance.view', or_self=True)
def attendance_history(request):
    email = str(request.GET.get('email') or '').strip().lower()
    if not email:
        return Response({'message': 'email is required'}, status=400)
    today = local_today()
    end = _parse(request.GET.get('to')) or today
    start = _parse(request.GET.get('from')) or (end - timedelta(days=29))
    if start > end:
        start, end = end, start
    if (end - start).days >= MAX_DAYS:
        return Response({'message': f'Pick a range of at most {MAX_DAYS} days.'}, status=400)

    days = build_days(email, start, end, today)
    counts = {s: 0 for s in STATUSES}
    for x in days:
        counts[x['status']] = counts.get(x['status'], 0) + 1
    rows = _filter(days, request.GET)

    if request.GET.get('export') == 'csv':   # not ?format= (DRF reserves it)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(['Date', 'Day', 'Status', 'Check in', 'Check out', 'Worked', 'Break', 'Overtime',
                    'Late (min)', 'Mode', 'Details', 'Note'])
        for x in rows:
            w.writerow([_csv_cell(v) for v in (
                x['date'], x['weekday'], x['status'], x['checkIn'], x['checkOut'], _mins(x['workedMinutes']),
                _mins(x['breakMinutes']), _mins(x['overtimeMinutes']), x['lateMinutes'] or '',
                {'wfh': 'WFH', 'office': 'Office'}.get(x['mode'], ''),
                ' · '.join(p for p in (x['detail'], 'Missed punch' if x['punchIssue'] else '') if p), x['note'])])
        resp = HttpResponse(buf.getvalue(), content_type='text/csv; charset=utf-8')
        safe = ''.join(c for c in email.split('@')[0] if c.isalnum() or c in '._-')[:40] or 'employee'
        resp['Content-Disposition'] = f'attachment; filename="attendance_{safe}_{start}_{end}.csv"'
        resp['Cache-Control'] = 'no-store'
        return resp

    try:
        size = int(request.GET.get('pageSize') or 20)
    except ValueError:
        size = 20
    size = size if size in PAGE_SIZES else 20
    total = len(rows)
    pages = max(1, -(-total // size))
    try:
        page = min(max(int(request.GET.get('page') or 1), 1), pages)
    except ValueError:
        page = 1
    return Response({
        'email': email, 'from': start.isoformat(), 'to': end.isoformat(),
        'counts': counts, 'total': total, 'page': page, 'pages': pages, 'pageSize': size,
        'results': rows[(page - 1) * size: page * size],
    })
