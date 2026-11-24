"""Shared security toolkit for the payroll extensions.

Every module in api/payroll_ext uses these instead of rolling its own:

* ``caller(request)``                 → (email, AppUser) or (None, None)
* ``require(request, perm, fresh=False)`` → (email, user, None) or (None, None, Response)
      perm may be a code, a tuple of codes (any), or None (any signed-in user).
      fresh=True additionally demands a valid sign-in token for the same person
      (a forged X-User-Email header alone is not enough) — use it for anything
      that moves money, changes credentials or releases files.
* ``issue_action_otp(user, purpose, ref)`` / ``verify_action_otp(email, purpose, ref, code)``
      6-digit, hashed, 10-minute, 5-attempt one-time codes sent by email.
* ``seal(text)`` / ``unseal(token)``    encrypt / decrypt (Fernet, api/secret_box).
* ``mask_account(no)``, ``mask_pan(pan)``, ``is_valid_pan(pan)``, ``is_valid_ifsc(code)``
* ``check_upload(b64, mime, max_mb)`` → (bytes, error)  — size + real file-type check.
* ``verify_hmac(secret, body_bytes, signature, timestamp=None, tolerance=300)``
* ``record_webhook(provider, event_id, payload, signature_ok)`` → (event, is_replay)
* ``audit(action, entity_type, entity_id, request|email, changes, notes)``
* ``get_secret(provider)`` / ``set_secret(provider, config_dict, mode, enabled, public, actor)``
"""
import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
from datetime import timedelta

from django.utils import timezone
from rest_framework.response import Response

logger = logging.getLogger(__name__)

OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
OTP_MIN_INTERVAL_S = 30            # rate limit: one new code per purpose/ref every 30 s


# ── identity / permissions ────────────────────────────────────────────────
def _msg(message, status, code=None, **extra):
    body = {'message': message}
    if code:
        body['code'] = code
    body.update(extra)
    return Response(body, status=status)


def caller(request):
    from ..permissions import _get_caller
    email, user = _get_caller(request)
    if not email or not user or getattr(user, 'status', 'active') != 'active':
        return None, None
    return email.lower(), user


def has_perm(user, perm):
    from ..permissions import _is_super_admin, _user_has_perm
    if user is None:
        return False
    if _is_super_admin(user):
        return True
    if perm is None:
        return True
    codes = perm if isinstance(perm, (tuple, list, set)) else (perm,)
    return any(_user_has_perm(user, c) for c in codes)


def is_super(user):
    from ..permissions import _is_super_admin
    return bool(user is not None and _is_super_admin(user))


def require(request, perm=None, fresh=False):
    """(email, user, None) when allowed, else (None, None, error Response)."""
    from ..permissions import _CACHE
    _CACHE.clear()
    email, user = caller(request)
    if not email:
        return None, None, _msg('Authentication required. Please sign in again.', 401, 'AUTH_REQUIRED')
    if not has_perm(user, perm):
        need = perm if isinstance(perm, str) else ' or '.join(perm or [])
        return None, None, _msg(f"You don't have permission to do this. Required: {need}", 403, 'PERMISSION_DENIED')
    if fresh:
        token_user = getattr(request, 'user', None)
        token_email = (getattr(token_user, 'email', '') or '').strip().lower()
        if not token_email or token_email != email:
            return None, None, _msg('For security, this action needs a fresh sign-in. Sign out and sign in again, '
                                    'then retry.', 401, 'REAUTH_REQUIRED')
    return email, user, None


def display_name(user, email=''):
    return (getattr(user, 'full_name', '') or '').strip() or (email or '').split('@')[0]


# ── action OTP ────────────────────────────────────────────────────────────
def _hash(code, salt):
    return hashlib.sha256(f'{salt}:{code}'.encode('utf-8')).hexdigest()


