import os
import sys
import django
from django.db import connection

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

def run_clean():
    django.setup()
    
    with connection.cursor() as cursor:
        print("Cleaning up database migration state for 0032...")
        
        # 1. Drop tables
        tables = ['candidate_form_submissions', 'payroll_forms']
        for table in tables:
            try:
                cursor.execute(f"DROP TABLE IF EXISTS {table}")
                print(f"✓ Dropped table {table} (if it existed)")
            except Exception as e:
                print(f"✗ Error dropping table {table}: {e}")

        # 2. Drop columns on onboarding_candidates
        # For portal_token which has a unique index, we must drop the index first
        index_drops = [
            ("onboarding_candidates", "portal_token"),  # unique index
        ]
        for table, col in index_drops:
            try:
                # MySQL: find and drop unique index on the column
                cursor.execute(f"""
                    SELECT INDEX_NAME FROM information_schema.STATISTICS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = '{table}'
                      AND COLUMN_NAME = '{col}'
                      AND NON_UNIQUE = 0
                    LIMIT 1
                """)
                row = cursor.fetchone()
                if row and row[0] != 'PRIMARY':
                    idx = row[0]
                    cursor.execute(f"ALTER TABLE {table} DROP INDEX `{idx}`")
                    print(f"✓ Dropped unique index {idx} on {table}.{col}")
            except Exception as e:
                print(f"  (index drop skipped for {col}: {e})")

        columns = ['requested_docs', 'portal_token_expires_at', 'portal_token']
        for col in columns:
            try:
                cursor.execute(f"ALTER TABLE onboarding_candidates DROP COLUMN `{col}`")
                print(f"✓ Dropped column {col} from onboarding_candidates")
            except Exception as e:
                if '1091' in str(e) or "Can't DROP" in str(e):
                    print(f"✓ Column {col} did not exist, no action needed.")
                else:
                    print(f"✗ Error dropping column {col}: {e}")

        # 3. Clean django_migrations
        try:
            cursor.execute(
                "DELETE FROM django_migrations WHERE app='api' AND name='0032_payroll_electronic_filling'"
            )
            print("✓ Removed 0032_payroll_electronic_filling from migration history")
        except Exception as e:
            print(f"✗ Error cleaning django_migrations: {e}")

    print("\nDatabase cleanup completed! You can now run:")
    print("  .venv-1\\Scripts\\python.exe manage.py migrate")

if __name__ == '__main__':
    run_clean()
