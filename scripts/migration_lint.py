#!/usr/bin/env python3
"""Catch the migration mistakes Postgres will not complain about.

TWO CHECKS LIVE HERE, and they share a shape: each one is a way for a migration
to deploy clean, run without error, and be wrong forever after.

  1. scan_sql / unexpected_hits — a column name a subquery cannot satisfy,
     which resolves against the ENCLOSING query instead of failing. The
     2026-09-02 finish_unit incident, described at length below.
  2. shrinking_grants — a re-stated column-grant list that quietly got
     shorter, so a table-level REVOKE takes a privilege nobody meant to take.
     Described at its own definition, near the bottom of this file.

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

The scope is the whole query, parentheses included. The first cut of this file
only judged text at paren depth 0, which caught the one flat spelling the
incident happened to use and let every equally natural spelling of the identical
bug through — `where (opening_id = ...)`, `where coalesce(opening_id, x) = ...`,
the filter written inside any function call (2026-09-03 review). A parenthesised
group is now descended into unless it is a query of its own, meaning it has both
its own SELECT and its own FROM/JOIN: a bare name there resolves against that
query's tables, and if one of them is a suspect table it gets judged in its own
right by the loop below.

WHAT IT STILL DOES NOT SEE, stated plainly so nobody reads a green run as proof:

  * A wrong column that is NOT in SUSPECT_COLUMNS. The list is one pair long.
  * A name qualified with an alias — `e.opening_id` on `install_events` is a
    hard Postgres error, so it fails loudly and needs no scanner.
  * A `(` or `)` inside a string literal, which shifts the depth count for the
    rest of that scope. Quotes are not tracked; the failure is a missed hit,
    never a false alarm, and no migration in the tree does it today.
  * Anything outside supabase/migrations — app code reaches PostgREST, which
    400s on a column that does not exist, so this class of silence is SQL-only.

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


#: A parenthesised group is a query in its own right only when it has BOTH its
#: own SELECT and its own table source — `(select ... from other_table ...)`.
#: A bare name in there resolves against that query's tables, so it is that
#: query's business. Every other kind of group — `where (a = b)`,
#: `coalesce(a, b)`, any function's arguments — resolves against the enclosing
#: query, which means the trap hides in them just as well as at depth 0.
#: Requiring an identifier after from/join is what keeps
#: `extract(epoch from (a - b))` from reading as a table source.
_SELECT = re.compile(r"\bselect\b", re.I)
_TABLE_SOURCE = re.compile(
    r"\b(?:from|join)\s+(?:(?:only|lateral)\s+)*(?:[a-z_]\w*\.)?[a-z_]\w*",
    re.I,
)


def _matching_paren(text: str, start: int) -> int:
    """Index of the ')' closing the '(' at `start`; len(text) when unclosed."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return len(text)


def _own_depth(text: str) -> str:
    """`text` with everything inside parentheses blanked out.

    What is left is this group's own clause list, which is what decides
    whether the group is a query of its own.
    """
    out = []
    depth = 0
    for ch in text:
        if ch == "(":
            depth += 1
            out.append(" ")
        elif ch == ")":
            depth = max(0, depth - 1)
            out.append(" ")
        else:
            out.append(ch if depth == 0 else " ")
    return "".join(out)


def _is_own_query(inner: str) -> bool:
    top = _own_depth(inner)
    return bool(_SELECT.search(top) and _TABLE_SOURCE.search(top))


def _bare_offsets(scope: str, bare: re.Pattern, base: int = 0) -> list[int]:
    """Offsets in `scope` where a bare name resolves against THIS query.

    Descends into parentheses, skipping only the groups that are queries of
    their own. Depth alone used to decide this, which meant one extra pair of
    brackets around the 2026-09-02 filter walked straight through (2026-09-03).
    """
    out: list[int] = []
    i = 0
    while i < len(scope):
        if scope[i] == "(":
            end = _matching_paren(scope, i)
            inner = scope[i + 1:end]
            if not _is_own_query(inner):
                out.extend(_bare_offsets(inner, bare, base + i + 1))
            i = end + 1
            continue
        if bare.match(scope, i):
            out.append(base + i)
        i += 1
    return out


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
                for offset in _bare_offsets(scope, bare):
                    line = text.count("\n", 0, src.end() + offset) + 1
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


