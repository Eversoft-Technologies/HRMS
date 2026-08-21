from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0034_resumescore_content_hash'),
    ]

    operations = [
        migrations.AddField(
            model_name='hrverification',
            name='passport_verified',
            field=models.BooleanField(default=False),
        ),
    ]
