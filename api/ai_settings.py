"""Server-managed AI provider key (Settings > AI Settings).

Where the key comes from — in order:

1. **Managed key**: saved from the AI Settings page. Stored only encrypted
   (Fernet) in ``ai_provider_settings``; the encryption key is the
   ``HRMS_SECRETS_KEY`` environment variable, which never touches the database.
2. **Environment**: ``ANTHROPIC_API_KEY`` in the server environment / .env.
3. **Legacy environment**: ``VITE_ANTHROPIC_API_KEY``. Still honoured so an
   existing deployment keeps working, but reported as deprecated: VITE_-prefixed
   values can be compiled into browser code by the frontend build.

"Remove key" deletes the managed key; AI then falls back to (2)/(3), or is
unavailable if neither is set. The status endpoint always says which source
is active, so nobody is surprised by the fallback.

The key is never returned by any endpoint, never written to logs, and never
stored in the audit trail. Browsers can no longer substitute their own key: the
``x-api-key`` request header is ignored by every AI endpoint.

Permissions:
  * ``ai.settings.view``   - read safe metadata (configured, source, provider, model) and the audit trail
  * ``ai.settings.manage`` - test, save/rotate and remove the key; additionally
    requires a valid sign-in token for the same user (a forged ``X-User-Email``
    header alone is not enough to replace the organisation's AI credentials).
"""
import hashlib
import logging
import os

import requests
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import AIProviderSetting, AISettingsAudit
from .permissions import _CACHE as _PERM_CACHE, check_perm, require_perm

logger = logging.getLogger(__name__)

PROVIDER = 'anthropic'
PROVIDER_LABEL = 'Anthropic'
SECRETS_ENV = 'HRMS_SECRETS_KEY'
MIN_KEY_LEN = 20
MAX_KEY_LEN = 400


class SecretsNotConfigured(Exception):
    pass


# ---------------------------------------------------------------------------
# encryption
# ---------------------------------------------------------------------------
def _fernet():
    raw = (os.environ.get(SECRETS_ENV) or '').strip()
    if not raw:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(raw.encode())
    except Exception:
        # Never log the value; only that it is unusable.
        logger.error('%s is set but is not a valid Fernet key; managed secrets are disabled.', SECRETS_ENV)
        return None


def encryption_ready():
    return _fernet() is not None


def _encrypt(plain):
    f = _fernet()
    if f is None:
        raise SecretsNotConfigured()
    return f.encrypt(plain.encode()).decode()


def _decrypt(token):
    f = _fernet()
    if f is None or not token:
        return None
    try:
        return f.decrypt(token.encode()).decode()
    except Exception:
        return None


def fingerprint(key):
    """Short, non-reversible identifier for a key (shown to admins, audited)."""
    return hashlib.sha256((key or '').encode()).hexdigest()[:12] if key else ''


# ---------------------------------------------------------------------------
# key resolution (used by api/ai.py for every AI call)
# ---------------------------------------------------------------------------
def _managed_row():
    try:
        return AIProviderSetting.objects.filter(provider=PROVIDER).first()
    except Exception:
        # Table missing (migration not applied yet) must not break AI calls.
        return None


def resolve_key():
    """(key, source) — source is 'managed', 'environment', 'legacy_environment' or None."""
    row = _managed_row()
    if row and row.encrypted_key:
        key = _decrypt(row.encrypted_key)
        if key:
            return key, 'managed'
        logger.warning('A managed AI key is stored but cannot be decrypted (is %s set to the key '
                       'it was saved with?). Falling back to the environment.', SECRETS_ENV)
    env = (os.environ.get('ANTHROPIC_API_KEY') or '').strip()
    if env:
        return env, 'environment'
    legacy = (os.environ.get('VITE_ANTHROPIC_API_KEY') or '').strip()
    if legacy:
        return legacy, 'legacy_environment'
    return None, None


