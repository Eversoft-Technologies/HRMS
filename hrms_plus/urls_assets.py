"""IT asset register routes (mounted under /api/ by hrms_plus/urls.py)."""
from django.urls import path

from . import assets_views as v

urlpatterns = [
    path('assets/meta', v.meta),
    path('assets', v.assets),
    path('assets/licenses', v.licenses),
    path('assets/expiring', v.expiring),
    path('assets/stock', v.stock),
    path('assets/people', v.people),
    path('assets/export.csv', v.export_csv),
    path('assets/import', v.import_csv),
    path('assets/alerts/run', v.run_alerts),
    path('assets/my', v.my_assets),
    path('assets/my/<int:pk>/acknowledge', v.my_acknowledge),
    path('assets/my/<int:pk>/report', v.my_report),
    path('assets/separations/<int:sid>', v.separation_assets),
    path('assets/assignments/<int:pk>/return', v.assignment_return),
    path('assets/assignments/<int:pk>/lost', v.assignment_lost),
    path('assets/<int:pk>', v.asset_detail),
    path('assets/<int:pk>/assign', v.asset_assign),
    path('assets/<int:pk>/status', v.asset_status),
    path('assets/<int:pk>/write-off', v.asset_write_off),
]
