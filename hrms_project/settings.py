"""
Django settings for the HRMS project.

Single deployment: Django exposes the REST API under /api/* and also serves
the built React app (Vite `dist/`) for every other route via WhiteNoise.
"""
from pathlib import Path
import os
import sys
import warnings
from datetime import timedelta

try:                                  # Python 3.9+
    from zoneinfo import ZoneInfo
except ImportError:                   # pragma: no cover - fallback for 3.8
    ZoneInfo = None

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Load environment variables from a dotenv file next to manage.py.
# APP_ENV (default "development") picks the environment-specific file
# (.env.development / .env.production); a plain .env is still honoured as a
# fallback. load_dotenv keeps override=False, so real process env vars and
# the first file loaded win — i.e. .env.<APP_ENV> takes priority over .env.
APP_ENV = os.environ.get('APP_ENV') or os.environ.get('DJANGO_ENV') or 'development'
for _env_file in (f'.env.{APP_ENV}', '.env'):
    _env_path = BASE_DIR / _env_file
    if _env_path.exists():
        load_dotenv(_env_path)


def env_bool(name, default=False):
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ('1', 'true', 'yes', 'on')


def env_list(name, default=''):
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(',') if item.strip()]


def env_timezone(default):
    """HRMS_TIME_ZONE from the environment, checked before it is trusted.

    An unrecognised zone name is worse than no setting at all: business_tz()
    returns None for it, local_now() then falls back to the *host* clock, and
    the 5h30m drift timeutil exists to prevent is silently back. A typo in
    .env would not present as a typo - it would present, days later, as
    attendance stamped against the wrong day.

    Warns and keeps the default rather than raising: one bad character should
    not stop the server booting, but it must not pass unnoticed either.
    """
    name = (os.environ.get('HRMS_TIME_ZONE') or '').strip()
    if not name:
        return default
    if ZoneInfo is None:              # cannot verify here; trust it
        return name
    try:
        ZoneInfo(name)
    except Exception:
        warnings.warn(
            f'HRMS_TIME_ZONE={name!r} is not a known IANA zone name '
            f'(e.g. "Asia/Kolkata", "UTC") - falling back to {default!r}. '
            'Timestamps would otherwise be stamped from the host clock.',
            stacklevel=2,
        )
        return default
    return name


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'dev-insecure-change-me')
DEBUG = env_bool('DJANGO_DEBUG', True)
ALLOWED_HOSTS = env_list('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1') or ['*']

# The frontend and API share an origin in production, so CSRF is not an
# issue for the API (views are csrf-exempt). Trust the configured hosts for
# any form posts that might be added later.
CSRF_TRUSTED_ORIGINS = [
    f'https://{h}' for h in ALLOWED_HOSTS if h not in ('localhost', '127.0.0.1', '*')
]

# Keep the project minimal: no admin/auth/sessions tables are created in the
# user's MySQL database — only the 8 application tables.
INSTALLED_APPS = [
    'daphne',
    'channels',
    'corsheaders',
    # 'django.contrib.auth'
    
    'django.contrib.staticfiles',
    
    
    'rest_framework',
    'api',
]

# ---------------------------------------------------------------------------
# Django REST Framework
# ---------------------------------------------------------------------------
# This project deliberately omits django.contrib.auth/sessions/contenttypes
# (no auth tables are created in the user's MySQL DB — the app handles its own
# login via the app_users table). So DRF must NOT use any auth/permission
# classes that reference the User model, and request.user must resolve to None
# instead of AnonymousUser (which would import django.contrib.auth).
#
# JSON-only in/out keeps the wire format identical to the original Node/Express
# API the React frontend talks to.
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'api.authentication.JWTAppUserAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.AllowAny'],
    'UNAUTHENTICATED_USER': None,
    'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
    'DEFAULT_PARSER_CLASSES': ['rest_framework.parsers.JSONParser'],
}

# Simple JWT configuration — adds JWT auth support. Tokens are short-lived
# by default; adjust lifetimes via env vars in production.
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=int(os.environ.get('JWT_ACCESS_MINUTES', '60'))),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=int(os.environ.get('JWT_REFRESH_DAYS', '7'))),
    'AUTH_HEADER_TYPES': ('Bearer',),
}

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'hrms_project.urls'
WSGI_APPLICATION = 'hrms_project.wsgi.application'
ASGI_APPLICATION = 'hrms_project.asgi.application'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {'context_processors': []},
    },
]

# ---------------------------------------------------------------------------
# Database — MySQL (same DB the Node backend used)
# ---------------------------------------------------------------------------
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME':  os.environ.get('DB_NAME', 'hrms_system'),
        'USER':  os.environ.get('DB_USER', 'root'),
        'PASSWORD': os.environ.get('DB_PASSWORD', '1234'),
        'HOST':  os.environ.get('DB_HOST', 'localhost'),
        'PORT': os.environ.get('DB_PORT', '3306'),
        'OPTIONS': {
            'charset': 'utf8mb4',
        },
    }
}

