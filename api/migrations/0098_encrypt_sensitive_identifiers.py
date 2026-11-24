"""Widen the columns of sensitive identifiers so they can hold ciphertext, and
add the passport blind index.

Schema only. This migration deliberately does NOT encrypt anything: a deploy
must never encrypt data with a missing or temporary key. Existing plain values
keep working (they are read as legacy plain text) until an operator runs

    python manage.py encrypt_sensitive_fields --dry-run
    python manage.py encrypt_sensitive_fields --i-have-backed-up-the-key

Reversing it narrows the columns again, which is only safe after
``encrypt_sensitive_fields --decrypt`` has turned the values back to plain text.
"""
from django.db import migrations, models

import api.fields


def _enc():
    return api.fields.EncryptedCharField(blank=True, default='', max_length=512)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0097_attendance_phase1'),
    ]

    operations = [
        migrations.AlterField(model_name='benchsalesprofile', name='passport_no', field=_enc()),
        migrations.AddField(
            model_name='benchsalesprofile',
            name='passport_no_hash',
            field=models.CharField(blank=True, db_index=True, default='', max_length=64),
        ),
        migrations.AlterField(model_name='payrollinformation', name='account_number', field=_enc()),
        migrations.AlterField(model_name='employeecompensation', name='pan_number', field=_enc()),
        migrations.AlterField(model_name='employeecompensation', name='uan_number', field=_enc()),
        migrations.AlterField(model_name='employeecompensation', name='pf_account_number', field=_enc()),
        migrations.AlterField(model_name='employeecompensation', name='bank_account_number', field=_enc()),
        migrations.AlterField(model_name='payslip', name='pan_number', field=_enc()),
        migrations.AlterField(model_name='payslip', name='uan_number', field=_enc()),
        migrations.AlterField(model_name='payslip', name='pf_account_number', field=_enc()),
        migrations.AlterField(model_name='payslip', name='bank_account_number', field=_enc()),
        migrations.AlterField(model_name='payrollpayment', name='account_number', field=_enc()),
    ]
