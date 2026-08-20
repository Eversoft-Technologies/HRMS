"""Scope the Work Submissions queue: add ``submission.view_all``.

Every role that could open Work Submissions saw *every* submission in the
company, because the list endpoint returned the whole table to anyone holding
``employee.view``. An Employee only ever needs their own, and showing them
colleagues' titles, summaries and reviewer notes leaks more than the module was
ever meant to expose.

Split viewing from viewing-everything, the same way ``recruitment.kpi.view_own``
and ``recruitment.kpi.view_org`` split the KPI dashboard in migration 0023:

  employee.view        — reach the module (unchanged)
  submission.view_all  — see the whole queue rather than just your own

Backfill so nobody loses access on deploy: every role that can already reach the
module keeps the full queue, *except* Employee — which is the point of the
change. Roles are matched by the permission they hold, not by name, so a custom
role that was granted ``employee.view`` keeps behaving as it does today.
"""
from django.db import migrations


CODE = 'submission.view_all'
NAME = 'View All Submissions'

# The one role that is deliberately narrowed to its own submissions.
SCOPED_TO_OWN = ['Employee']


def forwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')

    # Slot it beside the other submission/employee codes.
    base = Permission.objects.filter(code='employee.view').first()
    gid = base.group_id if base and base.group_id else None
    if gid is None:
        g = PermissionGroup.objects.filter(name='Employee Group').first()
        gid = g.id if g else None

    perm, _ = Permission.objects.get_or_create(
        code=CODE, defaults={'name': NAME, 'group_id': gid, 'is_active': True})
    perm.name = NAME
    perm.group_id = gid
    perm.is_active = True
    perm.save()

    if not base:
        return

    scoped_ids = set(
        Role.objects.filter(name__in=SCOPED_TO_OWN).values_list('id', flat=True))
    for rid in RolePermission.objects.filter(
        permission=base
    ).values_list('role_id', flat=True).distinct():
        if rid in scoped_ids:
            continue
        RolePermission.objects.get_or_create(role_id=rid, permission=perm)


def backwards(apps, schema_editor):
    """Deliberately a no-op.

    Rolling back cannot restore "everyone sees the whole queue" — that lived in
    the view, not in the data. Deactivating the permission here would do the
    opposite of a rollback: with the new view still deployed, every role except
    Super Admin would drop to seeing only their own submissions. Leaving the
    permission and its grants in place means a code-only rollback keeps today's
    behaviour, and re-applying is a no-op.
    """
    return


class Migration(migrations.Migration):
    dependencies = [('api', '0053_alter_chatmeeting_options')]
    operations = [migrations.RunPython(forwards, backwards)]
