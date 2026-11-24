"""Encryption at rest for sensitive identifiers (PAN, UAN, PF and bank account
numbers, passport numbers).

``EncryptedCharField`` / ``EncryptedTextField`` keep the value encrypted in the
database and plain in Python:

* **write** (``get_prep_value``): a non-blank value is stored as
  ``enc1:<Fernet token>`` using the key from ``api/secret_box`` (the same
  ``HRMS_SECRETS_KEY`` / key file as the SMTP and AI credentials — there is no
  second key). Blank stays blank. A value that is already ``enc1:`` is stored
  unchanged, so copying a value between rows, or saving a row whose value could
  not be decrypted, never double-encrypts or loses it.
* **read** (``from_db_value``): ``enc1:`` values are decrypted; legacy plain
  text passes through unchanged, so the code switch is safe before the data job
  (``manage.py encrypt_sensitive_fields``) has run.

Behaviour without a usable key
------------------------------
* Reading legacy plain values works.
* Reading an ``enc1:`` value gives a ``LockedValue``: a ``str`` that *is* the
  ciphertext (so saving the row back stores it unchanged — no data loss) and
  that every mask helper renders as ``LOCKED_MASK``. A warning is logged once
  per process. List pages keep working.
* Code that needs the real value (bank files, payslips, statutory returns,
  reveal) calls ``plain(value)``, which raises ``SecretsNotConfigured`` with a
  clear message instead of writing ciphertext into a file.
* Writing a non-blank plain value raises ``SecretsNotConfigured``. Unlike the
  SMTP password, a key is **never auto-generated** here: an unnoticed,
  un-backed-up key would put every employee's identifiers at risk, while a
  refused save is visible and recoverable. Configure ``HRMS_SECRETS_KEY`` (or
  the key file) first.

Lookups: the ciphertext is randomised, so ``filter(field=value)`` can never
match. Only ``isnull`` and ``exact`` against a blank value are allowed; any
other lookup raises. Fields that must be searched get a companion
``<field>_hash`` column holding ``blind_index(value)`` (HMAC-SHA256 with a key
derived from the secrets key).
"""
import hashlib
import hmac
import logging
import os
import re

from django.db import models
from django.db.models.lookups import Exact, IsNull

from . import secret_box
from .secret_box import SecretsNotConfigured

logger = logging.getLogger(__name__)

LOCKED_MASK = '•••• (locked)'

NO_KEY_WRITE_MSG = ('Sensitive identifiers are stored encrypted, but no encryption key is configured '
                    '(set HRMS_SECRETS_KEY or create the key file). The value was not saved.')
NO_KEY_READ_MSG = ('This value is encrypted and cannot be read: the encryption key (HRMS_SECRETS_KEY) '
                   'is missing or has changed.')


class LockedValue(str):
    """An ``enc1:`` value that could not be decrypted. The string content is the
    ciphertext itself, so writing it back stores it unchanged."""
    locked = True


def is_locked(value):
    return isinstance(value, LockedValue) or (isinstance(value, str) and secret_box.is_encrypted(value))


def plain(value):
    """The real value for server-side use (bank file, payslip, statutory file,
    reveal). Raises ``SecretsNotConfigured`` when it cannot be decrypted."""
    if value is None:
        return ''
    if is_locked(value):
        raise SecretsNotConfigured(NO_KEY_READ_MSG)
    return value


_warned = set()


def _warn_once(kind):
    if kind not in _warned:
        _warned.add(kind)
        if kind == 'nokey':
            logger.error('Encrypted identifiers cannot be read: %s is not set and no key file exists. '
                         'They are shown masked as "%s" until the key is restored.',
                         secret_box.SECRETS_ENV, LOCKED_MASK)
        else:
            logger.error('An encrypted identifier could not be decrypted with the configured key '
                         '(was %s changed?). It is shown masked as "%s".', secret_box.SECRETS_ENV, LOCKED_MASK)


def _key_fernet():
    """The Fernet of a configured key, never auto-creating one."""
    return secret_box.fernet(create=False)


def decrypt_value(value):
    """Plain text for ``enc1:`` values, the value itself for legacy plain text,
    a ``LockedValue`` when the ciphertext cannot be decrypted."""
    if not value or not isinstance(value, str) or not secret_box.is_encrypted(value):
        return value
    if isinstance(value, LockedValue):
        return value
    f = _key_fernet()
    if f is None:
        _warn_once('nokey')
        return LockedValue(value)
    try:
        return f.decrypt(value[len(secret_box.PREFIX):].encode()).decode()
    except Exception:
        _warn_once('badkey')
        return LockedValue(value)


def encrypt_value(value):
    """``enc1:`` ciphertext for a non-blank value. Already-encrypted values are
    returned unchanged. Raises ``SecretsNotConfigured`` without a key."""
    if value is None or value == '':
        return value
    value = str(value)
    if secret_box.is_encrypted(value):
        return value
    f = _key_fernet()
    if f is None:
        raise SecretsNotConfigured(NO_KEY_WRITE_MSG)
    return secret_box.PREFIX + f.encrypt(value.encode()).decode()


