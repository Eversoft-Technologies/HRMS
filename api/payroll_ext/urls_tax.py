"""Routes for India tax & statutory compliance (mounted under /api/ by api/payroll_ext/urls.py)."""
from django.urls import path

from . import india_tax as t
from . import statutory as s

urlpatterns = [
    # employee self-service
    path('me/tax/declaration', t.my_declaration),
    path('me/tax/regime', t.my_regime),
    path('me/tax/submit', t.my_submit),
    path('me/tax/estimate', t.my_estimate),
    path('me/tax/proofs', t.my_proofs),
    path('me/tax/proofs/<int:pk>', t.my_proof_delete),
    path('me/tax/forms', t.my_forms),
    path('me/tax/forms/<int:pk>', t.my_form_file),
    # proofs: owner or verifier
    path('payroll/tax/proofs/<int:pk>/file', t.proof_file),
    # HR: tables, declarations, window, preview
    path('payroll/tax/tables', t.tax_tables),
    path('payroll/tax/declarations', t.hr_declarations),
    path('payroll/tax/declarations/lock-verified', t.hr_lock_verified),
    path('payroll/tax/declarations/<int:pk>', t.hr_declaration),
    path('payroll/tax/declarations/<int:pk>/review', t.hr_review),
    path('payroll/tax/declarations/<int:pk>/lock', t.hr_lock),
    path('payroll/tax/declarations/<int:pk>/regime', t.hr_regime),
    path('payroll/tax/window', t.hr_window),
    path('payroll/tax/employees', t.hr_employees),
    path('payroll/tax/preview', t.hr_preview),
    # statutory files
    path('payroll/statutory/options', s.options),
    path('payroll/statutory/filings', s.filings),
    path('payroll/statutory/filings/<int:pk>/download', s.download),
    path('payroll/statutory/ecr', s.gen_ecr),
    path('payroll/statutory/esic', s.gen_esic),
    path('payroll/statutory/24q', s.gen_24q),
    path('payroll/statutory/form16', s.gen_form16),
    path('payroll/statutory/form16/part-a', s.upload_form16a),
    path('payroll/statutory/esic-ip', s.esic_ip),
    path('payroll/statutory/employer', s.employer),
]
