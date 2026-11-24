"""Holiday calendar API (Attendance Phase 1 / Workstream H).

    GET  /api/holidays?year=              the caller's resolved holidays (same
                                          shape as before + calendar/optional/
                                          source/off). ?calendar=<id>, ?email=,
                                          ?all=1 for settings readers.
    GET  /api/holiday-calendars           admins: every calendar + counts;
                                          others: just their own calendar
    POST /api/holiday-calendars           create              (settings.manage)
    GET/PATCH/DELETE /api/holiday-calendars/<id>
    GET  /api/holiday-calendars/<id>/days?year=   own days + national (excluded flag)
    POST /api/holiday-calendars/<id>/days         add a day / exclude a national one
    PATCH/DELETE /api/holiday-calendars/<id>/days/<day_id>
    POST /api/holiday-calendars/<id>/import       CSV text "date,name,optional"
    GET  /api/holiday-calendars/assignments       who is on which calendar (+ counts)
    POST /api/holiday-calendars/assignments       {calendarId|null, emails:[..] | location}

Writes need settings.manage; reading other people's calendars needs
settings.view or settings.manage. Identity is X-User-Email (api/permissions.py).
"""
import csv
import io
from datetime import date, datetime

from django.db import IntegrityError, transaction
from django.http import JsonResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response

from api import permissions as perms
from api.models import (AppUser, HolidayCalendar, HolidayCalendarAssignment, HolidayCalendarDay,
                        UserProfile)
from api.timeutil import local_today

from .holidays import HolidayResolver, _national_year

READ_CODES = ['settings.view', 'settings.manage', 'holiday.manage']
WRITE_CODES = ['holiday.manage']
MAX_IMPORT_ROWS = 1000


def _err(message, status=400, **extra):
    body = {'message': message}
    body.update(extra)
    return JsonResponse(body, status=status)


def _norm(v):
    return str(v or '').strip().lower()


def _caller(request):
    perms._CACHE.clear()
    email, user = perms._get_caller(request)
    if user is not None and user.status != 'active':
        user = None
    return email, user


def _has(request, codes):
    allowed, email, user = perms.check_perm(request, list(codes))
    return bool(allowed and user)


def _guard(request, codes):
    """None when allowed, else the 401/403 response."""
    email, user = _caller(request)
    if not email or not user:
        return perms._auth_required(request)
    if not _has(request, codes):
        return _err("You don't have permission to perform this action. Required: " + codes[-1],
                    403, code='PERMISSION_DENIED', required=codes[-1])
    return None


def _year(request):
    raw = request.query_params.get('year') or local_today().year
    try:
        year = int(raw)
    except (TypeError, ValueError):
        return None, _err('year must be a number')
    if not 1900 <= year <= 2200:
        return None, _err('year must be between 1900 and 2200')
    return year, None


def _truthy(v):
    return _norm(v) in ('1', 'true', 'yes', 'y', 'on', 'optional')


def _parse_date(v):
    s = str(v or '').strip()
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


# ── /api/holidays ────────────────────────────────────────────────────────
@api_view(['GET'])
def holidays_api(request):
    """Backwards compatible with the Leave page: a JSON list of
    {date, name, country, type} (+ calendar, calendarId, optional, source, off).
    Not permission-gated for the caller's own list, as before."""
    year, bad = _year(request)
    if bad:
        return bad
    start, end = date(year, 1, 1), date(year, 12, 31)
    q = request.query_params
    r = HolidayResolver()
    email, user = _caller(request)
    want_cal = (q.get('calendar') or '').strip()
    want_all = _truthy(q.get('all'))
    want_email = _norm(q.get('email'))

    if want_all:
        g = _guard(request, READ_CODES)
        if g:
            return g
        if not r.configured:
            return Response(r.fallback_list(start, end))
        out = []
        for cal in r.calendars():
            out.extend(r.calendar_holidays(cal, start, end))
        out.sort(key=lambda h: (h['date'], h['calendar'] or '', h['name']))
        return Response(out)

    # ?meta=1 (the Leave page's holiday panel) wraps the list:
    #   {calendar: {id, name, country, region, how} | null, own: <same, the
    #    caller's>, canManage, calendars: [{id, name}] (settings.view only),
    #    holidays: [...]}
    # Optional holidays carry optional=True; the name is never altered.
    want_meta = _truthy(q.get('meta'))

    def _cal_meta(cal, how=''):
        if cal is None:
            return None
        return {'id': cal.id, 'name': cal.name, 'country': cal.country, 'region': cal.region, 'how': how}

    def _wrap(rows, cal, how=''):
        if not want_meta:
            return Response(rows)
        can = bool(email and user is not None and _has(request, READ_CODES))
        own, own_how = r.resolve(email) if email else (None, 'none')
        return Response({
            'year': year, 'calendar': _cal_meta(cal, how), 'own': _cal_meta(own, own_how),
            'canManage': can,
            'calendars': [{'id': c.id, 'name': c.name} for c in r.calendars()] if can else [],
            'holidays': rows,
        })

    if want_cal:
        try:
            cid = int(want_cal)
        except ValueError:
            return _err('calendar must be a number')
        cal = HolidayCalendar.objects.filter(pk=cid).first()
        if cal is None:
            return _err('Calendar not found', 404)
        own = r.calendar_for(email) if email else None
        if not (own is not None and own.id == cid):
            g = _guard(request, READ_CODES)
            if g:
                return g
        return _wrap(r.calendar_holidays(cal, start, end), cal, 'chosen')

    if want_email and want_email != _norm(email):
        g = _guard(request, READ_CODES)
        if g:
            return g
        cal, how = r.resolve(want_email)
        return _wrap(r.holidays_for(want_email, start, end), cal, how)

    cal, how = r.resolve(email or '')
    return _wrap(r.holidays_for(email or '', start, end), cal, how)