# Match the existing INT AUTO_INCREMENT primary keys (not BIGINT).
DEFAULT_AUTO_FIELD = 'django.db.models.AutoField'

# ---------------------------------------------------------------------------
# Large payloads: base64 video (recordingData) and document uploads can be big.
# Mirror the Node server's generous body limits.
# ---------------------------------------------------------------------------
DATA_UPLOAD_MAX_MEMORY_SIZE = None          # disable the size guard
FILE_UPLOAD_MAX_MEMORY_SIZE = 500 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = None
APPEND_SLASH = False                         # API paths have no trailing slash

# Public-facing base URL used to build candidate portal links in emails.
# Set this in .env to your real domain (e.g. https://hrms.eversoftit.com) so
# that candidates receive a clickable link even when the server runs locally.
# If left blank the link falls back to the request's own host (works locally
# only if the candidate is on the same machine).
HRMS_PUBLIC_URL = os.environ.get('HRMS_PUBLIC_URL', '').rstrip('/')


# ---------------------------------------------------------------------------
# LinkedIn OAuth — lets each recruiter link their OWN LinkedIn account so new
# jobs are auto-posted to their profile (see api/linkedin_oauth.py).
#
# Create an app at https://www.linkedin.com/developers/apps and request both
# the "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn"
# products, then add the redirect URL below under the app's Auth tab.
# When these are blank the feature stays dormant and the UI says so.
# ---------------------------------------------------------------------------
LINKEDIN_CLIENT_ID = os.environ.get('LINKEDIN_CLIENT_ID', '')
LINKEDIN_CLIENT_SECRET = os.environ.get('LINKEDIN_CLIENT_SECRET', '')
LINKEDIN_REDIRECT_URI = os.environ.get('LINKEDIN_REDIRECT_URI', '') or (
    HRMS_PUBLIC_URL + '/api/auth/linkedin/callback' if HRMS_PUBLIC_URL else ''
)


# ---------------------------------------------------------------------------
# Static files + React build
# ---------------------------------------------------------------------------
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

# Built React app (Vite output). Default: dist/dist relative to this project.
REACT_BUILD_DIR = Path(
    os.environ.get('REACT_BUILD_DIR', BASE_DIR / 'dist' / 'dist')
).resolve()

# WhiteNoise serves the dist/ folder at the site root so that the absolute
# asset paths Vite emits (e.g. /assets/index-xxx.js, /favicon.svg) resolve.
WHITENOISE_ROOT = str(REACT_BUILD_DIR)
WHITENOISE_INDEX_FILE = True

STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedStaticFilesStorage'},
}

# ---------------------------------------------------------------------------
# CORS — only needed when running the React dev server (localhost:3000)
# against this API on a different port. Same-origin in production.
# ---------------------------------------------------------------------------
CORS_ALLOW_ALL_ORIGINS = DEBUG
from corsheaders.defaults import default_headers  # noqa: E402
CORS_ALLOW_HEADERS = list(default_headers) + ['x-api-key', 'x-user-email', 'x-actor-email']

LANGUAGE_CODE = 'en-us'
# Attendance timestamps are stored as naive business-clock values because the
# legacy database uses dateStrings. Keep the production clock configurable so
# local development and the server use the same wall-clock timezone.
#
# Validated on the way in - see env_timezone: an unknown name would otherwise
# hand every stamp back to the host clock without saying so.
TIME_ZONE = env_timezone('Asia/Kolkata')
USE_I18N = True
USE_TZ = False  # the Node app stored naive datetimes (dateStrings)

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': 'INFO'},
}

# The test suite drives error paths on purpose: a 403 proving a permission is
# enforced, a mocked SMTP RuntimeError proving check-out survives a dead mailer.
# Django logs every 4xx/5xx it returns and the app logs its own handled errors,
# so a fully green run scrolled past pages of tracebacks and read as broken.
# Quieten the console for "manage.py test" only - dev and production logging are
# untouched, and unittest still reports real failures (it does not use logging).
# Set HRMS_TEST_LOGS=1 to get the chatter back when debugging a test.
if sys.argv[1:2] == ['test'] and os.environ.get('HRMS_TEST_LOGS') != '1':
    LOGGING['root']['level'] = 'CRITICAL'
    LOGGING['loggers'] = {
        'django.request': {
            'handlers': ['console'], 'level': 'CRITICAL', 'propagate': False,
        },
    }


# Channels (WebSocket) layer for Employee Chat realtime.
CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}
