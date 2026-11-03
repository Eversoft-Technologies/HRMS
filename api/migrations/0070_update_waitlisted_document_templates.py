import hashlib

from django.db import migrations


OLD_HASHES = {
    'Waitlisted 1': (
        'b7b187ebba89d35eb331f547887257068bbd169a65a4422d88dd18a84c92b535',
        '394e906db722870bc6453df63a1afe26b7f60853e68d04edddad11c63e112495',
    ),
    'Waitlisted 2': (
        'c6cd9314be6cce57a606323afe71738a34da0492cc34af6612b7089f79219aae',
        '5bc55c89d3c286bc84f9a093bb0cef8aa1b4cc1dba7d8367ae902c89f8876835',
    ),
    'Waitlisted 3': (
        'd25ab5f8ce1d3a358211de4516c0997841f4d315849325507988a9f358e1aaf5',
        'e8552be46c46afed18c2f97f39e0f5e4dd7626b40f10798322037b8b4ea0d965',
    ),
}

NEW_DEFAULTS = {
    'Waitlisted 1': (
        'Your Application Status — {{company}}',
        'Dear {{name}},<br><br>Thank you for your patience following your interview for the '
        '<strong>{{role}}</strong> position at {{company}}.<br><br>'
        'We want to keep you informed: your application is currently on our reserve shortlist. '
        'While we have extended an offer to another candidate at this time, we were genuinely '
        'impressed by your profile and would like to keep your candidacy active.<br><br>'
        '<strong>WHAT THIS MEANS FOR YOU</strong><br>'
        '<ul><li>You will be contacted within 2–4 weeks with a definitive update.</li>'
        '<li>If a position opens up, you will be among the first considered.</li>'
        '<li>No further interview rounds are required at this stage.</li></ul>'
        'We appreciate your understanding and continued interest in {{company}}. '
        'Please do not hesitate to reach out to your recruiter if you have any questions in the meantime.'
        '<br><br>With appreciation and anticipation,<br>{{company}} Talent Team',
    ),
    'Waitlisted 2': (
        'A Brief Update on Your Application — {{company}}',
        'Dear {{name}},<br><br>We want to reach out regarding your interview for the '
        '<strong>{{role}}</strong> position and provide a transparent update on where things stand.'
        '<br><br>Our hiring decision has been temporarily paused due to internal team '
        'restructuring. This is in no way a reflection of your candidacy: you remain among our '
        'strongest applicants, and we hold your application in high regard.<br><br>'
        '<strong>EXPECTED TIMELINE</strong><br><ul>'
        '<li>Current status: Decision on hold while internal review is in progress.</li>'
        '<li>Next update: Your assigned recruiter will share the decision timeline with you.</li>'
        '<li>Your position: Priority candidate; no re-interview is needed.</li>'
        '<li>Point of contact: Your assigned recruiter.</li></ul>'
        'We sincerely apologize for the uncertainty and appreciate your patience. Your assigned '
        'recruiter will share a final decision as soon as the review is complete.<br><br>'
        'With transparency and respect,<br>{{company}} Talent Team',
    ),
    'Waitlisted 3': (
        "You're in Our Active Talent Pipeline — {{company}}",
        'Dear {{name}},<br><br>We wanted to personally reach out following your interview for '
        'the <strong>{{role}}</strong> position. While we have filled the immediate opening, '
        'we are actively exploring additional opportunities and your profile is the kind of '
        'talent we are looking for.<br><br>You have been added to our Active Talent Pipeline, '
        'a curated group of high-potential candidates we consider as new opportunities emerge. '
        'This is a deliberate decision by our hiring team.<br><br>'
        '<strong>WHAT BEING IN THE PIPELINE MEANS</strong><br><ul>'
        '<li>Priority access: You can skip the initial screening for a future matched role.</li>'
        '<li>Direct notification: Your recruiter will contact you before matched roles are publicly posted.</li>'
        '<li>Dedicated contact: Your assigned recruiter remains your point of contact.</li>'
        '<li>Active for six months from the date of this update.</li></ul>'
        'Thank you for considering {{company}}. We look forward to finding the right opportunity.'
        '<br><br>With optimism and appreciation,<br>{{company}} Talent Team',
    ),
}


def update_unchanged_waitlisted_templates(apps, schema_editor):
    EmailTemplate = apps.get_model('api', 'EmailTemplate')
    for name, (subject_hash, body_hash) in OLD_HASHES.items():
        template = EmailTemplate.objects.filter(name=name, is_builtin=True).first()
        if not template:
            continue

        new_subject, new_body = NEW_DEFAULTS[name]
        update_fields = []
        if hashlib.sha256(template.subject.encode('utf-8')).hexdigest() == subject_hash:
            template.subject = new_subject
            update_fields.append('subject')
        if hashlib.sha256(template.body.encode('utf-8')).hexdigest() == body_hash:
            template.body = new_body
            update_fields.append('body')
        if update_fields:
            template.save(update_fields=update_fields + ['updated_at'])


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0069_update_selected_document_templates'),
    ]

    operations = [
        migrations.RunPython(update_unchanged_waitlisted_templates, migrations.RunPython.noop),
    ]