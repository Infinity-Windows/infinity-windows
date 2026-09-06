#!/usr/bin/env python3
"""Tests for scripts/restore_verify.py.

    python3 scripts/test_restore_verify.py

Stdlib only. No Postgres, no psql, no dump: the restored database is a dict and
`psql` is a function.

This is the test of the check, and the check is the only thing standing between
"we take backups" and "we can get the company back". So what is pinned here is
that it FAILS on each of the three ways a restore goes wrong — short table,
missing policy, altered row — because a restore verifier that passes on a broken
restore is worse than not having one: it converts an unknown into a false
reassurance.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import restore_verify as rv  # noqa: E402
from backup_manifest import row_hash  # noqa: E402

# What `supabase db dump --linked -f schema.sql` actually writes, and the only
# input that matters: pg_dump runs with --quote-all-identifier, so EVERY
# identifier is quoted, and the CLI's pipeline rewrites `CREATE FUNCTION "` to
# `CREATE OR REPLACE FUNCTION "` and then deletes every comment line.
#
# This file used to test against an unquoted, commented dump that the CLI cannot
# produce. Both checks found nothing in a real dump and reported "0 of 0
# declared exist" as a pass.
SCHEMA_SQL = """SET statement_timeout = 0;
SET row_security = off;

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "display_name" "text"
);

CREATE OR REPLACE FUNCTION "public"."finish_unit"("p_unit" "uuid") RETURNS void
    LANGUAGE "plpgsql"
    AS $$ begin end $$;

CREATE OR REPLACE FUNCTION "public"."my_pin_status"() RETURNS boolean
    LANGUAGE "sql"
    AS $$ select false $$;

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles are readable by the crew" ON "public"."profiles" FOR SELECT USING (true);

