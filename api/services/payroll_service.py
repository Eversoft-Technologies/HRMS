"""
Core Payroll Service layer handling compensation calculations, attendance-to-payroll bridge,
pay run execution, payslip generation, and bank file exports.
"""
import base64
import csv
import io
import logging
from datetime import datetime, date, timedelta
from decimal import Decimal
from django.utils import timezone
from django.db.models import Q, Sum

from api.models import (
    AppUser, EmployeeAttendance, LeaveRequest, WfhRequest,
    EmployeeCompensation, PayComponent, EmployeePayComponent,
    PayrollRun, Payslip, PayrollSetting, PayrollInformation
)
from api import mailer

logger = logging.getLogger(__name__)


def seed_default_pay_components():
    """Seed standard earnings & deductions pay components if catalogue is empty."""
    try:
        from api.models import PayComponent
        if PayComponent.objects.exists():
            return

        defaults = [
            {
                'code': 'BASE_SALARY',
                'name': 'Base Monthly Salary',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True
            },
            {
                'code': 'OVERTIME',
                'name': 'Overtime Pay (1.5x)',
                'component_type': 'earning',
                'calc_type': 'formula',
                'rate': Decimal('1.5000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True
            },
            {
                'code': 'HRA',
                'name': 'House Rent Allowance',
                'component_type': 'earning',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.2000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True
            },
            {
                'code': 'PERF_BONUS',
                'name': 'Performance Bonus',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('500.00'),
                'is_taxable': True,
                'is_active': True
            },
            {
                'code': 'LOP_DEDUCTION',
                'name': 'Loss of Pay (Absence)',
                'component_type': 'deduction',
                'calc_type': 'formula',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True
            },
            {
                'code': 'TAX_WITHHOLDING',
                'name': 'State & Federal Tax Withholding',
                'component_type': 'deduction',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.1000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True
            },
            {
                'code': 'HEALTH_INSURANCE',
                'name': 'Medical & Dental Insurance',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('150.00'),
                'is_taxable': False,
                'is_active': True
            },
            {
                'code': 'RETIREMENT_401K',
                'name': '401(k) / Retirement Contribution',
                'component_type': 'deduction',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.0500'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True
            },
        ]

        for item in defaults:
            PayComponent.objects.get_or_create(code=item['code'], defaults=item)
    except Exception as ex:
        logger.warning(f"Error seeding pay components: {ex}")


def seed_default_compensations():
    """Auto-setup baseline EmployeeCompensation for active AppUsers if empty."""
    try:
        from api.models import AppUser, EmployeeCompensation
        if EmployeeCompensation.objects.exists():
            return

        active_users = AppUser.objects.filter(status='active')
        for user in active_users:
            if user.email:
                EmployeeCompensation.objects.get_or_create(
                    email=user.email.strip().lower(),
                    defaults={
                        'pay_type': 'salaried',
                        'pay_frequency': 'monthly',
                        'base_amount': Decimal('5000.00'),
                        'annual_ctc': Decimal('60000.00'),
                        'currency': 'USD',
                        'status': 'active',
                        'effective_from': timezone.now().date(),
                        'notes': 'Default baseline compensation auto-initialized.'
                    }
                )
    except Exception as ex:
        logger.warning(f"Error seeding default compensation records: {ex}")


def ensure_payroll_tables():
    """Auto-create MySQL / SQLite payroll tables using Django ORM SchemaEditor if missing."""
    from django.db import connection
    from api.models import (
        EmployeeCompensation, PayComponent, EmployeePayComponent,
        PayrollRun, Payslip, PayrollSetting
    )
    models_to_create = [
        EmployeeCompensation, PayComponent, EmployeePayComponent,
        PayrollRun, Payslip, PayrollSetting
    ]
    try:
        existing_tables = connection.introspection.table_names()
        with connection.schema_editor() as schema_editor:
            for model in models_to_create:
                if model._meta.db_table not in existing_tables:
                    try:
                        schema_editor.create_model(model)
                    except Exception as ex:
                        logger.warning(f"Error creating table {model._meta.db_table}: {ex}")

        # Seed default pay components catalog and baseline employee compensation
        seed_default_pay_components()
        seed_default_compensations()
    except Exception as e:
        logger.warning(f"Auto-table creation exception: {e}")


class PayrollService:
    """Handles payroll computations, pay run execution, and payslip workflows."""

    @staticmethod
    def calculate_employee_pay(email: str, start_date: date, end_date: date) -> dict:
        """
        Calculate earnings, attendance LOP deductions, overtime, and net pay for an employee.
        """
        email = email.strip().lower()
        comp = EmployeeCompensation.objects.filter(
            email__iexact=email,
            status='active',
            effective_from__lte=end_date
        ).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=start_date)
        ).order_by('-effective_from').first()

        base_salary = comp.base_amount if comp else Decimal('0.00')
        pay_type = comp.pay_type if comp else 'salaried'
        currency = comp.currency if comp else 'USD'

        total_period_days = (end_date - start_date).days + 1
        if total_period_days <= 0:
            total_period_days = 30

        # Query attendance in date range
        attendances = EmployeeAttendance.objects.filter(
            email__iexact=email,
            date__gte=start_date,
            date__lte=end_date
        )

        present_days = attendances.filter(status='present').count()
        late_days = attendances.filter(status='late').count()
        half_days = attendances.filter(status='half-day').count()
        worked_days = Decimal(str(present_days + late_days)) + (Decimal('0.5') * Decimal(str(half_days)))

        total_worked_minutes = attendances.aggregate(total=Sum('worked_minutes'))['total'] or 0
        total_overtime_minutes = attendances.aggregate(total=Sum('overtime_minutes'))['total'] or 0
        overtime_hours = Decimal(str(round(total_overtime_minutes / 60.0, 2)))

        # Approved WFH days
        wfh_count = WfhRequest.objects.filter(
            email__iexact=email,
            status='Approved',
            from_date__lte=end_date,
            to_date__gte=start_date
        ).count()

        # Approved paid leaves
        leave_count = LeaveRequest.objects.filter(
            email__iexact=email,
            status='Approved',
            from_date__lte=end_date,
            to_date__gte=start_date
        ).count()

        # Accounted paid days
        paid_days = min(Decimal(str(total_period_days)), worked_days + Decimal(str(wfh_count + leave_count)))
        
        # Loss of Pay (LOP) days
        raw_lop = Decimal(str(total_period_days)) - paid_days
        lop_days = max(Decimal('0.00'), raw_lop)

        daily_rate = (base_salary / Decimal(str(total_period_days))).quantize(Decimal('0.01')) if total_period_days > 0 else Decimal('0.00')
        hourly_rate = (daily_rate / Decimal('8.00')).quantize(Decimal('0.01'))

        earnings_data = []
        deductions_data = []

        # 1. Base Pay computation
        if pay_type == 'salaried':
            earnings_data.append({
                'code': 'BASE_SALARY',
                'label': 'Base Monthly Salary',
                'amount': float(base_salary)
            })
            if lop_days > 0:
                lop_deduction = (daily_rate * lop_days).quantize(Decimal('0.01'))
                deductions_data.append({
                    'code': 'LOP_DEDUCTION',
                    'label': f'Loss of Pay ({lop_days} days)',
                    'amount': float(lop_deduction)
                })
        else:
            # Hourly worker
            worked_hours = Decimal(str(round(total_worked_minutes / 60.0, 2)))
            actual_base = (worked_hours * hourly_rate).quantize(Decimal('0.01'))
            earnings_data.append({
                'code': 'HOURLY_PAY',
                'label': f'Hourly Pay ({worked_hours} hrs @ {hourly_rate}/hr)',
                'amount': float(actual_base)
            })

        # 2. Overtime Earning (1.5x hourly rate)
        if overtime_hours > Decimal('0.00'):
            ot_amount = (overtime_hours * hourly_rate * Decimal('1.5')).quantize(Decimal('0.01'))
            earnings_data.append({
                'code': 'OVERTIME',
                'label': f'Overtime Pay ({overtime_hours} hrs)',
                'amount': float(ot_amount)
            })

        # 3. Custom Employee Pay Components
        emp_components = EmployeePayComponent.objects.filter(
            email__iexact=email,
            effective_from__lte=end_date
        ).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=start_date)
        ).select_related('component')

        for item in emp_components:
            comp_obj = item.component
            if not comp_obj.is_active:
                continue
            
            amount = item.amount if item.amount is not None else comp_obj.default_amount
            if comp_obj.calc_type == 'percent_of_base':
                rate = item.rate if item.rate is not None else comp_obj.rate
                amount = (base_salary * rate).quantize(Decimal('0.01'))

            entry = {
                'code': comp_obj.code,
                'label': comp_obj.name,
                'amount': float(amount)
            }
            if comp_obj.component_type == 'earning':
                earnings_data.append(entry)
            else:
                deductions_data.append(entry)

        # Totals
        gross_earnings = sum(Decimal(str(e['amount'])) for e in earnings_data if e['code'] != 'BASE_SALARY')
        if pay_type == 'salaried':
            gross_earnings += base_salary

        total_deductions = sum(Decimal(str(d['amount'])) for d in deductions_data)
        net_pay = max(Decimal('0.00'), gross_earnings - total_deductions)

        # Get employee name
        user = AppUser.objects.filter(email__iexact=email).first()
        employee_name = (user.full_name if user and user.full_name else (getattr(user, 'name', '') or email.split('@')[0].title()))

        return {
            'email': email,
            'employee_name': employee_name,
            'worked_days': float(worked_days),
            'paid_days': float(paid_days),
            'lop_days': float(lop_days),
            'overtime_hours': float(overtime_hours),
            'base_salary': float(base_salary),
            'gross_earnings': float(gross_earnings),
            'total_deductions': float(total_deductions),
            'net_pay': float(net_pay),
            'currency': currency,
            'earnings_data': earnings_data,
            'deductions_data': deductions_data
        }

    @staticmethod
    def create_pay_run(period_label: str, period_start: date, period_end: date, created_by: str = 'system') -> PayrollRun:
        """Create or update a draft pay run for all active staff."""
        ensure_payroll_tables()

        run, created = PayrollRun.objects.get_or_create(
            period_label=period_label,
            defaults={
                'period_start': period_start,
                'period_end': period_end,
                'frequency': 'monthly',
                'status': 'draft',
                'created_by': created_by
            }
        )

        # Get active employees (from AppUser or EmployeeCompensation)
        active_users = AppUser.objects.filter(status='active')
        emails = set(u.email.strip().lower() for u in active_users if u.email)
        comp_emails = set(c.email.strip().lower() for c in EmployeeCompensation.objects.filter(status='active'))
        all_emails = sorted(list(emails.union(comp_emails)))

        total_gross = Decimal('0.00')
        total_deductions = Decimal('0.00')
        total_net = Decimal('0.00')
        emp_count = 0

        for email in all_emails:
            calc = PayrollService.calculate_employee_pay(email, period_start, period_end)
            
            payslip, _ = Payslip.objects.update_or_create(
                run=run,
                email=email,
                defaults={
                    'employee_name': calc['employee_name'],
                    'worked_days': Decimal(str(calc['worked_days'])),
                    'paid_days': Decimal(str(calc['paid_days'])),
                    'lop_days': Decimal(str(calc['lop_days'])),
                    'overtime_hours': Decimal(str(calc['overtime_hours'])),
                    'base_salary': Decimal(str(calc['base_salary'])),
                    'gross_earnings': Decimal(str(calc['gross_earnings'])),
                    'total_deductions': Decimal(str(calc['total_deductions'])),
                    'net_pay': Decimal(str(calc['net_pay'])),
                    'earnings_data': calc['earnings_data'],
                    'deductions_data': calc['deductions_data'],
                    'status': 'draft'
                }
            )

            total_gross += Decimal(str(calc['gross_earnings']))
            total_deductions += Decimal(str(calc['total_deductions']))
            total_net += Decimal(str(calc['net_pay']))
            emp_count += 1

        run.total_gross = total_gross
        run.total_deductions = total_deductions
        run.total_net = total_net
        run.employee_count = emp_count
        run.save()

        return run

    @staticmethod
    def approve_pay_run(run_id: int, approved_by: str = 'admin') -> PayrollRun:
        """Approve pay run, lock payslips, and generate PDF payslips."""
        run = PayrollRun.objects.get(id=run_id)
        run.status = 'approved'
        run.approved_by = approved_by
        run.approved_at = timezone.now()
        run.save()

        payslips = Payslip.objects.filter(run=run)
        for payslip in payslips:
            payslip.status = 'approved'
            # Generate PDF data
            pdf_b64 = PayrollService.generate_payslip_pdf(payslip)
            payslip.file_data = pdf_b64
            payslip.file_name = f"Payslip_{run.period_label}_{payslip.email.split('@')[0]}.pdf"
            payslip.file_size = len(pdf_b64)
            payslip.save()

        return run

    @staticmethod
    def generate_payslip_pdf(payslip: Payslip) -> str:
        """Generate HTML-rendered base64 PDF/Document for payslip."""
        earnings_rows = "".join(
            f"<tr><td>{e.get('label', '')}</td><td style='text-align:right'>${e.get('amount', 0):,.2f}</td></tr>"
            for e in payslip.earnings_data
        )
        deductions_rows = "".join(
            f"<tr><td>{d.get('label', '')}</td><td style='text-align:right'>${d.get('amount', 0):,.2f}</td></tr>"
            for d in payslip.deductions_data
        )

        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {{ font-family: Arial, sans-serif; margin: 20px; color: #333; }}
            .header {{ text-align: center; border-bottom: 2px solid #2563eb; padding-bottom: 10px; }}
            .info {{ width: 100%; margin: 20px 0; border-collapse: collapse; }}
            .info td {{ padding: 6px; }}
            .table {{ width: 100%; border-collapse: collapse; margin-top: 15px; }}
            .table th, .table td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
            .table th {{ background-color: #f3f4f6; }}
            .total {{ font-weight: bold; background-color: #eff6ff; }}
          </style>
        </head>
        <body>
          <div class="header">
            <h2>EVERSOFT TECHNOLOGIES</h2>
            <h3>PAYSLIP - {payslip.run.period_label}</h3>
          </div>
          <table class="info">
            <tr><td><strong>Employee Name:</strong> {payslip.employee_name}</td><td><strong>Pay Period:</strong> {payslip.run.period_start} to {payslip.run.period_end}</td></tr>
            <tr><td><strong>Email:</strong> {payslip.email}</td><td><strong>Worked / Paid Days:</strong> {payslip.worked_days} / {payslip.paid_days}</td></tr>
            <tr><td><strong>LOP Days:</strong> {payslip.lop_days}</td><td><strong>Overtime Hours:</strong> {payslip.overtime_hours}</td></tr>
          </table>

          <h4>Earnings</h4>
          <table class="table">
            <tr><th>Component</th><th style="text-align:right">Amount (USD)</th></tr>
            {earnings_rows}
            <tr class="total"><td>Gross Earnings</td><td style="text-align:right">${payslip.gross_earnings:,.2f}</td></tr>
          </table>

          <h4>Deductions</h4>
          <table class="table">
            <tr><th>Component</th><th style="text-align:right">Amount (USD)</th></tr>
            {deductions_rows}
            <tr class="total"><td>Total Deductions</td><td style="text-align:right">${payslip.total_deductions:,.2f}</td></tr>
          </table>

          <h3 style="text-align:right; margin-top: 20px; color: #1e40af;">Net Pay: ${payslip.net_pay:,.2f}</h3>
        </body>
        </html>
        """
        encoded = base64.b64encode(html_content.encode('utf-8')).decode('utf-8')
        return encoded

    @staticmethod
    def export_bank_nacha_csv(run_id: int) -> str:
        """Export bank payout CSV format for direct deposit batch processing."""
        run = PayrollRun.objects.get(id=run_id)
        payslips = Payslip.objects.filter(run=run)

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['Employee Name', 'Employee Email', 'Bank Name', 'Account Number', 'Routing Number', 'Net Pay (USD)', 'Status'])

        for p in payslips:
            bank_info = PayrollInformation.objects.filter(email__iexact=p.email).first()
            bank_name = bank_info.bank_name if bank_info else 'N/A'
            acct_num = bank_info.account_number if bank_info else 'N/A'
            routing = bank_info.routing_number if bank_info else 'N/A'

            writer.writerow([
                p.employee_name,
                p.email,
                bank_name,
                acct_num,
                routing,
                f"{p.net_pay:.2f}",
                p.status
            ])

        return output.getvalue()
