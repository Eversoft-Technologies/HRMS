"""
REST API views for Core Payroll module.
"""
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import (
    EmployeeCompensation, PayComponent, EmployeePayComponent,
    PayrollRun, Payslip, PayrollSetting
)
from .serializers import (
    EmployeeCompensationSerializer, PayComponentSerializer,
    EmployeePayComponentSerializer, PayrollRunSerializer,
    PayslipSerializer, PayrollSettingSerializer
)


class EmployeeCompensationViewSet(viewsets.ModelViewSet):
    queryset = EmployeeCompensation.objects.all()
    serializer_class = EmployeeCompensationSerializer
    permission_classes = [permissions.AllowAny]


class PayComponentViewSet(viewsets.ModelViewSet):
    queryset = PayComponent.objects.all()
    serializer_class = PayComponentSerializer
    permission_classes = [permissions.AllowAny]


class EmployeePayComponentViewSet(viewsets.ModelViewSet):
    queryset = EmployeePayComponent.objects.all()
    serializer_class = EmployeePayComponentSerializer
    permission_classes = [permissions.AllowAny]


class PayrollRunViewSet(viewsets.ModelViewSet):
    queryset = PayrollRun.objects.all()
    serializer_class = PayrollRunSerializer
    permission_classes = [permissions.AllowAny]

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        run = self.get_object()
        run.status = 'approved'
        run.save(update_fields=['status'])
        return Response({'status': 'approved'})

    @action(detail=True, methods=['get'], url_path='export-bank-file')
    def export_bank_file(self, request, pk=None):
        run = self.get_object()
        return Response({'ok': True, 'run_id': run.id, 'file_url': ''})


class PayslipViewSet(viewsets.ModelViewSet):
    queryset = Payslip.objects.all()
    serializer_class = PayslipSerializer
    permission_classes = [permissions.AllowAny]

    @action(detail=True, methods=['get'], url_path='pdf')
    def download_pdf(self, request, pk=None):
        payslip = self.get_object()
        return Response({'pdf': payslip.file_data})


class PayrollSettingViewSet(viewsets.ModelViewSet):
    queryset = PayrollSetting.objects.all()
    serializer_class = PayrollSettingSerializer
    permission_classes = [permissions.AllowAny]
