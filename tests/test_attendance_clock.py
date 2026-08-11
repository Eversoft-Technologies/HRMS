"""Attendance stamps must not depend on the host's timezone.

Production (cPanel) runs UTC; the dev machines run IST. Because the project
stores naive datetimes, `datetime.now()` recorded the same check-in 5h30m apart
depending on where the code ran. Employees in IST saw "Checked In — 14:18" at
19:48, and "Working hours today" fell by exactly 5h30m the moment they checked
out — the live counter had been adding a delta measured from a check-in stamp
that was on a different clock from their browser.
"""
import os
import sys
import time
from datetime import datetime

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, override_settings

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.timeutil import local_now, local_today


class BusinessClockTests(TestCase):
    @override_settings(TIME_ZONE='Asia/Kolkata')
    def test_local_now_ignores_the_host_clock(self):
        """The whole point: identical output on a UTC server and an IST laptop."""
        original = os.environ.get('TZ')
        try:
            stamps = {}
            for host_tz in ('UTC', 'Asia/Kolkata', 'America/New_York'):
                os.environ['TZ'] = host_tz
                if hasattr(time, 'tzset'):
                    time.tzset()
                stamps[host_tz] = local_now()

            spread = max(stamps.values()) - min(stamps.values())
            self.assertLess(
                spread.total_seconds(), 5,
                f'stamps drift with the host timezone: {stamps}',
            )
        finally:
            if original is None:
                os.environ.pop('TZ', None)
            else:
                os.environ['TZ'] = original
            if hasattr(time, 'tzset'):
                time.tzset()

    @override_settings(TIME_ZONE='Asia/Kolkata')
    def test_local_now_is_naive(self):
        """Naive, so it drops into the existing columns unchanged."""
        self.assertIsNone(local_now().tzinfo)

    @override_settings(TIME_ZONE='Asia/Kolkata')
    def test_local_now_matches_the_configured_zone(self):
        from zoneinfo import ZoneInfo
        expected = datetime.now(ZoneInfo('Asia/Kolkata')).replace(tzinfo=None)
        self.assertLess(abs((local_now() - expected).total_seconds()), 5)

    @override_settings(TIME_ZONE='Asia/Kolkata')
    def test_local_today_follows_the_business_day(self):
        """Near midnight IST a UTC host is still on the previous date, which
        would file the check-in against yesterday's attendance row."""
        self.assertEqual(local_today(), local_now().date())

    @override_settings(TIME_ZONE='Not/AZone')
    def test_an_unresolvable_zone_degrades_instead_of_raising(self):
        self.assertIsInstance(local_now(), datetime)


class NoHostClockLeftInAttendanceTests(TestCase):
    """datetime.now() reintroduces the bug wherever it comes back."""

    def test_attendance_paths_use_the_business_clock(self):
        """Scans code, not prose.

        The first version matched the raw file text, so a comment *explaining*
        why datetime.now() is wrong failed the test that exists to keep it out.
        Comments are stripped before the check — a rule you cannot write about
        is a rule people work around instead of understanding.
        """
        import pathlib
        import re
        root = pathlib.Path(__file__).resolve().parent.parent
        offenders = []
        for name in ('api/views.py', 'api/attendance_views.py', 'api/onboarding_views.py'):
            src = (root / name).read_text(encoding='utf-8')
            code = '\n'.join(re.sub(r'#.*$', '', line) for line in src.splitlines())
            if 'datetime.now()' in code:
                offenders.append(name)
        self.assertEqual(offenders, [], f'{offenders} still stamp from the host clock')
