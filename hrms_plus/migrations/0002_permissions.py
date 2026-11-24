"""Permissions for hrms_plus modules.

Careers reuse recruitment.view / recruitment.edit (applications are recruiting
data). Matrix reporting lines need attendance.edit (HR). New codes cover what
has no existing equivalent: managing company / department OKRs, and the IT
asset register. Grants go to the named roles below only."""
from django.db import migrations

PERMS = [
    ('okr.manage', 'Manage OKRs', 'Create company and department objectives, edit anyone\'s OKRs'),
    ('assets.view', 'View IT Assets', 'See the IT asset register and who holds what'),
    ('assets.manage', 'Manage IT Assets', 'Add assets, assign, recover, retire, write off'),
]
GRANTS = {
    'Super Admin': ['okr.manage', 'assets.view', 'assets.manage'],
    'HR Manager': ['okr.manage', 'assets.view', 'assets.manage'],   # HR allocates assets at onboarding
    'HR Executive': ['assets.view'],
    'IT Admin': ['assets.view', 'assets.manage'],
}


def forwards(apps, schema_editor):
    Module = apps.get_model('api', 'Module')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Permission = apps.get_model('api', 'Permission')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')
    module, _ = Module.objects.get_or_create(name='Workplace', defaults={'icon': 'briefcase', 'order': 9, 'is_active': True})
    group, _ = PermissionGroup.objects.get_or_create(
        name='Goals & Assets Group', defaults={'module': module, 'is_active': True,
                                               'description': 'OKRs and the IT asset register'})
    by_code = {}
    for code, name, desc in PERMS:
        p, _ = Permission.objects.get_or_create(code=code, defaults={'name': name, 'description': desc,
                                                                     'group': group, 'is_active': True})
        by_code[code] = p
    # Grants go to named roles only. (Copying them to every role holding
    # onboarding.assets was too loose: on some installs the plain Employee
    # role holds every onboarding right, which would have handed all
    # employees the asset register.) Admins can grant more in Access Control.
    for role_name, codes in GRANTS.items():
        role = Role.objects.filter(name=role_name).first()
        if role:
            for c in codes:
                RolePermission.objects.get_or_create(role=role, permission=by_code[c])


class Migration(migrations.Migration):

    dependencies = [
        ('hrms_plus', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
