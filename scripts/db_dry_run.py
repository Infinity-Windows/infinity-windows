#!/usr/bin/env python3
"""The rolled-back database practice run: build the one batch, and read its answer.

scripts/db-dry-run.sh is the entry point (it holds the token and talks to the
Management API). This is the half that can be proved without a network, in
scripts/test_db_dry_run.py, and on a real PostgreSQL in
scripts/db-dry-run-harness.test.sh. Two subcommands:

  build --out BATCH.sql --probe PROBE.sql MIGRATION.sql [MIGRATION.sql ...]
      Refuses anything that could escape the transaction, then writes the
      batch:  begin;  ->  the harness below  ->  the migrations, in the order
      given  ->  the probe  ->  a `do` block that raises an exception carrying
      the probe's results. That forced error is the guarantee: Postgres rolls
      the whole batch back whether or not anything before it misbehaved, so
      the run leaves no trace, and the error message is how the results get
      out.

  judge --status HTTP_STATUS --body RESPONSE_FILE
      Reads the Management API's answer (or psql's stderr — any text, JSON or
      not), finds the results inside the forced error, prints the table, and
      exits 0 only when every check passed. A statement that failed earlier is
      reported as the result: the change is broken, and it was rolled back too.

Exit codes, shared with the wrapper:
  0  every check passed, and nothing was kept
  1  the change is broken: a statement failed, a check reported ok=false, or
     the probe recorded no checks at all (a run that checks nothing proves
     nothing)
  2  refused or misused; nothing was sent
  3  could not tell: no answer, an answer with no results in it, or a batch
     that ended WITHOUT the forced error
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

MARK_START = "DRY_RUN_RESULT:"
MARK_END = ":DRY_RUN_END"

# What the batch may not contain, because it would break out of the one
# transaction the whole promise rests on. Each is matched against a statement
# with comments, strings and dollar-quoted bodies removed, so a `commit` in a
# comment or an `end;` inside a plpgsql body is not a false alarm. The message
# is what the person sees; it says what to do.
HOSTILE = [
    (r"^(begin|start\s+transaction)\b",
     "starts a transaction of its own. The batch owns the transaction."),
    (r"^(commit|end)\b",
     "would commit, which is the one thing a practice run must never do."),
    (r"^(rollback|abort)\b",
     "rolls back by hand. The batch's forced error already does that, for everything."),
    (r"^(prepare\s+transaction|commit\s+prepared|rollback\s+prepared)\b",
     "uses two-phase commit, which cannot run inside the batch."),
    (r"^set\s+transaction\b",
     "sets transaction properties, which has to be the first statement of a transaction and is not."),
    (r"^create\s+(unique\s+)?index\s+concurrently\b",
     "is CREATE INDEX CONCURRENTLY, which cannot run inside a transaction. Build the index without CONCURRENTLY, or in a migration of its own."),
    (r"^drop\s+index\s+concurrently\b",
     "is DROP INDEX CONCURRENTLY, which cannot run inside a transaction."),
    (r"^reindex\b.*\bconcurrently\b",
     "is REINDEX CONCURRENTLY, which cannot run inside a transaction."),
    (r"^vacuum\b",
     "is VACUUM, which cannot run inside a transaction."),
    (r"^alter\s+system\b",
     "is ALTER SYSTEM, which cannot run inside a transaction."),
    (r"^(create|drop)\s+database\b",
     "creates or drops a database, which cannot run inside a transaction."),
    (r"^(create|drop)\s+tablespace\b",
     "creates or drops a tablespace, which cannot run inside a transaction."),
    (r"^discard\b",
     "is DISCARD, which would throw away the harness the probe relies on."),
    (r"^copy\b",
     "is COPY, which needs a file or stdin the Management API cannot give it."),
    (r"^\\",
     "is a psql command, not SQL. The Management API runs SQL only."),
]

# The one exception: a migration that wraps ITSELF in a transaction. Fourteen
# of the migrations on master do, and `supabase db push` accepts them because
# it applies each file in a transaction of its own — exactly as this batch
# does. So a `begin;` that is the first statement and a `commit;` that is the
# last are set aside, not refused, and the file runs under the batch's
# transaction instead. A wrapper with only one half, or a begin/commit anywhere
# else, is still refused: those are the shapes that could commit in the middle.
WRAP_BEGIN = re.compile(r"^(begin|start\s+transaction)(\s+(work|transaction))?(\s+(read|isolation|deferrable|not)\b.*)?$")
WRAP_END = re.compile(r"^(commit|end)(\s+(work|transaction))?(\s+and\s+(no\s+)?chain)?$")

# Set on the transaction before the migrations run. A migration takes the same
# locks the real deploy would — ALTER TABLE on time_shifts waits for every
# clock punch in flight and then blocks the next ones until the batch ends —
# so the batch must never sit in a lock queue: it fails fast and the person
# runs it again, rather than holding the crew's clock hostage behind a report.
DEFAULT_LOCK_TIMEOUT = "5s"
DEFAULT_STATEMENT_TIMEOUT = "120s"

TIMEOUT_RE = re.compile(r"^\d+(ms|s|min|h)?$")


# --------------------------------------------------------------------------
# Reading SQL: statements, with the parts that cannot be statements removed
# --------------------------------------------------------------------------

DOLLAR_TAG = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


class Statement:
    """One top-level statement: where it sits in the file, and its skeleton."""

    def __init__(self, start: int, code_start: int, end: int, skeleton: str):
        self.start = start            # offset just past the previous `;` (comments before the code included)
        self.code_start = code_start  # offset of the first character that is code, not comment or space
        self.end = end                # offset just past the terminating `;` (or EOF)
        self.skeleton = skeleton      # lowercased, comments/strings/bodies removed, whitespace collapsed


def split_statements(sql: str) -> list[Statement]:
    """Split at top-level semicolons, ignoring `;` inside comments, quoted
    strings, quoted identifiers and dollar-quoted bodies. The skeleton of each
    statement keeps the keywords and drops the rest, so a `commit` in a comment
    or an `end;` closing a plpgsql block is never mistaken for the real thing.
    """
    out: list[Statement] = []
    i, n = 0, len(sql)
    start = 0
    code_start = -1
    skel: list[str] = []

    def flush(end: int) -> None:
        nonlocal code_start
        text = re.sub(r"\s+", " ", "".join(skel)).strip().lower()
        # A run of only comments and whitespace is not a statement.
        if text:
            out.append(Statement(start, code_start, end, text))
        skel.clear()
        code_start = -1

    def code_at(pos: int) -> None:
        nonlocal code_start
        if code_start < 0:
            code_start = pos

    while i < n:
        c = sql[i]
        two = sql[i:i + 2]
        if two == "--":
            j = sql.find("\n", i)
            i = n if j < 0 else j + 1
            skel.append(" ")
            continue
        if two == "/*":
            depth, j = 1, i + 2
            while j < n and depth:
                if sql[j:j + 2] == "/*":
                    depth, j = depth + 1, j + 2
                elif sql[j:j + 2] == "*/":
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            i = j
            skel.append(" ")
            continue
        if c == "'":
            code_at(i)
            escapes = i > 0 and sql[i - 1] in "eE" and (i < 2 or not sql[i - 2].isalnum() and sql[i - 2] != "_")
            j = i + 1
            while j < n:
                if escapes and sql[j] == "\\":
                    j += 2
                    continue
                if sql[j] == "'":
                    if sql[j + 1:j + 2] == "'":
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            skel.append(" ' ")
            continue
        if c == '"':
            code_at(i)
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if sql[j + 1:j + 2] == '"':
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            skel.append(' " ')
            continue
        if c == "$":
            m = DOLLAR_TAG.match(sql, i)
            if m:
                code_at(i)
                tag = m.group(0)
                j = sql.find(tag, m.end())
                i = n if j < 0 else j + len(tag)
                skel.append(" $body$ ")
                continue
        if c == ";":
            flush(i + 1)
            i += 1
            start = i
            continue
        if not c.isspace():
            code_at(i)
        skel.append(c)
        i += 1
    flush(n)
    return out


class Refused(Exception):
    """Something the batch must not carry. The message says which and why."""


def hostile_reason(skeleton: str) -> str | None:
    for pattern, why in HOSTILE:
        if re.match(pattern, skeleton):
            return why
    return None


def excerpt(sql: str, st: Statement) -> str:
    text = re.sub(r"\s+", " ", sql[st.code_start:st.end]).strip()
    return text if len(text) <= 90 else text[:87] + "..."


def prepare_migration(path: str, sql: str) -> tuple[str, list[str]]:
    """The migration's text as the batch will carry it, plus notes for the plan.

    A self-contained begin/commit wrapper is set aside (see WRAP_BEGIN); any
    other transaction control, or anything that cannot run inside a
    transaction at all, is refused.
    """
    statements = split_statements(sql)
    if not statements:
        raise Refused(f"{path} has no SQL statements in it.")
    notes: list[str] = []
    first, last = statements[0], statements[-1]
    wrapped = bool(WRAP_BEGIN.match(first.skeleton)) and bool(WRAP_END.match(last.skeleton)) and len(statements) > 2
    if wrapped:
        body_statements = statements[1:-1]
        notes.append("its own begin/commit wrapper was set aside: the batch owns the transaction")
    else:
        body_statements = statements
    for st in body_statements:
        why = hostile_reason(st.skeleton)
        if why:
            raise Refused(f"{path} {why}\n    statement: {excerpt(sql, st)}")
    if not wrapped:
        return sql, notes
    # Only the two statements go; the comments around them (the file's header
    # among them) stay, so the batch still reads like the migration.
    replacement_begin = "-- [dry run] the file's own `%s` was set aside here: the batch owns the transaction\n" % excerpt(sql, first)
    replacement_end = "-- [dry run] the file's own `%s` was set aside here: the batch's forced error rolls everything back\n" % excerpt(sql, last)
    return (sql[:first.code_start] + replacement_begin + sql[first.end:last.code_start]
            + replacement_end + sql[last.end:]), notes


def check_probe(path: str, sql: str) -> int:
    """A probe is refused for ANY transaction control: the script owns `begin`
    and the final raise, so a probe that carries its own could commit the
    migration it is meant to be trying out. Returns the statement count.
    """
    statements = split_statements(sql)
    if not statements:
        raise Refused(f"{path} has no SQL statements in it.")
    for st in statements:
        why = hostile_reason(st.skeleton)
        if why:
            raise Refused(f"{path} {why}\n    statement: {excerpt(sql, st)}\n"
                          "    A probe never opens, commits or rolls back a transaction: the batch does.")
    if "dry_run_check" not in sql and "dry_run_expect_error" not in sql:
        raise Refused(f"{path} never calls pg_temp.dry_run_check or pg_temp.dry_run_expect_error, "
                      "so it could not report anything. scripts/dry-run-probes/TEMPLATE.sql shows the shape.")
    return len(statements)


# --------------------------------------------------------------------------
# The harness the probe calls, and the forced error at the end
# --------------------------------------------------------------------------

HARNESS = r"""
-- ===========================================================================
-- The harness (scripts/db_dry_run.py owns this; probes call it).
-- Temporary objects only: they die with the connection, and everything the
-- batch does dies with the forced error at the end.
-- ===========================================================================
create temp table dry_run_results (
  n serial primary key,
  "check" text not null,
  ok boolean not null,
  detail text
);
-- A probe records its checks while acting as a signed-in person, so the
-- client roles have to be able to reach the table and the helpers. The
-- project's default privileges revoke EXECUTE from public on every function
-- postgres creates (20260992000000), so each grant below is load-bearing.
grant insert, select on table pg_temp.dry_run_results to anon, authenticated;
grant usage, select on sequence pg_temp.dry_run_results_n_seq to anon, authenticated;

