"""Per-employee holiday calendars (India / USA / regional).

Who gets which calendar (``calendar_for``):
    1. an explicit HolidayCalendarAssignment for the email,
    2. else an active calendar whose ``locations`` contains the employee's
       UserProfile.location (case-insensitive),
    3. else the active ``is_default`` calendar,
    4. else None.

What a calendar contains (``holidays_for``):
    the computed national holidays of ``calendar.country`` (when
    ``include_national``) minus the calendar's ``exclude`` rows, plus the
    calendar's own days. Optional (restricted) holidays are listed but are not
    a day off.

Backwards compatibility: while NO active calendar exists at all, or when an
employee resolves to no calendar, the list is exactly the old India + US
national list (api/holiday_calendar.py) and nothing is a day off -- the
attendance / payroll numbers of an install that never configured calendars do
not move. Each entry carries ``off`` (True = a non-working day for this
employee); ``holiday_dates`` / ``is_holiday`` only ever return ``off`` days.

Bulk callers (payroll runs, sweeps over every employee) should build one
``HolidayResolver`` and reuse it: calendars, assignments and national lists
are then loaded once per run instead of once per employee.
"""
from datetime import date, timedelta
from functools import lru_cache

from api.holiday_calendar import national_holidays


def _norm(v):
    return str(v or '').strip().lower()


@lru_cache(maxsize=64)
def _national_year(year):
    # Pure function of the year (fixed rules + the `holidays` package), so a
    # process-wide cache is safe and saves the library's per-call cost.
    return tuple(national_holidays(year))


def _as_date(v):
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def _years(start, end):
    return range(start.year, end.year + 1)


