import jwt
from django.conf import settings
from rest_framework.authentication import BaseAuthentication

from .models import AppUser


class JWTAppUserAuthentication(BaseAuthentication):
    """Authenticate requests using a simple JWT that encodes the user's email.

    This lightweight approach avoids depending on Django's auth user model
    (the project intentionally omits django.contrib.auth). The token is
    signed with the project's SECRET_KEY using HS256 and must include an
    'email' claim that maps to an AppUser row.

    Important: a bad/expired/unknown token is treated as *anonymous* (returns
    None) rather than raising. The frontend (hrms-actor.js) attaches
    ``Authorization: Bearer <token>`` to every /api/ request, and access tokens
    expire after ~60 min. Real authorization is enforced per-view via the
    ``X-User-Email`` header + ``require_perm`` (which fail open during rollout),
    so the JWT here only *upgrades* a request to a known user — it must never
    hard-fail one. Raising here made every endpoint 401 once the token expired,
    which broke the whole UI (e.g. "Could not load jobs from database").
    """

    def authenticate(self, request):
        auth = request.META.get('HTTP_AUTHORIZATION', '')
        if not auth or not auth.startswith('Bearer '):
            return None
        token = auth.split(' ', 1)[1].strip()
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=['HS256'])
        except Exception:
            # Expired/invalid/malformed token → anonymous, not a hard failure.
            return None
        email = payload.get('email')
        if not email:
            return None
        user = AppUser.objects.filter(email=email).first()
        if not user:
            return None

        # Mark the AppUser instance as authenticated for DRF permissions.
        setattr(user, 'is_authenticated', True)
        return (user, token)
