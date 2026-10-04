#!/usr/bin/env python3
"""Real independent-backend unit-observation tests, synthetic local database only.
The sequential verifier exports its actual current bootstrap and migration SQL;
this harness does not copy permission helpers or emulate the canonical writer.
Every race observes distinct server PIDs and pg_blocking_pids before release.
No production URI, profile, clock or source data is used. Separate release gates
remain required; these tests do not prove an active global activity engine.
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

URL = os.environ.get('WORK_UNIT_OBSERVATION_TEST_DB_URL', '')
try:
    parsed = urlparse(URL)
    parsed_port = parsed.port
except ValueError:
    raise SystemExit('Refused: invalid unit fixture database URI')
if (parsed.scheme not in ('postgres', 'postgresql')
        or parsed.hostname not in ('localhost', '127.0.0.1')
        or parsed.path != '/forge_work_unit_observations_test'
        or parsed.query or parsed.fragment or parsed_port not in (None, 5432)):
    # libpq accepts query host/dbname overrides: never pass those through.

    raise SystemExit(
        'Refused: WORK_UNIT_OBSERVATION_TEST_DB_URL must point at localhost/127.0.0.1 '
        'and the exact disposable database /forge_work_unit_observations_test')

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


def wait_blocked(app, blocked_by):
    """Observe two different backend PIDs and their actual blocking edge.
    Never assume a sleep or pre-existing row proves the absent-row path."""
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        for name in (app, blocked_by):
            proc = next(p for p in reversed(processes) if p.fixture_app == name)
            assert proc.poll() is None, f'{name} exited before the expected wait'
        found = run(
            "select count(*) from pg_stat_activity w, pg_stat_activity h "
            f"where w.application_name='{app}' and h.application_name='{blocked_by}' "
            "and w.datname=current_database() and h.datname=current_database() "
            "and h.pid<>w.pid and h.pid=any(pg_blocking_pids(w.pid))", timeout=3)
        if int(found) == 1:
            return
        time.sleep(.02)
    raise AssertionError(f'{app} did not actually wait on {blocked_by}')


def wait_ready(app):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        proc = next(p for p in reversed(processes) if p.fixture_app == app)
        assert proc.poll() is None, f'{app} exited before holding its transaction'
        found = run(
            "select count(*) from pg_stat_activity "
            f"where application_name='{app}' and datname=current_database() "
            "and state='idle in transaction'", timeout=3)
        if int(found) == 1:
            return
        time.sleep(.02)
    raise AssertionError(f'{app} did not hold the transaction')


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
if connected_database != 'forge_work_unit_observations_test':
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


# Export the sequential verifier's actual schema, without its test records.
# PGlite remains the same pinned CI dependency; the Postgres execution below
# is independent of PGlite. Cluster roles alone are made idempotent.
import tempfile
import hashlib
with tempfile.TemporaryDirectory(prefix='forge-unit-schema-') as directory:
    schema_path = Path(directory) / 'schema.sql'
    export_env = dict(os.environ, WORK_UNIT_SCHEMA_OUT=str(schema_path))
    export = subprocess.run(['node', str(ROOT / 'scripts/verify-work-unit-observations.mjs')],
                            text=True, capture_output=True, timeout=120, env=export_env)
    assert export.returncode == 0, 'Unit fixture schema export failed: ' + export.stderr
    assert schema_path.is_file(), 'Unit verifier did not export the actual bootstrap'
    schema = schema_path.read_text()
    assert 'create or replace function public.custom_work_command' in schema
    assert 'work_unit_fact_revisions' in schema
    for role in ('authenticated', 'anon', 'service_role'):
        schema = schema.replace('create role ' + role + ';',
            "do $$ begin if not exists(select 1 from pg_roles where rolname='" + role +
            "') then create role " + role + "; end if; end $$;")
    run('set check_function_bodies=off;\n' + schema, timeout=120)

migration = ROOT / 'supabase/migrations/20261108100000_work_unit_observations.sql'
print('Actual unit migration SHA256', hashlib.sha256(migration.read_bytes()).hexdigest())
OWNER_A, OWNER_B, FOREMAN = new_uuid(), new_uuid(), new_uuid()
JOB_A, JOB_B, JOB_C = new_uuid(), new_uuid(), new_uuid()
run(f"insert into profiles(id,role) values('{OWNER_A}','owner'),('{OWNER_B}','owner'),('{FOREMAN}','foreman');"
    f"insert into projects(id) values('{JOB_A}'),('{JOB_B}'),('{JOB_C}');")


def json_sql(value):
    return "'" + json.dumps(value, separators=(',', ':')).replace("'", "''") + "'::jsonb"


def unit_data(unit, revision=0, width=12, project=JOB_A, fact_revision=0):
    return dict(id=unit, revision=revision, project_id=project, label='Synthetic race unit', facts={},
                dimension_observation=dict(width=width, height=24, unit='in', source='measured'),
                expected_fact_revision=fact_revision)


def command(cid, action, data):
    return f"select custom_work_command('{cid}','{action}',{json_sql(data)});\n"


def holder(app, actor, sql):
    p = begin_async(f"set application_name='{app}';\nbegin;\n{auth(actor)}{sql}", hold=True)
    wait_ready(app)
    return p


def waiter(app, actor, sql, blocked_by):
    p = begin_async(f"set application_name='{app}';\nbegin;\n{auth(actor)}{sql}commit;\n")
    wait_blocked(app, blocked_by)
    return p


def assert_receipts(winner, loser):
    assert int(run(f"select count(*) from custom_work_commands where id='{winner}'")) == 1
    assert int(run(f"select count(*) from custom_work_commands where id='{loser}'")) == 0
    assert int(run(f"select count(*) from custom_work_history where entity_id=(select result_id from custom_work_commands where id='{winner}')")) >= 1


cases = 0
# Truly absent unit: first row remains uncommitted, second SELECT cannot see
# it and proceeds to INSERT, which must wait and then refuse rather than UPSERT.
for index, (actor_a, actor_b) in enumerate([(OWNER_A, OWNER_B), (OWNER_B, OWNER_A)]):
    unit, cid_a, cid_b = new_uuid(), new_uuid(), new_uuid()
    first = holder('create_first', actor_a, command(cid_a, 'unit', unit_data(unit, width=12)))
    second = waiter('create_second', actor_b, command(cid_b, 'unit', unit_data(unit, width=99)), 'create_first')
    release(first); finish(first); finish_expect_error(second, 'P0001')
    assert_receipts(cid_a, cid_b)
    assert run(f"select facts->>'width_in' from custom_work_units where id='{unit}'") == '12'
    assert int(run(f"select count(*) from work_unit_fact_revisions where unit_id='{unit}'")) == 1
    assert run(f"select command_id::text from work_unit_fact_revisions where unit_id='{unit}'") == cid_a
    cases += 1
print('PASS true absent-row creates: both actor orders, one immutable fact/receipt, no losing overwrite')

# True create/delete ABA while the second absent-row INSERT waits. The
# private fact survives privileged source deletion; the second insertion must
# refuse reconciliation instead of appending under an assumed fact revision 0.
unit, cid_a, cid_b = new_uuid(), new_uuid(), new_uuid()
first = holder('incarnation_first', OWNER_A, command(cid_a, 'unit', unit_data(unit)))
second = waiter('incarnation_second', OWNER_B, command(cid_b, 'unit', unit_data(unit, width=99)), 'incarnation_first')
first.stdin.write(f"reset role; delete from custom_work_units where id='{unit}';\n")
first.stdin.flush()
release(first); finish(first); finish_expect_error(second, '23514')
assert_receipts(cid_a, cid_b)
assert int(run(f"select count(*) from custom_work_units where id='{unit}'")) == 0
assert int(run(f"select count(*) from work_unit_fact_revisions where unit_id='{unit}'")) == 1
assert int(run(f"select count(*) from work_unit_fact_current where unit_id='{unit}'")) == 1
cases += 1
print('PASS create/delete ABA during absent INSERT wait: original evidence retained, new incarnation refused')

# Existing row: second command waits on the canonical row then sees the winner's
# incremented operational revision. Its stale unit and fact basis cannot apply.
for actor_a, actor_b in [(OWNER_A, OWNER_B), (OWNER_B, OWNER_A)]:
    unit = new_uuid()
    run(auth(actor_a) + command(new_uuid(), 'unit', unit_data(unit)))
    cid_a, cid_b = new_uuid(), new_uuid()
    first = holder('edit_first', actor_a, command(cid_a, 'unit', unit_data(unit, 1, 13, fact_revision=1)))
    second = waiter('edit_second', actor_b, command(cid_b, 'unit', unit_data(unit, 1, 99, fact_revision=1)), 'edit_first')
    release(first); finish(first); finish_expect_error(second, 'P0001')
    assert_receipts(cid_a, cid_b)
    assert run(f"select facts->>'width_in' from custom_work_units where id='{unit}'") == '13'
    assert int(run(f"select count(*) from work_unit_fact_revisions where unit_id='{unit}'")) == 2
    cases += 1
print('PASS competing edits: both actor orders, postwait CAS and no losing fact/history/receipt')

# Competing relinks must preserve the observation origin and have exactly one
# new binding revision; the other destination cannot inherit the stale request.
for destination_a, destination_b in [(JOB_B, JOB_C), (JOB_C, JOB_B)]:
    unit = new_uuid()
    run(auth(OWNER_A) + command(new_uuid(), 'unit', unit_data(unit)))
    shift, session = new_uuid(), new_uuid()
    run(f"insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status,break_seconds) values('{shift}','{OWNER_A}','{JOB_A}','2026-09-18T07:00Z','2026-09-18T15:00Z','submitted',1800);"
        f"insert into custom_work_sessions(id,profile_id,shift_id,project_id,unit_id,kind,started_at,ended_at,end_reason,shift_status) values('{session}','{OWNER_A}','{shift}','{JOB_A}','{unit}','unit','2026-09-18T08:00Z','2026-09-18T09:00Z','stop','submitted');")
    shift_before = run(f"select row_to_json(t)::text from time_shifts t where id='{shift}'")
    row = json.loads(run(f"select facts::text from custom_work_units where id='{unit}'"))
    cid_a, cid_b = new_uuid(), new_uuid()
    data = dict(id=unit, revision=1, project_id=destination_a, label='Relink fixture', facts=row, reason='Synthetic move')
    other = dict(data, project_id=destination_b)
    first = holder('link_first', OWNER_A, command(cid_a, 'link', data))
    second = waiter('link_second', OWNER_B, command(cid_b, 'link', other), 'link_first')
    release(first); finish(first); finish_expect_error(second, 'P0001')
    assert_receipts(cid_a, cid_b)
    assert run(f"select project_id::text from custom_work_units where id='{unit}'") == destination_a
    assert run(f"select project_id::text from custom_work_sessions where id='{session}'") == destination_a
    assert run(f"select review_required::text||':'||revision::text from custom_work_sessions where id='{session}'") == 'true:2'
    assert run(f"select row_to_json(t)::text from time_shifts t where id='{shift}'") == shift_before

    assert run(f"select origin_project_id::text from work_unit_fact_revisions where unit_id='{unit}' order by revision desc limit 1") == JOB_A
    assert int(run(f"select count(*) from work_unit_fact_revisions where unit_id='{unit}'")) == 2
    cases += 1
print('PASS competing relinks: both destination orders, one binding change, original source retained')

# System holds only the operational row. A real command enters as active,
# waits, then must see independently committed account revocation.
unit = new_uuid()
run(auth(OWNER_A) + command(new_uuid(), 'unit', unit_data(unit)))
lock = begin_async(f"set application_name='actor_lock'; begin; select id from custom_work_units where id='{unit}' for update;", hold=True)
wait_ready('actor_lock')
cid = new_uuid()
request = waiter('actor_waiter', OWNER_B, command(cid, 'unit', unit_data(unit, 1, 15, fact_revision=1)), 'actor_lock')
run(f"update profiles set access_revoked_at=clock_timestamp() where id='{OWNER_B}';")
release(lock); finish(lock); finish_expect_error(request, '42501')
assert int(run(f"select count(*) from custom_work_commands where id='{cid}'")) == 0
assert int(run(f"select count(*) from work_unit_fact_revisions where unit_id='{unit}'")) == 1
run(f"update profiles set access_revoked_at=null where id='{OWNER_B}';")
cases += 1
print('PASS account revocation committed during unit-row wait: fresh authority, no partial save')

# Exact-job administrative grant is checked after the same row wait; neither
# role alone nor a now-revoked grant can substitute for it.
unit = new_uuid()
run(auth(OWNER_A) + command(new_uuid(), 'unit', unit_data(unit)))
grant = new_uuid()
run(f"insert into work_job_management_grants(id,project_id,profile_id,capability,granted_by) values('{grant}','{JOB_A}','{FOREMAN}','dimensions_edit','{OWNER_A}');")
lock = begin_async(f"set application_name='grant_lock'; begin; select id from custom_work_units where id='{unit}' for update;", hold=True)
wait_ready('grant_lock')
cid = new_uuid()
request = waiter('grant_waiter', FOREMAN, command(cid, 'unit', unit_data(unit, 1, 15, fact_revision=1)), 'grant_lock')
run(f"update work_job_management_grants set revoked_at=clock_timestamp(),revoked_by='{OWNER_A}' where id='{grant}';")
release(lock); finish(lock); finish_expect_error(request, '42501')
assert int(run(f"select count(*) from custom_work_commands where id='{cid}'")) == 0
assert int(run(f"select count(*) from work_unit_fact_revisions where unit_id='{unit}'")) == 1
cases += 1
print('PASS exact-job dimensions grant revoked during unit-row wait: no partial save')

# Mapped source is independently removed while a command waits on the unit.
# The canonical map check must see the fresh removed_at and abort all evidence.
unit, opening, cid = new_uuid(), new_uuid(), new_uuid()
run(f"insert into project_openings(id,project_id,opening_code) values('{opening}','{JOB_A}','Synthetic map');")
initial = dict(unit_data(unit), opening_id=opening)
run(auth(OWNER_A) + command(new_uuid(), 'unit', initial))
lock = begin_async(f"set application_name='map_lock'; begin; select id from custom_work_units where id='{unit}' for update;", hold=True)
wait_ready('map_lock')
request = waiter('map_waiter', OWNER_B, command(cid, 'unit', dict(unit_data(unit, 1, 15, fact_revision=1), opening_id=opening)), 'map_lock')
run(f"update project_openings set removed_at=clock_timestamp() where id='{opening}';")
release(lock); finish(lock); finish_expect_error(request, '42501')
assert int(run(f"select count(*) from custom_work_commands where id='{cid}'")) == 0
assert int(run(f"select count(*) from work_unit_fact_revisions where unit_id='{unit}'")) == 1
cases += 1
print('PASS mapped source removal committed during unit-row wait: no partial observation or receipt')

print(f'PASS {cases} actual independent-backend scenarios; no production/active-engine/QC verification claim')
