"""
API ViewSet endpoints for Core Payroll Module.
Safe exception handling catches missing DB tables gracefully before migration.
"""
import io
import csv
import base64
import functools
from datetime import datetime, date
from decimal import Decimal

from django.db import DatabaseError
from django.http import HttpResponse, JsonResponse
from rest_framework import viewsets, status
from rest_framework.decorators import api_view, action
from rest_framework.exceptions import APIException
from rest_framework.response import Response

from api.models import (
    EmployeeCompensation, PayComponent, EmployeePayComponent,
    PayrollRun, Payslip, PayrollSetting, SalaryStructure,
    SalaryStructureComponent, PayrollPeriod, PayrollEntry,
    PayrollAdjustment, PayrollApproval, PayrollPayment, PayrollAuditLog
)
from api.serializers import (
    EmployeeCompensationSerializer, PayComponentSerializer,
    EmployeePayComponentSerializer, PayrollRunSerializer,
    PayslipSerializer, PayrollSettingSerializer, SalaryStructureSerializer,
    SalaryStructureComponentSerializer, PayrollPeriodSerializer,
    PayrollEntrySerializer, PayrollAdjustmentSerializer,
    PayrollApprovalSerializer, PayrollPaymentSerializer,
    PayrollAuditLogSerializer
)
from api.sensitive import scrub as scrub_identifiers
from api.services.payroll_service import (
    PayrollService, ensure_payroll_tables, audit_payroll_action
)


# ── Access control ───────────────────────────────────────────────────────────
#
# DRF's global permission class is AllowAny, so every endpoint here enforces
# its own rule. The caller is the X-User-Email header (hrms-actor.js attaches it
# to every same-origin /api/ call), resolved by api.permissions exactly like
# @require_perm: unknown / inactive caller → 401, missing permission → 403.
#
#   reads (GET/HEAD/OPTIONS)                 payroll.view (or payroll.manage)
#   writes and run actions                   payroll.manage
#   runs/<id>/create-payment-batch           payroll.payout.prepare or .release
#   payments/<id>/mark-failed                payroll.payout.prepare or .release
#   payments/disburse                        payroll.payout.release + fresh sign-in
#   runs/<id>/export-neft-file|bank-file     payroll.manage + fresh sign-in
#
# Self-service (no payroll permission needed): an employee may read their own
# compensation (GET compensations?email=<self>), their own payslips
# (GET payslips?email=<self>, payslips/<id>, payslips/<id>/pdf).
#
# "Fresh sign-in" = a valid JWT (Authorization: Bearer, also sent by
# hrms-actor.js) for the same person as X-User-Email, so a forged header alone
# cannot move money or pull every employee's full bank account number.
PERM_READ = ('payroll.view', 'payroll.manage')
PERM_MANAGE = 'payroll.manage'
PERM_PAYOUT = ('payroll.payout.prepare', 'payroll.payout.release')
PERM_RELEASE = 'payroll.payout.release'
READ_METHODS = ('GET', 'HEAD', 'OPTIONS')


class PayrollAccessDenied(APIException):
    """401/403 with the same JSON body the rest of the API returns."""
    def __init__(self, status_code, body):
        self.status_code = status_code
        self.detail = body


def _required_label(perm):
    return perm if isinstance(perm, str) else ' or '.join(perm)


def payroll_access(request, perm, fresh=False):
    """Return (email, user) when allowed, else raise PayrollAccessDenied."""
    from api.permissions import _CACHE, _get_caller, _user_has_perm
    _CACHE.clear()
    email, user = _get_caller(request)
    if not email or not user or getattr(user, 'status', 'active') != 'active':
        raise PayrollAccessDenied(401, {'message': 'Authentication required. Please sign in again.',
                                        'code': 'AUTH_REQUIRED'})
    if perm is not None:
        codes = (perm,) if isinstance(perm, str) else tuple(perm)
        if not any(_user_has_perm(user, c) for c in codes):
            need = _required_label(perm)
            raise PayrollAccessDenied(403, {'message': f"You don't have permission to perform this action. "
                                                       f"Required: {need}",
                                            'code': 'PERMISSION_DENIED', 'required': need})
    if fresh:
        token_user = getattr(request, 'user', None)
        token_email = (getattr(token_user, 'email', '') or '').strip().lower()
        if not token_email or token_email != email:
            raise PayrollAccessDenied(401, {'message': 'For security, this action needs a fresh sign-in. '
                                                       'Sign out and sign in again, then retry.',
                                            'code': 'REAUTH_REQUIRED'})
    return email, user


