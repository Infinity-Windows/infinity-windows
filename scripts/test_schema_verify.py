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

This file also carries the standing gate for scripts/migration_lint.py — both
of its checks. The first is the 2026-09-02 finish_unit incident, where a column
name that does not exist on install_events resolved against the enclosing query
and made a subquery return the newest install on the whole database. The second
is a re-stated column-grant list that quietly got shorter (wave H against wave
X's `projects.stories`, 2026-09-04), where a table-level REVOKE takes a
privilege nobody meant to take and the app degrades so politely that nobody
finds out. Both belong here because it is the same job as the rest of the file:
proving the migrations say what the schema actually is, ahead of a deploy
rather than after one.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import migration_objects
import migration_lint
import partner_wall_lib
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
    def test_compact_constraints_are_not_phantom_columns(self):
        sql = "create table notices (id uuid, plan_id uuid, revision int, unique(plan_id,revision), check(revision > 0));"
        columns = {key for kind, key in migration_objects.extract(sql)[0] if kind == 'column'}
        self.assertEqual(columns, {'notices.id', 'notices.plan_id', 'notices.revision'})


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

    def test_a_dropped_function_is_no_longer_expected(self):
        self.fx.migration("create function old_fn() returns void language sql as $$ select 1 $$;")
        self.fx.migration("drop function if exists old_fn();")
        blocking, advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertEqual(blocking, [])
        self.assertEqual(advisory, [])

    def test_a_function_created_and_dropped_in_one_migration_is_not_expected(self):
        # 20260992000000 proves its default-privileges change this way: a
        # throwaway function inside a DO block, looked at, then dropped.
        self.fx.migration(
            "do $$ begin\n"
            "  execute 'create function public._probe() returns void language sql as $f$ select 1 $f$';\n"
            "  execute 'drop function public._probe()';\n"
            "end $$;"
        )
        blocking, advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertEqual(blocking, [])
        self.assertEqual(advisory, [])

    def test_a_function_recreated_after_a_drop_is_expected_again(self):
        self.fx.migration("create function fn() returns void language sql as $$ select 1 $$;")
        self.fx.migration("drop function fn();")
        self.fx.migration("create function fn() returns void language sql as $$ select 2 $$;")
        _blocking, advisory, _extra = self.fx.run(["table|other|norls"])
        self.assertIn("function|fn", [full for _fn, full in advisory])

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


class ShrinkingGrantListTest(unittest.TestCase):
    """A re-stated column-grant list that quietly got shorter.

    THE PROJECTS GRANT LAW says a migration that drops a `projects` column
    re-states both grant lists without it. The law is good and its primitive is
    sharp: a table-level `revoke insert, update` takes every COLUMN-level grant
    with it, so a re-statement is not "the list I am changing" but "every column
    that may be written from now on" — including columns a wave that merged
    last week added and this author never saw.

    Wave X (20260980000000) added `projects.stories` and granted it additively.
    Wave H (20260981000000) dropped three other columns and re-stated the lists
    from wave Z, which predates `stories`. H sorts after X, so the deploy would
    have dropped the privilege — and nothing would have failed, because
    api.ts's isMissingStoriesColumn reads the 42501 as "not deployed yet",
    drops the column from the write and retries. The save succeeds. The storey
    count a foreman typed is gone. Wave X's header predicted the file by name,
    which is exactly as much as a comment can do; this is the part that stops
    it.
    """

    def _hits(self, sql: str, name: str | None = None):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp))
            fn = fixture.migration(sql, name)
            paths = [fixture.migrations / fn]
            return [
                (t, p, c, r)
                for _f, _l, t, p, c, r in migration_lint.shrinking_grants(paths)
            ]

    def _hits_over(self, files: list[tuple[str, str]]):
        """Several migrations, judged together in name order."""
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp))
            for name, sql in files:
                fixture.migration(sql, name)
            paths = sorted(fixture.migrations.glob("*.sql"))
            return [
                (f, t, p, c, r)
                for f, _l, t, p, c, r in migration_lint.shrinking_grants(paths)
            ]

    # --- the real shape, across two migrations -----------------------------

    WAVE_X = "grant insert (stories) on projects to authenticated;\n"
    WAVE_H_LOST = """
    revoke insert, update on table projects from anon, authenticated;
    grant insert (job_code, name, notes) on projects to authenticated;
    """
    WAVE_H_KEPT = """
    revoke insert, update on table projects from anon, authenticated;
    grant insert (job_code, name, notes, stories) on projects to authenticated;
    """

    def test_the_wave_h_restatement_that_lost_stories_is_caught(self):
        self.assertEqual(
            self._hits_over([
                ("20260980000000_x.sql", self.WAVE_X),
                ("20260981000000_h.sql", self.WAVE_H_LOST),
            ]),
            [("20260981000000_h.sql", "projects", "insert", "stories", "authenticated")],
        )

    def test_naming_the_column_again_is_clean(self):
        self.assertEqual(
            self._hits_over([
                ("20260980000000_x.sql", self.WAVE_X),
                ("20260981000000_h.sql", self.WAVE_H_KEPT),
            ]),
            [],
        )

    def test_the_report_names_the_column_the_file_has_to_add(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Fixture(Path(tmp))
            fixture.migration(self.WAVE_X, "20260980000000_x.sql")
            fixture.migration(self.WAVE_H_LOST, "20260981000000_h.sql")
            text = migration_lint.describe_grants(
                migration_lint.shrinking_grants(sorted(fixture.migrations.glob("*.sql"))),
            )
        self.assertIn("stories", text)
        self.assertIn("20260981000000_h.sql", text)

    # --- and does not cry wolf ---------------------------------------------

    def test_a_revoke_from_another_role_is_not_a_loss(self):
        """20260729200000 grants profiles columns to `authenticated`, then
        writes `revoke all ... from anon` to shut a door that was never open.
        Postgres revokes per grantee; so does this."""
        self.assertEqual(
            self._hits("""
            grant insert (display_name, skill_level) on table public.profiles to authenticated;
            revoke all on table public.profiles from anon;
            """),
            [],
        )

    def test_a_column_this_migration_drops_is_not_expected_back(self):
        """Wave Z's own re-statement: it drops bid_amount and target_margin_pct
        and re-states the lists MINUS both. That is the law working, not a
        loss — dropping a column drops its ACL with it."""
        self.assertEqual(
            self._hits_over([
                ("20260959000000_d.sql",
                 "grant update (name, bid_amount) on projects to authenticated;"),
                ("20260978000000_z.sql", """
                 alter table projects drop column if exists bid_amount;
                 revoke insert, update on table projects from anon, authenticated;
                 grant update (name) on projects to authenticated;
                 """),
            ]),
            [],
        )

    def test_a_drop_written_after_the_revoke_is_still_a_drop(self):
        """Statement order is respected, but a column dropped anywhere in the
        same file is forgiven — the author said the column is going."""
        self.assertEqual(
            self._hits_over([
                ("20260959000000_d.sql",
                 "grant update (name, bid_amount) on projects to authenticated;"),
                ("20260978000000_z.sql", """
                 revoke insert, update on table projects from anon, authenticated;
                 grant update (name) on projects to authenticated;
                 alter table projects drop column if exists bid_amount;
                 """),
            ]),
            [],
        )

    def test_a_column_level_revoke_is_not_a_table_level_one(self):
        """`revoke insert (status) ...` takes exactly `status` and nothing
        else — 20260941000000 writes precisely that."""
        self.assertEqual(
            self._hits_over([
                ("20260940000000_a.sql",
                 "grant insert (name, status) on projects to authenticated;"),
                ("20260941000000_b.sql",
                 "revoke insert (status), update (status) on table projects from authenticated;"),
            ]),
            [],
        )

    def test_a_function_grant_does_not_borrow_the_next_statement(self):
        """`grant execute on function f(a, b) to r;` has no `on <table> to` of
        its own. A pattern allowed to run past the semicolon would take the
        next statement's table and invent a grant nobody wrote."""
        self.assertEqual(
            self._hits_over([
                ("20260940000000_a.sql",
                 "grant insert (name, stories) on projects to authenticated;"),
                ("20260941000000_b.sql", """
                 grant execute on function public.set_thing(uuid, text) to authenticated;
                 revoke insert on table projects from authenticated;
                 grant insert (name, stories) on projects to authenticated;
                 """),
            ]),
            [],
        )

    def test_a_table_that_never_used_column_grants_may_revoke_freely(self):
        """A new table's `revoke all ... ; grant select ...` opening — every
        table in this schema starts that way and none of them is a hit."""
        self.assertEqual(
            self._hits("""
            grant insert, update on project_pipeline to authenticated;
            revoke all on project_pipeline from anon, authenticated;
            grant select on project_pipeline to authenticated;
            """),
            [],
        )

    def test_a_grant_inside_a_comment_is_not_a_grant(self):
        self.assertEqual(
            self._hits_over([
                ("20260940000000_a.sql",
                 "grant insert (name, stories) on projects to authenticated;"),
                ("20260941000000_b.sql", """
                 -- revoke insert on table projects from authenticated;
                 /* grant insert (name) on projects to authenticated; */
                 """),
            ]),
            [],
        )

    # --- the standing gate on this repo ------------------------------------

    def test_the_real_migrations_lose_no_column_grant(self):
        hits = migration_lint.shrinking_grants()
        self.assertEqual(
            hits, [],
            "a migration re-states a column grant list and loses a column:\n"
            + migration_lint.describe_grants(hits),
        )

    def test_wave_h_still_names_stories_in_both_lists(self):
        """The incident, pinned to the real file. Wave H is the migration that
        re-states these lists today; if a later wave re-states them again it
        must carry `stories` too, and the gate above is what says so."""
        sql = (
            migration_lint.MIGRATIONS_DIR / "20260981000000_gc_handshake.sql"
        ).read_text()
        lists = re.findall(
            r"grant (insert|update) \((.*?)\)\s*\n?\s*on projects to authenticated;",
            sql,
            re.S,
        )
        self.assertEqual(
            [priv for priv, _cols in lists], ["insert", "update"],
            "wave H no longer states both projects grant lists",
        )
        for priv, cols in lists:
            self.assertIn(
                "stories", cols,
                f"wave H's projects {priv} list dropped `stories`, which wave X "
                "granted one migration earlier — the storey count would save "
                "silently into nothing",
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


# ---------------------------------------------------------------------------
# The points cap (20260991000000)
# ---------------------------------------------------------------------------
"""The shape of the migration that stopped a phone writing the scoreboard.

Two rules landed together on 2026-09-05, after two profiles filed hundreds of
Education quiz rows apiece in a single day through a policy that had said
`for all to authenticated using (true)` since the ledger was created:

  1. SERVER-ONLY WRITES — points_ledger keeps its read and loses every write,
     and three SECURITY DEFINER functions become the only doors.
  2. NEW CONTENT ONLY — a glossary term pays the first time it is answered
     correctly and never again, which makes the lifetime ceiling arithmetic.

Neither rule can be proved by running the app, and both are the kind that rot
quietly: a later migration that re-adds a FOR ALL policy, a term added to
glossary.ts without a key on the server, a function shipped without its revoke.
So the shape is pinned here, beside the other standing migration gates.
"""

POINTS_CAP = "20260991000000_points_cap.sql"
GLOSSARY = REPO / "app" / "src" / "lib" / "glossary.ts"


def _points_cap_sql() -> str:
    return (migration_lint.MIGRATIONS_DIR / POINTS_CAP).read_text(encoding="utf-8")


def _glossary_term_ids() -> list[str]:
    """The `id` of every entry in glossary.ts's TERMS array, in order."""
    text = GLOSSARY.read_text(encoding="utf-8")
    start = text.index("export const TERMS")
    end = text.index("export const PROC")
    return re.findall(r'"id":\s*"([a-z0-9_-]+)"', text[start:end])


class TestPointsCapMigration(unittest.TestCase):
    def test_the_migration_is_there_at_all(self):
        self.assertTrue((migration_lint.MIGRATIONS_DIR / POINTS_CAP).exists())

    def test_it_is_mirrored_verbatim_into_the_prototype_file(self):
        """docs/prototype-migrations.sql is the consolidated schema — a mirror
        that drifted would restore a database missing this whole rule."""
        mirror = (REPO / "docs" / "prototype-migrations.sql").read_text(encoding="utf-8")
        self.assertIn(f"-- {POINTS_CAP} (mirrored)", mirror)
        self.assertIn(_points_cap_sql(), mirror)

    def test_the_ledgers_for_all_policy_is_gone(self):
        sql = _points_cap_sql()
        self.assertIn('drop policy if exists "authenticated full access" on points_ledger', sql)
        # What replaces it reads, and only reads.
        self.assertRegex(
            sql,
            r'create policy "points_ledger read" on points_ledger\s+for select to authenticated',
        )
        self.assertNotRegex(sql, r"create policy[^;]*on points_ledger\s+for all")

    def test_the_ledger_keeps_the_partner_guard_it_already_had(self):
        self.assertRegex(
            _points_cap_sql(),
            r'create policy "points_ledger read"[^;]*not public\.is_partner_user\(\)',
        )

    def test_every_table_the_rule_touches_refuses_writes_from_a_phone(self):
        sql = _points_cap_sql()
        for table in ("points_ledger", "education_items", "education_credits"):
            self.assertIn(
                f"revoke insert, update, delete on table {table} from anon, authenticated;",
                sql,
                f"{table} still lets a signed-in phone write it directly",
            )

    def test_the_new_tables_have_row_level_security_on(self):
        sql = _points_cap_sql()
        for table in ("education_items", "education_credits"):
            self.assertIn(f"alter table {table} enable row level security;", sql)

    def test_every_new_select_policy_carries_the_partner_guard(self):
        # test_partner_wall.py replays this too; asserted here as well because
        # this file is the one somebody reads when they change this migration.
        sql = _points_cap_sql()
        for policy in ("education_items read", "own or lead read"):
            body = sql.split(f'create policy "{policy}" on ')[1].split(";")[0]
            self.assertIn("not public.is_partner_user()", body)

    def test_one_award_per_person_per_ref_per_kind_is_structural(self):
        """A comment is a promise; a unique index is a rule."""
        sql = _points_cap_sql()
        self.assertRegex(
            sql,
            r"create unique index if not exists "
            r"points_ledger_one_install_award_per_ref_kind\s+"
            r"on points_ledger \(profile_id, ref, kind\)",
        )

    def test_the_index_only_covers_the_kinds_the_install_door_writes(self):
        """SUMMONS SHARE THIS TABLE. answer_summon writes 'summon_answer' with
        a summon id for a ref, and a helper who cancels may re-join the same
        call — which writes that pair a second time on purpose (the cancel
        posts a separate -10 row rather than voiding the first). A repo-wide
        unique index here would abort answer_summon with a raw unique-violation
        and leave that person unable to re-join at all. So the index is scoped
        to the five kinds award_install_points writes, and the two lists have
        to stay in step."""
        sql = _points_cap_sql()
        index = sql.split("create unique index if not exists "
                          "points_ledger_one_install_award_per_ref_kind")[1].split(";")[0]
        self.assertIn(
            "kind in ('install', 'par', 'photos', 'teach', 'quality')", index,
            "the one-award index is not scoped to the install kinds",
        )
        # The same five, and no others, are what the function is willing to pay.
        body = sql.split("create or replace function public.award_install_points(")[1]
        caps = body.split("v_cap := case v_kind")[1].split("end;")[0]
        self.assertEqual(
            set(re.findall(r"when '([a-z]+)'\s+then", caps)),
            {"install", "par", "photos", "teach", "quality"},
        )

    def test_the_index_is_dropped_by_its_old_name_before_it_is_rebuilt(self):
        """`create ... if not exists` skips a rebuild, so a database that took
        the earlier unscoped shape of this index would keep it and keep
        breaking summons. Dropping the old name first is what makes re-running
        this migration actually correct rather than merely quiet."""
        sql = _points_cap_sql()
        self.assertIn("drop index if exists points_ledger_one_award_per_ref_kind;", sql)
        self.assertLess(
            sql.index("drop index if exists points_ledger_one_award_per_ref_kind;"),
            sql.index("create unique index if not exists "
                      "points_ledger_one_install_award_per_ref_kind"),
        )

    def test_the_duplicate_backfill_leaves_summon_points_alone(self):
        """Backfill B keeps the first row per (person, ref, kind) and voids the
        rest. Across all kinds that would void the second, legitimate answer on
        a summon somebody cancelled and re-joined — while the -10 cancellation
        row stands beside it, docking them 10 points for help they gave."""
        ranked = _points_cap_sql().split("with ranked as (")[1].split("\n)")[0]
        self.assertIn(
            "l.kind in ('install', 'par', 'photos', 'teach', 'quality')", ranked,
            "the duplicate backfill sweeps kinds it does not govern",
        )

    def test_the_backfill_voids_and_never_deletes(self):
        sql = _points_cap_sql()
        # The farmed rows: kind 'quiz' with no ref. Video quiz rows carry a
        # 'video_quiz:' ref and must survive untouched.
        self.assertIn("set status = 'void'", sql)
        self.assertIn("where kind = 'quiz'", sql)
        self.assertIn("and ref is null", sql)
        self.assertNotIn("delete from points_ledger", sql)
        self.assertIn("void_reason", sql)

    def test_the_backfill_can_be_applied_twice(self):
        """Idempotent by its own WHERE: after one run nothing matches, because
        the rows it changes are the rows it excludes."""
        self.assertIn("and status <> 'void'", _points_cap_sql())

    def test_every_function_it_ships_is_definer_with_a_pinned_search_path(self):
        sql = _points_cap_sql()
        for fn in (
            "award_install_points",
            "resolve_install_points",
            "award_education_quiz",
            "my_education_progress",
        ):
            body = sql.split(f"create or replace function public.{fn}(")[1].split("$$")[0]
            self.assertIn("security definer", body, f"{fn} is not SECURITY DEFINER")
            self.assertIn(
                "set search_path = public, pg_temp", body,
                f"{fn} does not pin its search_path",
            )

    def test_every_function_it_ships_is_revoked_then_granted(self):
        sql = _points_cap_sql()
        for fn in (
            "award_install_points",
            "resolve_install_points",
            "award_education_quiz",
            "my_education_progress",
        ):
            self.assertRegex(
                sql, rf"revoke all on function public\.{fn}\([^)]*\) from public, anon;",
                f"{fn} is not revoked from public and anon",
            )
            self.assertRegex(
                sql, rf"grant execute on function public\.{fn}\([^)]*\) to authenticated;",
                f"{fn} is never granted to the crew",
            )

    def test_the_install_door_stores_one_spelling_of_the_window_id(self):
        """points_ledger.ref is TEXT and Postgres reads 'A0EE…', '{a0ee…}' and
        an unhyphenated uuid as the same window — three different strings. Held
        raw, each spelling would miss the resend check, slip past the unique
        index and pay the same install again, and QC (which looks a unit up by
        the canonical id) would never reach the extra rows. So the function
        casts once and uses the cast value for both the check and the write."""
        body = _points_cap_sql().split(
            "create or replace function public.award_install_points("
        )[1].split("$$;")[0]
        self.assertIn("v_ref := v_opening::text;", body)
        self.assertIn("l.ref = v_ref", body)
        self.assertNotIn("l.ref = p_ref", body, "the resend check still compares raw caller text")
        insert = body.split("insert into points_ledger")[1].split(";")[0]
        self.assertIn("v_ref", insert)
        self.assertNotIn("p_ref", insert, "the ledger row still stores raw caller text")

    def test_install_points_are_always_filed_pending(self):
        """p_status came off a phone. 'confirmed' skipped QC outright and put
        points on the leaderboard that a later callback could never take back,
        because resolve_install_points only moves rows that are still pending.
        The argument stays in the signature so an older build keeps working,
        and its value is ignored."""
        body = _points_cap_sql().split(
            "create or replace function public.award_install_points("
        )[1].split("$$;")[0]
        insert = body.split("insert into points_ledger")[1].split(";")[0]
        self.assertIn("'pending'", insert)
        self.assertNotIn("p_status", insert, "the caller can still choose the status")

    def test_a_unit_installed_again_after_an_undo_is_paid_again(self):
        """undo_install and unsubmit_own_install void an opening's points and
        send the unit back to the work list. Counting a voided row as
        already-paid — with nothing to tell a retry from a redo — meant the
        crew who installed it the second time earned nothing, silently and
        permanently. The install event is what separates the two."""
        body = _points_cap_sql().split(
            "create or replace function public.award_install_points("
        )[1].split("$$;")[0]
        # The event id is loaded, written onto the row, and read back by the guard.
        self.assertIn("e.voided_at is null", body,
                      "points can still be paid against an install somebody took back")
        self.assertIn("jsonb_build_object('event_id', v_event)", body)
        self.assertIn("l.status <> 'void' or l.detail ->> 'event_id' = v_event::text", body)

    def test_par_and_quality_have_to_have_been_earned(self):
        """The amounts were always clamped, but nothing asked whether the rule
        applied — so a bare install could claim all five kinds and 65 points.
        These two the install event can answer, using the same comparisons
        computeInstallPoints makes in the browser. 'photos' and 'teach'
        deliberately cannot be checked here: the outbox awards points BEFORE it
        uploads the media, so at that moment neither exists on the server."""
        body = _points_cap_sql().split(
            "create or replace function public.award_install_points("
        )[1].split("$$;")[0]
        self.assertIn("v_minutes <= v_estimate", body)
        self.assertIn("v_grade >= 4", body)

    def test_qc_confirm_and_void_are_gated_at_foreman(self):
        body = _points_cap_sql().split(
            "create or replace function public.resolve_install_points("
        )[1].split("$$;")[0]
        self.assertIn("public.my_role_rank() < 1", body)

    def test_the_server_has_a_key_for_every_glossary_term_and_no_others(self):
        """THE JOIN BETWEEN TWO FILES. The glossary is content and lives in the
        app; the KEY LIST has to live in the database, because a key the server
        does not recognise must pay nothing. Adding a term to one side without
        the other is a silent hole — either a term nobody can earn, or a key
        that pays for something the crew never sees. So it is a red build."""
        sql = _points_cap_sql()
        seed = sql.split("insert into education_items (key, kind, points) values")[1]
        seed = seed.split("on conflict (key) do nothing;")[0]
        seeded = set(re.findall(r"\('([a-z0-9_:-]+)',", seed))
        expected = {f"term:{i}" for i in _glossary_term_ids()} | {"seq:install"}
        self.assertEqual(seeded, expected)

    def test_the_ceiling_is_a_number_somebody_can_check(self):
        """105 terms plus the sequence, ten points each. If this ever changes,
        the PR body's cap changes with it."""
        self.assertEqual(len(_glossary_term_ids()), 105)
        self.assertIn("'sequence', 10)", _points_cap_sql())

    def test_the_remove_login_count_learned_about_the_new_table(self):
        """education_credits cascades off profiles, so a login deleted outright
        would take a person's earned terms with it in silence."""
        sql = _points_cap_sql()
        self.assertIn(
            "create or replace function public.person_record_counts(p_id uuid)", sql)
        self.assertIn("'education_credits.profile_id',", sql)



# ---------------------------------------------------------------------------
# The installer gallery (20260995000000)
# ---------------------------------------------------------------------------

#: The migration that narrowed what an installer can read out of `attachments`.
INSTALLER_GALLERY = "20260995000000_installer_gallery.sql"

#: Every column an attachments row may hang off. The first five are
#: `attachments_target`'s own list (20260989000000); `service_case_id`
#: (20260718070000) is not in that constraint and is a target column all the
#: same — a row that carries one is about that case's job. Any column added to
#: either list has to be resolvable, or a photo naming only that column reads
#: as "belongs to no job" — which below foreman means invisible to everybody
#: but its uploader, not visible to everybody. The risk of forgetting one is a
#: photo of real work disappearing, not a leak.
ATTACHMENT_TARGET_COLUMNS = [
    "project_id",
    "window_id",
    "install_event_id",
    "project_opening_id",
    "package_id",
    "service_case_id",
]

#: What each target column has to be resolved THROUGH, as a fragment of the
#: resolver's SQL. install_events is the one that cannot be resolved directly:
#: it has no project_id and never has (20260715120000), so it goes through its
#: opening.
TARGET_RESOLUTIONS = {
    "project_id": "select p_project_id as pid",
    "window_id": "from windows w",
    "install_event_id": "from install_events ie",
    "project_opening_id": "from project_openings po",
    "package_id": "from packages pk",
    "service_case_id": "from service_cases sc",
}


class InstallerGalleryPolicyTest(unittest.TestCase):
    """An installer's photo gallery is the jobs they have worked.

    `attachments` carried one policy from 20260715000000 until this migration —
    "authenticated full access", FOR ALL, guarded only by the partner wall — so
    every crew member could read every job photo. The Capture button (2026-09-05)
    was the first door to it from an installer's phone, which is what made a
    latent read into a real one.

    These are shape tests, not a database. They assert the four things that
    could each undo the change while everything still deploys clean: the read
    narrowed, the writes did NOT, the partner wall survived, and every column a
    photo can hang off actually resolves to a job.
    """

    @classmethod
    def setUpClass(cls):
        cls.sql = (REPO / "supabase" / "migrations" / INSTALLER_GALLERY).read_text()
        states, _unparsed = partner_wall_lib.replay_policies()
        cls.policies = states["attachments"].policies

    # --- the read narrowed --------------------------------------------------

    def test_the_day_one_for_all_policy_is_gone(self):
        """A permissive FOR ALL policy left in place would OR straight past the
        narrow SELECT one and change nothing at all."""
        self.assertNotIn("authenticated full access", self.policies)
        self.assertEqual(
            [n for n, p in self.policies.items() if p.command == "ALL"], [],
            "a FOR ALL policy on attachments grants SELECT as well, so it "
            "would make the narrow select policy decorative",
        )

    def test_the_select_policy_asks_all_four_questions(self):
        p = self.policies["attachments_select"]
        self.assertEqual(p.command, "SELECT")
        self.assertIn("authenticated", p.roles)
        for fragment in (
            "my_role_rank() >= 1",          # foreman+ unchanged
            "is_my_upload_name(created_by)",  # my own shot, wherever it was filed
            "my_worked_project_ids()",      # the jobs I have worked
            "attachment_project_ids(",      # ...however this row names one
        ):
            self.assertIn(
                fragment.replace(" ", ""), p.using.replace(" ", "").replace("\n", ""),
                f"attachments_select no longer asks about {fragment}",
            )

    def test_the_select_policy_keeps_the_partner_guard(self):
        # test_partner_wall.py proves this mechanically for every table; pinned
        # here too because this is the policy being rewritten.
        self.assertIn("is_partner_user()", self.policies["attachments_select"].using)

    # --- the writes did not --------------------------------------------------

    def test_every_write_policy_is_exactly_as_wide_as_it_was(self):
        """The old FOR ALL policy's write half was `not is_partner_user()` and
        nothing else. Splitting it into three must not smuggle a rank check,
        an ownership check or a job check into a write path."""
        for name, command in (
            ("attachments_insert", "INSERT"),
            ("attachments_update", "UPDATE"),
            ("attachments_delete", "DELETE"),
        ):
            p = self.policies[name]
            self.assertEqual(p.command, command)
            self.assertIn("authenticated", p.roles)
            for clause in (p.using, p.check):
                if not clause.strip():
                    continue
                self.assertEqual(
                    clause.strip(), "not public.is_partner_user()",
                    f"{name} is not the width it was before the split",
                )

    def test_insert_and_update_still_check_what_they_checked(self):
        """A FOR ALL policy's WITH CHECK covered both INSERT and UPDATE. Losing
        either one would let a partner blind-write the table."""
        self.assertIn("is_partner_user()", self.policies["attachments_insert"].check)
        self.assertIn("is_partner_user()", self.policies["attachments_update"].check)
        self.assertIn("is_partner_user()", self.policies["attachments_update"].using)
        self.assertIn("is_partner_user()", self.policies["attachments_delete"].using)

    # --- every target column resolves ----------------------------------------

    def test_the_policy_hands_the_resolver_every_target_column(self):
        using = self.policies["attachments_select"].using
        call = using[using.index("attachment_project_ids("):]
        for column in ATTACHMENT_TARGET_COLUMNS:
            self.assertIn(
                column, call,
                f"attachments.{column} is never passed to attachment_project_ids, "
                "so a row that hangs off only that column belongs to no job and "
                "falls out of the rule",
            )

    def test_the_resolver_resolves_every_target_column(self):
        body = self.sql
        for column, fragment in TARGET_RESOLUTIONS.items():
            self.assertIn(
                fragment, body,
                f"attachment_project_ids has no branch resolving {column} "
                f"(expected {fragment!r})",
            )

    def test_install_events_is_resolved_through_its_opening(self):
        """install_events has no project_id — it has project_opening_id, and
        has since 20260715120000. Reaching for the wrong one is the
        2026-09-02 shape migration_lint exists to catch."""
        self.assertIn("join project_openings po on po.id = ie.project_opening_id", self.sql)
        self.assertNotIn("from install_events ie\n     where ie.project_id", self.sql)

    # --- the helpers are shaped the way a policy helper has to be ------------

    @staticmethod
    def _squashed(clause):
        """Policy text with whitespace removed, so a reformatting does not read
        as a rule change."""
        return "".join(clause.split())

    def _definition(self, name):
        """The text of one create-function statement in this migration."""
        start = self.sql.index(f"create or replace function public.{name}(")
        return self.sql[start:self.sql.index("$$;", start)]

    def test_the_helpers_that_bypass_rls_are_security_definer_and_pinned(self):
        for name in ("my_worked_project_ids", "attachment_project_ids"):
            body = self._definition(name)
            self.assertIn("security definer", body, f"{name} must be definer")
            self.assertIn("stable", body, f"{name} must be stable")
            self.assertIn(
                "set search_path = public, pg_temp", body,
                f"{name} is SECURITY DEFINER with an unpinned search_path",
            )

    def test_the_helpers_that_do_not_need_definer_do_not_have_it(self):
        """The house rule: definer is for functions that MUST bypass RLS.
        These two read only tables the caller can already read."""
        for name in ("is_my_upload_name", "list_my_worked_jobs"):
            body = self._definition(name)
            self.assertNotIn("security definer", body, f"{name} does not need definer")
            self.assertIn("set search_path = public, pg_temp", body)
            self.assertIn("stable", body)

    def test_the_id_resolver_answers_nothing_to_a_partner(self):
        """It takes ids as ARGUMENTS, so without its own guard a builder login
        could hand it a window id and learn which job that window is on — the
        exact mapping the wall withholds."""
        self.assertIn("not public.is_partner_user()", self._definition("attachment_project_ids"))

    def test_every_new_function_is_revoked_from_public_and_anon(self):
        for name, args in (
            ("my_worked_project_ids", ""),
            ("attachment_project_ids", "uuid, uuid, uuid, uuid, uuid, uuid"),
            ("is_my_upload_name", "text"),
            ("list_my_worked_jobs", ""),
        ):
            sig = f"public.{name}({args})"
            self.assertIn(
                f"revoke all on function {sig} from public, anon;", self.sql,
                f"{sig} is not revoked from public and anon",
            )
            self.assertIn(
                f"grant execute on function {sig} to authenticated", self.sql,
                f"{sig} is never granted to authenticated, so nothing can call it",
            )

    # --- the warehouse keeps its photo strip ---------------------------------

    def test_a_package_only_row_stays_crew_wide(self):
        """Receiving and put-away are rank-0 crew work (ADR-0007,
        20260986000000). A yard hand has almost no shifts, no published
        crew-board row and no unit sessions, and a Boneyard package has no job
        at all — so scoping package photos by job would empty PackageSheet's
        filmstrip for the person standing next to the box."""
        using = self._squashed(self.policies["attachments_select"].using)
        self.assertIn("package_idisnotnull", using)

    def test_the_warehouse_carve_out_needs_every_other_target_null(self):
        """Otherwise hanging a package id on a job photo would be a way out of
        the job rule. Every column except package_id has to be null for a row
        to count as warehouse rather than job work."""
        using = self._squashed(self.policies["attachments_select"].using)
        start = using.index("package_idisnotnull")
        # Up to the carve-out's own closing paren: it has no inner brackets, so
        # this is exactly the branch and none of the resolver call after it.
        clause = using[start:using.index(")", start)]
        for column in ATTACHMENT_TARGET_COLUMNS:
            if column == "package_id":
                continue
            self.assertIn(
                f"{column}isnull", clause,
                f"the warehouse carve-out does not require {column} to be null, "
                "so a job photo hung off a package would step around the rule",
            )

    # --- "mine" cannot be claimed by typing --------------------------------

    def test_ownership_is_the_signed_in_email_and_nothing_editable(self):
        """`display_name` is a column every crew member may write on their own
        profile row (20260729200000). Matching an upload against it would mean
        an installer could read another person's photos, on every job in the
        company, by renaming themselves to that person. The signed-in email is
        in the SIGNED token, so it is the only spelling that can be trusted."""
        body = self._definition("is_my_upload_name")
        self.assertIn("auth.jwt() ->> 'email'", body)
        for editable in ("display_name", "profiles"):
            self.assertNotIn(
                editable, body,
                f"is_my_upload_name reads {editable}, which the person it is "
                "asking about can edit — ownership must not be claimable",
            )

    def test_the_only_ownership_test_the_policy_runs_is_that_one(self):
        """A second ownership branch written straight into the policy would
        walk around the function and its test."""
        using = self.policies["attachments_select"].using
        self.assertNotIn("display_name", using)
        self.assertEqual(using.count("is_my_upload_name("), 1)

    def test_the_picker_and_the_policy_read_the_same_list(self):
        """A picker built from a different query would offer jobs whose photos
        come back empty, which reads as a broken screen rather than a rule."""
        self.assertIn("my_worked_project_ids()", self._definition("list_my_worked_jobs"))

    def test_the_migration_is_mirrored_into_the_prototype_file(self):
        mirror = (REPO / "docs" / "prototype-migrations.sql").read_text()
        self.assertIn(f"-- {INSTALLER_GALLERY} (mirrored)", mirror)
        self.assertIn('create policy "attachments_select" on attachments', mirror)


if __name__ == "__main__":
    unittest.main(verbosity=2)
