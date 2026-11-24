"""
Core Payroll Service layer handling compensation calculations, attendance-to-payroll bridge,
pay run execution, payslip generation, and bank file exports.

Configured for Indian payroll: INR, PF/ESI/PT/TDS deductions, Employer CTC contributions.
"""
import base64
import csv
import io
import logging
from calendar import monthrange
from datetime import datetime, date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from django.utils import timezone
from django.db.models import Q, Sum

from api.models import (
    AppUser, UserProfile, CompanyDetail,
    EmployeeAttendance, LeaveRequest, WfhRequest, Overtime,
    EmployeeCompensation, PayComponent, EmployeePayComponent,
    PayrollRun, Payslip, PayrollSetting, PayrollInformation,
    SalaryStructure, SalaryStructureComponent, PayrollPeriod,
    PayrollEntry, PayrollAdjustment, PayrollApproval,
    PayrollPayment, PayrollAuditLog
)
from api import mailer

logger = logging.getLogger(__name__)

# ─── Indian Rupees amount-to-words converter ────────────────────────────────

_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
         'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
         'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty',
         'Sixty', 'Seventy', 'Eighty', 'Ninety']


def _two_digit_words(n):
    """Convert 0-99 to words with hyphenation (e.g. Twenty-One)."""
    if n < 20:
        return _ONES[n]
    tens = _TENS[n // 10]
    ones = _ONES[n % 10]
    return f"{tens}-{ones}" if ones else tens


def amount_to_words_inr(amount):
    """Convert a numeric amount to Indian Rupee words.
    e.g., 17650 -> 'Rs. Seventeen Thousand Six Hundred Fifty Rupees Only'
    """
    amount = int(round(float(amount)))
    if amount == 0:
        return 'Rs. Zero Rupees Only'

    # Indian number system: last 3 digits (hundreds), then groups of 2
    parts = []
    # Crores
    if amount >= 10000000:
        crores = amount // 10000000
        parts.append(_two_digit_words(crores) + ' Crore')
        amount %= 10000000
    # Lakhs
    if amount >= 100000:
        lakhs = amount // 100000
        parts.append(_two_digit_words(lakhs) + ' Lakh')
        amount %= 100000
    # Thousands
    if amount >= 1000:
        thousands = amount // 1000
        parts.append(_two_digit_words(thousands) + ' Thousand')
        amount %= 1000
    # Hundreds
    if amount >= 100:
        hundreds = amount // 100
        parts.append(_ONES[hundreds] + ' Hundred')
        amount %= 100
    # Tens + ones
    if amount > 0:
        parts.append(_two_digit_words(amount))

    return 'Rs. ' + ' '.join(parts) + ' Rupees Only'


# ─── Default Indian Pay Components Seeder ────────────────────────────────────

def audit_payroll_action(action, entity_type, entity_id, actor_email='system', actor_name='System', changes=None, notes='', ip_address=None):
    """Write an immutable audit log entry for any payroll change."""
    try:
        from api.models import PayrollAuditLog
        PayrollAuditLog.objects.create(
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            actor_email=actor_email or 'system',
            actor_name=actor_name or 'System',
            changes=changes or {},
            notes=notes or '',
            ip_address=ip_address or ''
        )
    except Exception as ex:
        logger.warning(f"Error recording payroll audit log: {ex}")


def seed_default_pay_components():
    """Seed standard Indian earnings & deductions pay components."""
    try:
        from api.models import PayComponent

        defaults = [
            # ── Earnings ──
            {
                'code': 'BASIC_SALARY',
                'name': 'Basic Salary',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 1,
            },
            {
                'code': 'HRA',
                'name': 'House Rent Allowance (HRA)',
                'component_type': 'earning',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.5000'),   # 50% of Basic
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 2,
            },
            {
                'code': 'CONVEYANCE_ALLOWANCE',
                'name': 'Conveyance Allowance',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('1600.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 3,
            },
            {
                'code': 'MEDICAL_ALLOWANCE',
                'name': 'Medical Allowance',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('1250.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 4,
            },
            {
                'code': 'SPECIAL_ALLOWANCE',
                'name': 'Special Allowance',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('3500.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 5,
            },
            {
                'code': 'PERFORMANCE_BONUS',
                'name': 'Performance Bonus',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 6,
            },
            {
                'code': 'OVERTIME',
                'name': 'Overtime Pay',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 7,
            },
            {
                'code': 'OTHER_ALLOWANCES',
                'name': 'Other Allowances',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 8,
            },
            {
                'code': 'TRANSPORT_ALLOWANCE',
                'name': 'Transport Allowance',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('1600.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 9,
            },
            {
                'code': 'CEA',
                'name': 'Children Education Allowance',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('200.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 10,
            },
            {
                'code': 'LTA',
                'name': 'Leave Travel Allowance',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 11,
            },
            {
                'code': 'INCENTIVES',
                'name': 'Incentives',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 12,
            },

            # ── Deductions ──
            {
                'code': 'PF',
                'name': 'Provident Fund (PF)',
                'component_type': 'deduction',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.1200'),   # 12% of Basic
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 1,
            },
            {
                'code': 'ESI',
                'name': 'Employee State Insurance (ESI)',
                'component_type': 'deduction',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.0075'),   # 0.75% of gross
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 2,
            },
            {
                'code': 'PROFESSIONAL_TAX',
                'name': 'Professional Tax (PT)',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('200.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 3,
            },
            {
                'code': 'TDS',
                'name': 'TDS / Income Tax',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 4,
            },
            {
                'code': 'LOAN_RECOVERY',
                'name': 'Loan Recovery',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 5,
            },
            {
                'code': 'UNPAID_LEAVE_DEDUCTION',
                'name': 'Unpaid Leave Deduction (LOP)',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 6,
            },
            {
                'code': 'OTHER_DEDUCTIONS',
                'name': 'Other Deductions',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 7,
            },

            # ── Employer Contributions ──
            {
                'code': 'EMPLOYER_PF',
                'name': "Employer's Provident Fund",
                'component_type': 'employer',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.1200'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 1,
            },
            {
                'code': 'EMPLOYER_ESI',
                'name': "Employer's State Insurance",
                'component_type': 'employer',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.0325'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 2,
            },
        ]

        for item in defaults:
            PayComponent.objects.get_or_create(code=item['code'], defaults=item)
    except Exception as ex:
        logger.warning(f"Error seeding pay components: {ex}")


def seed_default_salary_structures():
    """Seed standard Indian Corporate Salary Structure and associate with employees."""
    try:
        from api.models import SalaryStructure, SalaryStructureComponent, PayComponent, EmployeeCompensation
        structure, created = SalaryStructure.objects.get_or_create(
            code='IND_STD_2026',
            defaults={
                'name': 'Standard Corporate Salary Structure',
                'description': 'Standard Indian enterprise compensation model with Basic, HRA, Allowances, PF, ESI, PT, and TDS',
                'currency': 'INR',
                'is_active': True,
                'created_by': 'System'
            }
        )

        structure_components = [
            ('BASIC_SALARY', 'percent_of_base', Decimal('1.0000'), Decimal('0.00'), 1),
            ('HRA', 'percent_of_base', Decimal('0.5000'), Decimal('0.00'), 2),
            ('CONVEYANCE_ALLOWANCE', 'fixed', Decimal('0.0000'), Decimal('1600.00'), 3),
            ('MEDICAL_ALLOWANCE', 'fixed', Decimal('0.0000'), Decimal('1250.00'), 4),
            ('SPECIAL_ALLOWANCE', 'fixed', Decimal('0.0000'), Decimal('3500.00'), 5),
            ('PF', 'percent_of_base', Decimal('0.1200'), Decimal('0.00'), 10),
            ('PROFESSIONAL_TAX', 'fixed', Decimal('0.0000'), Decimal('200.00'), 11),
            ('ESI', 'percent_of_base', Decimal('0.0075'), Decimal('0.00'), 12),
            ('TDS', 'fixed', Decimal('0.0000'), Decimal('0.00'), 13),
        ]

        for code, c_type, rate, amt, order in structure_components:
            comp = PayComponent.objects.filter(code=code).first()
            if comp:
                SalaryStructureComponent.objects.get_or_create(
                    structure=structure,
                    component=comp,
                    defaults={
                        'calc_type': c_type,
                        'rate': rate,
                        'amount': amt,
                        'display_order': order,
                    }
                )

        # Assign structure to any EmployeeCompensation that has null salary_structure
        EmployeeCompensation.objects.filter(salary_structure__isnull=True).update(salary_structure=structure)
    except Exception as ex:
        logger.warning(f"Error seeding default salary structures: {ex}")


def seed_default_compensations():
    """Auto-setup baseline EmployeeCompensation for active AppUsers if empty."""
    try:
        from api.models import AppUser, EmployeeCompensation
        if EmployeeCompensation.objects.exists():
            return

        active_users = AppUser.objects.filter(status='active')
        for user in active_users:
            if user.email:
                # Try to pull employee_id and designation from UserProfile
                profile = UserProfile.objects.filter(email__iexact=user.email.strip()).first()
                emp_id = ''
                if profile:
                    emp_id = profile.employee_id or ''
                elif user.employee_id:
                    emp_id = user.employee_id

                EmployeeCompensation.objects.get_or_create(
                    email=user.email.strip().lower(),
                    defaults={
                        'pay_type': 'salaried',
                        'pay_frequency': 'monthly',
                        'base_amount': Decimal('20000.00'),
                        'annual_ctc': Decimal('261600.00'),
                        'currency': 'INR',
                        'status': 'active',
                        'effective_from': timezone.now().date(),
                        'employee_code': emp_id,
                        'notes': 'Default baseline compensation auto-initialized.'
                    }
                )
    except Exception as ex:
        logger.warning(f"Error seeding default compensation records: {ex}")


def sync_employee_compensation(email, annual_ctc=None, employee_code='', start_date=None,
                               pan_number='', uan_number='', pf_account_number='',
                               bank_name='', bank_account_number='', designation='', department=''):
    """
    Syncs or creates EmployeeCompensation and Indian statutory component breakdown
    whenever an employee is added or updated in HRIS.
    """
    from api.models import EmployeeCompensation, PayComponent, EmployeePayComponent
    from decimal import Decimal, ROUND_HALF_UP
    from datetime import date

    email = str(email or '').strip().lower()
    if not email:
        return None

    try:
        ctc = Decimal(str(annual_ctc or '240000.00')).quantize(Decimal('0.01'))
    except Exception:
        ctc = Decimal('240000.00')

    if ctc <= Decimal('0.00'):
        ctc = Decimal('240000.00')

    monthly_gross = (ctc / Decimal('12')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    basic_salary = (monthly_gross * Decimal('0.50')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    hra = (monthly_gross * Decimal('0.25')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    transport = Decimal('1600.00') if monthly_gross >= Decimal('20000.00') else Decimal('800.00')
    cea = Decimal('200.00') if monthly_gross >= Decimal('15000.00') else Decimal('100.00')
    special_allowance = max(Decimal('0.00'), monthly_gross - (basic_salary + hra + transport + cea))

    eff_date = start_date if isinstance(start_date, date) else date(2026, 1, 1)

    # An employee can carry several compensation rows (revisions over time),
    # so update_or_create(email=...) raised MultipleObjectsReturned. Update
    # the current row (latest effective_from, then newest id); create one
    # only when there is none.
    comp_defaults = {
            'pay_type': 'salaried',
            'pay_frequency': 'monthly',
            'base_amount': basic_salary,
            'annual_ctc': ctc,
            'currency': 'INR',
            'status': 'active',
            'effective_from': eff_date,
            'employee_code': str(employee_code or '').strip(),
            'pan_number': str(pan_number or '').strip(),
            'uan_number': str(uan_number or '').strip(),
            'pf_account_number': str(pf_account_number or '').strip(),
            'bank_name': str(bank_name or '').strip(),
            'bank_account_number': str(bank_account_number or '').strip(),
            'notes': f'Indian CTC breakdown: Basic={basic_salary}, HRA={hra}, Spl={special_allowance}'
    }
    comp = (EmployeeCompensation.objects.filter(email__iexact=email)
            .order_by('-effective_from', '-id').first())
    if comp is None:
        comp = EmployeeCompensation.objects.create(email=email, **comp_defaults)
    else:
        for field, value in comp_defaults.items():
            setattr(comp, field, value)
        comp.save()

    # Setup per-employee overrides for HRA, Transport, CEA, and Special Allowance
    overrides = [
        ('HRA', hra),
        ('TRANSPORT_ALLOWANCE', transport),
        ('CHILDREN_EDUCATION_ALLOWANCE', cea),
        ('SPECIAL_ALLOWANCE', special_allowance),
    ]

    for comp_code, amount in overrides:
        pay_comp = PayComponent.objects.filter(code=comp_code).first()
        if pay_comp:
            EmployeePayComponent.objects.update_or_create(
                email=email,
                component=pay_comp,
                defaults={
                    'amount': amount,
                    'effective_from': eff_date
                }
            )

    return comp


def seed_hris_demo_employees():
    """No-op: Demo employees removed upon request."""
    pass


def ensure_payroll_tables():
    """Auto-create MySQL / SQLite payroll tables using Django ORM SchemaEditor if missing."""
    from django.db import connection
    from api.models import (
        SalaryStructure, PayComponent, SalaryStructureComponent,
        PayrollPeriod, PayrollRun, PayrollEntry, PayrollAdjustment,
        PayrollApproval, PayrollPayment, PayrollAuditLog,
        EmployeeCompensation, EmployeePayComponent,
        Payslip, PayrollSetting
    )
    models_to_create = [
        SalaryStructure, PayComponent, SalaryStructureComponent,
        PayrollPeriod, PayrollRun, PayrollEntry, PayrollAdjustment,
        PayrollApproval, PayrollPayment, PayrollAuditLog,
        EmployeeCompensation, EmployeePayComponent,
        Payslip, PayrollSetting
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

        # Seed default pay components, compensations, and corporate salary structure
        seed_default_pay_components()
        seed_default_compensations()
        seed_default_salary_structures()
    except Exception as e:
        logger.warning(f"Auto-table creation exception: {e}")


class PayrollService:
    """Handles Indian payroll computations, pay run execution, and payslip workflows."""

    @staticmethod
    def calculate_employee_pay(email: str, start_date: date, end_date: date, run_id: int = None) -> dict:
        """
        Calculate earnings, deductions, employer contributions, and net pay
        for an employee supporting configurable SalaryStructure, Attendance/LOP,
        Overtime, and one-off PayrollAdjustments.
        """
        email = email.strip().lower()
        comp = EmployeeCompensation.objects.filter(
            email__iexact=email,
            status='active',
            effective_from__lte=end_date
        ).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=start_date)
        ).order_by('-effective_from', '-id').first()

        if not comp:
            comp = EmployeeCompensation.objects.filter(
                email__iexact=email,
                status='active'
            ).order_by('-effective_from', '-id').first()

        if not comp:
            comp = EmployeeCompensation.objects.filter(
                email__iexact=email
            ).order_by('-effective_from', '-id').first()

        base_salary = comp.base_amount if comp else Decimal('0.00')
        annual_ctc = comp.annual_ctc if (comp and comp.annual_ctc) else (base_salary * Decimal('12'))
        pay_type = comp.pay_type if comp else 'salaried'
        currency = comp.currency if comp else 'INR'

        total_period_days = (end_date - start_date).days + 1
        if total_period_days <= 0:
            total_period_days = 30

        # ── Attendance snapshot ──
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

        try:
            from api.models import Overtime
            ot_reqs = Overtime.objects.filter(
                email__iexact=email,
                date__gte=start_date,
                date__lte=end_date,
                status__iexact='approved'
            )
            ot_sum = ot_reqs.aggregate(total=Sum('overtime_hours'))['total']
            if ot_sum:
                overtime_hours = max(overtime_hours, Decimal(str(ot_sum)))
        except Exception:
            pass

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
        ).exclude(
            Q(type__iexact='lop') | Q(type__iexact='loss of pay') | Q(type__iexact='unpaid')
        ).count()

        # Explicit unpaid / LOP leaves
        unpaid_leaves = LeaveRequest.objects.filter(
            email__iexact=email,
            status='Approved',
            from_date__lte=end_date,
            to_date__gte=start_date
        ).filter(
            Q(type__iexact='lop') | Q(type__iexact='loss of pay') | Q(type__iexact='unpaid')
        ).count()

        # Holiday calendars (attendance_ext/holidays.py): own regional holidays not worked are paid, never LOP.
        from api.attendance_ext.holidays import count_off_days
        holiday_off = count_off_days(email, start_date, end_date, skip=attendances.filter(status__in=('present', 'late', 'half-day')).values_list('date', flat=True))
        if attendances.exists():
            paid_days = min(Decimal(str(total_period_days)), worked_days + Decimal(str(wfh_count + leave_count + holiday_off)))
            raw_lop = Decimal(str(total_period_days)) - paid_days
            lop_days = max(Decimal('0.00'), raw_lop)
        else:
            # Baseline for salaried staff: default to full month less explicit LOP
            lop_days = Decimal(str(unpaid_leaves))
            paid_days = max(Decimal('0.00'), Decimal(str(total_period_days)) - lop_days)
            worked_days = paid_days

        # ── Check for Assigned Salary Structure ──
        salary_structure = comp.salary_structure if comp else None
        if not salary_structure:
            salary_structure = SalaryStructure.objects.filter(is_active=True).first()

        # ── Build Earnings ──
        earnings_data = []

        if salary_structure:
            structure_earnings = SalaryStructureComponent.objects.filter(
                structure=salary_structure,
                component__component_type='earning',
                component__is_active=True
            ).select_related('component').order_by('display_order', 'id')

            for sc in structure_earnings:
                comp_obj = sc.component
                emp_override = EmployeePayComponent.objects.filter(
                    email__iexact=email,
                    component=comp_obj
                ).order_by('-id').first()

                if comp_obj.code == 'BASIC_SALARY':
                    amount = base_salary
                elif emp_override and emp_override.amount is not None:
                    amount = emp_override.amount
                elif emp_override and emp_override.rate is not None:
                    amount = (base_salary * emp_override.rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif sc.calc_type == 'percent_of_base':
                    amount = (base_salary * sc.rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif sc.calc_type == 'percent_of_ctc':
                    monthly_ctc = (annual_ctc / Decimal('12'))
                    amount = (monthly_ctc * sc.rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif sc.calc_type == 'fixed':
                    amount = sc.amount if sc.amount is not None else comp_obj.default_amount
                else:
                    amount = Decimal('0.00')

                earnings_data.append({
                    'code': comp_obj.code,
                    'label': comp_obj.name,
                    'amount': float(amount)
                })
        else:
            earning_components = PayComponent.objects.filter(
                component_type='earning', is_active=True
            ).order_by('display_order', 'code')

            for comp_obj in earning_components:
                emp_override = EmployeePayComponent.objects.filter(
                    email__iexact=email,
                    component=comp_obj
                ).order_by('-id').first()

                if comp_obj.code == 'BASIC_SALARY':
                    amount = base_salary
                elif comp_obj.calc_type == 'percent_of_base':
                    rate = emp_override.rate if (emp_override and emp_override.rate is not None) else comp_obj.rate
                    amount = (base_salary * rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif comp_obj.calc_type == 'fixed':
                    amount = (emp_override.amount if (emp_override and emp_override.amount is not None)
                              else comp_obj.default_amount)
                else:
                    amount = Decimal('0.00')

                earnings_data.append({
                    'code': comp_obj.code,
                    'label': comp_obj.name,
                    'amount': float(amount)
                })

        # Overtime calculation: 1.5x hourly rate based on standard 8-hour workday
        if overtime_hours > 0:
            hourly_rate = (base_salary / Decimal(str(total_period_days * 8))).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            ot_amount = (hourly_rate * Decimal('1.5') * overtime_hours).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            found_ot = False
            for e in earnings_data:
                if e['code'] == 'OVERTIME':
                    e['amount'] = float(ot_amount)
                    found_ot = True
                    break
            if not found_ot:
                earnings_data.append({
                    'code': 'OVERTIME',
                    'label': 'Overtime Pay',
                    'amount': float(ot_amount)
                })

        # ── Build Deductions ──
        deductions_data = []
        gross_without_adjustments = sum(Decimal(str(e['amount'])) for e in earnings_data)

        if salary_structure:
            structure_deductions = SalaryStructureComponent.objects.filter(
                structure=salary_structure,
                component__component_type='deduction',
                component__is_active=True
            ).select_related('component').order_by('display_order', 'id')

            for sc in structure_deductions:
                comp_obj = sc.component
                emp_override = EmployeePayComponent.objects.filter(
                    email__iexact=email,
                    component=comp_obj
                ).order_by('-id').first()

                if comp_obj.code == 'PF':
                    if emp_override and emp_override.amount is not None:
                        amount = emp_override.amount
                    elif sc.rate > 0:
                        amount = (base_salary * sc.rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                    else:
                        amount = (base_salary * Decimal('0.12')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif comp_obj.code == 'ESI':
                    if emp_override and emp_override.amount is not None:
                        amount = emp_override.amount
                    elif gross_without_adjustments <= Decimal('21000.00'):
                        amount = (gross_without_adjustments * Decimal('0.0075')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                    else:
                        amount = Decimal('0.00')
                elif emp_override and emp_override.amount is not None:
                    amount = emp_override.amount
                elif emp_override and emp_override.rate is not None:
                    amount = (base_salary * emp_override.rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif sc.calc_type == 'percent_of_base':
                    amount = (base_salary * sc.rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif sc.calc_type == 'fixed':
                    amount = sc.amount if sc.amount is not None else comp_obj.default_amount
                else:
                    amount = Decimal('0.00')

                deductions_data.append({
                    'code': comp_obj.code,
                    'label': comp_obj.name,
                    'amount': float(amount)
                })
        else:
            deduction_components = PayComponent.objects.filter(
                component_type='deduction', is_active=True
            ).order_by('display_order', 'code')

            for comp_obj in deduction_components:
                emp_override = EmployeePayComponent.objects.filter(
                    email__iexact=email,
                    component=comp_obj
                ).order_by('-id').first()

                if comp_obj.code == 'PF':
                    if emp_override and emp_override.amount is not None:
                        amount = emp_override.amount
                    elif comp_obj.rate > 0:
                        amount = (base_salary * comp_obj.rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                    else:
                        amount = (base_salary * Decimal('0.12')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif comp_obj.code == 'ESI':
                    if emp_override and emp_override.amount is not None:
                        amount = emp_override.amount
                    elif gross_without_adjustments <= Decimal('21000.00'):
                        amount = (gross_without_adjustments * Decimal('0.0075')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                    else:
                        amount = Decimal('0.00')
                elif comp_obj.calc_type == 'percent_of_base':
                    rate = emp_override.rate if (emp_override and emp_override.rate is not None) else comp_obj.rate
                    amount = (base_salary * rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                elif comp_obj.calc_type == 'fixed':
                    amount = (emp_override.amount if (emp_override and emp_override.amount is not None)
                              else comp_obj.default_amount)
                else:
                    amount = Decimal('0.00')

                deductions_data.append({
                    'code': comp_obj.code,
                    'label': comp_obj.name,
                    'amount': float(amount)
                })

        # Loss of Pay (LOP) deduction
        if lop_days > 0:
            daily_rate = (base_salary / Decimal(str(total_period_days))).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            lop_amount = (daily_rate * lop_days).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            found_lop = False
            for d in deductions_data:
                if d['code'] == 'UNPAID_LEAVE_DEDUCTION':
                    d['amount'] = float(lop_amount)
                    found_lop = True
                    break
            if not found_lop:
                deductions_data.append({
                    'code': 'UNPAID_LEAVE_DEDUCTION',
                    'label': 'Loss of Pay (Unpaid Leave)',
                    'amount': float(lop_amount)
                })

        # ── Incorporate Payroll Adjustments ──
        if run_id:
            try:
                from api.models import PayrollAdjustment
                adjs = PayrollAdjustment.objects.filter(run_id=run_id, email__iexact=email)
                for adj in adjs:
                    adj_code = f"ADJ_{adj.id}"
                    adj_amt = float(adj.amount)
                    adj_type = (adj.adjustment_type or '').lower()
                    if adj_type in ['bonus', 'incentive', 'reimbursement', 'allowance', 'arrear']:
                        earnings_data.append({
                            'code': adj_code,
                            'label': adj.description or f"Adjustment ({adj_type.title()})",
                            'amount': adj_amt
                        })
                    elif adj_type in ['deduction', 'loan_recovery', 'penalty', 'tax']:
                        deductions_data.append({
                            'code': adj_code,
                            'label': adj.description or f"Adjustment ({adj_type.title()})",
                            'amount': adj_amt
                        })
            except Exception as e:
                logger.warning(f"Error fetching adjustments for {email}: {e}")

        gross_earnings = sum(Decimal(str(e['amount'])) for e in earnings_data)
        total_deductions = sum(Decimal(str(d['amount'])) for d in deductions_data)
        net_pay = max(Decimal('0.00'), gross_earnings - total_deductions)

        # ── Employer Contributions (CTC calculation) ──
        employer_contributions_data = []

        employer_contributions_data.append({
            'code': 'GROSS_EARNING',
            'label': 'GROSS EARNING',
            'amount': float(gross_earnings),
        })

        # Employer's Provident Fund (12% of Basic or override)
        emp_pf_override = EmployeePayComponent.objects.filter(
            email__iexact=email,
            component__code='EMPLOYER_PF'
        ).first()

        if emp_pf_override and emp_pf_override.amount is not None:
            employer_pf_total = emp_pf_override.amount
        elif base_salary > 0:
            employer_pf_total = (base_salary * Decimal('0.12')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        else:
            employer_pf_total = Decimal('0.00')

        if employer_pf_total == Decimal('1800.00'):
            pension_fund = Decimal('0.00')
            provident_fund = Decimal('1800.00')
        elif employer_pf_total > 0:
            pension_fund = (base_salary * Decimal('0.0833')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            provident_fund = employer_pf_total - pension_fund
        else:
            pension_fund = Decimal('0.00')
            provident_fund = Decimal('0.00')

        employer_contributions_data.append({
            'code': 'EMPLOYER_PF',
            'label': "EMPLOYER'S PROVIDENT FUND",
            'amount': float(employer_pf_total),
            'sub_items': [
                {'label': 'PENSION FUND', 'amount': float(pension_fund)},
                {'label': 'PROVIDENT FUND', 'amount': float(provident_fund)},
            ]
        })

        # Employer's State Insurance (3.25% of gross, if gross <= ₹21,000)
        emp_esi_override = EmployeePayComponent.objects.filter(
            email__iexact=email,
            component__code='EMPLOYER_ESI'
        ).first()

        if emp_esi_override and emp_esi_override.amount is not None:
            employer_esi = emp_esi_override.amount
        elif gross_earnings <= Decimal('21000.00') and gross_earnings > 0:
            employer_esi = (gross_earnings * Decimal('0.0325')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        else:
            employer_esi = Decimal('0.00')

        employer_contributions_data.append({
            'code': 'EMPLOYER_ESI',
            'label': "EMPLOYER'S STATE INSURANCE",
            'amount': float(employer_esi),
        })

        employer_contribution = employer_pf_total + employer_esi
        total_ctc = gross_earnings + employer_contribution

        # ── Employee metadata snapshot ──
        user = AppUser.objects.filter(email__iexact=email).first()
        employee_name = ''
        if user:
            employee_name = user.full_name or getattr(user, 'name', '')

        profile = UserProfile.objects.filter(email__iexact=email).first()
        department = profile.department if profile else ''
        designation = profile.designation if profile else ''
        if not employee_name and profile:
            fn = (profile.first_name or '').strip()
            ln = (profile.last_name or '').strip()
            employee_name = f"{fn} {ln}".strip()
        if not employee_name:
            employee_name = email.split('@')[0].title()

        doj = profile.start_date if profile else None
        emp_id = ''
        if comp:
            emp_id = comp.employee_code or ''
        if not emp_id and profile:
            emp_id = profile.employee_id or ''
        if not emp_id and user:
            emp_id = user.employee_id or ''

        bank_account = comp.bank_account_number if comp else ''
        bank_name = comp.bank_name if comp else ''
        ifsc_code = getattr(comp, 'ifsc_code', '') if comp else ''
        pan_number = comp.pan_number if comp else ''
        uan_number = comp.uan_number if comp else ''
        pf_number = comp.pf_account_number if comp else ''

        result = {
            'email': email,
            'employee_name': employee_name,
            'employee_code': emp_id,
            'department': department,
            'designation': designation,
            'doj': doj,
            'pan_number': pan_number,
            'uan_number': uan_number,
            'pf_account_number': pf_number,
            'bank_account_number': bank_account,
            'bank_name': bank_name,
            'ifsc_code': ifsc_code,
            'month_days': total_period_days,
            'worked_days': float(worked_days),
            'paid_days': float(paid_days),
            'lop_days': float(lop_days),
            'overtime_hours': float(overtime_hours),
            'base_salary': float(base_salary),
            'annual_ctc': float(annual_ctc),
            'gross_earnings': float(gross_earnings),
            'total_deductions': float(total_deductions),
            'net_pay': float(net_pay),
            'employer_contribution': float(employer_contribution),
            'total_ctc': float(total_ctc),
            'currency': currency,
            'earnings_data': earnings_data,
            'deductions_data': deductions_data,
            'employer_contributions_data': employer_contributions_data,
        }
        # Extensions: reimbursements, loan EMIs, regime-based TDS, US withholding
        # (api/payroll_ext). A failing step is logged and skipped.
        from api.payroll_ext import apply_calculation_hooks
        return apply_calculation_hooks(result, email, start_date, end_date, run_id)

    @staticmethod
    def create_pay_run(period_label: str, period_start: date, period_end: date, created_by: str = 'system', period_id: int = None) -> PayrollRun:
        """Create or update a draft pay run for all active staff, preventing duplicate finalized runs."""
        ensure_payroll_tables()

        # Prevent duplicate payroll processing if already approved or paid
        existing_finalized = PayrollRun.objects.filter(
            period_label=period_label,
            status__in=['approved', 'paid']
        ).first()
        if existing_finalized:
            raise ValueError(f"Payroll for period '{period_label}' is already finalized ({existing_finalized.status}). Duplicate processing is prevented.")

        period = None
        if period_id:
            period = PayrollPeriod.objects.filter(id=period_id).first()
        if not period:
            period, _ = PayrollPeriod.objects.get_or_create(
                label=period_label,
                defaults={
                    'start_date': period_start,
                    'end_date': period_end,
                    'status': 'processing',
                    'notes': f'Period for {period_label}'
                }
            )

        run, created = PayrollRun.objects.get_or_create(
            period_label=period_label,
            defaults={
                'period_start': period_start,
                'period_end': period_end,
                'period': period,
                'stage': 4,
                'frequency': 'monthly',
                'status': 'draft',
                'created_by': created_by
            }
        )
        if not run.period:
            run.period = period
            run.save()

        # Active employees
        active_users = AppUser.objects.filter(status='active')
        emails = set(u.email.strip().lower() for u in active_users if u.email)
        comp_emails = set(c.email.strip().lower() for c in EmployeeCompensation.objects.filter(status='active'))
        profile_emails = set(p.email.strip().lower() for p in UserProfile.objects.all() if p.email)
        all_emails = sorted(list(emails.union(comp_emails).union(profile_emails)))

        total_gross = Decimal('0.00')
        total_deductions = Decimal('0.00')
        total_net = Decimal('0.00')
        emp_count = 0

        for email in all_emails:
            calc = PayrollService.calculate_employee_pay(email, period_start, period_end, run_id=run.id)

            # Update or create PayrollEntry
            entry, _ = PayrollEntry.objects.update_or_create(
                run=run,
                email=email,
                defaults={
                    'employee_name': calc['employee_name'],
                    'employee_id': calc.get('employee_code', ''),
                    'department': calc['department'],
                    'designation': calc['designation'],
                    'currency': calc.get('currency', 'INR'),
                    'worked_days': Decimal(str(calc['worked_days'])),
                    'paid_days': Decimal(str(calc['paid_days'])),
                    'lop_days': Decimal(str(calc['lop_days'])),
                    'overtime_hours': Decimal(str(calc['overtime_hours'])),
                    'base_salary': Decimal(str(calc['base_salary'])),
                    'gross_earnings': Decimal(str(calc['gross_earnings'])),
                    'total_deductions': Decimal(str(calc['total_deductions'])),
                    'net_pay': Decimal(str(calc['net_pay'])),
                    'employer_contribution': Decimal(str(calc['employer_contribution'])),
                    'total_ctc': Decimal(str(calc['total_ctc'])),
                    'earnings_data': calc['earnings_data'],
                    'deductions_data': calc['deductions_data'],
                    'employer_data': calc.get('employer_contributions_data', []),
                    'status': 'draft',
                }
            )

            # Update or create Payslip (for PDF generation and compatibility)
            Payslip.objects.update_or_create(
                run=run,
                email=email,
                defaults={
                    'employee_name': calc['employee_name'],
                    'employee_code': calc['employee_code'],
                    'designation': calc['designation'],
                    'doj': calc['doj'],
                    'pan_number': calc['pan_number'],
                    'uan_number': calc['uan_number'],
                    'pf_account_number': calc['pf_account_number'],
                    'bank_account_number': calc['bank_account_number'],
                    'bank_name': calc['bank_name'],
                    'month_days': calc['month_days'],
                    'worked_days': Decimal(str(calc['worked_days'])),
                    'paid_days': Decimal(str(calc['paid_days'])),
                    'lop_days': Decimal(str(calc['lop_days'])),
                    'overtime_hours': Decimal(str(calc['overtime_hours'])),
                    'base_salary': Decimal(str(calc['base_salary'])),
                    'gross_earnings': Decimal(str(calc['gross_earnings'])),
                    'total_deductions': Decimal(str(calc['total_deductions'])),
                    'net_pay': Decimal(str(calc['net_pay'])),
                    'employer_contribution': Decimal(str(calc['employer_contribution'])),
                    'total_ctc': Decimal(str(calc['total_ctc'])),
                    'earnings_data': calc['earnings_data'],
                    'deductions_data': calc['deductions_data'],
                    'employer_contributions_data': calc['employer_contributions_data'],
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
        run.stage = 6  # Review stage
        run.save()

        audit_payroll_action('run_calculated', 'PayrollRun', run.id, created_by, created_by, notes=f'Payroll calculated for {emp_count} employees')
        return run

    @staticmethod
    def approve_pay_run(run_id: int, approved_by: str = 'admin') -> PayrollRun:
        """Approve pay run, lock payslips, and generate PDF payslips."""
        run = PayrollRun.objects.get(id=run_id)
        run.status = 'approved'
        run.stage = 8
        run.approved_by = approved_by
        run.approved_at = timezone.now()
        run.save()

        PayrollEntry.objects.filter(run=run).update(status='approved')

        payslips = Payslip.objects.filter(run=run)
        for payslip in payslips:
            payslip.status = 'approved'
            pdf_b64 = PayrollService.generate_payslip_pdf(payslip)
            payslip.file_data = pdf_b64
            payslip.file_name = f"Payslip_{run.period_label}_{payslip.email.split('@')[0]}.pdf"
            payslip.file_size = len(pdf_b64)
            payslip.save()

        if run.period:
            run.period.status = 'approved'
            run.period.save()

        audit_payroll_action('run_approved', 'PayrollRun', run.id, approved_by, approved_by, notes='Payroll run fully approved and payslips locked')
        return run

    # ── Guided 8-Step Processing Workflow Methods ───────────────────────────

    @staticmethod
    def step_get_or_create_period(label: str, start_date: date, end_date: date, pay_date: date = None, notes: str = '') -> PayrollPeriod:
        """Step 1: Select/configure payroll period."""
        period, _ = PayrollPeriod.objects.get_or_create(
            label=label,
            defaults={
                'start_date': start_date,
                'end_date': end_date,
                'pay_date': pay_date,
                'status': 'draft',
                'notes': notes or f'Payroll period {label}'
            }
        )
        return period

    @staticmethod
    def step_fetch_attendance(period_start: date, period_end: date) -> list:
        """Step 2 & 3: Fetch attendance, paid days, LOP, and overtime for all active employees."""
        active_users = AppUser.objects.filter(status='active')
        emails = set(u.email.strip().lower() for u in active_users if u.email)
        comp_emails = set(c.email.strip().lower() for c in EmployeeCompensation.objects.filter(status='active'))
        profile_emails = set(p.email.strip().lower() for p in UserProfile.objects.all() if p.email)
        all_emails = sorted(list(emails.union(comp_emails).union(profile_emails)))

        summary_list = []
        total_period_days = (period_end - period_start).days + 1

        for email in all_emails:
            attendances = EmployeeAttendance.objects.filter(
                email__iexact=email,
                date__gte=period_start,
                date__lte=period_end
            )
            present_days = attendances.filter(status='present').count()
            late_days = attendances.filter(status='late').count()
            half_days = attendances.filter(status='half-day').count()
            worked_days = float(present_days + late_days) + (0.5 * half_days)

            tot_mins = attendances.aggregate(t=Sum('overtime_minutes'))['t'] or 0
            ot_hours = round(tot_mins / 60.0, 2)

            wfh = WfhRequest.objects.filter(
                email__iexact=email, status='Approved',
                from_date__lte=period_end, to_date__gte=period_start
            ).count()

            leaves = LeaveRequest.objects.filter(
                email__iexact=email, status='Approved',
                from_date__lte=period_end, to_date__gte=period_start
            ).exclude(Q(type__iexact='lop') | Q(type__iexact='loss of pay') | Q(type__iexact='unpaid')).count()

            unpaid = LeaveRequest.objects.filter(
                email__iexact=email, status='Approved',
                from_date__lte=period_end, to_date__gte=period_start
            ).filter(Q(type__iexact='lop') | Q(type__iexact='loss of pay') | Q(type__iexact='unpaid')).count()

            # Holiday calendars: own regional holidays not worked are paid, never LOP.
            from api.attendance_ext.holidays import count_off_days
            holiday_off = count_off_days(email, period_start, period_end, skip=attendances.filter(status__in=('present', 'late', 'half-day')).values_list('date', flat=True))
            if attendances.exists():
                paid_days = min(float(total_period_days), worked_days + wfh + leaves + holiday_off)
                lop_days = max(0.0, float(total_period_days) - paid_days)
            else:
                lop_days = float(unpaid)
                paid_days = max(0.0, float(total_period_days) - lop_days)
                worked_days = paid_days

            profile = UserProfile.objects.filter(email__iexact=email).first()
            emp_name = ''
            dept = ''
            desig = ''
            if profile:
                emp_name = f"{profile.first_name} {profile.last_name}".strip()
                dept = profile.department or ''
                desig = profile.designation or ''
            if not emp_name:
                u = AppUser.objects.filter(email__iexact=email).first()
                emp_name = (u.full_name if u else '') or email.split('@')[0].title()

            summary_list.append({
                'email': email,
                'employee_name': emp_name,
                'department': dept,
                'designation': desig,
                'total_days': total_period_days,
                'present_days': present_days,
                'half_days': half_days,
                'wfh_days': wfh,
                'leave_days': leaves,
                'worked_days': worked_days,
                'paid_days': paid_days,
                'lop_days': lop_days,
                'overtime_hours': ot_hours,
            })
        return summary_list

    @staticmethod
    def step_validate_payroll(run_id: int) -> dict:
        """Step 5: Validate payroll run for missing bank info, negative net pay, unusual LOP."""
        run = PayrollRun.objects.get(id=run_id)
        entries = PayrollEntry.objects.filter(run=run)

        checks = []
        blocking_errors = 0
        warnings = 0

        for entry in entries:
            email = entry.email
            comp = EmployeeCompensation.objects.filter(email__iexact=email).order_by('-id').first()

            # 1. Missing bank account or IFSC
            bank_acc = getattr(comp, 'bank_account_number', '') if comp else ''
            ifsc = getattr(comp, 'ifsc_code', '') if comp else ''
            if not bank_acc:
                checks.append({
                    'type': 'error',
                    'email': email,
                    'employee_name': entry.employee_name,
                    'message': 'Missing Bank Account Number in employee profile'
                })
                blocking_errors += 1
            if not ifsc:
                checks.append({
                    'type': 'warning',
                    'email': email,
                    'employee_name': entry.employee_name,
                    'message': 'Missing Bank IFSC Code'
                })
                warnings += 1

            # 2. Negative Net Pay
            if entry.net_pay <= Decimal('0.00'):
                checks.append({
                    'type': 'error',
                    'email': email,
                    'employee_name': entry.employee_name,
                    'message': f"Calculated Net Pay is zero or negative (₹{entry.net_pay:.2f})"
                })
                blocking_errors += 1

            # 3. High LOP (> 15 days)
            if entry.lop_days > Decimal('15.00'):
                checks.append({
                    'type': 'warning',
                    'email': email,
                    'employee_name': entry.employee_name,
                    'message': f"High Loss of Pay ({entry.lop_days} days)"
                })
                warnings += 1

            # 4. Missing PAN / PF UAN
            pan = getattr(comp, 'pan_number', '') if comp else ''
            if not pan:
                checks.append({
                    'type': 'warning',
                    'email': email,
                    'employee_name': entry.employee_name,
                    'message': 'Missing PAN Number'
                })
                warnings += 1

        is_valid = (blocking_errors == 0)
        return {
            'is_valid': is_valid,
            'blocking_count': blocking_errors,
            'warning_count': warnings,
            'total_entries': entries.count(),
            'checks': checks,
        }

    @staticmethod
    def step_submit_approval(run_id: int, submitted_by: str, comments: str = '') -> PayrollRun:
        """Step 7: Submit payroll run for multi-level approval pipeline."""
        run = PayrollRun.objects.get(id=run_id)
        run.stage = 7
        run.status = 'pending_approval'
        run.notes = f"Submitted for approval by {submitted_by}. {comments}".strip()
        run.save()

        PayrollApproval.objects.create(
            run=run,
            level='payroll_executive',
            role_name='Payroll Executive',
            approver_name=submitted_by,
            action='submitted',
            comments=comments or 'Submitted payroll for approval workflow'
        )

        audit_payroll_action('run_submitted_for_approval', 'PayrollRun', run.id, submitted_by, submitted_by, notes=comments)
        return run

    @staticmethod
    def step_process_approval(run_id: int, level: str, action: str, approver_email: str, approver_name: str, comments: str = '') -> PayrollRun:
        """Step 8: Approve, Reject, or Request Corrections at configurable approval levels."""
        run = PayrollRun.objects.get(id=run_id)
        role_label = level.replace('_', ' ').title()

        if action in ['approve', 'approved']:
            norm_action = 'approved'
        elif action in ['reject', 'rejected']:
            norm_action = 'rejected'
        elif action in ['request_corrections', 'corrections_requested']:
            norm_action = 'corrections_requested'
        else:
            norm_action = action

        PayrollApproval.objects.create(
            run=run,
            level=level,
            role_name=role_label,
            approver_email=approver_email,
            approver_name=approver_name,
            action=norm_action,
            comments=comments or f"Action {norm_action} taken by {role_label}"
        )

        if norm_action == 'approved':
            if level in ['finance_manager', 'super_admin'] or run.approvals.filter(action='approved').count() >= 3:
                # Final sign-off
                run = PayrollService.approve_pay_run(run.id, approved_by=approver_name)
            else:
                next_stage = {
                    'payroll_executive': 'HR Manager',
                    'hr_manager': 'Finance Manager',
                }.get(level, 'Super Admin')
                run.notes = f"Approved at {role_label} level. Pending {next_stage} approval."
                run.save()

        elif norm_action == 'rejected':
            run.status = 'rejected'
            run.notes = f"Rejected at {role_label} level: {comments}"
            run.save()

        elif norm_action == 'corrections_requested':
            run.status = 'needs_correction'
            run.stage = 6  # Revert to review stage
            run.notes = f"Corrections requested by {role_label}: {comments}"
            run.save()

        audit_payroll_action(f"run_{norm_action}", 'PayrollRun', run.id, approver_email, approver_name, notes=comments)
        return run

    # ── Payment Disbursal Engine ─────────────────────────────────────────────

    @staticmethod
    def create_payment_batch(run_id: int, payment_method: str = 'bank_transfer') -> dict:
        """Initialize payment batch records for all approved entries in a run."""
        run = PayrollRun.objects.get(id=run_id)
        entries = PayrollEntry.objects.filter(run=run, net_pay__gt=0)
        created_count = 0

        for entry in entries:
            comp = EmployeeCompensation.objects.filter(email__iexact=entry.email).order_by('-id').first()
            bank_acc = getattr(comp, 'bank_account_number', '') if comp else ''
            ifsc = getattr(comp, 'ifsc_code', '') if comp else ''

            pm, created = PayrollPayment.objects.get_or_create(
                run=run,
                entry=entry,
                defaults={
                    'email': entry.email,
                    'employee_name': entry.employee_name,
                    'amount': entry.net_pay,
                    'currency': 'INR',
                    'payment_method': payment_method,
                    'bank_name': getattr(comp, 'bank_name', '') if comp else '',
                    'account_number': bank_acc,
                    'ifsc_or_routing': ifsc,
                    'status': 'pending',
                }
            )
            if created:
                created_count += 1

        total_amount = float(PayrollPayment.objects.filter(run=run).aggregate(s=Sum('amount'))['s'] or 0.0)
        return {
            'run_id': run.id,
            'period_label': run.period_label,
            'total_payments': PayrollPayment.objects.filter(run=run).count(),
            'newly_created': created_count,
            'total_amount': total_amount,
        }

    @staticmethod
    def disburse_payments(payment_ids: list, reference_prefix: str = 'PAY', disbursed_by: str = 'Finance Manager') -> dict:
        """Mark payments successful, generate reference numbers, and update entry status."""
        success_count = 0
        now = timezone.now()
        date_str = now.strftime('%Y%m%d')

        payments = PayrollPayment.objects.filter(id__in=payment_ids)
        for pm in payments:
            ref_no = f"{reference_prefix}-{date_str}-{pm.id:04d}"
            pm.status = 'successful'
            pm.reference_number = ref_no
            pm.disbursed_at = now
            pm.disbursed_by = disbursed_by
            pm.save()

            if pm.entry:
                pm.entry.payment_status = 'paid'
                pm.entry.payment_reference = ref_no
                pm.entry.save()
            success_count += 1

        # Check if all payments for the run are disbursed
        if payments.exists():
            run = payments.first().run
            if not PayrollPayment.objects.filter(run=run, status__in=['pending', 'processing']).exists():
                run.status = 'paid'
                run.save()
                if run.period:
                    run.period.status = 'completed'
                    run.period.save()

        audit_payroll_action('payments_disbursed', 'PayrollPayment', f"{success_count}_records", actor_name=disbursed_by, notes=f'Disbursed {success_count} payments')
        return {'disbursed_count': success_count}

    @staticmethod
    def mark_payment_failed(payment_id: int, failure_reason: str, updated_by: str = 'Finance Manager') -> PayrollPayment:
        """Record payment transaction failure with reason."""
        pm = PayrollPayment.objects.get(id=payment_id)
        pm.status = 'failed'
        pm.failure_reason = failure_reason
        pm.save()

        if pm.entry:
            pm.entry.payment_status = 'failed'
            pm.entry.save()

        audit_payroll_action('payment_failed', 'PayrollPayment', pm.id, actor_name=updated_by, notes=failure_reason)
        return pm

    @staticmethod
    def export_bank_neft_csv(run_id: int) -> str:
        """Export NEFT / RTGS / Direct Deposit CSV file."""
        run = PayrollRun.objects.get(id=run_id)
        entries = PayrollEntry.objects.filter(run=run)

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            'Beneficiary Name', 'Bank Name', 'Account Number', 'IFSC Code',
            'Amount (INR)', 'Payment Reference', 'Payment Status', 'Email'
        ])

        from api.fields import plain as _plain   # bank file: real values, decrypted server-side
        for entry in entries:
            comp = EmployeeCompensation.objects.filter(email__iexact=entry.email).order_by('-id').first()
            writer.writerow([
                entry.employee_name,
                getattr(comp, 'bank_name', '') if comp else '',
                _plain(getattr(comp, 'bank_account_number', '')) if comp else '',
                getattr(comp, 'ifsc_code', '') if comp else '',
                f"{entry.net_pay:.2f}",
                entry.payment_reference or f"RUN-{run.period_label}",
                entry.payment_status,
                entry.email
            ])

        return output.getvalue()

    # ── Payroll Reports Engine ───────────────────────────────────────────────

    @staticmethod
    def get_monthly_payroll_report(year: int, month: int) -> dict:
        """Monthly consolidated payroll report."""
        label_prefix = f"{year:04d}-{month:02d}"
        runs = PayrollRun.objects.filter(period_label__startswith=label_prefix)

        gross = float(runs.aggregate(s=Sum('total_gross'))['s'] or 0.0)
        net = float(runs.aggregate(s=Sum('total_net'))['s'] or 0.0)
        deductions = float(runs.aggregate(s=Sum('total_deductions'))['s'] or 0.0)
        employees = runs.aggregate(s=Sum('employee_count'))['s'] or 0

        return {
            'year': year,
            'month': month,
            'period_label': label_prefix,
            'runs_count': runs.count(),
            'total_gross': gross,
            'total_net': net,
            'total_deductions': deductions,
            'total_employees': employees,
        }

    @staticmethod
    def get_department_payroll_report(run_id: int) -> list:
        """Department-wise gross, net, and headcount breakdown."""
        run = PayrollRun.objects.get(id=run_id)
        entries = PayrollEntry.objects.filter(run=run)

        dept_map = {}
        for entry in entries:
            dept = entry.department or 'General'
            if dept not in dept_map:
                dept_map[dept] = {
                    'department': dept,
                    'headcount': 0,
                    'gross_salary': Decimal('0.00'),
                    'total_deductions': Decimal('0.00'),
                    'net_salary': Decimal('0.00'),
                }
            dept_map[dept]['headcount'] += 1
            dept_map[dept]['gross_salary'] += entry.gross_earnings
            dept_map[dept]['total_deductions'] += entry.total_deductions
            dept_map[dept]['net_salary'] += entry.net_pay

        results = []
        for d in dept_map.values():
            results.append({
                'department': d['department'],
                'headcount': d['headcount'],
                'gross_salary': float(d['gross_salary']),
                'total_deductions': float(d['total_deductions']),
                'net_salary': float(d['net_salary']),
            })
        return sorted(results, key=lambda x: x['gross_salary'], reverse=True)

    @staticmethod
    def get_statutory_tax_report(run_id: int) -> dict:
        """PF, ESI, Professional Tax, and TDS breakdown for compliance reporting."""
        run = PayrollRun.objects.get(id=run_id)
        entries = PayrollEntry.objects.filter(run=run)

        total_pf = Decimal('0.00')
        total_esi = Decimal('0.00')
        total_pt = Decimal('0.00')
        total_tds = Decimal('0.00')
        total_employer_pf = Decimal('0.00')
        total_employer_esi = Decimal('0.00')

        items = []
        for e in entries:
            epf = Decimal('0.00')
            eesi = Decimal('0.00')
            ept = Decimal('0.00')
            etds = Decimal('0.00')

            for d in (e.deductions_data or []):
                code = d.get('code', '')
                amt = Decimal(str(d.get('amount', 0)))
                if code == 'PF':
                    epf += amt
                elif code == 'ESI':
                    eesi += amt
                elif code == 'PROFESSIONAL_TAX':
                    ept += amt
                elif code == 'TDS':
                    etds += amt

            total_pf += epf
            total_esi += eesi
            total_pt += ept
            total_tds += etds

            items.append({
                'email': e.email,
                'name': e.employee_name,
                'department': e.department,
                'gross': float(e.gross_earnings),
                'pf': float(epf),
                'esi': float(eesi),
                'pt': float(ept),
                'tds': float(etds),
            })

        return {
            'run_id': run.id,
            'period_label': run.period_label,
            'total_pf': float(total_pf),
            'total_esi': float(total_esi),
            'total_pt': float(total_pt),
            'total_tds': float(total_tds),
            'employees': items,
        }

    @staticmethod
    def get_dashboard_metrics() -> dict:
        """Aggregated KPIs for the main Payroll Dashboard."""
        ensure_payroll_tables()

        active_comps = EmployeeCompensation.objects.filter(status='active')
        total_employees = active_comps.count()
        if total_employees == 0:
            total_employees = AppUser.objects.filter(status='active').count()

        latest_run = PayrollRun.objects.order_by('-period_start', '-id').first()
        gross = float(latest_run.total_gross) if latest_run else 0.0
        net = float(latest_run.total_net) if latest_run else 0.0
        deductions = float(latest_run.total_deductions) if latest_run else 0.0

        pending_runs = PayrollRun.objects.filter(status__in=['draft', 'processing', 'needs_correction']).count()
        processed_runs = PayrollRun.objects.filter(status__in=['approved', 'paid']).count()
        pending_approvals = PayrollRun.objects.filter(status='pending_approval').count()

        # Monthly trends (last 6 runs)
        recent_runs_qs = PayrollRun.objects.order_by('-period_start')[:6]
        trends = []
        for r in reversed(list(recent_runs_qs)):
            trends.append({
                'label': r.period_label,
                'gross': float(r.total_gross),
                'net': float(r.total_net),
                'deductions': float(r.total_deductions),
            })

        # Department distribution from latest run
        dept_dist = []
        if latest_run:
            dept_dist = PayrollService.get_department_payroll_report(latest_run.id)

        # Top recent runs
        runs_summary = []
        for r in PayrollRun.objects.order_by('-id')[:5]:
            runs_summary.append({
                'id': r.id,
                'period_label': r.period_label,
                'status': r.status,
                'stage': r.stage,
                'total_net': float(r.total_net),
                'employee_count': r.employee_count,
                'created_at': r.created_at.strftime('%Y-%m-%d') if r.created_at else '',
            })

        return {
            'total_employees': total_employees,
            'total_gross': gross,
            'total_net': net,
            'total_deductions': deductions,
            'pending_payroll_runs': pending_runs,
            'processed_payroll_runs': processed_runs,
            'pending_approvals': pending_approvals,
            'monthly_trends': trends,
            'department_distribution': dept_dist,
            'recent_runs': runs_summary,
        }

    @staticmethod
    def _format_amount(val, show_dash=True):
        """Format amount for display: show '-' for zero amounts if show_dash=True."""
        val = Decimal(str(val))
        if val == 0 and show_dash:
            return '-'
        return f'{val:,.2f}'

    @staticmethod
    def _get_month_name(period_label):
        """Convert '2026-06' to 'June-2026'."""
        try:
            parts = period_label.split('-')
            dt = date(int(parts[0]), int(parts[1]), 1)
            return dt.strftime('%B-%Y')
        except Exception:
            return period_label

    @staticmethod
    def generate_payslip_pdf(payslip: Payslip) -> str:
        """Generate HTML payslip matching the exact Eversoft Indian payslip reference layout."""
        import os
        from django.conf import settings
        from api.fields import plain as _plain
        # The payslip document legitimately carries the full identifiers. They
        # are decrypted here, server-side; a missing key raises
        # SecretsNotConfigured instead of printing ciphertext on the payslip.
        _ids = {f: _plain(getattr(payslip, f, '')) for f in
                ('pan_number', 'bank_account_number', 'pf_account_number', 'uan_number')}

        # Company details
        company = CompanyDetail.objects.first()
        company_name = company.company_name.upper() if (company and company.company_name) else 'EVERSOFT TECHNOLOGIES PRIVATE LIMITED'
        company_address_lines = [
            'UNIT NO:1012, 10th FLOOR, MANJEERA TRINITY CORPORATE',
            'BESIDE LULU HYPER MARKET, KPHB, PHASE-III, HYDERABAD-500072'
        ]
        if company and (company.address_line1 or company.address_line2):
            parts = [p.strip() for p in [company.address_line1, company.address_line2] if p and p.strip()]
            city_line = ', '.join([p.strip() for p in [company.city, company.state, company.pincode] if p and p.strip()])
            if city_line:
                parts.append(city_line)
            if parts:
                company_address_lines = parts

        company_address_html = '<br>'.join(company_address_lines)

        # Company Logo (dist/dist/logo.jpg or CompanyDetail fallback)
        logo_b64 = ''
        logo_path = os.path.join(settings.BASE_DIR, 'dist', 'dist', 'logo.jpg')
        if os.path.exists(logo_path):
            try:
                with open(logo_path, 'rb') as f:
                    logo_b64 = base64.b64encode(f.read()).decode('utf-8')
            except Exception:
                pass
        if not logo_b64 and company and company.company_logo:
            logo_b64 = company.company_logo.replace('data:image/jpeg;base64,', '').replace('data:image/png;base64,', '')

        period_label = payslip.run.period_label
        month_name = PayrollService._get_month_name(period_label)
        # Dates follow the company setting (MM/DD/YYYY by default).
        from api.timeutil import company_date, company_date_format
        _fmt = company_date_format()
        period_start = company_date(payslip.run.period_start, _fmt)
        period_end = company_date(payslip.run.period_end, _fmt)
        doj_str = company_date(payslip.doj, _fmt)

        month_days = int(payslip.month_days) if payslip.month_days else 30
        net_paid_days = int(float(payslip.paid_days))
        lwp_days = int(float(payslip.lop_days))

        # Build Earnings & Deductions side-by-side rows
        earnings = payslip.earnings_data or []
        deductions = payslip.deductions_data or []
        max_rows = max(len(earnings), len(deductions), 7)

        combined_rows = ''
        for i in range(max_rows):
            e_label = earnings[i]['label'].upper() if i < len(earnings) else ''
            e_amount = PayrollService._format_amount(earnings[i]['amount']) if i < len(earnings) else ''
            d_label = deductions[i]['label'].upper() if i < len(deductions) else ''
            d_amount = PayrollService._format_amount(deductions[i]['amount']) if i < len(deductions) else ''

            combined_rows += f'''
            <tr>
                <td style="padding: 2.5px 7px; border-right: 1px solid #000; font-size: 11.5px; height: 18px;">{e_label}</td>
                <td style="padding: 2.5px 7px; text-align: right; border-right: 1.5px solid #000; font-size: 11.5px;">{e_amount}</td>
                <td style="padding: 2.5px 7px; border-right: 1px solid #000; font-size: 11.5px;">{d_label}</td>
                <td style="padding: 2.5px 7px; text-align: right; font-size: 11.5px;">{d_amount}</td>
            </tr>'''

        total_earnings_str = PayrollService._format_amount(payslip.gross_earnings, show_dash=False)
        total_deductions_str = PayrollService._format_amount(payslip.total_deductions, show_dash=False)

        net_pay_val = float(payslip.net_pay)
        net_pay_display = f"{int(net_pay_val)}" if net_pay_val == int(net_pay_val) else f"{net_pay_val:,.2f}"
        net_pay_words = amount_to_words_inr(net_pay_val)

        # Employer CTC Breakdown
        total_ctc_val = float(payslip.total_ctc)
        total_ctc_display = f"{int(total_ctc_val)}" if total_ctc_val == int(total_ctc_val) else f"{total_ctc_val:,.2f}"
        total_ctc_str = PayrollService._format_amount(payslip.total_ctc, show_dash=False)
        total_ctc_words = amount_to_words_inr(total_ctc_val)
        gross_str = PayrollService._format_amount(payslip.gross_earnings, show_dash=False)

        employer_data = payslip.employer_contributions_data or []
        emp_pf_item = next((item for item in employer_data if item.get('code') == 'EMPLOYER_PF'), None)
        emp_esi_item = next((item for item in employer_data if item.get('code') == 'EMPLOYER_ESI'), None)

        pf_amount = emp_pf_item.get('amount', 0) if emp_pf_item else 0
        emp_pf_str = PayrollService._format_amount(pf_amount) if pf_amount > 0 else '-'

        sub_items = emp_pf_item.get('sub_items', []) if emp_pf_item else []
        pension_val = 0
        provident_val = pf_amount
        for sub in sub_items:
            if 'PENSION' in sub.get('label', '').upper():
                pension_val = sub.get('amount', 0)
            elif 'PROVIDENT' in sub.get('label', '').upper():
                provident_val = sub.get('amount', 0)

        pension_str = PayrollService._format_amount(pension_val) if pension_val > 0 else '-'
        provident_sub_str = PayrollService._format_amount(provident_val) if provident_val > 0 else '-'

        esi_amount = emp_esi_item.get('amount', 0) if emp_esi_item else 0
        emp_esi_str = PayrollService._format_amount(esi_amount) if esi_amount > 0 else 'Nil'

        html_content = f'''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Pay Slip - {payslip.employee_name} ({month_name})</title>
<style>
    @page {{
        margin: 12mm 15mm 12mm 15mm;
        size: A4 portrait;
    }}
    * {{
        box-sizing: border-box;
    }}
    body {{
        font-family: Arial, Helvetica, sans-serif;
        margin: 0;
        padding: 20px 25px;
        color: #000;
        font-size: 11.5px;
        background-color: #fff;
        -webkit-print-color-adjust: exact;
    }}
    .payslip-wrapper {{
        max-width: 780px;
        margin: 0 auto;
    }}
    .header-table {{
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 20px;
    }}
    .header-table td {{
        vertical-align: middle;
    }}
    .company-title {{
        font-size: 14px;
        font-weight: bold;
        color: #000;
        margin-bottom: 2px;
        letter-spacing: 0.3px;
    }}
    .company-sub {{
        font-size: 11px;
        font-weight: bold;
        color: #000;
        margin-bottom: 2px;
        line-height: 1.35;
    }}
    .period-title {{
        font-size: 14px;
        font-weight: bold;
        color: #000;
        margin-top: 5px;
        margin-bottom: 2px;
    }}
    .period-range {{
        font-size: 13.5px;
        font-weight: bold;
        color: #000;
    }}
    
    /* Boxed Tables */
    .boxed-table {{
        width: 100%;
        border: 1.5px solid #000;
        border-collapse: collapse;
        margin-bottom: 16px;
        font-size: 11.5px;
        background-color: #fff;
    }}
    .boxed-table td, .boxed-table th {{
        color: #000;
    }}
</style>
</head>
<body>
<div class="payslip-wrapper">

    <!-- ═══ HEADER (Unbordered) ═══ -->
    <table class="header-table">
        <tr>
            <td style="width: 130px; text-align: left; vertical-align: middle;">
                <div style="display: inline-block; text-align: center;">
                    {f'<img src="data:image/jpeg;base64,{logo_b64}" style="width: 72px; height: auto; display: block; margin: 0 auto 3px auto;" />' if logo_b64 else ''}
                    <div style="font-size: 11px; font-weight: bold; color: #0d6368; letter-spacing: 0.5px; font-family: Arial, sans-serif;">EVERSOFT</div>
                    <div style="font-size: 6px; font-weight: bold; color: #111; letter-spacing: 0.2px; font-family: Arial, sans-serif; white-space: nowrap;">TECHNOLOGIES PRIVATE LIMITED</div>
                </div>
            </td>
            <td style="text-align: center; vertical-align: middle;">
                <div class="company-title">{company_name}</div>
                <div class="company-sub">{company_address_html}</div>
                <div class="period-title">Pay Slip For the Month of {month_name}</div>
                <div class="period-range">(From {period_start} To {period_end})</div>
            </td>
            <td style="width: 130px;"></td>
        </tr>
    </table>

    <!-- ═══ TABLE 1: EMPLOYEE DETAILS & DAYS ═══ -->
    <table class="boxed-table">
        <tr>
            <td style="width: 125px; padding: 3px 6px;">Employee Name</td>
            <td style="width: 10px; padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.employee_name.upper()}</td>
            <td style="width: 125px; padding: 3px 6px;">Employee Code</td>
            <td style="width: 10px; padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.employee_code}</td>
        </tr>
        <tr>
            <td style="padding: 3px 6px;">DOJ</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{doj_str}</td>
            <td style="padding: 3px 6px;">PAN</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{_ids['pan_number']}</td>
        </tr>
        <tr>
            <td style="padding: 3px 6px;">Bank A/c No.</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{_ids['bank_account_number']}</td>
            <td style="padding: 3px 6px;">PF A/c No.</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{_ids['pf_account_number']}</td>
        </tr>
        <tr>
            <td style="padding: 3px 6px;">Designation</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.designation.upper() if payslip.designation else ''}</td>
            <td style="padding: 3px 6px;">Bank Name</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.bank_name}</td>
        </tr>
        <tr>
            <td style="padding: 3px 6px;">UAN</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{_ids['uan_number']}</td>
            <td colspan="3"></td>
        </tr>
        <!-- Horizontal Divider -->
        <tr>
            <td colspan="6" style="border-top: 1.5px solid #000; padding: 0;"></td>
        </tr>
        <!-- Days Section -->
        <tr>
            <td style="padding: 3px 6px;">Month Days</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 30px; font-weight: bold;">{month_days}</td>
            <td style="padding: 3px 6px; border-left: 1.5px solid #000;">LWP</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 30px; font-weight: bold;">{lwp_days}</td>
        </tr>
        <tr>
            <td style="padding: 3px 6px;">Net Paid Days</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 30px; font-weight: bold;">{net_paid_days}</td>
            <td colspan="3" style="border-left: 1.5px solid #000;"></td>
        </tr>
    </table>

    <!-- ═══ TABLE 2: EARNINGS & DEDUCTIONS ═══ -->
    <table class="boxed-table">
        <tr>
            <th style="width: 35%; padding: 4px 7px; border: 1px solid #000; text-align: left; font-weight: bold; background-color: #fff;">Earnings</th>
            <th style="width: 15%; padding: 4px 7px; border: 1px solid #000; text-align: right; font-weight: bold; background-color: #fff;">Amount Rs.</th>
            <th style="width: 35%; padding: 4px 7px; border: 1px solid #000; text-align: left; font-weight: bold; background-color: #fff;">Deductions</th>
            <th style="width: 15%; padding: 4px 7px; border: 1px solid #000; text-align: right; font-weight: bold; background-color: #fff;">Amount Rs.</th>
        </tr>
        {combined_rows}
        <tr style="border-top: 1.5px solid #000; border-bottom: 1.5px solid #000;">
            <td style="padding: 4px 7px; font-weight: bold; border-right: 1px solid #000;">Total Earnings</td>
            <td style="padding: 4px 7px; font-weight: bold; text-align: right; border-right: 1.5px solid #000;">{total_earnings_str}</td>
            <td style="padding: 4px 7px; font-weight: bold; border-right: 1px solid #000;">Total Deductions</td>
            <td style="padding: 4px 7px; font-weight: bold; text-align: right;">{total_deductions_str}</td>
        </tr>
        <tr>
            <td colspan="4" style="padding: 4px 7px 2px 7px; font-weight: bold;">
                <span style="display: inline-block; width: 95px;">Net Pay</span>
                <span style="display: inline-block; width: 12px; text-align: center;">:</span>
                <span>Rs. {net_pay_display}</span>
            </td>
        </tr>
        <tr>
            <td colspan="4" style="padding: 2px 7px 5px 7px; font-weight: bold;">
                <span style="display: inline-block; width: 95px;">In Words</span>
                <span style="display: inline-block; width: 12px; text-align: center;">:</span>
                <span>{net_pay_words}</span>
            </td>
        </tr>
    </table>

    <!-- ═══ TABLE 3: EMPLOYER'S CONTRIBUTION (CTC) ═══ -->
    <table class="boxed-table">
        <tr>
            <th colspan="3" style="text-align: left; font-weight: bold; border-bottom: 1.5px solid #000; padding: 4px 7px; background-color: #fff;">
                Employer's Contribution(CTC)
            </th>
        </tr>
        <tr>
            <td colspan="2" style="width: 85%; padding: 3px 7px;">GROSS EARNING</td>
            <td style="width: 15%; padding: 3px 7px; text-align: right; border-left: 1.5px solid #000;">{gross_str}</td>
        </tr>
        <tr>
            <td colspan="2" style="padding: 3px 7px;">EMPLOYER'S PROVIDENT FUND</td>
            <td style="padding: 3px 7px; text-align: right; border-left: 1.5px solid #000;">{emp_pf_str}</td>
        </tr>
        <tr>
            <td colspan="2" style="padding: 3px 7px 3px 35px;">PENSION FUND</td>
            <td style="padding: 3px 7px; text-align: right; border-left: 1.5px solid #000;">{pension_str}</td>
        </tr>
        <tr>
            <td style="padding: 3px 7px 3px 35px; width: 65%;">PROVIDENT FUND</td>
            <td style="padding: 3px 7px; text-align: right; width: 20%;">{provident_sub_str}</td>
            <td style="border-left: 1.5px solid #000;">&nbsp;</td>
        </tr>
        <tr>
            <td colspan="2" style="padding: 3px 7px;">EMPLOYER'S STATE INSURANCE</td>
            <td style="padding: 3px 7px; text-align: right; border-left: 1.5px solid #000;">{emp_esi_str}</td>
        </tr>
        <tr style="border-top: 1.5px solid #000; border-bottom: 1.5px solid #000;">
            <td colspan="2" style="padding: 4px 7px; text-align: right; font-weight: bold; padding-right: 12px;">Total :</td>
            <td style="padding: 4px 7px; text-align: right; font-weight: bold; border-left: 1.5px solid #000;">{total_ctc_str}</td>
        </tr>
        <tr>
            <td colspan="3" style="padding: 4px 7px 2px 7px; font-weight: bold;">
                <span style="display: inline-block; width: 95px;">Total CTC</span>
                <span style="display: inline-block; width: 12px; text-align: center;">:</span>
                <span>Rs. {total_ctc_display}</span>
            </td>
        </tr>
        <tr>
            <td colspan="3" style="padding: 2px 7px 5px 7px; font-weight: bold;">
                <span style="display: inline-block; width: 95px;">In Words</span>
                <span style="display: inline-block; width: 12px; text-align: center;">:</span>
                <span>{total_ctc_words}</span>
            </td>
        </tr>
        <tr>
            <td colspan="3" style="border-top: 1.5px solid #000; text-align: center; font-weight: bold; padding: 5px 7px;">
                This is Computer Generated Sheet, does not require Signature.
            </td>
        </tr>
    </table>

</div>
</body>
</html>'''
        return base64.b64encode(html_content.encode('utf-8')).decode('utf-8')

    @staticmethod
    def export_bank_nacha_csv(run_id: int) -> str:
        """Export bank payout CSV format for direct deposit batch processing."""
        run = PayrollRun.objects.get(id=run_id)
        payslips = Payslip.objects.filter(run=run)

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            'Employee Name', 'Employee Code', 'Employee Email',
            'Bank Name', 'Account Number', 'PAN',
            'Net Pay (INR)', 'Status'
        ])

        from api.fields import plain as _plain   # bank file: real values, decrypted server-side
        for p in payslips:
            writer.writerow([
                p.employee_name,
                p.employee_code,
                p.email,
                p.bank_name,
                _plain(p.bank_account_number),
                _plain(p.pan_number),
                f"{p.net_pay:.2f}",
                p.status
            ])

        return output.getvalue()
