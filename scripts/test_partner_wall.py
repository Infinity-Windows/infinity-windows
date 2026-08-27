#!/usr/bin/env python3
"""Standing test for wave S's partner wall (THE WALL, 20260950000000).

    python3 scripts/test_partner_wall.py

Dynamically replays every migration to find every table that currently
grants SELECT (directly, or via a FOR ALL policy) to `authenticated`, and
asserts each one — outside the two named exemptions — has the
`is_partner_user()` guard folded into every such policy. This is a listing
test in the same spirit as test_supabase_merge.py's DEDUP_KEYS checks: it
does not hardcode which tables were swept on the day the wall migration was
written, so a FUTURE migration that adds a table with a naive
`using (true)` select policy fails THIS test on its own — see
scripts/partner_wall_lib.py's module docstring for the mechanics.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from partner_wall_lib import (  # noqa: E402
    DROPPED_LATER_TABLES,
    KNOWN_DYNAMIC_SOURCES,
    NOT_PUBLIC_SCHEMA_TABLES,
    PARTNER_WALL_EXEMPT_TABLES,
    live_select_granting_tables,
    replay_policies,
)

GUARD = "is_partner_user()"


class TestParserHealth(unittest.TestCase):
    """If this fails, the parser hit a policy-defining construct it doesn't
    understand — extend partner_wall_lib.py's known-dynamic handling (or its
    regexes) rather than ignore this."""

    def test_every_unparsed_statement_is_a_known_dynamic_source(self):
        _states, unparsed = replay_policies()
        genuinely_new = [
            u for u in unparsed
            if not any(u.startswith(src + ":") for src in KNOWN_DYNAMIC_SOURCES)
        ]
        self.assertEqual(
            genuinely_new, [],
            "a migration builds a policy this parser cannot read — see the "
            "module docstring in scripts/partner_wall_lib.py",
        )


class TestTheWall(unittest.TestCase):
    def test_exempt_tables_are_real_tables(self):
        live = live_select_granting_tables()
        for table in PARTNER_WALL_EXEMPT_TABLES:
            self.assertIn(
                table, live,
                f"{table} is listed as wall-exempt but has no live select policy "
                "at all — either it was removed and the exemption is stale, or "
                "the table name is misspelled",
            )

    def test_every_swept_table_guards_every_select_policy(self):
        live = live_select_granting_tables()
        missing: dict[str, list[str]] = {}
        for table, policies in live.items():
            if table in PARTNER_WALL_EXEMPT_TABLES:
                continue
            unguarded = [
                name for name, p in policies.items()
                if GUARD not in p.using
            ]
            if unguarded:
                missing[table] = unguarded
        self.assertEqual(
            missing, {},
            "these tables grant SELECT to authenticated without the "
            "is_partner_user() guard — a partner login can read them "
            "straight off REST: " + repr(missing),
        )

    def test_a_for_all_policy_guards_with_check_too(self):
        # A partner blocked from reading a table by USING but left able to
        # blind-INSERT/UPDATE via an unguarded WITH CHECK is a write hole,
        # not a fixed table. Every FOR ALL policy on a swept table must
        # guard both clauses.
        live = live_select_granting_tables()
        unguarded_check: dict[str, list[str]] = {}
        for table, policies in live.items():
            if table in PARTNER_WALL_EXEMPT_TABLES:
                continue
            bad = [
                name for name, p in policies.items()
                if p.command == "ALL" and p.check and GUARD not in p.check
            ]
            if bad:
                unguarded_check[table] = bad
        self.assertEqual(
            unguarded_check, {},
            "these FOR ALL policies guard reads but not writes (WITH CHECK "
            "has no is_partner_user()): " + repr(unguarded_check),
        )

    def test_projects_keeps_its_own_grant_exception_not_the_mechanical_guard(self):
        # projects is exempt from the mechanical sweep on purpose (see THE
        # WALL #4) — it should NOT carry the plain guard, it should carry
        # the partner_job_grants exists() clause instead. This pins that the
        # exception actually landed, not just that the table was skipped.
        live = live_select_granting_tables()
        self.assertIn("projects", live)
        using_texts = " ".join(p.using for p in live["projects"].values())
        self.assertIn("partner_job_grants", using_texts)
        self.assertIn("is_partner_user", using_texts)

    def test_daily_logs_is_untouched_by_the_wall(self):
        # daily_logs relies on its existing rank check (installer-ranked
        # partners already fail my_role_rank() >= 1) rather than the
        # mechanical guard — pin that this migration did not add one, which
        # would just be redundant noise on the one table THE WALL says to
        # leave alone.
        live = live_select_granting_tables()
        self.assertIn("daily_logs", live)
        using_texts = " ".join(p.using for p in live["daily_logs"].values())
        self.assertNotIn("is_partner_user", using_texts)
        self.assertIn("my_role_rank", using_texts)

    def test_swept_table_count_is_in_the_ballpark(self):
        # Not a strict pin (unlike DEDUP_KEYS' exact 107) — new tables land
        # on master often and each one correctly guarded just grows this
        # number, which is fine. This only catches something wildly wrong
        # with the parser itself (e.g. it stops matching FOR ALL policies
        # and the count craters).
        live = live_select_granting_tables()
        swept = len(live) - len(PARTNER_WALL_EXEMPT_TABLES & live.keys())
        self.assertGreaterEqual(
            swept, 95,
            f"only {swept} tables came back swept — the parser likely broke",
        )

    def test_dropped_and_non_public_tables_are_not_reported(self):
        live = live_select_granting_tables()
        for table in DROPPED_LATER_TABLES | NOT_PUBLIC_SCHEMA_TABLES:
            self.assertNotIn(table, live)


if __name__ == "__main__":
    unittest.main()