def issue_action_otp(user, purpose, ref='', subject='Your HRMS confirmation code', what='confirm this action'):
    """Email a fresh code. Returns {'ok', 'devEcho'?, 'message'} — never the code."""
    from ..models import ActionOtp
    from .. import mailer
    now = timezone.now()
    last = ActionOtp.objects.filter(email=user.email, purpose=purpose, ref=str(ref)).order_by('-id').first()
    if last and (now - last.created_at).total_seconds() < OTP_MIN_INTERVAL_S:
        return {'ok': False, 'message': 'A code was just sent. Wait a few seconds before asking for another.',
                'code': 'OTP_RATE_LIMIT'}
    ActionOtp.objects.filter(email=user.email, purpose=purpose, ref=str(ref), consumed=False).update(consumed=True)
    code = f'{secrets.randbelow(1_000_000):06d}'
    salt = secrets.token_hex(8)
    ActionOtp.objects.create(email=user.email, purpose=purpose, ref=str(ref), code_hash=_hash(code, salt),
                             salt=salt, expires_at=now + timedelta(minutes=OTP_TTL_MINUTES), created_at=now)
    html = mailer.render_branded(
        title='Confirmation code',
        intro=f'Hi {display_name(user, user.email)}, use this code to {what}. It expires in {OTP_TTL_MINUTES} minutes. '
              f'If you did not start this, do not share the code and tell your administrator.',
        highlight_html=(f'<div style="text-align:center;margin:8px 0 4px;"><span style="display:inline-block;'
                        f'font-family:Consolas,monospace;font-size:34px;font-weight:800;letter-spacing:10px;'
                        f'color:#4f8ef7;background:#eef4ff;border-radius:12px;padding:16px 28px;">{code}</span></div>'),
        footer='HRMS will never ask for this code by phone or chat.',
    )
    res = mailer.send_email(to=user.email, subject=subject, html=html,
                            text=f'Your HRMS confirmation code is {code}. It expires in {OTP_TTL_MINUTES} minutes.')
    out = {'ok': bool(res.get('ok')), 'message': 'A 6-digit code was sent to your email.'}
    if not res.get('ok'):
        from ..auth_views import _dev_otp_enabled
        if _dev_otp_enabled():
            print(f'\n[HRMS DEV OTP] {purpose} code for {user.email}: {code}\n')
            out.update({'ok': True, 'devEcho': True,
                        'message': 'Email is unavailable — the code was printed to the server console (dev mode).'})
        else:
            out['message'] = 'Could not send the code: ' + str(res.get('error') or 'email failed')
    return out


def verify_action_otp(email, purpose, ref, code):
    """(True, '') or (False, reason). Consumes the code on success."""
    from ..models import ActionOtp
    code = str(code or '').strip()
    otp = ActionOtp.objects.filter(email=email, purpose=purpose, ref=str(ref), consumed=False).order_by('-id').first()
    if not otp:
        return False, 'No active code. Request a new one.'
    if otp.expires_at < timezone.now():
        otp.consumed = True
        otp.save(update_fields=['consumed'])
        return False, 'This code has expired. Request a new one.'
    if otp.attempts >= OTP_MAX_ATTEMPTS:
        otp.consumed = True
        otp.save(update_fields=['consumed'])
        return False, 'Too many incorrect attempts. Request a new code.'
    if not code or not hmac.compare_digest(_hash(code, otp.salt), otp.code_hash):
        otp.attempts += 1
        otp.save(update_fields=['attempts'])
        return False, f'Incorrect code. {max(0, OTP_MAX_ATTEMPTS - otp.attempts)} attempt(s) left.'
    otp.consumed = True
    otp.save(update_fields=['consumed'])
    return True, ''


# ── encryption / masking / validation ────────────────────────────────────
def seal(text):
    from .. import secret_box
    return secret_box.encrypt(str(text)) if text else ''


def unseal(token):
    from .. import secret_box
    return secret_box.decrypt(token) if token else ''


def mask_account(no):
    s = re.sub(r'\s+', '', str(no or ''))
    return ('•' * max(0, len(s) - 4) + s[-4:]) if s else ''


_PAN_RE = re.compile(r'^[A-Z]{5}[0-9]{4}[A-Z]$')
_IFSC_RE = re.compile(r'^[A-Z]{4}0[A-Z0-9]{6}$')


def is_valid_pan(pan):
    return bool(_PAN_RE.match(str(pan or '').strip().upper()))


def is_valid_ifsc(code):
    return bool(_IFSC_RE.match(str(code or '').strip().upper()))


def mask_pan(pan):
    s = str(pan or '').strip().upper()
    return (s[:2] + '•••••' + s[-3:]) if len(s) == 10 else ('•' * len(s))


_MAGIC = {
    'application/pdf': [b'%PDF'],
    'image/png': [b'\x89PNG'],
    'image/jpeg': [b'\xff\xd8\xff'],
    'image/jpg': [b'\xff\xd8\xff'],
}


def check_upload(b64, mime, max_mb=5):
    """Decode a base64 upload and make sure it is really a PDF/PNG/JPEG of an
    acceptable size. Returns (bytes, '') or (None, error)."""
    mime = str(mime or '').lower().strip()
    if mime not in _MAGIC:
        return None, 'Only PDF, PNG or JPG files are allowed.'
    s = str(b64 or '')
    if ',' in s[:80] and s.startswith('data:'):
        s = s.split(',', 1)[1]
    try:
        raw = base64.b64decode(s, validate=True)
    except Exception:
        return None, 'The file could not be read.'
    if not raw:
        return None, 'The file is empty.'
    if len(raw) > max_mb * 1024 * 1024:
        return None, f'Files must be {max_mb} MB or smaller.'
    if not any(raw.startswith(m) for m in _MAGIC[mime]):
        return None, 'The file content does not match its type.'
    return raw, ''


