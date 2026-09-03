#!/usr/bin/env python3
"""Catch column names a migration got wrong that Postgres will not complain about.

Postgres resolves an unqualified column name a subquery cannot satisfy against
the ENCLOSING query instead of raising. That is a real SQL feature (correlated
subqueries need it), and it means a stale or mistyped column name inside a
subquery compiles, deploys, and returns confident wrong answers forever.

The incident that bought this file (2026-09-02): `finish_unit`
(20260820000000_unit_sessions.sql) added up a unit's session minutes with

    from unit_sessions
    where opening_id = p_opening_id and ended_at is not null
      and started_at > coalesce(
        (select max(created_at) from install_events
         where opening_id = p_opening_id and voided_at is null),
        '-infinity'::timestamptz)

`install_events` has no `opening_id` column — it has `project_opening_id`, and
has since 20260715120000_install_capture.sql. So the inner `opening_id` bound
to the outer `unit_sessions.opening_id`, the enclosing WHERE already pinned
that to `p_opening_id`, and the subquery quietly became "the newest install
filed anywhere on the database". Finished units were filed with no minutes and
no start time. Nothing errored, no test failed, and it shipped on 2026-08-20
and stayed wrong until an owner tried to finish a unit on a busy afternoon.

This is a scanner, not a parser, and deliberately narrow: it knows a short list
of (table, column-the-table-does-not-have) pairs that have actually bitten, and
it reports a bare reference to one of those columns inside that table's own
query scope. Qualified references (`o.opening_id`), the real column
(`project_opening_id`) and plpgsql parameters (`p_opening_id`) are all left
alone, so a clean tree stays clean and a repeat of the 2026-09-02 shape cannot
land quietly.

Add a pair to SUSPECT_COLUMNS when a rename or a table's real shape turns an
old name into a silent trap somewhere else. Enforced by
scripts/test_schema_verify.py, which is already in the merge gate.

    python3 scripts/migration_lint.py     # exits 1 and names every hit
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"

#: table -> {a column the table does NOT have: the column it actually has}.
#: Every wrong name listed here is a real column on some OTHER table in this
#: schema, which is exactly why it resolves outward instead of failing.
#:   - install_events: the opening it belongs to is `project_opening_id`
#:     (20260715120000_install_capture.sql). `opening_id` is the spelling on
#:     unit_sessions, unit_redos, issues, opening_phases and qc_checks, so the
#:     wrong one is nearly always in scope somewhere nearby.
SUSPECT_COLUMNS: dict[str, dict[str, str]] = {
    "install_events": {"opening_id": "project_opening_id"},
}

#: Shipped migration -> the LATER migration that rebuilt the function and got
#: the column right. Migrations are append-only history: the text in
#: 20260820000000 is what actually ran on 2026-08-20, so it is recorded as
#: superseded here rather than edited after the fact. The exemption is not
#: taken on trust — `unexpected_hits` only honours it while the named
#: replacement is really present, really later in version order, and itself
#: clean, so deleting or reverting the fix turns this gate red again.
SUPERSEDED: dict[str, str] = {
    "20260820000000_unit_sessions.sql": "20260964000000_finish_unit_own_sessions.sql",
}

#: Shipped migration -> (the migration that REPAIRED the rows it damaged, the
#: table that lists them).
#:
#: A column reference that resolves outward does not merely break a code path;
#: it writes wrong rows for every day it lives. Replacing the function is
#: therefore half an incident — the rows already written stay wrong, and nobody
#: can name which units they are. 20260820000000 filed finished units with no
#: minutes and no start time from 2026-08-20 until the fix, and the first cut of
#: this branch shipped the fix with those rows unmentioned (2026-09-03). Every
#: entry in SUPERSEDED needs an entry here, and the test in
#: scripts/test_schema_verify.py refuses a fix that arrives without one.
REPAIRED: dict[str, tuple[str, str]] = {
    "20260820000000_unit_sessions.sql": (
        "20260965000000_finish_unit_minutes_repair.sql",
        "install_event_time_repairs",
    ),
}


def _blank_comments(sql: str) -> str:
    """Blank out -- line comments and /* */ blocks.

    Blanked rather than deleted so every offset — and so every reported line
    number — still points at the same place in the real file.
    """
    sql = re.sub(r"--[^\n]*", lambda m: " " * len(m.group(0)), sql)
    return re.sub(
        r"/\*.*?\*/",
        lambda m: re.sub(r"[^\n]", " ", m.group(0)),
        sql,
        flags=re.S,
    )


def _scope_after(sql: str, start: int) -> str:
    """The text belonging to the query that just named a table.

    Runs from `start` to whichever comes first: the ')' closing the subquery
    this table source sits in, or a ';' at the same nesting depth — which ends
    the statement, including a statement nested inside a plpgsql body.
    """
    depth = 0
    for i in range(start, len(sql)):
        ch = sql[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0:
                return sql[start:i]
            depth -= 1
        elif ch == ";" and depth == 0:
            return sql[start:i]
    return sql[start:]


def scan_sql(sql: str, filename: str = "<sql>") -> list[tuple[str, int, str, str, str]]:
    """Report every bare SUSPECT_COLUMNS reference inside its table's scope.

    Returns (filename, line, table, wrong column, right column) tuples.
    """
    text = _blank_comments(sql)
    found: list[tuple[str, int, str, str, str]] = []
    for table, columns in SUSPECT_COLUMNS.items():
        source = re.compile(
            r"\b(?:from|join|update|into)\s+(?:only\s+)?(?:public\.)?"
            + re.escape(table) + r"\b",
            re.I,
        )
        for src in source.finditer(text):
            scope = _scope_after(text, src.end())
            for wrong, right in columns.items():
                # (?<![\w.]) rules out project_opening_id, p_opening_id and
                # every qualified o.opening_id: only a genuinely bare name is
                # ambiguous enough to resolve outward.
                bare = re.compile(r"(?<![\w.])" + re.escape(wrong) + r"\b", re.I)
                depth = 0
                for i, ch in enumerate(scope):
                    if ch == "(":
                        depth += 1
                    elif ch == ")":
                        depth -= 1
                    elif depth == 0 and bare.match(scope, i):
                        line = text.count("\n", 0, src.end() + i) + 1
                        found.append((filename, line, table, wrong, right))
    return found


def scan_migrations(paths=None) -> list[tuple[str, int, str, str, str]]:
    """Scan every migration file, or the given paths, and report all hits."""
    found: list[tuple[str, int, str, str, str]] = []
    for path in _migration_paths(paths):
        found.extend(scan_sql(path.read_text(), path.name))
    return found


def unexpected_hits(paths=None) -> list[tuple[str, int, str, str, str]]:
    """Every hit that is not covered by a live SUPERSEDED entry.

    This is what the gate judges. A hit in shipped history is forgiven only
    while the migration that fixed it is still on disk, still sorts later, and
    is itself clean — otherwise the forgiveness would outlive the fix.
    """
    present = {p.name for p in _migration_paths(paths)}
    hits = scan_migrations(paths)
    dirty = {fn for fn, _l, _t, _w, _r in hits}

    def forgiven(filename: str) -> bool:
        fixer = SUPERSEDED.get(filename)
        return bool(
            fixer and fixer in present and fixer > filename and fixer not in dirty
        )

    return [hit for hit in hits if not forgiven(hit[0])]


def _migration_paths(paths=None) -> list[Path]:
    if paths is None:
        return sorted(MIGRATIONS_DIR.glob("*.sql"))
    return [Path(p) for p in paths]


def describe(hits) -> str:
    """A report a reader can act on without opening this file."""
    return "\n".join(
        f"  {fn}:{line} — `{table}` has no `{wrong}` column (it is `{right}`); "
        f"a bare `{wrong}` inside a query on {table} resolves to the enclosing "
        "query instead of failing, and the filter silently does nothing"
        for fn, line, table, wrong, right in hits
    )


if __name__ == "__main__":
    import sys

    hits = unexpected_hits()
    if hits:
        print(describe(hits))
        sys.exit(1)
    print("no silently-resolving column references in supabase/migrations")