class HolidayResolver:
    """Caches everything one request / one batch run needs.

    Create a new one per request or per run: it does not notice edits made
    after it loaded."""

    def __init__(self):
        self._loaded = False
        self._calendars = {}      # id -> HolidayCalendar (active only)
        self._assign = {}         # email -> calendar id
        self._loc = {}            # location (lower) -> calendar id
        self._default = None      # calendar id
        self._days = {}           # calendar id -> [HolidayCalendarDay]
        self._for_email = {}      # email -> calendar or None
        self._dates = {}          # (email, start, end) -> frozenset

    # ── loading ──────────────────────────────────────────────────────────
    def _load(self):
        if self._loaded:
            return
        from api.models import HolidayCalendar, HolidayCalendarAssignment
        cals = list(HolidayCalendar.objects.filter(is_active=True).order_by('name', 'id'))
        self._calendars = {c.id: c for c in cals}
        for c in cals:
            for loc in (c.locations or []):
                key = _norm(loc)
                if key and key not in self._loc:
                    self._loc[key] = c.id
            if c.is_default and self._default is None:
                self._default = c.id
        if cals:
            for a in HolidayCalendarAssignment.objects.filter(calendar_id__in=list(self._calendars)):
                self._assign[_norm(a.email)] = a.calendar_id
        self._loaded = True

    @property
    def configured(self):
        """True once at least one active calendar exists."""
        self._load()
        return bool(self._calendars)

    def calendars(self):
        self._load()
        return list(self._calendars.values())

    def preload_locations(self):
        """Load every UserProfile.location in one query (bulk callers)."""
        from api.models import UserProfile
        self._locations = {_norm(e): _norm(l) for e, l in
                           UserProfile.objects.values_list('email', 'location')}
        return self

    def _location_of(self, email):
        locs = getattr(self, '_locations', None)
        if locs is not None:
            return locs.get(email, '')
        from api.models import UserProfile
        p = UserProfile.objects.filter(email__iexact=email).only('location').first()
        return _norm(p.location if p else '')

    def resolve(self, email):
        """(calendar or None, how) — how is assignment | location | default | none."""
        self._load()
        email = _norm(email)
        if not self._calendars:
            return None, 'none'
        cid = self._assign.get(email) if email else None
        if cid in self._calendars:
            return self._calendars[cid], 'assignment'
        if email and self._loc:
            cid = self._loc.get(self._location_of(email))
            if cid in self._calendars:
                return self._calendars[cid], 'location'
        if self._default in self._calendars:
            return self._calendars[self._default], 'default'
        return None, 'none'

    def calendar_for(self, email):
        email = _norm(email)
        if email not in self._for_email:
            self._for_email[email] = self.resolve(email)[0]
        return self._for_email[email]

    def _days_of(self, cal):
        if cal.id not in self._days:
            self._days[cal.id] = list(cal.days.all().order_by('date', 'name'))
        return self._days[cal.id]

    # ── holiday lists ────────────────────────────────────────────────────
    @staticmethod
    def fallback_list(start, end):
        """The pre-calendar behaviour: India + US national list, no day off."""
        out = []
        for y in _years(start, end):
            for h in _national_year(y):
                d = _as_date(h['date'])
                if start <= d <= end:
                    e = dict(h)
                    e.update(optional=False, source='national', calendar=None,
                             calendarId=None, off=False)
                    out.append(e)
        return out

    def calendar_holidays(self, cal, start, end, with_excluded=False):
        """Resolved list for one calendar. with_excluded=True also returns the
        suppressed national holidays, flagged excluded=True (admin view)."""
        days = [d for d in self._days_of(cal) if start <= d.date <= end]
        excluded = {}
        for d in days:
            if d.exclude:
                excluded.setdefault(d.date, set()).add(_norm(d.name))
        out = []
        if cal.include_national:
            country = (cal.country or '').upper()
            for y in _years(start, end):
                for h in _national_year(y):
                    if h['country'] != country:
                        continue
                    d = _as_date(h['date'])
                    if not start <= d <= end:
                        continue
                    names = excluded.get(d)
                    # An exclude row suppresses the national holiday of the
                    # same name on that date, or every national holiday on
                    # that date when its name matches none of them.
                    is_ex = bool(names) and (_norm(h['name']) in names or not any(
                        _norm(x['name']) in names for x in _national_year(y)
                        if x['country'] == country and x['date'] == h['date']))
                    if is_ex and not with_excluded:
                        continue
                    e = dict(h)
                    e.update(optional=False, source='national', calendar=cal.name,
                             calendarId=cal.id, off=not is_ex)
                    if with_excluded:
                        e['excluded'] = is_ex
                    out.append(e)
        for d in days:
            if d.exclude:
                continue
            out.append({
                'date': d.date.isoformat(), 'name': d.name,
                'country': (cal.country or '').upper(),
                'type': 'Optional holiday' if d.optional else 'Company holiday',
                'optional': bool(d.optional), 'source': 'calendar',
                'calendar': cal.name, 'calendarId': cal.id, 'dayId': d.id,
                'off': not d.optional,
            })
        out.sort(key=lambda h: (h['date'], h['source'] != 'national', h['name']))
        return out

    def holidays_for(self, email, start, end):
        start, end = _as_date(start), _as_date(end)
        cal = self.calendar_for(email)
        if cal is None:
            return self.fallback_list(start, end)
        return self.calendar_holidays(cal, start, end)

    def holiday_dates(self, email, start, end):
        """frozenset of this employee's days off (non-optional holidays)."""
        start, end = _as_date(start), _as_date(end)
        key = (_norm(email), start, end)
        if key not in self._dates:
            if self.calendar_for(email) is None:
                self._dates[key] = frozenset()      # no calendar: nothing changes
            else:
                self._dates[key] = frozenset(
                    _as_date(h['date']) for h in self.holidays_for(email, start, end) if h['off'])
        return self._dates[key]

    def is_holiday(self, email, day):
        day = _as_date(day)
        return day in self.holiday_dates(email, day, day)


# ── module-level conveniences (a fresh resolver per call) ────────────────
def calendar_for(email):
    return HolidayResolver().calendar_for(email)


def holidays_for(email, start, end):
    return HolidayResolver().holidays_for(email, start, end)


def holiday_dates(email, start, end, resolver=None):
    return (resolver or HolidayResolver()).holiday_dates(email, start, end)


def is_holiday(email, day, resolver=None):
    return (resolver or HolidayResolver()).is_holiday(email, day)


def count_off_days(email, start, end, skip=(), resolver=None):
    """Holidays off in [start, end] that are not in `skip` (e.g. days the
    employee has an attendance row for). Used to stop a holiday turning into
    Loss of Pay."""
    return len(holiday_dates(email, start, end, resolver) - set(skip))


def daterange(start, end):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)
