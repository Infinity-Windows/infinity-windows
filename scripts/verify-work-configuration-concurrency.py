#!/usr/bin/env python3
"""Exercise real, independent PostgreSQL backends against the actual
work-configuration migrations -- never the production database.

Pattern (subprocess/psql/barrier only) borrowed from
scripts/verify-values-concurrency.py; none of its domain fixtures are
reused. Schema bootstrap and the real dependency-helper extraction are
pulled from the CURRENT scripts/verify-work-configuration.mjs, never
hand-duplicated, so the two verifiers cannot quietly drift apart. The
actual 20261107020000 foundation and 20261108000000 configuration
migrations run verbatim, byte-for-byte, against a real Postgres.

No third-party Python modules. Refuses outright unless
WORK_CONFIGURATION_TEST_DB_URL points at localhost/127.0.0.1 and the exact
database /forge_work_configuration_test, and refuses again if that database
is not actually fresh (CI must hand this script an empty database; it does
not create or drop one). Disposable synthetic profiles/projects only -- no
production credentials, no production schema, no payroll/personal-timing
claim. This is source-only until the parent runs it in CI: see the final
printed line.
"""
import atexit
import json
import os
import re
import subprocess
import time
import uuid as uuidlib
from pathlib import Path
from urllib.parse import urlparse

URL = os.environ.get('WORK_CONFIGURATION_TEST_DB_URL', '')
parsed = urlparse(URL)
if (parsed.scheme not in ('postgres', 'postgresql')
        or parsed.hostname not in ('localhost', '127.0.0.1')
        or parsed.path != '/forge_work_configuration_test'
        or parsed.query or parsed.fragment or parsed.port not in (None, 5432)):
    # libpq accepts query host/dbname overrides: never pass those through.

    raise SystemExit(
        'Refused: WORK_CONFIGURATION_TEST_DB_URL must point at localhost/127.0.0.1 '
        'and the exact disposable database /forge_work_configuration_test')

ROOT = Path(__file__).resolve().parent.parent
PSQL = ['psql', URL, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1']
# Do not let inherited libpq service/hostaddr/options override the local URI.
CONNECTION_ENV = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
CONNECTION_ENV['PGCONNECT_TIMEOUT'] = '3'
# Every statement/lock wait is bounded; a hang becomes a failed test, not a
# stuck CI job. sqlstate verbosity gives sanitized, parseable error output
# (just the five-character code) instead of raw server text.
PRELUDE = (
    "\\set VERBOSITY sqlstate\n"
    "set statement_timeout = '15s';\n"
    "set lock_timeout = '10s';\n"
)


def run(sql, expect_error=None, timeout=20):
    result = subprocess.run(PSQL, input=PRELUDE + sql, text=True, capture_output=True, timeout=timeout, env=CONNECTION_ENV)
    if expect_error:
        assert result.returncode != 0, f'expected SQLSTATE {expect_error} but the call succeeded: {result.stdout}'
        assert expect_error in result.stderr, f'expected SQLSTATE {expect_error}, got: {result.stderr!r}'
        return result.stderr.strip()
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


processes = []


def cleanup():
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)


atexit.register(cleanup)


def begin_async(sql, hold=False):
    proc = subprocess.Popen(PSQL, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env=CONNECTION_ENV)
    match = re.search(r"set application_name='([^']+)'", sql)
    proc.fixture_app = match.group(1) if match else None
    processes.append(proc)
    proc.stdin.write(PRELUDE + sql + '\n')
    proc.stdin.flush()
    if not hold:
        proc.stdin.close()
    return proc


def release(proc):
    proc.stdin.write('commit;\n')
    proc.stdin.close()


def finish(proc):
    proc.wait(timeout=15)
    out = proc.stdout.read()
    err = proc.stderr.read()
    assert proc.returncode == 0, err
    return out.strip()


def finish_expect_error(proc, code):
    proc.wait(timeout=15)
    out = proc.stdout.read()
    err = proc.stderr.read()
    assert proc.returncode != 0, f'expected SQLSTATE {code} but the call succeeded: {out}'
    assert code in err, f'expected SQLSTATE {code}, got: {err!r}'
    return out.strip()


