"""Speech-to-text (Deepgram) key, managed from Settings › AI Settings.

Same rules as the Anthropic key (api/ai_settings.py), same storage table
(``ai_provider_settings``, one row per provider — this one is 'deepgram'):

1. **Managed key**: saved from the AI Settings page, stored only encrypted
   (Fernet, api/secret_box.py), never returned by any endpoint or logged.
2. **Environment**: ``DEEPGRAM_API_KEY`` in the server .env — the fallback.

A key is checked against Deepgram before it is saved, so a typo never
switches transcription off. Changes go to the same audit trail as the AI key.

Permissions are the AI ones: ``ai.settings.view`` to see the status,
``ai.settings.manage`` (plus a fresh sign-in) to test / save / remove.
"""
import logging
import os

import requests
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import ai_settings as base
from .models import AIProviderSetting, AISettingsAudit
from .permissions import check_perm, require_perm

logger = logging.getLogger(__name__)

PROVIDER = 'deepgram'
PROVIDER_LABEL = 'Deepgram'
ENV = 'DEEPGRAM_API_KEY'
CHECK_URL = 'https://api.deepgram.com/v1/projects'     # free call: lists the key's projects


def _row():
    try:
        return AIProviderSetting.objects.filter(provider=PROVIDER).first()
    except Exception:
        return None


def resolve_key():
    """(key, source) — 'managed', 'environment' or None."""
    row = _row()
    if row and row.encrypted_key:
        key = base._decrypt(row.encrypted_key)
        if key:
            return key, 'managed'
        logger.warning('A saved Deepgram key cannot be decrypted (was %s changed?). Using the environment.',
                       base.SECRETS_ENV)
    env = (os.environ.get(ENV) or '').strip()
    if env:
        return env, 'environment'
    return None, None


def active_key():
    return resolve_key()[0]


def test_key(key):
    """(ok, message) — never echoes the key."""
    try:
        r = requests.get(CHECK_URL, headers={'Authorization': 'Token ' + key}, timeout=15)
    except requests.RequestException:
        return False, 'Could not reach Deepgram from this server. Check its internet access and try again.'
    if r.status_code == 200:
        return True, 'The key works.'
    if r.status_code in (401, 403):
        return False, 'Deepgram rejected this key (invalid or revoked).'
    if r.status_code == 402:
        return False, 'The Deepgram account is out of credit.'
    return False, f'Deepgram answered HTTP {r.status_code}. Try again in a minute.'


_SOURCE_LABEL = {
    'managed': 'Saved in HRMS (encrypted on the server)',
    'environment': 'Server environment (DEEPGRAM_API_KEY)',
    None: 'Not configured',
}


def metadata():
    row = _row()
    key, source = resolve_key()
    present = bool(row and row.encrypted_key)
    return {
        'provider': PROVIDER,
        'providerLabel': PROVIDER_LABEL,
        'model': os.environ.get('DEEPGRAM_MODEL') or 'nova-3',
        'language': os.environ.get('DEEPGRAM_LANGUAGE') or 'en-IN',
        'configured': bool(key),
        'source': source,
        'sourceLabel': _SOURCE_LABEL.get(source, source),
        'keyFingerprint': base.fingerprint(key) if key else '',
        'managed': {
            'present': present,
            'readable': not (present and source != 'managed'),
            'updatedBy': row.updated_by if present else '',
            'updatedAt': row.updated_at.isoformat() if present and row.updated_at else None,
            'validatedAt': row.validated_at.isoformat() if present and row.validated_at else None,
        },
        'environmentKeyPresent': bool((os.environ.get(ENV) or '').strip()),
        'encryptionReady': base.encryption_ready(),
        'fallbackPolicy': ('Removing the saved key makes transcription use DEEPGRAM_API_KEY from the server '
                           'environment if it is set; otherwise interviews keep only the live captions.'),
    }


def _audit(actor, action, fp='', detail=''):
    AISettingsAudit.objects.create(actor_email=actor, action=action, provider=PROVIDER,
                                   key_fingerprint=fp or '', detail=(detail or '')[:255])


@api_view(['GET'])
@require_perm('ai.settings.view')
def stt_settings(request):
    meta = metadata()
    meta['canManage'] = check_perm(request, 'ai.settings.manage')[0]
    return Response(meta)


@api_view(['POST'])
def stt_settings_validate(request):
    caller, denied = base._manage_guard(request)
    if denied:
        return denied
    key, problem = base._proposed_key(request)
    if problem:
        return base._msg(problem, 400)
    ok, message = test_key(key)
    _audit(caller, 'key_tested' if ok else 'key_test_failed', base.fingerprint(key), '' if ok else message)
    return Response({'valid': ok, 'message': message, 'keyFingerprint': base.fingerprint(key)})


@api_view(['PUT', 'DELETE'])
def stt_settings_key(request):
    caller, denied = base._manage_guard(request)
    if denied:
        return denied
    if request.method == 'DELETE':
        row = _row()
        if not row or not row.encrypted_key:
            return base._msg('There is no saved key to remove.', 404)
        old_fp = row.key_fingerprint
        row.encrypted_key, row.key_fingerprint, row.validated_at = '', '', None
        row.updated_by = caller
        row.save()
        meta = metadata()
        _audit(caller, 'key_removed', old_fp, 'fallback: ' + (meta['source'] or 'none (live captions only)'))
        return Response(meta)

    if not base.encryption_ready():
        return base._msg(f'Saving a key from the UI is disabled: the server has no usable encryption key '
                         f'({base.SECRETS_ENV}). Put the key in {ENV} in the server .env instead.',
                         503, 'ENCRYPTION_NOT_CONFIGURED')
    key, problem = base._proposed_key(request)
    if problem:
        return base._msg(problem, 400)
    ok, message = test_key(key)
    fp = base.fingerprint(key)
    if not ok:
        _audit(caller, 'key_rejected', fp, message)
        return base._msg(f'Key not saved: {message}', 400, 'KEY_INVALID')
    row = _row() or AIProviderSetting(provider=PROVIDER)
    rotated = bool(row.encrypted_key)
    row.encrypted_key = base._encrypt(key)
    row.key_fingerprint = fp
    row.validated_at = timezone.now()
    row.updated_by = caller
    row.save()
    _audit(caller, 'key_rotated' if rotated else 'key_saved', fp)
    return Response(metadata())


@api_view(['GET'])
@require_perm('ai.settings.view')
def stt_settings_audit(request):
    rows = AISettingsAudit.objects.filter(provider=PROVIDER)[:50]
    return Response({'events': [{
        'actor': r.actor_email, 'action': r.action, 'keyFingerprint': r.key_fingerprint,
        'detail': r.detail, 'at': r.created_at.isoformat() if r.created_at else None,
    } for r in rows]})
