"""
Test the public_candidate_forms view directly to get the real traceback.
Run by hand:  .venv\Scripts\python.exe verify_portal_api.py

Deliberately NOT named test_*: it queries real data at import time, so unittest
discovery picked it up and ran it against the live database on every test run.
"""
import os
import sys
import traceback

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
django.setup()

from api.models import OnboardingCandidate, PayrollForm, CandidateFormSubmission
from datetime import datetime

# Use the stored token
TOKEN = None

# Find first candidate with a token
try:
    c = OnboardingCandidate.objects.filter(portal_token__isnull=False, is_deleted=False).first()
    if c:
        TOKEN = c.portal_token
        print(f"Testing with candidate #{c.id} ({c.email}), token={TOKEN}")
    else:
        print("ERROR: No candidate with a portal_token found. Run Send Portal Link first.")
        sys.exit(1)
except Exception as e:
    print(f"ERROR fetching candidate: {e}")
    traceback.print_exc()
    sys.exit(1)

print("\n--- Step 1: Validate token ---")
candidate = OnboardingCandidate.objects.filter(portal_token=TOKEN, is_deleted=False).first()
if not candidate:
    print("ERROR: Token lookup returned None")
    sys.exit(1)
print(f"OK — found candidate #{candidate.id}")

print("\n--- Step 2: Check token expiry ---")
if candidate.portal_token_expires_at and datetime.now() > candidate.portal_token_expires_at:
    print("ERROR: Token expired")
else:
    print(f"OK — expires at {candidate.portal_token_expires_at}")

print("\n--- Step 3: Fetch payroll forms ---")
try:
    forms = PayrollForm.objects.filter(is_active=True)
    print(f"OK — {forms.count()} active forms found")
    forms_data = []
    for f in forms:
        sub = CandidateFormSubmission.objects.filter(candidate=candidate, form=f).first()
        forms_data.append({
            'id': f.id,
            'name': f.name,
            'isSubmitted': sub is not None,
        })
        print(f"  form #{f.id}: {f.name} — submitted={sub is not None}")
except Exception as e:
    print(f"ERROR fetching forms: {e}")
    traceback.print_exc()

print("\n--- Step 4: Fetch uploaded documents ---")
try:
    docs_qs = candidate.documents.filter(is_active=True)
    print(f"OK — {docs_qs.count()} uploaded documents")
    for d in docs_qs:
        print(f"  doc #{d.id}: {d.doc_type} ({d.file_name})")
except Exception as e:
    print(f"ERROR fetching documents: {e}")
    traceback.print_exc()

print("\n--- Step 5: Build candidate dict ---")
try:
    data = {
        'id': candidate.id,
        'firstName': candidate.first_name or '',
        'lastName': candidate.last_name or '',
        'email': candidate.email or '',
        'requestedDocs': candidate.requested_docs or [],
    }
    print(f"OK — {data}")
except Exception as e:
    print(f"ERROR building candidate dict: {e}")
    traceback.print_exc()

print("\nDone. No errors = view should work. Errors above = root cause of the 500.")
