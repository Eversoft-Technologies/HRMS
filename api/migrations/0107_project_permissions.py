"""Create the project.* permissions and grant them.

0106 started enforcing project.view / create / edit / delete / manage on the
Task Tracker project endpoints, but only granted those codes when a row already
existed, and no migration ever created them. On a database where they were
missing (production), nobody except Super Admin could create or edit a project,
and the codes could not be granted from Access Control either.

This creates the five codes (if missing) in a "Project Group" under Employees,
and grants them to named roles:
  Super Admin, HR Manager : all five
  Manager, Team Lead      : view, create, edit
  HR Executive, Employee  : view
A project's own manager can still edit their project without project.edit.
Additive only: nothing is revoked.
"""
from django.db import migrations

PERMS = [
    ('project.view', 'View Projects', 'See projects in the Task Tracker'),
    ('project.create', 'Create Projects', 'Create new projects in the Task Tracker'),
    ('project.edit', 'Edit Projects', 'Edit any project (name, manager, dates, teams), archive and restore'),
    ('project.delete', 'Delete Projects', 'Permanently delete a project'),
    ('project.manage', 'Manage Projects', 'Configure any project: views, fields, milestones, status updates'),
]
ALL = [p[0] for p in PERMS]
GRANTS = {
    'Super Admin': ALL,
    'HR Manager': ALL,
    'Manager': ['project.view', 'project.create', 'project.edit'],
    'Team Lead': ['project.view', 'project.create', 'project.edit'],
    'HR Executive': ['project.view'],
    'Employee': ['project.view'],
}


def forwards(apps, schema_editor):
    Module = apps.get_model('api', 'Module')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Permission = apps.get_model('api', 'Permission')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')
    emp, _ = Module.objects.get_or_create(name='Employees', defaults={'icon': 'users', 'order': 3, 'is_active': True})
    group, _ = PermissionGroup.objects.get_or_create(
        name='Project Group', defaults={'module': emp, 'is_active': True,
                                        'description': 'Task Tracker projects'})
    by_code = {}
    for code, name, desc in PERMS:
        p, created = Permission.objects.get_or_create(code=code, defaults={
            'name': name, 'description': desc, 'group': group, 'is_active': True})
        if not created and (p.group_id is None or not p.is_active):
            p.group = p.group or group
            p.is_active = True
            p.save(update_fields=['group', 'is_active'])
        by_code[code] = p
    for role_name, codes in GRANTS.items():
        role = Role.objects.filter(name=role_name).first()
        if not role:
            continue
        for c in codes:
            RolePermission.objects.get_or_create(role=role, permission=by_code[c])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0106_rbac_new_features'),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
