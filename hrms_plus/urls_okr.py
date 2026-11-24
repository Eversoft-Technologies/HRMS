"""Goals & OKRs routes, mounted under /api/ by hrms_plus/urls.py."""
from django.urls import path

from . import okr_views as v

urlpatterns = [
    path('okr/meta', v.okr_meta),
    path('okr/objectives', v.objectives),
    path('okr/objectives/<int:pk>', v.objective_detail),
    path('okr/objectives/<int:pk>/key-results', v.objective_key_results),
    path('okr/key-results/<int:pk>', v.key_result_detail),
    path('okr/key-results/<int:pk>/check-ins', v.key_result_check_ins),
    path('okr/key-results/<int:pk>/tasks', v.key_result_tasks),
    path('okr/tasks', v.linkable_tasks),
    path('okr/alignment-options', v.alignment_options),
    path('okr/check-ins/due', v.check_ins_due),
    path('okr/summary', v.summary),
    path('okr/my-team', v.my_team),
    path('okr/copy-forward', v.copy_forward),
]
