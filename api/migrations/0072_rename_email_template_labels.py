from django.db import migrations


RENAMES = {
    'Selected 1': 'Selected — Offer',
    'Selected 2': 'Selected — Formal Letter',
    'Selected 3': 'Selected — Welcome',
    'Waitlisted 1': 'Waitlisted — Reserve Shortlist',
    'Waitlisted 2': 'Waitlisted — Decision Delayed',
    'Waitlisted 3': 'Waitlisted — Active Pipeline',
    'Rejected 1': 'Rejected — Standard Decline',
    'Rejected 2': 'Rejected — With Feedback',
    'Rejected 3': 'Rejected — Future Opportunities',
}


def rename_builtin_templates(apps, schema_editor):
    EmailTemplate = apps.get_model('api', 'EmailTemplate')
    for old_name, new_name in RENAMES.items():
        template = EmailTemplate.objects.filter(name=old_name, is_builtin=True).first()
        if not template or EmailTemplate.objects.filter(name=new_name).exists():
            continue
        template.name = new_name
        template.save(update_fields=['name'])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0071_update_rejected_document_templates'),
    ]

    operations = [
        migrations.RunPython(rename_builtin_templates, migrations.RunPython.noop),
    ]