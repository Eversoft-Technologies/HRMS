# Bench Sales: files attached to the Certifications field are stored beside the
# Certificates uploads; `kind` tells the two lists apart (existing rows are all
# certificates).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0081_ai_settings_and_notification_prefs'),
    ]

    operations = [
        migrations.AddField(
            model_name='benchsalescertificate',
            name='kind',
            field=models.CharField(db_index=True, default='certificate', max_length=20),
        ),
    ]
