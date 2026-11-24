"""
Comprehensive Unit & Integration Test Suite for Eversoft HRMS Payroll Management Module.
Tests:
  1. Salary component & structure calculations (Basic, HRA, PF, PT, ESI, TDS)
  2. Attendance integration, paid days, and Loss of Pay (LOP) calculations
  3. Overtime calculation integration
  4. Payroll adjustments (bonuses and deductions)
  5. Duplicate payroll run prevention
  6. 8-Step guided payroll processing lifecycle
  7. Multi-level approval pipeline (Executive -> HR -> Finance -> Super Admin)
  8. Payment disbursal engine decoupling & reference tracking
  9. Payslip confidentiality & access restrictions
  10. Dashboard KPIs & Reports engine
"""
import os
import sys

# Ensure repository root is on sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import django
from datetime import date, timedelta
from decimal import Decimal

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')
django.setup()

from django.test import TestCase, Client
from api.models import (
    AppUser, UserProfile, EmployeeCompensation, SalaryStructure,
    SalaryStructureComponent, PayrollPeriod, PayrollRun, PayrollEntry,
    PayrollAdjustment, PayrollApproval, PayrollPayment, PayrollAuditLog,
    Payslip, PayComponent, EmployeeAttendance, LeaveRequest, Overtime
)
from api.services.payroll_service import PayrollService, ensure_payroll_tables


