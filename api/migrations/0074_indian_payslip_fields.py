"""
Add Indian statutory fields to EmployeeCompensation and Payslip models
for generating payslips in the Eversoft Indian payslip format.
"""
from django.db import migrations, models
from decimal import Decimal


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0073_merge_20261028_2347'),
    ]

    operations = [
        # ── EmployeeCompensation: Indian statutory fields ──
        migrations.AddField(
            model_name='employeecompensation',
            name='employee_code',
            field=models.CharField(max_length=40, default='', blank=True),
        ),
        migrations.AddField(
            model_name='employeecompensation',
            name='pan_number',
            field=models.CharField(max_length=20, default='', blank=True),
        ),
        migrations.AddField(
            model_name='employeecompensation',
            name='uan_number',
            field=models.CharField(max_length=20, default='', blank=True),
        ),
        migrations.AddField(
            model_name='employeecompensation',
            name='pf_account_number',
            field=models.CharField(max_length=60, default='', blank=True),
        ),
        migrations.AddField(
            model_name='employeecompensation',
            name='bank_account_number',
            field=models.CharField(max_length=40, default='', blank=True),
        ),
        migrations.AddField(
            model_name='employeecompensation',
            name='bank_name',
            field=models.CharField(max_length=100, default='', blank=True),
        ),
        # Change currency default from USD to INR
        migrations.AlterField(
            model_name='employeecompensation',
            name='currency',
            field=models.CharField(max_length=10, default='INR'),
        ),

        # ── PayComponent: display_order + employer type ──
        migrations.AddField(
            model_name='paycomponent',
            name='display_order',
            field=models.IntegerField(default=0),
        ),

        # ── Payslip: employer contribution + statutory snapshot fields ──
        migrations.AddField(
            model_name='payslip',
            name='employer_contribution',
            field=models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00')),
        ),
        migrations.AddField(
            model_name='payslip',
            name='total_ctc',
            field=models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00')),
        ),
        migrations.AddField(
            model_name='payslip',
            name='employer_contributions_data',
            field=models.JSONField(default=list, blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='employee_code',
            field=models.CharField(max_length=40, default='', blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='pan_number',
            field=models.CharField(max_length=20, default='', blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='uan_number',
            field=models.CharField(max_length=20, default='', blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='pf_account_number',
            field=models.CharField(max_length=60, default='', blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='bank_account_number',
            field=models.CharField(max_length=40, default='', blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='bank_name',
            field=models.CharField(max_length=100, default='', blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='designation',
            field=models.CharField(max_length=120, default='', blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='doj',
            field=models.DateField(null=True, blank=True),
        ),
        migrations.AddField(
            model_name='payslip',
            name='month_days',
            field=models.IntegerField(default=30),
        ),
    ]
