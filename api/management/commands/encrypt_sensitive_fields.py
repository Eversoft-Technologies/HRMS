"""Encrypt (or, in an emergency, decrypt) the sensitive identifier columns.

    python manage.py encrypt_sensitive_fields --dry-run
    python manage.py encrypt_sensitive_fields --i-have-backed-up-the-key
    python manage.py encrypt_sensitive_fields --decrypt --dry-run
    python manage.py encrypt_sensitive_fields --decrypt --i-have-backed-up-the-key

Every column declared as ``api.fields.EncryptedCharField/EncryptedTextField``
is processed. Safeguards:

* refuses unless a key is configured (``HRMS_SECRETS_KEY`` or an existing key
  file) — a key is never generated here;
* prints the key fingerprint and a loud "back up the key" notice; writing needs
  ``--i-have-backed-up-the-key``;
* ``--dry-run`` only counts (no writes) and reports values that do not decrypt
  with the configured key (a sign of a different key);
* refuses when a column is still too narrow for ciphertext (run migrate first);
* idempotent: ``enc1:`` values are skipped when encrypting, plain values are
  skipped when decrypting;
* works in batches, each in a transaction; every new value is verified to
  decrypt back to the original *before* it is written, the UPDATE only applies
  when the row still holds the value that was read (a concurrent edit is left
  alone and reported), and the stored value is read back and checked again
  before the batch commits — any mismatch rolls the batch back and stops;
* fills blind-index (``<field>_hash``) columns.
"""
from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from api import fields as F
from api import secret_box


class VerifyFailed(Exception):
    pass


# encrypted field -> companion blind-index column
HASH_COLUMNS = {
    ('api', 'BenchSalesProfile', 'passport_no'): 'passport_no_hash',
}


