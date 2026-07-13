"""
Migration to add advanced attendance management models.
Created: 2024-07-08
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0014_attendancecorrection_geofence_shift_wfhrequest_and_more'),
    ]

    operations = [
        # BreakPolicy model
        migrations.CreateModel(
            name='BreakPolicy',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(default='Default', max_length=100)),
                ('max_break_minutes_per_day', models.IntegerField(default=60)),
                ('min_break_minutes', models.IntegerField(default=15)),
                ('max_break_minutes', models.IntegerField(default=60)),
                ('is_paid', models.BooleanField(default=False)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'break_policies',
                'ordering': ['name'],
            },
        ),

        # Break model
        migrations.CreateModel(
            name='Break',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('employee_name', models.CharField(blank=True, default='', max_length=255)),
                ('date', models.DateField(db_index=True)),
                ('break_start', models.DateTimeField()),
                ('break_end', models.DateTimeField(blank=True, null=True)),
                ('break_type', models.CharField(default='meal', max_length=20)),
                ('reason', models.CharField(blank=True, default='', max_length=255)),
                ('is_paid', models.BooleanField(default=False)),
                ('break_minutes', models.IntegerField(default=0)),
                ('status', models.CharField(default='active', max_length=20)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'employee_breaks',
                'ordering': ['-date', '-break_start'],
            },
        ),

        # LateCheckInPolicy model
        migrations.CreateModel(
            name='LateCheckInPolicy',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(default='Default', max_length=100)),
                ('late_threshold_minutes', models.IntegerField(default=5)),
                ('escalation_count', models.IntegerField(default=3)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'late_checkin_policies',
                'ordering': ['name'],
            },
        ),

        # LateCheckInAlert model
        migrations.CreateModel(
            name='LateCheckInAlert',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('employee_name', models.CharField(blank=True, default='', max_length=255)),
                ('date', models.DateField(db_index=True)),
                ('late_minutes', models.IntegerField(default=0)),
                ('check_in_time', models.DateTimeField()),
                ('shift_start_time', models.DateTimeField()),
                ('reason', models.CharField(blank=True, default='', max_length=255)),
                ('is_excused', models.BooleanField(default=False)),
                ('excused_by', models.CharField(blank=True, default='', max_length=255)),
                ('excused_at', models.DateTimeField(blank=True, null=True)),
                ('escalated', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'db_table': 'late_checkin_alerts',
                'ordering': ['-date', '-id'],
            },
        ),

        # OvertimePolicy model
        migrations.CreateModel(
            name='OvertimePolicy',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(default='Default', max_length=100)),
                ('overtime_threshold_minutes', models.IntegerField(default=540)),
                ('daily_max_overtime_minutes', models.IntegerField(default=180)),
                ('weekly_max_overtime_minutes', models.IntegerField(default=600)),
                ('is_active', models.BooleanField(default=True)),
                ('requires_approval', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'overtime_policies',
                'ordering': ['name'],
            },
        ),

        # Overtime model
        migrations.CreateModel(
            name='Overtime',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('employee_name', models.CharField(blank=True, default='', max_length=255)),
                ('date', models.DateField(db_index=True)),
                ('shift_hours', models.FloatField(default=8.0)),
                ('worked_hours', models.FloatField(default=0.0)),
                ('overtime_hours', models.FloatField(default=0.0)),
                ('overtime_type', models.CharField(default='regular', max_length=30)),
                ('status', models.CharField(default='calculated', max_length=20)),
                ('approver', models.CharField(blank=True, default='', max_length=255)),
                ('approval_note', models.TextField(blank=True, null=True)),
                ('approved_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'overtimes',
                'ordering': ['-date', '-id'],
                'unique_together': {('email', 'date')},
            },
        ),

        # OvertimeBalance model
        migrations.CreateModel(
            name='OvertimeBalance',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.CharField(db_index=True, max_length=255)),
                ('employee_name', models.CharField(blank=True, default='', max_length=255)),
                ('period', models.CharField(db_index=True, max_length=20)),
                ('total_overtime_hours', models.FloatField(default=0.0)),
                ('comp_off_hours', models.FloatField(default=0.0)),
                ('cash_payout_hours', models.FloatField(default=0.0)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'overtime_balances',
                'ordering': ['-period', 'email'],
                'unique_together': {('email', 'period')},
            },
        ),

        # WFHPolicy model
        migrations.CreateModel(
            name='WFHPolicy',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(default='Default', max_length=100)),
                ('max_wfh_days_per_week', models.IntegerField(default=2)),
                ('max_wfh_days_per_month', models.IntegerField(default=10)),
                ('requires_approval', models.BooleanField(default=True)),
                ('min_advance_notice_days', models.IntegerField(default=1)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'wfh_policies',
                'ordering': ['name'],
            },
        ),
    ]
