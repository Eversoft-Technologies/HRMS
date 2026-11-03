import hashlib

from django.db import migrations


OLD_HASHES = {
    'Selected 1': (
        'aac4cf2e8d5abd6c8dacc3cb36063f45a39de6d4c0f4ff1907fa2079b7a88f38',
        'b0f488280fd319bd8afd39fac27d7ae72d1ce8d94bae0d53a771f6b70f028e0b',
    ),
    'Selected 2': (
        '3e385cd015c4ce467f5c036b1e10164dfb22374eabcd7395f0d2e6ff451220e4',
        '585c14a8f86d6d2cc691d5a457e0e3876c0e29cc87d370e93727bf988c3f6008',
    ),
    'Selected 3': (
        '58cdefc5856f5f5865cf5040e0773da7a7fb6ab6a1a2892447794897b729c708',
        '92cadada2bfc891dad468065b568da59bd167fa44b64e0d1c1bee851d7c6da62',
    ),
}

NEW_DEFAULTS = {
    'Selected 1': (
        'Congratulations! Offer for {{role}} at {{company}}',
        'Dear {{name}},<br><br>'
        'We are delighted to inform you that after careful consideration, you have been selected '
        'for the <strong>{{role}}</strong> position at {{company}}.<br><br>'
        'The entire interview panel was genuinely impressed by your knowledge, approach, and the '
        'clarity you brought to each discussion. You stood out among a highly competitive field '
        'of candidates, and we are confident you will be a valuable addition to the team.<br><br>'
        '<strong>WHAT HAPPENS NEXT</strong><br>'
        '<ul><li>Our HR team will contact you within 2–3 business days with your formal offer letter.</li>'
        '<li>You will receive complete onboarding details and next steps.</li>'
        '<li>Your tentative start date will be confirmed in your formal offer letter.</li></ul>'
        'We look forward to welcoming you to EverSoft and building great things together.'
        '<br><br>With warmest congratulations,<br>{{company}} Talent Team',
    ),
    'Selected 2': (
        'Your Formal Offer — {{company}}',
        'Dear {{name}},<br><br>On behalf of {{company}}, it is with great pleasure that we '
        'extend to you this formal offer of employment for the position of '
        '<strong>{{role}}</strong>.<br><br>Your background, expertise, and the professionalism '
        'you demonstrated throughout the selection process made a lasting impression. We are '
        'confident this is the beginning of a rewarding and long-term partnership.<br><br>'
        '<strong>OFFER SUMMARY</strong><br><ul>'
        '<li>Position: {{role}}</li>'
        '<li>Department: As detailed in your formal offer</li>'
        '<li>Start Date: As stated in your formal offer</li>'
        '<li>Annual Compensation: As detailed in your formal offer</li>'
        '<li>Employment Type: As detailed in your formal offer</li>'
        '<li>Reporting To: As detailed in your formal offer</li></ul>'
        'Please review all details and confirm your acceptance by the deadline stated in your '
        'formal offer. Your recruiter will follow up with the formal documents shortly.<br><br>'
        'With great pleasure,<br>{{company}} Talent Team',
    ),
    'Selected 3': (
        'Welcome to the {{company}} Family!',
        'Dear {{name}},<br><br>The offer has been confirmed, and we could not be more thrilled. '
        'Welcome to {{company}}! You are joining a team that values curiosity, collaboration, '
        'and impact.<br><br>As our new <strong>{{role}}</strong>, you will have the opportunity '
        'to work on meaningful challenges alongside driven people. We are genuinely excited to '
        'see what we will build together.<br><br>'
        '<strong>YOUR ONBOARDING JOURNEY</strong><br><ol>'
        '<li>Documents &amp; Verification: HR will reach out to complete paperwork within 48 hours.</li>'
        '<li>Equipment Setup: Your laptop and access credentials will be ready before Day 1.</li>'
        '<li>First Day: On the date stated in your offer, meet your team, attend orientation, and get settled in.</li>'
        '<li>30-Day Check-in: Meet 1:1 with your manager to align on goals and expectations.</li></ol>'
        'Questions before Day 1? Reach out to your recruiter. We are here for you every step of the way.'
        '<br><br>With excitement and warmth,<br>{{company}} Talent Team',
    ),
}


def update_unchanged_selected_templates(apps, schema_editor):
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
        ('api', '0068_rename_followup_template_variants'),
    ]

    operations = [
        migrations.RunPython(update_unchanged_selected_templates, migrations.RunPython.noop),
    ]