"""Payroll extensions: India tax & statutory, bank payouts, US payroll, ESS, F&F.

Calculation hook
----------------
``PayrollService.calculate_employee_pay`` ends with::

    result = apply_calculation_hooks(result, email, start_date, end_date, run_id)

Each step below is ``module:function(result, ctx) -> result`` and is imported
lazily, so a missing / failing step never breaks a pay run (it is logged and
skipped). Steps add or replace payslip lines with ``set_line`` and finish
with ``recompute`` so gross / deductions / net / CTC stay consistent with the
core service's own maths. Order matters: reimbursements and loans first,
then tax (which needs the final taxable earnings).
"""
import importlib
import logging
from decimal import Decimal, ROUND_HALF_UP

logger = logging.getLogger(__name__)

STEPS = [
    'api.payroll_ext.ess:apply_expenses',      # approved claims → non-taxable earnings
    'api.payroll_ext.ess:apply_loans',         # loan / advance EMIs → deductions
    'api.attendance_ext.leave_accrual:apply_leave_encashment',  # year-end leave encashment -> taxable LEAVE_ENC
    'api.attendance_ext.penalties:apply_attendance_penalties',  # attendance LOP penalties -> ATT_PENALTY deduction
    'api.payroll_ext.india_tax:apply_tds',     # regime-based TDS (replaces the TDS line)
    'api.payroll_ext.us_payroll:apply_us',     # FIT / SIT / FICA / Medicare for US employees
]

# Codes of earning lines that are NOT taxable (reimbursements …). Steps that
# add non-taxable earnings append their code here so the tax step skips them.
NON_TAXABLE_CODES = {'REIMB', 'REIMBURSEMENT', 'EXPENSE_REIMB'}
INFO_EMPLOYER_CODES = {'GROSS_EARNING'}


def D(v):
    return Decimal(str(v or 0)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def set_line(result, key, code, label, amount, replace=True):
    """Add a line to result[key] ('earnings_data' | 'deductions_data' |
    'employer_contributions_data'); with replace=True an existing line with
    the same code is overwritten. A zero amount removes the line."""
    lines = list(result.get(key) or [])
    if replace:
        lines = [l for l in lines if str(l.get('code')) != code]
    if D(amount) != 0:
        lines.append({'code': code, 'label': label, 'amount': float(D(amount))})
    result[key] = lines
    return result


def line_amount(result, key, code):
    return sum(D(l.get('amount')) for l in (result.get(key) or []) if str(l.get('code')) == code)


def taxable_earnings(result):
    return sum(D(l.get('amount')) for l in (result.get('earnings_data') or [])
               if str(l.get('code')).upper() not in NON_TAXABLE_CODES)


def recompute(result):
    """Same arithmetic as PayrollService.calculate_employee_pay."""
    gross = sum(D(e.get('amount')) for e in (result.get('earnings_data') or []))
    ded = sum(D(d.get('amount')) for d in (result.get('deductions_data') or []))
    # GROSS_EARNING is an informational row the core service adds to the
    # employer list; it is not an employer cost (the service excludes it too).
    employer = sum(D(e.get('amount')) for e in (result.get('employer_contributions_data') or [])
                   if str(e.get('code')).upper() not in INFO_EMPLOYER_CODES)
    result['gross_earnings'] = float(gross)
    result['total_deductions'] = float(ded)
    result['net_pay'] = float(max(Decimal('0'), gross - ded))
    result['employer_contribution'] = float(employer)
    result['total_ctc'] = float(gross + employer)
    return result


def apply_calculation_hooks(result, email, start_date, end_date, run_id=None):
    ctx = {'email': (email or '').lower(), 'start': start_date, 'end': end_date, 'run_id': run_id}
    for spec in STEPS:
        mod_name, fn_name = spec.split(':')
        try:
            fn = getattr(importlib.import_module(mod_name), fn_name, None)
        except ImportError:
            continue
        if fn is None:
            continue
        try:
            out = fn(result, ctx)
            if isinstance(out, dict):
                result = out
        except Exception:
            logger.exception('payroll hook %s failed for %s — skipped', spec, email)
    return result
