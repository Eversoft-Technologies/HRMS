"""US date format (MM/DD/YYYY) by default.

The company date format setting (Settings › General) drives every date the app
shows. The business asked for US dates, so the default becomes MM/DD/YYYY and
a company still on the old default (DD/MM/YYYY) or blank is switched once.
A company that deliberately picked another format (YYYY-MM-DD, DD MMM YYYY)
keeps it, and anyone can still change it in Settings › General.
"""
from django.db import migrations, models


def to_us(apps, schema_editor):
    CompanyDetail = apps.get_model('api', 'CompanyDetail')
    CompanyDetail.objects.filter(date_format__in=['DD/MM/YYYY', '']).update(date_format='MM/DD/YYYY')


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0089_appuser_is_superadmin'),
    ]

    operations = [
        migrations.AlterField(
            model_name='companydetail',
            name='date_format',
            field=models.CharField(blank=True, default='MM/DD/YYYY', max_length=30),
        ),
        migrations.RunPython(to_us, migrations.RunPython.noop),
    ]
