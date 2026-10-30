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
    EmployeeAttendance, LeaveRequest, WfhRequest,
    EmployeeCompensation, PayComponent, EmployeePayComponent,
    PayrollRun, Payslip, PayrollSetting, PayrollInformation
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

def seed_default_pay_components():
    """Seed standard Indian earnings & deductions pay components if catalogue is empty."""
    try:
        from api.models import PayComponent
        if PayComponent.objects.exists():
            return

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
                'name': 'HRA',
                'component_type': 'earning',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.5000'),   # 50% of Basic
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 2,
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
                'display_order': 3,
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
                'display_order': 4,
            },
            {
                'code': 'LTA',
                'name': 'LTA',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 5,
            },
            {
                'code': 'SPECIAL_ALLOWANCE',
                'name': 'Special Allowance',
                'component_type': 'earning',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': True,
                'is_active': True,
                'display_order': 6,
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
                'display_order': 7,
            },

            # ── Deductions ──
            {
                'code': 'PF',
                'name': 'PF',
                'component_type': 'deduction',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.1200'),   # 12% of Basic (employee share)
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 1,
            },
            {
                'code': 'PROFESSIONAL_TAX',
                'name': 'Professional Tax',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('150.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 2,
            },
            {
                'code': 'ESI',
                'name': 'ESI',
                'component_type': 'deduction',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.0075'),   # 0.75% of gross (employee share)
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 3,
            },
            {
                'code': 'TDS',
                'name': 'TDS',
                'component_type': 'deduction',
                'calc_type': 'fixed',
                'rate': Decimal('0.0000'),
                'default_amount': Decimal('0.00'),
                'is_taxable': False,
                'is_active': True,
                'display_order': 4,
            },

            # ── Employer Contributions (not deducted from employee) ──
            {
                'code': 'EMPLOYER_PF',
                'name': "Employer's Provident Fund",
                'component_type': 'employer',
                'calc_type': 'percent_of_base',
                'rate': Decimal('0.1200'),   # 12% of Basic (3.67% PF + 8.33% Pension)
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
                'rate': Decimal('0.0325'),   # 3.25% of gross
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
    """Handles Indian payroll computations, pay run execution, and payslip workflows."""

    @staticmethod
    def calculate_employee_pay(email: str, start_date: date, end_date: date) -> dict:
        """
        Calculate earnings, deductions, employer contributions, and net pay
        for an employee in the Indian payslip format.
        """
        email = email.strip().lower()
        comp = EmployeeCompensation.objects.filter(
            email__iexact=email,
            status='active',
            effective_from__lte=end_date
        ).filter(
            Q(effective_to__isnull=True) | Q(effective_to__gte=start_date)
        ).order_by('-effective_from').first()

        if not comp:
            comp = EmployeeCompensation.objects.filter(
                email__iexact=email,
                status='active'
            ).order_by('-effective_from').first()

        if not comp:
            comp = EmployeeCompensation.objects.filter(
                email__iexact=email
            ).order_by('-effective_from').first()

        base_salary = comp.base_amount if comp else Decimal('0.00')
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

        if attendances.exists():
            paid_days = min(Decimal(str(total_period_days)), worked_days + Decimal(str(wfh_count + leave_count)))
            raw_lop = Decimal(str(total_period_days)) - paid_days
            lop_days = max(Decimal('0.00'), raw_lop)
        else:
            # Baseline for salaried staff: if no attendance rows recorded, default to full month less explicit LOP
            unpaid_leaves = LeaveRequest.objects.filter(
                email__iexact=email,
                status='Approved',
                from_date__lte=end_date,
                to_date__gte=start_date
            ).filter(Q(type__iexact='lop') | Q(type__iexact='loss of pay') | Q(type__iexact='unpaid')).count()
            lop_days = Decimal(str(unpaid_leaves))
            paid_days = Decimal(str(total_period_days)) - lop_days
            worked_days = paid_days

        # ── Build Earnings ──
        earnings_data = []

        # Get all active earning components in display order
        earning_components = PayComponent.objects.filter(
            component_type='earning', is_active=True
        ).order_by('display_order', 'code')

        for comp_obj in earning_components:
            # Check for per-employee override
            emp_override = EmployeePayComponent.objects.filter(
                email__iexact=email,
                component=comp_obj,
                effective_from__lte=end_date
            ).filter(
                Q(effective_to__isnull=True) | Q(effective_to__gte=start_date)
            ).order_by('-effective_from').first()

            if not emp_override:
                emp_override = EmployeePayComponent.objects.filter(
                    email__iexact=email,
                    component=comp_obj
                ).order_by('-effective_from').first()

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

        # ── Build Deductions ──
        deductions_data = []
        gross_earnings = sum(Decimal(str(e['amount'])) for e in earnings_data)

        deduction_components = PayComponent.objects.filter(
            component_type='deduction', is_active=True
        ).order_by('display_order', 'code')

        for comp_obj in deduction_components:
            emp_override = EmployeePayComponent.objects.filter(
                email__iexact=email,
                component=comp_obj,
                effective_from__lte=end_date
            ).filter(
                Q(effective_to__isnull=True) | Q(effective_to__gte=start_date)
            ).order_by('-effective_from').first()

            if not emp_override:
                emp_override = EmployeePayComponent.objects.filter(
                    email__iexact=email,
                    component=comp_obj
                ).order_by('-effective_from').first()

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
                elif gross_earnings <= Decimal('21000.00'):
                    amount = (gross_earnings * Decimal('0.0075')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
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

        total_deductions = sum(Decimal(str(d['amount'])) for d in deductions_data)
        net_pay = max(Decimal('0.00'), gross_earnings - total_deductions)

        # ── Employer Contributions (CTC calculation) ──
        employer_contributions_data = []

        # Gross Earning
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

        # ── Employee info snapshot ──
        user = AppUser.objects.filter(email__iexact=email).first()
        employee_name = ''
        if user:
            employee_name = user.full_name or getattr(user, 'name', '')

        profile = UserProfile.objects.filter(email__iexact=email).first()
        if not employee_name and profile:
            employee_name = f"{profile.first_name} {profile.last_name}".strip()
        if not employee_name:
            employee_name = email.split('@')[0].title()

        designation = profile.designation if profile else ''
        doj = profile.start_date if profile else None
        emp_id = ''
        if comp:
            emp_id = comp.employee_code or ''
        if not emp_id and profile:
            emp_id = profile.employee_id or ''
        if not emp_id and user:
            emp_id = user.employee_id or ''

        return {
            'email': email,
            'employee_name': employee_name,
            'employee_code': emp_id,
            'designation': designation,
            'doj': doj,
            'pan_number': comp.pan_number if comp else '',
            'uan_number': comp.uan_number if comp else '',
            'pf_account_number': comp.pf_account_number if comp else '',
            'bank_account_number': comp.bank_account_number if comp else '',
            'bank_name': comp.bank_name if comp else '',
            'month_days': total_period_days,
            'worked_days': float(worked_days),
            'paid_days': float(paid_days),
            'lop_days': float(lop_days),
            'overtime_hours': float(overtime_hours),
            'base_salary': float(base_salary),
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

        # Get active employees (from AppUser, UserProfile, or EmployeeCompensation)
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
            calc = PayrollService.calculate_employee_pay(email, period_start, period_end)

            payslip, _ = Payslip.objects.update_or_create(
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
        period_start = payslip.run.period_start.strftime('%d/%m/%Y')
        period_end = payslip.run.period_end.strftime('%d/%m/%Y')
        doj_str = payslip.doj.strftime('%d-%m-%Y') if payslip.doj else ''

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
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.pan_number}</td>
        </tr>
        <tr>
            <td style="padding: 3px 6px;">Bank A/c No.</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.bank_account_number}</td>
            <td style="padding: 3px 6px;">PF A/c No.</td>
            <td style="padding: 3px 0; text-align: center;">:</td>
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.pf_account_number}</td>
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
            <td style="padding: 3px 6px; font-weight: bold;">{payslip.uan_number}</td>
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

        for p in payslips:
            writer.writerow([
                p.employee_name,
                p.employee_code,
                p.email,
                p.bank_name,
                p.bank_account_number,
                p.pan_number,
                f"{p.net_pay:.2f}",
                p.status
            ])

        return output.getvalue()
