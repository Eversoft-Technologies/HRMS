"""
API ViewSet endpoints for Core Payroll Module.
Safe exception handling catches missing DB tables gracefully before migration.
"""
from datetime import datetime, date
from django.db import DatabaseError
from django.http import HttpResponse, JsonResponse
from rest_framework import viewsets, status
from rest_framework.decorators import api_view, action
from rest_framework.response import Response

from api.models import (
    EmployeeCompensation, PayComponent, EmployeePayComponent,
    PayrollRun, Payslip, PayrollSetting
)
from api.serializers import (
    EmployeeCompensationSerializer, PayComponentSerializer,
    EmployeePayComponentSerializer, PayrollRunSerializer,
    PayslipSerializer, PayrollSettingSerializer
)
from api.services.payroll_service import PayrollService, ensure_payroll_tables


class SafeViewSet(viewsets.ModelViewSet):
    """Base ViewSet that auto-creates missing tables on DatabaseError."""
    def list(self, request, *args, **kwargs):
        try:
            return super().list(request, *args, **kwargs)
        except DatabaseError:
            try:
                ensure_payroll_tables()
                return super().list(request, *args, **kwargs)
            except Exception:
                return Response([], status=status.HTTP_200_OK)


class EmployeeCompensationViewSet(SafeViewSet):
    queryset = EmployeeCompensation.objects.all()
    serializer_class = EmployeeCompensationSerializer
    lookup_field = 'pk'

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
            if email:
                qs = qs.filter(email__iexact=email.strip())
            return qs
        except DatabaseError:
            return EmployeeCompensation.objects.none()


class PayComponentViewSet(SafeViewSet):
    queryset = PayComponent.objects.all()
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
    queryset = PayrollRun.objects.all()
    serializer_class = PayrollRunSerializer

    def create(self, request, *args, **kwargs):
        """Trigger creation/re-calculation of a draft pay run."""
        period_label = request.data.get('period_label')  # e.g., '2026-08'
        period_start_str = request.data.get('period_start')  # '2026-08-01'
        period_end_str = request.data.get('period_end')      # '2026-08-31'
        created_by = request.data.get('created_by', 'Admin')

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
                created_by=created_by
            )
            serializer = self.get_serializer(run)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        except Exception as e:
            return Response({'error': f'Pay run error: {str(e)}'}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='approve')
    def approve(self, request, pk=None):
        """Approve pay run and lock payslips."""
        try:
            approved_by = request.data.get('approved_by', 'Admin')
            run = PayrollService.approve_pay_run(int(pk), approved_by=approved_by)
            serializer = self.get_serializer(run)
            return Response(serializer.data)
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


class PayslipViewSet(SafeViewSet):
    queryset = Payslip.objects.all()
    serializer_class = PayslipSerializer

    def get_queryset(self):
        try:
            qs = super().get_queryset()
            email = self.request.query_params.get('email')
            run_id = self.request.query_params.get('run_id')
            if email:
                qs = qs.filter(email__iexact=email.strip())
            if run_id:
                qs = qs.filter(run_id=run_id)
            return qs
        except DatabaseError:
            return Payslip.objects.none()

    @action(detail=True, methods=['get'], url_path='pdf')
    def download_pdf(self, request, pk=None):
        """Download or view payslip PDF."""
        try:
            payslip = self.get_object()
            if not payslip.file_data:
                payslip.file_data = PayrollService.generate_payslip_pdf(payslip)
                payslip.save()

            import base64
            pdf_bytes = base64.b64decode(payslip.file_data)
            response = HttpResponse(pdf_bytes, content_type='text/html')
            response['Content-Disposition'] = f'inline; filename="{payslip.file_name or "payslip.pdf"}"'
            return response
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)


class PayrollSettingViewSet(SafeViewSet):
    queryset = PayrollSetting.objects.all()
    serializer_class = PayrollSettingSerializer
