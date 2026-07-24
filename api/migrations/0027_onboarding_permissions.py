"""Seed the Onboarding module, permissions, and workflow roles.

The onboarding workflow is deliberately split into one permission per stage
rather than a single onboarding.manage:

  onboarding.view / .create / .edit / .delete  — the candidate record
  onboarding.verify   — HR's document checklist
  onboarding.approve  — the manager's decision
  onboarding.assets   — IT hardware allocation
  onboarding.payroll  — bank / tax details
  onboarding.settings — module configuration

Splitting them is the point: a Manager can approve a candidate without being
able to read their bank details, and IT can hand over a laptop without seeing
payroll. A single coarse permission would collapse that separation of duties.

Three new roles carry one stage each (Manager, IT Admin, Payroll Admin). HR
Executive — the recruiter role today — gets create/edit but explicitly NOT
verify or approve, so nobody can drive a candidate end-to-end unaided.

Idempotent (get_or_create throughout) and safe to re-run alongside
`manage.py seed_rbac`, which seeds the same catalogue.
"""
from django.db import migrations


MODULE = {'name': 'Onboarding', 'icon': 'user-check', 'order': 9}
GROUP = {
    'name': 'Onboarding Group',
    'description': 'Work authorization, documents, verification, and employee onboarding',
}

NEW_PERMS = [
    ('onboarding.view', 'View Onboarding'),
    ('onboarding.create', 'Create Candidate'),
    ('onboarding.edit', 'Edit Candidate / Work Authorization'),
    ('onboarding.delete', 'Delete Candidate'),
    ('onboarding.verify', 'Verify Documents (HR)'),
    ('onboarding.approve', 'Approve Onboarding (Manager)'),
    ('onboarding.assets', 'Allocate IT Assets'),
    ('onboarding.payroll', 'Complete Payroll Information'),
    ('onboarding.settings', 'Manage Onboarding Settings'),
]

NEW_ROLES = [
    ('Manager', 'Approve, reject, or return onboarding candidates'),
    ('IT Admin', 'Allocate and track IT assets for onboarding candidates'),
    ('Payroll Admin', 'Complete payroll information for onboarding candidates'),
    # 'Recruiter' already exists in some databases (created ad hoc through the
    # RBAC editor, never seeded). get_or_create adopts it rather than duplicating.
    ('Recruiter', 'Create and edit onboarding candidates'),
]

# Role -> onboarding codes. Super Admin bypasses every check in permissions.py,
# so it needs no grants here.
GRANTS = {
    'HR Manager': [
        'onboarding.view', 'onboarding.create', 'onboarding.edit',
        'onboarding.delete', 'onboarding.verify', 'onboarding.settings',
    ],
    'HR Executive': ['onboarding.view', 'onboarding.create', 'onboarding.edit'],
    'Recruiter': ['onboarding.view', 'onboarding.create', 'onboarding.edit'],
    'Manager': ['onboarding.view', 'onboarding.approve'],
    'IT Admin': ['onboarding.view', 'onboarding.assets'],
    'Payroll Admin': ['onboarding.view', 'onboarding.payroll'],
}


def forwards(apps, schema_editor):
    Module = apps.get_model('api', 'Module')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Permission = apps.get_model('api', 'Permission')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')

    module, _ = Module.objects.get_or_create(
        name=MODULE['name'],
        defaults={'icon': MODULE['icon'], 'order': MODULE['order'], 'is_active': True},
    )
    group, _ = PermissionGroup.objects.get_or_create(
        name=GROUP['name'],
        defaults={
            'module_id': module.id,
            'description': GROUP['description'],
            'is_active': True,
        },
    )

    perms = {}
    for code, name in NEW_PERMS:
        p, _ = Permission.objects.get_or_create(
            code=code,
            defaults={'name': name, 'group_id': group.id, 'is_active': True},
        )
        perms[code] = p

    for name, desc in NEW_ROLES:
        Role.objects.get_or_create(
            name=name, defaults={'description': desc, 'is_active': True},
        )

    for role_name, codes in GRANTS.items():
        role = Role.objects.filter(name=role_name).first()
        if not role:
            continue
        for code in codes:
            RolePermission.objects.get_or_create(role_id=role.id, permission=perms[code])


def backwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    Permission.objects.filter(
        code__in=[c for c, _ in NEW_PERMS]
    ).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0026_onboardingcandidate_onboardingactivitylog_and_more')]
    operations = [migrations.RunPython(forwards, backwards)]
