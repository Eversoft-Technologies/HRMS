

"""
Per-user LinkedIn OAuth so each recruiter can link their OWN LinkedIn account.

Once linked, jobs the recruiter creates are auto-posted to that recruiter's
profile by api/social_poster.py — never to a colleague's account.

  GET  /api/auth/linkedin/connect?userEmail=...   302 -> LinkedIn authorize
  GET  /api/auth/linkedin/callback?code=&state=   HTML that postMessages the opener
  GET  /api/auth/linkedin/status?userEmail=...    -> {configured, connected, expired, name}
  POST /api/auth/linkedin/disconnect  {userEmail} -> clears the stored token

The token, the member's author URN and the expiry are stored on
``UserEmailConfig.social['linkedinAuth']``. They deliberately do NOT go in
``social['linkedin']``: that key is a plain profile-URL string owned by the
React Settings form, and turning it into an object would render
"[object Object]" in its input. social_poster.py merges the two.

LinkedIn access tokens last ~60 days and refresh tokens are not granted to
standard apps, so there is deliberately no refresh loop: an expired connection
surfaces as a "Reconnect" button in Settings.

The frontend half of this lives in dist/dist/assets/hrms-linkedin.js.
"""
import json
import logging
import secrets
from datetime import timedelta
from urllib.parse import urlencode

import requests as http_requests
from django.conf import settings
from django.core import signing
from django.http import HttpResponse, HttpResponseRedirect
from django.utils import timezone
from django.utils.html import escape
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import AppUser, UserEmailConfig
from .views import err, norm_email, safe_json

logger = logging.getLogger(__name__)

AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization'
TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken'
USERINFO_URL = 'https://api.linkedin.com/v2/userinfo'

# openid/profile/email -> "Sign In with LinkedIn using OpenID Connect" (gives us
# the member's `sub`, which becomes the author URN).
# w_member_social      -> "Share on LinkedIn" (permission to publish the post).
SCOPES = 'openid profile email w_member_social'

STATE_SALT = 'hrms.linkedin.oauth'
STATE_MAX_AGE = 600  # 10 minutes to complete the handshake
TIMEOUT = 20

# Where the OAuth credentials live, beside the form-owned social['linkedin'].
AUTH_KEY = 'linkedinAuth'


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _is_configured():
    return bool(settings.LINKEDIN_CLIENT_ID and settings.LINKEDIN_CLIENT_SECRET)


def _redirect_uri(request):
    """The callback URL registered on the LinkedIn app.

    Falls back to the request's own host so a tunnelled dev server works
    without extra configuration, mirroring how HRMS_PUBLIC_URL is treated in
    onboarding_views.py.
    """
    configured = getattr(settings, 'LINKEDIN_REDIRECT_URI', '')
    if configured:
        return configured
    return request.build_absolute_uri('/api/auth/linkedin/callback')


def _get_social(email):
    """Return (config_row_or_None, social_dict) for a user."""
    cfg = UserEmailConfig.objects.filter(pk=email).first()
    if not cfg:
        return None, {}
    social = safe_json(cfg.social)
    if not isinstance(social, dict):
        social = cfg.social if isinstance(cfg.social, dict) else {}
    return cfg, social


def _auth_entry(social):
    """The stored OAuth credentials, normalised to a dict."""
    val = (social or {}).get(AUTH_KEY)
    return dict(val) if isinstance(val, dict) else {}


def _save_auth(email, entry):
    """Persist (or clear) the OAuth credentials for `email`.

    Only touches social[AUTH_KEY]; the form-owned social['linkedin'] URL is
    left exactly as the user typed it.
    """
    cfg, social = _get_social(email)
    social = dict(social or {})
    if entry:
        social[AUTH_KEY] = entry
    else:
        social.pop(AUTH_KEY, None)
    if cfg:
        cfg.social = social
        cfg.save(update_fields=['social', 'updated_at'])
    else:
        UserEmailConfig.objects.create(user_email=email, social=social)


def _popup_result(ok, message):
    """HTML for the OAuth popup: notify the opener, then close.

    Every exit path from `callback` must return this, otherwise the popup is
    left hanging on a blank page. The message shape is the contract that
    hrms-linkedin.js's `message` listener already expects.
    """
    payload = {
        'source': 'hrms-linkedin',
        'ok': bool(ok),
        'message': message,
    }
    body = json.dumps(payload)
    html = f"""<!doctype html>
<meta charset="utf-8">
<title>LinkedIn</title>
<body style="font:14px/1.5 system-ui,sans-serif;padding:32px;text-align:center;color:#334155">
<p>{escape(message)}</p>
<p style="color:#94a3b8;font-size:12.5px">You can close this window.</p>
<script>
  (function () {{
    var data = {body};
    try {{ if (window.opener) window.opener.postMessage(data, '*'); }} catch (e) {{}}
    setTimeout(function () {{ try {{ window.close(); }} catch (e) {{}} }}, {600 if ok else 2500});
  }})();
</script>
</body>"""
    return HttpResponse(html, content_type='text/html; charset=utf-8')


