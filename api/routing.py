from django.urls import re_path

from .consumers import ChatConsumer, EmployeeStatusConsumer

websocket_urlpatterns = [
    re_path(r"ws/chat/(?P<room_id>\d+)/$", ChatConsumer.as_asgi()),
    re_path(r"ws/employee/(?P<email>[^/]+)/$", EmployeeStatusConsumer.as_asgi()),
]