# ── key material ─────────────────────────────────────────────────────────
def raw_key():
    """The configured key string ('' when none). Never logged."""
    raw = (os.environ.get(secret_box.SECRETS_ENV) or '').strip()
    return raw or secret_box._read_key_file()


def key_fingerprint():
    raw = raw_key()
    return hashlib.sha256(raw.encode()).hexdigest()[:12] if raw else ''


def normalize_identifier(value):
    """Upper-case, without spaces / hyphens / dots / slashes."""
    return re.sub(r'[\s\-./]', '', str(value or '')).upper()


def blind_index(value):
    """HMAC-SHA256 of the normalised value, keyed by a key derived from the
    secrets key. '' for a blank value. Raises without a key."""
    norm = normalize_identifier(value)
    if not norm:
        return ''
    raw = raw_key()
    if not raw or _key_fernet() is None:
        raise SecretsNotConfigured(NO_KEY_WRITE_MSG)
    sub = hmac.new(raw.encode(), b'hrms-blind-index-v1', hashlib.sha256).digest()
    return hmac.new(sub, norm.encode(), hashlib.sha256).hexdigest()


# ── column width guard ───────────────────────────────────────────────────
_WIDTHS = {}


def column_width(connection, table, column):
    """Declared character width of a column (None when unknown/unbounded)."""
    key = (connection.alias, table, column)
    if key not in _WIDTHS:
        width = None
        try:
            with connection.cursor() as cur:
                for col in connection.introspection.get_table_description(cur, table):
                    if col.name == column:
                        width = getattr(col, 'internal_size', None) or getattr(col, 'display_size', None)
                        break
        except Exception:
            width = None
        try:
            width = int(width) if width else None
        except (TypeError, ValueError):
            width = None
        _WIDTHS[key] = width
    return _WIDTHS[key]


class ColumnTooNarrow(Exception):
    pass


# ── lookups ──────────────────────────────────────────────────────────────
class EncryptedExact(Exact):
    """Only ``field=''`` is meaningful on randomised ciphertext."""

    def get_prep_lookup(self):
        if self.rhs not in ('', None) and not hasattr(self.rhs, 'resolve_expression'):
            raise ValueError('%s is encrypted and cannot be filtered by value; use its _hash blind index.'
                             % getattr(self.lhs, 'target', self.lhs))
        return super().get_prep_lookup()


class EncryptedFieldMixin:
    encrypted = True

    def from_db_value(self, value, expression, connection):
        return decrypt_value(value)

    def to_python(self, value):
        value = super().to_python(value)
        return decrypt_value(value) if isinstance(value, str) else value

    def get_prep_value(self, value):
        value = super().get_prep_value(value)
        if value is None or value == '':
            return value
        return encrypt_value(value)

    def get_db_prep_save(self, value, connection):
        prepared = super().get_db_prep_save(value, connection)
        # A deploy that has not run the migration yet still has the old narrow
        # column. MySQL in non-strict mode would silently truncate the
        # ciphertext — unrecoverable — so refuse instead.
        if (isinstance(prepared, str) and isinstance(self, models.CharField)
                and connection.vendor == 'mysql' and getattr(self, 'model', None) is not None):
            width = column_width(connection, self.model._meta.db_table, self.column)
            if width and len(prepared) > width:
                raise ColumnTooNarrow(
                    f'{self.model._meta.db_table}.{self.column} is only {width} characters wide; run '
                    f'"manage.py migrate" before saving encrypted values.')
        return prepared

    def value_to_string(self, obj):
        # dumpdata / serializers: emit ciphertext, never the plain identifier.
        value = self.value_from_object(obj)
        try:
            return encrypt_value(value) or ''
        except SecretsNotConfigured:
            return value if is_locked(value) else ''

    def get_lookup(self, lookup_name):
        if lookup_name == 'exact':
            return EncryptedExact
        if lookup_name == 'isnull':
            return IsNull
        return None


class EncryptedCharField(EncryptedFieldMixin, models.CharField):
    """CharField stored encrypted. Use max_length=512: a Fernet token for a
    value of n bytes is about 4/3·(n + 57) characters, plus the 5-char prefix."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault('max_length', 512)
        super().__init__(*args, **kwargs)


class EncryptedTextField(EncryptedFieldMixin, models.TextField):
    pass


def encrypted_fields(model):
    return [f for f in model._meta.concrete_fields if getattr(f, 'encrypted', False)]


# ── DRF ──────────────────────────────────────────────────────────────────
def exception_handler(exc, context):
    """DRF exception handler: a missing key is a clear 503, not a bare 500."""
    from rest_framework.response import Response
    from rest_framework.views import exception_handler as default_handler
    if isinstance(exc, SecretsNotConfigured):
        return Response({'message': str(exc) or NO_KEY_READ_MSG, 'code': 'SECRETS_NOT_CONFIGURED'}, status=503)
    if isinstance(exc, ColumnTooNarrow):
        logger.error('%s', exc)
        return Response({'message': 'The database has not been migrated for encrypted identifiers yet. '
                                    'Ask an administrator to run the migrations.', 'code': 'MIGRATION_PENDING'},
                        status=503)
    return default_handler(exc, context)
