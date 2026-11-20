"""Split the single ``Recruiter`` role into ``Recruiter (India)`` and
``Recruiter (USA)``.

The existing role is renamed in place so every user already assigned to it
keeps the assignment and its grants. ``Recruiter (USA)`` starts with the same
permissions as the India role; adjust either one from Settings > Access Control.
"""
from django.db import migrations

OLD = 'Recruiter'
INDIA = 'Recruiter (India)'
USA = 'Recruiter (USA)'


def split_recruiter(apps, schema_editor):
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')

    india = Role.objects.filter(name=INDIA).first()
    old = Role.objects.filter(name=OLD).first()
    if old and not india:
        old.name = INDIA
        old.description = 'Create and edit onboarding candidates (India)'
        old.save(update_fields=['name', 'description'])
        india = old
    if not india:
        india = Role.objects.create(
            name=INDIA, description='Create and edit onboarding candidates (India)', is_active=True)

    usa, _ = Role.objects.get_or_create(
        name=USA,
        defaults={'description': 'Create and edit onboarding candidates (USA)', 'is_active': True})
    for perm_id in RolePermission.objects.filter(role=india).values_list('permission_id', flat=True):
        RolePermission.objects.get_or_create(role=usa, permission_id=perm_id)


def merge_back(apps, schema_editor):
    Role = apps.get_model('api', 'Role')
    AppUser = apps.get_model('api', 'AppUser')
    india = Role.objects.filter(name=INDIA).first()
    usa = Role.objects.filter(name=USA).first()
    if usa:
        if india:
            AppUser.objects.filter(role_ref=usa).update(role_ref=india)
        usa.delete()
    if india and not Role.objects.filter(name=OLD).exists():
        india.name = OLD
        india.description = 'Create and edit onboarding candidates'
        india.save(update_fields=['name', 'description'])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0081_ai_settings_and_notification_prefs'),
    ]

    operations = [
        migrations.RunPython(split_recruiter, merge_back),
    ]