class Command(BaseCommand):
    help = 'Encrypt sensitive identifier columns in place (or --decrypt them for a rollback).'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='Count only; write nothing.')
        parser.add_argument('--decrypt', action='store_true',
                            help='Emergency rollback: turn enc1: values back into plain text.')
        parser.add_argument('--i-have-backed-up-the-key', action='store_true', dest='backed_up',
                            help='Required to write: confirms the key is backed up somewhere safe.')
        parser.add_argument('--batch-size', type=int, default=200)

    # ── helpers ──────────────────────────────────────────────────────────
    def _targets(self):
        out = []
        for model in apps.get_models():
            if model._meta.proxy or not model._meta.managed:
                continue
            flds = F.encrypted_fields(model)
            if flds:
                out.append((model, flds))
        return out

    def _q(self, name):
        return connection.ops.quote_name(name)

    def _fetch(self, model, columns, pks):
        table = self._q(model._meta.db_table)
        pkcol = self._q(model._meta.pk.column)
        cols = ', '.join(self._q(c) for c in columns)
        ph = ', '.join(['%s'] * len(pks))
        with connection.cursor() as cur:
            cur.execute(f'SELECT {pkcol}, {cols} FROM {table} WHERE {pkcol} IN ({ph})', list(pks))
            return {row[0]: dict(zip(columns, row[1:])) for row in cur.fetchall()}

    # ── main ─────────────────────────────────────────────────────────────
    def handle(self, *args, **opts):
        dry, decrypt, batch_size = opts['dry_run'], opts['decrypt'], max(1, opts['batch_size'])
        source = secret_box.key_source()
        f = F._key_fernet()
        if source not in ('environment', 'file') or f is None:
            raise CommandError(
                'No usable encryption key is configured. Set HRMS_SECRETS_KEY (or create the key file '
                f'{secret_box.key_file_path()}) first. This command never generates a key.')
        fp = F.key_fingerprint()
        bar = '!' * 78
        self.stdout.write(bar)
        self.stdout.write(f'  Key source: {source}    Key fingerprint (sha256[:12]): {fp}')
        self.stdout.write('  BACK UP THE KEY. Without this exact key the encrypted identifiers')
        self.stdout.write('  (PAN, UAN, PF, bank account, passport numbers) can NEVER be read again.')
        self.stdout.write('  Keep a copy outside this server and outside database backups.')
        self.stdout.write(bar)
        if not dry and not opts['backed_up']:
            raise CommandError('Refusing to write: re-run with --i-have-backed-up-the-key once the key '
                               f'(fingerprint {fp}) is backed up — or use --dry-run.')

        mode = 'decrypt' if decrypt else 'encrypt'
        self.stdout.write(f'Mode: {mode}{" (dry run — nothing is written)" if dry else ""}')
        totals = {'changed': 0, 'skipped': 0, 'undecryptable': 0, 'conflicts': 0}

        for model, flds in self._targets():
            label = model._meta.label
            cols = [fl.column for fl in flds]
            hash_cols = {fl.column: HASH_COLUMNS[(model._meta.app_label, model.__name__, fl.name)]
                         for fl in flds if (model._meta.app_label, model.__name__, fl.name) in HASH_COLUMNS}
            read_cols = cols + [h for h in hash_cols.values()]
            stats = {c: {'rows': 0, 'blank': 0, 'plain': 0, 'encrypted': 0, 'undecryptable': 0,
                         'changed': 0, 'conflict': 0} for c in cols}
            hashes_filled = 0
            pks = list(model._base_manager.order_by('pk').values_list('pk', flat=True))
            for i in range(0, len(pks), batch_size):
                chunk = pks[i:i + batch_size]
                try:
                    with transaction.atomic():
                        rows = self._fetch(model, read_cols, chunk)
                        for pk, vals in rows.items():
                            updates = {}
                            for fl in flds:
                                c = fl.column
                                raw = vals.get(c)
                                st = stats[c]
                                st['rows'] += 1
                                if raw is None or raw == '':
                                    st['blank'] += 1
                                    if c in hash_cols and vals.get(hash_cols[c]):
                                        updates[hash_cols[c]] = ''
                                    continue
                                is_enc = secret_box.is_encrypted(raw)
                                st['encrypted' if is_enc else 'plain'] += 1
                                plain_val = None
                                if is_enc:
                                    try:
                                        plain_val = f.decrypt(raw[len(secret_box.PREFIX):].encode()).decode()
                                    except Exception:
                                        st['undecryptable'] += 1
                                        continue
                                else:
                                    plain_val = raw
                                if not decrypt and not is_enc:
                                    new = secret_box.PREFIX + f.encrypt(raw.encode()).decode()
                                    if f.decrypt(new[len(secret_box.PREFIX):].encode()).decode() != raw:
                                        raise VerifyFailed(f'{label}#{pk}.{c}: ciphertext did not verify')
                                    updates[c] = new
                                elif decrypt and is_enc:
                                    updates[c] = plain_val
                                if c in hash_cols:
                                    digest = F.blind_index(plain_val)
                                    if vals.get(hash_cols[c]) != digest:
                                        updates[hash_cols[c]] = digest
                            changed_cols = [c for c in cols if c in updates]
                            if not updates:
                                continue
                            if dry:
                                for c in changed_cols:
                                    stats[c]['changed'] += 1
                                hashes_filled += sum(1 for h in hash_cols.values() if h in updates)
                                continue
                            self._check_widths(model, updates)
                            n = self._update(model, pk, updates, {c: vals[c] for c in updates})
                            if n != 1:
                                for c in changed_cols:
                                    stats[c]['conflict'] += 1
                                continue
                            after = self._fetch(model, list(updates), [pk])[pk]
                            for c in changed_cols:
                                got = after[c]
                                want_plain = (f.decrypt(updates[c][len(secret_box.PREFIX):].encode()).decode()
                                              if not decrypt else updates[c])
                                orig_plain = (vals[c] if not decrypt else
                                              f.decrypt(vals[c][len(secret_box.PREFIX):].encode()).decode())
                                stored_plain = (f.decrypt(got[len(secret_box.PREFIX):].encode()).decode()
                                                if secret_box.is_encrypted(got) else got)
                                if got != updates[c] or stored_plain != orig_plain or want_plain != orig_plain:
                                    raise VerifyFailed(f'{label}#{pk}.{c}: stored value did not verify')
                                stats[c]['changed'] += 1
                            hashes_filled += sum(1 for h in hash_cols.values() if h in updates)
                except VerifyFailed as e:
                    raise CommandError(f'Verification failed, batch rolled back, nothing further written: {e}')

            for c in cols:
                st = stats[c]
                verb = 'would change' if dry else 'changed'
                self.stdout.write(
                    f'  {label}.{c}: rows={st["rows"]} blank={st["blank"]} plain={st["plain"]} '
                    f'encrypted={st["encrypted"]} undecryptable={st["undecryptable"]} {verb}={st["changed"]}'
                    + (f' skipped-concurrent-edit={st["conflict"]}' if st['conflict'] else ''))
                totals['changed'] += st['changed']
                totals['undecryptable'] += st['undecryptable']
                totals['conflicts'] += st['conflict']
            if hash_cols:
                self.stdout.write(f'  {label}: blind-index values {"to fill" if dry else "filled"}={hashes_filled}')

        self.stdout.write(f'Done. {"Would change" if dry else "Changed"} {totals["changed"]} value(s).')
        if totals['undecryptable']:
            self.stdout.write(self.style.WARNING(
                f'{totals["undecryptable"]} encrypted value(s) do NOT decrypt with the key {fp}. They were left '
                'untouched. Was the data encrypted with a different key? Do not continue until this is explained.'))
        if totals['conflicts']:
            self.stdout.write(self.style.WARNING(
                f'{totals["conflicts"]} value(s) changed while this ran and were left alone; run the command again.'))

    def _check_widths(self, model, updates):
        for col, val in updates.items():
            fld = next((x for x in model._meta.concrete_fields if x.column == col), None)
            if fld is None or not hasattr(fld, 'max_length') or fld.get_internal_type() == 'TextField':
                continue
            width = F.column_width(connection, model._meta.db_table, col)
            if width and val and len(val) > width:
                raise CommandError(f'{model._meta.db_table}.{col} is only {width} characters wide. Run '
                                   '"python manage.py migrate" first. Nothing was written for this batch.')

    def _update(self, model, pk, updates, expected):
        table = self._q(model._meta.db_table)
        pkcol = self._q(model._meta.pk.column)
        sets = ', '.join(f'{self._q(c)} = %s' for c in updates)
        where = ' AND '.join(f'{self._q(c)} = %s' for c in expected)
        params = list(updates.values()) + [pk] + list(expected.values())
        with connection.cursor() as cur:
            cur.execute(f'UPDATE {table} SET {sets} WHERE {pkcol} = %s AND {where}', params)
            return cur.rowcount
