from django.urls import include, path, re_path

from api.views import spa_index
from hrms_plus import careers_pages

urlpatterns = [
    path('api/', include('api.urls')),
    path('api/', include('hrms_plus.urls')),
    # Public careers pages + embeddable widget: plain Django pages, no sign-in,
    # so they must sit before the SPA catch-all (which would bounce to /login).
    path('careers', careers_pages.careers_index),
    path('careers/', careers_pages.careers_index),
    path('careers/widget.js', careers_pages.widget_js),
    path('careers/logo', careers_pages.logo),
    path('careers/<str:ident>', careers_pages.careers_detail),
    # Everything that is not an /api/ route and not a real file served by
    # WhiteNoise falls through to the React single-page app.
    re_path(r'^(?!api/).*$', spa_index),
]
