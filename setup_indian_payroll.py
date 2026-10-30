"""
One-time migration script to replace US pay components with Indian ones
and set up proper test compensation data for the reference payslip.

Run: python setup_indian_payroll.py
"""
import os
import sys
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
django.setup()

import base64
from decimal import Decimal
from datetime import date
from api.models import (
    EmployeeCompensation, PayComponent, EmployeePayComponent,
    PayrollRun, Payslip, AppUser, UserProfile
)
from api.services.payroll_service import PayrollService, amount_to_words_inr

print("=" * 60)
print("  Setting up Indian Payroll Components")
print("=" * 60)

# ── Step 1: Remove old US pay components ──
old_codes = ['BASE_SALARY', 'OVERTIME', 'PERF_BONUS', 'HRA',
             'LOP_DEDUCTION', 'TAX_WITHHOLDING', 'HEALTH_INSURANCE', 'RETIREMENT_401K']
deleted = PayComponent.objects.filter(code__in=old_codes).delete()
print(f"\n[1] Removed {deleted[0]} old US pay components")

# ── Step 2: Create Indian pay components ──
indian_components = [
    # Earnings
    {'code': 'BASIC_SALARY', 'name': 'Basic Salary', 'component_type': 'earning',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('0.00'),
     'is_taxable': True, 'is_active': True, 'display_order': 1},
    {'code': 'HRA', 'name': 'HRA', 'component_type': 'earning',
     'calc_type': 'percent_of_base', 'rate': Decimal('0.5000'), 'default_amount': Decimal('0.00'),
     'is_taxable': True, 'is_active': True, 'display_order': 2},
    {'code': 'TRANSPORT_ALLOWANCE', 'name': 'Transport Allowance', 'component_type': 'earning',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('1600.00'),
     'is_taxable': True, 'is_active': True, 'display_order': 3},
    {'code': 'CEA', 'name': 'Children Education Allowance', 'component_type': 'earning',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('200.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 4},
    {'code': 'LTA', 'name': 'LTA', 'component_type': 'earning',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('0.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 5},
    {'code': 'SPECIAL_ALLOWANCE', 'name': 'Special Allowance', 'component_type': 'earning',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('0.00'),
     'is_taxable': True, 'is_active': True, 'display_order': 6},
    {'code': 'INCENTIVES', 'name': 'Incentives', 'component_type': 'earning',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('0.00'),
     'is_taxable': True, 'is_active': True, 'display_order': 7},
    # Deductions
    {'code': 'PF', 'name': 'PF', 'component_type': 'deduction',
     'calc_type': 'percent_of_base', 'rate': Decimal('0.1200'), 'default_amount': Decimal('0.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 1},
    {'code': 'PROFESSIONAL_TAX', 'name': 'Professional Tax', 'component_type': 'deduction',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('150.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 2},
    {'code': 'ESI', 'name': 'ESI', 'component_type': 'deduction',
     'calc_type': 'percent_of_base', 'rate': Decimal('0.0075'), 'default_amount': Decimal('0.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 3},
    {'code': 'TDS', 'name': 'TDS', 'component_type': 'deduction',
     'calc_type': 'fixed', 'rate': Decimal('0.0000'), 'default_amount': Decimal('0.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 4},
    # Employer Contributions
    {'code': 'EMPLOYER_PF', 'name': "Employer's Provident Fund", 'component_type': 'employer',
     'calc_type': 'percent_of_base', 'rate': Decimal('0.1200'), 'default_amount': Decimal('0.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 1},
    {'code': 'EMPLOYER_ESI', 'name': "Employer's State Insurance", 'component_type': 'employer',
     'calc_type': 'percent_of_base', 'rate': Decimal('0.0325'), 'default_amount': Decimal('0.00'),
     'is_taxable': False, 'is_active': True, 'display_order': 2},
]

created_count = 0
for item in indian_components:
    _, created = PayComponent.objects.get_or_create(code=item['code'], defaults=item)
    if created:
        created_count += 1

print(f"[2] Created {created_count} Indian pay components")
print("\n    Current components:")
for pc in PayComponent.objects.all().order_by('component_type', 'display_order'):
    print(f"    [{pc.component_type:8s}] {pc.code:25s} {pc.name}")

# ── Step 3: Update first active user's compensation to match reference payslip ──
user = AppUser.objects.filter(status='active').first()
if user:
    email = user.email.strip().lower()
    user.full_name = 'ADIPI REDDY SRIKANTH'
    user.save()
    print(f"\n[3] Setting up sample compensation for: {email} ({user.full_name})")

    comp, _ = EmployeeCompensation.objects.get_or_create(
        email=email,
        defaults={'status': 'active'}
    )
    comp.base_amount = Decimal('10900.00')
    comp.annual_ctc = Decimal('261600.00')
    comp.currency = 'INR'
    comp.effective_from = date(2026, 1, 1)
    comp.status = 'active'
    comp.employee_code = 'ET099'
    comp.pan_number = 'OLJPS2742M'
    comp.uan_number = '102341569566'
    comp.pf_account_number = 'APPTC2402614000010084'
    comp.bank_account_number = '50100867418243'
    comp.bank_name = 'HDFC'
    comp.save()
    print("    ✅ Compensation updated with Indian statutory fields")

    # Set per-employee overrides to match reference payslip
    overrides = {
        'HRA': Decimal('5450.00'),
        'TRANSPORT_ALLOWANCE': Decimal('1600.00'),
        'CEA': Decimal('200.00'),
        'LTA': Decimal('1090.00'),
        'SPECIAL_ALLOWANCE': Decimal('760.00'),
        'INCENTIVES': Decimal('0.00'),
        'PF': Decimal('1800.00'),
        'PROFESSIONAL_TAX': Decimal('150.00'),
        'ESI': Decimal('400.00'),
        'TDS': Decimal('0.00'),
        'EMPLOYER_PF': Decimal('1800.00'),
        'EMPLOYER_ESI': Decimal('0.00'),
    }

    for code, amount in overrides.items():
        comp_obj = PayComponent.objects.filter(code=code).first()
        if comp_obj:
            EmployeePayComponent.objects.update_or_create(
                email=email,
                component=comp_obj,
                defaults={
                    'amount': amount,
                    'effective_from': date(2026, 1, 1),
                }
            )
    print("    ✅ Employee pay component overrides set")

    # Also ensure UserProfile has designation and start_date (DOJ)
    profile, _ = UserProfile.objects.get_or_create(email=email)
    profile.designation = 'BACKEND DEVELOPER'
    profile.start_date = date(2026, 5, 26)
    profile.employee_id = 'ET099'
    profile.save()
    print("    ✅ Profile designation and DOJ (26-05-2026) updated")

    # ── Step 4: Generate test payslip ──
    print(f"\n[4] Generating payslip for June 2026...")
    period_start = date(2026, 6, 1)
    period_end = date(2026, 6, 30)
    
    calc = PayrollService.calculate_employee_pay(email, period_start, period_end)
    
    print(f"\n    Earnings:")
    for e in calc['earnings_data']:
        print(f"      {e['label']:35s} Rs. {e['amount']:>10,.2f}")
    print(f"      {'─' * 50}")
    print(f"      {'Total Earnings':35s} Rs. {calc['gross_earnings']:>10,.2f}")
    
    print(f"\n    Deductions:")
    for d in calc['deductions_data']:
        print(f"      {d['label']:35s} Rs. {d['amount']:>10,.2f}")
    print(f"      {'─' * 50}")
    print(f"      {'Total Deductions':35s} Rs. {calc['total_deductions']:>10,.2f}")
    
    print(f"\n    Net Pay:     Rs. {calc['net_pay']:>10,.2f}")
    print(f"    In Words:    {amount_to_words_inr(calc['net_pay'])}")
    print(f"\n    Employer:    Rs. {calc['employer_contribution']:>10,.2f}")
    print(f"    Total CTC:   Rs. {calc['total_ctc']:>10,.2f}")
    print(f"    In Words:    {amount_to_words_inr(calc['total_ctc'])}")
    
    # Create payslip and generate HTML
    run, _ = PayrollRun.objects.get_or_create(
        period_label='2026-06',
        defaults={
            'period_start': period_start,
            'period_end': period_end,
            'frequency': 'monthly',
            'status': 'draft',
            'created_by': 'setup_script',
        }
    )
    
    payslip, _ = Payslip.objects.update_or_create(
        run=run, email=email,
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
            'month_days': 30,
            'worked_days': Decimal('30.00'),
            'paid_days': Decimal('30.00'),
            'lop_days': Decimal('0.00'),
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
            'status': 'draft',
        }
    )
    
    html_b64 = PayrollService.generate_payslip_pdf(payslip)
    html_content = base64.b64decode(html_b64).decode('utf-8')
    
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sample_payslip.html')
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    
    print(f"\n{'=' * 60}")
    print(f"  ✅ DONE! Sample payslip saved to:")
    print(f"  {output_path}")
    print(f"  Open in browser to view the payslip.")
    print(f"{'=' * 60}")
else:
    print("\n⚠ No active users found.")