# ── calendars ────────────────────────────────────────────────────────────
def _cal_json(c, counts=None):
    counts = counts or {}
    return {
        'id': c.id, 'name': c.name, 'country': c.country, 'region': c.region,
        'includeNational': c.include_national, 'locations': list(c.locations or []),
        'isDefault': c.is_default, 'isActive': c.is_active,
        'createdBy': c.created_by,
        'createdAt': c.created_at.isoformat() if c.created_at else None,
        'updatedAt': c.updated_at.isoformat() if c.updated_at else None,
        'dayCount': counts.get('days', {}).get(c.id, 0),
        'assignmentCount': counts.get('assign', {}).get(c.id, 0),
        'employeeCount': counts.get('employees', {}).get(c.id, 0),
    }


def _apply_cal_fields(c, body, creating):
    """Validate + copy request fields onto c. Returns an error message or None."""
    if creating or 'name' in body:
        name = str(body.get('name') or '').strip()
        if not name:
            return 'Name is required'
        if len(name) > 120:
            return 'Name must be at most 120 characters'
        dup = HolidayCalendar.objects.filter(name__iexact=name)
        if c.pk:
            dup = dup.exclude(pk=c.pk)
        if dup.exists():
            return 'A calendar with this name already exists'
        c.name = name
    if creating or 'country' in body:
        country = str(body.get('country') or 'IN').strip().upper()
        if len(country) != 2 or not country.isalpha():
            return 'Country must be a 2-letter code (IN, US, ...)'
        c.country = country
    if 'region' in body:
        c.region = str(body.get('region') or '').strip()[:120]
    if 'includeNational' in body:
        c.include_national = bool(body.get('includeNational'))
    if 'locations' in body:
        locs = body.get('locations') or []
        if isinstance(locs, str):
            locs = locs.split(',')
        if not isinstance(locs, list):
            return 'locations must be a list'
        seen, clean = set(), []
        for l in locs:
            s = str(l or '').strip()[:255]
            if s and s.lower() not in seen:
                seen.add(s.lower())
                clean.append(s)
        c.locations = clean
    if 'isDefault' in body:
        c.is_default = bool(body.get('isDefault'))
    if 'isActive' in body:
        c.is_active = bool(body.get('isActive'))
    return None


def _location_clash(c):
    """Another active calendar already claims one of c's locations?"""
    if not c.is_active:
        return None
    mine = {_norm(x) for x in (c.locations or [])}
    if not mine:
        return None
    for o in HolidayCalendar.objects.filter(is_active=True).exclude(pk=c.pk):
        both = mine & {_norm(x) for x in (o.locations or [])}
        if both:
            return 'Location "%s" is already mapped to "%s"' % (sorted(both)[0], o.name)
    return None


def _save_cal(c):
    with transaction.atomic():
        c.save()
        if c.is_default:
            HolidayCalendar.objects.exclude(pk=c.pk).filter(is_default=True).update(is_default=False)


