from django.db import migrations


def rename_single_defaults(apps, schema_editor):
    EmailTemplate = apps.get_model('api', 'EmailTemplate')
    for outcome in ('Selected', 'Waitlisted', 'Rejected'):
        old_name = f'{outcome} — default'
        new_name = f'{outcome} 1'
        template = EmailTemplate.objects.filter(name=old_name, is_builtin=True).first()
        if not template:
            continue
        if EmailTemplate.objects.filter(name=new_name).exists():
            continue
        template.name = new_name
        template.save(update_fields=['name'])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0067_followup_templates_from_documents'),
    ]

    operations = [
        migrations.RunPython(rename_single_defaults, migrations.RunPython.noop),
    ]