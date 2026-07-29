#!/usr/bin/env python3
"""Unit tests for the post-push schema verification.

    python3 scripts/test_schema_verify.py

Stdlib only, and nothing here contacts a database: each case writes throwaway
migration files and a fake catalog snapshot, so the comparison is exercised
against known inputs.

The behaviour that matters most is the DIRECTION of the check, because getting
it wrong in either direction breaks the pipeline in a different way: too strict
and every merge is red forever because of `project_marks`, too loose and a
migration that never applied ships silently. Both directions are asserted.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import schema_verify

REPO = Path(__file__).resolve().parent.parent


class Fixture:
    """A throwaway migrations directory plus a fake live snapshot."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.migrations = tmp / "migrations"
        self.migrations.mkdir(exist_ok=True)
        self._n = 0

    def migration(self, sql: str, name: str | None = None) -> str:
        """Add a migration file. Names are ordered unless one is given."""
        self._n += 1
        fn = name or "202601%02d000000_test.sql" % self._n
        (self.migrations / fn).write_text(sql)
        return fn

    def snapshot(self, keys: list[str]) -> str:
        """A live_schema.sql result: a JSON array of {"k": ...} rows."""
        path = self.tmp / "live.json"
        path.write_text(json.dumps([{"k": k} for k in keys]))
        return str(path)

    def run(self, keys: list[str]):
        """Compare the fixture's migrations against the given live keys."""
        schema_verify.MIG_DIR = str(self.migrations)
        declared = schema_verify.declared_objects()
        live = schema_verify.live_keys([self.snapshot(keys)])
        return schema_verify.compare(declared, live)


class SchemaVerifyTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(Path(self._tmp.name))
        self._orig_mig_dir = schema_verify.MIG_DIR

    def tearDown(self):
        schema_verify.MIG_DIR = self._orig_mig_dir
        self._tmp.cleanup()

    # --- the failing direction: declared but absent -------------------------

    def test_missing_table_blocks(self):
        self.fx.migration("create table widgets (id uuid primary key);")
        blocking, _advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertIn("table|widgets", [full for _fn, full in blocking])

    def test_missing_column_blocks(self):
        self.fx.migration("create table widgets (id uuid primary key);")
        self.fx.migration("alter table widgets add column colour text;")
        blocking, _advisory, _extra = self.fx.run(
            ["table|widgets|norls", "column|widgets.id|uuid|NO|-"],
        )
        self.assertIn("column|widgets.colour", [full for _fn, full in blocking])

    def test_blocking_entry_names_the_migration_that_declared_it(self):
        fn = self.fx.migration("create table widgets (id uuid primary key);")
        blocking, _advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertEqual([f for f, _full in blocking if _full == "table|widgets"], [fn])

    def test_everything_present_blocks_nothing(self):
        self.fx.migration("create table widgets (id uuid primary key, colour text);")
        blocking, _advisory, _extra = self.fx.run(
            [
                "table|widgets|norls",
                "column|widgets.id|uuid|NO|-",
                "column|widgets.colour|text|YES|-",
            ],
        )
        self.assertEqual(blocking, [])

    # --- the reporting direction: live but undeclared -----------------------

    def test_undeclared_live_table_does_not_block(self):
        """The project_marks case: this must never fail a deploy."""
        self.fx.migration("create table widgets (id uuid primary key);")
        blocking, _advisory, extra = self.fx.run(
            ["table|widgets|norls", "column|widgets.id|uuid|NO|-",
             "table|project_marks|rls"],
        )
        self.assertEqual(blocking, [])
        self.assertIn("project_marks", extra["tables"])

    def test_undeclared_live_column_on_a_declared_table_is_reported(self):
        self.fx.migration("create table widgets (id uuid primary key);")
        _blocking, _advisory, extra = self.fx.run(
            [
                "table|widgets|norls",
                "column|widgets.id|uuid|NO|-",
                "column|widgets.sneaked_in|text|YES|-",
            ],
        )
        self.assertIn("widgets.sneaked_in", extra["columns"])

    def test_columns_of_an_undeclared_table_are_not_listed_twice(self):
        """Reporting the table is enough; listing all its columns is noise."""
        self.fx.migration("create table widgets (id uuid primary key);")
        _blocking, _advisory, extra = self.fx.run(
            [
                "table|widgets|norls",
                "column|widgets.id|uuid|NO|-",
                "table|project_marks|rls",
                "column|project_marks.id|uuid|NO|-",
                "column|project_marks.page|integer|YES|-",
            ],
        )
        self.assertEqual(extra["tables"], ["project_marks"])
        self.assertEqual(extra["columns"], [])

    def test_other_schemas_are_not_reported_as_undeclared(self):
        """storage/vault/auth objects are Supabase's, not ours to declare."""
        self.fx.migration("create table widgets (id uuid primary key);")
        _blocking, _advisory, extra = self.fx.run(
            [
                "table|widgets|norls",
                "column|widgets.id|uuid|NO|-",
                "view|storage.something",
                "view|vault.decrypted_secrets",
            ],
        )
        self.assertEqual(extra["tables"], [])

    # --- migration bookkeeping is ignored -----------------------------------

    def test_migration_history_rows_are_ignored_entirely(self):
        """Phantom rows in schema_migrations must not affect the verdict.

        Production's history table holds 37 versions matching no file
        (docs/db-push-readiness.md). An earlier audit trusted recorded history
        and certified the wrong database; this check measures objects only.
        """
        self.fx.migration("create table widgets (id uuid primary key);")
        keys = ["table|widgets|norls", "column|widgets.id|uuid|NO|-"]
        clean, _a1, e1 = self.fx.run(keys)
        phantoms = keys + [
            "migration|20260715185858",
            "migration|20260729170000",
            "migration|20260729180000",
        ]
        with_phantoms, _a2, e2 = self.fx.run(phantoms)
        self.assertEqual(clean, with_phantoms)
        self.assertEqual(e1, e2)

    def test_phantom_versions_are_never_reported_as_live_only(self):
        self.fx.migration("create table widgets (id uuid primary key);")
        _blocking, _advisory, extra = self.fx.run(
            ["table|widgets|norls", "column|widgets.id|uuid|NO|-",
             "migration|20260729170000"],
        )
        self.assertEqual(extra["tables"], [])
        self.assertEqual(extra["columns"], [])

    # --- scoping: only tables and columns block -----------------------------

    def test_a_missing_index_is_advisory_not_blocking(self):
        self.fx.migration(
            "create table widgets (id uuid primary key);\n"
            "create index widgets_id_idx on widgets (id);",
        )
        blocking, advisory, _extra = self.fx.run(
            ["table|widgets|norls", "column|widgets.id|uuid|NO|-"],
        )
        self.assertEqual(blocking, [])
        self.assertIn("index|widgets|widgets_id_idx", [full for _fn, full in advisory])

    def test_a_missing_policy_is_advisory_not_blocking(self):
        self.fx.migration(
            "create table widgets (id uuid primary key);\n"
            'create policy "read all" on widgets for select using (true);',
        )
        blocking, advisory, _extra = self.fx.run(
            ["table|widgets|norls", "column|widgets.id|uuid|NO|-"],
        )
        self.assertEqual(blocking, [])
        self.assertTrue(any("policy|" in full for _fn, full in advisory))

    def test_seeds_and_backfills_are_never_judged(self):
        self.fx.migration("insert into widgets (id) values (gen_random_uuid());")
        self.fx.migration("update widgets set colour = 'red';")
        blocking, advisory, _extra = self.fx.run(["table|widgets|norls"])
        self.assertEqual(blocking, [])
        self.assertEqual(advisory, [])

    # --- drops must not turn the deploy permanently red ---------------------

    def test_a_dropped_table_is_no_longer_expected(self):
        self.fx.migration("create table gone (id uuid primary key);")
        self.fx.migration("drop table gone;")
        blocking, advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertEqual(blocking, [])
        self.assertEqual(advisory, [])

    def test_a_dropped_column_is_no_longer_expected(self):
        self.fx.migration("create table widgets (id uuid primary key, old_col text);")
        self.fx.migration("alter table widgets drop column old_col;")
        blocking, _advisory, _extra = self.fx.run(
            ["table|widgets|norls", "column|widgets.id|uuid|NO|-"],
        )
        self.assertEqual(blocking, [])

    def test_dropping_a_table_drops_expectations_for_its_columns(self):
        self.fx.migration("create table gone (id uuid primary key, colour text);")
        self.fx.migration("drop table if exists gone;")
        blocking, _advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertEqual(blocking, [])

    def test_a_table_recreated_after_a_drop_is_expected_again(self):
        self.fx.migration("create table widgets (id uuid primary key);")
        self.fx.migration("drop table widgets;")
        self.fx.migration("create table widgets (id uuid primary key);")
        blocking, _advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertIn("table|widgets", [full for _fn, full in blocking])

    # --- report rendering ---------------------------------------------------

    def test_summary_says_verified_when_clean(self):
        text, ok = schema_verify.render([], [], {"tables": [], "columns": []}, "ref123")
        self.assertTrue(ok)
        self.assertIn("Schema verified", text)
        self.assertIn("ref123", text)

    def test_summary_names_missing_objects_and_points_at_the_runbook(self):
        text, ok = schema_verify.render(
            [("20260101000000_x.sql", "table|widgets")],
            [],
            {"tables": [], "columns": []},
            "ref123",
        )
        self.assertFalse(ok)
        self.assertIn("table|widgets", text)
        self.assertIn("20260101000000_x.sql", text)
        self.assertIn("db-push-readiness", text)

    def test_summary_reports_live_only_objects_without_claiming_failure(self):
        text, ok = schema_verify.render(
            [], [], {"tables": ["project_marks"], "columns": []}, "ref123",
        )
        self.assertTrue(ok)
        self.assertIn("project_marks", text)
        self.assertIn("declared by no migration", text)

    def test_result_line_carries_the_live_only_tables(self):
        line = schema_verify.result_line(
            [], [], {"tables": ["project_marks", "other"], "columns": []},
        )
        self.assertIn("missing=0", line)
        self.assertIn("live_only_tables=2", line)
        self.assertIn("tables=project_marks,other", line)

    def test_long_lists_are_capped_so_the_summary_stays_readable(self):
        many = [("f.sql", "table|t%d" % i) for i in range(200)]
        text, _ok = schema_verify.render(many, [], {"tables": [], "columns": []}, "r")
        self.assertIn("and %d more" % (200 - schema_verify.MAX_LISTED), text)

    # --- an empty snapshot proves nothing -----------------------------------

    def test_empty_snapshot_fails_rather_than_reporting_success(self):
        """The lesson verify-functions.sh learned: cannot-tell is not healthy."""
        self.fx.migration("create table widgets (id uuid primary key);")
        schema_verify.MIG_DIR = str(self.fx.migrations)
        empty = self.fx.snapshot([])
        rc = schema_verify.main(["schema_verify.py", empty])
        self.assertEqual(rc, 1)

    # --- against the real repo ---------------------------------------------

    def test_the_real_migrations_parse_and_declare_tables(self):
        """Sanity: the check has something to say about this repo's own files."""
        schema_verify.MIG_DIR = self._orig_mig_dir
        declared = schema_verify.declared_objects()
        tables = {key for kind, key in declared if kind == "table"}
        self.assertGreater(len(tables), 50)
        # The table the brief called out: declared nowhere.
        self.assertNotIn("project_marks", tables)

    def test_the_real_migrations_would_flag_project_marks_as_live_only(self):
        """End-to-end on the real repo with a snapshot that has project_marks."""
        schema_verify.MIG_DIR = self._orig_mig_dir
        declared = schema_verify.declared_objects()
        tables = sorted({key for kind, key in declared if kind == "table"})
        keys = ["table|%s|norls" % t for t in tables]
        keys.append("table|project_marks|rls")
        live = schema_verify.live_keys([self.fx.snapshot(keys)])
        blocking, _advisory, extra = schema_verify.compare(declared, live)
        # Only columns can be missing here; no table is.
        self.assertEqual([f for _fn, f in blocking if f.startswith("table|")], [])
        self.assertEqual(extra["tables"], ["project_marks"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
