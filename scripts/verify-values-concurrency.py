#!/usr/bin/env python3
"""Exercise real PostgreSQL sessions, never the production database.

CI owns a disposable localhost database named forge_values_test. The test
uses actual migration functions. A fixture-only cutoff replacement accelerates
waiting across the deadline; date/timezone policy is tested separately by the
SQL verifier and real-schema rollback probe. No third-party Python modules.
"""
import atexit
from datetime import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlparse

URL = os.environ.get('VALUES_TEST_DB_URL', '')
parsed = urlparse(URL)
if parsed.hostname not in ('localhost', '127.0.0.1') or parsed.path != '/forge_values_test':
    raise SystemExit('Refused: use only disposable localhost/forge_values_test')
ROOT = Path(__file__).resolve().parent.parent
PSQL = ['psql', URL, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1']

def run(sql):
    result = subprocess.run(PSQL, input=sql, text=True, capture_output=True, timeout=20)
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
                            stderr=subprocess.PIPE, text=True)
    processes.append(proc)
    proc.stdin.write(sql + '\n')
    proc.stdin.flush()
    if not hold:
        proc.stdin.close()
    return proc

def release(proc):
    proc.stdin.write('commit;\n')
    proc.stdin.close()

def wait_cutoff():
    deadline = time.monotonic() + 10
    while run('select (clock_timestamp() >= at)::int from fixture_cutoff') != '1':
        assert time.monotonic() < deadline, 'fixture cutoff did not arrive'
        time.sleep(.03)

def finish(proc):
    proc.wait(timeout=15)
    output = proc.stdout.read().strip()
    error = proc.stderr.read()
    assert proc.returncode == 0, error
    return output

def wait_lock(app, waiting=False, blocked_by=None):
    for _ in range(80):
        result = run("select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid "
                     f"where a.application_name='{app}' and l.locktype='advisory' "
                     f"and l.granted={'false' if waiting else 'true'} "
                     "and l.objsubid=1 "
                     "and l.classid::bigint=((hashtextextended('values_period:2026-10-01',0)>>32)&4294967295) "
                     "and l.objid::bigint=(hashtextextended('values_period:2026-10-01',0)&4294967295)")
        if int(result) > 0:
            if blocked_by:
                relation = run(f"select count(*) from pg_stat_activity w, pg_stat_activity h where w.application_name='{app}' and h.application_name='{blocked_by}' and h.pid=any(pg_blocking_pids(w.pid))")
                if int(relation) == 0:
                    time.sleep(.025)
                    continue
            return
        time.sleep(.025)
    raise AssertionError(f'{app} did not reach expected advisory lock state')

# Reuse the explicitly synthetic verifier schema so schema drift cannot hide
# behind a second hand-built policy engine. This extracts SQL, never executes JS.
source = (ROOT / 'scripts/verify-values-reviews.mjs').read_text()
match = re.search(r'await db\.exec\(`([\s\S]*?)`\);', source)
assert match, 'SQL verifier fixture missing'
run(match.group(1))
migration = (ROOT / 'supabase/migrations/20261106000000_monthly_values_reviews.sql').read_text()
migration = re.sub(r'do \$\$\nbegin\n {2}if not exists \(select 1 from cron\.job[\s\S]*?\nend \$\$;\n', '', migration)
assert 'cron.schedule' not in migration, 'cron block not stripped'
run('set check_function_bodies=off;\n' + migration)

RATER = '11111111-1111-4111-8111-111111111111'
SUBJECT = '22222222-2222-4222-8222-222222222222'
run(f"insert into profiles(id,role,display_name) values('{RATER}','installer','Fixture rater'),"
    f"('{SUBJECT}','installer','Fixture subject'); select _values_ensure_period('2026-10-01');")
RUBRIC = int(run("select rubric_version from values_periods where period_start='2026-10-01'"))
SCORES = json.dumps([{'slug': slug, 'score': 7} for slug in
                    ['fullsend','growth','integrity','ownership','safety','sincerity','strategic','tribe']])

def assignment(request):
    return run(f"insert into values_assignments(period_start,rater_id,subject_id,reason) "
               f"values('2026-10-01','{RATER}','{SUBJECT}','dealt') returning id")

def submission(aid, request, with_start=False):
    call = f"values_submit('{aid}','{request}',{RUBRIC},'{SCORES}'::jsonb,null)"
    if with_start:
        call = "json_build_object('startedAt',transaction_timestamp(),'response'," + call + ")"
    return (f"set request.jwt.claim.sub='{RATER}'; set role authenticated; "
            f"select {call};")

def cutoff(seconds):
    run('create table if not exists fixture_cutoff(at timestamptz); truncate fixture_cutoff; '
        f"insert into fixture_cutoff values(clock_timestamp()+interval '{seconds} seconds'); "
        'create or replace function _values_quarter_cutoff_at(date) returns timestamptz '
        'language sql stable as $$ select at from fixture_cutoff $$;')

