"""Migration 0094 adds the (email, date) index on attendance events. It must
work on a database that already has the index (one that ran it under its old
number, 0085) as well as one that does not, or `migrate` stops with
"Duplicate key name"."""
import importlib
import os
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.apps import apps
from django.db import connection
from django.test import TransactionTestCase

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

migration = importlib.import_module('api.migrations.0094_attendanceevent_email_date_index')
TABLE = 'attendance_events'


def index_exists():
    with connection.cursor() as cursor:
        return migration.INDEX_NAME in connection.introspection.get_constraints(cursor, TABLE)


class AttendanceEventIndexMigrationTests(TransactionTestCase):
    def test_runs_cleanly_when_the_index_is_already_there(self):
        self.assertTrue(index_exists())                       # the test database was built by the migrations
        with connection.schema_editor() as editor:
            migration.add_index_if_missing(apps, editor)      # would raise "duplicate key" before the fix
        self.assertTrue(index_exists())

    def test_adds_the_index_when_it_is_missing(self):
        with connection.schema_editor() as editor:
            migration.drop_index_if_present(apps, editor)
        self.assertFalse(index_exists())
        with connection.schema_editor() as editor:
            migration.add_index_if_missing(apps, editor)
        self.assertTrue(index_exists())

    def test_reverse_is_safe_whether_or_not_the_index_exists(self):
        with connection.schema_editor() as editor:
            migration.drop_index_if_present(apps, editor)
            migration.drop_index_if_present(apps, editor)     # second call: nothing to drop, no error
        self.assertFalse(index_exists())
        with connection.schema_editor() as editor:
            migration.add_index_if_missing(apps, editor)
