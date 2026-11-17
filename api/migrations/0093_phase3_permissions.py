"""Permissions for the Phase 3 modules.

* ticket.manage      — work the service desk: see every ticket, assign, change
                       status, reply internally. (Anyone signed in can raise
                       tickets and follow their own.)
* timesheet.approve  — approve / reject any submitted timesheet week. A
                       manager can always decide their own reports' weeks.
* attendance.audit   — read the attendance change history of anyone.

Super Admin holds every permission automatically.
"""
from django.db import migrations

PERMS = [
    ('ticket.manage', 'Manage Tickets', 'Work the service desk: view all tickets, assign, change status'),
    ('timesheet.approve', 'Approve Timesheets', 'Approve or reject submitted timesheet weeks'),
    ('attendance.audit', 'View Attendance History', 'See the field-by-field change history of attendance days'),
]
GRANTS = {
    'HR Manager': ['ticket.manage', 'timesheet.approve', 'attendance.audit'],
    'HR Executive': ['ticket.manage', 'attendance.audit'],
    'IT Admin': ['ticket.manage'],
    'Payroll Admin': ['ticket.manage'],
    'Manager': ['timesheet.approve'],
    'Team Lead': ['timesheet.approve'],
}


def forwards(apps, schema_editor):
    Module = apps.get_model('api', 'Module')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Permission = apps.get_model('api', 'Permission')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')
    module, _ = Module.objects.get_or_create(name='Workspace', defaults={'icon': 'briefcase', 'order': 10, 'is_active': True})
    group, _ = PermissionGroup.objects.get_or_create(
        name='Workspace Group', defaults={'module': module, 'is_active': True,
                                          'description': 'Service desk tickets, timesheets and attendance history'})
    by_code = {}
    for code, name, desc in PERMS:
        p, _ = Permission.objects.get_or_create(code=code, defaults={'name': name, 'description': desc,
                                                                     'group': group, 'is_active': True})
        by_code[code] = p
    for role_name, codes in GRANTS.items():
        role = Role.objects.filter(name=role_name).first()
        if not role:
            continue
        for c in codes:
            RolePermission.objects.get_or_create(role=role, permission=by_code[c])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0092_phase3_tickets_timesheets_audit'),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
