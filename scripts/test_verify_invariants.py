#!/usr/bin/env python3
"""Tests for scripts/verify_invariants.py.

    python3 scripts/test_verify_invariants.py

Stdlib only, offline. Each case hands the judge a small hand-built report of
the shape scripts/invariants.sql produces, so nothing here needs a token, a
project or a network.

A check nobody has proved can FAIL is not a check, so the cases that matter
are the failing ones: a wall policy without its guard, a money table without
its door, a read policy open to anon, a client role that can read pin_hash, a
project-scoped table missing the fence, a table without RLS, a function anon
can call. Each has to be reported in a sentence that names the table or the
function. And the good shape — the one production is supposed to
have — has to pass with no failures, or the gate is red on day one and people
learn to skip it.
"""
from __future__ import annotations

import io
import json
import sys
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_invariants as vi  # noqa: E402


def policy(table, name="p", cmd="SELECT", roles=("authenticated",), using="", check="", schema="public"):
    return {"schema": schema, "table": table, "name": name, "cmd": cmd,
            "roles": list(roles), "using": using, "check": check}


WALL = "(NOT is_partner_user()) AND (true)"


def healthy() -> dict:
    return {
        "policies": [
            policy("project_openings", "openings_read", using=WALL),
            policy("packages", "packages_all", cmd="ALL", using=WALL, check=WALL),
            policy("projects", "projects_read", using="(EXISTS (partner_job_grants...)) OR (NOT is_partner_user())"),
            policy("daily_logs", "logs_read", using="(my_role_rank() >= 1)"),
            policy("access_requests", "anon can request", cmd="INSERT", roles=("anon",), check="true"),
            policy("job_costs", "authenticated full access", cmd="ALL",
                   using="(NOT is_partner_user()) AND can_see_costs(auth.uid())",
                   check="(NOT is_partner_user()) AND can_see_costs(auth.uid())"),
            policy("receipts", "receipts_select",
                   using="(NOT is_partner_user()) AND ((my_role_rank() >= 2) OR can_see_costs(auth.uid()) OR (uploaded_by = auth.uid()))"),
            policy("pay_rates", "pay_rates_select", using="(NOT is_partner_user()) AND can_see_pay(auth.uid())"),
            policy("objects", "authenticated plansets", schema="storage",
                   using="(bucket_id = 'plansets') AND (NOT is_partner_user())"),
            policy("objects", "trip attachments read", schema="storage", using="(bucket_id = 'trips')"),
            policy("packages", "service writes", cmd="INSERT", roles=("service_role",), check="true"),
        ],
        "profile_columns": [
            {"column": "pin_hash", "role": "anon", "select": False},
            {"column": "pin_hash", "role": "authenticated", "select": False},
            {"column": "pin_salt", "role": "anon", "select": False},
            {"column": "pin_salt", "role": "authenticated", "select": False},
        ],
        "profile_truncate": {"anon": False, "authenticated": False},
        "fence_unguarded": [],
        "test_logins": 2,
        "rls_off": [],
        "anon_functions": [],
        "anon_default_execute": False,
        "definer_unpinned": [],
    }


class TheHealthyShapePasses(unittest.TestCase):
    def test_no_failures_no_advisories(self):
        failures, advisories, summary = vi.judge(healthy())
        self.assertEqual(failures, [])
        self.assertEqual(advisories, [])
        self.assertTrue(any("read policies" in s for s in summary))
        self.assertTrue(any("anon-executable" in s for s in summary))

    def test_exempt_tables_are_the_walls_own_list(self):
        # projects and daily_logs carry no guard in the healthy fixture and
        # must not be reported — the same two the static test exempts.
        self.assertEqual(vi.PARTNER_WALL_EXEMPT_TABLES, frozenset({"projects", "daily_logs"}))

    def test_storage_todo_list_is_shared_with_the_static_test(self):
        self.assertIn("trip attachments read", vi.STORAGE_WALL_TODO)