def wait_gate(app, waiting=False, blocked_by=None):
    """work_configuration's single dedicated gate is the two-key integer
    advisory lock pg_advisory_xact_lock(7710, 0) -- classid=7710, objid=0,
    objsubid=2 is exactly how Postgres records that two-argument form in
    pg_locks (per the brief, confirmed against PostgreSQL's own advisory
    lock documentation, not assumed)."""
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        for required_app in [name for name in (app, blocked_by) if name is not None]:
            proc = next(proc for proc in reversed(processes) if proc.fixture_app == required_app)
            assert proc.poll() is None, f'{required_app} exited before the gate barrier'
        result = run(
            "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid "
            f"where a.application_name = '{app}' and a.datname=current_database() and l.locktype = 'advisory' "
            "and l.classid = 7710 and l.objid = 0 and l.objsubid = 2 "
            f"and l.granted = {'false' if waiting else 'true'}", timeout=3)
        if int(result) > 0:
            if blocked_by:
                relation = run(
                    "select count(*) from pg_stat_activity w, pg_stat_activity h "
                    f"where w.application_name = '{app}' and h.application_name = '{blocked_by}' "
                    "and w.datname=current_database() and h.datname=current_database() "
                    "and h.pid <> w.pid and h.pid = any(pg_blocking_pids(w.pid))", timeout=3)
                if int(relation) == 0:
                    time.sleep(.02)
                    continue
            return
        time.sleep(.02)
    raise AssertionError(f'{app} did not reach the expected gate7710 state')


def new_uuid():
    return str(uuidlib.uuid4())


def auth(uid):
    return f"set request.jwt.claim.sub='{uid}'; set role authenticated;\n"


# ---------------------------------------------------------------------------
# Freshness refusal -- CI must hand this a genuinely empty database. This
# script leaves fixture objects for the CI-owned disposable database and does not drop/recreate
# the database itself.
# ---------------------------------------------------------------------------
connected_database = run('select current_database()')
if connected_database != 'forge_work_configuration_test':
    raise SystemExit('Refused: connected database is not the exact disposable fixture database')
existing = run(
    "select (exists(select 1 from pg_namespace where nspname not in ('public','information_schema') "
    "and left(nspname,3) <> 'pg_') or exists(select 1 from pg_class c join pg_namespace n "
    "on n.oid=c.relnamespace where left(n.nspname,3) <> 'pg_' and n.nspname <> 'information_schema') "
    "or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
    "where n.nspname='public') or exists(select 1 from pg_type t join pg_namespace n "
    "on n.oid=t.typnamespace where n.nspname='public'))::int")
if existing != '0':
    raise SystemExit('Refused: target database is not fresh -- user objects or a nondefault schema exist')

# ---------------------------------------------------------------------------
# Bootstrap: extracted from the CURRENT scripts/verify-work-configuration.mjs,
# never hand-duplicated. The two CREATE ROLE statements are the one line this
# script cannot take verbatim -- roles are cluster-wide in Postgres, not
# database-scoped, so a prior disposable run against the same local cluster
# can leave them behind even though THIS database is fresh; guarded with a
# plain existence check rather than skipped.
# ---------------------------------------------------------------------------
mjs_source = (ROOT / 'scripts/verify-work-configuration.mjs').read_text()
bootstrap_match = re.search(r"await db\.exec\(`(create role authenticated[\s\S]*?)`\);", mjs_source)
assert bootstrap_match, 'Actual bootstrap schema block must exist in verify-work-configuration.mjs'
bootstrap_sql = bootstrap_match.group(1)
bootstrap_sql = bootstrap_sql.replace(
    'create role authenticated; create role anon;',
    "do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then "
    "create role authenticated; end if; "
    "if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if; end $$;")
run(bootstrap_sql)

deps_match = re.search(r"for \(const \[file, names\] of \[([\s\S]*?)\]\) for \(const name of names\)", mjs_source)
assert deps_match, 'Actual dependency helper list must exist in verify-work-configuration.mjs'
dependency_pairs = re.findall(r"\['([^']+)', \[([^\]]+)\]\]", deps_match.group(1))
assert dependency_pairs, 'Actual dependency helper list must parse'


def migration_function(file, name):
    source = (ROOT / 'supabase/migrations' / file).read_text()
    prefixes = ['create or replace function public.', 'create function public.',
                'create or replace function ', 'create function ']
    start = -1
    for prefix in prefixes:
        idx = source.find(prefix + name + '(')
        if idx >= 0:
            start = idx
            break
    assert start >= 0, f'Actual helper must exist: {name} in {file}'
    end = source.find('$$;', start)
    assert end > start
    return source[start:end + 3]


