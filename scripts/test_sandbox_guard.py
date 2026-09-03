#!/usr/bin/env python3
"""Standing test for the test-login fence (20260967000000_sandbox_guard_rearm).

    python3 scripts/test_sandbox_guard.py

Two jobs.

THE STATIC GATE. Replays every migration to find every table that becomes
project-scoped after 20260967000000's sweep — created with a project link,
dropped and recreated, or given one by ALTER — and asserts that the migration
doing it arms the fence itself. This is the check that stops the live census
from ever going non-empty again: the original fence attached its triggers from
a `do` block that ran once, on 2026-07-30, and fourteen tables created since
then never carried a guard at all. Nobody has to remember to add a new table to
a list here; a migration that adds one and does not arm it fails THIS test,
before it can reach any database.

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
    REARM_COVERED,
    SANDBOX_DECISION,
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


class TestTheMigrationText(unittest.TestCase):
    """What the SQL says, read as text.

    There is no database here, so the parts of the migration a reviewer would
    otherwise have to hold in their head are asserted instead. Each of these
    stands for a way the fence can be present and useless.
    """

    def body_of(self, function: str) -> str:
        """One `create or replace function` body, whitespace flattened.

        Flattened because where a predicate is split across lines is the
        formatter's business, and a check that goes red over a reflow is a
        check people start deleting.
        """
        sql = (MIGRATIONS_DIR / REARM_MIGRATION).read_text(encoding="utf-8")
        start = sql.index("create or replace function public." + function)
        return " ".join(sql[start:sql.index("$$;", start)].split())

    def test_the_attacher_does_not_count_a_switched_off_trigger(self):
        """`alter table … disable trigger` and `pg_restore --disable-triggers`
        both leave a trigger with the right name, function, arguments and
        tgtype that fires on nothing. Skipping it as 'already armed' would
        leave the fence down and say it was up."""
        body = self.body_of("attach_sandbox_guards")
        self.assertIn("tg.tgenabled in ('O', 'A')", body)
        self.assertIn("coalesce(v_on, false)", body)

    def test_the_census_reports_a_switched_off_trigger(self):
        body = self.body_of("sandbox_guard_census")
        self.assertIn("tg.tgenabled not in ('O', 'A')", body)
        self.assertIn("the guard is switched off and fires on nothing", body)

    def test_the_census_still_checks_the_shape_it_always_did(self):
        """The trigger has to exist, fire on every write, and read this
        table's link column. Losing one of those to a later edit would make
        the deploy proof weaker without making it red."""
        body = self.body_of("sandbox_guard_census")
        self.assertIn("tg.oid is null", body)
        self.assertIn("tg.tgtype <> 31", body)
        self.assertIn("quote_literal(s.link_column)", body)
        self.assertIn("quote_literal(s.link_kind)", body)

    def test_the_migration_is_mirrored_into_the_prototype_file(self):
        """docs/prototype-migrations.sql is the consolidated schema. A mirror
        that has drifted from the migration is worse than no mirror: it is
        read as the truth."""
        repo = Path(__file__).resolve().parent.parent
        migration = (repo / "supabase" / "migrations" / REARM_MIGRATION).read_text(
            encoding="utf-8")
        mirror = (repo / "docs" / "prototype-migrations.sql").read_text(encoding="utf-8")
        # assertTrue rather than assertIn: this compares two 12 kB strings, and
        # assertIn prints both of them on failure.
        self.assertTrue(
            migration in mirror,
            f"{REARM_MIGRATION} and its copy in docs/prototype-migrations.sql "
            "have drifted. Re-mirror it: the migration body goes in verbatim, "
            "under the banner that names the file.",
        )


class TestTheProvisionerAsksTheSameQuestion(unittest.TestCase):
    """scripts/provision-test-foreman.py creates a foreman-grade QA login, and
    refuses to when the cage is not on the database. That refusal has to be
    judged the same way the deploy judges it: test_account_write_scope()'s
    `guarded` column asks only whether a trigger of that NAME exists — no
    check of the function, the timing, the arguments or whether it is switched
    on. On a database where a guard is mis-attached or disabled, the old
    question says yes, provisioning proceeds, and the deploy's fence check on
    the same database says no."""

    def source(self) -> str:
        path = Path(__file__).resolve().parent / "provision-test-foreman.py"
        return path.read_text(encoding="utf-8")

    def test_the_preflight_reads_the_census(self):
        body = " ".join(self.source().split())
        start = body.index("def guard_is_installed()")
        preflight = body[start:body.index("def check_migration()", start)]
        self.assertIn("public.sandbox_guard_census()", preflight)
        self.assertIn("public.sandbox_scoped_tables()", preflight)
        self.assertNotIn(
            "public.test_account_write_scope()", preflight,
            "the pre-flight is back on the weaker definition of 'guarded' — a "
            "trigger of the right name, whatever it points at",
        )

    def test_the_run_checks_coverage_with_the_census_too(self):
        """Step 8 asserts every project-scoped table carries the guard. Same
        reasoning, and the same function has to answer it."""
        body = " ".join(self.source().split())
        claim = "every project-scoped table carries the guard"
        self.assertIn(claim, body)
        before = body[body.index("8. Say out loud what is NOT covered"):body.index(claim)]
        self.assertIn("public.sandbox_guard_census()", before)


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

    def test_a_real_job_in_the_sandbox_is_named_in_the_headline(self):
        """Every trigger can be in place and a QA login can still write a
        customer's house, because the sandbox grew to include one. A summary
        whose first line reads "HOLDING" and nothing else is how that went
        unremarked from 2026-08-25 to 2026-09-02."""
        census = load_census([census_file([
            "scoped|project_openings|project_id|project",
            "sandbox_job|ZZTEST|TEST — automation sandbox",
            "sandbox_job|BLACK22|Black Desert",
        ])])
        summary, ok = render(census, "czprjcskmzzagdztqonm")
        self.assertTrue(ok, "the fence question is about triggers, and they are all here")
        self.assertIn("1 real job is inside the sandbox", summary.splitlines()[0])
        self.assertIn("**a real job**", summary)
        self.assertIn(SANDBOX_DECISION, summary)

    def test_the_automation_sandbox_on_its_own_raises_nothing(self):
        """ZZTEST exists to be written by robots. Crying wolf over it would
        train everyone to skip the paragraph that matters."""
        census = load_census([census_file([
            "scoped|project_openings|project_id|project",
            "sandbox_job|ZZTEST|TEST — automation sandbox",
        ])])
        summary, ok = render(census, "czprjcskmzzagdztqonm")
        self.assertTrue(ok)
        self.assertEqual("### Test-login fence: HOLDING", summary.splitlines()[0])
        self.assertNotIn("**a real job**", summary)
        self.assertNotIn(SANDBOX_DECISION, summary)

    def test_the_decision_the_summary_points_at_is_written_down(self):
        """A deploy summary citing a file nobody wrote is worse than one that
        says nothing at all."""
        self.assertTrue(
            (Path(__file__).resolve().parent.parent / SANDBOX_DECISION).exists(),
            f"{SANDBOX_DECISION} is quoted in every deploy summary that finds a "
            "real job inside the sandbox",
        )

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
            "sandbox_job|BLACK22|Black Desert",
            "test_login|TEST — automation FOREMAN, do not assign",
        ])])
        self.assertEqual(
            "::result:: scoped=2 unguarded=1 sandbox_jobs=2 real_jobs=1 test_logins=1",
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

    def test_a_later_migration_arming_the_fence_does_not_clear_it(self):
        """Filenames are a version order, not the order files reach a
        database. `supabase db push` applies whatever is pending, so the
        arming migration may already have run when this table lands — the
        table is created, nothing sweeps, and the fence is down on it. Only
        arming in the SAME file has no such gap."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            (directory / "20260971000000_arm_it.sql").write_text(
                "select public.attach_sandbox_guards();\n", encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260970000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_a_table_that_becomes_project_scoped_later_is_caught(self):
        """`alter table cost_codes add column project_id` makes a table that
        has existed for months project-scoped for the first time. It has no
        trigger from that statement onwards, and keying coverage to the
        migration that CREATED it would call it covered forever."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260500000000_cost_codes.sql").write_text(
                "create table cost_codes (id uuid primary key, code text);\n",
                encoding="utf-8",
            )
            (directory / "20260970000000_bill_by_job.sql").write_text(
                "alter table cost_codes add column project_id uuid references projects(id);\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("cost_codes", "project_id", "20260970000000_bill_by_job.sql")],
                uncovered_new_tables(directory),
            )

    def test_a_table_dropped_and_recreated_is_caught(self):
        """Root cause 2, in a future migration. Postgres drops the trigger
        with the table, so a recreated table is a new table as far as the
        fence is concerned — which is how project_marks and package_events
        lost guards they had on day one."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260814000000_storage_tracking.sql").write_text(
                "create table packages (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            (directory / "20260970000000_repack.sql").write_text(
                "drop table packages cascade;\n"
                "create table packages (id uuid primary key, project_id uuid, lpn text);\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("packages", "project_id", "20260970000000_repack.sql")],
                uncovered_new_tables(directory),
            )

    def test_a_recreated_table_that_arms_itself_is_fine(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260814000000_storage_tracking.sql").write_text(
                "create table packages (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            (directory / "20260970000000_repack.sql").write_text(
                "drop table packages cascade;\n"
                "create table packages (id uuid primary key, project_id uuid, lpn text);\n"
                "select public.attach_sandbox_guards();\n",
                encoding="utf-8",
            )
            self.assertEqual([], uncovered_new_tables(directory))

    def test_the_tables_the_rearm_sweep_covered_are_not_re_reported(self):
        """The gate has to stay quiet about the forty-three tables
        20260967000000 actually armed, or nobody will read it."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260814000000_storage_tracking.sql").write_text(
                "create table packages (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            self.assertIn("packages", REARM_COVERED)
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

    def test_naming_the_function_inside_a_string_is_not_arming_it(self):
        """`comment on function … is '… select public.attach_sandbox_guards();
        …'` is the sentence 20260967000000 itself writes, in a SQL literal.
        Reading literals as code means the documentation of the fix passes for
        the fix."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n"
                "comment on table job_notes is\n"
                "  'Any migration that adds one of these must end with "
                "`select public.attach_sandbox_guards();`.';\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260970000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_naming_the_function_in_a_block_comment_is_not_arming_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "/* todo: select public.attach_sandbox_guards();\n"
                "   /* and mind the nesting */ still inside */\n"
                "create table job_notes (id uuid primary key, project_id uuid);\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260970000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_a_raise_notice_quoting_the_instruction_is_not_arming_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n"
                "do $$ begin\n"
                "  raise notice 'next time, select public.attach_sandbox_guards();';\n"
                "end $$;\n",
                encoding="utf-8",
            )
            self.assertEqual(
                [("job_notes", "project_id", "20260970000000_new_feature.sql")],
                uncovered_new_tables(directory),
            )

    def test_arming_from_inside_a_do_block_still_counts(self):
        """Which is how 20260967000000 does it, so a scanner that threw dollar
        bodies away would call the real fix a mention."""
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "20260970000000_new_feature.sql").write_text(
                "create table job_notes (id uuid primary key, project_id uuid);\n"
                "do $$ declare v int; begin\n"
                "  select count(*) into v from public.attach_sandbox_guards();\n"
                "  raise notice 'armed %', v;\n"
                "end $$;\n",
                encoding="utf-8",
            )
            self.assertEqual([], uncovered_new_tables(directory))

    def test_deleting_the_real_arming_block_is_noticed(self):
        """The whole gate, pointed at the real migration with its `do` block
        cut out. Everything else in that file — the function definition, the
        grants, the sentence in `comment on` — still names the function."""
        migration = (MIGRATIONS_DIR / REARM_MIGRATION).read_text(encoding="utf-8")
        cut = migration.index("-- 4. Arm it now")
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / REARM_MIGRATION).write_text(migration[:cut], encoding="utf-8")
            self.assertEqual([], migrations_calling_attach(directory))
            self.assertIn(
                REARM_MIGRATION, migrations_calling_attach(MIGRATIONS_DIR),
                "and the real file, with the block, still counts",
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
