import hashlib

from django.db import migrations


OLD_HASHES = {
    'Rejected 1': (
        '5be1cd4d27a3b8756505d2764e99446c3e5f31b3c084d897098ff9b6a9a0fd7e',
        'e8757568a019535cb422cd5666c759dfd96e6adfdf682009785de030089d96ff',
    ),
    'Rejected 2': (
        '44e78d9ef7c2f16817b6db3b88390e9431e36218fe5eaf394725db6fee985527',
        '2c9d49b1c57a4ec5b8e58a8144c2510ab496705ea8b3d3f30d4cf19886bc2b9e',
    ),
    'Rejected 3': (
        'f2bf5f95dc8cbe990aea9158b52a9f56a20cbc7b533c217e158a7b9a24573dfe',
        '97ed821212b75fdcf7323d50ed0468960295ba09cd7c2902f17c2b7a4b95a3f8',
    ),
}

NEW_DEFAULTS = {
    'Rejected 1': (
        'Update on Your Application — EverSoft Technologies',
        'Dear {{name}},<br><br>Thank you sincerely for the time and effort you invested in interviewing '
        'for the <strong>{{role}}</strong> position at {{company}}.<br><br>'
        'After thorough evaluation of all candidates, we regret to inform you that we will not be '
        'moving forward with your application at this time. This was a highly competitive process, '
        'and this decision does not diminish the strengths and qualities you demonstrated throughout.'
        '<br><br><strong>A FEW THOUGHTS</strong><br>'
        '<ul><li>We encourage you to apply again for future roles that align with your profile.</li>'
        '<li>Your résumé will remain in our talent pool for 12 months.</li>'
        '<li>You are welcome to request feedback by replying to your assigned recruiter.</li></ul>'
        'We genuinely appreciate your interest in EverSoft and wish you every success in your career journey.'
        '<br><br>With appreciation and best wishes,<br>EverSoft Talent Team',
    ),
    'Rejected 2': (
        'Your Application Outcome & Feedback — {{company}}',
        'Dear {{name}},<br><br>Thank you for interviewing for the <strong>{{role}}</strong> role at '
        '{{company}}. We valued the time you dedicated and the thoughtful answers you shared throughout '
        'the process.<br><br>After careful deliberation, we have decided to proceed with another '
        'candidate whose experience more closely aligns with our current needs. If you would like a '
        'personalized feedback summary on your interview, please contact your assigned recruiter.'
        '<br><br>We hope that feedback will support your continued growth. We would genuinely welcome '
        'your application for a future role at {{company}}.<br><br>'
        'With respect and gratitude,<br>{{company}} Talent Team',
    ),
    'Rejected 3': (
        "We'd Love to Stay in Touch — {{company}}",
        'Dear {{name}},<br><br>Thank you for interviewing for the <strong>{{role}}</strong> position. '
        'Your conversation left a genuine impression on our team. We have moved forward with a candidate '
        'whose experience more closely matched the immediate requirements of this role.<br><br>'
        'We would like to keep the relationship open. As {{company}} grows, the right opportunity for '
        'someone with your background may be just around the corner.<br><br>'
        '<strong>STAY CONNECTED WITH {{company}}</strong><br><ul>'
        '<li>Your profile will remain active in our talent pool for 12 months.</li>'
        '<li>Subscribe to our careers page for new openings.</li>'
        '<li>Follow {{company}} on LinkedIn for company news.</li>'
        '<li>Reach out to your assigned recruiter if a new role interests you.</li></ul>'
        'We wish you the very best in your search and hope our paths cross again soon.'
        '<br><br>With warm regards,<br>{{company}} Talent Team',
    ),
}


def update_unchanged_rejected_templates(apps, schema_editor):
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
        ('api', '0070_update_waitlisted_document_templates'),
    ]

    operations = [
        migrations.RunPython(update_unchanged_rejected_templates, migrations.RunPython.noop),
    ]