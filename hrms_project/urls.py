from django.urls import include, path, re_path

from api.auth_views import super_admin_login_page
from api.views import spa_index

urlpatterns = [
    path('api/', include('api.urls')),
    path('super-admin/login', super_admin_login_page),
    # Everything that is not an /api/ route and not a real file served by
    # WhiteNoise falls through to the React single-page app.
    re_path(r'^(?!api/).*$', spa_index),
]
