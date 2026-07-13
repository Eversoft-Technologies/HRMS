"""Add the ``attendance.remote`` permission.

Switching to Remote was previously unguarded: anyone could POST a
``remote-switch`` event (or check in with a "Home" location) and be marked
Remote, which made the WfhRequest approval workflow purely advisory.

Remote now requires an approved WFH request for the day, OR this permission for
staff who are permanently remote/hybrid and shouldn't file one every day.

Granted on install to the roles that already administer attendance (Super Admin
and HR Manager) so admins are not locked out of their own toggle. Everyone else
goes through the approval flow.
"""
from django.db import migrations


CODE = 'attendance.remote'
NAME = 'Work Remotely (no approval needed)'
SEED_ROLES = ['Super Admin', 'HR Manager']


def forwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')

    base = Permission.objects.filter(code='attendance.view').first()
    gid = base.group_id if base and base.group_id else None
    if gid is None:
        g = PermissionGroup.objects.filter(name='Attendance Group').first()
        gid = g.id if g else None

    perm, _ = Permission.objects.get_or_create(
        code=CODE, defaults={'name': NAME, 'group_id': gid, 'is_active': True})
    perm.name = NAME
    perm.group_id = gid
    perm.is_active = True
    perm.save()

    for rid in Role.objects.filter(name__in=SEED_ROLES).values_list('id', flat=True):
        RolePermission.objects.get_or_create(role_id=rid, permission=perm)


def backwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    Permission.objects.filter(code=CODE).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0024_backfill_leave_days')]
    operations = [migrations.RunPython(forwards, backwards)]
