"""Credential protection helpers.

Two different tools for two different kinds of secret:

* **Login passwords are hashed** (Django's ``make_password``, PBKDF2 by
  default). A hash can only be checked, never read back — which is exactly
  what a login needs. ``is_password_hash`` tells a hash from plain text.

* **Credentials the server must re-use** (an SMTP password, the AI provider
  key) cannot be hashed: the server has to send the real value to the mail
  server / API. Those are **encrypted** (Fernet) with ``HRMS_SECRETS_KEY``,
  kept outside the database, and are never returned to the browser.

  Where the key comes from, in order:
    1. ``HRMS_SECRETS_KEY`` in the environment / .env — always wins;
    2. the key file ``HRMS_SECRETS_FILE`` (default ``~/.hrms/secrets.key``);
    3. nothing set: the first time something must be encrypted, a new key is
       generated into that file (owner-only permissions), unless
       ``HRMS_SECRETS_AUTOGEN=0``. The file lives in the server account's home,
       outside the code, the deploy release folders and database backups — a
       key stored next to the data it protects would protect nothing.
  Back the key up: if it is lost, saved secrets cannot be read and must be
  entered again. Encrypted values carry the ``enc1:`` prefix so legacy plain
  text can still be recognised (and is encrypted the next time it is saved,
  or by ``manage.py hash_existing_passwords``).
"""
import logging
import os

logger = logging.getLogger(__name__)

SECRETS_ENV = 'HRMS_SECRETS_KEY'
SECRETS_FILE_ENV = 'HRMS_SECRETS_FILE'
SECRETS_AUTOGEN_ENV = 'HRMS_SECRETS_AUTOGEN'
PREFIX = 'enc1:'


class SecretsNotConfigured(Exception):
    """HRMS_SECRETS_KEY is missing or invalid, so nothing can be encrypted."""


# --- hashing (login passwords) -------------------------------------------------
def is_password_hash(value):
    """True when ``value`` is a hash produced by Django's make_password."""
    if not value:
        return False
    from django.contrib.auth.hashers import identify_hasher
    try:
        identify_hasher(value)
        return True
    except ValueError:
        return False


def hash_password(raw):
    """Hash a raw password; blank stays blank (Google/SSO accounts have none)
    and an existing hash is kept as it is (never double-hashed)."""
    if not raw or is_password_hash(raw):
        return raw or ''
    from django.contrib.auth.hashers import make_password
    return make_password(raw)


# --- encryption (credentials the server must re-use) ---------------------------
def key_file_path():
    from pathlib import Path
    raw = (os.environ.get(SECRETS_FILE_ENV) or '').strip()
    return Path(raw).expanduser() if raw else Path.home() / '.hrms' / 'secrets.key'


def _autogen_allowed():
    return (os.environ.get(SECRETS_AUTOGEN_ENV) or '1').strip().lower() not in ('0', 'false', 'no', 'off')


def _read_key_file():
    try:
        return key_file_path().read_text(encoding='ascii').strip()
    except (OSError, UnicodeDecodeError):
        return ''


def _create_key_file():
    """Write a new Fernet key to the key file (never overwriting one). Returns
    the key, or '' when the file cannot be created."""
    from cryptography.fernet import Fernet
    path = key_file_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path.parent, 0o700)
        except OSError:
            pass
        key = Fernet.generate_key()
        # O_EXCL: if another worker created it a moment ago, use theirs.
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as fh:
            fh.write(key + b'\n')
        logger.warning('Created a new encryption key file at %s (%s was not set). Back this file up: '
                       'without it, secrets saved from the UI cannot be read.', path, SECRETS_ENV)
        return key.decode()
    except FileExistsError:
        return _read_key_file()
    except OSError as e:
        logger.error('Could not create the encryption key file %s: %s', path, e)
        return ''


def key_source():
    """'environment' | 'file' | 'auto' (created on first save) | None."""
    if (os.environ.get(SECRETS_ENV) or '').strip():
        return 'environment'
    if _read_key_file():
        return 'file'
    return 'auto' if _autogen_allowed() else None


def fernet(create=False):
    raw = (os.environ.get(SECRETS_ENV) or '').strip()
    where = SECRETS_ENV
    if not raw:
        raw = _read_key_file()
        where = str(key_file_path())
    if not raw and create and _autogen_allowed():
        raw = _create_key_file()
    if not raw:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(raw.encode())
    except Exception:
        # Never log the value; only that it is unusable.
        logger.error('The encryption key in %s is not a valid Fernet key; encrypted secrets are disabled.', where)
        return None


def encryption_ready():
    """True when a secret can be encrypted now — including when the key file
    would be created on the first save."""
    if fernet() is not None:
        return True
    if not _autogen_allowed() or (os.environ.get(SECRETS_ENV) or '').strip() or _read_key_file():
        return False      # disabled, or a key is set but unusable: never paper over it
    return True


def is_encrypted(value):
    return bool(value) and str(value).startswith(PREFIX)


def encrypt(plain):
    """``enc1:<token>`` for a non-blank value; blank stays blank."""
    if not plain:
        return ''
    if is_encrypted(plain):
        return plain
    f = fernet(create=True)
    if f is None:
        raise SecretsNotConfigured()
    return PREFIX + f.encrypt(str(plain).encode()).decode()


def decrypt(value):
    """The plain value. Legacy plain text is returned as is; an ``enc1:`` value
    that cannot be decrypted (key missing/changed) gives ''."""
    if not value:
        return ''
    if not is_encrypted(value):
        return value
    f = fernet()
    if f is None:
        logger.warning('An encrypted secret could not be read: %s is not set.', SECRETS_ENV)
        return ''
    try:
        return f.decrypt(value[len(PREFIX):].encode()).decode()
    except Exception:
        logger.warning('An encrypted secret could not be decrypted (was %s changed?).', SECRETS_ENV)
        return ''
