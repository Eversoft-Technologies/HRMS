"""Routes for connected banking, reconciliation and alerts (mounted under /api/)."""
from django.urls import path

from . import banking, channels

urlpatterns = [
    # payouts
    path('payroll/banking/meta', banking.meta_view),
    path('payroll/banking/runs', banking.runs_view),
    path('payroll/banking/runs/<int:run_id>/preview', banking.run_preview_view),
    path('payroll/banking/runs/<int:run_id>/prepare', banking.prepare_view),
    path('payroll/banking/batches', banking.batches_view),
    path('payroll/banking/batches/<int:batch_id>', banking.batch_detail_view),
    path('payroll/banking/batches/<int:batch_id>/release', banking.release_view),
    path('payroll/banking/batches/<int:batch_id>/cancel', banking.cancel_view),
    path('payroll/banking/batches/<int:batch_id>/poll', banking.poll_view),
    path('payroll/banking/batches/<int:batch_id>/simulate-settle', banking.settle_view),
    path('payroll/banking/otp', banking.otp_view),
    path('payroll/banking/transactions/<int:txn_id>/requeue', banking.requeue_view),
    path('payroll/banking/payments/<int:payment_id>/bank-details', banking.payment_bank_view),
    path('payroll/banking/reconciliation', banking.reconciliation_view),
    # bank callbacks (server-to-server, HMAC-signed)
    path('payroll/banking/webhook/<str:provider>', banking.webhook_view),
    # integrations
    path('payroll/banking/integrations', banking.integrations_view),
    path('payroll/banking/integrations/<str:provider>', banking.integration_view),
    path('payroll/banking/integrations/<str:provider>/test', banking.integration_test_view),
    # alerts
    path('payroll/alerts/deliveries', channels.deliveries_view),
    path('payroll/alerts/payrun/sweep', channels.sweep_view),
    path('payroll/alerts/payrun/<int:run_id>/notify', channels.notify_payrun_view),
    path('payroll/alerts/slack/interact', channels.slack_interact_view),
]
