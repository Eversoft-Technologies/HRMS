"""Add a Team Lead role.

Team Lead was added to the Work Submissions reviewer dropdown and to the
sign-in role selector, but no such role existed. That combination fails
closed rather than silently: ``auth_views.login`` compares the selected
role against the account's assigned role and returns 403 — "The selected
role does not match this account" — so the option would have been visible
and unusable.

Permissions mirror Manager's *reviewing* duties and stop there:

  employee.view        reach the employee module and Work Submissions
  submission.view_all  see the whole submission queue, not just their own
  attendance.view      see their team's attendance
  leave.view           see leave requests
  settings.view        reach Settings

Deliberately NOT granted, because each is a decision to make explicitly
rather than inherit:

  submission.action    approve/reject submissions — no role holds this today
  leave.action         approve/reject leave — Manager's duty
  onboarding.*         a separate workflow with its own segregation of duties

Grant any of those from the RBAC screen if a lead should have them.
"""
from django.db import migrations


ROLE = 'Team Lead'
DESCRIPTION = 'Review work submitted by their team; view attendance and leave'
GRANTS = [
    'employee.view',
    'submission.view_all',
    'attendance.view',
    'leave.view',
    'settings.view',
]


def forwards(apps, schema_editor):
    Role = apps.get_model('api', 'Role')
    Permission = apps.get_model('api', 'Permission')
    RolePermission = apps.get_model('api', 'RolePermission')

    role, created = Role.objects.get_or_create(
        name=ROLE, defaults={'description': DESCRIPTION, 'is_active': True})
    if not created and not role.is_active:
        # a previously deactivated role is revived rather than duplicated
        role.is_active = True
        role.save()

    for code in GRANTS:
        perm = Permission.objects.filter(code=code, is_active=True).first()
        if perm:
            RolePermission.objects.get_or_create(role=role, permission=perm)


def backwards(apps, schema_editor):
    """Deactivate rather than delete.

    Deleting the role would cascade or orphan any AppUser.role_ref pointing at
    it, silently changing what those people can do. Deactivating leaves the
    accounts intact and reversible.
    """
    Role = apps.get_model('api', 'Role')
    Role.objects.filter(name=ROLE).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0056_chat_member_last_read_at')]
    operations = [migrations.RunPython(forwards, backwards)]
