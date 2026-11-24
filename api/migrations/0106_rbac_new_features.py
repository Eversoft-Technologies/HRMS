"""RBAC for the newer features.

Until now these screens borrowed broad codes: attendance policies and holiday
calendars used settings.view/settings.manage (settings.view is held by every
role, so every employee could read all policy profiles and the office IP
ranges), overtime used attendance.view (also held by every employee, so anyone
could list everyone's overtime), and creating a Task Tracker issue needed
employee.create. Each now has its own code, editable per role in Access
Control. The project.* codes (migration 0046) now actually gate the project
endpoints, and Team Lead gets project.view / project.edit to run its projects.

Grants go to named roles only (see hrms_plus 0002 for why). Super Admin passes
every check anyway; it is granted the codes so its role page lists them.
Managers keep deciding overtime, regularization, short leave and penalty
waivers for their own reports through the reporting line, as before.
"""
from django.db import migrations

PERMS = [
    ('task.create', 'Create Tasks / Issues', 'Open new issues in the Task Tracker', 'Employee Group'),
    ('attendance.policy.view', 'View Attendance Policies', 'See attendance policy profiles, assignments and everyone\'s penalties', 'Attendance Policy Group'),
    ('attendance.policy.manage', 'Manage Attendance Policies', 'Create, edit, assign and delete policy profiles; run penalty evaluation', 'Attendance Policy Group'),
    ('attendance.penalty.waive', 'Waive Attendance Penalties', 'Waive anyone\'s attendance penalty (managers can waive their reports\')', 'Attendance Policy Group'),
    ('overtime.approve', 'Approve Overtime & Comp-off', 'See everyone\'s overtime and approve or reject it', 'Attendance Policy Group'),
    ('attendance.regularize.approve', 'Approve Regularization & Short Leave', 'Decide anyone\'s regularization and short-leave requests', 'Attendance Policy Group'),
    ('holiday.manage', 'Manage Holiday Calendars', 'Create and edit regional holiday calendars and assignments', 'Attendance Policy Group'),
    ('attendance.network.manage', 'Manage Office Networks (Wi-Fi/IP)', 'View and edit the office Wi-Fi / IP whitelist used to verify check-ins', 'Attendance Policy Group'),
]
PROJECT_CODES = ['project.view', 'project.create', 'project.edit', 'project.delete', 'project.manage']
GRANTS = {
    'Super Admin': [p[0] for p in PERMS] + PROJECT_CODES,
    'HR Manager': [p[0] for p in PERMS],
    'HR Executive': ['task.create'],
    'Manager': ['task.create', 'attendance.policy.view'],
    'Team Lead': ['task.create', 'project.view', 'project.edit'],
    'Employee': ['task.create'],
    'IT Admin': ['attendance.network.manage'],
}


def forwards(apps, schema_editor):
    Module = apps.get_model('api', 'Module')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Permission = apps.get_model('api', 'Permission')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')
    att, _ = Module.objects.get_or_create(name='Attendance', defaults={'icon': 'clock', 'order': 4, 'is_active': True})
    emp, _ = Module.objects.get_or_create(name='Employees', defaults={'icon': 'users', 'order': 3, 'is_active': True})
    groups = {
        'Attendance Policy Group': PermissionGroup.objects.get_or_create(
            name='Attendance Policy Group', defaults={
                'module': att, 'is_active': True,
                'description': 'Attendance policies, penalties, overtime, holidays, office networks and regularization'})[0],
        'Employee Group': PermissionGroup.objects.get_or_create(
            name='Employee Group', defaults={'module': emp, 'is_active': True,
                                             'description': 'Manage employee records and tasks'})[0],
    }
    by_code = {}
    for code, name, desc, group in PERMS:
        p, _ = Permission.objects.get_or_create(code=code, defaults={
            'name': name, 'description': desc, 'group': groups[group], 'is_active': True})
        by_code[code] = p
    for code in PROJECT_CODES:
        p = Permission.objects.filter(code=code).first()
        if p:
            by_code[code] = p
    for role_name, codes in GRANTS.items():
        role = Role.objects.filter(name=role_name).first()
        if not role:
            continue
        for c in codes:
            if c in by_code:
                RolePermission.objects.get_or_create(role=role, permission=by_code[c])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0105_task_views_fields_roadmap'),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
