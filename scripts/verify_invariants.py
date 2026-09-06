#!/usr/bin/env python3
"""Judge the security shape of the live database.

    scripts/pgq.sh scripts/invariants.sql | scripts/verify_invariants.py
    scripts/verify_invariants.py report.json

Exit 0 when every invariant holds, 1 when one does not — or when nothing could
be measured, because a check that cannot tell "clean" from "did not look" is
worse than no check. Normally run through scripts/verify-invariants.sh.

WHAT IS ASSERTED, and where each rule already lives as a static check over
the migration files:

  partner wall     every SELECT/ALL policy on a public table that grants to
                   `authenticated` carries is_partner_user(), except the two
                   tables THE WALL exempts. scripts/test_partner_wall.py
                   asserts this over the files; this asserts it over the
                   database. Storage bucket policies too, minus the ones that
                   test lists as work left to do.
  money doors      the cost tables' read policies still ask can_see_costs()
                   (pay_rates: can_see_pay()). 20260978000000.
  nobody reads     no read policy on a public table grants to anon or to
  anonymously      public (a policy written without `to` is `to public`).
  pin_hash         no client role can SELECT profiles.pin/pin_hash/pin_salt
                   or TRUNCATE profiles. 20260729200000 and 20260729200100.
  sandbox fence    sandbox_guard_census() is empty, and there are at most
                   two test logins. 20260967000000.

Three more are ADVISORY: listed in the output, never failing. Tables
reachable by a client role with RLS switched off; functions anon may execute
(20260992000000 revoked all of them, keep-list ANON_FUNCTIONS_ALLOWED); and
whether the default privileges would hand the NEXT function to anon. They were
true of parts of this schema before anyone looked, and a gate that is red on
its first run is a gate people learn to skip. When the list is empty on
production, promote them; the test suite pins the shape.

READ-ONLY. The SQL is scripts/invariants.sql, run through scripts/pgq.sh,
which refuses anything that is not a SELECT.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The same exemption lists the static tests use, imported rather than copied,
# so the live check and the file check can never disagree about which tables
# are outside the wall. test_partner_wall is a test module, but its TODO list
# is the only place that fact is written down; importing it is the honest way
# to share it.
from partner_wall_lib import PARTNER_WALL_EXEMPT_TABLES  # noqa: E402
from test_partner_wall import STORAGE_WALL_TODO  # noqa: E402

GUARD = "is_partner_user("
COST_GUARD = "can_see_costs("
PAY_GUARD = "can_see_pay("

#: Tables whose read policies must ask the cost grant (wave Z, money doors).
COST_TABLES: frozenset[str] = frozenset({
    "job_costs", "change_orders", "project_financials", "receipts",
    "bank_imports", "bank_transactions",
    "ai_spend_alerts", "ai_spend_limits", "ai_spend_months",
    "ai_usage_days", "ai_usage_events",
})
PAY_TABLES: frozenset[str] = frozenset({"pay_rates"})
CREDENTIAL_COLUMNS: frozenset[str] = frozenset({"pin", "pin_hash", "pin_salt"})
#: Functions a signed-out caller is allowed to execute. Empty on purpose:
#: 20260992000000 read every signed-out flow (GC portal, access request,
#: sign-in, password reset, invite redemption) and none of them calls a
#: function in public — they go through edge functions on the service key or
#: through GoTrue. A name here must also be granted in a migration, the way
#: that file's section 4 shows.
ANON_FUNCTIONS_ALLOWED: frozenset[str] = frozenset()
MAX_TEST_LOGINS = 2


def _client_facing(roles) -> bool:
    return any(r in ("authenticated", "public") for r in roles)


def _anonymous(roles) -> bool:
    return any(r in ("anon", "public") for r in roles)


def _reads(policy: dict) -> bool:
    return policy.get("cmd") in ("SELECT", "ALL")


def judge(report: dict) -> tuple[list[str], list[str], list[str]]:
    """Return (failures, advisories, summary). Failures are plain sentences a
    person can act on; each names the table or policy."""
    failures: list[str] = []
    advisories: list[str] = []
    policies = report.get("policies") or []

    # --- the partner wall, live -------------------------------------------
    unguarded_public = []
    unguarded_storage = []
    for p in policies:
        if not _reads(p) or not _client_facing(p.get("roles") or []):
            continue
        body = (p.get("using") or "") + " " + (p.get("check") or "")
        if p["schema"] == "public":
            if p["table"] in PARTNER_WALL_EXEMPT_TABLES:
                continue
            if GUARD not in body:
                unguarded_public.append(f'{p["table"]}: policy "{p["name"]}"')
            elif p.get("cmd") == "ALL" and GUARD not in (p.get("check") or ""):
                unguarded_public.append(f'{p["table"]}: policy "{p["name"]}" (WITH CHECK side)')
        elif p["schema"] == "storage":
            if p["name"] in STORAGE_WALL_TODO:
                continue
            if GUARD not in body:
                unguarded_storage.append(f'storage.objects: policy "{p["name"]}"')
    for item in unguarded_public:
        failures.append(
            f"A builder login can read a crew table. {item} has no is_partner_user() guard. "
            "Fold `not public.is_partner_user() and (...)` into it, the way THE WALL "
            "(20260950000000) did for every other table."
        )
    for item in unguarded_storage:
        failures.append(
            f"A builder login can read a storage bucket. {item} has no is_partner_user() guard."
        )

    # --- the money doors ----------------------------------------------------
    for p in policies:
        if p["schema"] != "public" or not _reads(p) or not _client_facing(p.get("roles") or []):
            continue
        body = (p.get("using") or "") + " " + (p.get("check") or "")
        if p["table"] in COST_TABLES and COST_GUARD not in body:
            failures.append(
                f'The money door on {p["table"]} is open: policy "{p["name"]}" does not ask '
                "can_see_costs(). Every cost table's read policy must (wave Z, 20260978000000)."
            )
        if p["table"] in PAY_TABLES and PAY_GUARD not in body:
            failures.append(
                f'The pay door on {p["table"]} is open: policy "{p["name"]}" does not ask can_see_pay().'
            )

    # --- nobody reads anonymously ------------------------------------------
    for p in policies:
        if p["schema"] == "public" and _reads(p) and _anonymous(p.get("roles") or []):
            failures.append(
                f'Anyone on the internet can read {p["table"]}: policy "{p["name"]}" grants to '
                f'{p.get("roles")}. Read policies on crew tables are `to authenticated`; a policy '
                "written without a `to` clause is `to public`, which includes anon."
            )

    # --- pin_hash -----------------------------------------------------------
    for c in report.get("profile_columns") or []:
        if c.get("column") in CREDENTIAL_COLUMNS and c.get("select"):
            failures.append(
                f'{c["role"]} can SELECT profiles.{c["column"]}. That column is a credential; '
                "no client role may read it (20260729200100). Re-run the column-by-column grant "
                "from that migration and never widen profiles to a table-level SELECT."
            )
    trunc = report.get("profile_truncate") or {}
    for role in ("anon", "authenticated"):
        if trunc.get(role):
            failures.append(
                f"{role} can TRUNCATE profiles. TRUNCATE ignores every row policy; "
                "20260729200000 revoked it and something granted it back."
            )

    # --- the sandbox fence ---------------------------------------------------
    unguarded = report.get("fence_unguarded")
    if unguarded is None:
        failures.append(
            "The test-login fence could not be measured (no fence_unguarded in the report)."
        )
    else:
        for row in unguarded:
            failures.append(
                f'A QA login can write to any job through {row.get("table")}: it is project-scoped '
                f'(via {row.get("column")}) and carries no sandbox guard. Run '
                "attach_sandbox_guards() in a migration, as 20260967000000 did."
            )
    logins = report.get("test_logins")
    if logins is None:
        failures.append("Could not count test logins (no test_logins in the report).")
    elif int(logins) > MAX_TEST_LOGINS:
        failures.append(
            f"There are {logins} test logins; the fence expects at most {MAX_TEST_LOGINS} "
            "(the QA installer and the QA foreman). A third login inside the sandbox is news."
        )

    # --- advisories ----------------------------------------------------------
    rls_off = report.get("rls_off") or []
    if rls_off:
        advisories.append(
            f"{len(rls_off)} table(s) a client role can reach have row-level security OFF: "
            + ", ".join(rls_off)
            + ". Not failing yet; promote when this list is empty on production."
        )
    anon_fns = [f for f in (report.get("anon_functions") or []) if f not in ANON_FUNCTIONS_ALLOWED]
    if anon_fns:
        advisories.append(
            f"{len(anon_fns)} function(s) an anonymous caller may execute: "
            + ", ".join(anon_fns)
            + ". 20260992000000 revoked EXECUTE from anon on every routine in public; "
            "a new one is either granted back on purpose (and listed in ANON_FUNCTIONS_ALLOWED) "
            "or has `revoke all on function ... from public, anon` in its migration."
        )
    if report.get("anon_default_execute"):
        advisories.append(
            "The default privileges for role postgres in schema public grant EXECUTE to anon "
            "or PUBLIC again, so the next function created is callable signed-out. "
            "20260992000000 section 5 is the fix."
        )

    reads = sum(1 for p in policies if p["schema"] == "public" and _reads(p) and _client_facing(p.get("roles") or []))
    summary = [
        f"{reads} client-facing read policies on public tables checked against the partner wall",
        f"{len([p for p in policies if p['schema'] == 'storage'])} storage policies checked",
        f"{len(COST_TABLES) + len(PAY_TABLES)} money and pay tables checked",
        f"profiles credential columns: {len(report.get('profile_columns') or [])} role/column pairs checked",
        f"sandbox fence: {len(unguarded or [])} unguarded table(s); {logins} test login(s)",
    ]
    return failures, advisories, summary


def load_report(text: str) -> dict:
    """The Management API answers a SELECT as a list of rows. One row, one
    column called report. Anything else is an error message, not data."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"VERIFICATION failure: the database answer was not JSON ({exc}).")
    if isinstance(data, dict) and "message" in data:
        msg = str(data.get("message"))
        hint = ""
        if "sandbox_guard_census" in msg:
            hint = " 20260967000000_sandbox_guard_rearm.sql has not been applied to this project."
        raise SystemExit(f"VERIFICATION failure: the database refused the query: {msg}.{hint}")
    if not isinstance(data, list) or len(data) != 1 or "report" not in data[0]:
        raise SystemExit("VERIFICATION failure: expected one row with a report column; nothing was measured.")
    report = data[0]["report"]
    if isinstance(report, str):
        report = json.loads(report)
    return report


def main(argv: list[str]) -> int:
    text = open(argv[1]).read() if len(argv) > 1 else sys.stdin.read()
    report = load_report(text)
    failures, advisories, summary = judge(report)
    for line in summary:
        print(f"  {line}")
    for line in advisories:
        print(f"ADVISORY: {line}")
    if failures:
        print(f"FAIL: {len(failures)} security invariant(s) do not hold on the live database:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("OK: every security invariant holds on the live database.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
