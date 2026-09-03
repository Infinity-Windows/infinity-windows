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

This file also carries the standing gate for scripts/migration_lint.py — the
2026-09-02 finish_unit incident, where a column name that does not exist on
install_events resolved against the enclosing query and made a subquery return
the newest install on the whole database. That belongs here because it is the
same job as the rest of the file: proving the migrations say what the schema
actually is, ahead of a deploy rather than after one.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import migration_lint
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


#: The exact statement that shipped in 20260820000000_unit_sessions.sql and
#: cost an owner a finished unit's minutes on 2026-09-02. Kept verbatim so
#: these tests fail if the scanner ever stops recognising the real shape.
FINISH_UNIT_BEFORE = """
  select coalesce(sum(least(480,
           greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60)))), 0)::int,
         min(started_at)
  into v_minutes, v_started
  from unit_sessions
  where opening_id = p_opening_id and ended_at is not null
    and started_at > coalesce(
      (select max(created_at) from install_events
       where opening_id = p_opening_id and voided_at is null),
      '-infinity'::timestamptz);
"""

FINISH_UNIT_AFTER = FINISH_UNIT_BEFORE.replace(
    "where opening_id = p_opening_id and voided_at is null",
    "where project_opening_id = p_opening_id and voided_at is null",
)


class MigrationLintTest(unittest.TestCase):
    """A column name that isn't on the table it is filtering.

    Postgres resolves it against the enclosing query rather than raising, so
    nothing errors and the filter silently stops filtering. See
    scripts/migration_lint.py for the incident this came from.
    """

    # --- it catches the real thing -----------------------------------------

    def test_the_2026_09_02_statement_is_caught(self):
        hits = migration_lint.scan_sql(FINISH_UNIT_BEFORE, "before.sql")
        self.assertEqual(
            [(t, w) for _f, _l, t, w, _r in hits],
            [("install_events", "opening_id")],
        )

    def test_the_fixed_statement_is_clean(self):
        self.assertEqual(migration_lint.scan_sql(FINISH_UNIT_AFTER, "after.sql"), [])

    def test_the_report_names_the_column_that_should_have_been_used(self):
        text = migration_lint.describe(
            migration_lint.scan_sql(FINISH_UNIT_BEFORE, "before.sql"),
        )
        self.assertIn("project_opening_id", text)
        self.assertIn("before.sql", text)

    # --- the same bug, spelled with one more pair of brackets ---------------
    #
    # The incident happened to write the filter flat. Nothing about the bug
    # needs it to be flat, and the first cut of the scanner only judged text at
    # paren depth 0 — so every spelling below re-shipped the identical bug with
    # the gate printing "no silently-resolving column references" (2026-09-03).

    def test_the_filter_wrapped_in_its_own_parentheses_is_caught(self):
        sql = """
        select 1 from install_events
        where (opening_id = p_opening_id and voided_at is null);
        """
        self.assertEqual(
            [(t, w) for _f, _l, t, w, _r in migration_lint.scan_sql(sql)],
            [("install_events", "opening_id")],
        )

    def test_the_filter_inside_a_function_call_is_caught(self):
        sql = """
        select 1 from install_events
        where coalesce(opening_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = p_opening_id;
        """
        self.assertEqual(
            [(t, w) for _f, _l, t, w, _r in migration_lint.scan_sql(sql)],
            [("install_events", "opening_id")],
        )

    def test_the_2026_09_02_statement_with_a_bracketed_filter_is_caught(self):
        """The whole incident again, one bracket deeper — the shape a future
        finish_unit is most likely to be written in."""
        sql = FINISH_UNIT_BEFORE.replace(
            "where opening_id = p_opening_id and voided_at is null",
            "where (opening_id = p_opening_id and voided_at is null)",
        )
        self.assertEqual(
            [(t, w) for _f, _l, t, w, _r in migration_lint.scan_sql(sql)],
            [("install_events", "opening_id")],
        )

    # --- it does not cry wolf ----------------------------------------------

    def test_a_subquery_on_another_table_is_that_querys_business(self):
        """Descending into brackets must not start judging a nested query that
        brought its own FROM: `opening_id` really is unit_sessions' column."""
        sql = """
        select 1 from install_events
        where project_opening_id in (
          select opening_id from unit_sessions where ended_at is not null
        );
        """
        self.assertEqual(migration_lint.scan_sql(sql), [])

    def test_the_from_inside_extract_is_not_a_table_source(self):
        """`extract(epoch from (a - b))` reads like a FROM clause and is not
        one — if it were treated as a nested query, the trap could hide in it."""
        sql = """
        select extract(epoch from (created_at - started_at)) from install_events
        where (opening_id = p_opening_id);
        """
        self.assertEqual(
            [(t, w) for _f, _l, t, w, _r in migration_lint.scan_sql(sql)],
            [("install_events", "opening_id")],
        )


    def test_a_qualified_opening_id_on_another_table_is_fine(self):
        """20260959000000's shape: install_events joined next to a table that
        really does have opening_id, every reference qualified."""
        sql = """
        select a.path from attachments a
        join install_events ie on ie.id = a.install_event_id
        join project_openings po on po.id = ie.project_opening_id
        union all
        select op.photo_path from opening_phases op
        join project_openings po on po.id = op.opening_id;
        """
        self.assertEqual(migration_lint.scan_sql(sql), [])

    def test_an_aliased_subquery_on_a_different_table_is_fine(self):
        """20260718005000's shape: the bare-looking name belongs to `issues`,
        and is qualified with its alias."""
        sql = """
        select 1 from install_events e
        join project_openings o on o.id = e.project_opening_id
        where e.voided_at is not null
          and not exists (
            select 1 from issues i
            where i.opening_id = e.project_opening_id and i.kind = 'failed_install'
          );
        """
        self.assertEqual(migration_lint.scan_sql(sql), [])

    def test_a_later_statements_column_list_is_not_this_statements_scope(self):
        """20260718070000's shape: the select on install_events ends at its
        semicolon; the insert after it names opening_id legitimately."""
        sql = """
        select id into v_event from install_events
        where window_id = p_window_id and voided_at is null
        order by created_at desc limit 1;
        insert into service_cases (window_id, install_event_id, opening_id)
        values (p_window_id, v_event, p_opening_id);
        """
        self.assertEqual(migration_lint.scan_sql(sql), [])

    def test_the_real_column_name_is_never_flagged(self):
        sql = "select 1 from install_events where project_opening_id = p_opening_id;"
        self.assertEqual(migration_lint.scan_sql(sql), [])

    def test_creating_and_indexing_the_table_is_not_a_query(self):
        sql = """
        create table install_events (
          id uuid primary key,
          project_opening_id uuid not null references project_openings(id)
        );
        create index install_events_opening_idx on install_events(project_opening_id);
        """
        self.assertEqual(migration_lint.scan_sql(sql), [])

    # --- the standing gate on this repo ------------------------------------

    def test_the_real_migrations_carry_no_unforgiven_trap(self):
        self.assertEqual(
            migration_lint.unexpected_hits(), [],
            "a migration filters install_events by a bare opening_id:\n"
            + migration_lint.describe(migration_lint.unexpected_hits()),
        )

    def test_the_shipped_bug_is_still_found_in_the_history_it_shipped_in(self):
        """Proof the scanner works on this repo's real text and not just on
        fixtures: 20260820000000 still reads the way it read on the day."""
        hit_files = {fn for fn, _l, _t, _w, _r in migration_lint.scan_migrations()}
        self.assertIn("20260820000000_unit_sessions.sql", hit_files)

    def test_forgiveness_dies_if_the_fix_goes_away(self):
        """The whole tree passes only BECAUSE 20260964000000 is there. With
        the history alone, the gate is red — which is what it would have said
        about master any day between 2026-08-20 and 2026-09-02."""
        history_only = [
            migration_lint.MIGRATIONS_DIR / "20260820000000_unit_sessions.sql",
        ]
        hits = migration_lint.unexpected_hits(history_only)
        self.assertEqual(
            [(t, w) for _f, _l, t, w, _r in hits],
            [("install_events", "opening_id")],
        )

    def test_every_superseded_entry_names_a_real_later_migration(self):
        """A stale exemption is worse than none: it forgives a live bug."""
        names = {p.name for p in migration_lint.MIGRATIONS_DIR.glob("*.sql")}
        for old, fixer in migration_lint.SUPERSEDED.items():
            self.assertIn(old, names, f"{old} is exempted but no longer exists")
            self.assertIn(fixer, names, f"{old}'s replacement {fixer} is missing")
            self.assertGreater(
                fixer, old,
                f"{fixer} does not sort after {old}, so it never runs second",
            )


