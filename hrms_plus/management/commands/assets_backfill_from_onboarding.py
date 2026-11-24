"""Mirror existing onboarding IT asset allocations into the IT asset register.

Dry run by default (prints what would happen, changes nothing):
    python manage.py assets_backfill_from_onboarding
Apply:
    python manage.py assets_backfill_from_onboarding --apply

Safe to re-run: allocations already mirrored are skipped.
"""
from django.core.management.base import BaseCommand

from hrms_plus import assets_links


class Command(BaseCommand):
    help = 'Create register assets + assignments for existing onboarding IT asset allocations.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='Write the changes (default is a dry run).')
        parser.add_argument('--actor', default='system', help='Recorded as the actor on created rows.')

    def handle(self, *args, **opts):
        apply = opts['apply']
        report = assets_links.backfill(actor=opts['actor'], dry_run=not apply)
        linked = created = skipped = 0
        for r in report:
            linked += len(r['linked'])
            created += len(r['created'])
            skipped += len(r['skipped'])
            if r['linked'] or r['created'] or r['skipped']:
                self.stdout.write(f"allocation #{r['allocationId']} {r['email']} [{r['status']}]: "
                                  f"linked {', '.join(r['linked']) or '-'}; new {', '.join(r['created']) or '-'}"
                                  + (f"; skipped: {'; '.join(r['skipped'])}" if r['skipped'] else ''))
        self.stdout.write(('APPLIED' if apply else 'DRY RUN (nothing saved; re-run with --apply)') +
                          f': {len(report)} allocation(s), {linked} existing asset(s) linked, '
                          f'{created} asset(s) added to the register, {skipped} skipped')
