"""Weekly OKR digest email for managers, team leads and department heads:
their teams' objective progress with 7-day deltas and the at-risk key results
(confidence <= 4, or behind the elapsed-time line of the quarter / due date).

Cron (Fridays 16:00 business time):
    0 16 * * 5  cd /path/to/HRMS && venv/bin/python manage.py okr_weekly_digest
"""
from django.conf import settings
from django.core.management.base import BaseCommand

from hrms_plus import okr


class Command(BaseCommand):
    help = 'Email the weekly OKR digest to managers / department heads.'

    def add_arguments(self, parser):
        parser.add_argument('--period', default='', help='Quarter, e.g. 2026-Q4 (default: current)')
        parser.add_argument('--only', default='', help='Send only to this manager email')
        parser.add_argument('--dry-run', action='store_true', help='Build digests, send nothing')

    def handle(self, *args, **opts):
        period = opts['period'] or None
        if period and not okr.valid_period(period):
            self.stderr.write('Period must look like 2026-Q4.')
            return
        okr.refresh_milestones()
        rows = okr.send_weekly_digests(period=period, only=opts['only'] or None, dry_run=opts['dry_run'],
                                       origin=getattr(settings, 'HRMS_PUBLIC_URL', '') or '')
        for r in rows:
            state = 'dry-run' if opts['dry_run'] else ('sent' if r['ok'] else f'FAILED: {r["error"]}')
            self.stdout.write(f'{r["to"]}: {r["objectives"]} objective(s), {r["atRisk"]} at risk — {state}')
        self.stdout.write(f'okr_weekly_digest: {len(rows)} digest(s)')
