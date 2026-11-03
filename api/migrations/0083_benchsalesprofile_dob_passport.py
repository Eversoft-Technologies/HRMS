# Bench Sales profile: Date of Birth and Passport No, collected on the
# New/Edit Profile form below Contact No. Nullable/blank so existing profiles
# stay valid until someone fills them in.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0082_benchsalescertificate_kind'),
    ]

    operations = [
        migrations.AddField(
            model_name='benchsalesprofile',
            name='date_of_birth',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='benchsalesprofile',
            name='passport_no',
            field=models.CharField(blank=True, default='', max_length=40),
        ),
    ]