-- Record one check. ok=false fails the run; detail is what the table shows
-- (keep it to ids and counts: the run's log is readable by everyone with
-- access to the repository, so never a person's name or email).
create function pg_temp.dry_run_check(p_check text, p_ok boolean, p_detail text default null)
returns void language sql as $dry$
  insert into pg_temp.dry_run_results ("check", ok, detail)
  values (p_check, coalesce(p_ok, false), left(p_detail, 500));
$dry$;
grant execute on function pg_temp.dry_run_check(text, boolean, text) to anon, authenticated;

-- Act as one person from here on: their JWT claims (transaction-local) and
-- the `authenticated` role, so every policy, grant and auth.uid() sees the
-- request the way the app's would. Returns their app role.
create function pg_temp.dry_run_act_as(p_profile uuid)
returns text language plpgsql as $dry$
declare
  v_role text;
  v_email text;
begin
  execute 'reset role';
  select p.role into v_role from public.profiles p where p.id = p_profile;
  if v_role is null then
    raise exception 'dry run: there is no profile % to act as', p_profile;
  end if;
  select u.email into v_email from auth.users u where u.id = p_profile;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_profile::text, 'role', 'authenticated', 'email', v_email,
    'aud', 'authenticated', 'iss', 'supabase')::text, true);
  perform set_config('request.jwt.claim.sub', p_profile::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.email', coalesce(v_email, ''), true);
  execute 'set local role authenticated';
  return v_role;
end $dry$;
grant execute on function pg_temp.dry_run_act_as(uuid) to anon, authenticated;

-- Back to the system: no row security, no caller. For setup, and for reading
-- the truth after an RPC ran.
create function pg_temp.dry_run_as_system()
returns void language plpgsql as $dry$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.email', '', true);
end $dry$;
grant execute on function pg_temp.dry_run_as_system() to anon, authenticated;

-- Somebody with a role. The QA test login first where the role has one
-- (docs/test-account.md: the accounts built to write on the sandbox job, and
-- fenced to it by the database if a rollback ever failed); otherwise the
-- longest-standing real account of that role. Everything is rolled back
-- either way. Resets to the system, so pick people BEFORE acting as one.
create function pg_temp.dry_run_pick(p_role text)
returns uuid language plpgsql as $dry$
declare v_id uuid;
begin
  execute 'reset role';
  select p.id into v_id from public.profiles p
   where p.role = p_role
     and p.retired_at is null and p.access_revoked_at is null
     and coalesce(p.is_partner, false) = false
   order by coalesce(p.is_test, false) desc, p.id
   limit 1;
  if v_id is null then
    raise exception 'dry run: nobody with the role % to act as', p_role;
  end if;
  return v_id;
end $dry$;
grant execute on function pg_temp.dry_run_pick(text) to anon, authenticated;

-- A real person of a role, never a QA login: for an RPC that treats test
-- logins differently, or a role that has no QA login. Rolled back like all.
create function pg_temp.dry_run_pick_real(p_role text)
returns uuid language plpgsql as $dry$
declare v_id uuid;
begin
  execute 'reset role';
  select p.id into v_id from public.profiles p
   where p.role = p_role
     and p.retired_at is null and p.access_revoked_at is null
     and coalesce(p.is_partner, false) = false
     and not coalesce(p.is_test, false)
   order by p.id
   limit 1;
  if v_id is null then
    raise exception 'dry run: no real person with the role % to act as', p_role;
  end if;
  return v_id;
end $dry$;
grant execute on function pg_temp.dry_run_pick_real(text) to anon, authenticated;

-- A job by its code. BLACK22 is the sandbox job every probe targets: it is a
-- testing project, so even a rollback that failed could touch nothing real.
-- Resets to the system (the row is hidden from installers by design).
create function pg_temp.dry_run_job(p_job_code text default 'BLACK22')
returns uuid language plpgsql as $dry$
declare v_id uuid;
begin
  execute 'reset role';
  select p.id into v_id from public.projects p
   where p.job_code = p_job_code and p.deleted_at is null;
  if v_id is null then
    raise exception 'dry run: there is no job with the code %', p_job_code;
  end if;
  return v_id;
end $dry$;
grant execute on function pg_temp.dry_run_job(text) to anon, authenticated;

-- Run a statement that SHOULD be refused, as whoever we are acting as. The
-- check passes when it raises (and, if p_expect is given, when the error
-- mentions it); a statement that quietly succeeds fails the check. The
-- refused statement's own writes are undone with the error, as they would
-- be for the app.
create function pg_temp.dry_run_expect_error(p_check text, p_sql text, p_expect text default null)
returns void language plpgsql as $dry$
begin
  execute p_sql;
  perform pg_temp.dry_run_check(p_check, false,
    'was NOT refused' || coalesce(' (expected an error mentioning "' || p_expect || '")', ''));
exception when others then
  perform pg_temp.dry_run_check(p_check,
    p_expect is null or position(lower(p_expect) in lower(sqlerrm)) > 0,
    'refused: ' || sqlstate || ' ' || sqlerrm);
end $dry$;
grant execute on function pg_temp.dry_run_expect_error(text, text, text) to anon, authenticated;
"""

FINAL = r"""
-- ===========================================================================
-- The end. The results leave in an exception, which rolls everything back:
-- the migrations, the probe's writes, every helper above. Nothing is kept.
-- ===========================================================================
do $dry$
declare v_payload text;
begin
  execute 'reset role';
  select coalesce(json_agg(json_build_object('check', r."check", 'ok', r.ok, 'detail', r.detail) order by r.n), '[]'::json)::text
    into v_payload
    from pg_temp.dry_run_results r;
  raise exception 'DRY_RUN_RESULT:%:DRY_RUN_END', v_payload;
end $dry$;
"""


def timeout_setting(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip() or default
    if not TIMEOUT_RE.match(value):
        raise Refused(f"{name}={value!r} is not a Postgres duration like 5s, 500ms or 2min.")
    return value


def build(out_path: str, probe_path: str, migration_paths: list[str]) -> list[str]:
    """Write the batch and return the plan lines to print."""
    if not migration_paths:
        raise Refused("name at least one migration file (the .sql under supabase/migrations/ the pull request adds).")
    lock_timeout = timeout_setting("DB_DRY_RUN_LOCK_TIMEOUT", DEFAULT_LOCK_TIMEOUT)
    statement_timeout = timeout_setting("DB_DRY_RUN_STATEMENT_TIMEOUT", DEFAULT_STATEMENT_TIMEOUT)

    plan: list[str] = []
    parts: list[str] = [
        "begin;\n",
        f"set local lock_timeout = '{lock_timeout}';\n",
        f"set local statement_timeout = '{statement_timeout}';\n",
        HARNESS,
    ]
    for k, path in enumerate(migration_paths, 1):
        sql = read_text(path)
        text, notes = prepare_migration(path, sql)
        count = len(split_statements(text))
        plan.append(f"migration {k}: {path} ({count} statement{'s' if count != 1 else ''}"
                    + (f"; {'; '.join(notes)}" if notes else "") + ")")
        parts.append(f"\n-- ===========================================================================\n"
                     f"-- migration {k}: {path}\n"
                     f"-- ===========================================================================\n")
        parts.append(text if text.endswith("\n") else text + "\n")
    probe_sql = read_text(probe_path)
    count = check_probe(probe_path, probe_sql)
    plan.append(f"probe: {probe_path} ({count} statement{'s' if count != 1 else ''})")
    parts.append("\n-- ===========================================================================\n"
                 f"-- probe: {probe_path}\n"
                 "-- ===========================================================================\n")
    parts.append(probe_sql if probe_sql.endswith("\n") else probe_sql + "\n")
    parts.append(FINAL)
    batch = "".join(parts)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(batch)
    plan.append(f"batch: {len(batch.encode('utf-8'))} bytes, one transaction, lock_timeout {lock_timeout}, "
                f"statement_timeout {statement_timeout}; rolled back by the forced error at its end")
    return plan


def read_text(path: str) -> str:
    if not os.path.isfile(path):
        raise Refused(f"{path} is not a file here.")
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# --------------------------------------------------------------------------
# Reading the answer
# --------------------------------------------------------------------------

def strings_in(value, depth: int = 0) -> list[str]:
    """Every string inside a parsed JSON value, deepest first: a string that
    is itself JSON (an API wrapping another API's error) is opened, and what
    is inside it comes before it, because the marker's payload is only
    readable at the level where it is not JSON-escaped."""
    found: list[str] = []
    if isinstance(value, str):
        stripped = value.lstrip()
        if depth < 4 and stripped[:1] and stripped[0] in "{[":
            try:
                found.extend(strings_in(json.loads(value), depth + 1))
            except ValueError:
                pass
        found.append(value)
    elif isinstance(value, dict):
        for v in value.values():
            found.extend(strings_in(v, depth))
    elif isinstance(value, list):
        for v in value:
            found.extend(strings_in(v, depth))
    return found


def find_results(body: str):
    """(results list, problem). results is None when the marker is absent;
    problem names a marker that was there but unreadable in every place it
    appeared."""
    candidates: list[str] = []
    parsed = None
    try:
        parsed = json.loads(body)
    except ValueError:
        pass
    if parsed is not None:
        candidates.extend(strings_in(parsed))
    candidates.append(body)
    problem = None
    for text in candidates:
        i = text.find(MARK_START)
        if i < 0:
            continue
        rest = text[i + len(MARK_START):]
        try:
            value, end = json.JSONDecoder().raw_decode(rest)
        except ValueError:
            problem = problem or "the results inside the error were cut short or unreadable"
            continue
        if not rest[end:].startswith(MARK_END):
            problem = problem or "the results inside the error did not end where they should"
            continue
        if not isinstance(value, list):
            problem = problem or "the results inside the error were not a list"
            continue
        return value, None
    return None, problem


def error_text(body: str) -> str:
    """The database's own words for what went wrong, from whichever shape the
    answer came in: the Management API's {"message": ...}, pg-meta's richer
    object, or plain text."""
    try:
        parsed = json.loads(body)
    except ValueError:
        return body.strip()
    if isinstance(parsed, dict):
        for key in ("formattedError", "message", "error", "detail", "hint"):
            v = parsed.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, dict):
                inner = error_text(json.dumps(v))
                if inner:
                    return inner
        return json.dumps(parsed)[:600]
    return json.dumps(parsed)[:600]


EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def scrub(text: str) -> str:
    """Nothing that identifies a person or unlocks the project reaches the log."""
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if token:
        text = text.replace(token, "[token]")
    return EMAIL.sub("[email]", text)


def judge(status: str, body_path: str, project: str) -> int:
    with open(body_path, encoding="utf-8", errors="replace") as fh:
        body = fh.read()
    where = f" on {project}" if project else ""
    results, problem = find_results(body)

    if results is not None:
        return render(results, where)

    say = lambda *lines: print(scrub("\n".join(lines)))  # noqa: E731

    if problem:
        say(f"COULD NOT TELL: the batch reached its end{where}, but {problem}.",
            "The forced error fired, so everything was rolled back; the results just did not survive the trip.",
            "    " + error_text(body)[:600].replace("\n", "\n    "))
        return 3

    code = status.strip()
    if code.startswith("2"):
        say(f"COULD NOT TELL: the batch{where} finished WITHOUT its forced error.",
            "That should be impossible: the last statement always raises. Treat nothing as proven,",
            "and read the answer below to see what the database ran.",
            "    " + body.strip()[:600].replace("\n", "\n    "))
        return 3
    if code == "400" or "ERROR" in body:
        said = error_text(body)
        # A lock the crew was holding, or a slow statement, is not a broken
        # change — it is a run to repeat when the clock is quieter.
        if re.search(r"lock timeout|statement timeout", said, re.IGNORECASE):
            say(f"COULD NOT TELL: the batch{where} timed out waiting, so the change was not tried to the end.",
                "Everything was rolled back. Run it again in a quieter minute, or raise DB_DRY_RUN_LOCK_TIMEOUT /",
                "DB_DRY_RUN_STATEMENT_TIMEOUT if the migration genuinely takes longer. The database said:",
                "    " + said.replace("\n", "\n    "))
            return 3
        say(f"FAIL: a statement failed before the end of the batch{where}, so the change is broken.",
            "Everything before it was rolled back with it; nothing was kept. The database said:",
            "    " + said.replace("\n", "\n    "))
        return 1
    say(f"COULD NOT TELL: the Management API answered {code or 'nothing'}{where}, which is not a result.",
        "Nothing was measured. A 401 or 403 is the token; a 404 is the project ref; a 5xx is Supabase's day.",
        "    " + error_text(body)[:600].replace("\n", "\n    "))
    return 3


def render(results: list, where: str) -> int:
    rows = []
    for item in results:
        if not isinstance(item, dict):
            rows.append(("?", False, f"a result that was not an object: {json.dumps(item)[:120]}"))
            continue
        rows.append((str(item.get("check", "?")), item.get("ok") is True, str(item.get("detail") or "")))
    failed = [r for r in rows if not r[1]]
    print(scrub(f"Rolled-back database practice run{where}"))
    if not rows:
        print("FAIL: the probe recorded no checks, so nothing was proved. A probe that checks nothing")
        print("      is not a probe: call pg_temp.dry_run_check at least once (scripts/dry-run-probes/TEMPLATE.sql).")
        print("Nothing was kept: the forced error rolled the batch back.")
        return 1
    width = min(max(len(r[0]) for r in rows), 72)
    for check, ok, detail in rows:
        mark = "ok  " if ok else "FAIL"
        name = check if len(check) <= width else check[:width - 3] + "..."
        line = f"  {mark}  {name.ljust(width)}"
        if detail:
            line += f"  {detail}"
        print(scrub(line))
    print()
    if failed:
        print(f"FAIL: {len(failed)} of {len(rows)} checks failed. The change is not ready.")
    else:
        print(f"OK: all {len(rows)} checks passed.")
    print("Nothing was kept: the batch ended in the forced error, which rolled back the migrations,")
    print("the probe's writes and the harness together.")
    return 1 if failed else 0


# --------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="write the batch, or refuse")
    b.add_argument("--out", required=True, help="where to write the batch SQL")
    b.add_argument("--probe", required=True, help="the probe .sql (scripts/dry-run-probes/)")
    b.add_argument("migrations", nargs="*", help="migration files, in the order they apply")
    j = sub.add_parser("judge", help="read the answer and print the table")
    j.add_argument("--status", required=True, help="the HTTP status curl saw (000 when nothing came back)")
    j.add_argument("--body", required=True, help="the response body file")
    j.add_argument("--project", default="", help="the project ref, for the heading only")
    args = parser.parse_args(argv)

    if args.command == "build":
        try:
            for line in build(args.out, args.probe, args.migrations):
                print(line)
        except Refused as e:
            print(f"REFUSED: {e}\nNothing was sent.", file=sys.stderr)
            return 2
        return 0
    return judge(args.status, args.body, args.project)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