def _preview(resolver=None):
    """[{email, name, location, calendarId, calendar, via}] for active staff."""
    r = resolver or HolidayResolver()
    r.preload_locations()
    names = {}
    for p in UserProfile.objects.values('email', 'first_name', 'last_name', 'location', 'department'):
        names[_norm(p['email'])] = p
    rows = []
    for u in AppUser.objects.filter(status='active').order_by('full_name', 'email'):
        em = _norm(u.email)
        if not em:
            continue
        cal, via = r.resolve(em)
        p = names.get(em) or {}
        nm = ('%s %s' % (p.get('first_name') or '', p.get('last_name') or '')).strip() or u.full_name or em
        rows.append({
            'email': em, 'name': nm, 'location': p.get('location') or '',
            'department': p.get('department') or '',
            'calendarId': cal.id if cal else None, 'calendar': cal.name if cal else None,
            'via': via,
        })
    return rows


def _counts(preview=None):
    from django.db.models import Count
    days = dict(HolidayCalendarDay.objects.filter(exclude=False).values('calendar_id')
                .annotate(n=Count('id')).values_list('calendar_id', 'n'))
    assign = dict(HolidayCalendarAssignment.objects.values('calendar_id')
                  .annotate(n=Count('id')).values_list('calendar_id', 'n'))
    emp = {}
    for row in (preview if preview is not None else _preview()):
        if row['calendarId']:
            emp[row['calendarId']] = emp.get(row['calendarId'], 0) + 1
    return {'days': days, 'assign': assign, 'employees': emp}


@api_view(['GET', 'POST'])
def holiday_calendars(request):
    email, user = _caller(request)
    if not email or not user:
        return perms._auth_required(request)
    if request.method == 'GET':
        if _has(request, READ_CODES):
            preview = _preview()
            counts = _counts(preview)
            cals = HolidayCalendar.objects.all().order_by('-is_active', 'name')
            unassigned = sum(1 for p in preview if not p['calendarId'])
            return Response({
                'calendars': [_cal_json(c, counts) for c in cals],
                'canManage': _has(request, WRITE_CODES),
                'unassigned': unassigned,
                'configured': HolidayCalendar.objects.filter(is_active=True).exists(),
            })
        own = HolidayResolver().calendar_for(email)
        return Response({'calendars': [_cal_json(own)] if own else [], 'canManage': False,
                         'mine': own.id if own else None})
    g = _guard(request, WRITE_CODES)
    if g:
        return g
    body = request.data or {}
    c = HolidayCalendar(created_by=email)
    msg = _apply_cal_fields(c, body, creating=True) or _location_clash(c)
    if msg:
        return _err(msg)
    try:
        _save_cal(c)
    except IntegrityError:
        return _err('A calendar with this name already exists')
    return Response(_cal_json(c, _counts()), status=201)


@api_view(['GET', 'PATCH', 'PUT', 'DELETE'])
def holiday_calendar_detail(request, pk):
    email, user = _caller(request)
    if not email or not user:
        return perms._auth_required(request)
    c = HolidayCalendar.objects.filter(pk=pk).first()
    if c is None:
        return _err('Calendar not found', 404)
    if request.method == 'GET':
        own = HolidayResolver().calendar_for(email)
        if not (own and own.id == c.id):
            g = _guard(request, READ_CODES)
            if g:
                return g
        return Response(_cal_json(c, _counts()))
    g = _guard(request, WRITE_CODES)
    if g:
        return g
    if request.method == 'DELETE':
        c.delete()
        return Response({'deleted': pk})
    msg = _apply_cal_fields(c, request.data or {}, creating=False) or _location_clash(c)
    if msg:
        return _err(msg)
    try:
        _save_cal(c)
    except IntegrityError:
        return _err('A calendar with this name already exists')
    return Response(_cal_json(c, _counts()))


# ── days ─────────────────────────────────────────────────────────────────
def _day_json(d):
    return {'id': d.id, 'date': d.date.isoformat(), 'name': d.name,
            'optional': d.optional, 'exclude': d.exclude, 'calendarId': d.calendar_id}


