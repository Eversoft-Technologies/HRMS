"""Matrix reporting routes (hrms_plus/org.py), mounted under /api/."""
from django.urls import path

from . import org

urlpatterns = [
    path('org/chart', org.chart),
    path('org/lines', org.lines),
    path('org/lines/bulk', org.lines_bulk),
    path('org/lines/<int:pk>', org.line_detail),
    path('org/project-reports', org.project_reports),
    path('org/projects', org.projects),
]