#: The per-session minutes arithmetic, wherever it appears. Pulled out of the
#: file text rather than retyped, so the assertion below compares what the two
#: migrations actually say.
MINUTES_EXPRESSION = re.compile(r"coalesce\(sum\(least\(480.*?\)\), 0\)::int", re.S)


def _squash(text: str) -> str:
    """Whitespace-insensitive form: the two files indent this expression
    differently, and indentation is not the thing under test."""
    return re.sub(r"\s+", " ", text).strip()


class ShippedColumnBugRepairTest(unittest.TestCase):
    """Fixing the function is half the incident; the rows it wrote are the
    other half.

    finish_unit filed finished units with no minutes and no start time for
    thirteen days. Replacing the function stops the next one and repairs none
    of them — and a unit whose time reads as "nobody recorded this" is a lie
    about a crew that did the work. So a shipped column bug has to name the
    migration that put its rows right and the list of what could not be.
    """

    def test_every_shipped_column_bug_names_the_repair_for_its_rows(self):
        names = {p.name for p in migration_lint.MIGRATIONS_DIR.glob("*.sql")}
        for old, fixer in migration_lint.SUPERSEDED.items():
            self.assertIn(
                old, migration_lint.REPAIRED,
                f"{old} wrote wrong rows until {fixer} replaced it; name the "
                "migration that repaired them (and the list of the ones it "
                "could not) in migration_lint.REPAIRED",
            )
            repair, listing = migration_lint.REPAIRED[old]
            self.assertIn(repair, names, f"{old}'s repair {repair} is missing")
            self.assertGreater(
                repair, fixer,
                f"{repair} must run after {fixer}, or it repairs rows with the "
                "broken function still in place",
            )
            text = (migration_lint.MIGRATIONS_DIR / repair).read_text()
            self.assertIn(
                f"create table if not exists {listing}", text,
                f"{repair} must leave {listing} behind: a row it could not "
                "recover is only visible if something names it",
            )

    def test_the_repair_recomputes_with_the_arithmetic_the_fix_uses(self):
        """A repair that adds minutes up differently from the fixed function
        would file a second wrong number over the first one."""
        for old, fixer in migration_lint.SUPERSEDED.items():
            repair, _listing = migration_lint.REPAIRED[old]
            fixed = MINUTES_EXPRESSION.search(
                (migration_lint.MIGRATIONS_DIR / fixer).read_text())
            repaired = MINUTES_EXPRESSION.search(
                (migration_lint.MIGRATIONS_DIR / repair).read_text())
            self.assertIsNotNone(fixed, f"no minutes arithmetic found in {fixer}")
            self.assertIsNotNone(repaired, f"no minutes arithmetic found in {repair}")
            self.assertEqual(
                _squash(fixed.group(0)), _squash(repaired.group(0)),
                f"{repair} sums a session's minutes differently from {fixer}",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