for file, names_blob in dependency_pairs:
    for name in [n.strip().strip("'") for n in names_blob.split(',')]:
        run(migration_function(file, name))

run('set check_function_bodies = off;\n' +
    (ROOT / 'supabase/migrations/20261107020000_work_capture_foundation.sql').read_text())
run('set check_function_bodies = off;\n' +
    (ROOT / 'supabase/migrations/20261108000000_work_configuration.sql').read_text())

# ---------------------------------------------------------------------------
# Disposable synthetic fixture identities
# ---------------------------------------------------------------------------
OWNER = new_uuid()
SUPERVISOR = new_uuid()
FOREMAN = new_uuid()
LIVE_JOB = new_uuid()
run(f"insert into profiles(id,role) values('{OWNER}','owner'),('{SUPERVISOR}','supervisor'),('{FOREMAN}','foreman');"
    f"insert into projects(id) values('{LIVE_JOB}');")

cases_passed = 0


def publish_stmt(cid, code, label='X'):
    return f"select work_publish_activity_version('{cid}','{code}',0,'general','{label}','{label}',false,'[]');\n"


# ---------------------------------------------------------------------------
# Case 1: two owner publish commands, same code, same expected version 0.
# The first holds gate7710 through commit; the second visibly waits on it;
# after commit, exactly one version and one receipt exist, the loser gets
# SQLSTATE 23514, and no partial row survives for it. Run in both orders.
# ---------------------------------------------------------------------------
def publish_race(code, first_app, second_app):
    cid_first, cid_second = new_uuid(), new_uuid()
    first = begin_async(
        f"set application_name='{first_app}';\nbegin;\n{auth(OWNER)}{publish_stmt(cid_first, code, 'First')}",
        hold=True)
    wait_gate(first_app)
    second = begin_async(
        f"set application_name='{second_app}';\nbegin;\n{auth(OWNER)}{publish_stmt(cid_second, code, 'Second')}commit;\n")
    wait_gate(second_app, waiting=True, blocked_by=first_app)
    release(first)
    finish(first)
    finish_expect_error(second, '23514')
    version_count = int(run(
        "select count(*) from work_activity_definitions d "
        "join work_activity_definition_versions v on v.definition_id = d.id "
        f"where d.code = '{code}'"))
    assert version_count == 1, f'exactly one published version expected for {code}, found {version_count}'
    receipt_count = int(run(
        f"select count(*) from work_configuration_commands where command_id in ('{cid_first}','{cid_second}')"))
    assert receipt_count == 1, 'exactly one receipt expected; the loser leaves no partial row'
    winner = run(f"select command_id::text from work_configuration_commands where command_id = '{cid_first}'")
    assert winner == cid_first, 'the session that held the gate through commit is the one with the receipt'


publish_race('cc_pub_race_fwd', 'pub_race_a', 'pub_race_b')
publish_race('cc_pub_race_rev', 'pub_race_b', 'pub_race_a')
print('PASS case 1: owner publish race serializes on gate7710, loser refuses 23514, no partial row (both orders)')
cases_passed += 1

# ---------------------------------------------------------------------------
# Case 2: the exact same command id and payload, sent from two concurrent
# sessions, resolves to one immutable receipt and one version; both callers
# see an identical result.
# ---------------------------------------------------------------------------
cid_dup = new_uuid()
holder = begin_async(
    f"set application_name='dup_a';\nbegin;\n{auth(OWNER)}{publish_stmt(cid_dup, 'cc_exact_dup')}", hold=True)
wait_gate('dup_a')
waiter = begin_async(
    f"set application_name='dup_b';\nbegin;\n{auth(OWNER)}{publish_stmt(cid_dup, 'cc_exact_dup')}commit;\n")
wait_gate('dup_b', waiting=True, blocked_by='dup_a')
release(holder)
out_a = finish(holder)
out_b = finish(waiter)
assert out_a == out_b, f'exact duplicate command must return an identical result: {out_a!r} vs {out_b!r}'
assert int(run(f"select count(*) from work_configuration_commands where command_id = '{cid_dup}'")) == 1
assert int(run(
    "select count(*) from work_activity_definitions d join work_activity_definition_versions v "
    f"on v.definition_id = d.id where d.code = 'cc_exact_dup'")) == 1
print('PASS case 2: exact same command/payload concurrently -> identical result, one receipt, one version')
cases_passed += 1