def _expiry_state(entry):
    """(connected, expired) for a stored linkedin entry."""
    connected = bool(entry.get('accessToken') and entry.get('authorUrn'))
    if not connected:
        return False, False
    expires_at = entry.get('expiresAt')
    if not expires_at:
        return True, False
    parsed = _parse_iso(expires_at)
    if not parsed:
        return True, False
    return True, parsed <= timezone.now()


def _parse_iso(value):
    """Parse a stored ISO timestamp into something comparable to
    ``timezone.now()``.

    This project runs USE_TZ=False (naive datetimes, inherited from the old
    Node app), so now() is naive. Match whichever convention is configured —
    mixing the two raises TypeError on comparison.
    """
    from django.utils.dateparse import parse_datetime
    try:
        dt = parse_datetime(str(value))
    except (TypeError, ValueError):
        return None
    if not dt:
        return None
    default_tz = timezone.get_default_timezone()
    if settings.USE_TZ and timezone.is_naive(dt):
        return timezone.make_aware(dt, default_tz)
    if not settings.USE_TZ and timezone.is_aware(dt):
        return timezone.make_naive(dt, default_tz)
    return dt


# ---------------------------------------------------------------------------
# GET /api/auth/linkedin/connect
# ---------------------------------------------------------------------------
@api_view(['GET'])
def linkedin_connect(request):
    """Kick off the OAuth handshake by redirecting the popup to LinkedIn.

    Deliberately not wrapped in @require_perm: this is a top-level browser
    navigation from window.open(), so it cannot carry the X-User-Email header
    the RBAC layer reads. The signed `state` is what binds this handshake to
    one email — it is verified in the callback and cannot be tampered with
    in flight.
    """
    if not _is_configured():
        return _popup_result(
            False, 'LinkedIn is not set up on this server. Ask your administrator.')

    email = norm_email(request.query_params.get('userEmail') or '')
    if not email:
        return _popup_result(False, 'Missing user. Please sign in and try again.')
    if not AppUser.objects.filter(email=email).exists():
        return _popup_result(False, 'Unknown user account.')

    state = signing.TimestampSigner(salt=STATE_SALT).sign_object({
        'email': email,
        'nonce': secrets.token_urlsafe(16),
    })
    params = {
        'response_type': 'code',
        'client_id': settings.LINKEDIN_CLIENT_ID,
        'redirect_uri': _redirect_uri(request),
        'state': state,
        'scope': SCOPES,
    }
    return HttpResponseRedirect(AUTHORIZE_URL + '?' + urlencode(params))


