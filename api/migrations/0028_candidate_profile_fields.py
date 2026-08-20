"""Add personal/professional profile fields to OnboardingCandidate.

All additive and nullable/blank, so applying this against the existing
``onboarding_candidates`` table only adds columns and never rewrites rows:

  candidate_code  — human-friendly ID (CAN0001), server-generated on create
  dob             — date of birth
  gender          — free string (UI offers a small select)
  address         — mailing / residential address
  manager         — reporting manager
  work_location   — office / client site the candidate works from
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0027_onboarding_permissions'),
    ]

    operations = [
        migrations.AddField(
            model_name='onboardingcandidate',
            name='candidate_code',
            field=models.CharField(blank=True, db_index=True, default='', max_length=32),
        ),
        migrations.AddField(
            model_name='onboardingcandidate',
            name='dob',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='onboardingcandidate',
            name='gender',
            field=models.CharField(blank=True, default='', max_length=32),
        ),
        migrations.AddField(
            model_name='onboardingcandidate',
            name='address',
            field=models.CharField(blank=True, default='', max_length=500),
        ),
        migrations.AddField(
            model_name='onboardingcandidate',
            name='manager',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='onboardingcandidate',
            name='work_location',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
    ]