def active_key():
    return resolve_key()[0]


# ---------------------------------------------------------------------------
# validation: one minimal request (1 output token) against the provider
# ---------------------------------------------------------------------------
def test_key(key):
    """(ok, message). Never includes the key in the message."""
    from . import ai
    try:
        resp = requests.post(
            ai.ANTHROPIC_URL,
            headers={'Content-Type': 'application/json', 'x-api-key': key,
                     'anthropic-version': ai.ANTHROPIC_VERSION},
            json={'model': ai.VALIDATION_MODEL, 'max_tokens': 1,
                  'messages': [{'role': 'user', 'content': 'hi'}]},
            timeout=15,
        )
    except requests.RequestException:
        return False, 'Could not reach the Anthropic API from this server. Check its internet access and try again.'
    if resp.ok:
        return True, 'The key works.'
    if resp.status_code == 401:
        return False, 'Anthropic rejected this key (invalid or revoked).'
    if resp.status_code == 403:
        return False, 'This key is not allowed to use the configured model.'
    if resp.status_code == 429:
        return False, 'The key is rate-limited or out of credit right now.'
    return False, ai._upstream_error(resp).replace(key, '[key]')


# ---------------------------------------------------------------------------
# helpers for the views
# ---------------------------------------------------------------------------
_SOURCE_LABEL = {
    'managed': 'Saved in HRMS (encrypted on the server)',
    'environment': 'Server environment (ANTHROPIC_API_KEY)',
    'legacy_environment': 'Server environment (VITE_ANTHROPIC_API_KEY, deprecated)',
    None: 'Not configured',
}


def metadata():
    """Everything the AI Settings page may show. Contains no key material."""
    from . import ai
    row = _managed_row()
    key, source = resolve_key()
    managed_unreadable = bool(row and row.encrypted_key and source != 'managed')
    return {
        'provider': PROVIDER,
        'providerLabel': PROVIDER_LABEL,
        'model': ai.GENERATION_MODEL,
        'validationModel': ai.VALIDATION_MODEL,
        'configured': bool(key),
        'source': source,
        'sourceLabel': _SOURCE_LABEL.get(source, source),
        'keyFingerprint': fingerprint(key) if key else '',
        'managed': {
            'present': bool(row and row.encrypted_key),
            'readable': not managed_unreadable,
            'fingerprint': row.key_fingerprint if row and row.encrypted_key else '',
            'updatedBy': row.updated_by if row and row.encrypted_key else '',
            'updatedAt': row.updated_at.isoformat() if row and row.encrypted_key and row.updated_at else None,
            'validatedAt': row.validated_at.isoformat() if row and row.encrypted_key and row.validated_at else None,
        },
        'environmentKeyPresent': bool((os.environ.get('ANTHROPIC_API_KEY') or '').strip()),
        'legacyViteKeyPresent': bool((os.environ.get('VITE_ANTHROPIC_API_KEY') or '').strip()),
        'encryptionReady': encryption_ready(),
        'fallbackPolicy': ('Removing the saved key makes AI use ANTHROPIC_API_KEY from the server '
                           'environment if it is set; otherwise AI features are switched off.'),
    }


def _audit(actor, action, fp='', detail=''):
    AISettingsAudit.objects.create(actor_email=actor, action=action, provider=PROVIDER,
                                   key_fingerprint=fp or '', detail=(detail or '')[:255])


def _reset_ai_status_cache():
    from . import ai
    ai.reset_status_cache()


def _msg(message, status, code=None):
    body = {'message': message}
    if code:
        body['code'] = code
    return Response(body, status=status)


