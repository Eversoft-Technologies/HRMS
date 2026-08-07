"""ASGI config for the HRMS project (HTTP + Channels WebSocket)."""
import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

# Initialise Django before importing anything that touches the ORM.
django_asgi_app = get_asgi_application()

from api.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": URLRouter(websocket_urlpatterns),
})
