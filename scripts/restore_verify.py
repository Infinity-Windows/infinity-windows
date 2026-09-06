#!/usr/bin/env python3
"""Prove a restored database is the database the backup claimed to hold.

    scripts/restore_verify.py --backup backups/2026-09-05 \
        --db-url postgresql://postgres:postgres@localhost:5432/postgres

Run this against a THROWAWAY Postgres that the dump was just replayed into —
never against Supabase. It is the whole point of the weekly restore test: a
backup nobody has ever restored is a hope, not a backup.

Three checks, in the order a bad restore usually fails them:

  1. Row counts. Every table in MANIFEST.json must come back with exactly the
     count taken at dump time. This catches the failure that looks most like
     success: `data.sql` truncated mid-COPY still restores, still exits 0, and
     leaves a database that is a plausible-looking fraction of the real one.

  2. Functions and row-level-security policies. `schema.sql` declares them, so
     they are re-read out of the dump and looked for in the restored database.
     Losing a policy is the dangerous one — the rows are all there, and every
     installer can now read every other installer's pay.

  3. Three spot rows, looked up by the ids MANIFEST.json recorded, hashed and
     compared. Counts cannot tell you the rows came back with the right bytes
     in them; this can.

Reads only. Needs `psql` on PATH. Nothing here prints a row: the manifest holds
hashes, and a mismatch is reported by table and id, never by value.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Any, Callable, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backup_manifest import row_hash, spot_row_sql  # noqa: E402


def psql_runner(db_url: str) -> Callable[[str], str]:
    """One row of tab-separated output per result row, no headers, no pager."""

    def run(sql: str) -> str:
        proc = subprocess.run(
            ["psql", db_url, "-X", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError("psql failed: %s" % (proc.stderr or "").strip()[:400])
        return proc.stdout

    return run


# ---------------------------------------------------------------------------
# Reading what the schema dump promised.


# One identifier, quoted or not. `supabase db dump` runs pg_dump with
# --quote-all-identifier, so a real dump says `"public"."finish_unit"` and never
# `public.finish_unit`. Both spellings are accepted because a hand-run pg_dump
# without that flag produces the bare one, and this file is also what somebody
# points at a dump on the worst day.
IDENT = r"(?:\"([^\"]+)\"|([A-Za-z0-9_]+))"


def _ident(*groups: Optional[str]) -> str:
    """Whichever half of an IDENT alternation matched."""
    for g in groups:
        if g is not None:
            return g
    return ""


def declared_functions(schema_sql: str) -> List[Tuple[str, str]]:
    """(schema, name) for every function the dump creates.

    pg_dump writes `CREATE FUNCTION "public"."foo"("a" integer) RETURNS ...`,
    and the CLI rewrites the leading verb to `CREATE OR REPLACE FUNCTION`. Only
    the schema and name are taken: argument types are rendered differently by
    different server versions, and a check that is wrong on a version bump is a
    check somebody turns off.
    """
    out = []
    for m in re.finditer(
        r"^CREATE (?:OR REPLACE )?FUNCTION\s+%s\.%s\s*\(" % (IDENT, IDENT),
        schema_sql,
        re.MULTILINE,
    ):
        out.append((_ident(m.group(1), m.group(2)), _ident(m.group(3), m.group(4))))
    return sorted(set(out))


def declared_policies(schema_sql: str) -> List[Tuple[str, str, str]]:
    """(schema, table, policy name) for every RLS policy the dump creates."""
    out = []
    for m in re.finditer(
        r"^CREATE POLICY\s+%s\s+ON\s+%s\.%s" % (IDENT, IDENT, IDENT),
        schema_sql,
        re.MULTILINE,
    ):
        name = _ident(m.group(1), m.group(2))
        schema = _ident(m.group(3), m.group(4))
        table = _ident(m.group(5), m.group(6))
        out.append((schema, table, name))
    return sorted(set(out))


# ---------------------------------------------------------------------------
# Asking the restored database what it actually has.


def live_relations(run: Callable[[str], str]) -> set:
    """Every table, view and matview the restored database has, by (schema, name).

    Asked first so a relation that did not come back is REPORTED rather than
    counted. Counting it would put an unknown relation into a batched query,
    psql runs with ON_ERROR_STOP=1, and the whole batch — plus the verdict, plus
    the reason Slack was going to be told — would die with it.
    """
    sql = (
        "select n.nspname, c.relname from pg_class c "
        "join pg_namespace n on n.oid = c.relnamespace "
        "where c.relkind in ('r','p','v','m','f') "
        "and n.nspname not in ('pg_catalog','information_schema')"
    )
    return {tuple(line.split("\t")) for line in run(sql).strip().splitlines() if line.strip()}


def live_counts(
    run: Callable[[str], str], tables: List[Dict[str, Any]]
) -> Tuple[Dict[Tuple[str, str], int], Dict[Tuple[str, str], str]]:
    """Row counts, and the tables that could not be counted with the reason why.

    Batched 25 at a time because a query per table over a few hundred tables is
    slow enough to matter in CI. A batch that errors is retried one table at a
    time, so the report can name the table instead of losing 25 answers to one
    unreadable relation.
    """
    counts: Dict[Tuple[str, str], int] = {}
    errors: Dict[Tuple[str, str], str] = {}
    batch: List[Dict[str, Any]] = []

    def count_one(row: Dict[str, Any]) -> None:
        key = (row["schema"], row["table"])
        try:
            text = run('select count(*) from "%s"."%s"' % key).strip()
            counts[key] = int(text.splitlines()[0])
        except Exception as exc:  # noqa: BLE001 - recorded per table, never silent
            errors[key] = str(exc)[:200]

    def flush():
        if not batch:
            return
        union = " union all ".join(
            "select '%s' as s, '%s' as t, count(*) as n from \"%s\".\"%s\""
            % (row["schema"], row["table"], row["schema"], row["table"])
            for row in batch
        )
        try:
            out = run(union)
        except Exception:  # noqa: BLE001 - retried one at a time just below
            for row in batch:
                count_one(row)
            del batch[:]
            return
        for line in out.strip().splitlines():
            if not line.strip():
                continue
            s, t, n = line.split("\t")
            counts[(s, t)] = int(n)
        del batch[:]

    for row in tables:
        batch.append(row)
        if len(batch) == 25:
            flush()
    flush()
    return counts, errors


def live_functions(run: Callable[[str], str]) -> set:
    sql = (
        "select n.nspname, p.proname from pg_proc p "
        "join pg_namespace n on n.oid = p.pronamespace "
        "where n.nspname not in ('pg_catalog','information_schema')"
    )
    return {tuple(line.split("\t")) for line in run(sql).strip().splitlines() if line.strip()}


def live_policies(run: Callable[[str], str]) -> set:
    sql = "select schemaname, tablename, policyname from pg_policies"
    return {tuple(line.split("\t")) for line in run(sql).strip().splitlines() if line.strip()}


def spot_row_value(run: Callable[[str], str], spot: Dict[str, Any]) -> Optional[Any]:
    schema, table = spot["schema"], spot["table"]
    if spot.get("id") is not None:
        # Looked up by the manifest's own id, so the check is about THIS row
        # rather than about whichever row happens to sort first now.
        ident = str(spot["id"]).replace("'", "''")
        sql = (
            "select to_jsonb(t)::text from \"%s\".\"%s\" t where t.id::text = '%s'"
            % (schema, table, ident)
        )
    else:
        sql = spot_row_sql(schema, table)
    text = run(sql).strip()
    if not text:
        return None
    return json.loads(text.splitlines()[0])


# ---------------------------------------------------------------------------


def verify(
    manifest: Dict[str, Any],
    schema_sql: str,
    run: Callable[[str], str],
) -> Tuple[List[str], List[str]]:
    problems: List[str] = []
    checks: List[str] = []

    # 0. A manifest with nothing in it must never come out the other end as a
    # pass. With no tables and no spot rows every loop below is empty, no
    # problem is ever appended, and the verdict reads "Restore test PASSED" —
    # having checked nothing at all. That is the one way this file could do
    # active harm, by turning "we do not know" into "we are covered".
    if not (manifest.get("tables") or []):
        problems.append(
            "the backup manifest lists no tables, so there was nothing to check "
            "and this run proves nothing about the restore"
        )
    elif not manifest.get("total_rows"):
        problems.append(
            "the backup manifest records zero rows across every table, which "
            "cannot be true of this database — the counts it was going to be "
            "measured against are not usable"
        )

    # 1. Row counts.
    tables = manifest.get("tables") or []
    present = live_relations(run) if tables else set()
    got, count_errors = live_counts(
        run, [r for r in tables if (r["schema"], r["table"]) in present]
    )
    mismatched = 0
    for row in tables:
        key = (row["schema"], row["table"])
        actual = got.get(key)
        if key in count_errors:
            problems.append(
                "%s.%s is in the restored database but could not be counted: %s"
                % (key[0], key[1], count_errors[key])
            )
            mismatched += 1
        elif actual is None:
            problems.append(
                "%s.%s is in the backup manifest but not in the restored database"
                % key
            )
            mismatched += 1
        elif actual != row["rows"]:
            problems.append(
                "%s.%s restored %d row(s), the backup recorded %d"
                % (key[0], key[1], actual, row["rows"])
            )
            mismatched += 1
    checks.append(
        "row counts: %d of %d table(s) match (%d rows)"
        % (len(tables) - mismatched, len(tables), manifest.get("total_rows", 0))
    )

    # 2. Functions and policies.
    want_fns = set(declared_functions(schema_sql))
    have_fns = live_functions(run)
    missing_fns = sorted(want_fns - have_fns)
    if missing_fns:
        problems.append(
            "%d function(s) the schema dump declares are missing after the restore: %s"
            % (len(missing_fns), ", ".join("%s.%s" % f for f in missing_fns[:10]))
        )
    checks.append("functions: %d of %d declared exist" % (len(want_fns) - len(missing_fns), len(want_fns)))

    want_pol = set(declared_policies(schema_sql))
    have_pol = live_policies(run)
    missing_pol = sorted(want_pol - have_pol)
    if missing_pol:
        problems.append(
            "%d row-level-security policy/policies are missing after the restore, so "
            "the restored database would show people rows they may not see: %s"
            % (len(missing_pol), ", ".join("%s.%s/%s" % p for p in missing_pol[:10]))
        )
    checks.append("policies: %d of %d declared exist" % (len(want_pol) - len(missing_pol), len(want_pol)))

    # A dump that declares nothing at all is not a database with nothing in it —
    # it is a dump this file could not read. That happened once already: pg_dump
    # quotes every identifier and the patterns above did not, so both checks
    # found zero declarations and reported "0 of 0 declared exist" as a pass. A
    # restore that had silently dropped every policy would have gone to Slack as
    # PASSED. This floor is what makes that a failure instead of a shrug.
    if schema_sql.strip() and not want_fns and not want_pol:
        problems.append(
            "the schema dump declares no functions and no policies, which this "
            "database has plenty of — so the dump was not read, and the function "
            "and policy checks above proved nothing"
        )

    # 3. Spot rows.
    spots = manifest.get("spot_rows") or []
    ok = 0
    for spot in spots:
        value = spot_row_value(run, spot)
        if value is None:
            problems.append(
                "spot row %s.%s (id %s) is not in the restored database"
                % (spot["schema"], spot["table"], spot.get("id"))
            )
            continue
        if row_hash(value) != spot["sha256"]:
            problems.append(
                "spot row %s.%s (id %s) came back with different contents"
                % (spot["schema"], spot["table"], spot.get("id"))
            )
            continue
        ok += 1
    checks.append("spot rows: %d of %d match byte for byte" % (ok, len(spots)))
    if spots and ok == 0:
        problems.append("no spot row matched, so nothing proves the row contents survived")

    return problems, checks


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--backup", required=True, help="the unpacked backup folder")
    ap.add_argument("--db-url", required=True, help="the THROWAWAY Postgres to check")
    ap.add_argument(
        "--summary",
        default="",
        help="write the one-line result here as well (the job summary / Slack line)",
    )
    args = ap.parse_args(argv)

    with open(os.path.join(args.backup, "MANIFEST.json")) as fh:
        manifest = json.load(fh)
    schema_path = os.path.join(args.backup, "schema.sql")
    schema_sql = ""
    if os.path.exists(schema_path):
        with open(schema_path, errors="replace") as fh:
            schema_sql = fh.read()

    try:
        problems, checks = verify(manifest, schema_sql, psql_runner(args.db_url))
    except Exception as exc:  # noqa: BLE001 - see below; never leave no verdict
        # Whatever broke, the summary file has to exist. restore-test.yml reads
        # its first line and hands that to Slack as the cause; when the file is
        # missing, the whole notification is the words "Restore test did not
        # produce a verdict" and somebody's Monday starts with no idea why.
        headline = "Restore test FAILED: the check itself could not run — %s" % str(exc)[:300]
        print(headline, file=sys.stderr)
        if args.summary:
            with open(args.summary, "w") as fh:
                fh.write(headline + "\n")
        return 1

    for line in checks:
        print("  ok  %s" % line)
    for line in problems:
        print("FAIL  %s" % line, file=sys.stderr)

    headline = (
        "Restore test PASSED: %s restored clean — %s"
        % (manifest.get("started_at", "the backup"), "; ".join(checks))
        if not problems
        else "Restore test FAILED: %d problem(s) — %s" % (len(problems), problems[0])
    )
    print(headline)
    if args.summary:
        with open(args.summary, "w") as fh:
            fh.write(headline + "\n")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
