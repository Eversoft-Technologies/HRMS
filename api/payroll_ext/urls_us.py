"""US payroll + FX routes (mounted under /api/ by api/payroll_ext/urls.py)."""
from django.urls import path

from . import fx
from . import us_payroll as us

urlpatterns = [
    path('payroll/us/meta', us.us_meta),
    path('payroll/us/settings', us.us_settings),
    path('payroll/us/employees', us.us_employees),
    path('payroll/us/employees/<str:email>/w4', us.us_employee_w4),
    path('payroll/us/employees/<str:email>/preview', us.us_employee_preview),
    path('payroll/us/tax-tables', us.us_tax_tables),
    path('payroll/us/tax-tables/copy', us.us_tax_tables_copy),
    path('payroll/us/tax-tables/<int:pk>', us.us_tax_table_detail),
    path('payroll/us/pay-calendar', us.us_pay_calendar),
    path('payroll/us/runs/<int:pk>/warnings', us.us_run_warnings),
    path('payroll/us/w2', us.us_w2_preview),
    path('payroll/us/w2/generate', us.us_w2_generate),
    path('payroll/us/1099/generate', us.us_1099_generate),
    path('payroll/us/filings', us.us_filings),
    path('payroll/us/filings/<int:pk>/download', us.us_filing_download),
    path('payroll/us/contractors/payments', us.us_contractor_payments),
    path('payroll/us/contractors/payments/<int:pk>', us.us_contractor_payment_detail),
    path('me/w4', us.me_w4),
    path('me/w4/preview', us.me_w4_preview),
    path('me/us-forms', us.me_us_forms),
    path('me/us-forms/<int:pk>/download', us.me_us_form_download),
    path('payroll/fx/rates', fx.fx_rates),
    path('payroll/fx/rates/<int:pk>', fx.fx_rate_detail),
    path('payroll/fx/settings', fx.fx_settings),
    path('payroll/fx/fetch', fx.fx_fetch),
    path('payroll/fx/convert', fx.fx_convert),
    path('payroll/fx/dashboard', fx.fx_dashboard),
]
