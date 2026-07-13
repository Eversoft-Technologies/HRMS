"""Add separate KPI dashboard scope permissions.

The KPI dashboard's "My View" / "Org View" toggle was gated on a hardcoded list
of role NAMES ('HR Manager', 'Super Admin', 'HR Executive', 'Recruitment'),
which meant a custom role could never be given org-wide KPIs and the RBAC editor
had no say in it. Replace that with two real permissions:

  recruitment.kpi.view_own — the recruiter's own numbers (My View)
  recruitment.kpi.view_org — every recruiter's numbers (Org View)

Backfill so no one loses access on deploy: any role that could already reach the
dashboard (recruitment.view) keeps My View, and any role matching the old
hardcoded admin list also keeps Org View.
"""
from django.db import migrations


NEW_PERMS = [
    ('recruitment.kpi.view_own', 'KPI Dashboard — My View'),
    ('recruitment.kpi.view_org', 'KPI Dashboard — Org View'),
]

# The role names the old code treated as "admin" for scope=all.
LEGACY_ORG_ROLES = ['HR Manager', 'Super Admin', 'HR Executive', 'Recruitment']


def forwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')

    # Slot the new codes into the same group as the existing recruitment perms.
    base = Permission.objects.filter(code='recruitment.view').first()
    gid = base.group_id if base and base.group_id else None
    if gid is None:
        g = PermissionGroup.objects.filter(name='Recruitment Group').first()
        gid = g.id if g else None

    created = {}
    for code, name in NEW_PERMS:
        p, _ = Permission.objects.get_or_create(
            code=code, defaults={'name': name, 'group_id': gid, 'is_active': True})
        p.name = name
        p.group_id = gid
        p.is_active = True
        p.save()
        created[code] = p

    own = created['recruitment.kpi.view_own']
    org = created['recruitment.kpi.view_org']

    # Anyone who could open the dashboard keeps at least their own numbers.
    if base:
        for rid in RolePermission.objects.filter(
            permission=base
        ).values_list('role_id', flat=True).distinct():
            RolePermission.objects.get_or_create(role_id=rid, permission=own)

    # Preserve org-wide access for the roles that had it by name before.
    for rid in Role.objects.filter(
        name__in=LEGACY_ORG_ROLES
    ).values_list('id', flat=True):
        RolePermission.objects.get_or_create(role_id=rid, permission=own)
        RolePermission.objects.get_or_create(role_id=rid, permission=org)


def backwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    codes = [c for c, _ in NEW_PERMS]
    Permission.objects.filter(code__in=codes).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0022_interviewlink_legacy_question_counts')]
    operations = [migrations.RunPython(forwards, backwards)]
