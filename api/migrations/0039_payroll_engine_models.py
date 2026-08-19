from decimal import Decimal
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0038_employeeattendance_auto_checkout_at_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='employeeattendance',
            name='is_auto_checked_out',
            field=models.BooleanField(default=False),
        ),
        migrations.CreateModel(
            name='EmployeeCompensation',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('pay_type', models.CharField(default='salaried', max_length=20)),
                ('pay_frequency', models.CharField(default='monthly', max_length=20)),
                ('base_amount', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=12)),
                ('annual_ctc', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=12)),
                ('currency', models.CharField(default='USD', max_length=10)),
                ('effective_from', models.DateField(default=django.utils.timezone.now)),
                ('effective_to', models.DateField(blank=True, null=True)),
                ('status', models.CharField(default='active', max_length=20)),
                ('notes', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'employee_compensation',
                'ordering': ['-effective_from'],
            },
        ),
        migrations.CreateModel(
            name='PayComponent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('code', models.CharField(max_length=50, unique=True)),
                ('name', models.CharField(max_length=100)),
                ('component_type', models.CharField(default='earning', max_length=20)),
                ('calc_type', models.CharField(default='fixed', max_length=30)),
                ('rate', models.DecimalField(decimal_places=4, default=Decimal('0.0000'), max_digits=8)),
                ('default_amount', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=12)),
                ('is_taxable', models.BooleanField(default=True)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'pay_components',
                'ordering': ['component_type', 'code'],
            },
        ),
        migrations.CreateModel(
            name='PayrollRun',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('period_label', models.CharField(db_index=True, max_length=20)),
                ('period_start', models.DateField()),
                ('period_end', models.DateField()),
                ('pay_date', models.DateField(blank=True, null=True)),
                ('frequency', models.CharField(default='monthly', max_length=20)),
                ('status', models.CharField(default='draft', max_length=30)),
                ('created_by', models.CharField(blank=True, default='', max_length=255)),
                ('approved_by', models.CharField(blank=True, default='', max_length=255)),
                ('approved_at', models.DateTimeField(blank=True, null=True)),
                ('total_gross', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=14)),
                ('total_deductions', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=14)),
                ('total_net', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=14)),
                ('employee_count', models.IntegerField(default=0)),
                ('notes', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'payroll_runs',
                'ordering': ['-period_start'],
            },
        ),
        migrations.CreateModel(
            name='PayrollSetting',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('key', models.CharField(max_length=100, unique=True)),
                ('value', models.TextField(blank=True, default='')),
                ('description', models.CharField(blank=True, default='', max_length=255)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'payroll_settings',
                'ordering': ['key'],
            },
        ),
        migrations.CreateModel(
            name='EmployeePayComponent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('amount', models.DecimalField(blank=True, decimal_places=2, max_digits=12, null=True)),
                ('rate', models.DecimalField(blank=True, decimal_places=4, max_digits=8, null=True)),
                ('effective_from', models.DateField(default=django.utils.timezone.now)),
                ('effective_to', models.DateField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('component', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='employee_components', to='api.paycomponent')),
            ],
            options={
                'db_table': 'employee_pay_components',
                'ordering': ['-effective_from'],
            },
        ),
        migrations.CreateModel(
            name='Payslip',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('employee_name', models.CharField(blank=True, default='', max_length=255)),
                ('worked_days', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=5)),
                ('paid_days', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=5)),
                ('lop_days', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=5)),
                ('overtime_hours', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=6)),
                ('base_salary', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=12)),
                ('gross_earnings', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=12)),
                ('total_deductions', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=12)),
                ('net_pay', models.DecimalField(decimal_places=2, default=Decimal('0.00'), max_digits=12)),
                ('earnings_data', models.JSONField(blank=True, default=list)),
                ('deductions_data', models.JSONField(blank=True, default=list)),
                ('status', models.CharField(default='draft', max_length=20)),
                ('file_name', models.CharField(blank=True, default='', max_length=255)),
                ('file_mime', models.CharField(blank=True, default='application/pdf', max_length=100)),
                ('file_size', models.IntegerField(default=0)),
                ('file_data', models.TextField(blank=True, default='')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('run', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='payslips', to='api.payrollrun')),
            ],
            options={
                'db_table': 'payslips',
                'ordering': ['employee_name', 'email'],
                'unique_together': {('run', 'email')},
            },
        ),
    ]
