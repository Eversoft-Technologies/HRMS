"""India and US holidays for any year.

US federal holidays are fixed dates or "Nth weekday of a month" rules,
computed here. India's three national holidays are fixed dates; its festival
holidays (Diwali, Dussehra, Holi, Eid, ...) follow lunar calendars, so they
come from the `holidays` package (central-government gazetted list plus a few
widely observed festivals). The package ships festival dates up to 2035;
bumping its version in requirements.txt extends that. Past its range -- or if
the package is missing -- India falls back to the three national holidays.
Islamic festival dates beyond the current year are moon-sighting estimates
and are marked "(tentative)".

Nothing needs editing when a new year starts.
Dates are the actual holiday dates, not the US "observed" weekday shift.
"""
import calendar
import warnings
from datetime import date


def _nth_weekday(year, month, weekday, n):
    """n-th (1-based) `weekday` (Mon=0) of the month; n=-1 means the last one."""
    days = [d for d in range(1, calendar.monthrange(year, month)[1] + 1)
            if date(year, month, d).weekday() == weekday]
    return date(year, month, days[n - 1 if n > 0 else n])


MON, THU = 0, 3

# (name, month, day) — India's three national holidays.
_INDIA_FIXED = [
    ('Republic Day', 1, 26),
    ('Independence Day', 8, 15),
    ('Gandhi Jayanti', 10, 2),
]

# US federal holidays: fixed dates ...
_US_FIXED = [
    ("New Year's Day", 1, 1),
    ('Juneteenth', 6, 19),
    ('Independence Day', 7, 4),
    ('Veterans Day', 11, 11),
    ('Christmas Day', 12, 25),
]
# ... and (name, month, weekday, n) weekday rules.
_US_RULES = [
    ('Martin Luther King Jr. Day', 1, MON, 3),
    ("Presidents' Day", 2, MON, 3),
    ('Memorial Day', 5, MON, -1),
    ('Labor Day', 9, MON, 1),
    ('Columbus Day', 10, MON, 2),
    ('Thanksgiving Day', 11, THU, 4),
]


_INDIA_NATIONAL = 'India national holiday'
_INDIA_FESTIVAL = 'India festival holiday'
# Library names -> the names shown in the app.
_INDIA_RENAME = {"Mahatma Gandhi's Jayanti": 'Gandhi Jayanti',
                 'Janmashtami (Vaishnava)': 'Janmashtami'}
# Widely observed festivals the library files under "optional" (restricted)
# rather than gazetted; matched on a fragment of the library's name.
_INDIA_OPTIONAL_KEEP = ('Makar Sankranti', 'Pongal', 'Maha Shivaratri',
                        'Raksha Bandhan', 'Ganesh Chaturthi')


def _india(year):
    """[(date, name, type)] for India; fixed national three as a fallback."""
    national = {name for name, _, _ in _INDIA_FIXED}
    fixed = [(date(year, m, d), name, _INDIA_NATIONAL) for name, m, d in _INDIA_FIXED]
    try:
        import holidays as hlib
    except ImportError:
        return fixed
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')  # "only available from 2001 to 2035"
        # Pin the language: otherwise the server's locale can switch the names
        # (e.g. en_US "Mahatma Gandhi's Birthday").
        public = hlib.India(years=year, language='en_IN')
        optional = hlib.India(years=year, categories=('optional',), language='en_IN')
    out, seen = [], set()

    def add(d, raw):
        name = _INDIA_RENAME.get(raw, raw).replace(' (estimated)', ' (tentative)')
        if (d, name) in seen:
            return
        seen.add((d, name))
        out.append((d, name, _INDIA_NATIONAL if name in national else _INDIA_FESTIVAL))

    for d, names in public.items():
        for raw in names.split('; '):
            add(d, raw)
    for d, names in optional.items():
        parts = [p for p in names.split('; ') if any(k in p for k in _INDIA_OPTIONAL_KEEP)]
        if parts:
            add(d, ' / '.join(parts))
    # The national three are always present, even past the library's range.
    for d, name, t in fixed:
        if (d, name) not in seen:
            out.append((d, name, t))
    return out


def national_holidays(year):
    """[{date, name, country, type}] for `year`, sorted by date."""
    out = [(d, name, 'IN', t) for d, name, t in _india(year)]
    for name, m, d in _US_FIXED:
        out.append((date(year, m, d), name, 'US', 'US federal holiday'))
    for name, m, wd, n in _US_RULES:
        out.append((_nth_weekday(year, m, wd, n), name, 'US', 'US federal holiday'))
    out.sort(key=lambda h: (h[0], h[2]))
    return [{'date': d.isoformat(), 'name': name, 'country': c, 'type': t}
            for d, name, c, t in out]