# ---------------------------------------------------------------------------
# The second check: a re-stated column-grant list that quietly got shorter
# ---------------------------------------------------------------------------
"""Catch a table-level REVOKE that drops a column privilege nobody meant to drop.

THE PROJECTS GRANT LAW (wave D, 20260959000000) revokes table-level
INSERT/UPDATE on `projects` and grants back only the columns the app writes
directly, by name. Every wave that drops a `projects` column re-states both
lists. That is good documentation and a bad primitive, because two waves
developed the same week do not see each other's columns:

  * wave X (20260980000000) added `stories` and granted it ADDITIVELY —
    `grant insert (stories) on projects to authenticated;` on its own.
  * wave H (20260981000000) dropped three other columns and re-stated the
    lists, copying them from wave Z, which predates `stories`.

A table-level `revoke insert, update` takes every COLUMN-level grant of those
privileges with it. H sorts after X, so the deploy would have left `stories`
un-granted — and nothing would have gone red, because the app degrades on
purpose: api.ts reads the 42501 as "that column is not deployed yet", drops
`stories` from the write and retries. The save succeeds, and the storey count a
foreman typed is silently gone. Wave X's own header predicted the file that
would do it; a comment cannot enforce itself, so this does.

THE RULE: when a migration revokes INSERT or UPDATE at the table level, every
column that an earlier migration granted that privilege on — and that this
migration does not itself drop — must be named again in that migration's
grant-back. Re-stating a list is re-stating the WHOLE list.

Deliberately narrow, same as the scanner above:

  * COLUMN grants only. A table-level `grant insert on t to r` is not tracked,
    so a table that never used column grants can revoke and re-grant freely.
  * A column this migration drops is not expected back — dropping a column
    drops its ACL, which is the legitimate reason to re-state a list at all.
  * PER ROLE. Postgres revokes per grantee, and this check has to as well:
    20260729200000 grants profiles columns to `authenticated` and then writes
    `revoke all on table public.profiles from anon;` to shut a door that was
    never open. Judging on column names alone read that as five lost
    privileges, which is the kind of false alarm that gets a gate switched off.
  * Statement order inside a file is respected (a drop before the revoke is
    seen as a drop), and a column dropped anywhere in the same file is
    forgiven, so a file that revokes first and drops after is not a hit.
"""

#: Objects a GRANT/REVOKE can name that are not tables. `grant execute on
#: function f(...)` would otherwise read as a table called "function".
_NOT_A_TABLE = {"function", "schema", "sequence", "procedure", "routine", "all", "table"}

#: privs and roles are `[^;]*` so a match can never run past the end of its own
#: statement into the next one. Without that, `grant execute on function f(...)
#: to r;` finds no "on <name> to" of its own and happily borrows the one from
#: the following statement, inventing a grant that was never written.
_GRANT_RE = re.compile(
    r"\bgrant\s+(?P<privs>[^;]*?)\s+on\s+(?:table\s+)?(?:public\.)?"
    r"(?P<table>[a-z_]\w*)\s+to\s+(?P<roles>[^;]*)",
    re.I | re.S,
)
_REVOKE_RE = re.compile(
    r"\brevoke\s+(?P<privs>[^;]*?)\s+on\s+(?:table\s+)?(?:public\.)?"
    r"(?P<table>[a-z_]\w*)\s+from\s+(?P<roles>[^;]*)",
    re.I | re.S,
)
_DROP_COLUMN_RE = re.compile(
    r"\balter\s+table\s+(?:only\s+)?(?:public\.)?(?P<table>[a-z_]\w*)\s+"
    r"drop\s+column\s+(?:if\s+exists\s+)?(?P<column>[a-z_]\w*)",
    re.I,
)
#: `insert (a, b)` / `update(c)` inside a privilege list.
_PRIV_COLUMNS_RE = re.compile(r"\b(insert|update)\s*\(([^)]*)\)", re.I)
#: A bare privilege word with no column list after it — the table-level form.
_PRIV_BARE_RE = re.compile(r"\b(insert|update|all)\b(?!\s*\()", re.I)

#: Roles whose loss actually breaks the app. A revoke from service_role or from
#: a role the app never signs in as is not this check's business.
_APP_ROLES = {"anon", "authenticated", "public"}


def _privilege_columns(privs: str) -> dict[str, set[str]]:
    """`insert (a, b), update (c)` -> {"insert": {"a","b"}, "update": {"c"}}."""
    out: dict[str, set[str]] = {}
    for priv, cols in _PRIV_COLUMNS_RE.findall(privs):
        names = {c.strip().lower() for c in cols.split(",") if c.strip()}
        out.setdefault(priv.lower(), set()).update(names)
    return out


