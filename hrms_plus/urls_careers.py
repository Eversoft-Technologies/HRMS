"""Careers API routes (mounted under /api/ by hrms_plus/urls.py).
The public HTML pages (/careers, /careers/<job>, /careers/widget.js) are
routed in hrms_project/urls.py, ahead of the single-page-app catch-all."""
from django.urls import path

from . import careers

urlpatterns = [
    # public, no sign-in
    path('public/careers/jobs', careers.public_jobs),
    path('public/careers/jobs/<str:ident>', careers.public_job_detail),
    path('public/careers/apply', careers.public_apply),
    path('public/careers/parse-resume', careers.public_parse_resume),
    # recruiters
    path('recruit/applications', careers.recruit_applications),
    path('recruit/applications/meta', careers.recruit_meta),
    path('recruit/applications/<int:pk>', careers.recruit_application_detail),
    path('recruit/applications/<int:pk>/resume', careers.recruit_application_resume),
    path('recruit/applications/<int:pk>/score', careers.recruit_application_score),
    path('recruit/applications/<int:pk>/resend-confirmation', careers.recruit_application_resend_confirmation),
    path('recruit/applications/<int:pk>/onboard', careers.recruit_application_onboard),
    path('recruit/careers/settings', careers.recruit_careers_settings),
]