CREATE POLICY "installers_own_pay" ON "public"."time_shifts" FOR SELECT USING (true);
"""

# A pg_dump run by hand, without --quote-all-identifier. Not what the nightly
# writes, but it is what somebody reaches for on the worst day, so it has to
# read too.
UNQUOTED_SCHEMA_SQL = """
CREATE FUNCTION public.finish_unit(p_unit uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$ begin end $$;

CREATE OR REPLACE FUNCTION public.my_pin_status() RETURNS boolean
    LANGUAGE sql
    AS $$ select false $$;

CREATE POLICY "profiles are readable by the crew" ON public.profiles FOR SELECT USING (true);

CREATE POLICY installers_own_pay ON public.time_shifts FOR SELECT USING (true);
"""

PROFILE_ROW = {"id": "p1", "display_name": "Dave"}

MANIFEST = {
    "started_at": "2026-09-05T09:10:00Z",
    "total_rows": 7,
    "tables": [
        {"schema": "public", "table": "profiles", "rows": 2},
        {"schema": "public", "table": "time_shifts", "rows": 5},
    ],
    "spot_rows": [
        {"schema": "public", "table": "profiles", "id": "p1", "sha256": row_hash(PROFILE_ROW)},
    ],
}


def runner(counts=None, functions=None, policies=None, spot=PROFILE_ROW, breaks=()):
    """A fake psql. Answers the five shapes of query the verifier asks.

    `breaks` names tables whose count query fails the way real psql fails, which
    is by returning non-zero and taking the whole batched statement with it.
    """
    counts = {("public", "profiles"): 2, ("public", "time_shifts"): 5} if counts is None else counts
    functions = (
        {("public", "finish_unit"), ("public", "my_pin_status")} if functions is None else functions
    )
    policies = (
        {
            ("public", "profiles", "profiles are readable by the crew"),
            ("public", "time_shifts", "installers_own_pay"),
        }
        if policies is None
        else policies
    )

    def run(sql):
        if "from pg_proc" in sql:
            return "\n".join("\t".join(f) for f in sorted(functions))
        if "from pg_policies" in sql:
            return "\n".join("\t".join(p) for p in sorted(policies))
        if "from pg_class" in sql:
            # Only what really came back — the catalog is how a table that is
            # missing gets named instead of blowing up a batch.
            return "\n".join("\t".join(k) for k in sorted(counts))
        if "count(*)" in sql and " as s," not in sql:
            # The per-table retry: `select count(*) from "s"."t"`, one number.
            schema = sql.split('from "')[1].split('"')[0]
            table = sql.split('"."')[1].split('"')[0]
            if (schema, table) in breaks:
                raise RuntimeError('psql failed: relation "%s.%s" is broken' % (schema, table))
            return str(counts[(schema, table)])
        if "count(*)" in sql:
            lines = []
            for part in sql.split(" union all "):
                schema = part.split("select '")[1].split("'")[0]
                table = part.split(" as s, '")[1].split("'")[0]
                if (schema, table) in breaks:
                    raise RuntimeError("psql failed: ON_ERROR_STOP killed the batch")
                if (schema, table) in counts:
                    lines.append("%s\t%s\t%d" % (schema, table, counts[(schema, table)]))
            return "\n".join(lines)
        if "to_jsonb(t)::text" in sql:
            return "" if spot is None else json.dumps(spot, sort_keys=True)
        raise AssertionError("unexpected sql: %s" % sql[:120])

    return run


class Case(unittest.TestCase):
    def test_a_good_restore_passes(self):
        problems, checks = rv.verify(MANIFEST, SCHEMA_SQL, runner())
        self.assertEqual(problems, [])
        self.assertIn("row counts: 2 of 2", checks[0])
        self.assertIn("functions: 2 of 2", checks[1])
        self.assertIn("policies: 2 of 2", checks[2])
        self.assertIn("spot rows: 1 of 1", checks[3])

    # 1. The failure that looks most like success.
    def test_a_short_table_fails_and_says_which_and_by_how_much(self):
        problems, _ = rv.verify(
            MANIFEST,
            SCHEMA_SQL,
            runner(counts={("public", "profiles"): 2, ("public", "time_shifts"): 3}),
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("time_shifts restored 3 row(s), the backup recorded 5", problems[0])

    def test_a_table_that_did_not_come_back_at_all_is_named_not_a_traceback(self):
        # The batched count query runs under ON_ERROR_STOP=1, so one missing
        # relation used to kill the whole statement, escape verify(), and leave
        # no verdict file at all — Slack then said only "Restore test did not
        # produce a verdict", with no cause in it.
        problems, _ = rv.verify(
            MANIFEST, SCHEMA_SQL, runner(counts={("public", "profiles"): 2})
        )
        self.assertTrue(
            any("public.time_shifts is in the backup manifest but not in the restored database" in p
                for p in problems),
            problems,
        )

    def test_a_table_that_cannot_be_counted_names_itself_and_spares_the_others(self):
        problems, checks = rv.verify(
            MANIFEST, SCHEMA_SQL, runner(breaks={("public", "time_shifts")})
        )
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("public.time_shifts", problems[0])
        self.assertIn("could not be counted", problems[0])
        self.assertIn("row counts: 1 of 2", checks[0], "the other table still answered")

    # 2. The dangerous one: every row present, nobody's privacy left.
    def test_a_missing_rls_policy_fails_and_explains_the_consequence(self):
        problems, _ = rv.verify(
            MANIFEST,
            SCHEMA_SQL,
            runner(policies={("public", "profiles", "profiles are readable by the crew")}),
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("installers_own_pay", problems[0])
        self.assertIn("rows they may not see", problems[0])

    def test_a_missing_function_fails(self):
        problems, _ = rv.verify(
            MANIFEST, SCHEMA_SQL, runner(functions={("public", "my_pin_status")})
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("public.finish_unit", problems[0])

    # 3. Right count, wrong bytes.
    def test_an_altered_spot_row_fails(self):
        problems, _ = rv.verify(
            MANIFEST, SCHEMA_SQL, runner(spot={"id": "p1", "display_name": "Dav"})
        )
        self.assertEqual(len(problems), 2)
        self.assertIn("came back with different contents", problems[0])

    def test_a_missing_spot_row_fails(self):
        problems, _ = rv.verify(MANIFEST, SCHEMA_SQL, runner(spot=None))
        self.assertTrue(any("is not in the restored database" in p for p in problems))

    # Reading the dump. This is the pair that silently found nothing.
    def test_it_reads_the_quoted_identifiers_a_real_dump_is_made_of(self):
        self.assertEqual(
            rv.declared_functions(SCHEMA_SQL),
            [("public", "finish_unit"), ("public", "my_pin_status")],
        )
        self.assertEqual(
            rv.declared_policies(SCHEMA_SQL),
            [
                ("public", "profiles", "profiles are readable by the crew"),
                ("public", "time_shifts", "installers_own_pay"),
            ],
        )

    def test_it_still_reads_a_pg_dump_run_by_hand_without_quoting(self):
        self.assertEqual(
            rv.declared_functions(UNQUOTED_SCHEMA_SQL),
            [("public", "finish_unit"), ("public", "my_pin_status")],
        )
        self.assertEqual(
            rv.declared_policies(UNQUOTED_SCHEMA_SQL),
            [
                ("public", "profiles", "profiles are readable by the crew"),
                ("public", "time_shifts", "installers_own_pay"),
            ],
        )

    # The floor. "0 of 0 declared exist" must never read as a pass.
    def test_a_dump_this_file_cannot_read_fails_instead_of_passing_vacuously(self):
        problems, _ = rv.verify(MANIFEST, "CREATE TABLE nothing_it_understands();", runner())
        self.assertTrue(any("the dump was not read" in p for p in problems), problems)

    def test_no_schema_dump_at_all_is_not_turned_into_a_false_alarm(self):
        # A backup folder with no schema.sql has nothing to check; the counts and
        # the spot row still have to hold, and the summary must not claim more.
        problems, checks = rv.verify(MANIFEST, "", runner())
        self.assertEqual(problems, [])
        self.assertIn("functions: 0 of 0", checks[1])

    def test_the_spot_row_is_looked_up_by_the_manifests_own_id(self):
        seen = []

        def run(sql):
            seen.append(sql)
            return runner()(sql)

        rv.verify(MANIFEST, SCHEMA_SQL, run)
        lookups = [s for s in seen if "to_jsonb" in s]
        self.assertEqual(len(lookups), 1)
        self.assertIn("t.id::text = 'p1'", lookups[0])

    def test_a_spot_row_with_no_id_falls_back_to_the_ordering_query(self):
        manifest = dict(MANIFEST)
        manifest["spot_rows"] = [
            {"schema": "public", "table": "profiles", "id": None, "sha256": row_hash(PROFILE_ROW)}
        ]
        seen = []

        def run(sql):
            seen.append(sql)
            return runner()(sql)

        problems, _ = rv.verify(manifest, SCHEMA_SQL, run)
        self.assertEqual(problems, [])
        lookups = [s for s in seen if "to_jsonb" in s]
        self.assertIn("order by 1 limit 1", lookups[0])

    def test_an_id_with_a_quote_in_it_cannot_break_the_lookup(self):
        manifest = dict(MANIFEST)
        manifest["spot_rows"] = [
            {"schema": "public", "table": "profiles", "id": "p'1", "sha256": row_hash(PROFILE_ROW)}
        ]
        seen = []

        def run(sql):
            seen.append(sql)
            return runner()(sql)

        rv.verify(manifest, SCHEMA_SQL, run)
        lookups = [s for s in seen if "to_jsonb" in s]
        self.assertIn("t.id::text = 'p''1'", lookups[0])


class Verdict(unittest.TestCase):
    """Whatever happens, a verdict file gets written.

    The workflow reads its first line and posts that to Slack as the cause. With
    no file, the entire notification is "Restore test did not produce a verdict".
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "MANIFEST.json"), "w") as fh:
            json.dump(MANIFEST, fh)
        with open(os.path.join(self.dir, "schema.sql"), "w") as fh:
            fh.write(SCHEMA_SQL)
        self.summary = os.path.join(self.dir, "verdict.txt")

    def main(self):
        return rv.main(
            ["--backup", self.dir, "--db-url", "postgresql://nobody@localhost:1/x",
             "--summary", self.summary]
        )

    def test_a_check_that_cannot_run_at_all_still_says_why(self):
        def explode(_db_url):
            def run(_sql):
                raise RuntimeError("could not connect to server")

            return run

        prior, rv.psql_runner = rv.psql_runner, explode
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = self.main()
        finally:
            rv.psql_runner = prior
        self.assertEqual(code, 1)
        with open(self.summary) as fh:
            line = fh.readline()
        self.assertIn("FAILED", line)
        self.assertIn("could not connect to server", line)

    def test_a_good_restore_writes_the_passing_line(self):
        prior, rv.psql_runner = rv.psql_runner, lambda _db_url: runner()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                code = self.main()
        finally:
            rv.psql_runner = prior
        self.assertEqual(code, 0)
        with open(self.summary) as fh:
            self.assertIn("Restore test PASSED", fh.readline())


if __name__ == "__main__":
    unittest.main(verbosity=1)
