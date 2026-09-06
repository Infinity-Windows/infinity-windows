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

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import restore_verify as rv  # noqa: E402
from backup_manifest import row_hash  # noqa: E402

SCHEMA_SQL = """
--
-- PostgreSQL database dump
--
-- Dumped from database version 15.8

CREATE TABLE public.profiles (id uuid NOT NULL, display_name text);

CREATE FUNCTION public.finish_unit(p_unit uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$ begin end $$;

CREATE OR REPLACE FUNCTION public.my_pin_status() RETURNS boolean
    LANGUAGE sql
    AS $$ select false $$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

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


def runner(counts=None, functions=None, policies=None, spot=PROFILE_ROW):
    """A fake psql. Answers the four shapes of query the verifier asks."""
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
        if "count(*)" in sql:
            lines = []
            for part in sql.split(" union all "):
                schema = part.split("select '")[1].split("'")[0]
                table = part.split(" as s, '")[1].split("'")[0]
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

    def test_a_table_that_did_not_come_back_at_all_fails(self):
        problems, _ = rv.verify(
            MANIFEST, SCHEMA_SQL, runner(counts={("public", "profiles"): 2})
        )
        self.assertTrue(any("not in the restored database" in p for p in problems))

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

    # Reading the dump.
    def test_it_reads_both_create_function_spellings_and_quoted_policy_names(self):
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

    def test_a_schema_dump_that_declares_nothing_is_not_treated_as_a_pass_signal(self):
        problems, checks = rv.verify(MANIFEST, "", runner())
        # Nothing declared means nothing to miss — but the counts and the spot
        # row still have to hold, and the summary must not claim otherwise.
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


if __name__ == "__main__":
    unittest.main(verbosity=1)