@api_view(['GET', 'POST'])
def holiday_calendar_days(request, pk):
    email, user = _caller(request)
    if not email or not user:
        return perms._auth_required(request)
    c = HolidayCalendar.objects.filter(pk=pk).first()
    if c is None:
        return _err('Calendar not found', 404)
    if request.method == 'GET':
        own = HolidayResolver().calendar_for(email)
        if not (own and own.id == c.id):
            g = _guard(request, READ_CODES)
            if g:
                return g
        year, bad = _year(request)
        if bad:
            return bad
        start, end = date(year, 1, 1), date(year, 12, 31)
        r = HolidayResolver()
        days = c.days.filter(date__gte=start, date__lte=end).order_by('date', 'name')
        national = [h for h in r.calendar_holidays(c, start, end, with_excluded=True)
                    if h['source'] == 'national']
        if not c.include_national:
            # Show what *would* apply, so the admin can see what they turned off.
            national = [dict(h, excluded=False, off=False, inactive=True)
                        for h in _national_year(year) if h['country'] == (c.country or '').upper()]
        return Response({
            'calendar': _cal_json(c), 'year': year,
            'days': [_day_json(d) for d in days],
            'national': national,
            'resolved': r.calendar_holidays(c, start, end),
        })
    g = _guard(request, WRITE_CODES)
    if g:
        return g
    body = request.data or {}
    d = _parse_date(body.get('date'))
    if d is None:
        return _err('A valid date (YYYY-MM-DD) is required')
    name = str(body.get('name') or '').strip()
    if not name:
        return _err('Name is required')
    if len(name) > 160:
        return _err('Name must be at most 160 characters')
    exclude = bool(body.get('exclude'))
    optional = False if exclude else bool(body.get('optional'))
    if HolidayCalendarDay.objects.filter(calendar=c, date=d, name__iexact=name).exists():
        return _err('This calendar already has "%s" on %s' % (name, d.isoformat()))
    day = HolidayCalendarDay.objects.create(calendar=c, date=d, name=name,
                                            optional=optional, exclude=exclude)
    return Response(_day_json(day), status=201)


@api_view(['PATCH', 'PUT', 'DELETE'])
def holiday_calendar_day_detail(request, pk, day_id):
    g = _guard(request, WRITE_CODES)
    if g:
        return g
    day = HolidayCalendarDay.objects.filter(pk=day_id, calendar_id=pk).first()
    if day is None:
        return _err('Holiday not found', 404)
    if request.method == 'DELETE':
        day.delete()
        return Response({'deleted': day_id})
    body = request.data or {}
    if 'date' in body:
        d = _parse_date(body.get('date'))
        if d is None:
            return _err('A valid date (YYYY-MM-DD) is required')
        day.date = d
    if 'name' in body:
        name = str(body.get('name') or '').strip()
        if not name or len(name) > 160:
            return _err('Name is required (at most 160 characters)')
        day.name = name
    if 'exclude' in body:
        day.exclude = bool(body.get('exclude'))
    if 'optional' in body:
        day.optional = bool(body.get('optional'))
    if day.exclude:
        day.optional = False
    if HolidayCalendarDay.objects.filter(calendar_id=pk, date=day.date, name__iexact=day.name) \
            .exclude(pk=day.pk).exists():
        return _err('This calendar already has "%s" on %s' % (day.name, day.date.isoformat()))
    day.save()
    return Response(_day_json(day))


def parse_holiday_csv(text):
    """(rows, errors). rows: [(date, name, optional)]; errors: [{line, error}].
    Accepts an optional header row, blank lines and '#' comments."""
    rows, errors, seen = [], [], set()
    reader = csv.reader(io.StringIO(str(text or '')))
    for lineno, rec in enumerate(reader, start=1):
        cells = [c.strip() for c in rec]
        if not cells or not any(cells) or cells[0].startswith('#'):
            continue
        if lineno == 1 and _norm(cells[0]) == 'date':
            continue
        if len(cells) < 2:
            errors.append({'line': lineno, 'error': 'Expected date,name[,optional]'})
            continue
        if len(cells) > 3 and any(cells[3:]):
            errors.append({'line': lineno, 'error': 'Too many columns (expected date,name,optional)'})
            continue
        d = _parse_date(cells[0])
        if d is None:
            errors.append({'line': lineno, 'error': 'Invalid date "%s" (use YYYY-MM-DD)' % cells[0]})
            continue
        if not 1900 <= d.year <= 2200:
            errors.append({'line': lineno, 'error': 'Year out of range'})
            continue
        name = cells[1]
        if not name:
            errors.append({'line': lineno, 'error': 'Name is required'})
            continue
        if len(name) > 160:
            errors.append({'line': lineno, 'error': 'Name must be at most 160 characters'})
            continue
        opt_raw = cells[2] if len(cells) > 2 else ''
        if _norm(opt_raw) not in ('', '0', '1', 'true', 'false', 'yes', 'no', 'y', 'n', 'optional'):
            errors.append({'line': lineno, 'error': 'optional must be yes/no (got "%s")' % opt_raw})
            continue
        key = (d, name.lower())
        if key in seen:
            errors.append({'line': lineno, 'error': 'Duplicate of an earlier line'})
            continue
        seen.add(key)
        rows.append((d, name, _truthy(opt_raw)))
    if len(rows) > MAX_IMPORT_ROWS:
        errors.append({'line': 0, 'error': 'At most %d rows per import' % MAX_IMPORT_ROWS})
    return rows, errors


