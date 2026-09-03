#!/usr/bin/env python3
"""Standing test for the test-login fence (20260965000000_sandbox_guard_rearm).

    python3 scripts/test_sandbox_guard.py

Two jobs.

THE STATIC GATE. Replays every migration to find every project-scoped table
declared after the fence migration, and asserts something arms it — a call to
attach_sandbox_guards() in that migration or a later one. This is the check
that stops the live census from ever going non-empty again: the original fence
attached its triggers from a `do` block that ran once, on 2026-07-30, and
fourteen tables created since then never carried a guard at all. Nobody has to
remember to add a new table to a list here; a migration that adds one and does
not arm it fails THIS test, before it can reach any database.

THE REPORT. Exercises scripts/sandbox_guard.py's rendering and verdict against
fixed census snapshots, so the deploy check cannot be red or green for the wrong
reason. This half is pure: it never touches a database.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sandbox_guard import (  # noqa: E402
    GUARD_MIGRATION,
    REARM_MIGRATION,
    MIGRATIONS_DIR,
    link_for,
    load_census,
    migrations_calling_attach,
    render,
    result_line,
    scoped_tables,
    uncovered_new_tables,
)


def census_file(rows: list[str]) -> str:
    """A snapshot on disk, the shape scripts/pgq.sh writes."""
    handle = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8")
    json.dump([{"k": row} for row in rows], handle)
    handle.close()
    return handle.name


class TestTheStaticGate(unittest.TestCase):
    """Reads the real supabase/migrations/, on purpose."""

    def test_the_fence_migration_is_still_there(self):
        self.assertTrue(
            (MIGRATIONS_DIR / GUARD_MIGRATION).exists(),
            f"{GUARD_MIGRATION} is the migration that invented the fence — if "
            "it was renamed, this whole module is measuring against a file "
            "that no longer exists",
        )
        self.assertTrue(
            (MIGRATIONS_DIR / REARM_MIGRATION).exists(),
            f"{REARM_MIGRATION} defines attach_sandbox_guards()",
        )

    def test_the_rearm_migration_actually_calls_the_function(self):
        self.assertIn(
            REARM_MIGRATION, migrations_calling_attach(),
            "the migration that defines attach_sandbox_guards() must also call "
            "it, or the fourteen tables it exists to cover stay uncovered",
        )

    def test_every_project_scoped_table_added_since_is_armed(self):
        uncovered = uncovered_new_tables()
        self.assertEqual(
            [], uncovered,
            "these tables can be written by a QA test login on ANY job, "
            "because no migration arms the sandbox guard on them: "
            + ", ".join(f"{t} ({c}, declared in {m})" for t, c, m in uncovered)
            + ". End that migration with `select public.attach_sandbox_guards();`.",
        )

    def test_the_replay_still_finds_the_schema(self):
        """If this fails the parser broke, and the gate above is vacuous."""
        tables = scoped_tables()
        self.assertGreater(
            len(tables), 30,
            "the migration replay found almost no project-scoped tables, so "
            "the gate above is passing because it is measuring nothing",
        )
        self.assertEqual(("id", "project", ), tables["projects"][:2])
        self.assertEqual("project_id", tables["project_openings"][0])
        self.assertEqual("opening_id", tables["unit_sessions"][0])
        self.assertNotIn("sandbox_projects", tables)


class TestLinkPrecedence(unittest.TestCase):
    """The rule public.sandbox_scoped_tables() uses, mirrored here."""

    def test_projects_links_through_its_own_id(self):
        self.assertEqual(("id", "project"), link_for("projects", {"id", "name"}))

    def test_a_direct_project_id_beats_an_opening_link(self):
        self.assertEqual(
            ("project_id", "project"),
            link_for("summons", {"id", "project_id", "opening_id"}),
        )

    def test_project_opening_id_beats_opening_id(self):
        self.assertEqual(
            ("project_opening_id", "opening"),
            link_for("install_events", {"id", "project_opening_id", "opening_id"}),
        )

    def test_a_table_with_no_link_is_not_scoped(self):
        self.assertIsNone(link_for("cost_codes", {"id", "code"}))

    def test_the_sandbox_list_itself_is_never_scoped(self):
        self.assertIsNone(link_for("sandbox_projects", {"project_id"}))


class TestTheLiveReport(unittest.TestCase):
    def test_a_full_fence_passes(self):
        census = load_census([census_file([
            "scoped|project_openings|project_id|project",
            "scoped|unit_sessions|opening_id|opening",
            "sandbox_job|ZZTEST|TEST — automation sandbox",
            "test_login|TEST — automation FOREMAN, do not assign",
        ])])
        summary, ok = render(census, "czprjcskmzzagdztqonm")
        self.assertTrue(ok)
        self.assertIn("HOLDING", summary)
        self.assertIn("2 of 2 project-scoped tables", summary)
        self.assertIn("ZZTEST", summary)

    def test_one_unguarded_table_fails_and_is_named(self):
        census = load_census([census_file([
            "scoped|project_openings|project_id|project",
            "scoped|unit_sessions|opening_id|opening",
            "unguarded|unit_sessions|opening_id|no sandbox guard on this table",
            "sandbox_job|ZZTEST|TEST — automation sandbox",
        ])])
        summary, ok = render(census, "czprjcskmzzagdztqonm")
        self.assertFalse(ok)
        self.assertIn("OPEN", summary)
        self.assertIn("1 of 2 project-scoped tables", summary)
        self.assertIn("`unit_sessions`", summary)
        self.assertIn("no sandbox guard on this table", summary)

    def test_an_empty_snapshot_is_a_failure_not_a_clean_bill(self):
        """`verify-functions.sh` learned this the hard way: "we could not
        measure it" must never render as "everything is fine"."""
        census = load_census([census_file([])])
        summary, ok = render(census, "czprjcskmzzagdztqonm")
        self.assertFalse(ok)
        self.assertIn("Nothing was measured", summary)

    def test_a_sandbox_with_no_jobs_still_passes_but_says_so(self):
        census = load_census([census_file([
            "scoped|project_openings|project_id|project",
        ])])
        summary, ok = render(census, "czprjcskmzzagdztqonm")
        self.assertTrue(ok)
        self.assertIn("No job is registered as a sandbox", summary)

    def test_every_sandbox_job_is_printed(self):
        """The 2026-09-02 incident turned on WHICH jobs are inside the fence,
        so the deploy log has to say, every time."""
        census = load_census([census_file([
            "scoped|project_openings|project_id|project",
            "sandbox_job|ZZTEST|TEST — automation sandbox",
            "sandbox_job|BLACK22|Black Desert",
        ])])
        summary, _ok = render(census, "czprjcskmzzagdztqonm")
        self.assertIn("`ZZTEST`", summary)
        self.assertIn("`BLACK22`", summary)

    def test_a_query_error_names_the_missing_migration(self):
        path = census_file([])
        Path(path).write_text(
            json.dumps({"message": 'function public.sandbox_guard_census() does not exist'}),
            encoding="utf-8",
        )
        with self.assertRaises(SystemExit) as caught:
            load_census([path])
        self.assertIn(REARM_MIGRATION, str(caught.exception))

    def test_the_result_line_carries_the_counts(self):
        census = load_census([census_file([
            "scoped|project_openings|project_id|project",
            "scoped|unit_sessions|opening_id|opening",
            "unguarded|unit_sessions|opening_id|no sandbox guard on this table",
            "sandbox_job|ZZTEST|TEST — automation sandbox",
            "test_login|TEST — automation FOREMAN, do not assign",
        ])])
        self.assertEqual(
            "::result:: scoped=2 unguarded=1 sandbox_jobs=1 test_logins=1",
            result_line(census),
        )