# ---------------------------------------------------------------------------
# Case 3: the caller's transaction begins and blocks on gate7710 before a
# separate session revokes the acting owner (retired_at) and commits while
# the gate is still held. The caller's authority check, read fresh AFTER the
# wait resolves, must see the revocation and refuse 42501 -- never a stale
# pre-wait snapshot -- leaving no definition, version, or receipt row.
# ---------------------------------------------------------------------------
revoked_owner = new_uuid()
run(f"insert into profiles(id,role) values('{revoked_owner}','owner')")
cid_revoked = new_uuid()
blocker = begin_async("set application_name='auth_blocker';\nbegin;\nselect pg_advisory_xact_lock(7710, 0);\n",
                      hold=True)
wait_gate('auth_blocker')
caller = begin_async(
    "set application_name='auth_caller';\nbegin;\n" + auth(revoked_owner) +
    publish_stmt(cid_revoked, 'cc_auth_revoked') + 'commit;\n')
wait_gate('auth_caller', waiting=True, blocked_by='auth_blocker')
run(f"update profiles set retired_at = now() where id = '{revoked_owner}'")
release(blocker)
finish(blocker)
finish_expect_error(caller, '42501')
assert int(run("select count(*) from work_activity_definitions where code = 'cc_auth_revoked'")) == 0
assert int(run(f"select count(*) from work_configuration_commands where command_id = '{cid_revoked}'")) == 0
print('PASS case 3: authority is re-read fresh after the gate wait, not from before the revoke; no rows written')
cases_passed += 1

# ---------------------------------------------------------------------------
# Case 4: a publish transaction begins and blocks before the blocking
# session releases gate7710. Its published_at must follow the release
# (clock_timestamp() taken after the wait, never frozen at the statement's
# own start), an omitted effective_from resolves to that same immediate
# instant, and the stored normalized_payload keeps the caller's original
# "immediate" intent (JSON null) rather than baking in the resolved time --
# so a genuine retry with the same null still hashes to an exact replay.
# ---------------------------------------------------------------------------
cid_clock = new_uuid()
clock_blocker = begin_async("set application_name='clock_blocker';\nbegin;\nselect pg_advisory_xact_lock(7710, 0);\n",
                           hold=True)
wait_gate('clock_blocker')
late = begin_async(
    "set application_name='clock_late';\nbegin;\n" + auth(OWNER) +
    publish_stmt(cid_clock, 'cc_clock_after_wait') + 'commit;\n')
wait_gate('clock_late', waiting=True, blocked_by='clock_blocker')
before_release = run('select clock_timestamp()')
release(clock_blocker)
finish(clock_blocker)
finish(late)
published_after_release = run(
    f"select (result->>'publishedAt')::timestamptz > '{before_release}'::timestamptz "
    f"from work_configuration_commands where command_id = '{cid_clock}'")
assert published_after_release == 't', 'publishedAt must follow the release of the governing wait'
immediate_effective = run(
    f"select (result->>'publishedAt')::timestamptz = (result->>'effectiveFrom')::timestamptz "
    f"from work_configuration_commands where command_id = '{cid_clock}'")
assert immediate_effective == 't', 'an omitted effectiveFrom must resolve to the immediate publication instant'
stored_intent = run(f"select normalized_payload->'effectiveFrom' from work_configuration_commands where command_id = '{cid_clock}'")
assert stored_intent == 'null', 'caller intent for immediate publication must be stored as JSON null for retry, not a resolved timestamp'
print('PASS case 4: publishedAt follows the wait; immediate effectiveFrom; null intent preserved for retry')
cases_passed += 1

# ---------------------------------------------------------------------------
# Case 5: two job-menu selection writers, same job, same expected revision
# 0, against a valid published and currently effective menu on a live job.
# They serialize on the same gate7710; the loser refuses stale-CAS 23514;
# the winner's exact menu/activity version ids stay pinned on the row.
# ---------------------------------------------------------------------------
activity_cmd = new_uuid()
run(f"begin;\n{auth(OWNER)}{publish_stmt(activity_cmd, 'cc_race_activity')}commit;\n")
definition_id = run("select id::text from work_activity_definitions where code = 'cc_race_activity'")
version_id = run(
    "select v.id::text from work_activity_definitions d join work_activity_definition_versions v "
    "on v.definition_id = d.id where d.code = 'cc_race_activity'")