class TheWall(unittest.TestCase):
    def test_a_read_policy_without_the_guard_fails_and_names_the_table(self):
        r = healthy()
        r["policies"].append(policy("time_shifts", "shifts_read", using="true"))
        failures, _, _ = vi.judge(r)
        self.assertEqual(len(failures), 1)
        self.assertIn("time_shifts", failures[0])
        self.assertIn("is_partner_user()", failures[0])

    def test_a_policy_to_public_counts_as_client_facing(self):
        r = healthy()
        r["policies"].append(policy("time_shifts", "shifts_read", roles=("public",), using="true"))
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("time_shifts" in f and "is_partner_user" in f for f in failures))

    def test_a_for_all_policy_guarded_only_on_using_fails_on_the_check_side(self):
        r = healthy()
        r["policies"].append(policy("packages", "packages_write", cmd="ALL", using=WALL, check="true"))
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("WITH CHECK side" in f for f in failures), failures)

    def test_service_role_only_policies_are_not_the_walls_business(self):
        r = healthy()
        r["policies"].append(policy("time_shifts", "svc", roles=("service_role",), using="true"))
        failures, _, _ = vi.judge(r)
        self.assertEqual(failures, [])

    def test_a_new_storage_bucket_without_the_guard_fails(self):
        r = healthy()
        r["policies"].append(policy("objects", "authenticated receipts", schema="storage", using="(bucket_id = 'receipts')"))
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("storage bucket" in f and "authenticated receipts" in f for f in failures))


class TheMoneyDoors(unittest.TestCase):
    def test_a_cost_table_read_without_can_see_costs_fails(self):
        r = healthy()
        r["policies"].append(policy("project_financials", "wide open", using=WALL))
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("money door on project_financials" in f for f in failures), failures)

    def test_pay_rates_must_ask_can_see_pay(self):
        r = healthy()
        r["policies"] = [p for p in r["policies"] if p["table"] != "pay_rates"]
        r["policies"].append(policy("pay_rates", "pay_rates_select", using=WALL))
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("pay door" in f for f in failures), failures)


class NobodyReadsAnonymously(unittest.TestCase):
    def test_an_anon_read_policy_fails(self):
        r = healthy()
        r["policies"].append(policy("projects", "everyone", roles=("anon",), using="true"))
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("Anyone on the internet can read projects" in f for f in failures))

    def test_an_anon_insert_policy_is_allowed(self):
        # access_requests lets a stranger ask for an account; that is a write.
        failures, _, _ = vi.judge(healthy())
        self.assertEqual(failures, [])


class Profiles(unittest.TestCase):
    def test_a_client_role_reading_pin_hash_fails(self):
        r = healthy()
        r["profile_columns"][1]["select"] = True
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("authenticated can SELECT profiles.pin_hash" in f for f in failures))

    def test_truncate_granted_back_fails(self):
        r = healthy()
        r["profile_truncate"]["authenticated"] = True
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("TRUNCATE profiles" in f for f in failures))

    def test_a_dropped_credential_column_is_simply_absent(self):
        r = healthy()
        r["profile_columns"] = [c for c in r["profile_columns"] if c["column"] != "pin_salt"]
        failures, _, _ = vi.judge(r)
        self.assertEqual(failures, [])


class TheFence(unittest.TestCase):
    def test_an_unguarded_project_scoped_table_fails(self):
        r = healthy()
        r["fence_unguarded"] = [{"table": "unit_sessions", "column": "project_id", "reason": "no trigger"}]
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("unit_sessions" in f and "attach_sandbox_guards" in f for f in failures))

    def test_a_third_test_login_fails(self):
        r = healthy()
        r["test_logins"] = 3
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("3 test logins" in f for f in failures))

    def test_an_unmeasured_fence_is_a_failure_not_a_pass(self):
        r = healthy()
        del r["fence_unguarded"]
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("could not be measured" in f for f in failures))


class RlsEverywhere(unittest.TestCase):
    def test_a_reachable_table_without_rls_fails_and_names_it(self):
        r = healthy()
        r["rls_off"] = ["window_id_counters"]
        failures, advisories, _ = vi.judge(r)
        self.assertEqual(advisories, [])
        self.assertEqual(len(failures), 1)
        self.assertIn("window_id_counters", failures[0])
        self.assertIn("enable row level security", failures[0])

    def test_an_unmeasured_list_is_a_failure_not_a_pass(self):
        r = healthy()
        del r["rls_off"]
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("rls_off" in f for f in failures))


