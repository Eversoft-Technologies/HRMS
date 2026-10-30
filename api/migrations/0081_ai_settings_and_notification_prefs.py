"""Per-user notification preferences, the server-managed AI key, its audit
trail, and the two AI-settings permissions.

``ai.settings.view`` / ``ai.settings.manage`` are deliberately NOT inherited
from ``settings.view`` / ``settings.manage``: being able to see the company's
general settings must not imply being able to read or replace the AI provider
key. On day one they are granted to the Super Admin role only (Super Admins
pass every check anyway); other administrators get them explicitly from
Settings > Access Control.
"""
from django.db import migrations, models


NEW_PERMS = [
    ('ai.settings.view', 'View AI Settings (status, provider, model)'),
    ('ai.settings.manage', 'Manage AI Settings (save / rotate / remove the API key)'),
]
SEED_ROLES = ['Super Admin']


def forwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    PermissionGroup = apps.get_model('api', 'PermissionGroup')
    Role = apps.get_model('api', 'Role')
    RolePermission = apps.get_model('api', 'RolePermission')

    base = Permission.objects.filter(code='settings.manage').first()
    gid = base.group_id if base and base.group_id else None
    if gid is None:
        g = PermissionGroup.objects.filter(name='Settings Group').first()
        gid = g.id if g else None

    role_ids = list(Role.objects.filter(name__in=SEED_ROLES).values_list('id', flat=True))
    for code, name in NEW_PERMS:
        perm, _ = Permission.objects.get_or_create(
            code=code, defaults={'name': name, 'group_id': gid, 'is_active': True})
        perm.name, perm.group_id, perm.is_active = name, gid, True
        perm.save()
        for rid in role_ids:
            RolePermission.objects.get_or_create(role_id=rid, permission=perm)


def backwards(apps, schema_editor):
    Permission = apps.get_model('api', 'Permission')
    Permission.objects.filter(code__in=[c for c, _ in NEW_PERMS]).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [('api', '0080_home_capture_method')]

    operations = [
        migrations.CreateModel(
            name='NotificationPreference',
            fields=[
                ('email', models.CharField(max_length=255, primary_key=True, serialize=False)),
                ('prefs', models.JSONField(blank=True, default=dict)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={'db_table': 'notification_preferences'},
        ),
        migrations.CreateModel(
            name='AIProviderSetting',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('provider', models.CharField(default='anthropic', max_length=40, unique=True)),
                ('encrypted_key', models.TextField(blank=True, default='')),
                ('key_fingerprint', models.CharField(blank=True, default='', max_length=16)),
                ('validated_at', models.DateTimeField(blank=True, null=True)),
                ('updated_by', models.CharField(blank=True, default='', max_length=255)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={'db_table': 'ai_provider_settings'},
        ),
        migrations.CreateModel(
            name='AISettingsAudit',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('actor_email', models.CharField(db_index=True, max_length=255)),
                ('action', models.CharField(max_length=40)),
                ('provider', models.CharField(default='anthropic', max_length=40)),
                ('key_fingerprint', models.CharField(blank=True, default='', max_length=16)),
                ('detail', models.CharField(blank=True, default='', max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={'db_table': 'ai_settings_audit', 'ordering': ['-created_at', '-id']},
        ),
        migrations.RunPython(forwards, backwards),
    ]
