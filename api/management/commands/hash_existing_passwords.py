"""
Management command: hash_existing_passwords
-------------------------------------------
One-time migration that finds every AppUser whose password is still stored as
plain text and replaces it with a proper PBKDF2-SHA256 Django hash.

Usage
-----
    python manage.py hash_existing_passwords

Options
-------
    --dry-run   Print which accounts would be upgraded without writing anything.

Safety
------
* Idempotent — accounts that already carry a Django hash are skipped.
* Chunked reads (1 000 rows at a time) to avoid loading the full table.
* Wraps each row in its own try/except so one bad row never aborts the run.
"""

from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand

from api.models import AppUser

# All hash prefixes that Django's make_password() can produce.
_HASH_PREFIXES = ('pbkdf2_', 'argon2$', 'bcrypt$', 'sha1$', 'md5$')


def _is_already_hashed(password: str) -> bool:
    return any(password.startswith(p) for p in _HASH_PREFIXES)


class Command(BaseCommand):
    help = "Hash every AppUser password that is still stored as plain text."

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            default=False,
            help='Report what would be changed without actually writing to the database.',
        )

    def handle(self, *args, **options):
        dry_run: bool = options['dry_run']
        if dry_run:
            self.stdout.write(self.style.WARNING('DRY-RUN mode — no changes will be written.\n'))

        total = AppUser.objects.count()
        self.stdout.write(f'Scanning {total} user account(s)...\n')

        upgraded = 0
        skipped = 0
        errors = 0

        # Process in chunks to be memory-efficient on large tables.
        CHUNK = 1_000
        offset = 0
        while True:
            batch = list(AppUser.objects.order_by('id')[offset: offset + CHUNK])
            if not batch:
                break
            offset += CHUNK

            for user in batch:
                stored = user.password or ''
                if not stored:
                    # Blank password — skip (Google/SSO accounts commonly have none).
                    skipped += 1
                    continue
                from api.secret_box import is_password_hash
                if is_password_hash(stored):
                    skipped += 1
                    continue

                # Plain-text password detected.
                self.stdout.write(
                    f'  Upgrading: {user.email} (id={user.id})'
                )
                if not dry_run:
                    try:
                        AppUser.objects.filter(pk=user.pk).update(password=make_password(stored))
                        upgraded += 1
                    except Exception as exc:  # noqa: BLE001
                        errors += 1
                        self.stderr.write(
                            self.style.ERROR(f'    ERROR for {user.email}: {exc}')
                        )
                else:
                    upgraded += 1

        # SMTP passwords cannot be hashed (they are re-used to log in to the
        # mail server) — encrypt any still stored as plain text.
        from api.models import UserEmailConfig
        from api.secret_box import encrypt, encryption_ready, is_encrypted
        smtp_plain = [c for c in UserEmailConfig.objects.exclude(smtp_password='')
                      if not is_encrypted(c.smtp_password)]
        if smtp_plain and not encryption_ready():
            self.stderr.write(self.style.WARNING(
                f'{len(smtp_plain)} SMTP password(s) are plain text but HRMS_SECRETS_KEY is not set; '
                f'set it and run this command again.'))
        else:
            for cfg in smtp_plain:
                self.stdout.write(f'  Encrypting SMTP password: {cfg.user_email}')
                if not dry_run:
                    cfg.smtp_password = encrypt(cfg.smtp_password)
                    cfg.save(update_fields=['smtp_password'])

        # Summary
        self.stdout.write('\n' + '─' * 50)
        if dry_run:
            self.stdout.write(self.style.WARNING(
                f'DRY-RUN complete. {upgraded} account(s) would be upgraded, '
                f'{skipped} already hashed / blank, {errors} errors.'
            ))
        else:
            self.stdout.write(self.style.SUCCESS(
                f'Done. {upgraded} account(s) upgraded, '
                f'{skipped} already hashed / blank, {errors} errors.'
            ))
