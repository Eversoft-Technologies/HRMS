"""Credential protection helpers.

Two different tools for two different kinds of secret:

* **Login passwords are hashed** (Django's ``make_password``, PBKDF2 by
  default). A hash can only be checked, never read back — which is exactly
  what a login needs. ``is_password_hash`` tells a hash from plain text.

* **Credentials the server must re-use** (an SMTP password, the AI provider
  key) cannot be hashed: the server has to send the real value to the mail
  server / API. Those are **encrypted** (Fernet) with ``HRMS_SECRETS_KEY``,
  an environment variable kept outside the database, and are never returned
  to the browser. Encrypted values carry the ``enc1:`` prefix so legacy plain
  text can still be recognised (and is encrypted the next time it is saved,
  or by ``manage.py hash_existing_passwords``).
"""
import logging
import os

logger = logging.getLogger(__name__)

SECRETS_ENV = 'HRMS_SECRETS_KEY'
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
def fernet():
    raw = (os.environ.get(SECRETS_ENV) or '').strip()
    if not raw:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(raw.encode())
    except Exception:
        # Never log the value; only that it is unusable.
        logger.error('%s is set but is not a valid Fernet key; encrypted secrets are disabled.', SECRETS_ENV)
        return None


def encryption_ready():
    return fernet() is not None


def is_encrypted(value):
    return bool(value) and str(value).startswith(PREFIX)


def encrypt(plain):
    """``enc1:<token>`` for a non-blank value; blank stays blank."""
    if not plain:
        return ''
    if is_encrypted(plain):
        return plain
    f = fernet()
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
