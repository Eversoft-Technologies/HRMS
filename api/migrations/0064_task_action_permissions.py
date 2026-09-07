"""Task Tracker action permissions: reviewer edit/delete, employee accept/reject.

The Task Tracker's reviewer card (Edit / View / Delete) is for Manager and
Team Lead, and the employee card (View / Accept / Reject / Mark Done) needs
edit rights on their own tasks. ``api/views.py::task_detail`` gates PUT/DELETE
behind two codes scoped to tasks only — ``task.edit`` and ``task.delete`` —
kept separate from the generic ``employee.edit`` / ``employee.delete`` Work
Submissions also uses, so granting a reviewer or an employee task access
never silently unlocks Work Submissions editing for them too.

To avoid regressing whoever could already edit/delete a task before this
change, the new codes are also granted to every role that held the generic
ones (Super Admin and HR Manager already get every permission automatically
and need no explicit grant; HR Executive held employee.edit only, so it gets
task.edit only), on top of the Manager / Team Lead / Employee grants this
change is actually for.
"""
from django.db import migrations


GROUP_NAME = 'Employee Group'
MODULE_NAME = 'Employees'

PERMISSIONS = [
    ('task.edit', 'Edit Tasks'),
    ('task.delete', 'Delete Tasks'),
]

# Explicit grants only — Super Admin and HR Manager already hold every
# permission and pick up new codes automatically (see permissions.py and
# seed_rbac.py's HR Manager wildcard). Employee gets task.edit only (accept /
# reject / mark done), never task.delete.
GRANTS = {
    'HR Executive': ['task.edit'],
    'Manager': ['task.edit', 'task.delete'],
    'Team Lead': ['task.edit', 'task.delete'],
    'Employee': ['task.edit'],
}


def forwards(apps, schema_editor):
    Module = apps.get_model('api', 'Module')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Permission = apps.get_model('api', 'Permission')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')

    module, _ = Module.objects.get_or_create(
        name=MODULE_NAME, defaults={'icon': 'users', 'order': 3, 'is_active': True})
    group, _ = PermissionGroup.objects.get_or_create(
        name=GROUP_NAME,
        defaults={'module': module, 'description': 'Manage employee records and tasks', 'is_active': True},
    )

    perms = {}
    for code, name in PERMISSIONS:
        perm, _ = Permission.objects.get_or_create(
            code=code, defaults={'name': name, 'group': group, 'is_active': True})
        perms[code] = perm

    for role_name, codes in GRANTS.items():
        role = Role.objects.filter(name=role_name).first()
        if not role:
            continue
        for code in codes:
            RolePermission.objects.get_or_create(role=role, permission=perms[code])


def backwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    Permission.objects.filter(code__in=[c for c, _ in PERMISSIONS]).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0063_task_board_columns')]
    operations = [migrations.RunPython(forwards, backwards)]
