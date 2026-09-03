#!/usr/bin/env python3
"""Judge the test-login fence — live, and statically over the migration files.

    scripts/pgq.sh scripts/sandbox_guard_census.sql > /tmp/fence.json
    scripts/sandbox_guard.py /tmp/fence.json

Exit status: 0 when every project-scoped table carries the sandbox guard, 1
when one does not — or when nothing could be measured. Normally invoked through
scripts/verify-sandbox-guard.sh, which takes the snapshot for you and refuses to
guess which project to measure.

WHY THIS EXISTS. 20260730220000_test_accounts_sandbox_only.sql confines a
`profiles.is_test` login to the jobs in `public.sandbox_projects` with a BEFORE
trigger on every project-scoped table. It attached those triggers from a `do`
block that ran exactly once, on 2026-07-30. Fourteen project-scoped tables have
been created since and never carried the guard, two more lost it when their
table was dropped and recreated, and on 2026-09-02 the QA foreman login wrote to
a live job. Nothing was watching, because the only coverage report in the schema
had one caller and it ran on demand. See 20260965000000_sandbox_guard_rearm.sql.

TWO CHECKS, BECAUSE ONE OF THEM IS ALWAYS TOO LATE.

  THE LIVE CENSUS (this file's CLI, run by the deploy) reads pg_trigger through
  public.sandbox_guard_census() and fails the deploy on any row. It is the only
  check that can prove the fence is actually up, and it can only say so after
  the migrations have been pushed.

  THE STATIC SCAN (uncovered_new_tables(), asserted by
  scripts/test_sandbox_guard.py) reads the migration files. A migration that
  makes a table project-scoped and never calls attach_sandbox_guards() fails
  CI, before it reaches any database. That is the check that stops the census
  from ever going non-empty again by somebody simply forgetting.

The static scan replays the migrations rather than reading a hand-written list
of tables, for the reason partner_wall_lib.py gives: a list written on the day
of the fix is stale by the next merge. REARM_COVERED is the one list here, and
it is a different kind of thing — a record of what one sweep did on one day,
which cannot go stale because that day is over.

WHAT NEITHER CHECK DECIDES. A fence is only as tight as the list of what is
inside it, and that list is not an engineering question. 20260933000000 made
BLACK22 — a real job — practice data on 2026-08-25, which put it inside the
sandbox, which is why the QA login's write on 2026-09-02 was accepted by a guard
working exactly as written. Removing it is the owner's call, so this file does
not: it names every non-automation job in the summary and in the headline, on
every deploy, and points at the open question. Reporting the shape of the fence
is not the same as approving it.

DIRECTION OF ERROR. Both checks over-report by design. A table with a
`project_id` that a test login could never reach for some other reason still has
to carry the guard, because "some other reason" is not a control. An honest
over-report is the right error direction for a fence nobody is watching.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The private names are the migration parser this repo already has, borrowed
# rather than written again. If one is renamed the import fails loudly, which is
# the right failure for a security gate — a second copy of the parser drifting
# quietly is what put seventeen versions of the missing-table check in the app.
from supabase_merge_lib import (  # noqa: E402
    _ADD_COLUMN,
    _CREATE_TABLE,
    _parse_create_table,
    _read_parens,
    _strip_dollar_quoted,
)

REPO_ROOT = HERE.parent
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"

#: The migration that invented the fence, and swept the catalogue once from a
#: `do` block on the day it ran.
GUARD_MIGRATION = "20260730220000_test_accounts_sandbox_only.sql"

#: The migration that made re-arming callable, and called it. Every table that
#: was project-scoped on the database when this ran is covered by that call —
#: which is not the same set as "every table whose filename sorts below it",
#: hence REARM_COVERED.
REARM_MIGRATION = "20260965000000_sandbox_guard_rearm.sql"

#: What 20260965000000's sweep actually armed: every table that was
#: project-scoped in the repo on the day it was written (2026-09-02).
#:
#: A FROZEN HISTORICAL FACT, not a list to maintain. Nothing may be added to
#: it — a table that becomes project-scoped after that sweep has to arm the
#: fence from its own migration, and this list is how the gate tells the two
#: apart. A version comparison cannot: `supabase db push` applies whatever is
#: pending, so a branch numbered below 20260965000000 and merged after it runs
#: on a database where the sweep is already behind it. Its table would sort as
#: "covered" and carry no trigger.
#:
#: A name here that no longer exists costs nothing; the gate only ever looks up
#: tables the replay still finds.
REARM_COVERED: frozenset[str] = frozenset({
    "attachments", "change_orders", "daily_logs", "flash_run_assignments",
    "incidents", "install_events", "issues", "job_costs", "job_notes",
    "monday_jobs", "movements", "opening_notes", "opening_phases",
    "package_events", "packages", "partner_job_grants",
    "project_mark_elevation_views", "project_mark_specs", "project_marks",
    "project_message_reads", "project_messages", "project_opening_pin_moves",
    "project_openings", "project_plan_outlines", "project_plansets",
    "project_spec_discrepancies", "project_windows", "projects", "qc_checks",
    "receipts", "schedule_assignments", "service_cases", "studio_projects",
    "summons", "supply_orders", "takeoffs", "task_sessions", "time_shifts",
    "trips", "unit_redos", "unit_sessions", "vehicle_project_assignments",
    "windows",
})

#: `drop table a, b cascade;` — the names, up to the semicolon. A table that is
#: dropped takes its triggers with it, so the replay has to see the drop or it
#: reports a recreated table as still guarded (root cause 2 of this incident).
DROP_TABLE = re.compile(
    r"drop\s+table\s+(?:if\s+exists\s+)?([^;]*?)(?:\s+(?:cascade|restrict))?\s*;",
    re.IGNORECASE,
)

#: What a migration has to contain to count as re-arming the fence: a CALL,
#: not a mention. `create or replace function public.attach_sandbox_guards()`
#: and the `comment on` / `grant execute on` lines that follow it all name the
#: function without arming anything, so the keyword in front is what decides.
#: Write `select public.attach_sandbox_guards();` in a new migration.
ATTACH_CALL = re.compile(
    r"\b(?:select|perform|from|join)\s+(?:public\.)?attach_sandbox_guards\s*\(",
    re.IGNORECASE,
)

#: The column that ties a row to a project, in the precedence
#: 20260730220000 chose and public.sandbox_scoped_tables() still uses: every
#: table has an `id`, so `id` is the answer for `projects` alone; otherwise a
#: direct `project_id` wins, then a link to an opening.
LINK_COLUMNS: tuple[tuple[str, str], ...] = (
    ("project_id", "project"),
    ("project_opening_id", "opening"),
    ("opening_id", "opening"),
)

#: The list of sandbox jobs itself. No client role holds any grant on it and it
#: has RLS on with no policy (20260730220000), so it is not fenced and does not
#: need to be. public.sandbox_scoped_tables() skips the same name.
NOT_SCOPED: frozenset[str] = frozenset({"sandbox_projects"})

#: The job that exists to be written by robots — created by 20260730220000 and
#: never removed from the sandbox even if somebody unflags it
#: (20260933000000's set_project_test guards it by name). Every OTHER job on the
#: sandbox list is a real job that somebody turned into practice data, which is
#: a different kind of thing entirely and gets said out loud.
AUTOMATION_SANDBOX = "ZZTEST"

#: Where the open question about that lives, so the deploy summary can point at
#: something a person can answer rather than restating it every fortnight.
SANDBOX_DECISION = ".scratch/test-login-fence/issues/01-a-real-job-is-inside-the-sandbox.md"

# Long lists in a job summary get skimmed, not read. Same cap as schema_verify.
MAX_LISTED = 40


# ---------------------------------------------------------------------------
# The static scan: what the migration files say
# ---------------------------------------------------------------------------


def link_for(table_name: str, columns) -> tuple[str, str] | None:
    """('project_id', 'project') for a table a row can be traced from."""
    if table_name in NOT_SCOPED:
        return None
    if table_name == "projects":
        return ("id", "project")
    for column, kind in LINK_COLUMNS:
        if column in columns:
            return (column, kind)
    return None


def scoped_tables(directory: Path | str = MIGRATIONS_DIR) -> dict[str, tuple[str, str, str]]:
    """table -> (link column, link kind, the migration where it BECAME scoped).

    The third field is the load-bearing one, and it is not "the migration that
    created the table". A trigger is attached to a table at a moment in time,
    and there are three ways a table can need one after that moment:

      * it is created project-scoped — the ordinary case;
      * it is dropped and recreated, which takes the trigger with it. That is
        root cause 2 of the 2026-09-02 incident: project_marks and
        package_events lost guards they had, on migrations about something
        else. A parser that keeps the first `create table` cannot see it;
      * `alter table … add column project_id` makes a table that has existed
        for months project-scoped for the first time, and unguarded from that
        statement onwards.

    So this replays the files in version order the way `supabase db push`
    applies them, tracking each table's live columns, and records the file
    where it last crossed into being project-scoped.

    `create table … as select` is invisible to it (the archive tables in
    20260942000000_time_wipe.sql are the only instances), so those are covered
    by the live census and not by the static scan.
    """
    live: dict[str, set[str]] = {}
    scoped_after_last_file: set[str] = set()
    became: dict[str, str] = {}

    for path in sorted(Path(directory).glob("*.sql")):
        # Comments, quoted strings and function bodies all contain DDL-shaped
        # text that never runs as DDL.
        sql = _strip_dollar_quoted(_code_only(path.read_text(encoding="utf-8")))

        for statement in DROP_TABLE.finditer(sql):
            for name in statement.group(1).split(","):
                name = name.strip().strip('"').lower()
                if name.startswith("public."):
                    name = name[len("public."):]
                live.pop(name, None)
                scoped_after_last_file.discard(name)

        position = 0
        while True:
            match = _CREATE_TABLE.search(sql, position)
            if not match:
                break
            try:
                body, position = _read_parens(sql, match.end() - 1)
            except ValueError:
                position = match.end()
                continue
            name = match.group(1).lower()
            live[name] = set(_parse_create_table(name, body, path.name).columns)

        for match in _ADD_COLUMN.finditer(sql):
            table = live.get(match.group(1).lower())
            if table is not None:
                table.add(match.group(2).lower())

        scoped_now = {n for n, cols in live.items() if link_for(n, cols)}
        for name in scoped_now - scoped_after_last_file:
            became[name] = path.name
        scoped_after_last_file = scoped_now

    out: dict[str, tuple[str, str, str]] = {}
    for name in scoped_after_last_file:
        link = link_for(name, live[name])
        if link is not None:
            out[name] = (link[0], link[1], became[name])
    return out


def migrations_calling_attach(directory: Path | str = MIGRATIONS_DIR) -> list[str]:
    """Migration filenames that re-arm the fence, in version order."""
    directory = Path(directory)
    return sorted(
        path.name
        for path in directory.glob("*.sql")
        if ATTACH_CALL.search(_code_only(path.read_text(encoding="utf-8")))
    )


def _code_only(sql: str) -> str:
    """The SQL with comments and quoted strings blanked out.

    Prose that NAMES the arming call must not read as the arming call, and
    prose is not only `-- …` lines. 20260965000000 ends its
    `comment on function` with the sentence "must end with
    `select public.attach_sandbox_guards();`" — inside a SQL string literal.
    Scanning the raw text finds that sentence, so deleting the actual `do`
    block that arms the fence would have left this whole gate green with
    nothing arming anything. Same hole for a `/* … */` block and for any
    `raise notice` that quotes the instruction.

    Dollar-quoted bodies are deliberately NOT dropped: `do $$ … $$` is where a
    migration legitimately arms the fence, so the delimiters are passed over
    and the body is read as the code it is. Comments and literals inside it are
    blanked like everywhere else.

    Narrow on purpose. `E'…\\''` — a backslash-escaped quote inside an escape
    string — would confuse it; no migration in this repo writes one, and the
    failure would be a false REPORT of an unarmed table, which is the safe
    direction.
    """
    out: list[str] = []
    i, n = 0, len(sql)
    depth = 0
    while i < n:
        if depth:
            if sql.startswith("/*", i):
                depth += 1
                i += 2
            elif sql.startswith("*/", i):
                depth -= 1
                i += 2
            else:
                i += 1
            continue
        if sql.startswith("--", i):
            newline = sql.find("\n", i)
            i = n if newline < 0 else newline
            continue
        if sql.startswith("/*", i):
            depth = 1
            i += 2
            continue
        if sql[i] == "'":
            i += 1
            while i < n:
                if sql[i] != "'":
                    i += 1
                elif sql.startswith("''", i):
                    i += 2
                else:
                    i += 1
                    break
            out.append(" ")
            continue
        out.append(sql[i])
        i += 1
    return "".join(out)


def uncovered_new_tables(
    directory: Path | str = MIGRATIONS_DIR,
) -> list[tuple[str, str, str]]:
    """(table, link column, migration) for project-scoped tables nothing arms.

    A table is covered when THE MIGRATION THAT MAKES IT PROJECT-SCOPED arms the
    fence itself, or when 20260965000000's sweep already covered it.

    "Or a later migration arms it" is not on that list, and the omission is the
    point. Filenames are a version order, not the order the files reach a
    database: `supabase db push` applies whatever is pending, so a branch
    numbered below 20260965000000 and merged after it lands on a database where
    the only arming call has already run. Its table gets no trigger, and a gate
    that credited any higher-sorting filename would be green on that PR — the
    one-shot bug, reproduced by the check written to catch it. Arming in the
    same file has no such gap: the table and the sweep are one transaction, in
    one place, whenever it runs.
    """
    arming = set(migrations_calling_attach(directory))
    uncovered = []
    for name, (column, _kind, became_scoped_in) in sorted(scoped_tables(directory).items()):
        if became_scoped_in in arming:
            continue
        if became_scoped_in <= REARM_MIGRATION and name in REARM_COVERED:
            continue
        uncovered.append((name, column, became_scoped_in))
    return uncovered


# ---------------------------------------------------------------------------
# The live census: what the database says
# ---------------------------------------------------------------------------


def load_census(paths) -> dict[str, list[list[str]]]:
    """Read scripts/sandbox_guard_census.sql's output into kind -> [fields].

    A dict rather than a list is the Management API's error shape, and the most
    likely error by far is that 20260965000000 has not been applied — so that
    one is named rather than dumped.
    """
    rows: dict[str, list[list[str]]] = {}
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
        if isinstance(payload, dict):
            message = str(payload.get("message") or payload)
            if "sandbox_guard_census" in message or "sandbox_scoped_tables" in message:
                raise SystemExit(
                    "FAIL: this database has no sandbox_guard_census(), so the "
                    "test-login fence was NOT measured.\n"
                    "Apply supabase/migrations/" + REARM_MIGRATION + " first "
                    "(deploy-backend.yml pushes it).\n"
                    "Server said: " + message,
                )
            raise SystemExit("FAIL: could not read the fence: " + message)
        for row in payload:
            kind, _, rest = str(row["k"]).partition("|")
            rows.setdefault(kind, []).append(rest.split("|"))
    return rows


def real_jobs(census: dict[str, list[list[str]]]) -> list[list[str]]:
    """Sandbox jobs that are not the dedicated automation sandbox.

    Every one of these is a job that was somebody's real work before it was
    made practice data, and a test login may finish its units, edit its
    openings and delete its rows. Split out from the rest because a summary
    that lists ZZTEST and a live job in one flat list reads as "the sandbox",
    and that is how BLACK22 sat inside the fence for a week without anyone
    weighing in (2026-08-25 seeded it, 2026-09-02 the owner reported the write).
    """
    return sorted(
        fields for fields in census.get("sandbox_job", [])
        if fields and fields[0] != AUTOMATION_SANDBOX
    )


def render(census: dict[str, list[list[str]]], project: str) -> tuple[str, bool]:
    """The job summary, and whether the deploy may proceed."""
    scoped = census.get("scoped", [])
    unguarded = census.get("unguarded", [])
    jobs = sorted(census.get("sandbox_job", []))
    real = real_jobs(census)
    logins = sorted(fields[0] for fields in census.get("test_login", []))

    # "HOLDING" on its own is a claim this check is not entitled to make while a
    # real job sits inside the sandbox: the triggers can all be present and a QA
    # login can still write a customer's house. So the headline carries both
    # facts, and the reader does not have to scroll to find the second one.
    headline = "HOLDING" if not unguarded else "OPEN"
    if not unguarded and real:
        headline += " on every table — and %d real job%s %s inside the sandbox" % (
            len(real), "" if len(real) == 1 else "s", "is" if len(real) == 1 else "are",
        )
    out = ["### Test-login fence: " + headline]
    out.append("")

    if not scoped:
        out.append(
            "**Nothing was measured.** The census returned no project-scoped "
            "tables at all, which cannot be true of this schema. Treat this as "
            "a broken check, not a healthy fence.",
        )
        return "\n".join(out) + "\n", False

    out.append(
        "%d of %d project-scoped tables on `%s` carry the sandbox guard."
        % (len(scoped) - len(unguarded), len(scoped), project),
    )
    out.append("")

    if unguarded:
        out.append(
            "#### A test login can write these tables on ANY job",
        )
        out.append("")
        out.append(
            "Each row is a table `guard_test_account_sandbox_only` is missing "
            "from, switched off on, or mis-attached to. Call "
            "`select public.attach_sandbox_guards();` from the migration that "
            "made it project-scoped — see "
            "`supabase/migrations/" + REARM_MIGRATION + "`.",
        )
        out.append("")
        for fields in unguarded[:MAX_LISTED]:
            name = fields[0]
            column = fields[1] if len(fields) > 1 else "?"
            reason = fields[2] if len(fields) > 2 else "unknown"
            out.append("- `%s` (links through `%s`) — %s" % (name, column, reason))
        if len(unguarded) > MAX_LISTED:
            out.append("- …and %d more" % (len(unguarded) - MAX_LISTED))
        out.append("")

    out.append("#### Jobs a test login is allowed to write")
    out.append("")
    if jobs:
        out.append(
            "Everything else on this database is read-only to the accounts "
            "below. `%s` is the automation sandbox — a job that exists to be "
            "written by robots. Anything else here is a real job somebody made "
            "practice data, and a test login can finish its units, edit its "
            "openings and delete its rows." % AUTOMATION_SANDBOX,
        )
        out.append("")
        for fields in jobs[:MAX_LISTED]:
            code = fields[0]
            name = fields[1] if len(fields) > 1 and fields[1] else ""
            if code == AUTOMATION_SANDBOX:
                out.append("- `%s` — %s (the automation sandbox)" % (code, name))
            else:
                out.append("- `%s` — %s — **a real job**" % (code, name))
        if len(jobs) > MAX_LISTED:
            out.append("- …and %d more" % (len(jobs) - MAX_LISTED))
        if real:
            out.append("")
            # Naming the decision, not making it. Which jobs count as practice
            # data is the owner's call; what this check owes him is that the
            # answer stops being discovered by accident.
            out.append(
                "**This is a decision nobody has confirmed since the "
                "2026-09-02 incident.** `20260933000000_testing_projects.sql` "
                "put a real job into the sandbox by name, and the fence has "
                "allowed a test login to write it ever since — the guard doing "
                "exactly what it says, against a sandbox that grew. Nothing in "
                "this check reverses that. The open question is written down at "
                "`" + SANDBOX_DECISION + "`.",
            )
    else:
        out.append(
            "None. No job is registered as a sandbox, so a test login can "
            "write nothing at all — safe, but the QA accounts are useless "
            "until one is added.",
        )
    out.append("")

    out.append("#### Accounts the fence applies to")
    out.append("")
    for name in logins or ["(none — no profile is flagged is_test)"]:
        out.append("- %s" % name)

    return "\n".join(out) + "\n", not unguarded


def result_line(census: dict[str, list[list[str]]]) -> str:
    """One machine-readable line, the shape scripts/verify-schema.sh parses.

    `real_jobs` is the count that moved on 2026-08-25 and that nobody saw move,
    so it is on the line a person greps rather than only in the prose.
    """
    return (
        "::result:: scoped=%d unguarded=%d sandbox_jobs=%d real_jobs=%d "
        "test_logins=%d" % (
            len(census.get("scoped", [])),
            len(census.get("unguarded", [])),
            len(census.get("sandbox_job", [])),
            len(real_jobs(census)),
            len(census.get("test_login", [])),
        )
    )


def main(argv: list[str]) -> int:
    paths = [a for a in argv[1:] if not a.startswith("--")]
    if not paths:
        sys.stderr.write(
            "usage: sandbox_guard.py <census.json> [more.json ...]\n"
            "Take the snapshot with: scripts/pgq.sh scripts/sandbox_guard_census.sql\n",
        )
        return 2

    project = os.environ.get("SUPABASE_PROJECT_REF", "the live database")
    census = load_census(paths)
    summary, ok = render(census, project)
    sys.stdout.write(summary)
    sys.stdout.write("\n" + result_line(census) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
