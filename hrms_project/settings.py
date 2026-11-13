
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
    """Validate HRMS_TIME_ZONE before using it."""
    name = (os.environ.get('HRMS_TIME_ZONE') or '').strip()
    if not name:
        return default
    if ZoneInfo is None:
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

CSRF_TRUSTED_ORIGINS = [
    f'https://{h}' for h in ALLOWED_HOSTS if h not in ('localhost', '127.0.0.1', '*')
]

# ---------------------------------------------------------------------------
# Installed Applications
# ---------------------------------------------------------------------------
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
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'api.authentication.JWTAppUserAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.AllowAny'
    ],
    'UNAUTHENTICATED_USER': None,
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer'
    ],
    'DEFAULT_PARSER_CLASSES': [
        'rest_framework.parsers.JSONParser'
    ],
}

# ---------------------------------------------------------------------------
# Simple JWT Configuration
# ---------------------------------------------------------------------------
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(
        minutes=int(os.environ.get('JWT_ACCESS_MINUTES', '60'))
    ),
    'REFRESH_TOKEN_LIFETIME': timedelta(
        days=int(os.environ.get('JWT_REFRESH_DAYS', '7'))
    ),
    'AUTH_HEADER_TYPES': ('Bearer',),
}

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------
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
# Database — MySQL
# ---------------------------------------------------------------------------
# Kept the hover branch's default MySQL password (1234).
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.environ.get('DB_NAME', 'hrms_system'),
        'USER': os.environ.get('DB_USER', 'root'),
        'PASSWORD': os.environ.get('DB_PASSWORD', '1234'),
        'HOST': os.environ.get('DB_HOST', 'localhost'),
        'PORT': os.environ.get('DB_PORT', '3306'),
        'OPTIONS': {
            'charset': 'utf8mb4',
        },
    }
}

# A MySQL on this same machine does not need TLS, and PyMySQL builds a TLS
# context for every new connection (about 35 ms each on Windows), which every
# request pays because the dev server opens a fresh connection per request.
# A remote database keeps TLS.
if DATABASES['default']['HOST'] in ('localhost', '127.0.0.1', '::1'):
    DATABASES['default']['OPTIONS']['ssl_disabled'] = True

if 'test' in sys.argv:
    DATABASES['default'] = {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'test.sqlite3',
    }

# ---------------------------------------------------------------------------
# Default Auto Field
# ---------------------------------------------------------------------------
DEFAULT_AUTO_FIELD = 'django.db.models.AutoField'

# ---------------------------------------------------------------------------
# Password Hashers and Test Configuration
# ---------------------------------------------------------------------------
if len(sys.argv) > 1 and sys.argv[1] == 'test':
    PASSWORD_HASHERS = [
        'django.contrib.auth.hashers.MD5PasswordHasher'
    ]

    import tempfile as _tempfile
    os.environ['HRMS_SECRETS_FILE'] = os.path.join(
        _tempfile.mkdtemp(prefix='hrms-test-secrets-'),
        'secrets.key'
    )
    os.environ['HRMS_SECRETS_AUTOGEN'] = '0'

# ---------------------------------------------------------------------------
# Large Payloads
# ---------------------------------------------------------------------------
DATA_UPLOAD_MAX_MEMORY_SIZE = None
FILE_UPLOAD_MAX_MEMORY_SIZE = 500 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = None
APPEND_SLASH = False

# ---------------------------------------------------------------------------
# Public URL
# ---------------------------------------------------------------------------
HRMS_PUBLIC_URL = os.environ.get('HRMS_PUBLIC_URL', '').rstrip('/')

# ---------------------------------------------------------------------------
# LinkedIn OAuth
# ---------------------------------------------------------------------------
LINKEDIN_CLIENT_ID = os.environ.get('LINKEDIN_CLIENT_ID', '')
LINKEDIN_CLIENT_SECRET = os.environ.get('LINKEDIN_CLIENT_SECRET', '')
LINKEDIN_REDIRECT_URI = os.environ.get('LINKEDIN_REDIRECT_URI', '') or (
    HRMS_PUBLIC_URL + '/api/auth/linkedin/callback'
    if HRMS_PUBLIC_URL else ''
)

# ---------------------------------------------------------------------------
# Map and Basemap Tile Configuration
# ---------------------------------------------------------------------------
HRMS_DEVICE_PUNCH_TOKEN = os.environ.get('HRMS_DEVICE_PUNCH_TOKEN', '')

HRMS_BASEMAP_TILE_URL = os.environ.get(
    'HRMS_BASEMAP_TILE_URL',
    'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'
)

HRMS_BASEMAP_ATTRIBUTION = os.environ.get(
    'HRMS_BASEMAP_ATTRIBUTION',
    '© OpenStreetMap contributors, © CARTO'
)

# ---------------------------------------------------------------------------
# Static Files and React Build
# ---------------------------------------------------------------------------
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

# Uploaded Media
MEDIA_URL = '/media/'
MEDIA_ROOT = Path(
    os.environ.get('MEDIA_ROOT') or (BASE_DIR / 'media')
)

# Built React App (Vite)
REACT_BUILD_DIR = Path(
    os.environ.get('REACT_BUILD_DIR', BASE_DIR / 'dist' / 'dist')
).resolve()

WHITENOISE_ROOT = str(REACT_BUILD_DIR)
WHITENOISE_INDEX_FILE = True

STORAGES = {
    'default': {
        'BACKEND': 'django.core.files.storage.FileSystemStorage'
    },
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedStaticFilesStorage'
    },
}

# ---------------------------------------------------------------------------
# CORS Configuration
# ---------------------------------------------------------------------------
CORS_ALLOW_ALL_ORIGINS = DEBUG

from corsheaders.defaults import default_headers  # noqa: E402

CORS_ALLOW_HEADERS = list(default_headers) + [
    'x-api-key',
    'x-user-email',
    'x-actor-email'
]

# ---------------------------------------------------------------------------
# Language and Time Zone
# ---------------------------------------------------------------------------
LANGUAGE_CODE = 'en-us'

TIME_ZONE = env_timezone('Asia/Kolkata')
USE_I18N = True
USE_TZ = False

# ---------------------------------------------------------------------------
# Logging Configuration
# ---------------------------------------------------------------------------
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler'
        }
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO'
    },
}

# Quieten logs during tests unless explicitly enabled.
if sys.argv[1:2] == ['test'] and os.environ.get('HRMS_TEST_LOGS') != '1':
    LOGGING['root']['level'] = 'CRITICAL'
    LOGGING['loggers'] = {
        'django.request': {
            'handlers': ['console'],
            'level': 'CRITICAL',
            'propagate': False,
        },
    }

# ---------------------------------------------------------------------------
# Channels — WebSocket Layer for Employee Chat
# ---------------------------------------------------------------------------
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    },
}
