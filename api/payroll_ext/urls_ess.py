"""Routes for employee self-service pay (ess.py) and Full & Final (fnf.py).
Mounted under /api/ by api/payroll_ext/urls.py."""
from django.urls import path

from . import ess, fnf

urlpatterns = [
    # employee self-service
    path('me/pay/payslips', ess.my_payslips),
    path('me/pay/payslips/<int:pk>/pdf', ess.my_payslip_pdf),
    path('me/pay/expenses', ess.my_expenses),
    path('me/pay/expenses/<int:pk>/receipt', ess.expense_receipt),
    path('me/pay/expenses/<int:pk>/cancel', ess.expense_cancel),
    path('me/pay/loans', ess.my_loans),
    path('me/pay/loans/<int:pk>/cancel', ess.my_loan_cancel),
    path('me/pay/total-rewards', ess.my_total_rewards),
    # approvers / HR
    path('payroll/ess/policy', ess.policy),
    path('payroll/ess/expenses/approvals', ess.expense_approvals),
    path('payroll/ess/expenses/<int:pk>/decide', ess.expense_decide),
    path('payroll/ess/loans', ess.loans_admin),
    path('payroll/ess/loans/<int:pk>/decide', ess.loan_decide),
    path('payroll/ess/loans/<int:pk>/disburse', ess.loan_disburse),
    path('payroll/ess/loans/<int:pk>/foreclose', ess.loan_foreclose),
    path('payroll/ess/payslips/email', ess.email_run_payslips),
    path('payroll/ess/payslips/email-runs', ess.email_runs),
    # full & final
    path('payroll/fnf/employees', fnf.fnf_employees),
    path('payroll/fnf/separations', fnf.separations),
    path('payroll/fnf/separations/<int:pk>', fnf.separation_detail),
    path('payroll/fnf/separations/<int:pk>/clearances', fnf.clearance_add),
    path('payroll/fnf/separations/<int:pk>/clearances/<int:cid>', fnf.clearance_update),
    path('payroll/fnf/separations/<int:pk>/compute', fnf.separation_compute),
    path('payroll/fnf/separations/<int:pk>/approve', fnf.separation_approve),
    path('payroll/fnf/separations/<int:pk>/mark-paid', fnf.separation_mark_paid),
    path('payroll/fnf/separations/<int:pk>/cancel', fnf.separation_cancel),
    path('payroll/fnf/separations/<int:pk>/documents', fnf.separation_documents),
]