def _can(user, perm):
    from api.permissions import _user_has_perm
    codes = (perm,) if isinstance(perm, str) else tuple(perm)
    return any(_user_has_perm(user, c) for c in codes)


def payroll_perm(perm=PERM_READ):
    """Decorator for the function views below (place it under @api_view)."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(request, *args, **kwargs):
            try:
                payroll_access(request, perm)
            except PayrollAccessDenied as exc:
                return Response(exc.detail, status=exc.status_code)
            return fn(request, *args, **kwargs)
        return wrapper
    return deco


class SafeViewSet(viewsets.ModelViewSet):
    """Base ViewSet that auto-creates missing tables on DatabaseError.

    Also the single access-control point for every payroll viewset (see the
    table above). Subclasses tune it with:
      action_perms   {action_name: perm}   overrides the read/manage default
      fresh_actions  {action_name, ...}    additionally need a fresh sign-in
      self_list      True                  GET list?email=<caller> is self-service
      self_object_actions {action, ...}    object actions the owner may read
    """
    action_perms = {}
    fresh_actions = frozenset()
    self_list = False
    self_object_actions = frozenset()

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        self.check_payroll_access(request)

    def check_payroll_access(self, request):
        action_name = getattr(self, 'action', None)
        is_read = request.method in READ_METHODS
        perm = self.action_perms.get(action_name, PERM_READ if is_read else PERM_MANAGE)
        fresh = action_name in self.fresh_actions
        # Identify the caller first: anonymous is always 401.
        email, user = payroll_access(request, None)
        self.caller_email = email
        self.caller_can_read = _can(user, PERM_READ)
        if is_read and perm == PERM_READ and not self.caller_can_read:
            if self.self_list and action_name == 'list':
                target = (request.query_params.get('email') or '').strip().lower()
                if target and target == email:
                    return
            elif action_name in self.self_object_actions and self._owns_object(email):
                return
        payroll_access(request, perm, fresh=fresh)

    def _owns_object(self, email):
        pk = self.kwargs.get(self.lookup_url_kwarg or self.lookup_field)
        try:
            owner = self.queryset.model.objects.filter(pk=pk).values_list('email', flat=True).first()
        except (DatabaseError, ValueError, TypeError):
            return False
        return bool(owner) and owner.strip().lower() == email

    def list(self, request, *args, **kwargs):
        try:
            return super().list(request, *args, **kwargs)
        except DatabaseError:
            try:
                ensure_payroll_tables()
                return super().list(request, *args, **kwargs)
            except Exception:
                return Response([], status=status.HTTP_200_OK)


@api_view(['GET'])
@payroll_perm(PERM_READ)
def payroll_dashboard(request):
    """Get aggregated dashboard KPIs, status breakdowns, and distribution metrics."""
    try:
        metrics = PayrollService.get_dashboard_metrics()
        return Response(metrics, status=status.HTTP_200_OK)
    except Exception as e:
        return Response({'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class SalaryStructureViewSet(SafeViewSet):
    """Manage corporate salary structures and templates."""
    queryset = SalaryStructure.objects.all().order_by('-id')
    serializer_class = SalaryStructureSerializer

    def list(self, request, *args, **kwargs):
        try:
            ensure_payroll_tables()
            from api.services.payroll_service import seed_default_salary_structures
            seed_default_salary_structures()
        except Exception:
            pass
        return super().list(request, *args, **kwargs)

    @action(detail=True, methods=['get', 'post'], url_path='components')
    def manage_components(self, request, pk=None):
        structure = self.get_object()
        if request.method == 'GET':
            comps = SalaryStructureComponent.objects.filter(structure=structure).order_by('display_order', 'id')
            return Response(SalaryStructureComponentSerializer(comps, many=True).data)

        # POST: Add or update component in structure
        comp_id = request.data.get('component_id')
        calc_type = request.data.get('calc_type', 'fixed')
        rate = request.data.get('rate', 0.0)
        amount = request.data.get('amount', 0.0)
        order = request.data.get('display_order', 1)

        try:
            pay_comp = PayComponent.objects.get(id=comp_id)
            item, created = SalaryStructureComponent.objects.update_or_create(
                structure=structure,
                component=pay_comp,
                defaults={
                    'calc_type': calc_type,
                    'rate': Decimal(str(rate or 0)),
                    'amount': Decimal(str(amount or 0)),
                    'display_order': int(order),
                }
            )
            audit_payroll_action('structure_component_updated', 'SalaryStructure', structure.id,
                                 actor_name=request.data.get('updated_by', 'Admin'),
                                 notes=f"Component {pay_comp.name} configured in {structure.name}")
            return Response(SalaryStructureComponentSerializer(item).data, status=status.HTTP_200_OK)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['delete'], url_path='components/(?P<component_id>[^/.]+)')
    def delete_component(self, request, pk=None, component_id=None):
        structure = self.get_object()
        try:
            SalaryStructureComponent.objects.filter(structure=structure, component_id=component_id).delete()
            return Response({'status': 'deleted'}, status=status.HTTP_200_OK)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)


class SalaryStructureComponentViewSet(SafeViewSet):
    queryset = SalaryStructureComponent.objects.all()
    serializer_class = SalaryStructureComponentSerializer


class PayrollPeriodViewSet(SafeViewSet):
    """Manage standard payroll calendar periods."""
    queryset = PayrollPeriod.objects.all().order_by('-start_date', '-id')
    serializer_class = PayrollPeriodSerializer


class EmployeeCompensationViewSet(SafeViewSet):
    queryset = EmployeeCompensation.objects.all().order_by('-id')
    serializer_class = EmployeeCompensationSerializer
    lookup_field = 'pk'
    self_list = True          # HRIS profile: GET compensations?email=<self>

    def list(self, request, *args, **kwargs):
        try:
            ensure_payroll_tables()
            from api.services.payroll_service import seed_default_compensations
            seed_default_compensations()
        except Exception:
            pass
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        try:
            qs = super().get_queryset()
            email = self.request.query_params.get('email')
            dept = self.request.query_params.get('department')
            status_param = self.request.query_params.get('status')
            structure_id = self.request.query_params.get('salary_structure')

            if email:
                qs = qs.filter(email__iexact=email.strip())
            if status_param:
                qs = qs.filter(status__iexact=status_param.strip())
            if structure_id:
                qs = qs.filter(salary_structure_id=structure_id)
            if dept:
                # filter by profile department
                from api.models import UserProfile
                matched_emails = UserProfile.objects.filter(department__iexact=dept.strip()).values_list('email', flat=True)
                qs = qs.filter(email__in=matched_emails)
            return qs
        except DatabaseError:
            return EmployeeCompensation.objects.none()

    def update(self, request, *args, **kwargs):
        """Update compensation with revision audit logging."""
        reason = request.data.get('revision_reason', 'Salary revision')
        revised_by = request.data.get('revised_by', 'Admin')
        resp = super().update(request, *args, **kwargs)
        try:
            audit_payroll_action('compensation_revised', 'EmployeeCompensation', kwargs.get('pk'),
                                 actor_name=revised_by, notes=reason,
                                 changes=scrub_identifiers(dict(request.data)))
        except Exception:
            pass
        return resp


class PayComponentViewSet(SafeViewSet):
    queryset = PayComponent.objects.all().order_by('display_order', 'id')
    serializer_class = PayComponentSerializer

    def list(self, request, *args, **kwargs):
        try:
            ensure_payroll_tables()
            from api.services.payroll_service import seed_default_pay_components
            seed_default_pay_components()
        except Exception:
            pass
        return super().list(request, *args, **kwargs)


class EmployeePayComponentViewSet(SafeViewSet):
    queryset = EmployeePayComponent.objects.all()
    serializer_class = EmployeePayComponentSerializer

    def get_queryset(self):
        try:
            qs = super().get_queryset()
            email = self.request.query_params.get('email')
            if email:
                qs = qs.filter(email__iexact=email.strip())
            return qs
        except DatabaseError:
            return EmployeePayComponent.objects.none()


class PayrollRunViewSet(SafeViewSet):
    """Handles guided payroll execution, validation, approvals, and payout export."""
    queryset = PayrollRun.objects.all().order_by('-id')
    serializer_class = PayrollRunSerializer
    # No dedicated run-approval permission exists (channels.PAYRUN_APPROVE_PERMS
    # is payroll.manage too), so approvals stay on the manage default.
    action_perms = {
        'create_payment_batch': PERM_PAYOUT,
        'export_neft_file': PERM_MANAGE,
        'export_bank_file': PERM_MANAGE,
    }
    fresh_actions = frozenset({'export_neft_file', 'export_bank_file'})

    def create(self, request, *args, **kwargs):
        """Step 1 & 4: Trigger creation/re-calculation of pay run."""
        period_label = request.data.get('period_label')  # e.g., '2026-08'
        period_start_str = request.data.get('period_start')  # '2026-08-01'
        period_end_str = request.data.get('period_end')      # '2026-08-31'
        created_by = request.data.get('created_by', 'Admin')
        period_id = request.data.get('period_id')

        if not period_label:
            period_label = datetime.now().strftime('%Y-%m')

        try:
            if period_start_str:
                start_d = datetime.strptime(period_start_str.strip(), '%Y-%m-%d').date()
            else:
                year, month = map(int, period_label.split('-'))
                start_d = date(year, month, 1)
        except Exception:
            year, month = datetime.now().year, datetime.now().month
            start_d = date(year, month, 1)

        try:
            if period_end_str:
                end_d = datetime.strptime(period_end_str.strip(), '%Y-%m-%d').date()
            else:
                from calendar import monthrange
                _, last_day = monthrange(start_d.year, start_d.month)
                end_d = date(start_d.year, start_d.month, last_day)
        except Exception:
            from calendar import monthrange
            _, last_day = monthrange(start_d.year, start_d.month)
            end_d = date(start_d.year, start_d.month, last_day)

        try:
            run = PayrollService.create_pay_run(
                period_label=period_label,
                period_start=start_d,
                period_end=end_d,
                created_by=created_by,
                period_id=period_id
            )
            serializer = self.get_serializer(run)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        except ValueError as ve:
            return Response({'error': str(ve)}, status=status.HTTP_409_CONFLICT)
        except Exception as e:
            return Response({'error': f'Pay run error: {str(e)}'}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'], url_path='entries')
    def get_entries(self, request, pk=None):
        """Step 6: Get employee-wise salary ledger entries for review."""
        run = self.get_object()
        entries = PayrollEntry.objects.filter(run=run).order_by('employee_name', 'id')
        dept = request.query_params.get('department')
        search = request.query_params.get('search')
        if dept:
            entries = entries.filter(department__iexact=dept.strip())
        if search:
            s = search.strip()
            entries = entries.filter(employee_name__icontains=s) | entries.filter(email__icontains=s)
        return Response(PayrollEntrySerializer(entries, many=True).data)

    @action(detail=True, methods=['get'], url_path='attendance-summary')
    def attendance_summary(self, request, pk=None):
        """Step 2 & 3: Fetch attendance and paid days/LOP breakdown for this run."""
        run = self.get_object()
        summary = PayrollService.step_fetch_attendance(run.period_start, run.period_end)
        return Response(summary)

    @action(detail=True, methods=['post'], url_path='validate')
    def validate_run(self, request, pk=None):
        """Step 5: Run thorough validation checks before approval submission."""
        run = self.get_object()
        validation = PayrollService.step_validate_payroll(run.id)
        return Response(validation)

    @action(detail=True, methods=['post'], url_path='submit-approval')
    def submit_approval(self, request, pk=None):
        """Step 7: Submit pay run for multi-level approval pipeline."""
        # Who submitted is the signed-in caller, never a name from the body.
        _email, _user = payroll_access(request, None)
        submitted_by = (getattr(_user, 'full_name', '') or _email)
        comments = request.data.get('comments', '')
        try:
            run = PayrollService.step_submit_approval(int(pk), submitted_by=submitted_by, comments=comments)
            return Response(self.get_serializer(run).data)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='action-approval')
    def action_approval(self, request, pk=None):
        """Step 8: Multi-level approval action (approve, reject, request_corrections)."""
        action_val = request.data.get('action', 'approve')  # 'approve', 'reject', 'request_corrections'
        comments = request.data.get('comments', '')
        # The approver and their approval level come from the signed-in
        # caller, not the request body: otherwise anyone with payroll.manage
        # could approve as someone else, or claim 'finance_manager' and
        # finalise a run in one click. Only a Super Admin may pick a level.
        from api.payroll_ext.channels import approval_level
        approver_email, _user = payroll_access(request, None)
        approver_name = getattr(_user, 'full_name', '') or approver_email
        level = approval_level(_user)
        if level == 'super_admin':
            level = request.data.get('level') or 'super_admin'
            if level not in ('payroll_executive', 'hr_manager', 'finance_manager', 'super_admin'):
                level = 'super_admin'

        try:
            run = PayrollService.step_process_approval(
                run_id=int(pk),
                level=level,
                action=action_val,
                approver_email=approver_email,
                approver_name=approver_name,
                comments=comments
            )
            return Response(self.get_serializer(run).data)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='approve')
    def approve(self, request, pk=None):
        """Approve pay run and lock payslips."""
        try:
            _email, _user = payroll_access(request, None)
            approved_by = getattr(_user, 'full_name', '') or _email
            run = PayrollService.approve_pay_run(int(pk), approved_by=approved_by)
            serializer = self.get_serializer(run)
            return Response(serializer.data)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='create-payment-batch')
    def create_payment_batch(self, request, pk=None):
        """Create payment batch for direct disbursal (payment tracking)."""
        method = request.data.get('payment_method', 'bank_transfer')
        try:
            res = PayrollService.create_payment_batch(int(pk), payment_method=method)
            return Response(res, status=status.HTTP_201_CREATED)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'], url_path='export-bank-file')
    def export_bank_file(self, request, pk=None):
        """Export NACHA / Direct Deposit CSV file."""
        try:
            csv_data = PayrollService.export_bank_nacha_csv(int(pk))
            run = self.get_object()
            response = HttpResponse(csv_data, content_type='text/csv')
            response['Content-Disposition'] = f'attachment; filename="Payroll_Payout_{run.period_label}.csv"'
            return response
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['get'], url_path='export-neft-file')
    def export_neft_file(self, request, pk=None):
        """Export NEFT/RTGS Bank Payout CSV."""
        try:
            csv_data = PayrollService.export_bank_neft_csv(int(pk))
            run = self.get_object()
            response = HttpResponse(csv_data, content_type='text/csv')
            response['Content-Disposition'] = f'attachment; filename="Bank_Transfer_NEFT_{run.period_label}.csv"'
            return response
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)


class PayrollAdjustmentViewSet(SafeViewSet):
    """One-off bonuses, incentives, arrears, or deductions per payroll run."""
    queryset = PayrollAdjustment.objects.all().order_by('-id')
    serializer_class = PayrollAdjustmentSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        run_id = self.request.query_params.get('run_id')
        email = self.request.query_params.get('email')
        if run_id:
            qs = qs.filter(run_id=run_id)
        if email:
            qs = qs.filter(email__iexact=email.strip())
        return qs


class PayrollApprovalViewSet(SafeViewSet):
    """View approval pipeline records and history."""
    queryset = PayrollApproval.objects.all().order_by('-created_at', '-id')
    serializer_class = PayrollApprovalSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        run_id = self.request.query_params.get('run_id')
        if run_id:
            qs = qs.filter(run_id=run_id)
        return qs


class PayrollPaymentViewSet(SafeViewSet):
    """Manage and disburse employee bank payouts."""
    queryset = PayrollPayment.objects.all().order_by('-id')
    serializer_class = PayrollPaymentSerializer
    action_perms = {
        'disburse_batch': PERM_RELEASE,
        'mark_failed': PERM_PAYOUT,
    }
    fresh_actions = frozenset({'disburse_batch'})

    def get_queryset(self):
        qs = super().get_queryset()
        run_id = self.request.query_params.get('run_id')
        st = self.request.query_params.get('status')
        if run_id:
            qs = qs.filter(run_id=run_id)
        if st:
            qs = qs.filter(status__iexact=st.strip())
        return qs

    @action(detail=False, methods=['post'], url_path='disburse')
    def disburse_batch(self, request):
        """Disburse payment batch with reference tracking."""
        payment_ids = request.data.get('payment_ids', [])
        ref_prefix = request.data.get('reference_prefix', 'PAY')
        disbursed_by = request.data.get('disbursed_by', 'Finance Manager')
        if not payment_ids:
            return Response({'error': 'No payment IDs provided.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            res = PayrollService.disburse_payments(payment_ids, reference_prefix=ref_prefix, disbursed_by=disbursed_by)
            return Response(res, status=status.HTTP_200_OK)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='mark-failed')
    def mark_failed(self, request, pk=None):
        """Mark a payment failed with reason."""
        reason = request.data.get('failure_reason', 'Transaction declined by bank')
        updated_by = request.data.get('updated_by', 'Finance Manager')
        try:
            pm = PayrollService.mark_payment_failed(int(pk), failure_reason=reason, updated_by=updated_by)
            return Response(self.get_serializer(pm).data)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)


class PayrollAuditLogViewSet(SafeViewSet):
    """Read-only audit trail of all payroll transactions."""
    queryset = PayrollAuditLog.objects.all().order_by('-created_at')
    serializer_class = PayrollAuditLogSerializer


class PayslipViewSet(SafeViewSet):
    """Generate, download, and restrict payslips with employee-specific security."""
    queryset = Payslip.objects.all().order_by('-id')
    serializer_class = PayslipSerializer
    self_list = True                                        # GET payslips?email=<self>
    self_object_actions = frozenset({'retrieve', 'download_pdf'})

    def get_queryset(self):
        try:
            qs = super().get_queryset()
            # Confidentiality: without payroll.view a caller only ever sees
            # their own payslips (check_payroll_access already refused the rest).
            if not getattr(self, 'caller_can_read', False):
                me = getattr(self, 'caller_email', None)
                qs = qs.filter(email__iexact=me) if me else qs.none()
            email_param = self.request.query_params.get('email')
            if email_param:
                qs = qs.filter(email__iexact=email_param.strip())

            run_id = self.request.query_params.get('run_id')
            if run_id:
                qs = qs.filter(run_id=run_id)
            return qs
        except DatabaseError:
            return Payslip.objects.none()

    @action(detail=True, methods=['get'], url_path='pdf')
    def download_pdf(self, request, pk=None):
        """Download or view payslip as rendered HTML (printable to PDF)."""
        try:
            payslip = self.get_object()   # get_queryset limits non-viewers to their own

            if not payslip.file_data:
                payslip.file_data = PayrollService.generate_payslip_pdf(payslip)
                payslip.save()

            html_bytes = base64.b64decode(payslip.file_data)
            response = HttpResponse(html_bytes, content_type='text/html; charset=utf-8')
            fname = payslip.file_name or f'Payslip_{payslip.run.period_label}_{payslip.employee_name}.html'
            response['Content-Disposition'] = f'inline; filename="{fname}"'
            return response
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='regenerate')
    def regenerate_pdf(self, request, pk=None):
        """Force-regenerate the payslip HTML from current data."""
        try:
            payslip = self.get_object()
            payslip.file_data = PayrollService.generate_payslip_pdf(payslip)
            payslip.file_name = f"Payslip_{payslip.run.period_label}_{payslip.email.split('@')[0]}.html"
            payslip.file_size = len(payslip.file_data)
            payslip.save()
            serializer = self.get_serializer(payslip)
            return Response(serializer.data)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)


class PayrollSettingViewSet(SafeViewSet):
    queryset = PayrollSetting.objects.all()
    serializer_class = PayrollSettingSerializer


# ── Report Endpoints ─────────────────────────────────────────────────────────

@api_view(['GET'])
@payroll_perm(PERM_READ)
def payroll_monthly_report(request):
    """Get aggregated monthly payroll report."""
    year = int(request.query_params.get('year', datetime.now().year))
    month = int(request.query_params.get('month', datetime.now().month))
    report = PayrollService.get_monthly_payroll_report(year, month)
    return Response(report)


@api_view(['GET'])
@payroll_perm(PERM_READ)
def payroll_department_report(request):
    """Get department distribution report for a run."""
    run_id = request.query_params.get('run_id')
    if not run_id:
        latest = PayrollRun.objects.order_by('-id').first()
        run_id = latest.id if latest else None
    if not run_id:
        return Response([])
    report = PayrollService.get_department_payroll_report(int(run_id))
    return Response(report)


@api_view(['GET'])
@payroll_perm(PERM_READ)
def payroll_statutory_report(request):
    """Get PF, ESI, PT, and TDS tax report."""
    run_id = request.query_params.get('run_id')
    if not run_id:
        latest = PayrollRun.objects.order_by('-id').first()
        run_id = latest.id if latest else None
    if not run_id:
        return Response({})
    report = PayrollService.get_statutory_tax_report(int(run_id))
    return Response(report)
