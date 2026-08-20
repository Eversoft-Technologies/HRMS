from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0036_hrverification_vendor_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='hrverification',
            name='identity_verified',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='hrverification',
            name='education_verified',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='hrverification',
            name='employment_verified',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='hrverification',
            name='address_verified',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='hrverification',
            name='criminal_verified',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='hrverification',
            name='reference_verified',
            field=models.BooleanField(default=False),
        ),
    ]
