"""
Diagnostic script — checks:
  1. Whether migration 0032 columns exist in the DB
  2. Whether migration 0032 is marked as applied
  3. What portal tokens are currently stored for candidates
"""
import os
import sys
import django

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

django.setup()

from django.db import connection

print("=" * 60)
print("STEP 1 — Check migration history")
print("=" * 60)
with connection.cursor() as cursor:
    cursor.execute(
        "SELECT name, applied FROM django_migrations "
        "WHERE app='api' AND name LIKE '003%' ORDER BY name"
    )
    rows = cursor.fetchall()
    for name, applied in rows:
        print(f"  {'[X]' if applied else '[ ]'} {name}")

print()
print("=" * 60)
print("STEP 2 — Check if new columns exist on onboarding_candidates")
print("=" * 60)
with connection.cursor() as cursor:
    cursor.execute("""
        SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'onboarding_candidates'
          AND COLUMN_NAME IN ('portal_token', 'portal_token_expires_at', 'requested_docs')
        ORDER BY COLUMN_NAME
    """)
    rows = cursor.fetchall()
    if rows:
        for col, typ, nullable in rows:
            print(f"  ✓  {col}  ({typ}, nullable={nullable})")
    else:
        print("  ✗  NONE of the new columns exist — migration has NOT been applied!")

print()
print("=" * 60)
print("STEP 3 — Check new tables")
print("=" * 60)
with connection.cursor() as cursor:
    for tbl in ('payroll_forms', 'candidate_form_submissions'):
        cursor.execute(f"""
            SELECT COUNT(*) FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{tbl}'
        """)
        exists = cursor.fetchone()[0]
        print(f"  {'✓' if exists else '✗'}  {tbl}  {'exists' if exists else 'MISSING'}")

print()
print("=" * 60)
print("STEP 4 — Candidate portal tokens (first 5)")
print("=" * 60)
try:
    with connection.cursor() as cursor:
        cursor.execute("""
            SELECT id, email, portal_token, portal_token_expires_at
            FROM onboarding_candidates
            WHERE portal_token IS NOT NULL
            LIMIT 5
        """)
        rows = cursor.fetchall()
        if rows:
            for cid, email, tok, exp in rows:
                print(f"  Candidate #{cid} ({email})")
                print(f"    token : {tok}")
                print(f"    expires: {exp}")
        else:
            print("  No candidates have a portal token stored yet.")
except Exception as e:
    print(f"  Could not query tokens: {e}")

print()
print("Done. Share the output above.")
