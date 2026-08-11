"""Give the two attendance approval decisions permissions of their own.

Both decisions were riding on permissions that mean something else:

  * approving/rejecting a WFH request needed ``settings.manage`` — the
    company-configuration permission, so granting someone the ability to sign
    off a day at home also handed them the SMTP credentials and the pay cycle.
  * approving/rejecting an off-site check-in needed ``attendance.edit`` — "Edit
    Attendance Log". Anyone trusted to correct a mistyped punch could also clear
    a check-in from outside the geofence, which is the control the fence exists
    to provide.

They are separate codes rather than one ``attendance.approve`` because they are
different decisions: a WFH request is a scheduling matter agreed in advance,
while an off-site approval is a live "this person is not where they should be
right now" judgement. A team lead may reasonably own the first without the
second. Sites that want them together simply grant both — which is what the
seed below does, so behaviour is unchanged on day one.

Granted to whoever currently holds the borrowed permission, not to a fixed list
of role names. A site that moved WFH approval onto a custom "Team Lead" role
keeps working after this migration instead of silently losing the ability to
approve anything.
"""
from django.db import migrations


NEW_PERMS = [
    # code, name, permission it is being split out of
    ('attendance.approve_wfh', 'Approve / Reject WFH Requests', 'settings.manage'),
    ('attendance.approve_offsite', 'Approve / Reject Off-site Check-ins', 'attendance.edit'),
]

# Seeded in addition to the inheritance above, so a fresh install where nobody
# holds the old permissions yet still has working approvals.
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

    for code, name, inherit_from in NEW_PERMS:
        perm, _ = Permission.objects.get_or_create(
            code=code, defaults={'name': name, 'group_id': gid, 'is_active': True})
        perm.name = name
        perm.group_id = gid
        perm.is_active = True
        perm.save()

        role_ids = set(Role.objects.filter(name__in=SEED_ROLES).values_list('id', flat=True))

        # Carry the grant across from the permission this one was split out of,
        # so nobody who can approve today loses the ability tomorrow.
        old = Permission.objects.filter(code=inherit_from).first()
        if old:
            role_ids.update(
                RolePermission.objects.filter(permission=old).values_list('role_id', flat=True)
            )

        for rid in role_ids:
            RolePermission.objects.get_or_create(role_id=rid, permission=perm)


def backwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    Permission.objects.filter(code__in=[c for c, _, _ in NEW_PERMS]).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0039_payroll_engine_models')]
    operations = [migrations.RunPython(forwards, backwards)]
