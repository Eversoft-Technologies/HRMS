"""Recalculate worked time / overtime for closed attendance days.

Days saved before multi-session days added up kept only their last session.
This rebuilds each day from its check-in / check-out events (each session
minus its own breaks). By default it only PREVIEWS; nothing changes without
--apply. Closed payroll months are left alone: the default range starts at
the 1st of the current month. The same preview / apply is available in the
app: Attendance Administration › Recalculate Hours.

  python manage.py recalc_attendance                       # preview this month
  python manage.py recalc_attendance --from 2026-10-01 --csv changes.csv
  python manage.py recalc_attendance --apply               # write the changes

Each applied change is recorded on that day's timeline ("Hours recalculated").
Days whose event trail does not pair up are reported and left as they are.

--policy re-evaluates the DAY STATUS (present / late / half-day / absent) of
closed days under each employee's attendance policy profile
(api/attendance_ext/day_status.py) instead of the hours, e.g. after a profile
was created or its thresholds changed. Same preview / --apply rule; applied
changes go to the attendance audit log (source 'policy_recalc') and the
penalties of every month touched are re-evaluated.

  python manage.py recalc_attendance --policy --from 2026-11-01 --to 2026-11-30
  python manage.py recalc_attendance --policy --from 2026-11-01 --apply
"""
import csv

from django.core.management.base import BaseCommand, CommandError

from api import attendance_recalc as rc
from api import views as v
from api.timeutil import local_today


class Command(BaseCommand):
    help = 'Preview (default) or --apply recalculated worked time for closed attendance days.'

    def add_arguments(self, parser):
        parser.add_argument('--from', dest='date_from', help='YYYY-MM-DD (default: 1st of this month)')
        parser.add_argument('--to', dest='date_to', help='YYYY-MM-DD (default: today)')
        parser.add_argument('--email', help='Only this employee')
        parser.add_argument('--csv', help='Also write the changes to this CSV file')
        parser.add_argument('--apply', action='store_true', help='Write the changes (default: preview only)')
        parser.add_argument('--policy', action='store_true',
                            help='Re-evaluate day status (present/late/half-day/absent) under the attendance policy')

    def handle(self, *args, **o):
        today = local_today()
        try:
            d_from = rc.parse_day(o['date_from'], today.replace(day=1))
            d_to = rc.parse_day(o['date_to'], today)
        except ValueError:
            raise CommandError('Dates must be YYYY-MM-DD.')
        if o['policy']:
            return self._policy(d_from, d_to, o)
        changes, skipped = rc.preview(d_from, d_to, o['email'])

        mode = 'APPLY' if o['apply'] else 'PREVIEW (nothing is changed; add --apply to write)'
        self.stdout.write(f'{mode} — closed days {d_from} → {d_to}'
                          + (f' for {o["email"]}' if o['email'] else ''))
        self.stdout.write(f'{"date":<11} {"employee":<36} {"worked":>17} {"overtime":>15}')
        for att, worked, ot in changes:
            self.stdout.write(f'{att.date!s:<11} {att.email[:36]:<36} '
                              f'{v._fmt_dur(att.worked_minutes or 0):>7} → {v._fmt_dur(worked):<7} '
                              f'{v._fmt_dur(att.overtime_minutes or 0):>6} → {v._fmt_dur(ot):<6}')
        self.stdout.write(f'{len(changes)} day(s) would change' if not o['apply'] else f'{len(changes)} day(s) changed')
        if skipped:
            self.stdout.write(f'{len(skipped)} day(s) left as they are — their check-in/check-out trail does not '
                              f'pair up: ' + ', '.join(f'{a.email} {a.date}' for a in skipped[:20])
                              + (' …' if len(skipped) > 20 else ''))
        if o['csv']:
            with open(o['csv'], 'w', newline='', encoding='utf-8') as fh:
                w = csv.writer(fh)
                w.writerow(['date', 'email', 'old_worked_min', 'new_worked_min', 'old_overtime_min', 'new_overtime_min'])
                for att, worked, ot in changes:
                    w.writerow([att.date, att.email, att.worked_minutes or 0, worked, att.overtime_minutes or 0, ot])
            self.stdout.write(f'Wrote {o["csv"]}')
        if o['apply'] and changes:
            rc.apply(changes, 'recalc_attendance')

    def _policy(self, d_from, d_to, o):
        from api.attendance_ext import day_status as ds
        changes = ds.reevaluate(d_from, d_to, o['email'])
        mode = 'APPLY' if o['apply'] else 'PREVIEW (nothing is changed; add --apply to write)'
        self.stdout.write(f'{mode} — day status under the attendance policy, closed days {d_from} → {d_to}'
                          + (f' for {o["email"]}' if o['email'] else ''))
        self.stdout.write(f'{"date":<11} {"employee":<36} {"status":>21}  reason')
        for att, status, late, r in changes:
            self.stdout.write(f'{att.date!s:<11} {att.email[:36]:<36} {(att.status or "-"):>9} → {status:<9}  {r.reason}')
        self.stdout.write(f'{len(changes)} day(s) would change' if not o['apply'] else f'{len(changes)} day(s) changed')
        if o['csv']:
            with open(o['csv'], 'w', newline='', encoding='utf-8') as fh:
                w = csv.writer(fh)
                w.writerow(['date', 'email', 'old_status', 'new_status', 'old_late_min', 'new_late_min',
                            'worked_min', 'credited_min', 'reason'])
                for att, status, late, r in changes:
                    w.writerow([att.date, att.email, att.status, status, att.late_minutes or 0, late,
                                r.worked, r.credited, r.reason])
            self.stdout.write(f'Wrote {o["csv"]}')
        if o['apply'] and changes:
            ds.apply_changes(changes, 'recalc_attendance --policy')