class TestTheGateCanActuallyFail(unittest.TestCase):
    """A gate nobody has seen go red is a gate nobody can trust."""

    def test_a_new_scoped_table_with_no_arming_call_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / GUARD_MIGRATION).write_text(
                "create table project_openings (id uuid primary key, "
                "project_id uuid not null);\n",
                encoding="utf-8",
            )
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260970000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_the_same_migration_arming_the_fence_clears_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n"
                "select public.attach_sandbox_guards();\n",
                encoding="utf-8",
            )
            self.assertEqual([], uncovered_new_tables(directory))

    def test_a_later_migration_arming_the_fence_clears_it_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            (directory / "20260971000000_arm_it.sql").write_text(
                "select public.attach_sandbox_guards();\n", encoding="utf-8",
            )
            self.assertEqual([], uncovered_new_tables(directory))

    def test_an_earlier_arming_call_does_not_cover_a_later_table(self):
        """attach_sandbox_guards() sweeps the catalogue as it stands when it
        runs. A call BEFORE the table exists is exactly the one-shot bug."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_arm_it.sql").write_text(
                "select public.attach_sandbox_guards();\n", encoding="utf-8",
            )
            (directory / "20260971000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260971000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_naming_the_function_in_a_comment_is_not_arming_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "-- remember to select public.attach_sandbox_guards() one day\n"
                "create table job_notes (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260970000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_declaring_the_function_is_not_calling_it(self):
        """`create or replace function public.attach_sandbox_guards()` and the
        grant lines under it all name the function without arming anything."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n"
                "create or replace function public.attach_sandbox_guards()\n"
                "returns void language sql as $$ select 1 $$;\n"
                "grant execute on function public.attach_sandbox_guards() to service_role;\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260970000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_a_table_with_no_project_link_needs_no_arming(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table cost_codes (id uuid primary key, code text);\n",
                encoding="utf-8",
            )
            self.assertEqual([], uncovered_new_tables(directory))


if __name__ == "__main__":
    unittest.main(verbosity=2)
