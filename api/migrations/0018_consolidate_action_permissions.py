"""Consolidate the separate approve/reject permissions into a single "Action"
permission per module.

Leave and Work Submissions used to expose two permissions each
(leave.approve/leave.reject, submission.approve/submission.reject). Admins asked
for one "Action" permission per module — granting it lets a user both approve and
reject. This migration creates leave.action / submission.action, grants them to
any role that held either of the old permissions, and deactivates the old ones so
they disappear from the RBAC editor.
"""
from django.db import migrations


PAIRS = [
    ('leave.action', 'Action (Approve / Reject)', ['leave.approve', 'leave.reject'], 'Leave Group'),
    ('submission.action', 'Action (Approve / Reject)', ['submission.approve', 'submission.reject'], 'Employee Group'),
]
OLD_CODES = ['leave.approve', 'leave.reject', 'submission.approve', 'submission.reject']
NEW_CODES = ['leave.action', 'submission.action']


def forwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    RolePermission = apps.get_model('api', 'RolePermission')

    for new_code, new_name, old_codes, group_name in PAIRS:
        # Inherit the group from an existing old permission, else look it up by name.
        gid = None
        for oc in old_codes:
            op = Permission.objects.filter(code=oc).first()
            if op and op.group_id:
                gid = op.group_id
                break
        if gid is None:
            g = PermissionGroup.objects.filter(name=group_name).first()
            gid = g.id if g else None

        newp, _ = Permission.objects.get_or_create(
            code=new_code, defaults={'name': new_name, 'group_id': gid, 'is_active': True})
        # Ensure it's active + correctly named/grouped even if it already existed.
        newp.name = new_name
        newp.group_id = gid
        newp.is_active = True
        newp.save()

        # Grant the new permission to every role that held either old permission.
        old_perms = list(Permission.objects.filter(code__in=old_codes))
        role_ids = set(
            RolePermission.objects.filter(permission__in=old_perms).values_list('role_id', flat=True))
        for rid in role_ids:
            RolePermission.objects.get_or_create(role_id=rid, permission=newp)

        # Retire the old permissions.
        Permission.objects.filter(code__in=old_codes).update(is_active=False)


def backwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    Permission.objects.filter(code__in=OLD_CODES).update(is_active=True)
    Permission.objects.filter(code__in=NEW_CODES).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0017_jobpost_status_comment_alter_jobpost_status')]
    operations = [migrations.RunPython(forwards, backwards)]
