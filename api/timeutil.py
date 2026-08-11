"""Business-clock helpers.

The project stores naive datetimes (``USE_TZ = False``), a convention inherited
from the Node app. That only works if every writer agrees on which clock those
naive values are in — and ``datetime.now()`` does not: it returns the *host's*
local time. Developer machines run IST, the cPanel server runs UTC, so the same
code stamped attendance 5h30m apart depending on where it ran. Employees saw
"Checked In — 14:18" at 19:48, and "Working hours today" jumped by exactly 5h30m
the moment they checked out, because the live counter added a delta measured
against a check-in stamp that was in a different timezone from the browser.

``local_now()`` returns the current time on the configured business clock
(``settings.TIME_ZONE``) as a naive datetime, so stamps are identical whatever
the host is set to. Use it for anything a person will read as a wall-clock time.
"""
from datetime import datetime

from django.conf import settings

try:                                  # Python 3.9+
    from zoneinfo import ZoneInfo
except ImportError:                   # pragma: no cover - fallback for 3.8
    ZoneInfo = None


def business_tz():
    """The configured business timezone, or None if it cannot be resolved."""
    name = getattr(settings, 'TIME_ZONE', None)
    if not name or ZoneInfo is None:
        return None
    try:
        return ZoneInfo(name)
    except Exception:
        return None


def local_now():
    """Current wall-clock time in the business timezone, as a naive datetime.

    Naive so it drops straight into the existing columns. Host-independent, so a
    UTC server and an IST laptop record the same instant identically.
    """
    tz = business_tz()
    if tz is None:
        return datetime.now()
    return datetime.now(tz).replace(tzinfo=None)


def local_today():
    """Today's date on the business clock.

    Distinct from ``date.today()`` near midnight: at 00:30 IST the host-UTC
    clock still reads the previous day, which would file a check-in against
    yesterday's attendance row.
    """
    return local_now().date()
