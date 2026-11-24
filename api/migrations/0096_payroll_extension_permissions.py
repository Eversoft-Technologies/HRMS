"""Permissions for the payroll extensions.

Separation of duties: the role that PREPARES a salary payout (Payroll Admin)
does not hold the right to RELEASE it (HR Manager); Super Admin holds every
permission. Integration credentials (bank / Twilio / Slack) are Super Admin
only by default.
"""
from django.db import migrations

PERMS = [
    ('payroll.tax.manage', 'Manage Tax Tables', 'Edit tax slabs, rebates and section limits per financial year'),
    ('payroll.tax.verify', 'Verify Tax Declarations', 'Review IT declarations and proofs, lock them for final TDS'),
    ('payroll.statutory', 'Generate Statutory Files', 'EPFO ECR, ESIC, Form 24Q, Form 16, W-2 and 1099 files'),
    ('payroll.payout.prepare', 'Prepare Salary Payouts', 'Create bank payout batches (maker)'),
    ('payroll.payout.release', 'Release Salary Payouts', 'Release payout batches to the bank with OTP (checker)'),
    ('payroll.integrations', 'Manage Payroll Integrations', 'Bank API, Twilio and Slack credentials'),
    ('payroll.loans.approve', 'Approve Loans & Advances', 'Approve salary advances and employee loans'),
    ('payroll.fnf.manage', 'Manage Full & Final', 'Separations, clearances and F&F settlements'),
    ('payroll.us.manage', 'Manage US Payroll', 'W-4s, US tax tables, contractor payments'),
    ('expense.approve', 'Approve Expense Claims', 'Approve reimbursement claims paid through payroll'),
]
GRANTS = {
    'Payroll Admin': ['payroll.tax.manage', 'payroll.tax.verify', 'payroll.statutory', 'payroll.payout.prepare',
                      'payroll.loans.approve', 'payroll.fnf.manage', 'payroll.us.manage', 'expense.approve'],
    'HR Manager': ['payroll.tax.verify', 'payroll.statutory', 'payroll.payout.release', 'payroll.loans.approve',
                   'payroll.fnf.manage', 'expense.approve'],
    'Manager': ['expense.approve'],
}


def forwards(apps, schema_editor):
    Module = apps.get_model('api', 'Module')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Permission = apps.get_model('api', 'Permission')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')
    module, _ = Module.objects.get_or_create(name='Payroll', defaults={'icon': 'credit-card', 'order': 6, 'is_active': True})
    group, _ = PermissionGroup.objects.get_or_create(
        name='Payroll Compliance Group', defaults={'module': module, 'is_active': True,
                                                   'description': 'Tax, statutory filing, payouts, loans, F&F, US payroll'})
    by_code = {}
    for code, name, desc in PERMS:
        p, _ = Permission.objects.get_or_create(code=code, defaults={'name': name, 'description': desc,
                                                                     'group': group, 'is_active': True})
        by_code[code] = p
    for role_name, codes in GRANTS.items():
        role = Role.objects.filter(name=role_name).first()
        if role:
            for c in codes:
                RolePermission.objects.get_or_create(role=role, permission=by_code[c])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0095_payroll_extensions'),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