# ---------------------------------------------------------------------------
# GET /api/auth/linkedin/callback
# ---------------------------------------------------------------------------
@api_view(['GET'])
def linkedin_callback(request):
    """Exchange the authorization code for a token and store it against the
    user identified by the signed `state`."""
    # The user pressed Cancel on LinkedIn's consent screen.
    error = request.query_params.get('error')
    if error:
        desc = request.query_params.get('error_description') or error
        return _popup_result(False, f'LinkedIn connection cancelled: {desc}')

    raw_state = request.query_params.get('state') or ''
    code = request.query_params.get('code') or ''
    if not raw_state or not code:
        return _popup_result(False, 'LinkedIn returned an incomplete response.')

    try:
        data = signing.TimestampSigner(salt=STATE_SALT).unsign_object(
            raw_state, max_age=STATE_MAX_AGE)
    except signing.SignatureExpired:
        return _popup_result(False, 'This connection attempt timed out. Please try again.')
    except signing.BadSignature:
        logger.warning('LinkedIn callback with a bad state signature')
        return _popup_result(False, 'Invalid connection request. Please try again.')

    email = norm_email(data.get('email') or '')
    if not email:
        return _popup_result(False, 'Invalid connection request. Please try again.')

    # 1. code -> access token
    try:
        token_res = http_requests.post(
            TOKEN_URL,
            data={
                'grant_type': 'authorization_code',
                'code': code,
                'redirect_uri': _redirect_uri(request),
                'client_id': settings.LINKEDIN_CLIENT_ID,
                'client_secret': settings.LINKEDIN_CLIENT_SECRET,
            },
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            timeout=TIMEOUT,
        )
    except http_requests.RequestException as e:
        logger.warning('LinkedIn token exchange failed for %s: %s', email, e)
        return _popup_result(False, 'Could not reach LinkedIn. Please try again.')

    if not token_res.ok:
        logger.warning('LinkedIn token exchange rejected for %s: %s %s',
                       email, token_res.status_code, token_res.text[:300])
        return _popup_result(False, 'LinkedIn rejected the connection. Please try again.')

    token_data = token_res.json() or {}
    access_token = token_data.get('access_token')
    if not access_token:
        return _popup_result(False, 'LinkedIn did not return an access token.')

    # 2. token -> member identity. `sub` is the member id behind the author URN.
    try:
        info_res = http_requests.get(
            USERINFO_URL,
            headers={'Authorization': f'Bearer {access_token}'},
            timeout=TIMEOUT,
        )
    except http_requests.RequestException as e:
        logger.warning('LinkedIn userinfo failed for %s: %s', email, e)
        return _popup_result(False, 'Could not read your LinkedIn profile. Please try again.')

    if not info_res.ok:
        logger.warning('LinkedIn userinfo rejected for %s: %s %s',
                       email, info_res.status_code, info_res.text[:300])
        return _popup_result(
            False,
            'Could not read your LinkedIn profile. Make sure the app has the '
            '"Sign In with LinkedIn using OpenID Connect" product enabled.')

    info = info_res.json() or {}
    sub = str(info.get('sub') or '').strip()
    if not sub:
        return _popup_result(False, 'LinkedIn did not identify your profile.')

    display_name = (str(info.get('name') or '').strip()
                    or ' '.join(x for x in [info.get('given_name'), info.get('family_name')] if x).strip()
                    or info.get('email') or '')

    now = timezone.now()
    expires_in = token_data.get('expires_in')
    try:
        expires_at = now + timedelta(seconds=int(expires_in)) if expires_in else None
    except (TypeError, ValueError):
        expires_at = None

    _save_auth(email, {
        'accessToken': access_token,
        'authorUrn': f'urn:li:person:{sub}',
        'name': display_name,
        'expiresAt': expires_at.isoformat() if expires_at else '',
        'connectedAt': now.isoformat(),
    })
    logger.info('LinkedIn connected for %s as %s', email, display_name or sub)

    return _popup_result(
        True, f'LinkedIn connected{" as " + display_name if display_name else ""}.')


# ---------------------------------------------------------------------------
# GET /api/auth/linkedin/status
# ---------------------------------------------------------------------------
@api_view(['GET'])
def linkedin_status(request):
    """Whether the given user has a usable LinkedIn connection.

    `configured` is server-wide (are the app credentials present); the rest is
    per-user. Shapes match what hrms-linkedin.js renders.
    """
    configured = _is_configured()
    email = norm_email(request.query_params.get('userEmail') or '')
    if not email:
        return Response({'configured': configured, 'connected': False,
                         'expired': False, 'name': ''})

    _, social = _get_social(email)
    entry = _auth_entry(social)
    connected, expired = _expiry_state(entry)
    return Response({
        'configured': configured,
        'connected': connected,
        'expired': expired,
        'name': entry.get('name') or '',
        'connectedAt': entry.get('connectedAt') or '',
    })


# ---------------------------------------------------------------------------
# POST /api/auth/linkedin/disconnect
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# POST /api/auth/linkedin/preview
# ---------------------------------------------------------------------------
@api_view(['POST'])
def linkedin_preview(request):
    """Build the draft announcement for a job the user is about to create.

    Nothing is saved or published — this only renders the text so the recruiter
    can review and edit it before confirming. Generating it server-side keeps
    one source of truth with what post_job would otherwise send.
    """
    from . import social_poster
    from .views import poster_contact

    body = request.data or {}
    job = body.get('job') if isinstance(body.get('job'), dict) else body
    email = norm_email(body.get('userEmail') or '')
    try:
        text = social_poster.build_message(job or {}, poster_contact(email))
    except Exception as e:  # noqa: BLE001 - a bad draft must not block posting
        logger.warning('LinkedIn preview build failed for %s: %s', email, e)
        return err('Could not build the preview.', 500)
    return Response({'text': text})


@api_view(['POST'])
def linkedin_disconnect(request):
    """Forget the stored token. Keeps the user's typed profile URL."""
    body = request.data or {}
    email = norm_email(body.get('userEmail') or '')
    if not email:
        return err('userEmail is required')

    cfg, _ = _get_social(email)
    if not cfg:
        return Response({'ok': True, 'connected': False})

    _save_auth(email, None)
    logger.info('LinkedIn disconnected for %s', email)
    return Response({'ok': True, 'connected': False})