class NobodyCallsAnonymously(unittest.TestCase):
    def test_a_function_anon_can_execute_fails_and_names_it(self):
        r = healthy()
        r["anon_functions"] = ["finish_unit", "role_rank"]
        failures, advisories, _ = vi.judge(r)
        self.assertEqual(advisories, [])
        self.assertEqual(len(failures), 1)
        self.assertIn("finish_unit, role_rank", failures[0])
        self.assertIn("20260992000000", failures[0])

    def test_the_keep_list_is_empty_and_honoured(self):
        # Nothing signed-out calls a function in public (20260992000000's
        # header lists every flow that was read). A name added here must also
        # be granted in a migration; then the probe stays quiet about it.
        self.assertEqual(vi.ANON_FUNCTIONS_ALLOWED, frozenset())
        r = healthy()
        r["anon_functions"] = ["vault_pin_is_set"]
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("vault_pin_is_set" in f for f in failures))
        with unittest.mock.patch.object(vi, "ANON_FUNCTIONS_ALLOWED", frozenset({"vault_pin_is_set"})):
            failures, _, _ = vi.judge(r)
        self.assertEqual(failures, [])

    def test_a_default_rule_that_reopens_the_door_fails(self):
        r = healthy()
        r["anon_default_execute"] = True
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("default privileges" in f and "20260992000000" in f for f in failures))

    def test_an_unmeasured_list_is_a_failure_not_a_pass(self):
        r = healthy()
        del r["anon_functions"]
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("anon_functions" in f for f in failures))


class DefinerFunctionsPinSearchPath(unittest.TestCase):
    # Promoted from an advisory the day production showed the list empty
    # (20260997000000 was the sweep).
    def test_an_unpinned_definer_function_fails_and_is_named_by_signature(self):
        r = healthy()
        r["definer_unpinned"] = ["mint_packages(p_count integer)", "add_supply(p_name text, p_unit text)"]
        failures, advisories, summary = vi.judge(r)
        self.assertEqual(advisories, [])
        self.assertEqual(len(failures), 1)
        self.assertIn("mint_packages(p_count integer), add_supply(p_name text, p_unit text)", failures[0])
        self.assertIn("set search_path = public, pg_temp", failures[0])
        self.assertIn("20260997000000", failures[0])
        self.assertTrue(any("2 SECURITY DEFINER function(s) without a pinned search_path" in s for s in summary))

    def test_an_empty_list_says_nothing(self):
        failures, advisories, summary = vi.judge(healthy())
        self.assertEqual(advisories, [])
        self.assertTrue(any("0 SECURITY DEFINER function(s) without a pinned search_path" in s for s in summary))

    def test_an_unmeasured_list_is_a_failure_not_a_pass(self):
        # invariants.sql and this judge have to agree about the report's
        # keys; a missing one is the two drifting apart, not a clean answer.
        r = healthy()
        del r["definer_unpinned"]
        failures, _, _ = vi.judge(r)
        self.assertTrue(any("definer_unpinned" in f for f in failures))


class TheReportEnvelope(unittest.TestCase):
    def test_one_row_one_report_column(self):
        self.assertEqual(vi.load_report(json.dumps([{"report": {"x": 1}}])), {"x": 1})

    def test_a_string_report_is_parsed(self):
        self.assertEqual(vi.load_report(json.dumps([{"report": json.dumps({"x": 1})}])), {"x": 1})

    def test_an_api_error_is_a_verification_failure(self):
        with self.assertRaises(SystemExit) as ctx:
            vi.load_report(json.dumps({"message": "permission denied"}))
        self.assertIn("VERIFICATION failure", str(ctx.exception))

    def test_a_missing_census_function_says_which_migration(self):
        with self.assertRaises(SystemExit) as ctx:
            vi.load_report(json.dumps({"message": "function public.sandbox_guard_census() does not exist"}))
        self.assertIn("20260967000000", str(ctx.exception))

    def test_garbage_is_a_verification_failure(self):
        with self.assertRaises(SystemExit):
            vi.load_report("not json")
        with self.assertRaises(SystemExit):
            vi.load_report(json.dumps([{"other": 1}]))


class TheCli(unittest.TestCase):
    def _run(self, report):
        import tempfile, os
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump([{"report": report}], fh)
            path = fh.name
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = vi.main(["verify_invariants.py", path])
            return code, buf.getvalue()
        finally:
            os.remove(path)

    def test_healthy_exits_zero_and_says_ok(self):
        code, out = self._run(healthy())
        self.assertEqual(code, 0)
        self.assertIn("OK: every security invariant holds", out)

    def test_broken_exits_one_and_lists_each_failure(self):
        r = healthy()
        r["policies"].append(policy("time_shifts", "shifts_read", using="true"))
        r["test_logins"] = 5
        code, out = self._run(r)
        self.assertEqual(code, 1)
        self.assertIn("FAIL: 2 security invariant(s)", out)
        self.assertIn("time_shifts", out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