def _manage_guard(request):
    """ai.settings.manage plus a valid sign-in token for the same person.

    Returns (caller_email, None) or (None, error_response)."""
    _PERM_CACHE.clear()   # same per-request reset require_perm does
    allowed, caller, user = check_perm(request, 'ai.settings.manage')
    if not caller or not user:
        return None, _msg('Authentication required. Please sign in again.', 401, 'AUTH_REQUIRED')
    if not allowed:
        return None, _msg("You don't have permission to change the AI settings. Required: ai.settings.manage",
                          403, 'PERMISSION_DENIED')
    token_user = getattr(request, 'user', None)
    token_email = (getattr(token_user, 'email', '') or '').strip().lower()
    if not token_email or token_email != caller:
        return None, _msg('For security, changing the AI key needs a fresh sign-in. '
                          'Sign out and sign in again, then retry.', 401, 'REAUTH_REQUIRED')
    return caller, None


def _proposed_key(request):
    try:
        key = str(request.data.get('apiKey') or '').strip()
    except Exception:
        key = ''
    if not key:
        return None, 'Enter the API key.'
    if len(key) < MIN_KEY_LEN or len(key) > MAX_KEY_LEN or any(c.isspace() for c in key):
        return None, "That doesn't look like an API key."
    return key, None


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------
@api_view(['GET'])
@require_perm('ai.settings.view')
def ai_settings(request):
    meta = metadata()
    meta['canManage'] = check_perm(request, 'ai.settings.manage')[0]
    return Response(meta)


@api_view(['POST'])
def ai_settings_validate(request):
    """Test a proposed key without saving it."""
    caller, denied = _manage_guard(request)
    if denied:
        return denied
    key, problem = _proposed_key(request)
    if problem:
        return _msg(problem, 400)
    ok, message = test_key(key)
    _audit(caller, 'key_tested' if ok else 'key_test_failed', fingerprint(key), '' if ok else message)
    return Response({'valid': ok, 'message': message, 'keyFingerprint': fingerprint(key)})


@api_view(['PUT', 'DELETE'])
def ai_settings_key(request):
    caller, denied = _manage_guard(request)
    if denied:
        return denied

    if request.method == 'DELETE':
        row = _managed_row()
        if not row or not row.encrypted_key:
            return _msg('There is no saved key to remove.', 404)
        old_fp = row.key_fingerprint
        row.encrypted_key, row.key_fingerprint, row.validated_at = '', '', None
        row.updated_by = caller
        row.save()
        _reset_ai_status_cache()
        meta = metadata()
        _audit(caller, 'key_removed', old_fp,
               'fallback: ' + (meta['source'] or 'none (AI switched off)'))
        return Response(meta)

    # PUT: validate first, then save (or rotate) — never activate a broken key.
    if not encryption_ready():
        return _msg(f'Saving a key from the UI is disabled because {SECRETS_ENV} is not set on the '
                    f'server. Set it (see README_DJANGO.md), or put the key in ANTHROPIC_API_KEY instead.',
                    503, 'ENCRYPTION_NOT_CONFIGURED')
    key, problem = _proposed_key(request)
    if problem:
        return _msg(problem, 400)
    ok, message = test_key(key)
    fp = fingerprint(key)
    if not ok:
        _audit(caller, 'key_rejected', fp, message)
        return _msg(f'Key not saved: {message}', 400, 'KEY_INVALID')
    row = _managed_row() or AIProviderSetting(provider=PROVIDER)
    rotated = bool(row.encrypted_key)
    row.encrypted_key = _encrypt(key)
    row.key_fingerprint = fp
    row.validated_at = timezone.now()
    row.updated_by = caller
    row.save()
    _reset_ai_status_cache()
    _audit(caller, 'key_rotated' if rotated else 'key_saved', fp)
    return Response(metadata())


@api_view(['GET'])
@require_perm('ai.settings.view')
def ai_settings_audit(request):
    rows = AISettingsAudit.objects.all()[:50]
    return Response({'events': [{
        'actor': r.actor_email, 'action': r.action, 'keyFingerprint': r.key_fingerprint,
        'detail': r.detail, 'at': r.created_at.isoformat() if r.created_at else None,
    } for r in rows]})
