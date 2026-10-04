#!/usr/bin/env python3
"""Real independent-backend activity-substrate tests, synthetic local database only.
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
import select
import subprocess
import time
import uuid as uuidlib
from pathlib import Path
from urllib.parse import urlparse

URL = os.environ.get('WORK_ACTIVITY_ENGINE_TEST_DB_URL', '')
try:
    parsed = urlparse(URL)
    parsed_port = parsed.port
except ValueError:
    raise SystemExit('Refused: invalid activity fixture database URI')
if (parsed.scheme not in ('postgres', 'postgresql')
        or parsed.hostname not in ('localhost', '127.0.0.1')
        or parsed.path != '/forge_work_activity_engine_test'
        or parsed.query or parsed.fragment or parsed_port not in (None, 5432)):
    # libpq accepts query host/dbname overrides: never pass those through.

    raise SystemExit(
        'Refused: WORK_ACTIVITY_ENGINE_TEST_DB_URL must point at localhost/127.0.0.1 '
        'and the exact disposable database /forge_work_activity_engine_test')

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
    return f"set request.jwt.claim.sub='{uid}';\n"


# ---------------------------------------------------------------------------
# Freshness refusal -- CI must hand this a genuinely empty database. This
# script leaves fixture objects for the CI-owned disposable database and does not drop/recreate
# the database itself.
# ---------------------------------------------------------------------------
connected_database = run('select current_database()')
if connected_database != 'forge_work_activity_engine_test':
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

# Export exactly the sequential verifier's executed schema, before fixtures.
import tempfile
import hashlib
with tempfile.TemporaryDirectory(prefix='forge-activity-schema-') as directory:
    schema_path = Path(directory) / 'schema.sql'
    exported = subprocess.run(['node', str(ROOT / 'scripts/verify-work-activity-engine-substrate.mjs')],
        text=True, capture_output=True, timeout=120,
        env=dict(os.environ, WORK_ACTIVITY_SCHEMA_OUT=str(schema_path)))
    assert exported.returncode == 0, 'Activity schema export failed: ' + exported.stderr
    schema = schema_path.read_text()
    assert 'create function public._work_activity_establish_stream' in schema
    for role in ('authenticated', 'anon', 'service_role'):
        schema = schema.replace('create role ' + role + ';',
            "do $$ begin if not exists(select 1 from pg_roles where rolname='" + role +
            "') then create role " + role + "; end if; end $$;")
    run(schema, timeout=120)
print('Actual substrate SHA256', hashlib.sha256((ROOT/'supabase/migrations/20261108400000_work_activity_engine_substrate.sql').read_bytes()).hexdigest())

def json_sql(value):
    return "'" + json.dumps(value, separators=(',', ':')).replace("'", "''") + "'::jsonb"

def one(sql):
    return json.loads(run(sql))

def seed():
    actor, device = new_uuid(), new_uuid()
    run(f"insert into profiles(id,role) values('{actor}','installer');")
    return actor, device

def observe(actor, device):
    return one(auth(actor)+f"select to_jsonb(_work_activity_observe('{device}'))")

def payload(obs, generation):
    return dict(deviceId=obs['device_id'],clientGeneration=generation,clientSequence=0,
        predecessorCommandId=None,expectedRevision=obs['revision'],basis=dict(observationId=obs['id']),
        shiftRef=dict(kind='shift',id=obs['shift_id']) if obs['shift_id'] else None,
        tappedAt='2026-10-04T00:00:00Z',clockCheckedAt=None,clockSkewMs=None,
        intent=dict(kind='establish_stream',previousGeneration=obs['current_generation'],previousHeadCommandId=obs['current_head_command_id']))

def establish(cid, data):
    return f"select _work_activity_establish_stream('{cid}',{json_sql(data)});\n"

def holder(app, actor, sql):
    proc=begin_async(f"set application_name='{app}';\nbegin;\n{auth(actor)}{sql}",hold=True)
    wait_ready(app)
    return proc

def waiter(app, actor, sql, blocked_by):
    proc=begin_async(f"set application_name='{app}';\nbegin;\n{auth(actor)}{sql}commit;\n")
    wait_blocked(app,blocked_by)
    return proc

def receipt(cid):
    return one(f"select result from personal_activity_commands where command_id='{cid}'")

def current(actor, device):
    return run(f"select client_generation from work_activity_streams where actor_id='{actor}' and device_id='{device}' and status in ('active','blocked')")

def retained_counts(actor):
    return run(f"select jsonb_build_object('commands',(select count(*) from personal_activity_commands where actor_id='{actor}'),'streams',(select count(*) from work_activity_streams where actor_id='{actor}'),'transitions',(select count(*) from personal_activity_transitions where profile_id='{actor}'))")

# Nonempty unrelated payroll is an invariant, not a new payable clock.
baseline_actor, _ = seed()
baseline_shift, baseline_session = new_uuid(), new_uuid()
run(f"insert into time_shifts(id,profile_id,clock_in_at,clock_out_at,status,break_seconds) values('{baseline_shift}','{baseline_actor}','2026-10-03 12:00Z','2026-10-03 20:00Z','approved',1800);"
    f"insert into custom_work_sessions(id,profile_id,shift_id,kind,description,started_at,ended_at,shift_status) values('{baseline_session}','{baseline_actor}','{baseline_shift}','idle','Unchanged synthetic evidence','2026-10-03 12:15Z','2026-10-03 13:00Z','approved');")
baseline=run(f"select jsonb_build_object('shift',(select to_jsonb(s) from time_shifts s where id='{baseline_shift}'),'session',(select to_jsonb(s) from custom_work_sessions s where id='{baseline_session}'))")
cases=0

# Same observation, different generations: reverse which generation holds G.
for reverse in (False,True):
    actor,device=seed();obs=observe(actor,device)
    ids=[new_uuid(),new_uuid()];generations=[new_uuid(),new_uuid()]
    first_index,second_index=(1,0) if reverse else (0,1)
    first=holder('establish_first',actor,establish(ids[first_index],payload(obs,generations[first_index])))
    second=waiter('establish_second',actor,establish(ids[second_index],payload(obs,generations[second_index])),'establish_first')
    release(first);finish(first);finish(second)
    assert receipt(ids[first_index])['status']=='noop'
    assert receipt(ids[second_index])['status']=='conflict'
    assert receipt(ids[second_index])['reasonCode']=='stream_changed'
    assert current(actor,device)==generations[first_index]
    assert json.loads(retained_counts(actor))==dict(commands=2,streams=1,transitions=0)
    cases+=1

# Exact duplicate receipt under contention; changed payload cannot replace it.
for changed in (False,True):
    actor,device=seed();obs=observe(actor,device);cid,generation=new_uuid(),new_uuid();data=payload(obs,generation)
    first=holder('duplicate_first',actor,establish(cid,data))
    second_data={**data,'tappedAt':'2026-10-04T00:01:00Z'} if changed else data
    second=waiter('duplicate_second',actor,establish(cid,second_data),'duplicate_first')
    release(first);a=finish(first)
    if changed:finish_expect_error(second,'23514')
    else:assert a.splitlines()[-1]==finish(second).splitlines()[-1]
    assert json.loads(retained_counts(actor))==dict(commands=1,streams=1,transitions=0)
    assert current(actor,device)==generation
    cases+=1

# Fresh rotation contenders see one retained old generation and one winner.
for reverse in (False,True):
    actor,device=seed();obs=observe(actor,device);old=new_uuid()
    run(auth(actor)+establish(new_uuid(),payload(obs,old)))
    obs=observe(actor,device);ids=[new_uuid(),new_uuid()];generations=[new_uuid(),new_uuid()]
    i,j=(1,0) if reverse else (0,1)
    first=holder('rotate_first',actor,establish(ids[i],payload(obs,generations[i])))
    second=waiter('rotate_second',actor,establish(ids[j],payload(obs,generations[j])),'rotate_first')
    release(first);finish(first);finish(second)
    assert receipt(ids[i])['status']=='noop' and receipt(ids[j])['status']=='conflict'
    assert current(actor,device)==generations[i]
    assert run(f"select status from work_activity_streams where actor_id='{actor}' and client_generation='{old}'")=='retired'
    assert json.loads(retained_counts(actor))==dict(commands=3,streams=2,transitions=0)
    cases+=1

# A waiter statement begins before revocation but checks the actor after G.
actor,device=seed();obs=observe(actor,device);cid=new_uuid()
first=holder('revoke_first',actor,f"select _work_activity_gate();update profiles set access_revoked_at=clock_timestamp() where id='{actor}';")
second=waiter('revoke_second',actor,establish(cid,payload(obs,new_uuid())),'revoke_first')
release(first);finish(first);finish_expect_error(second,'42501')
assert json.loads(retained_counts(actor))==dict(commands=0,streams=0,transitions=0)
cases+=1

# Simulated external revision under G (not an installed lifecycle callback).
actor,device=seed();obs=observe(actor,device);cid=new_uuid()
first=holder('revision_first',actor,f"select _work_activity_gate();update personal_activity_state set revision=1 where profile_id='{actor}';")
second=waiter('revision_second',actor,establish(cid,payload(obs,new_uuid())),'revision_first')
release(first);finish(first);finish(second)
assert receipt(cid)['status']=='conflict' and receipt(cid)['reasonCode']=='state_changed'
assert current(actor,device)=='' and json.loads(retained_counts(actor))==dict(commands=1,streams=0,transitions=0)
cases+=1

# Construct a legal short lease once, then let it expire during an observed wait.
actor,device=seed();obs=observe(actor,device);short=new_uuid();cid=new_uuid()
run(f"insert into work_activity_observations(id,actor_id,device_id,revision,issued_at,expires_at) values('{short}','{actor}','{device}',0,clock_timestamp()-interval '15 hours',clock_timestamp()+interval '3 seconds');")
obs={**obs,'id':short}
first=holder('expiry_first',actor,'select _work_activity_gate();')
second=waiter('expiry_second',actor,establish(cid,payload(obs,new_uuid())),'expiry_first')
deadline=time.monotonic()+6
while run(f"select (clock_timestamp()>expires_at)::int from work_activity_observations where id='{short}'")!='1':
    assert time.monotonic()<deadline,'short lease failed to expire'
    time.sleep(.03)
release(first);finish(first);finish(second)
assert receipt(cid)['status']=='refused' and receipt(cid)['reasonCode']=='observation_expired'
assert current(actor,device)==''
cases+=1

# Unfinished frames cannot commit. Same transaction savepoint rollback cleans up.
actor,device=seed()
run(auth(actor)+"begin;select _work_activity_context_open('fixture','stop',clock_timestamp());commit;",expect_error='23514')
assert run('select count(*) from work_activity_transaction_context')=='0'
run(auth(actor)+"begin;select _work_activity_gate();savepoint child;select _work_activity_context_open('fixture','stop',clock_timestamp());rollback to child;commit;")
assert run('select count(*) from work_activity_transaction_context')=='0'
cases+=1

# Capture the actual holder's frame UUID from psql, rather than guessing one.
# It cannot authorize another backend while uncommitted, or after the holder
# rolls it back. The second attempt explicitly acquires G; context_assert itself
# checks identity and does not acquire the gate.
actor,device=seed()
first=holder('frame_first',actor,"select _work_activity_context_open('fixture','stop',clock_timestamp());")
assert select.select([first.stdout],[],[],3)[0], 'holder did not emit its actual frame ID'
frame_id=first.stdout.readline().strip()
assert str(uuidlib.UUID(frame_id))==frame_id, 'holder did not return a frame UUID'
run(auth(actor)+f"select _work_activity_context_assert('{frame_id}');",expect_error='42501')
second=waiter('frame_second',actor,f"select _work_activity_gate();select _work_activity_context_assert('{frame_id}');",'frame_first')
first.stdin.write('rollback;\n');first.stdin.close();finish(first);finish_expect_error(second,'42501')
assert run('select count(*) from work_activity_transaction_context')=='0'
cases+=1

# Real-role denial and unsupported isolation never create private evidence.
actor,device=seed();before=retained_counts(actor)
run(auth(actor)+f"set role authenticated;select _work_activity_observe('{device}');",expect_error='42501')
run(auth(actor)+"begin isolation level repeatable read;select _work_activity_gate();",expect_error='25000')
assert retained_counts(actor)==before
cases+=1
assert run('select count(*) from work_activity_transaction_context')=='0'
assert run('select count(*) from work_activity_expected_mutations')=='0'
assert run(f"select jsonb_build_object('shift',(select to_jsonb(s) from time_shifts s where id='{baseline_shift}'),'session',(select to_jsonb(s) from custom_work_sessions s where id='{baseline_session}'))")==baseline
print(f'Activity inactive substrate: {cases} independent-backend/transaction scenarios passed; actual blocking PIDs observed. No public capture, legacy cutover or load-latency claim.')

