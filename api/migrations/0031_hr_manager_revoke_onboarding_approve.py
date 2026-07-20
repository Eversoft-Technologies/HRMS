"""Revoke onboarding.approve from HR Manager.

Migration 0027 grants HR Manager view/create/edit/delete/verify/settings and
deliberately NOT approve: the onboarding workflow splits verification from
approval so that no single person can clear their own verification.

`seed_rbac` contradicted that — it granted HR Manager every permission except
rbac.manage, which swept in onboarding.approve. That is fixed at the source, but
grants are applied with get_or_create and are therefore additive: the row it
already created is never removed by re-running the seed. Any database seeded
before this migration still has it, so it has to be deleted explicitly.

Only this one grant is touched. HR Manager's other broad rights (including
onboarding.assets and onboarding.payroll, which seed_rbac also grants beyond
0027's list) are left alone — narrowing those is a separate decision.
"""
from django.db import migrations

ROLE = 'HR Manager'
CODE = 'onboarding.approve'


def forwards(apps, schema_editor):
    RolePermission = apps.get_model('api', 'RolePermission')
    RolePermission.objects.filter(
        role__name=ROLE, permission__code=CODE,
    ).delete()


def backwards(apps, schema_editor):
    """Re-grant, so the migration is reversible.

    A missing role or permission means there is nothing to restore — that is a
    valid state (the catalogue may not be seeded), not an error.
    """
    Role = apps.get_model('api', 'Role')
    Permission = apps.get_model('api', 'Permission')
    RolePermission = apps.get_model('api', 'RolePermission')

    role = Role.objects.filter(name=ROLE).first()
    perm = Permission.objects.filter(code=CODE).first()
    if role and perm:
        RolePermission.objects.get_or_create(role=role, permission=perm)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0030_candidatedocument_is_custom_candidatedocument_label_and_more'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
