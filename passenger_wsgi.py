import os
import sys

# Ensure application directory is first on sys.path
app_dir = os.path.dirname(os.path.abspath(__file__))
if app_dir not in sys.path:
    sys.path.insert(0, app_dir)

# Ensure cPanel virtualenv site-packages are present in sys.path
home_dir = os.path.expanduser('~')
for app_name in ('hrms_staging', 'hrms_django'):
    venv_site = os.path.join(home_dir, 'virtualenv', app_name, '3.10', 'lib', 'python3.10', 'site-packages')
    if os.path.isdir(venv_site) and venv_site not in sys.path:
        sys.path.insert(0, venv_site)
        break

# Set environment variables for Django
os.environ.setdefault('DJANGO_ENV', 'production')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

# Import Django's WSGI application handler
from django.core.wsgi import get_wsgi_application
application = get_wsgi_application()