def reset():
    run('truncate values_quarterly_ratings, values_submissions, values_assignments cascade;')

# A transaction began before the deadline, but acceptance waited beyond it.
# now()/transaction_timestamp() would incorrectly call this eligible.
aid = assignment(1)
cutoff(5)
cutoff_at = datetime.fromisoformat(json.loads(run("select to_json(at)::text from fixture_cutoff")))
blocker = begin_async("set application_name='values_blocker'; begin; "
    "select pg_advisory_xact_lock(hashtextextended('values_period:2026-10-01',0));", hold=True)
wait_lock('values_blocker')
late = begin_async("set application_name='values_late'; begin; " +
                  submission(aid, '33333333-3333-4333-8333-333333333333', with_start=True) + ' commit;')
wait_lock('values_late', waiting=True, blocked_by='values_blocker')
wait_cutoff()
release(blocker)
finish(blocker)
envelope = json.loads(finish(late))
result = envelope['response']
assert datetime.fromisoformat(envelope['startedAt']) < cutoff_at, 'fixture did not begin before cutoff'
assert datetime.fromisoformat(result['receipt']['acceptedAt']) >= cutoff_at, 'accepted timestamp precedes cutoff despite lock wait'
assert result['receipt']['quarterEligibility'] == 'late_after_cutoff', result
run("select _values_freeze_quarter('2026-10-01');")
assert int(run('select submission_count from values_quarterly_ratings')) == 0
assert int(run('select count(*) from values_quarterly_manifest where included')) == 0
print('PASS acceptance after governing-lock wait uses wall clock; late review excluded')

# A before-cutoff submission holds the governing lock through commit. Freeze
# must block, then include the complete committed header + eight children.
reset()
aid = assignment(2)
cutoff(5)
writer = begin_async("set application_name='values_writer'; begin; " +
                    submission(aid, '44444444-4444-4444-8444-444444444444'), hold=True)
wait_lock('values_writer')
wait_cutoff()
freezer = begin_async("set application_name='values_freezer'; begin; "
                      "select _values_freeze_quarter('2026-10-01'); commit;")
wait_lock('values_freezer', waiting=True, blocked_by='values_writer')
release(writer)
finish(writer)
finish(freezer)
assert int(run('select submission_count from values_quarterly_ratings')) == 1
assert int(run('select count(*) from values_scores')) == 8
assert int(run('select count(*) from values_quarterly_manifest where included')) == 1
print('PASS freeze waits for committed complete submission under same period lock')

# If freeze owns the period locks first, a later submit may enter live evidence
# but cannot rewrite a frozen empty result or its immutable inclusion manifest.
reset()
aid = assignment(3)
cutoff(-1)
freezer = begin_async("set application_name='values_freeze_first'; begin; "
                      "select _values_freeze_quarter('2026-10-01'); "
                      "select json_build_object('rating',(select to_jsonb(r) from values_quarterly_ratings r),'manifest',coalesce((select jsonb_agg(to_jsonb(m) order by m.submission_id) from values_quarterly_manifest m),'[]'::jsonb),'accounting',coalesce((select jsonb_agg(to_jsonb(a) order by a.rating_id) from values_quarterly_accounting a),'[]'::jsonb));", hold=True)
wait_lock('values_freeze_first')
late = begin_async("set application_name='values_after_freeze'; begin; " +
                  submission(aid, '55555555-5555-4555-8555-555555555555') + ' commit;')
wait_lock('values_after_freeze', waiting=True, blocked_by='values_freeze_first')
release(freezer)
frozen_initial = json.loads(finish(freezer).splitlines()[-1])
assert json.loads(finish(late))['receipt']['quarterEligibility'] == 'late_after_cutoff'
assert int(run('select submission_count from values_quarterly_ratings')) == 0
before = run('select row_to_json(r)::text from values_quarterly_ratings r')
manifest_before = run("select coalesce(jsonb_agg(to_jsonb(m) order by m.submission_id)::text,'[]') from values_quarterly_manifest m")
accounting_before = run("select coalesce(jsonb_agg(to_jsonb(a) order by a.rating_id)::text,'[]') from values_quarterly_accounting a")
assert json.loads(accounting_before) == frozen_initial['accounting'], 'late submission changed frozen accounting'
assert json.loads(before) == frozen_initial['rating'], 'late submission changed frozen rating'
assert json.loads(manifest_before) == frozen_initial['manifest'], 'late submission changed frozen manifest'
run("select _values_freeze_quarter('2026-10-01');")
assert run('select row_to_json(r)::text from values_quarterly_ratings r') == before
assert run("select coalesce(jsonb_agg(to_jsonb(m) order by m.submission_id)::text,'[]') from values_quarterly_manifest m") == manifest_before
assert run("select coalesce(jsonb_agg(to_jsonb(a) order by a.rating_id)::text,'[]') from values_quarterly_accounting a") == accounting_before
print('PASS freeze-first preserves empty quarterly result despite late live evidence')
print('3 real two-session concurrency scenarios passed; disposable local database only')