@api_view(['POST'])
def holiday_calendar_import(request, pk):
    """All-or-nothing: any invalid line rejects the whole file with the list of
    line errors. Existing (date, name) rows are updated, not duplicated.
    replace=true first removes the calendar's own (non-exclude) days in the
    years the file covers. dryRun=true validates only."""
    g = _guard(request, WRITE_CODES)
    if g:
        return g
    c = HolidayCalendar.objects.filter(pk=pk).first()
    if c is None:
        return _err('Calendar not found', 404)
    body = request.data or {}
    rows, errors = parse_holiday_csv(body.get('csv'))
    if errors:
        return _err('The file has %d problem(s); nothing was imported.' % len(errors), errors=errors)
    if not rows:
        return _err('No holidays found in the file', errors=[])
    if _truthy(body.get('dryRun')):
        return Response({'valid': len(rows), 'created': 0, 'updated': 0, 'removed': 0, 'dryRun': True})
    created = updated = removed = 0
    with transaction.atomic():
        if _truthy(body.get('replace')):
            years = sorted({d.year for d, _, _ in rows})
            removed, _ = HolidayCalendarDay.objects.filter(
                calendar=c, exclude=False, date__year__in=years).delete()
        for d, name, optional in rows:
            ex = HolidayCalendarDay.objects.filter(calendar=c, date=d, name__iexact=name).first()
            if ex:
                if ex.optional != optional or ex.exclude:
                    ex.optional, ex.exclude = optional, False
                    ex.save(update_fields=['optional', 'exclude'])
                updated += 1
            else:
                HolidayCalendarDay.objects.create(calendar=c, date=d, name=name, optional=optional)
                created += 1
    return Response({'valid': len(rows), 'created': created, 'updated': updated, 'removed': removed})


# ── assignments ──────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
def holiday_calendar_assignments(request):
    if request.method == 'GET':
        g = _guard(request, READ_CODES)
        if g:
            return g
        preview = _preview()
        counts = _counts(preview)
        cals = HolidayCalendar.objects.all().order_by('name')
        per = [{'calendarId': c.id, 'calendar': c.name, 'isActive': c.is_active,
                'employees': counts['employees'].get(c.id, 0),
                'assigned': counts['assign'].get(c.id, 0)} for c in cals]
        per.append({'calendarId': None, 'calendar': None, 'isActive': True,
                    'employees': sum(1 for p in preview if not p['calendarId']), 'assigned': 0})
        locations = sorted({p['location'] for p in preview if p['location']}, key=str.lower)
        return Response({'employees': preview, 'perCalendar': per, 'locations': locations})

    g = _guard(request, WRITE_CODES)
    if g:
        return g
    caller, _ = _caller(request)
    body = request.data or {}
    raw_cid = body.get('calendarId')
    cal = None
    if raw_cid not in (None, '', 0, '0'):
        try:
            cal = HolidayCalendar.objects.filter(pk=int(raw_cid)).first()
        except (TypeError, ValueError):
            cal = None
        if cal is None:
            return _err('Calendar not found', 404)
    emails = body.get('emails')
    if isinstance(emails, str):
        emails = [e for e in emails.replace(';', ',').replace('\n', ',').split(',')]
    emails = [_norm(e) for e in (emails or []) if _norm(e)]
    location = str(body.get('location') or '').strip()
    if body.get('email'):
        emails.append(_norm(body.get('email')))
    if location:
        emails.extend(_norm(e) for e in UserProfile.objects.filter(location__iexact=location)
                      .values_list('email', flat=True))
    emails = sorted(set(emails))
    if not emails:
        return _err('Give emails or a location that has employees')
    known = {_norm(e) for e in AppUser.objects.values_list('email', flat=True)} | \
            {_norm(e) for e in UserProfile.objects.values_list('email', flat=True)}
    unknown = [e for e in emails if e not in known]
    emails = [e for e in emails if e in known]
    changed = 0
    with transaction.atomic():
        for em in emails:
            if cal is None:
                n, _ = HolidayCalendarAssignment.objects.filter(email__iexact=em).delete()
                changed += 1 if n else 0
            else:
                a = HolidayCalendarAssignment.objects.filter(email__iexact=em).first()
                if a is None:
                    HolidayCalendarAssignment.objects.create(email=em, calendar=cal, assigned_by=caller or '')
                    changed += 1
                elif a.calendar_id != cal.id:
                    a.calendar, a.assigned_by = cal, caller or ''
                    a.save(update_fields=['calendar', 'assigned_by'])
                    changed += 1
    return Response({'changed': changed, 'emails': emails, 'unknown': unknown,
                     'calendarId': cal.id if cal else None})