def _bare_privileges(privs: str) -> set[str]:
    """The INSERT/UPDATE privileges named WITHOUT a column list."""
    found = {p.lower() for p in _PRIV_BARE_RE.findall(privs)}
    return {"insert", "update"} if "all" in found else found & {"insert", "update"}


def _roles(text: str) -> set[str]:
    """The grantees a GRANT/REVOKE names, lowercased."""
    return {r.strip().lower() for r in text.split(",") if r.strip()}


def _events(sql: str):
    """Every grant / revoke / drop-column in one file, in statement order."""
    out = []
    for m in _GRANT_RE.finditer(sql):
        table = m.group("table").lower()
        if table not in _NOT_A_TABLE:
            out.append((
                m.start(), "grant", table,
                (_privilege_columns(m.group("privs")), _roles(m.group("roles"))),
            ))
    for m in _REVOKE_RE.finditer(sql):
        table = m.group("table").lower()
        roles = _roles(m.group("roles")) & _APP_ROLES
        if table in _NOT_A_TABLE or not roles:
            continue
        out.append((
            m.start(), "revoke", table,
            (_bare_privileges(m.group("privs")),
             _privilege_columns(m.group("privs")), roles),
        ))
    for m in _DROP_COLUMN_RE.finditer(sql):
        out.append((m.start(), "drop", m.group("table").lower(), m.group("column").lower()))
    return sorted(out, key=lambda e: e[0])


def shrinking_grants(paths=None) -> list[tuple[str, int, str, str, str, str]]:
    """Every column privilege a table-level revoke drops without granting back.

    Returns (filename, line, table, privilege, column, role) tuples.
    """
    #: (table, privilege, role) -> the columns granted so far, across all files.
    granted: dict[tuple[str, str, str], set[str]] = {}
    found: list[tuple[str, str, str, str, str, str]] = []

    for path in _migration_paths(paths):
        text = _blank_comments(path.read_text())
        dropped_in_file = {
            (m.group("table").lower(), m.group("column").lower())
            for m in _DROP_COLUMN_RE.finditer(text)
        }
        # (table, priv, role) -> (line of the revoke, columns it took away)
        pending: dict[tuple[str, str, str], tuple[int, set[str]]] = {}

        for offset, kind, table, payload in _events(text):
            if kind == "drop":
                for key in [k for k in granted if k[0] == table]:
                    granted[key].discard(payload)
                for key, (_line, lost) in pending.items():
                    if key[0] == table:
                        lost.discard(payload)
            elif kind == "grant":
                by_column, roles = payload
                for priv, cols in by_column.items():
                    for role in roles:
                        granted.setdefault((table, priv, role), set()).update(cols)
                        if (table, priv, role) in pending:
                            pending[(table, priv, role)][1].difference_update(cols)
            else:  # revoke
                bare, by_column, roles = payload
                for role in roles:
                    for priv, cols in by_column.items():
                        # A COLUMN-level revoke takes exactly what it names.
                        granted.get((table, priv, role), set()).difference_update(cols)
                    for priv in bare:
                        lost = granted.pop((table, priv, role), set())
                        if lost:
                            line = text.count("\n", 0, offset) + 1
                            pending[(table, priv, role)] = (line, set(lost))

        for (table, priv, role), (line, lost) in pending.items():
            for column in sorted(lost):
                if (table, column) not in dropped_in_file:
                    found.append((path.name, line, table, priv, column, role))

    return sorted(found)


def describe_grants(hits) -> str:
    """A report a reader can act on without opening this file."""
    return "\n".join(
        f"  {fn}:{line} — the table-level `revoke {priv} on {table} from {role}` "
        f"here takes the column grant on `{table}.{column}` with it, and this "
        f"migration never grants it back to {role}. Add `{column}` to the "
        f"`grant {priv} (…) on {table} to {role}` list in this file, or drop "
        "the column if it is really going"
        for fn, line, table, priv, column, role in hits
    )


if __name__ == "__main__":
    import sys

    bad = False
    hits = unexpected_hits()
    if hits:
        print(describe(hits))
        bad = True
    else:
        print("no silently-resolving column references in supabase/migrations")

    shrunk = shrinking_grants()
    if shrunk:
        print(describe_grants(shrunk))
        bad = True
    else:
        print("no re-stated grant list loses a column in supabase/migrations")

    sys.exit(1 if bad else 0)
