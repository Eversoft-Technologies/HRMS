"""Recompute ``days`` on every existing leave request from its date range.

The UI posted a hardcoded ``days: 1``, which beat the serializer's old
"derive only when missing" logic, so most rows stored 1 regardless of the range
(e.g. 2026-07-03 → 2026-07-17 was saved as 1 day). ``days`` also feeds the leave
balance (used = sum of approved days), so those balances were wrong too.

Both endpoints are inclusive: 2026-08-10 → 2026-08-12 is 3 days.
"""
from django.db import migrations


def forwards(apps, schema_editor):
    LeaveRequest = apps.get_model('api', 'LeaveRequest')

    fixed = 0
    for lr in LeaveRequest.objects.exclude(
        from_date__isnull=True
    ).exclude(to_date__isnull=True).iterator():
        correct = (lr.to_date - lr.from_date).days + 1
        if correct < 1:
            correct = 1          # guard inverted ranges rather than store <= 0
        if lr.days != correct:
            lr.days = correct
            lr.save(update_fields=['days'])
            fixed += 1
    print(f'  recomputed days on {fixed} leave request(s)')


def backwards(apps, schema_editor):
    # The original (wrong) values are not recoverable, and restoring them would
    # only reintroduce the bug. Correct data is a safe state to stay in.
    pass


class Migration(migrations.Migration):
    dependencies = [('api', '0023_kpi_scope_permissions')]
    operations = [migrations.RunPython(forwards, backwards)]
