"""Add ``attendance.manage_arrangement``.

Deciding that someone is permanently remote, or that their hybrid week is three
days instead of two, is a bigger call than correcting a mistyped punch — and it
is the control the geofence ultimately rests on, since a 'remote' arrangement
exempts every check-in from it. It gets its own code so it can be granted (and
withheld) independently of attendance.edit.

Seeded to Super Admin and HR Manager. Unlike the approval permissions in 0040
this does not inherit from an existing grant, because there is no predecessor:
arrangements did not exist before, so nobody loses an ability they had.
"""
from django.db import migrations


CODE = 'attendance.manage_arrangement'
NAME = 'Manage Work Arrangements (onsite / hybrid / remote)'
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
    dependencies = [('api', '0042_work_arrangement')]
    operations = [migrations.RunPython(forwards, backwards)]
