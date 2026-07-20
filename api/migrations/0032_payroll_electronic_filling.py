from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0031_hr_manager_revoke_onboarding_approve'),
    ]

    operations = [
        migrations.AddField(
            model_name='onboardingcandidate',
            name='portal_token',
            field=models.CharField(max_length=64, unique=True, null=True, blank=True, db_index=True),
        ),
        migrations.AddField(
            model_name='onboardingcandidate',
            name='portal_token_expires_at',
            field=models.DateTimeField(null=True, blank=True),
        ),
        migrations.AddField(
            model_name='onboardingcandidate',
            name='requested_docs',
            field=models.JSONField(blank=True, default=list),
        ),



        migrations.CreateModel(
            name='PayrollForm',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=120, unique=True)),
                ('file_name', models.CharField(max_length=255, default='', blank=True)),
                ('file_mime', models.CharField(max_length=100, default='', blank=True)),
                ('file_data', models.TextField(default='', blank=True)),
                ('schema', models.JSONField(blank=True, default=list)),
                ('is_active', models.BooleanField(default=True, db_index=True)),
                ('created_by', models.CharField(blank=True, default='', max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'payroll_forms',
                'ordering': ['name'],
            },
        ),
        migrations.CreateModel(
            name='CandidateFormSubmission',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('filled_data', models.JSONField(blank=True, default=dict)),
                ('signature_data', models.TextField(blank=True, default='')),
                ('signed_at', models.DateTimeField(null=True, blank=True)),
                ('file_name', models.CharField(max_length=255, default='', blank=True)),
                ('file_mime', models.CharField(max_length=100, default='application/pdf', blank=True)),
                ('file_size', models.IntegerField(default=0)),
                ('file_data', models.TextField(blank=True, default='')),
                ('mode', models.CharField(max_length=20, default='digital', db_index=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('candidate', models.ForeignKey(db_column='candidate_id', on_delete=django.db.models.deletion.CASCADE, related_name='form_submissions', to='api.onboardingcandidate')),
                ('form', models.ForeignKey(db_column='form_id', on_delete=django.db.models.deletion.CASCADE, related_name='submissions', to='api.payrollform')),
            ],
            options={
                'db_table': 'candidate_form_submissions',
                'ordering': ['-created_at'],
            },
        ),
    ]
