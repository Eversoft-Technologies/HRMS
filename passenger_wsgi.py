import os
import sys

# Add the application directory to the python path
sys.path.insert(0, os.path.dirname(__file__))

# Set environment variables for production
os.environ.setdefault('DJANGO_ENV', 'production')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

# Import Django's WSGI application handler
from django.core.wsgi import get_wsgi_application
application = get_wsgi_application()
