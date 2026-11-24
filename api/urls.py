from django.urls import include, path

from . import ai_settings
from . import tickets, timesheets, org_tree, project_views
from . import team_hub
from . import stt_settings
from . import attendance_recalc
from . import chat_extras
from . import notification_prefs
from . import org_views
from . import submission_discussion
from . import tts_views
from . import work_setup
from . import sensitive
from .attendance_ext import holiday_views
from .attendance_ext import leave_views as leave_ledger_views
from .attendance_ext import regularization as att_regularization
from .attendance_ext import history as att_history
from .attendance_ext import policy_views as att_policy
from .attendance_ext import short_leave as att_short_leave
from .attendance_ext import overtime_views as att_overtime
from .attendance_ext import networks as att_networks
from . import (auth_views, email_template_views, linkedin_oauth, live_views, views,
               attendance_views, job_form_views, onboarding_views, payroll_views)

# All paths are relative to the "/api/" prefix from the project urlconf.
urlpatterns = [
    # Authentication (OTP login + password reset + Google OAuth)
    path('auth/login', auth_views.login),
    path('auth/signup', auth_views.signup),
    path('auth/verify-otp', auth_views.verify_otp),
    path('auth/resend-otp', auth_views.resend_otp),
    path('auth/forgot-password', auth_views.forgot_password),
    path('auth/reset-password', auth_views.reset_password),
    path('auth/verify-reset-token', auth_views.verify_reset_token),
    path('auth/google', auth_views.google_auth),

    # Per-user LinkedIn linking, so new jobs post to the creator's own profile
    path('auth/linkedin/connect', linkedin_oauth.linkedin_connect),
    path('auth/linkedin/callback', linkedin_oauth.linkedin_callback),
    path('auth/linkedin/status', linkedin_oauth.linkedin_status),
    path('auth/linkedin/preview', linkedin_oauth.linkedin_preview),
    path('auth/linkedin/disconnect', linkedin_oauth.linkedin_disconnect),

    path('jobs', views.jobs),
    path('jobs/next-code', views.job_next_code),
    path('jobs/<int:pk>', views.job_detail),

    # Reusable candidate follow-up email templates
    path('email-templates', email_template_views.email_templates),
    path('email-templates/preview', email_template_views.email_template_preview),
    path('email-templates/<int:pk>', email_template_views.email_template_detail),

    # Job Form Builder: dynamic schema, templates, master data, currencies
    path('job-form/config', job_form_views.job_form_config),
    path('job-form/templates', job_form_views.job_form_templates),
    path('job-form/templates/<int:pk>', job_form_views.job_form_template_detail),
    path('master-data', job_form_views.master_data),
    path('master-data/<str:key>', job_form_views.master_data_detail),
    path('currencies', job_form_views.currencies),

    path('interviews', views.interviews),
    path('interviews/bulk/send-emails', views.interviews_bulk_send_emails),
    path('interviews/send-followup', views.interview_send_followup),
    path('interviews/verify-token', views.interview_verify_token),
    path('interviews/complete', views.interview_complete),
    path('interviews/<int:pk>', views.interview_detail),
    path('interviews/<int:pk>/note', views.interview_note),
    path('interviews/<int:pk>/regenerate-link', views.interview_regenerate_link),
    path('interviews/<int:pk>/resend-invitation', views.interview_resend_invitation),

    # Live interview (WebRTC signaling for recruiter live-view)
    path('live', live_views.live_list),
    path('live/start', live_views.live_start),
    path('live/<str:sid>', live_views.live_detail),
    path('live/<str:sid>/answer', live_views.live_answer),
    path('live/<str:sid>/ice', live_views.live_ice),
    path('live/<str:sid>/update', live_views.live_update),
    path('live/<str:sid>/end', live_views.live_end),

    path('resume-scores', views.resume_scores),
    path('resume-scores/<int:pk>', views.resume_score_detail),
    path('resume-scores/<int:pk>/file', views.resume_score_file),

    path('interview-recordings', views.recordings),
    path('interview-recordings/<int:pk>', views.recording_detail),
    path('interview-recordings/<int:pk>/video', views.recording_video),
    path('interview-recordings/<int:pk>/thumbnail', views.recording_thumbnail),
    path('interview-recordings/<int:pk>/transcribe', views.recording_transcribe),

    path('question-sets', views.question_sets),
    path('question-sets/<str:set_id>', views.question_set_detail),

    path('ai/status', views.ai_status),
    path('ai/status/', views.ai_status),
    path('ai/generate-questions', views.ai_generate_questions),
    path('ai/generate-questions/', views.ai_generate_questions),
    path('ai/score-resume', views.ai_score_resume),
    path('ai/score-resume/', views.ai_score_resume),
    path('ai/evaluate-interview', views.ai_evaluate_interview),
    path('ai/evaluate-interview/', views.ai_evaluate_interview),
    # Eva's spoken lines as audio, so the interview recording includes her voice.
    path('eva-tts', tts_views.eva_tts),
    # Server-managed AI key (Settings > AI Settings); never returns the key.
    path('ai/settings', ai_settings.ai_settings),
    path('ai/settings/validate', ai_settings.ai_settings_validate),
    path('ai/settings/key', ai_settings.ai_settings_key),
    path('ai/settings/audit', ai_settings.ai_settings_audit),
    path('stt/settings', stt_settings.stt_settings),
    path('stt/settings/validate', stt_settings.stt_settings_validate),
    path('stt/settings/key', stt_settings.stt_settings_key),
    path('stt/settings/audit', stt_settings.stt_settings_audit),

    path('users', views.users),
    path('users/<str:email>', views.user_detail),
    path('employees', views.employees),
    path('employees/<str:key>/profile', views.employee_profile),
    path('teams', org_views.teams),
    path('teams/<int:pk>', org_views.team_detail),
    path('teams/<int:pk>/members', org_views.team_members),
    path('teams/<int:pk>/members/<str:member>', org_views.team_member_detail),
    path('org/people', org_views.org_people),
    # Phase 3 — interactive org tree
    path('org/tree', org_tree.org_tree),
    path('org/manager', org_tree.set_manager),
    # Team Management Phase 1 — My Team command center (api/team_hub.py)
    path('my-team/summary', team_hub.summary),
    path('my-team/members', team_hub.members),
    path('my-team/inbox', team_hub.inbox),
    path('my-team/inbox/decide', team_hub.inbox_decide),
    path('my-team/inbox/batch', team_hub.inbox_batch),
    path('my-team/presence', team_hub.presence),
    path('my-team/calendar', team_hub.calendar),
    path('my-team/workload', team_hub.workload),
    # Phase 3 — service desk tickets
    path('tickets/meta', tickets.ticket_meta),
    path('tickets', tickets.tickets),
    path('tickets/<int:pk>', tickets.ticket_detail),
    path('tickets/<int:pk>/comments', tickets.ticket_comments),
    # Phase 3 — timesheets and attendance change history
    path('timesheets/entries', timesheets.entries),
    path('timesheets/entries/<int:pk>', timesheets.entry_detail),
    path('timesheets/week', timesheets.week),
    path('timesheets/week/submit', timesheets.submit_week),
    path('timesheets/approvals', timesheets.approvals),
    path('timesheets/week/<int:pk>/decide', timesheets.decide_week),
    path('attendance/audit', timesheets.attendance_audit),
    path('org/manager-review', org_views.manager_review),
    path('org/approver', org_views.org_approver),
    path('org/reviewers', org_views.org_reviewers),
    path('org/unresolved', org_views.org_unresolved),
    path('employees/<str:key>', views.employee_detail),

    path('notifications', views.notifications),
    path('notifications/<int:pk>/read', views.notification_read),
    path('notifications/<int:pk>', views.notification_delete),
    path('notifications/delete', views.notifications_delete_batch),
    path('notifications/read-all', views.notifications_read_all),

    path('user-settings/<str:email>', views.user_settings),
    path('user-settings/<str:email>/profile', views.user_profile),
    path('user-settings/<str:email>/notification-preferences', notification_prefs.notification_preferences),
    path('user-settings/<str:email>/email-config', views.user_email_config),
    path('user-settings/<str:email>/documents', views.user_documents),
    path('user-settings/<str:email>/documents/<str:doc_type>', views.user_document_detail),

    # Company Details & General System Settings (Settings -> General)
    path('settings/general', views.company_settings),
    path('settings/general/', views.company_settings),
    path('settings/company', views.company_settings),
    path('settings/company/', views.company_settings),
    path('settings/general/backfill', views.company_settings_backfill),
    path('settings/general/backfill/', views.company_settings_backfill),
    path('settings/company/backfill', views.company_settings_backfill),
    path('settings/company/backfill/', views.company_settings_backfill),

    # Employees module — Attendance / Check-In-Out
    path('attendance', views.attendance),
    path('attendance/history', att_history.attendance_history),
    path('attendance/check-in', views.attendance_check_in),
    path('attendance/check-out', views.attendance_check_out),
    path('attendance/today', views.attendance_today),
    path('attendance/events', views.attendance_events),
    path('attendance/team', views.attendance_team),
    path('attendance/presence', views.attendance_presence),
    path('attendance/overtime', views.attendance_overtime),
    path('attendance/auto-correct', views.attendance_auto_correct),
    path('attendance/analytics', views.attendance_analytics),
    path('attendance/geofence-check', views.attendance_geofence_check),
    path('attendance/location-reviews', views.attendance_location_reviews),
    path('attendance/map-feed', views.attendance_map_feed),
    path('attendance/heatmap', views.attendance_heatmap),
    path('attendance/remind', views.attendance_remind),
    path('attendance/departure-policy', views.attendance_departure_policy),
    path('attendance/networks', att_networks.attendance_networks),
    path('attendance/recheckin-requests', views.attendance_recheckin_requests),
    path('attendance/recheckin/<int:pk>/decide', views.attendance_recheckin_decide),
    path('attendance/roster', views.attendance_roster),
    path('attendance/home-locations', views.attendance_home_locations),
    path('attendance/home-locations/review', views.attendance_home_location_review),
    path('attendance/home-locations/changes', work_setup.home_changes),
    path('attendance/home-locations/changes/<int:pk>/decide', work_setup.home_change_decide),
    path('attendance/home-locations/changes/<int:pk>', work_setup.home_change_cancel),
    path('attendance/arrangements', views.attendance_arrangements),
    path('attendance/arrangements/<int:pk>', views.attendance_arrangement_detail),
    path('attendance/geofences', views.attendance_geofences),
    path('attendance/geofences/<int:pk>', views.attendance_geofence_detail),
    path('attendance/wfh', views.wfh_requests),
    path('attendance/wfh/<int:pk>', views.wfh_request_detail),
    path('attendance/corrections', views.attendance_corrections),
    path('attendance/corrections/<int:pk>', views.attendance_correction_detail),
    # Forgot-punch tickets (raise a ticket beside Request WFH)
    path('attendance/punch-ticket', views.attendance_punch_ticket),
    path('attendance/punch-ticket/pending', views.attendance_punch_ticket_pending),
    path('attendance/punch-ticket/<int:pk>/proof', views.attendance_punch_ticket_proof),
    path('attendance/punch-ticket/<int:pk>/decide', views.attendance_punch_ticket_decide),
    # Attendance policy profiles, penalties, short leave (attendance_ext/policy_views.py, short_leave.py)
    path('attendance/policies', att_policy.policies),
    path('attendance/policies/assignments', att_policy.assignments),
    path('attendance/policies/preview', att_policy.policy_preview),
    path('attendance/policies/options', att_policy.policy_options),
    path('attendance/policies/resolve', att_policy.policy_resolve),
    path('attendance/policies/<int:pk>', att_policy.policy_detail),
    path('attendance/penalties', att_policy.penalty_list),
    path('attendance/penalties/evaluate', att_policy.penalty_evaluate),
    path('attendance/penalties/<int:pk>/waive', att_policy.penalty_waive),
    path('attendance/short-leave', att_short_leave.short_leave),
    path('attendance/short-leave/queue', att_short_leave.short_leave_queue),
    path('attendance/short-leave/<int:pk>/decide', att_short_leave.short_leave_decide),
    path('attendance/short-leave/<int:pk>/cancel', att_short_leave.short_leave_cancel),
    # Missed punches + regularization (attendance_ext/regularization.py)
    path('attendance/regularization', att_regularization.regularization),
    path('attendance/regularization/queue', att_regularization.regularization_queue),
    path('attendance/regularization/<int:pk>/decide', att_regularization.regularization_decide),
    path('attendance/punch-issues', att_regularization.punch_issues),
    path('attendance/missed-punch-policy', att_regularization.missed_punch_policy),
    # Overtime rules + comp-off (attendance_ext/overtime.py, Workstream O)
    path('attendance/overtime-records', att_overtime.records),
    path('attendance/overtime-records/batch', att_overtime.batch),
    path('attendance/overtime-records/<int:pk>/decide', att_overtime.decide),
    path('attendance/overtime-summary', att_overtime.summary),
    path('attendance/overtime-evaluate', att_overtime.evaluate),
    # Employee attendance detail + hourly location tracking
    path('attendance/day-detail', views.attendance_day_detail),
    path('attendance/location-punch', views.attendance_location_punch),
    path('attendance/<int:pk>', views.attendance_detail),
    path('attendance/recalculate', attendance_recalc.attendance_recalculate),

    # Shifts
    path('shifts', views.shifts),
    path('shifts/<int:pk>', views.shift_detail),
    path('shift-assignments', views.shift_assignments),
    path('shift-assignments/<int:pk>', views.shift_assignment_detail),

    # Employees module — Leave Management
    path('leave', views.leave),
    path('leave/balance', views.leave_balance),
    path('leave/policy', views.leave_policy),
    # Leave accrual ledger (Attendance Phase 1 / L): attendance_ext/leave_accrual.py
    path('leave/ledger', leave_ledger_views.ledger),
    path('leave/ledger/adjust', leave_ledger_views.adjust),
    path('leave/ledger/people', leave_ledger_views.people),
    path('leave/accrual/run', leave_ledger_views.accrual_run),
    path('leave/rollover', leave_ledger_views.rollover),
    # Holiday calendars (Attendance Phase 1 / H): /api/holidays now resolves
    # the caller's own calendar; views.holidays is the old national-only view.
    path('holidays', holiday_views.holidays_api),
    path('holiday-calendars', holiday_views.holiday_calendars),
    path('holiday-calendars/assignments', holiday_views.holiday_calendar_assignments),
    path('holiday-calendars/<int:pk>', holiday_views.holiday_calendar_detail),
    path('holiday-calendars/<int:pk>/days', holiday_views.holiday_calendar_days),
    path('holiday-calendars/<int:pk>/days/<int:day_id>', holiday_views.holiday_calendar_day_detail),
    path('holiday-calendars/<int:pk>/import', holiday_views.holiday_calendar_import),
    path('leave/<int:pk>', views.leave_detail),
    path('leave/<int:pk>/approver', views.leave_approver),

    # Employees module — Task Tracker
    path('tasks', views.tasks),
    path('tasks/assignees', views.task_assignees),
    path('tasks/<int:pk>', views.task_detail),
    path('tasks/<int:pk>/comments', project_views.task_comments),
    path('tasks/<int:task_pk>/comments/<int:comment_pk>', project_views.task_comment_detail),
    path('tasks/<int:task_pk>/comments/<int:comment_pk>/reactions', project_views.task_reaction),
    path('projects', project_views.projects_list),
    path('projects/<int:pk>', project_views.project_detail),
    path('projects/<int:pk>/milestones', project_views.project_milestones),
    path('projects/<int:pk>/burndown', project_views.project_burndown),
    path('projects/<int:pk>/status-updates', project_views.project_status_updates),
    path('projects/<int:pk>/status-updates/<int:uid>', project_views.project_status_update_detail),
    path('projects/<int:pk>/archive', project_views.project_archive),
    path('projects/<int:pk>/unarchive', project_views.project_unarchive),
    path('projects/<int:pk>/views', project_views.project_views_list),
    path('projects/<int:pk>/views/<int:vid>', project_views.project_view_detail),
    path('projects/<int:pk>/fields', project_views.project_fields_list),
    path('projects/<int:pk>/fields/<int:fid>', project_views.project_field_detail),
    path('tasks/<int:task_pk>/fields/<int:fid>', project_views.task_field_value),

    # Employees module — Work Submissions
    path('submissions', views.submissions),
    path('submissions/<int:pk>', views.submission_detail),
    path('submissions/<int:pk>/thread', submission_discussion.thread),
    path('submissions/<int:pk>/comments', submission_discussion.comments),
    path('submissions/<int:pk>/collaborators', submission_discussion.collaborators),
    path('submissions/<int:pk>/collaborators/<str:member>', submission_discussion.collaborator_detail),
    path('submissions/<int:pk>/file', views.submission_file),
    path('submissions/<int:pk>/review-file', views.submission_review_file),

    # Recruit module — Bench Sales — Bench Submissions
    path('recruit/bench-submissions', views.bench_submissions),
    path('recruit/bench-submissions/<int:pk>', views.bench_submission_detail),

    # Recruit module — Bench Sales — consultant profile roster
    path('recruit/bench-sales', views.bench_sales_profiles),
    path('recruit/bench-sales/<int:pk>', views.bench_sales_profile_detail),
    path('recruit/bench-sales/<int:pk>/file/<str:field>', views.bench_sales_profile_file),
    path('recruit/bench-sales/<int:pk>/upload', views.bench_sales_profile_upload),
    path('recruit/bench-sales/<int:pk>/certificates/<int:cert_id>', views.bench_sales_profile_certificate_detail),
    path('recruit/bench-sales/<int:pk>/certificates/<int:cert_id>/file', views.bench_sales_profile_certificate_file),

    # Role-Based Access Control (RBAC)
    path('rbac/stats', views.rbac_stats),
    path('rbac/users', views.rbac_users),
    path('rbac/users/<int:pk>', views.rbac_user_detail),
    path('roles', views.roles),
    path('roles/<int:pk>', views.role_detail),
    path('roles/<int:pk>/groups', views.role_groups),
    path('roles/<int:pk>/permissions', views.role_permissions_view),
    path('permission-groups', views.permission_groups),
    path('permission-groups/<int:pk>', views.permission_group_detail),
    path('permission-groups/<int:pk>/permissions', views.permission_group_permissions),
    path('permissions', views.permissions),
    path('permissions/<int:pk>', views.permission_detail),
    path('modules', views.modules),
    path('companies', views.companies),
    path('me/permissions', views.my_permissions),

    path('dashboard/stats', views.dashboard_stats),
    path('directory', views.directory_search),
    path('avatars', views.avatars),
    path('avatars/<str:email>', views.avatar_image),
    path('config', views.client_config),
    path('integrations/status', views.integrations_status),
    path('health', views.health),

    # Recruitment KPI Dashboard
    path('recruitment/kpis', views.recruitment_kpis),

    # === Advanced Attendance Management API Endpoints ===
    # Shifts
    path('shifts/', attendance_views.ShiftViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('shifts/active/', attendance_views.ShiftViewSet.as_view({'get': 'active'})),
    path('shifts/<int:pk>/', attendance_views.ShiftViewSet.as_view({'get': 'retrieve', 'put': 'update', 'delete': 'destroy'})),
    path('shifts/<int:pk>/assignments/', attendance_views.ShiftViewSet.as_view({'get': 'assignments'})),

    # Check-In/Check-Out
    # Same guarded, location-verified views as the slash-less routes; these used
    # to reach an AllowAny viewset that skipped identity and every fence.
    path('attendance/check-in/', views.attendance_check_in),
    path('attendance/check-out/', views.attendance_check_out),
    path('attendance/device-punch/', attendance_views.AttendanceCheckInOutViewSet.as_view({'post': 'device_punch'})),
    path('attendance/today/', attendance_views.AttendanceCheckInOutViewSet.as_view({'get': 'today'})),
    path('attendance/summary/', attendance_views.AttendanceCheckInOutViewSet.as_view({'get': 'summary'})),

    # Core Payroll Endpoints
    path('payroll/dashboard', payroll_views.payroll_dashboard),
    path('payroll/structures', payroll_views.SalaryStructureViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/structures/<int:pk>', payroll_views.SalaryStructureViewSet.as_view({'get': 'retrieve', 'put': 'update', 'delete': 'destroy'})),
    path('payroll/structures/<int:pk>/components', payroll_views.SalaryStructureViewSet.as_view({'get': 'manage_components', 'post': 'manage_components'})),
    path('payroll/structures/<int:pk>/components/<int:component_id>', payroll_views.SalaryStructureViewSet.as_view({'delete': 'delete_component'})),
    path('payroll/periods', payroll_views.PayrollPeriodViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/periods/<int:pk>', payroll_views.PayrollPeriodViewSet.as_view({'get': 'retrieve', 'put': 'update', 'delete': 'destroy'})),
    path('payroll/compensations', payroll_views.EmployeeCompensationViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/compensations/<int:pk>', payroll_views.EmployeeCompensationViewSet.as_view({'get': 'retrieve', 'put': 'update', 'patch': 'partial_update', 'delete': 'destroy'})),
    path('payroll/components', payroll_views.PayComponentViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/components/<int:pk>', payroll_views.PayComponentViewSet.as_view({'get': 'retrieve', 'put': 'update', 'delete': 'destroy'})),
    path('payroll/employee-components', payroll_views.EmployeePayComponentViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/employee-components/<int:pk>', payroll_views.EmployeePayComponentViewSet.as_view({'get': 'retrieve', 'put': 'update', 'delete': 'destroy'})),
    path('payroll/runs', payroll_views.PayrollRunViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/runs/<int:pk>', payroll_views.PayrollRunViewSet.as_view({'get': 'retrieve', 'put': 'update', 'delete': 'destroy'})),
    path('payroll/runs/<int:pk>/entries', payroll_views.PayrollRunViewSet.as_view({'get': 'get_entries'})),
    path('payroll/runs/<int:pk>/attendance-summary', payroll_views.PayrollRunViewSet.as_view({'get': 'attendance_summary'})),
    path('payroll/runs/<int:pk>/validate', payroll_views.PayrollRunViewSet.as_view({'post': 'validate_run'})),
    path('payroll/runs/<int:pk>/submit-approval', payroll_views.PayrollRunViewSet.as_view({'post': 'submit_approval'})),
    path('payroll/runs/<int:pk>/action-approval', payroll_views.PayrollRunViewSet.as_view({'post': 'action_approval'})),
    path('payroll/runs/<int:pk>/approve', payroll_views.PayrollRunViewSet.as_view({'post': 'approve'})),
    path('payroll/runs/<int:pk>/create-payment-batch', payroll_views.PayrollRunViewSet.as_view({'post': 'create_payment_batch'})),
    path('payroll/runs/<int:pk>/export-bank-file', payroll_views.PayrollRunViewSet.as_view({'get': 'export_bank_file'})),
    path('payroll/runs/<int:pk>/export-neft-file', payroll_views.PayrollRunViewSet.as_view({'get': 'export_neft_file'})),
    path('payroll/adjustments', payroll_views.PayrollAdjustmentViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/adjustments/<int:pk>', payroll_views.PayrollAdjustmentViewSet.as_view({'get': 'retrieve', 'delete': 'destroy'})),
    path('payroll/approvals', payroll_views.PayrollApprovalViewSet.as_view({'get': 'list'})),
    path('payroll/payments', payroll_views.PayrollPaymentViewSet.as_view({'get': 'list'})),
    path('payroll/payments/disburse', payroll_views.PayrollPaymentViewSet.as_view({'post': 'disburse_batch'})),
    path('payroll/payments/<int:pk>/mark-failed', payroll_views.PayrollPaymentViewSet.as_view({'post': 'mark_failed'})),
    path('payroll/audit-logs', payroll_views.PayrollAuditLogViewSet.as_view({'get': 'list'})),
    path('payroll/reports/monthly', payroll_views.payroll_monthly_report),
    path('payroll/reports/department', payroll_views.payroll_department_report),
    path('payroll/reports/statutory', payroll_views.payroll_statutory_report),
    path('payroll/payslips', payroll_views.PayslipViewSet.as_view({'get': 'list', 'post': 'create'})),
    path('payroll/payslips/<int:pk>', payroll_views.PayslipViewSet.as_view({'get': 'retrieve'})),
    path('payroll/payslips/<int:pk>/pdf', payroll_views.PayslipViewSet.as_view({'get': 'download_pdf'})),
    path('payroll/payslips/<int:pk>/regenerate', payroll_views.PayslipViewSet.as_view({'post': 'regenerate_pdf'})),
    path('payroll/settings', payroll_views.PayrollSettingViewSet.as_view({'get': 'list', 'post': 'create'})),

    # Breaks
    path('attendance/break/start/', attendance_views.BreakViewSet.as_view({'post': 'start'})),
    path('attendance/break/end/', attendance_views.BreakViewSet.as_view({'post': 'end'})),
    path('attendance/breaks/today/', attendance_views.BreakViewSet.as_view({'get': 'today'})),

    # Late Check-In Alerts
    path('attendance/late-alerts/', attendance_views.LateCheckInAlertViewSet.as_view({'get': 'list_alerts'})),
    path('attendance/late-alerts/excuse/', attendance_views.LateCheckInAlertViewSet.as_view({'post': 'excuse'})),

    # Overtime
    path('attendance/overtime/daily/', attendance_views.OvertimeViewSet.as_view({'get': 'daily'})),
    path('attendance/overtime/monthly/', attendance_views.OvertimeViewSet.as_view({'get': 'monthly'})),
    path('attendance/overtime/balance/', attendance_views.OvertimeViewSet.as_view({'get': 'balance'})),
    path('attendance/overtime/approve/', attendance_views.OvertimeViewSet.as_view({'post': 'approve'})),

    # Attendance Corrections
    path('attendance/correction/', attendance_views.AttendanceCorrectionViewSet.as_view({'post': 'request_correction'})),
    path('attendance/correction/approve/', attendance_views.AttendanceCorrectionViewSet.as_view({'post': 'approve_correction'})),
    path('attendance/correction/reject/', attendance_views.AttendanceCorrectionViewSet.as_view({'post': 'reject_correction'})),
    path('attendance/correction/pending/', attendance_views.AttendanceCorrectionViewSet.as_view({'get': 'pending'})),

    # WFH Requests
    path('attendance/wfh/submit/', attendance_views.WFHRequestViewSet.as_view({'post': 'submit_request'})),
    path('attendance/wfh/approve/', attendance_views.WFHRequestViewSet.as_view({'post': 'approve_request'})),
    path('attendance/wfh/reject/', attendance_views.WFHRequestViewSet.as_view({'post': 'reject_request'})),

    # Onboarding — work authorization, documents, and the candidate lifecycle.
    # Static segments precede <int:pk> so they are not swallowed by it.
    path('onboarding/dashboard', onboarding_views.onboarding_dashboard),
    path('onboarding/alerts', onboarding_views.onboarding_alerts),
    # One list per sidebar page — each returns what that page is about.
    path('onboarding/work-authorizations', onboarding_views.work_authorization_list),
    path('onboarding/documents', onboarding_views.documents_list),
    path('onboarding/verifications', onboarding_views.verifications_list),
    path('onboarding/asset-allocations', onboarding_views.asset_allocations_list),
    path('onboarding/payroll', onboarding_views.payroll_list),
    path('onboarding/field-config', onboarding_views.candidate_field_config),
    path('onboarding/work-auth-field-config', onboarding_views.work_auth_field_config),
    path('onboarding/work-auth-type-field-config', onboarding_views.work_auth_type_field_config),
    path('onboarding/form-templates', onboarding_views.candidate_form_templates),
    path('onboarding/form-templates/<int:pk>', onboarding_views.candidate_form_template_detail),
    path('onboarding/candidates', onboarding_views.candidates),
    path('onboarding/candidates/<int:pk>', onboarding_views.candidate_detail),
    path('onboarding/candidates/<int:pk>/timeline', onboarding_views.candidate_timeline),
    path('onboarding/candidates/<int:pk>/work-authorization', onboarding_views.candidate_work_authorization),
    path('onboarding/candidates/<int:pk>/documents', onboarding_views.candidate_documents),
    path('onboarding/candidates/<int:pk>/documents/<int:doc_id>', onboarding_views.candidate_document_detail),
    path('onboarding/candidates/<int:pk>/documents/<int:doc_id>/preview', onboarding_views.candidate_document_preview),
    path('onboarding/candidates/<int:pk>/document-versions/<str:doc_type>', onboarding_views.candidate_document_versions),
    path('onboarding/candidates/<int:pk>/verify', onboarding_views.candidate_verification),
    path('onboarding/candidates/<int:pk>/approve', onboarding_views.candidate_approval),
    path('onboarding/candidates/<int:pk>/assets', onboarding_views.candidate_assets),
    path('onboarding/candidates/<int:pk>/assets/<int:asset_id>', onboarding_views.candidate_asset_detail),
    path('onboarding/candidates/<int:pk>/payroll', onboarding_views.candidate_payroll),
    # Audited reveal of ONE encrypted identifier (permission + fresh sign-in) — api/sensitive.py
    path('sensitive/<str:entity>/<int:pk>/reveal', sensitive.reveal),
    path('onboarding/candidates/<int:pk>/activate', onboarding_views.candidate_activate),

    # Payroll form templates (admin)
    path('onboarding/forms', onboarding_views.payroll_templates),
    path('onboarding/forms/<int:pk>', onboarding_views.payroll_template_detail),

    # Candidate submissions (admin)
    path('onboarding/candidates/<int:pk>/submissions', onboarding_views.candidate_form_submissions),
    path('onboarding/candidates/<int:pk>/submissions/<int:sub_id>/pdf', onboarding_views.candidate_submission_pdf),
    path('onboarding/candidates/<int:pk>/send-portal-link', onboarding_views.send_portal_link),

    # Public portal endpoints (candidate)
    path('public/onboarding/forms', onboarding_views.public_candidate_forms),
    path('public/onboarding/forms/<int:form_id>', onboarding_views.public_form_template_detail),
    path('public/onboarding/submit-form', onboarding_views.public_submit_form),
    path('public/onboarding/upload-document', onboarding_views.public_upload_document),
    path('public/onboarding/complete', onboarding_views.public_complete_portal),
]

# --- Employee Chat routes (appended by chat-module integration) ---
urlpatterns += [
    path("chat/rooms", views.chat_rooms),
    path("chat/rooms/<int:room_id>", views.chat_room_detail),
    path("chat/messages/<int:room_id>", views.chat_messages),
    path("chat/message/<int:msg_id>", views.chat_message_detail),
    path("chat/message/<int:msg_id>/pin", views.chat_message_pin),
    path("chat/translate", views.chat_translate),           # POST translate composer text
    path("chat/attachment/<int:msg_id>", views.chat_attachment),
    path("chat/rooms/<int:room_id>/read", views.chat_mark_read),
    path("chat/rooms/<int:room_id>/members", views.chat_room_members),
    path("chat/rooms/<int:room_id>/members/<str:email>", views.chat_room_member_detail),
    path("chat/contacts", views.chat_contacts),
    path("chat/ws-ticket/<int:room_id>", chat_extras.chat_ws_ticket),
    path("chat/unread", chat_extras.chat_unread_total),
    path("chat/threads", chat_extras.chat_threads),
    path("chat/pins", chat_extras.chat_my_pins),
    path("chat/channels/browse", chat_extras.chat_browse_channels),
    path("chat/rooms/<int:room_id>/join", chat_extras.chat_join_channel),
    path("chat/message/<int:msg_id>/react", chat_extras.chat_message_react),
    path("chat/meetings", views.chat_meetings),
    path("chat/meetings/<int:meeting_id>", views.chat_meeting_detail),
    # Payroll extensions (tax, statutory, payouts, US, ESS, F&F) — api/payroll_ext
    path('', include('api.payroll_ext.urls')),
]