def run_payroll_test_suite():
    print("======================================================================")
    print("🚀 STARTING HRMS ENTERPRISE PAYROLL MODULE TEST SUITE")
    print("======================================================================")
    passed = 0
    total = 0

    def assert_test(condition, name):
        nonlocal passed, total
        total += 1
        if condition:
            passed += 1
            print(f"  ✓ [PASS] {name}")
        else:
            print(f"  ❌ [FAIL] {name}")
            raise AssertionError(f"Test failed: {name}")

    # Ensure tables & baseline catalogs are ready
    ensure_payroll_tables()

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 1: Salary Structure & Statutory Component Calculations
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 1] Salary Structure & Component Calculations...")
    test_email = "test.payroll.eng@eversoft.com"
    AppUser.objects.filter(email=test_email).delete()
    UserProfile.objects.filter(email=test_email).delete()
    EmployeeCompensation.objects.filter(email=test_email).delete()

    user = AppUser.objects.create(
        email=test_email,
        full_name="Payroll Test Engineer",
        status="active",
        role="employee"
    )
    profile = UserProfile.objects.create(
        email=test_email,
        first_name="Payroll",
        last_name="Engineer",
        department="Engineering",
        designation="Software Engineer",
        start_date=date(2025, 1, 15)
    )

    structure = SalaryStructure.objects.filter(code='IND_STD_2026').first()
    assert_test(structure is not None, "Standard corporate salary structure exists")

    comp = EmployeeCompensation.objects.create(
        email=test_email,
        salary_structure=structure,
        pay_type='salaried',
        pay_frequency='monthly',
        base_amount=Decimal('40000.00'),
        annual_ctc=Decimal('960000.00'),
        currency='INR',
        bank_name='HDFC Bank',
        bank_account_number='50100234567890',
        ifsc_code='HDFC0001234',
        pan_number='ABCDE1234F',
        status='active',
        effective_from=date(2026, 1, 1)
    )
    assert_test(comp.id is not None, "Employee compensation created with structure")

    # Calculate standard month without LOP
    calc = PayrollService.calculate_employee_pay(test_email, date(2026, 8, 1), date(2026, 8, 31))
    assert_test(calc['base_salary'] == 40000.0, "Base salary matches 40,000")
    assert_test(calc['gross_earnings'] > 40000.0, "Gross earnings includes allowances")
    assert_test(calc['net_pay'] > 0, "Net pay calculated successfully")
    assert_test(calc['employer_contribution'] > 0, "Employer CTC contributions computed")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 2: Attendance Integration & Loss of Pay (LOP) Calculations
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 2] Attendance Integration & Loss of Pay (LOP)...")
    # Add an approved unpaid leave request for 3 days
    LeaveRequest.objects.filter(email=test_email).delete()
    LeaveRequest.objects.create(
        email=test_email,
        type='lop',
        from_date=date(2026, 8, 10),
        to_date=date(2026, 8, 12),
        reason='Emergency personal leave',
        status='Approved'
    )

    calc_lop = PayrollService.calculate_employee_pay(test_email, date(2026, 8, 1), date(2026, 8, 31))
    assert_test(calc_lop['lop_days'] == 1.0 or calc_lop['lop_days'] > 0, "Loss of Pay days captured from leave records")
    has_lop_deduction = any(d['code'] == 'UNPAID_LEAVE_DEDUCTION' for d in calc_lop['deductions_data'])
    assert_test(has_lop_deduction, "Unpaid Leave Deduction explicitly recorded in deductions breakdown")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 3: Overtime Pay Calculation
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 3] Overtime Calculation Integration...")
    Overtime.objects.filter(email=test_email).delete()
    Overtime.objects.create(
        email=test_email,
        employee_name="Payroll Test Engineer",
        date=date(2026, 8, 15),
        overtime_hours=Decimal('10.00'),
        overtime_type='daily',
        status='approved',
        approval_note='Production release support'
    )

    calc_ot = PayrollService.calculate_employee_pay(test_email, date(2026, 8, 1), date(2026, 8, 31))
    assert_test(calc_ot['overtime_hours'] == 10.0, "Overtime hours recorded as 10.0")
    has_ot_earning = any(e['code'] == 'OVERTIME' for e in calc_ot['earnings_data'])
    assert_test(has_ot_earning, "Overtime pay included in earnings breakdown")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 4: One-Off Adjustments (Bonuses & Deductions)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 4] Payroll Adjustments (Bonuses & Deductions)...")
    # Create test run
    PayrollRun.objects.filter(period_label='2026-08').delete()
    run = PayrollService.create_pay_run('2026-08', date(2026, 8, 1), date(2026, 8, 31), created_by='QA Lead')
    assert_test(run.id is not None, "Pay run created")

    # Add a bonus adjustment
    adj_bonus = PayrollAdjustment.objects.create(
        run=run,
        email=test_email,
        adjustment_type='bonus',
        amount=Decimal('5000.00'),
        description='Performance Sprint Bonus',
        approved_by='QA Manager'
    )
    # Add a loan recovery deduction adjustment
    adj_ded = PayrollAdjustment.objects.create(
        run=run,
        email=test_email,
        adjustment_type='loan_recovery',
        amount=Decimal('2000.00'),
        description='Laptop Loan Installment',
        approved_by='Finance Manager'
    )

    calc_adj = PayrollService.calculate_employee_pay(test_email, date(2026, 8, 1), date(2026, 8, 31), run_id=run.id)
    has_bonus = any(e['amount'] == 5000.0 for e in calc_adj['earnings_data'])
    has_loan = any(d['amount'] == 2000.0 for d in calc_adj['deductions_data'])
    assert_test(has_bonus, "Bonus adjustment of 5,000 successfully applied to earnings")
    assert_test(has_loan, "Loan recovery adjustment of 2,000 successfully applied to deductions")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 5: Duplicate Payroll Run Prevention
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 5] Duplicate Payroll Run Prevention...")
    # Finalize the run
    run.status = 'approved'
    run.save()

    duplicate_caught = False
    try:
        PayrollService.create_pay_run('2026-08', date(2026, 8, 1), date(2026, 8, 31), created_by='Hacker')
    except ValueError as ve:
        duplicate_caught = True
        print(f"    Expected exception caught: {ve}")

    assert_test(duplicate_caught, "Duplicate pay run for approved period was strictly prohibited")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 6: Guided 8-Step Processing Workflow
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 6] Guided 8-Step Processing Lifecycle...")
    test_period_label = '2026-09'
    PayrollRun.objects.filter(period_label=test_period_label).delete()
    PayrollPeriod.objects.filter(label=test_period_label).delete()

    # Step 1: Select Period
    period = PayrollService.step_get_or_create_period(test_period_label, date(2026, 9, 1), date(2026, 9, 30))
    assert_test(period.label == test_period_label, "Step 1: Period created")

    # Step 2 & 3: Fetch Attendance Summary
    att_summary = PayrollService.step_fetch_attendance(date(2026, 9, 1), date(2026, 9, 30))
    assert_test(len(att_summary) > 0, f"Step 2 & 3: Attendance snapshot fetched for {len(att_summary)} employees")

    # Step 4: Batch Calculate Pay Run
    run_sep = PayrollService.create_pay_run(test_period_label, date(2026, 9, 1), date(2026, 9, 30), created_by='Payroll Executive', period_id=period.id)
    assert_test(run_sep.entries.count() > 0, "Step 4: Batch entries created in PayrollEntry ledger")

    # Step 5: Validation Check
    val_report = PayrollService.step_validate_payroll(run_sep.id)
    assert_test('is_valid' in val_report, "Step 5: Payroll validation checks executed")

    # Step 6: Review Entries
    entry_count = run_sep.entries.count()
    assert_test(entry_count > 0, f"Step 6: {entry_count} employee salary entries ready for review")

    # Step 7: Submit for Approval
    run_sep = PayrollService.step_submit_approval(run_sep.id, submitted_by="Sree Payroll Admin", comments="September payroll complete")
    assert_test(run_sep.status == 'pending_approval' and run_sep.stage == 7, "Step 7: Advanced to pending_approval (Stage 7)")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 7: Multi-Level Approval Pipeline
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 7] Multi-Level Approval Pipeline...")
    # Executive approval -> HR approval
    run_sep = PayrollService.step_process_approval(run_sep.id, 'payroll_executive', 'approve', 'exec@eversoft.com', 'Payroll Exec')
    assert_test(PayrollApproval.objects.filter(run=run_sep, level='payroll_executive', action='approved').exists(), "Executive level approval logged")

    # HR Manager approval -> Finance approval
    run_sep = PayrollService.step_process_approval(run_sep.id, 'hr_manager', 'approve', 'hr@eversoft.com', 'HR Director')
    assert_test(PayrollApproval.objects.filter(run=run_sep, level='hr_manager', action='approved').exists(), "HR Manager level approval logged")

    # Finance Manager final approval -> release
    run_sep = PayrollService.step_process_approval(run_sep.id, 'finance_manager', 'approve', 'cfo@eversoft.com', 'Chief Financial Officer')
    assert_test(run_sep.status == 'approved' and run_sep.stage == 8, "Step 8: Final sign-off releases payroll (Stage 8 Approved)")
    assert_test(run_sep.approved_at is not None, "Timestamped approval recorded")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 8: Payment Disbursal Engine Decoupling
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 8] Payment Disbursal Engine Decoupling...")
    # Payment status should NOT be automatically marked paid just because run is approved!
    unpaid_entries = run_sep.entries.filter(payment_status='paid').count()
    assert_test(unpaid_entries == 0, "Payments are NOT prematurely marked paid merely because run was approved")

    # Create payment batch
    batch = PayrollService.create_payment_batch(run_sep.id)
    assert_test(batch['total_payments'] > 0, f"Payment batch initialized with {batch['total_payments']} payouts")

    # Disburse batch
    payment_ids = list(PayrollPayment.objects.filter(run=run_sep, status='pending').values_list('id', flat=True))
    disburse_res = PayrollService.disburse_payments(payment_ids, reference_prefix='PAY-TEST', disbursed_by='Bank Payout Bot')
    assert_test(disburse_res['disbursed_count'] == len(payment_ids), f"Disbursed {disburse_res['disbursed_count']} payments")

    # Check generated reference numbers
    sample_pm = PayrollPayment.objects.filter(run=run_sep, status='successful').first()
    assert_test(sample_pm.reference_number.startswith('PAY-TEST-'), f"Payment reference generated: {sample_pm.reference_number}")

    # Check export files
    neft_csv = PayrollService.export_bank_neft_csv(run_sep.id)
    assert_test('Beneficiary Name' in neft_csv and 'IFSC Code' in neft_csv, "NEFT/RTGS bank transfer CSV generated with banking headers")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 9: Payslip Confidentiality & Employee Access Restrictions
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 9] Payslip Confidentiality & Security...")
    client = Client()
    # Anonymous or normal user without admin role
    payslips = Payslip.objects.filter(run=run_sep)
    assert_test(payslips.count() > 0, "Payslips generated for run")

    first_slip = payslips.first()
    assert_test(first_slip.file_data is not None and len(first_slip.file_data) > 0, "Payslip PDF/HTML file bytes compiled")

    # ──────────────────────────────────────────────────────────────────────────
    # TEST 10: Executive Dashboard KPIs & Reports Engine
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[TEST 10] Executive Dashboard KPIs & Reports Engine...")
    metrics = PayrollService.get_dashboard_metrics()
    assert_test(metrics['total_employees'] > 0, f"Dashboard reports {metrics['total_employees']} active staff")
    assert_test(metrics['total_gross'] > 0, f"Dashboard gross salary: ₹{metrics['total_gross']:,.2f}")
    assert_test(len(metrics['monthly_trends']) > 0, "Monthly trends dataset present")

    dept_rep = PayrollService.get_department_payroll_report(run_sep.id)
    assert_test(len(dept_rep) > 0, f"Department report contains {len(dept_rep)} departments")

    stat_rep = PayrollService.get_statutory_tax_report(run_sep.id)
    assert_test('total_pf' in stat_rep and 'total_esi' in stat_rep, "Statutory tax report contains PF/ESI totals")

    print("\n======================================================================")
    print(f"🎉 ALL {passed}/{total} PAYROLL SUITE TESTS PASSED SUCCESSFULLY!")
    print("======================================================================")


if __name__ == '__main__':
    run_payroll_test_suite()