def sha256_hex(raw):
    return hashlib.sha256(raw).hexdigest()


# ── webhooks ──────────────────────────────────────────────────────────────
def verify_hmac(secret, body, signature, timestamp=None, tolerance=300):
    """Constant-time HMAC-SHA256 check. When ``timestamp`` is given the signed
    message is ``f"{timestamp}.{body}"`` and stale timestamps are refused."""
    if not secret or not signature:
        return False
    if isinstance(body, str):
        body = body.encode('utf-8')
    msg = body
    if timestamp is not None:
        try:
            ts = int(str(timestamp))
        except ValueError:
            return False
        if abs(int(timezone.now().timestamp()) - ts) > tolerance:
            return False
        msg = str(ts).encode() + b'.' + body
    expected = hmac.new(secret.encode('utf-8'), msg, hashlib.sha256).hexdigest()
    sig = str(signature).strip()
    if sig.startswith('sha256='):
        sig = sig[7:]
    return hmac.compare_digest(expected, sig)


def record_webhook(provider, event_id, payload, signature_ok, error=''):
    """Store the callback; (event, is_replay). A replayed event_id is never re-processed."""
    from ..models import WebhookEvent
    from django.db import IntegrityError, transaction
    try:
        with transaction.atomic():
            ev = WebhookEvent.objects.create(provider=provider, event_id=str(event_id)[:120],
                                             signature_ok=bool(signature_ok),
                                             payload=payload if isinstance(payload, dict) else {'raw': str(payload)[:4000]},
                                             error=error[:255])
        return ev, False
    except IntegrityError:
        return WebhookEvent.objects.filter(provider=provider, event_id=str(event_id)[:120]).first(), True


# ── audit ─────────────────────────────────────────────────────────────────
def client_ip(request):
    if request is None:
        return ''
    fwd = request.META.get('HTTP_X_FORWARDED_FOR', '')
    return (fwd.split(',')[0].strip() if fwd else request.META.get('REMOTE_ADDR', ''))[:60]


def audit(action, entity_type, entity_id, request=None, email='', name='', changes=None, notes=''):
    """Write to PayrollAuditLog. Never raises. Never pass secrets in ``changes``."""
    try:
        from ..models import PayrollAuditLog
        PayrollAuditLog.objects.create(action=action[:60], entity_type=entity_type[:60], entity_id=str(entity_id)[:60],
                                       actor_email=(email or '')[:255], actor_name=(name or '')[:255],
                                       ip_address=client_ip(request), changes=changes or {}, notes=(notes or '')[:2000])
    except Exception:
        logger.exception('payroll audit write failed for %s', action)


# ── integration credentials ───────────────────────────────────────────────
def get_secret(provider):
    """(config_dict, row) — config is {} when missing / unreadable."""
    from ..models import IntegrationSecret
    row = IntegrationSecret.objects.filter(provider=provider).first()
    if not row or not row.encrypted_config:
        return {}, row
    raw = unseal(row.encrypted_config)
    try:
        return (json.loads(raw) if raw else {}), row
    except ValueError:
        return {}, row


def set_secret(provider, config, mode='test', enabled=False, public=None, actor=''):
    from ..models import IntegrationSecret
    row = IntegrationSecret.objects.filter(provider=provider).first() or IntegrationSecret(provider=provider)
    if config is not None:
        payload = json.dumps(config, sort_keys=True)
        row.encrypted_config = seal(payload)
        row.fingerprint = hashlib.sha256(payload.encode()).hexdigest()[:12]
    row.mode = 'live' if mode == 'live' else 'test'
    row.enabled = bool(enabled)
    if public is not None:
        row.public_config = public
    row.updated_by = actor
    row.updated_at = timezone.now()
    row.save()
    return row


def secret_meta(provider):
    """Safe metadata for the UI: never any secret value."""
    cfg, row = get_secret(provider)
    return {
        'provider': provider,
        'configured': bool(cfg),
        'enabled': bool(row and row.enabled),
        'mode': row.mode if row else 'test',
        'fingerprint': row.fingerprint if row else '',
        'fields': sorted(cfg.keys()),
        'public': (row.public_config if row else {}) or {},
        'updatedBy': row.updated_by if row else '',
        'updatedAt': row.updated_at.isoformat() if row and row.updated_at else None,
    }