menu_items = json.dumps([{'definitionId': definition_id, 'versionId': version_id, 'position': 0, 'enabled': True}])
menu_cmd = new_uuid()
run(f"begin;\n{auth(OWNER)}select work_publish_menu_version('{menu_cmd}','cc_race_menu',0,'M','M','{menu_items}'::jsonb);\ncommit;\n")
menu_version_id = run(
    "select mv.id::text from work_capture_menus m join work_capture_menu_versions mv on mv.menu_id = m.id "
    "where m.code = 'cc_race_menu'")

cid_sel_a, cid_sel_b = new_uuid(), new_uuid()
select_stmt = lambda cid: f"select work_select_job_menu('{cid}','{LIVE_JOB}','{menu_version_id}',0);\n"
sel_holder = begin_async(f"set application_name='sel_a';\nbegin;\n{auth(OWNER)}{select_stmt(cid_sel_a)}", hold=True)
wait_gate('sel_a')
sel_waiter = begin_async(f"set application_name='sel_b';\nbegin;\n{auth(OWNER)}{select_stmt(cid_sel_b)}commit;\n")
wait_gate('sel_b', waiting=True, blocked_by='sel_a')
release(sel_holder)
finish(sel_holder)
finish_expect_error(sel_waiter, '23514')
selection_count = int(run(f"select count(*) from work_job_menu_selections where project_id = '{LIVE_JOB}'"))
assert selection_count == 1, f'exactly one job menu selection expected, found {selection_count}'
pinned_menu_version = run(
    f"select menu_version_id::text from work_job_menu_selections where project_id = '{LIVE_JOB}' and revision = 1")
assert pinned_menu_version == menu_version_id, 'the winning selection must pin the exact menu version id'
assert int(run(f"select count(*) from work_configuration_commands where command_id='{cid_sel_a}'")) == 1
assert int(run(f"select count(*) from work_configuration_commands where command_id='{cid_sel_b}'")) == 0
assert json.loads(run(f"select result->'frozenDefinitionVersionIds' from work_configuration_commands where command_id='{cid_sel_a}'")) == [version_id]
print('PASS case 5: concurrent job-menu selection serializes to one row, stale loser refuses 23514, ids pinned')
cases_passed += 1

# ---------------------------------------------------------------------------
# Case 6 (sequential, targeted -- no barrier needed): grant, revoke, and
# regrant the same capability to the same foreman; a delayed revoke command
# that still names the ORIGINAL (now-stale) grant id must refuse 23514, and
# the replacement grant must stay active.
# ---------------------------------------------------------------------------
grant_cmd_1 = new_uuid()
grant_1 = json.loads(run(
    f"begin;\n{auth(SUPERVISOR)}select work_grant_job_capability('{grant_cmd_1}','{LIVE_JOB}','{FOREMAN}','menu_select');\ncommit;\n"))
grant_id_1 = grant_1['grantId']
revoke_cmd_1 = new_uuid()
run(f"begin;\n{auth(SUPERVISOR)}select work_revoke_job_capability('{revoke_cmd_1}','{LIVE_JOB}','{FOREMAN}','menu_select','{grant_id_1}');\ncommit;\n")
grant_cmd_2 = new_uuid()
grant_2 = json.loads(run(
    f"begin;\n{auth(SUPERVISOR)}select work_grant_job_capability('{grant_cmd_2}','{LIVE_JOB}','{FOREMAN}','menu_select');\ncommit;\n"))
grant_id_2 = grant_2['grantId']
assert grant_id_2 != grant_id_1, 'the regrant must be a new row, not a resurrection of the revoked one'
delayed_revoke_cmd = new_uuid()
run(f"begin;\n{auth(SUPERVISOR)}select work_revoke_job_capability('{delayed_revoke_cmd}','{LIVE_JOB}','{FOREMAN}','menu_select','{grant_id_1}');\ncommit;\n",
    expect_error='23514')
replacement_active = run(f"select revoked_at is null from work_job_management_grants where id = '{grant_id_2}'")
assert replacement_active == 't', 'the replacement grant must remain active after the stale delayed revoke'
print('PASS case 6: delayed revoke naming the stale original grant id refuses 23514; replacement stays active')
cases_passed += 1

print(f'{cases_passed} checks passed: 5 concurrent categories and 1 sequential stale-grant regression on real disposable PostgreSQL; '
      'no global personal-timing or production-schema equivalence claimed.')
