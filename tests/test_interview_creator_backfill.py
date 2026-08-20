"""The audit-log backfill only credits interviews it can be sure about.

``audit_logs`` predates this backend and nothing writes to it any more, but it
recorded ``interview.created`` with the actor's email — the only surviving trace
of who scheduled the interviews that came before ``created_by_email``. Mining it
is worth doing once, and worth being strict about: a name in that column is
meant to be trustworthy, and a plausible guess is indistinguishable from a real
attribution once it is written.

So these cases pin the refusals as much as the matches — a near-miss on the
candidate, a stale timestamp, and two equally good candidates all have to come
out uncredited rather than credited to whoever was closest.
"""
import importlib
import json
import os
import sys
from datetime import timedelta

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.apps import apps as real_apps
from django.db import connection
from django.test import TransactionTestCase

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api.models import AppUser, InterviewLink
from api.timeutil import local_now

migration = importlib.import_module('api.migrations.0049_backfill_interview_creator_from_audit')


class _Editor(object):
    """The one attribute the migration uses off schema_editor."""
    connection = connection


# TransactionTestCase, not TestCase: these cases CREATE and DROP audit_logs,
# and DDL implicitly commits in MySQL, which tears the wrapping transaction
# out from under a TestCase and errors every case after the first.
class InterviewCreatorBackfillTests(TransactionTestCase):
    ACTOR = 'auditor@example.test'

    def setUp(self):
        AppUser.objects.create(full_name='Aud Itor', email=self.ACTOR,
                               status='active', role='admin')
        with connection.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    actor_email VARCHAR(255) NOT NULL DEFAULT '',
                    action VARCHAR(80) NOT NULL DEFAULT '',
                    target VARCHAR(255) NOT NULL DEFAULT '',
                    detail JSON NULL,
                    ip VARCHAR(64) NOT NULL DEFAULT '',
                    created_at DATETIME(6) NOT NULL
                )""")
            cur.execute('DELETE FROM audit_logs')

    def tearDown(self):
        with connection.cursor() as cur:
            cur.execute('DROP TABLE IF EXISTS audit_logs')

    # ── helpers ────────────────────────────────────────────────────────────
    def _audit(self, name, role, when, actor=None, target=''):
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO audit_logs (actor_email, action, target, detail, ip, created_at) "
                "VALUES (%s, 'interview.created', %s, %s, '', %s)",
                [self.ACTOR if actor is None else actor, target,
                 json.dumps({'name': name, 'role': role}), when])

    def _interview(self, name, role, when):
        iv = InterviewLink.objects.create(
            name=name, initials='XX', role=role, email='%s@example.test' % name.replace(' ', ''),
            status='Scheduled')
        InterviewLink.objects.filter(pk=iv.pk).update(created_at=when)
        return iv

    def _run(self):
        migration.forwards(real_apps, _Editor())

    # ── what it credits ────────────────────────────────────────────────────
    def test_an_audit_row_credits_the_interview_it_describes(self):
        now = local_now()
        iv = self._interview('srikanth', 'data analyst', now - timedelta(seconds=7))
        self._audit('srikanth', 'data analyst', now)
        self._run()
        iv.refresh_from_db()
        self.assertEqual(iv.created_by_email, self.ACTOR)
        # The name comes from the account, not from the audit row.
        self.assertEqual(iv.created_by_name, 'Aud Itor')

    def test_the_earliest_rows_kept_the_actor_in_target(self):
        now = local_now()
        iv = self._interview('srikanth', 'data analyst', now - timedelta(seconds=5))
        self._audit('srikanth', 'data analyst', now, actor='', target=self.ACTOR)
        self._run()
        iv.refresh_from_db()
        self.assertEqual(iv.created_by_email, self.ACTOR)

    def test_two_audit_rows_do_not_both_claim_one_interview(self):
        now = local_now()
        first = self._interview('srikanth', 'data analyst', now - timedelta(minutes=30))
        second = self._interview('srikanth', 'data analyst', now - timedelta(seconds=6))
        self._audit('srikanth', 'data analyst', now - timedelta(minutes=30) + timedelta(seconds=7))
        self._audit('srikanth', 'data analyst', now)
        self._run()
        first.refresh_from_db(); second.refresh_from_db()
        self.assertEqual(first.created_by_email, self.ACTOR)
        self.assertEqual(second.created_by_email, self.ACTOR)

    # ── what it refuses ────────────────────────────────────────────────────
    def test_a_different_candidate_is_not_credited(self):
        now = local_now()
        iv = self._interview('someone else', 'data analyst', now - timedelta(seconds=6))
        self._audit('srikanth', 'data analyst', now)
        self._run()
        iv.refresh_from_db()
        self.assertEqual(iv.created_by_email, '')

    def test_a_different_role_is_not_credited(self):
        now = local_now()
        iv = self._interview('srikanth', 'data engineer', now - timedelta(seconds=6))
        self._audit('srikanth', 'data analyst', now)
        self._run()
        iv.refresh_from_db()
        self.assertEqual(iv.created_by_email, '')

    def test_an_interview_outside_the_window_is_not_credited(self):
        now = local_now()
        iv = self._interview('srikanth', 'data analyst', now - timedelta(hours=3))
        self._audit('srikanth', 'data analyst', now)
        self._run()
        iv.refresh_from_db()
        self.assertEqual(iv.created_by_email, '')

    def test_two_equally_good_candidates_are_both_left_alone(self):
        """Same candidate, same role, seconds apart: nothing separates them, so
        crediting either would be a coin toss written into the database."""
        now = local_now()
        a = self._interview('srikanth', 'data analyst', now - timedelta(seconds=5))
        b = self._interview('srikanth', 'data analyst', now - timedelta(seconds=8))
        self._audit('srikanth', 'data analyst', now)
        self._run()
        a.refresh_from_db(); b.refresh_from_db()
        self.assertEqual(a.created_by_email, '')
        self.assertEqual(b.created_by_email, '')

    def test_an_interview_that_already_has_a_creator_is_untouched(self):
        now = local_now()
        iv = self._interview('srikanth', 'data analyst', now - timedelta(seconds=6))
        InterviewLink.objects.filter(pk=iv.pk).update(
            created_by_email='real@example.test', created_by_name='Real Person')
        self._audit('srikanth', 'data analyst', now)
        self._run()
        iv.refresh_from_db()
        self.assertEqual(iv.created_by_email, 'real@example.test')

    def test_running_it_twice_changes_nothing(self):
        now = local_now()
        iv = self._interview('srikanth', 'data analyst', now - timedelta(seconds=6))
        self._audit('srikanth', 'data analyst', now)
        self._run()
        self._run()
        iv.refresh_from_db()
        self.assertEqual(iv.created_by_email, self.ACTOR)
        self.assertEqual(InterviewLink.objects.exclude(created_by_email='').count(), 1)

    def test_a_missing_audit_table_is_not_an_error(self):
        with connection.cursor() as cur:
            cur.execute('DROP TABLE IF EXISTS audit_logs')
        self._interview('srikanth', 'data analyst', local_now())
        self._run()  # must not raise on a database that never had the table
