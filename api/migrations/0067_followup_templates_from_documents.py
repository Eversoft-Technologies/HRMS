from django.db import migrations


OLD_DEFAULTS = {
    'Selected — default': (
        'Congratulations! Offer for {{role}} at {{company}}',
        'Dear {{name}},<br><br>'
        'We are delighted to let you know that you have been <strong>selected</strong> for the '
        '<strong>{{role}}</strong> position at {{company}}. The whole panel was impressed by your '
        'performance during the interview.<br><br>'
        'Our HR team will reach out shortly with your offer details and onboarding steps. '
        'We are looking forward to having you join us, with a tentative start in the first week of next month.'
        '<br><br>Warm regards,<br>The {{company}} Talent Team',
    ),
    'Waitlisted — default': (
        'Your application for {{role}} at {{company}}',
        'Dear {{name}},<br><br>'
        'Thank you for interviewing for the <strong>{{role}}</strong> position. You did really well, '
        'and we have placed your application on our <strong>waitlist</strong>. Should a suitable '
        'opening become available, we will be in touch right away.<br><br>'
        'We genuinely appreciate the time and energy you invested in the process.<br><br>'
        'Warm regards,<br>The {{company}} Talent Team',
    ),
    'Rejected — default': (
        'Update on your application for {{role}} at {{company}}',
        'Dear {{name}},<br><br>'
        'Thank you for taking the time to interview for the <strong>{{role}}</strong> position and for '
        'your interest in {{company}}. After careful consideration, we have decided not to move forward '
        'with your application at this time.<br><br>'
        'This was a difficult decision — we encourage you to apply for future roles that match your '
        'skills. We wish you the very best in your job search.<br><br>'
        'Warm regards,<br>The {{company}} Talent Team',
    ),
}


NEW_DEFAULTS = {
    'Selected — default': (
        'Congratulations! Offer for {{role}} at {{company}}',
        'Dear {{name}},<br><br>'
        'We are delighted to inform you that after careful consideration, you have been selected '
        'for the <strong>{{role}}</strong> position at {{company}}. The entire '
        'interview panel was genuinely impressed by your knowledge, approach, and the clarity you '
        'brought to each discussion. You stood out among a highly competitive field of candidates, '
        'and we are confident you will be a valuable addition to the team.<br><br>'
        '<strong>WHAT HAPPENS NEXT</strong><br>'
        '<ul><li>Our HR team will contact you within 2–3 business days with your formal offer letter.</li>'
        '<li>You will receive complete onboarding details and next steps.</li>'
        '<li>Your tentative start date will be confirmed in your formal offer letter.</li></ul>'
        'We look forward to welcoming you to {{company}} and building great things together.'
        '<br><br>With warmest congratulations,<br>{{company}} Talent Team',
    ),
    'Waitlisted — default': (
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
    'Rejected — default': (
        'Update on Your Application — {{company}}',
        'Dear {{name}},<br><br>Thank you sincerely for the time and effort you invested in interviewing '
        'for the <strong>{{role}}</strong> position at {{company}}.<br><br>'
        'After thorough evaluation of all candidates, we regret to inform you that we will not be '
        'moving forward with your application at this time. This was a highly competitive process, '
        'and this decision does not diminish the strengths and qualities you demonstrated throughout.'
        '<br><br><strong>A FEW THOUGHTS</strong><br>'
        '<ul><li>We encourage you to apply again for future roles that align with your profile.</li>'
        '<li>Your résumé will remain in our talent pool for 12 months.</li>'
        '<li>You are welcome to request feedback by replying to your assigned recruiter.</li></ul>'
        'We genuinely appreciate your interest in {{company}} and wish you every success '
        'in your career journey ahead.<br><br>With appreciation and best wishes,'
        '<br>{{company}} Talent Team',
    ),
}


def upgrade_unchanged_builtins(apps, schema_editor):
    EmailTemplate = apps.get_model('api', 'EmailTemplate')
    for name, (old_subject, old_body) in OLD_DEFAULTS.items():
        template = EmailTemplate.objects.filter(name=name, is_builtin=True).first()
        if not template:
            continue
        new_subject, new_body = NEW_DEFAULTS[name]
        update_fields = []
        if template.subject == old_subject:
            template.subject = new_subject
            update_fields.append('subject')
        if template.body == old_body:
            template.body = new_body
            update_fields.append('body')
        if update_fields:
            template.save(update_fields=update_fields)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0066_merge_20260910_1919'),
    ]

    operations = [
        migrations.RunPython(upgrade_unchanged_builtins, migrations.RunPython.noop),
    ]