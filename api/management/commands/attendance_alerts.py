"""Scheduled attendance alerts.

Cron examples (server local time):

    */15 6-23 * * *  cd <release> && python manage.py attendance_alerts --late
    30 19 * * 1-5    cd <release> && python manage.py attendance_alerts --digest

Both are idempotent, so a missed run simply catches up on the next tick and a
duplicate run sends nothing twice.
"""
from django.core.management.base import BaseCommand

from api import attendance_alerts
from api.timeutil import local_now


class Command(BaseCommand):
    help = 'Send late/absent notices and the daily HR attendance digest.'

    def add_arguments(self, parser):
        parser.add_argument('--late', action='store_true',
                            help='notify anyone past shift start + grace with no check-in')
        parser.add_argument('--digest', action='store_true',
                            help='email HR the summary of the day')
        parser.add_argument('--dry-run', action='store_true',
                            help='report what would be sent, send nothing')

    def handle(self, *args, **opts):
        now = local_now()
        if not opts['late'] and not opts['digest']:
            self.stderr.write('Nothing to do — pass --late and/or --digest.')
            return

        if opts['late']:
            sent = attendance_alerts.run_late_sweep(now=now, dry_run=opts['dry_run'])
            verb = 'would notify' if opts['dry_run'] else 'notified'
            self.stdout.write(f'{now:%Y-%m-%d %H:%M} late sweep: {verb} {len(sent)}')
            for e in sent:
                self.stdout.write(f'  {e}')

        if opts['digest']:
            if opts['dry_run']:
                d = attendance_alerts.collect_digest(now=now)
                self.stdout.write(
                    f"digest (dry run): {d['checkedIn']}/{d['expected']} in, "
                    f"{d['late']} late, {d['stillOpen']} still open, "
                    f"{d['pendingApprovals']} approvals waiting"
                )
            else:
                to = attendance_alerts.send_hr_digest(now=now)
                self.stdout.write(f'digest sent to {len(to)} recipient(s)')
