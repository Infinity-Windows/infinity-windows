#!/usr/bin/env python3
"""Real independent-backend cutover-development tests, synthetic local database only.
The sequential verifier exports its actual current bootstrap and migration SQL;
this harness does not copy permission helpers or emulate the canonical writer.
Every race observes distinct server PIDs and pg_blocking_pids before release.
No production URI, profile, clock or source data is used. Separate release gates
remain required; the exported development subset does not prove the complete installed route graph.
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

URL = os.environ.get('WORK_ACTIVITY_CUTOVER_TEST_DB_URL', '')
try:
    parsed = urlparse(URL)
    parsed_port = parsed.port
except ValueError:
    raise SystemExit('Refused: invalid cutover fixture database URI')
if (parsed.scheme not in ('postgres', 'postgresql')
        or parsed.hostname not in ('localhost', '127.0.0.1')
        or parsed.path != '/forge_work_activity_cutover_test'
        or parsed.query or parsed.fragment or parsed_port not in (None, 5432)):
    # libpq accepts query host/dbname overrides: never pass those through.

    raise SystemExit(
        'Refused: WORK_ACTIVITY_CUTOVER_TEST_DB_URL must point at localhost/127.0.0.1 '
        'and the exact disposable database /forge_work_activity_cutover_test')

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
if connected_database != 'forge_work_activity_cutover_test':
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

# Export the actual executed development schema and actual transformed roots.
# This intentionally does not bypass the full installed schema guard or claim
# that the reduced fixture represents all 212 roots. Full-schema acceptance is
# a separate local disposable reconstruction, never operational production SQL.
import tempfile
import hashlib
from datetime import datetime, timezone
with tempfile.TemporaryDirectory(prefix='forge-cutover-schema-') as directory:
    schema_path = Path(directory) / 'schema.sql'
    exported = subprocess.run(['node', str(ROOT / 'scripts/verify-work-activity-engine-cutover.mjs'), '--development-prefix'],
        text=True, capture_output=True, timeout=120,
        env=dict(os.environ, WORK_ACTIVITY_CUTOVER_SCHEMA_OUT=str(schema_path)))
    assert exported.returncode == 0, 'Cutover schema export failed: ' + exported.stderr
    schema = schema_path.read_text()
    assert 'create function public.work_activity_command(' in schema
    assert 'create function public._work_activity_statement_begin()' in schema
    assert "select public.is_partner_user() into partner;" in schema
    for role in ('authenticated', 'anon', 'service_role'):
        schema = schema.replace('create role ' + role + ';',
            "do $$ begin if not exists(select 1 from pg_roles where rolname='" + role +
            "') then create role " + role + "; end if; end $$;")
    run(schema, timeout=120)
print('Cutover source SHA256', hashlib.sha256((ROOT/'supabase/migrations/20261108410000_work_activity_engine_cutover.sql').read_bytes()).hexdigest())
print('Executed development schema SHA256', hashlib.sha256(schema.encode()).hexdigest())


def js(value):
    return "'" + json.dumps(value, separators=(',', ':')).replace("'", "''") + "'::jsonb"


def one(sql):
    lines = run(sql).splitlines()
    assert len(lines) == 1, 'Expected one JSON record, received: ' + repr(lines)
    return json.loads(lines[0])


def client(uid):
    return auth(uid) + 'set role authenticated;\n'


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def holder(app, sql):
    proc = begin_async(f"set application_name='{app}';\nbegin;\n{sql}", hold=True)
    wait_ready(app)
    return proc


def waiter(app, sql, blocked_by):
    proc = begin_async(f"set application_name='{app}';\nbegin;\n{sql}commit;\n")
    wait_blocked(app, blocked_by)
    return proc


def clean_frames():
    names = ['work_activity_operations','work_activity_operation_people','work_activity_operation_events',
             'work_activity_statement_frames','work_activity_transaction_context','work_activity_expected_mutations']
    for name in names:
        assert run(f'select count(*) from public.{name}') == '0', 'Leaked frame: ' + name


job, owner = new_uuid(), new_uuid()
run(f"insert into profiles(id,role,is_test) values('{owner}','owner',false);"
    f"insert into projects(id,is_test) values('{job}',false);")
# Actual published configuration and selection, never a fake eligibility helper.
run(client(owner)+f"select work_publish_activity_version('{new_uuid()}','cutover_general',0,'general','General task','Tarea',false,'[]');")
definition = one("select jsonb_build_object('id',d.id,'version',v.id) from work_activity_definitions d join work_activity_definition_versions v on v.definition_id=d.id where d.code='cutover_general'")
items = [dict(definitionId=definition['id'], versionId=definition['version'], position=0, enabled=True)]
run(client(owner)+f"select work_publish_menu_version('{new_uuid()}','cutover_menu',0,'Menu','Menu',{js(items)});")
menu = run("select v.id from work_capture_menus m join work_capture_menu_versions v on v.menu_id=m.id where m.code='cutover_menu'")
run(client(owner)+f"select work_select_job_menu('{new_uuid()}','{job}','{menu}',0);")
selection = one(f"select jsonb_build_object('id',id,'revision',revision) from work_job_menu_selections where project_id='{job}' order by revision desc limit 1")
run("begin;select _work_activity_gate();update work_activity_authority_generation set capture_enabled=true,revision=revision+1;commit;")
run("insert into company_settings(id,paid_time_from_start_day_on) values(1,(clock_timestamp() at time zone 'America/Denver')::date);")


def seed(kind='custom'):
    actor, shift, source = new_uuid(), new_uuid(), new_uuid()
    run(f"insert into profiles(id,role,is_test) values('{actor}','installer',false);")
    run(auth(actor)+f"insert into toolbox_completions(profile_id,signed_at) values('{actor}',clock_timestamp());"
        f"insert into time_shifts(id,profile_id,project_id,clock_in_at,last_punch_at,status,break_seconds) values('{shift}','{actor}','{job}',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour','open',300);")
    if kind == 'custom':
        run(auth(actor)+f"insert into custom_work_sessions(id,profile_id,shift_id,project_id,kind,description,started_at,shift_status) values('{source}','{actor}','{shift}','{job}','idle','Synthetic current work',clock_timestamp()-interval '50 minutes','open');")
    elif kind == 'task':
        run(auth(actor)+f"insert into task_sessions(id,profile_id,project_id,started_at,state) values('{source}','{actor}','{job}',clock_timestamp()-interval '50 minutes','on_task');")
    return actor, shift, source


def evidence(actor):
    return one(f"select jsonb_build_object('shifts',(select jsonb_agg(to_jsonb(s) order by id) from time_shifts s where profile_id='{actor}'),"
        f"'tasks',(select jsonb_agg(to_jsonb(s) order by id) from task_sessions s where profile_id='{actor}'),"
        f"'custom',(select jsonb_agg(to_jsonb(s) order by id) from custom_work_sessions s where profile_id='{actor}'),"
        f"'state',(select to_jsonb(s)-'updated_at' from personal_activity_state s where profile_id='{actor}'),"
        f"'transitions',(select count(*) from personal_activity_transitions where profile_id='{actor}'),"
        f"'receipts',(select count(*) from personal_activity_commands where actor_id='{actor}'))")


def observe(actor, device):
    return one(client(actor)+f"select work_activity_snapshot('{device}');")


def command(cid, payload):
    return f"select work_activity_command('{cid}',1,{js(payload)});\n"


def establish(actor):
    device, generation, cid = new_uuid(), new_uuid(), new_uuid()
    observed = observe(actor, device)
    data = dict(deviceId=device, clientGeneration=generation, clientSequence=0, predecessorCommandId=None,
        expectedRevision=observed['state']['revision'], basis=dict(observationId=observed['observation']['id']),
        shiftRef=observed['observation']['shiftRef'], tappedAt=now_iso(), clockCheckedAt=None, clockSkewMs=None,
        intent=dict(kind='establish_stream',previousGeneration=None,previousHeadCommandId=None))
    result = one(client(actor)+command(cid,data))
    assert result['receipt']['status'] == 'noop', result
    return dict(data, clientSequence=1, predecessorCommandId=cid)


def receipt(cid):
    return one(f"select result from personal_activity_commands where command_id='{cid}'")


cases = 0
# A changed partner predicate must be read AFTER waiting for G. In particular,
# task_sessions has no timecard row guard which could accidentally mask stale
# outer-statement RLS. Both relations retain their exact installed RLS helper.
for table in ('task_sessions','time_shifts'):
    actor, shift, source = seed('task')
    before = evidence(actor)
    first = holder('partner_first',auth(owner)+f"select _work_activity_gate();update profiles set is_partner=true where id='{actor}';")
    update = (f"update task_sessions set ended_at=clock_timestamp() where id='{source}';" if table=='task_sessions'
              else f"update time_shifts set break_seconds=break_seconds+1 where id='{shift}';")
    second = waiter('direct_second',client(actor)+update,'partner_first')
    release(first); finish(first); finish_expect_error(second,'42501')
    assert evidence(actor) == before, table+' changed evidence after partner revocation'
    assert run(f"select is_partner::int from profiles where id='{actor}'") == '1'
    clean_frames(); cases += 1

# Reverse the actual order: an authorized direct write already holding G
# finishes first; the permission change waits and does not retroactively undo it.
for table in ('task_sessions','time_shifts'):
    actor, shift, source = seed('task')
    before = evidence(actor)
    update = (f"update task_sessions set ended_at=clock_timestamp() where id='{source}';" if table=='task_sessions'
              else f"update time_shifts set break_seconds=break_seconds+1 where id='{shift}';")
    first = holder('direct_first',client(actor)+update)
    second = waiter('partner_second',auth(owner)+f"update profiles set is_partner=true where id='{actor}';",'direct_first')
    release(first); finish(first); finish(second)
    after = evidence(actor)
    assert after['transitions'] == before['transitions']+1
    assert after['state']['revision'] == before['state']['revision']+1
    if table=='task_sessions':
        assert after['tasks'][0]['ended_at'] is not None and after['shifts']==before['shifts']
    else:
        assert after['shifts'][0]['break_seconds'] == 301
    assert run(f"select is_partner::int from profiles where id='{actor}'") == '1'
    clean_frames(); cases += 1

# Two current devices each hold a valid independent stream but the same global
# revision. Reverse which device's actual command wins, with a real G barrier.
for reverse in (False,True):
    actor, shift, source = seed()
    commands = [new_uuid(),new_uuid()]
    payloads = [dict(establish(actor),intent=dict(kind='stop')) for _ in range(2)]
    before = evidence(actor)
    i,j = (1,0) if reverse else (0,1)
    first = holder('device_first',client(actor)+command(commands[i],payloads[i]))
    second = waiter('device_second',client(actor)+command(commands[j],payloads[j]),'device_first')
    release(first); finish(first); finish(second)
    assert receipt(commands[i])['status']=='applied'
    assert receipt(commands[j])['status']=='conflict' and receipt(commands[j])['reasonCode']=='state_changed'
    after = evidence(actor)
    assert after['transitions']==before['transitions']+1 and after['shifts']==before['shifts']
    assert after['custom'][0]['ended_at'] is not None
    clean_frames(); cases += 1

# Lost-response resend uses the SAME immutable identity, not another start.
actor,shift,source=seed(); data=dict(establish(actor),intent=dict(kind='stop')); cid=new_uuid();before=evidence(actor)
first=holder('replay_first',client(actor)+command(cid,data))
second=waiter('replay_second',client(actor)+command(cid,data),'replay_first')
release(first);first_value=json.loads(finish(first));second_value=json.loads(finish(second))
assert first_value==second_value and first_value['receipt']['status']=='applied'
assert evidence(actor)['transitions']==before['transitions']+1
clean_frames();cases+=1

# Actual old keyed break competes with new work under the same first gate.
for break_first in (False,True):
    actor,shift,source=seed(); data=establish(actor); cid,break_id=new_uuid(),new_uuid()
    data['intent']=dict(kind='switch',projectId=job,selectionId=selection['id'],selectionRevision=selection['revision'],
        menuVersionId=menu,definitionVersionId=definition['version'],scope='general',unit=None,machineKind=None,values={})
    old_break=f"select start_break('{shift}'::uuid,'rest'::text,'{break_id}'::uuid,null::timestamptz,null::timestamptz,null::integer);"
    first_sql,second_sql=(old_break,command(cid,data)) if break_first else (command(cid,data),old_break)
    before=evidence(actor)
    first=holder('break_switch_first',client(actor)+first_sql)
    second=waiter('break_switch_second',client(actor)+second_sql,'break_switch_first')
    release(first);finish(first);finish(second)
    result=receipt(cid)
    assert result['status']==('conflict' if break_first else 'applied'),result
    after=evidence(actor)
    assert after['shifts'][0]['break_started_at'] is not None and after['shifts'][0]['break_seconds']==300
    assert all(s['ended_at'] is not None for s in after['custom'])
    assert after['transitions']==before['transitions']+(1 if break_first else 2)
    assert run(f"select outcome from time_clock_actions where client_id='{break_id}'")=='started'
    run(client(actor)+old_break)
    assert evidence(actor)==after, 'Original payroll replay changed the already accepted state'
    clean_frames();cases+=1

# The observation expires while waiting, not merely before the request begins.
actor,shift,source=seed();data=establish(actor);cid,short_id=new_uuid(),new_uuid()
fresh=observe(actor,data['deviceId'])
run(f"insert into work_activity_observations select (jsonb_populate_record(null::work_activity_observations,to_jsonb(o)||jsonb_build_object('id','{short_id}'::uuid,'issued_at',clock_timestamp()-interval '15 hours','expires_at',clock_timestamp()+interval '3 seconds'))).* from work_activity_observations o where id='{fresh['observation']['id']}';")
data['basis']=dict(observationId=short_id)
data['intent']=dict(kind='switch',projectId=job,selectionId=selection['id'],selectionRevision=selection['revision'],menuVersionId=menu,definitionVersionId=definition['version'],scope='general',unit=None,machineKind=None,values={})
before=evidence(actor)
first=holder('expiry_first',auth(owner)+'select _work_activity_gate();')
second=waiter('expiry_second',client(actor)+command(cid,data),'expiry_first')
deadline=time.monotonic()+6
while run(f"select (clock_timestamp()>expires_at)::int from work_activity_observations where id='{short_id}'")!='1':
    assert time.monotonic()<deadline,'lease did not expire'
    time.sleep(.03)
release(first);finish(first);finish(second)
assert receipt(cid)['status']=='refused' and receipt(cid)['reasonCode']=='observation_expired'
after=evidence(actor)
assert after['shifts']==before['shifts'] and after['custom']==before['custom'] and after['transitions']==before['transitions']
clean_frames();cases+=1

# Private factories stay unavailable to the real client role; rejected contexts
# never leave reusable transaction rows or receipts behind.
run(client(actor)+"select _work_activity_operation_enter('forged');",expect_error='42501')
run(client(actor)+"select * from work_activity_operations;",expect_error='42501')
clean_frames();cases+=1
print(f'PASS {cases} cutover development backend/transaction scenarios; blocking PIDs observed for 10 races. No full installed-route, activation, load-latency or production-data claim.')
