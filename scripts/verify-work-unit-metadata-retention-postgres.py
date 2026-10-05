#!/usr/bin/env python3
"""Explicit opt-in retention extension of the genuine PG17 metadata fixture.

Default/--check-plan never executes a subprocess or contacts a database. Source
installation, guard repair, activation and provider operations are forbidden.
All correctness holds are separate from the bounded ACTIVE census paid test.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
SOURCE_REL = 'supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql'
MAIN_REL = 'scripts/verify-work-unit-metadata-cohorts-postgres.py'
# Enroll only a root-reviewed, frozen source pair. Never derive an expectation
# from a live catalog, predecessor JSON, command-line value or installed body.
EXPECTED_SOURCE_SHA256 = 'd083b38b07bb51f9f34d7b6c114fcdfcaf4c16b91a1541b7c51f2f11d5459c44'
EXPECTED_MAIN_SHA256 = '63540e422154972cf0fbf7867c74cd2290eae5013ceaba79f91dde98abb7f294'
PARENT_PINS = {
    '20261108410000_work_activity_engine_cutover.sql': 'aa767e67de301cd0ce5961758cc5afefe89bdf25fe27b3c4156a219c9cb2f648',
    '20261108440000_work_unit_review.sql': 'e32122a581bf995857983cc433323bc490381b6eb217c583bf95fd7376b3e53f',
    '20261108450000_work_activity_totals.sql': 'e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140',
    '20261108460000_work_unit_contributors.sql': 'ae6185e4b390b7cff8f3d7aca837688fda2756792bdf055ef8c3a1f290d438c5',
}
SUFFIXES = ('definitions', 'versions', 'proposals', 'revisions', 'floors', 'commands')
TABLES = tuple('_work_unit_metadata_' + s for s in SUFFIXES)
KEYS = tuple(t + '.actor_id' for t in TABLES)
CENSUS = '_work_unit_metadata_person_counts'
OLD_GUARDS = '_work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()'
SETTINGS = "\\set VERBOSITY verbose\nset statement_timeout='20s';set lock_timeout='12s';set default_transaction_isolation='read committed';"
MATRIX = {(r, u) for r in (0, 1000, 10000) for u in (1, 10, 100)}


def require(value, message):
    if not value:
        raise AssertionError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def lit(value):
    return 'null' if value is None else "'" + str(value).replace("'", "''") + "'"


def qi(value):
    return '"' + value.replace('"', '""') + '"'


def uid(n):
    return '00000000-0000-4000-8000-' + str(760000 + n).zfill(12)


def auth(actor):
    return 'set role authenticated;set request.jwt.claim.sub=' + lit(actor) + ';'


def census_sql(target, requester=None):
    return 'select public.' + CENSUS + '(' + lit(target) + '::uuid,' + lit(requester) + '::uuid);'


def command_sql(actor, n, action='propose'):
    definition = {'kind': 'material', 'code': 'retention_fixture_' + str(n),
                  'labelEn': 'Retention fixture', 'labelEs': 'Retention fixture'}
    payload = {'action': action, 'data': {'definitionId': uid(10000 + n),
               'expectedVersion': 0, 'projectId': None, 'definition': definition}}
    return auth(actor) + 'select work_unit_metadata_command(' + lit(uid(20000 + n)) + ",1," + lit(json.dumps(payload)) + '::jsonb);'


def validate_url(value):
    try:
        p = urlparse(value)
        good = (p.scheme in ('postgres', 'postgresql') and p.hostname in ('localhost', '127.0.0.1')
                and p.port == 5432 and p.path == '/forge_work_activity_role_test'
                and p.username == 'supabase_admin' and p.password == 'fixture-only'
                and not p.query and not p.fragment and not p.params)
    except ValueError:
        good = False
    require(good, 'Refused: exact localhost:5432/forge_work_activity_role_test supabase_admin:fixture-only URL required')
    return p


def validate_sources(root=ROOT, execute=False):
    source = (root / SOURCE_REL).read_text()
    source_sha, main_sha = sha(root / SOURCE_REL), sha(root / MAIN_REL)
    require(re.search(r'rollback;\s*$', source, re.I), 'Candidate must end in ROLLBACK')
    for name, expected in PARENT_PINS.items():
        require(sha(root / 'supabase/migrations' / name) == expected, 'Frozen parent source mismatch: ' + name)
    enrolled = bool(re.fullmatch('[0-9a-f]{64}', EXPECTED_SOURCE_SHA256) and
                    re.fullmatch('[0-9a-f]{64}', EXPECTED_MAIN_SHA256))
    if execute:
        require(enrolled, 'Refused: final source/harness pins have not been enrolled by root')
    if enrolled:
        require(source_sha == EXPECTED_SOURCE_SHA256, 'Reviewed metadata source mismatch')
        require(main_sha == EXPECTED_MAIN_SHA256, 'Reviewed main fixture source mismatch')
    return {'sourceSha256': source_sha, 'mainHarnessSha256': main_sha,
            'parentSourcePins': PARENT_PINS, 'enrolled': enrolled}, source


def validate_predecessor(receipt, pins):
    require(receipt.get('status') == 'passed' and receipt.get('stage') == 'complete',
            'Predecessor must have passed every test and reached complete')
    require(receipt.get('sourceSha256') == pins['sourceSha256'] and
            receipt.get('harnessSha256') == pins['mainHarnessSha256'], 'Exact predecessor source/harness mismatch')
    require(receipt.get('plan', {}).get('timeoutsSeconds') == {'statement': 20, 'lock': 12},
            'Predecessor deadlines changed')
    tiers = receipt.get('tiers', [])
    require(len(tiers) == 9 and {(t.get('additionalUnrelatedRows'), t.get('currentUnits')) for t in tiers} == MATRIX,
            'All nine predecessor volume tiers required')
    for t in tiers:
        samples = t.get('samplesMs', [])
        require(len(samples) == 20 and all(type(x) in (float, int) and math.isfinite(x) and x >= 0 for x in samples),
                'Twenty finite measured samples per predecessor tier required')
    require(any(w.get('case') == 'active_batch_payroll' and w.get('observed') is True and
                w.get('holderWasActive') is True and w.get('controlledIdleHold') is False and
                w.get('stage') == 'reader_and_payroll_completed' for w in receipt.get('waits', [])),
            'Predecessor actual ACTIVE paid edge required')
    # Completion is evidence; it does not establish an acceptable latency budget.
    return {'status': 'source_matched_complete', 'performanceBudgetApproved': False,
            'sourceSha256': receipt['sourceSha256'], 'harnessSha256': receipt['harnessSha256']}


def validate_counts(value, old):
    require(isinstance(value, dict) and isinstance(old, dict) and old, 'Complete census objects required')
    require(set(value) == set(old) | set(KEYS) and not (set(old) & set(KEYS)), 'Exact six supplemental keys required')
    require(all(type(n) is int and 0 <= n <= 9007199254740991 for n in value.values()), 'Invalid census count')
    require(all(value[k] == n for k, n in old.items()), 'Old census changed or lost')
    return value


def error_state(stderr, expected=None, constraint=None, table=None):
    found = re.search(r'ERROR:\s+([0-9A-Z]{5}):', stderr)
    require(found, 'No verbose PostgreSQL ERROR SQLSTATE: ' + stderr[-1500:])
    state = found.group(1)
    if expected is not None:
        require(state == expected, 'Wrong SQLSTATE: expected ' + expected + ', actual ' + state)
    if constraint:
        require(re.search(r'CONSTRAINT NAME:\s+' + re.escape(constraint) + r'\s*(?:\n|$)', stderr),
                'Missing exact constraint diagnostic')
    if table:
        require(re.search(r'TABLE NAME:\s+' + re.escape(table) + r'\s*(?:\n|$)', stderr),
                'Missing exact table diagnostic')
    return {'sqlstate': state, 'constraint': constraint, 'table': table, 'stderr': stderr[-2500:]}


class Evidence:
    def __init__(self, path):
        self.path = Path(path).resolve()
        require(not self.path.exists(), 'Refused: evidence file already exists; choose a distinct output')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data = {'status': 'running', 'stage': 'preflight', 'databaseContacted': False,
                     'checks': [], 'waits': [], 'oldestRows': [], 'timings': [],
                     'scope': 'Disposable PG17 only; no provider contact, source installation, guard repair or activation',
                     'coverageLimits': {'authProviderIntegration': False, 'atomicPersonRemoval': False,
                                        'finalPostAuthRequesterCheck': False, 'performanceBudgetApproved': False,
                                        'productionFlagsChanged': False}}
        self.persist()

    def persist(self, stage=None):
        if stage:
            self.data['stage'] = stage
        tmp = self.path.with_name(self.path.name + '.tmp')
        tmp.write_text(json.dumps(self.data, indent=2) + '\n')
        tmp.replace(self.path)

    def check(self, condition, label):
        require(condition, label)
        self.data['checks'].append(label)
        self.persist()
        print('PASS', label, flush=True)


class Session:
    """Real LOGIN connection, with a readable identity receipt before any wait."""
    def __init__(self, db, label, sql, user='authenticator', role_sql=''):
        self.db, self.label, self.login = db, label, user
        self.expected_role = 'authenticated' if role_sql.startswith('set role authenticated;') else ('service_role' if role_sql == 'set role service_role;' else user)
        subject = re.search(r"set request.jwt.claim.sub='([0-9a-f-]{36})';", role_sql)
        self.expected_actor = subject.group(1) if subject else None
        self.out = tempfile.NamedTemporaryFile(mode='w+', prefix='retention-', suffix='.stdout', delete=False)
        self.err = tempfile.NamedTemporaryFile(mode='w+', prefix='retention-', suffix='.stderr', delete=False)
        self.proc = subprocess.Popen(db.argv(user), stdin=subprocess.PIPE, stdout=self.out,
                                     stderr=self.err, text=True, env=db.env)
        identity = "select jsonb_build_object('fixtureIdentity',true,'pid',pg_backend_pid(),'sessionUser',session_user,'currentRole',current_user,'actor',auth.uid(),'statementTimeout',current_setting('statement_timeout'),'lockTimeout',current_setting('lock_timeout'));"
        self.write(SETTINGS + 'set application_name=' + lit(label) + ';' + role_sql + identity + sql)

    def write(self, sql):
        self.proc.stdin.write(sql + '\n')
        self.proc.stdin.flush()

    def text(self):
        return Path(self.out.name).read_text(), Path(self.err.name).read_text()

    def identity(self):
        for line in self.text()[0].splitlines():
            if line.startswith('{'):
                row = json.loads(line)
                if row.get('fixtureIdentity') is True:
                    return row
        return None

    def finish(self, sql='', error=None, constraint=None, table=None):
        if sql:
            self.write(sql)
        self.proc.stdin.close()
        self.proc.wait(timeout=25)
        out, err = self.text()
        if error or constraint:
            require(self.proc.returncode != 0, 'Expected SQL refusal')
            return error_state(err, error, constraint, table)
        require(self.proc.returncode == 0, err[-2500:])
        return [json.loads(line) for line in out.splitlines() if line.startswith('{') and not json.loads(line).get('fixtureIdentity')]

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)
        stdout, stderr = self.text()
        self.db.evidence.data.setdefault('sessionTranscripts', []).append({'label': self.label, 'returncode': self.proc.returncode, 'stdout': stdout[-30000:], 'stderr': stderr[-5000:]})
        self.db.evidence.persist()
        self.out.close()
        self.err.close()
        for p in (self.out.name, self.err.name):
            Path(p).unlink(missing_ok=True)


class DB:
    def __init__(self, parsed, evidence):
        self.parsed, self.evidence = parsed, evidence
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        self.env['PGCONNECT_TIMEOUT'] = '3'

    def argv(self, user):
        require(user in ('postgres', 'authenticator', 'supabase_admin'), 'Unexpected fixture login')
        url = urlunparse((self.parsed.scheme, user + ':fixture-only@' + self.parsed.hostname + ':5432', self.parsed.path, '', '', ''))
        return ['psql', url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1']

    def run(self, sql, user='postgres', error=None, constraint=None, table=None):
        self.evidence.data['databaseContacted'] = True
        self.evidence.persist()
        r = subprocess.run(self.argv(user), input=SETTINGS + sql, text=True, capture_output=True, timeout=30, env=self.env)
        if error or constraint:
            require(r.returncode != 0, 'Expected SQL refusal')
            return error_state(r.stderr, error, constraint, table)
        require(r.returncode == 0, r.stderr[-2500:])
        return r.stdout.strip()

    def obj(self, sql, user='postgres'):
        return json.loads(self.run(sql, user).splitlines()[-1])

    def counts(self, actor, requester=None):
        old = self.obj('select person_record_counts(' + lit(actor) + ');')
        value = self.obj('set role service_role;' + census_sql(actor, requester), 'authenticator')
        return validate_counts(value, old), old

    def person(self, n):
        actor = uid(n)
        self.run('insert into auth.users(id) values(' + lit(actor) + ');insert into profiles(id,display_name,role,is_test) values(' + lit(actor) + ',' + lit('Retention fixture ' + str(n)) + ",'owner',false);")
        return actor

    def until(self, query, seconds=4):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = self.obj(query)
            if value:
                return value
            time.sleep(.015)
        return None

    def idle(self, session):
        observed = self.until("select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'login',usename,'state',state)), '[]') from pg_stat_activity where application_name=" + lit(session.label) + " and state='idle in transaction'")
        require(observed, 'Real statement did not complete in held transaction')
        return observed

    def wait_snapshot(self, holder, waiter, active=False):
        # G=7712 is observed directly, not inferred from any unrelated blocking PID.
        return self.until("select coalesce(jsonb_agg(jsonb_build_object('holderPid',a.pid,'waiterPid',b.pid,'holderLogin',a.usename,'waiterLogin',b.usename,'holderState',a.state,'waiterState',b.state,'holderQuery',a.query,'waiterQuery',b.query,'blockingPids',pg_blocking_pids(b.pid),'gateClass',7712,'gateObject',0)), '[]') from pg_stat_activity a join pg_stat_activity b on a.datname=b.datname where a.application_name=" + lit(holder.label) + ' and b.application_name=' + lit(waiter.label) + (" and a.state='active'" if active else " and a.state='idle in transaction'") + " and a.pid=any(pg_blocking_pids(b.pid)) and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.classid=7712 and l.objid=0 and l.objsubid=2 and l.granted) and exists(select 1 from pg_locks l where l.pid=b.pid and l.locktype='advisory' and l.classid=7712 and l.objid=0 and l.objsubid=2 and not l.granted)", seconds=2 if active else 4)


def source_bodies(source):
    bodies = {}
    for match in re.finditer(r'create(?: or replace)? function public\.([a-z_]+)\(.*?\bas\s+(\$[a-z_]*\$)(.*?)\2;', source, re.S | re.I):
        bodies[match.group(1)] = match.group(3)
    require('_work_unit_metadata_coverage' in bodies and CENSUS in bodies, 'Cannot extract final authored guard/census bodies')
    return bodies


def catalog_sql():
    names = ','.join(lit(t) for t in TABLES)
    return """select jsonb_build_object(
 'fks',(select jsonb_agg(jsonb_build_object('table',c.relname,'constraint',k.conname,'kind',k.contype,'delete',k.confdeltype,'update',k.confupdtype,'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,'childColumns',(select jsonb_agg(a.attname order by x.n) from unnest(k.conkey) with ordinality x(attnum,n) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.attnum),'parent',k.confrelid::regclass::text,'parentColumns',(select jsonb_agg(a.attname order by x.n) from unnest(k.confkey) with ordinality x(attnum,n) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.attnum)) order by c.relname) from pg_constraint k join pg_class c on c.oid=k.conrelid where k.conrelid in(select oid from pg_class where relnamespace='public'::regnamespace and relname in (NAMES)) and k.conname='metadata_actor_retention'),
 'indexes',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',ix.relname,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'unique',i.indisunique,'keys',i.indnkeyatts,'attributes',i.indnatts,'method',am.amname,'predicate',pg_get_expr(i.indpred,i.indrelid),'expressions',pg_get_expr(i.indexprs,i.indrelid),'column',pg_get_indexdef(i.indexrelid,1,true)) order by c.relname) from pg_index i join pg_class c on c.oid=i.indrelid join pg_class ix on ix.oid=i.indexrelid join pg_am am on am.oid=ix.relam where c.relnamespace='public'::regnamespace and ix.relname in (INDEXES)),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'constraintTable',d.relname,'name',t.tgname,'function',p.proname,'functionSchema',n.nspname,'internal',t.tgisinternal,'type',t.tgtype,'enabled',t.tgenabled,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'opposite',t.tgconstrrelid=case when t.tgrelid=k.conrelid then k.confrelid else k.conrelid end) order by d.relname,p.proname) from pg_trigger t join pg_constraint k on k.oid=t.tgconstraint join pg_class c on c.oid=t.tgrelid join pg_class d on d.oid=k.conrelid join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where k.conname='metadata_actor_retention' and k.conrelid in(select oid from pg_class where relnamespace='public'::regnamespace and relname in (NAMES))))""".replace('NAMES', names).replace('INDEXES', ','.join(lit('work_unit_metadata_actor_' + s) for s in SUFFIXES))


def validate_catalog(value):
    require({f['table'] for f in value['fks']} == set(TABLES) and len(value['fks']) == 6, 'Exact six actor FKs')
    for f in value['fks']:
        require(f['constraint'] == 'metadata_actor_retention' and f['kind'] == 'f' and f['delete'] == 'r' and f['update'] == 'a'
                and f['validated'] is True and f['deferrable'] is False and f['deferred'] is False
                and f['childColumns'] == ['actor_id'] and f['parent'] in ('profiles', 'public.profiles')
                and f['parentColumns'] == ['id'], 'Actor FK semantics drift')
    require(len(value['indexes']) == 6 and {i['table'] for i in value['indexes']} == set(TABLES), 'Exact six actor indexes')
    for i in value['indexes']:
        require(i['name'] == 'work_unit_metadata_actor_' + i['table'].removeprefix('_work_unit_metadata_')
                and all(i[k] is True for k in ('valid', 'ready', 'live')) and i['unique'] is False
                and i['keys'] == 1 and i['attributes'] == 1 and i['method'] == 'btree'
                and i['predicate'] is None and i['expressions'] is None and i['column'] == 'actor_id', 'Actor index semantics drift')
    require(len(value['triggers']) == 24, 'Exact twenty-four internal RI triggers')
    functions = {'RI_FKey_check_ins': (5, False), 'RI_FKey_check_upd': (17, False),
                 'RI_FKey_restrict_del': (9, True), 'RI_FKey_noaction_upd': (17, True)}
    for table in TABLES:
        rows = [r for r in value['triggers'] if r['constraintTable'] == table]
        require(len(rows) == 4 and {r['function'] for r in rows} == set(functions), 'RI trigger function set drift')
        for r in rows:
            typ, incoming = functions[r['function']]
            require(r['table'] == ('profiles' if incoming else table) and r['type'] == typ
                    and r['functionSchema'] == 'pg_catalog' and r['internal'] is True and r['enabled'] == 'O'
                    and r['deferrable'] is False and r['deferred'] is False and r['opposite'] is True,
                    'RI trigger semantics drift')


def isolated_insert(table, actor, n):
    """Privileged fixture control only: an oldest sole-history row, NOT RPC proof."""
    rowid, otherid, command = uid(30000 + n), uid(31000 + n), uid(32000 + n)
    stamp = "'2000-01-01T00:00:00Z'::timestamptz"
    if table.endswith('_definitions'):
        cols, values = 'id,kind,code,actor_id,recorded_at', [lit(rowid), "'material'", lit('retention_sole_' + str(n)), lit(actor), stamp]
    elif table.endswith('_versions'):
        # Dependency belongs to a separate helper; target still has only ONE row.
        prefix = "insert into _work_unit_metadata_definitions(id,kind,code,actor_id) values(" + lit(otherid) + ",'material'," + lit('retention_parent_' + str(n)) + ',' + lit(uid(1)) + ');'
        return prefix + 'insert into ' + table + '(id,definition_id,version,state,value,actor_id,command_id,recorded_at) values(' + ','.join([lit(rowid), lit(otherid), '1', "'published'", "'{}'", lit(actor), lit(command), stamp]) + ');'
    elif table.endswith('_proposals'):
        cols, values = 'id,actor_id,command_id,value,recorded_at', [lit(rowid), lit(actor), lit(command), "'{}'", stamp]
    elif table.endswith('_revisions'):
        cols, values = 'id,unit_id,incarnation,revision,binding,origin_jobs,value,actor_id,command_id,recorded_at', [lit(rowid), lit(otherid), '0', '1', "'{}'", "'[]'", "'{}'", lit(actor), lit(command), stamp]
    elif table.endswith('_floors'):
        cols, values = 'id,unit_id,incarnation,revision,basis,origin_jobs,state,shares,reason,actor_id,command_id,recorded_at', [lit(rowid), lit(otherid), '0', '1', "'{}'", "'[]'", "'unknown'", "'[]'", "'Sole oldest fixture control'", lit(actor), lit(command), stamp]
    else:
        cols, values = 'command_id,actor_id,origin_jobs,request,result,recorded_at', [lit(command), lit(actor), "'[]'", "'{}'", "'{}'", stamp]
    return 'insert into ' + table + '(' + cols + ') values(' + ','.join(values) + ');'


def snapshot_sql(table, actor):
    return "select jsonb_build_object('authExists',exists(select 1 from auth.users where id=" + lit(actor) + "),'profile',(select to_jsonb(p) from profiles p where id=" + lit(actor) + "),'rows',(select jsonb_agg(to_jsonb(t) order by recorded_at) from " + table + ' t where actor_id=' + lit(actor) + '))'


def admission(db, evidence, source):
    evidence.persist('catalog_admission')
    evidence.check(db.run("select current_setting('server_version_num')::int/10000") == '17', 'Actual PostgreSQL 17')
    evidence.check(db.run("select session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)") == 't', 'Actual nonsuperuser fixture-owner login')
    evidence.check(db.run("select session_user='authenticator' and not (select rolsuper or rolinherit from pg_roles where rolname=session_user)", 'authenticator') == 't', 'Actual noninheriting authenticator login')
    bodies = source_bodies(source)
    for name in ('_work_unit_metadata_coverage', CENSUS):
        body = db.obj('select to_jsonb(prosrc) from pg_proc where oid=' + lit('public.' + name + ('()' if name.endswith('coverage') else '(uuid,uuid)')) + '::regprocedure')
        evidence.check(body == bodies[name], 'Installed ' + name + ' matches authored source body')
    attester = re.search(r'if not (coalesce\(.*?\)) then raise exception', bodies[CENSUS], re.S)
    require(attester, 'Cannot extract authored self-attester pin')
    evidence.check(db.run('select ' + attester.group(1)) == 't', 'Full self-attester attributes match authored pin')
    contract = re.search(r"values\('metadata_v1','([0-9a-f]{64})'\)", source)
    require(contract, 'Cannot extract authored catalog contract pin')
    evidence.check(db.run("select expected_catalog_sha256 from _work_unit_metadata_contract where proof_key='metadata_v1'") == contract.group(1), 'Installed contract equals authored expected catalog hash')
    evidence.check(db.run('select ' + OLD_GUARDS + ' and _work_unit_metadata_coverage()') == 't', 'All frozen and new catalog guards true')
    catalog = db.obj(catalog_sql())
    validate_catalog(catalog)
    evidence.data['catalog'] = catalog
    evidence.check(True, 'Exact six FK/index and twenty-four RI semantic records')
    # Source-coupled legacy census; the new function may only supplement it.
    predecessor = (ROOT / 'supabase/migrations/20261108440000_work_unit_review.sql').read_text()
    match = re.search(r'create or replace function public\.person_record_counts\(p_id uuid\).*?as \$\$(.*?)\$\$;', predecessor, re.S)
    require(match, 'Cannot extract authored frozen person census')
    evidence.check(db.obj("select to_jsonb(prosrc) from pg_proc where oid='person_record_counts(uuid)'::regprocedure") == match.group(1), 'Frozen legacy census body preserved exactly')
    acl = db.obj("select jsonb_object_agg(r,has_function_privilege(r,'_work_unit_metadata_person_counts(uuid,uuid)','EXECUTE')) from unnest(array['anon','authenticated','service_role']) r")
    evidence.check(acl == {'anon': False, 'authenticated': False, 'service_role': True}, 'Service-only census EXECUTE')
    for role in ('anon', 'authenticated'):
        db.run('set role ' + role + ';' + census_sql(uid(1)), 'authenticator', error='42501')
        evidence.check(True, role + ' actual census SQLSTATE 42501')
    for role in ('anon', 'authenticated', 'service_role'):
        for table in TABLES:
            db.run('set role ' + role + ';select actor_id from ' + table + ' limit 1;', 'authenticator', error='42501')
    evidence.check(True, 'Ordinary and service roles cannot read private author rows')
    evidence.data['initialAuthorityFlags'] = db.obj("select jsonb_build_object('capture_enabled',capture_enabled) from work_activity_authority_generation")
    evidence.persist()
    return catalog


def cases(db, evidence, catalog):
    owner = db.person(1)
    empty = db.person(2)
    value, old = db.counts(empty, owner)
    evidence.check(not any(value.values()), 'Existing empty profile: complete legacy and six-key census zero')
    evidence.data['emptyBaselineCensus'] = value
    evidence.check(db.counts(empty)[0] == value, 'Null requesting owner admitted only through trusted service role')
    db.run('set role service_role;' + census_sql(uid(999), owner), 'authenticator', error='P0002')
    db.run('set role service_role;' + census_sql(None, owner), 'authenticator', error='23514')
    evidence.check(True, 'Nonexistent and null targets produce exact distinct refusal SQLSTATEs')
    for index, field in enumerate(('access_revoked_at', 'retired_at')):
        requester = db.person(3 + index)
        db.run('update profiles set ' + field + '=clock_timestamp() where id=' + lit(requester))
        db.run('set role service_role;' + census_sql(empty, requester), 'authenticator', error='42501')
        evidence.check(True, 'Supplied ' + field + ' owner refused; trusted-null service path remains available')
        db.counts(empty)
    # Rollback-only disable controls. Privileged login is necessary for internal
    # RI DDL; these controls are never claimed as authenticator login races.
    for incoming in (True, False):
        trigger = next(t for t in catalog['triggers'] if (t['table'] == 'profiles') == incoming)
        table, name = qi(trigger['table']), qi(trigger['name'])
        prefix = 'begin;alter table public.' + table + ' disable trigger ' + name + ';set role postgres;'
        proof = db.obj(prefix + 'select jsonb_build_object(\'old\',' + OLD_GUARDS + ",'new',_work_unit_metadata_coverage());rollback;", 'supabase_admin')
        evidence.check(proof == {'old': True, 'new': False}, ('Incoming' if incoming else 'Outgoing') + ' disabled RI refuses new guard while frozen guards true')
        for sql, expected in (("set role service_role;" + census_sql(empty, owner), '55000'),):
            db.run(prefix + sql + 'rollback;', 'supabase_admin', error=expected)
        probes = [auth(owner) + 'select work_unit_metadata_read(' + lit(uid(999)) + ',1);',
                  auth(owner) + 'select work_unit_metadata_receipt(' + lit(uid(999)) + ',1);',
                  auth(owner) + 'select work_unit_cohorts_read(' + lit(uid(999)) + ',1);',
                  command_sql(owner, 900 + int(incoming))]
        for probe in probes:
            reply = db.obj(prefix + probe + 'rollback;', 'supabase_admin')
            evidence.check(reply.get('availability') == 'unavailable', 'Disabled RI denies metadata public entry')
        evidence.check(db.run('select ' + OLD_GUARDS + ' and _work_unit_metadata_coverage()') == 't', 'Rollback restores exact catalog without repair')
    # Constraint-isolation seeds intentionally bypass runtime RPC semantics, but
    # do not disable any trigger/constraint or fabricate a runtime receipt claim.
    evidence.persist('six_isolated_oldest_history_tables')
    restrict_state = None
    for index, table in enumerate(TABLES):
        actor = db.person(20 + index)
        initial, old = db.counts(actor, owner)
        evidence.check(not any(initial.values()), 'Fresh sole-history actor absent every old census key: ' + table)
        db.run(isolated_insert(table, actor, index))
        counts, old = db.counts(actor, owner)
        expected = {k: int(k == table + '.actor_id') for k in KEYS}
        evidence.check(not any(old.values()) and {k: counts[k] for k in KEYS} == expected, 'Exactly one isolated oldest author row: ' + table)
        before = db.obj(snapshot_sql(table, actor))
        evidence.check(before['authExists'] and len(before['rows']) == 1 and before['rows'][0]['recorded_at'].startswith('2000-01-01'), 'Sole retained historical row and named person exist')
        record = {'table': table, 'actor': actor, 'fixtureControlOnly': True, 'runtimeRpcProof': False,
                  'before': before, 'completeCensus': counts, 'deleteErrors': []}
        evidence.data['oldestRows'].append(record)
        evidence.persist()
        for target in ('public.profiles', 'auth.users'):
            error = db.run('delete from ' + target + ' where id=' + lit(actor), constraint='metadata_actor_retention', table=table)
            require(error['sqlstate'] in ('23001', '23503'), 'Unexpected RESTRICT SQLSTATE')
            if restrict_state is None:
                restrict_state = error['sqlstate']
                evidence.data['actualPG17RestrictSqlstate'] = restrict_state
            require(error['sqlstate'] == restrict_state, 'RESTRICT SQLSTATE inconsistent across direct/cascade paths')
            record['deleteErrors'].append({'target': target, **error})
            evidence.check(db.obj(snapshot_sql(table, actor)) == before, 'Exact profile/name/auth/history survives failed ' + target + ' deletion')
        db.run('update profiles set retired_at=clock_timestamp(),access_revoked_at=clock_timestamp(),active=false where id=' + lit(actor))
        after = db.obj(snapshot_sql(table, actor))
        evidence.check(after['authExists'] and after['rows'] == before['rows'] and after['profile']['display_name'] == before['profile']['display_name'] and after['profile']['retired_at'] is not None, 'Retirement preserves immutable row and name')
        db.run(command_sql(actor, 100 + index), 'authenticator', error='42501')
        db.run('set role service_role;' + census_sql(empty, actor), 'authenticator', error='42501')
        evidence.check(True, 'Retired author loses new-write and requesting-owner admission')
        record['afterRetirement'] = after
        record['status'] = 'passed'
        evidence.persist()
    return owner, empty, restrict_state


def capture_wait(db, evidence, record, holder, waiter, active=False):
    # Persist BEFORE every bounded observer. Missing observation is never success.
    record['stage'] = 'observing_actual_G'
    evidence.persist()
    observation = db.wait_snapshot(holder, waiter, active)
    record['observation'] = observation
    record['identities'] = [holder.identity(), waiter.identity()]
    record['observed'] = bool(observation)
    evidence.persist()
    if observation:
        for session, identity in zip((holder, waiter), record['identities']):
            require(identity and identity['statementTimeout'] == '20s' and identity['lockTimeout'] == '12s', 'Missing exact live connection identity/deadline proof')
            require(identity['sessionUser'] == session.login and identity['currentRole'] == session.expected_role and identity['actor'] == session.expected_actor, 'Session role/actor differs from intended fresh LOGIN')
            for row in observation:
                side = 'holder' if session is holder else 'waiter'
                require(row[side + 'Pid'] == identity['pid'] and row[side + 'Login'] == identity['sessionUser'], 'Observer and session identity disagree')
    return observation


def races(db, evidence, owner, restrict_state):
    evidence.persist('real_two_connection_correctness_races')
    actor = db.person(40)
    evidence.check(not any(db.counts(actor, owner)[0].values()), 'Writer race starts with complete zero census')
    holder = waiter = None
    record = {'case': 'supported_writer_wins_auth_delete', 'controlledIdleHold': True,
              'paidPerformanceClaim': False, 'observed': False, 'stage': 'prepared'}
    evidence.data['waits'].append(record)
    evidence.persist()
    try:
        holder = Session(db, 'retention_writer_holder', 'begin;' + command_sql(actor, 400, 'publish'), role_sql=auth(actor))
        db.idle(holder)
        waiter = Session(db, 'retention_auth_delete_waiter', 'delete from auth.users where id=' + lit(actor) + ';', 'postgres')
        require(capture_wait(db, evidence, record, holder, waiter), 'Writer-vs-delete G wait not observed')
        require(record['identities'][0]['sessionUser'] == 'authenticator' and record['identities'][0]['currentRole'] == 'authenticated' and record['identities'][0]['actor'] == actor, 'Writer is not fresh authenticated LOGIN actor')
        replies = holder.finish('commit;')
        require(replies[-1]['receipt']['status'] == 'applied', 'Real publish command must apply')
        refusal = waiter.finish(error=restrict_state, constraint='metadata_actor_retention')
        # Any of three real publish author tables may be checked first by PG.
        table_match = re.search(r'TABLE NAME:\s+([^\n]+)', refusal['stderr'])
        require(table_match and table_match.group(1).strip() in (TABLES[0], TABLES[1], TABLES[5]), 'Writer delete refusal must be real publish history')
        counts, old = db.counts(actor, owner)
        evidence.check(not any(old.values()) and {k: counts[k] for k in KEYS} == {k: int(k in (KEYS[0], KEYS[1], KEYS[5])) for k in KEYS}, 'Fresh census sees exact committed publish history')
        evidence.check(db.obj(snapshot_sql(TABLES[0], actor))['profile']['display_name'] == 'Retention fixture 40', 'Writer winner keeps named profile')
        record.update({'status': 'passed', 'stage': 'complete', 'writerReply': replies[-1], 'deleteRefusal': refusal, 'freshCensus': counts})
        evidence.persist()
    finally:
        for s in (holder, waiter):
            if s:
                s.stop()
    actor = db.person(41)
    evidence.check(not any(db.counts(actor, owner)[0].values()), 'Delete race starts with genuinely empty synthetic identity')
    holder = waiter = None
    record = {'case': 'empty_auth_delete_wins_supported_writer', 'controlledIdleHold': True,
              'paidPerformanceClaim': False, 'observed': False, 'stage': 'prepared'}
    evidence.data['waits'].append(record)
    evidence.persist()
    try:
        holder = Session(db, 'retention_delete_holder', 'begin;delete from auth.users where id=' + lit(actor) + ';', 'postgres')
        db.idle(holder)
        waiter = Session(db, 'retention_writer_waiter', command_sql(actor, 410), role_sql=auth(actor))
        require(capture_wait(db, evidence, record, holder, waiter), 'Delete-vs-writer G wait not observed')
        require(record['identities'][1]['sessionUser'] == 'authenticator' and record['identities'][1]['currentRole'] == 'authenticated' and record['identities'][1]['actor'] == actor, 'Waiting writer must be actual actor LOGIN')
        holder.finish('commit;')
        record['writerRefusal'] = waiter.finish(error='42501')
        absence = db.obj("select jsonb_build_object('profile',exists(select 1 from profiles where id=" + lit(actor) + "),'auth',exists(select 1 from auth.users where id=" + lit(actor) + "),'metadata',(" + ' + '.join('(select count(*) from ' + t + ' where actor_id=' + lit(actor) + ')' for t in TABLES) + '))')
        evidence.check(absence == {'profile': False, 'auth': False, 'metadata': 0}, 'Deletion winner leaves no profile/auth/metadata ghost')
        record.update({'status': 'passed', 'stage': 'complete', 'absence': absence})
        evidence.persist()
    finally:
        for s in (holder, waiter):
            if s:
                s.stop()
    requester = db.person(42)
    evidence.check(not any(db.counts(uid(2), requester)[0].values()), 'Requester is admitted owner before real revocation')
    holder = waiter = None
    record = {'case': 'revocation_wins_census_requester_recapture', 'controlledIdleHold': True,
              'paidPerformanceClaim': False, 'observed': False, 'stage': 'prepared'}
    evidence.data['waits'].append(record)
    evidence.persist()
    try:
        holder = Session(db, 'retention_revoke_holder', 'begin;update profiles set access_revoked_at=clock_timestamp() where id=' + lit(requester) + ';', 'postgres')
        db.idle(holder)
        waiter = Session(db, 'retention_census_waiter', census_sql(uid(2), requester), role_sql='set role service_role;')
        require(capture_wait(db, evidence, record, holder, waiter), 'Revocation-vs-requester G wait not observed')
        require(record['identities'][1]['sessionUser'] == 'authenticator' and record['identities'][1]['currentRole'] == 'service_role', 'Actual service role census LOGIN')
        holder.finish('commit;')
        record['censusRefusal'] = waiter.finish(error='42501')
        evidence.check(db.run('select access_revoked_at is not null and role=\'owner\' from profiles where id=' + lit(requester)) == 't', 'Owner role remains; freshly revoked requester is rejected after G')
        record.update({'status': 'passed', 'stage': 'complete'})
        evidence.persist()
    finally:
        for s in (holder, waiter):
            if s:
                s.stop()


def performance(db, evidence, owner, target):
    evidence.persist('full_supplemental_census_timing')
    samples = []
    for n in range(20):
        record = {'sample': n + 1, 'status': 'running'}
        evidence.data['timings'].append(record)
        evidence.persist()
        started = time.monotonic()
        result = db.obj("set role service_role;create temp table retention_measure(ms double precision,value jsonb);do $$declare t timestamptz;v jsonb;begin t:=clock_timestamp();v:=public." + CENSUS + '(' + lit(target) + '::uuid,' + lit(owner) + "::uuid);insert into retention_measure values(extract(epoch from clock_timestamp()-t)*1000,v);end$$;select jsonb_build_object('serverMs',ms,'value',value) from retention_measure;", 'authenticator')
        validate_counts(result['value'], db.obj('select person_record_counts(' + lit(target) + ');'))
        require(type(result['serverMs']) in (int, float) and math.isfinite(result['serverMs']) and result['serverMs'] >= 0, 'Nonfinite server timing')
        samples.append(result['serverMs'])
        record.update({'status': 'passed', 'serverMs': result['serverMs'], 'callerWallMsIncludingStartup': (time.monotonic() - started) * 1000, 'completeCounts': result['value']})
        evidence.persist()
    ordered = sorted(samples)
    evidence.data['timingSummary'] = {'samples': 20, 'medianMs': statistics.median(samples), 'p95Ms': ordered[18], 'maxMs': max(samples), 'budgetApproved': False,
                                      'scope': 'Complete legacy plus six supplemental counts under real G at predecessor fixture baseline; no extrapolation'}
    evidence.persist('active_census_supported_paid_clock')
    # Use predecessor's synthetic job; prove its supported fixture state instead
    # of changing activation/configuration. Fresh separate actor/shift.
    actor = db.person(50)
    project = '00000000-0000-4000-8000-000000650010'
    require(db.run('select capture_enabled from work_activity_authority_generation') == 't', 'Predecessor capture fixture was not activated; this extension will not activate it')
    rpc = lambda sql: db.obj(auth(actor) + sql, 'authenticator')
    signed = rpc('select to_jsonb(sign_toolbox_talk(' + lit(uid(500)) + ',' + lit(actor) + ",null::uuid,'Synthetic signature',null::text,null::text,'Retention fixture only',clock_timestamp()));")
    require(signed['profile_id'] == actor, 'Supported toolbox signing failed')
    shift = rpc('select to_jsonb(clock_in(' + lit(project) + '::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,' + lit(uid(501)) + "::uuid,clock_timestamp()-interval '1 minute',clock_timestamp(),0,1));")['id']
    observed = False
    try:
        for attempt in range(2):
            reader = paid = None
            record = {'case': 'active_supplemental_census_paid_clock', 'attempt': attempt + 1, 'observed': False,
                      'holderWasActive': False, 'controlledIdleHold': False, 'stage': 'prepared'}
            evidence.data['waits'].append(record)
            evidence.persist()
            try:
                reader = Session(db, 'retention_active_census', census_sql(target, owner), role_sql='set role service_role;')
                active = db.until("select coalesce(jsonb_agg(jsonb_build_object('pid',a.pid,'state',a.state)), '[]') from pg_stat_activity a where a.application_name='retention_active_census' and a.state='active' and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.classid=7712 and l.objid=0 and l.objsubid=2 and l.granted)", 2)
                record['holderWasActive'] = bool(active)
                record['initialActiveObservation'] = active
                evidence.persist()
                if not active:
                    record['censusResults'] = reader.finish()
                    record['stage'] = 'finished_without_observed_active_edge'
                    evidence.persist()
                    continue
                started = time.monotonic()
                paid = Session(db, 'retention_paid_waiter', 'select to_jsonb(start_break(' + lit(shift) + "::uuid,'rest'::text));", role_sql=auth(actor))
                observation = capture_wait(db, evidence, record, reader, paid, active=True)
                answers = reader.finish()
                paid_result = paid.finish()[-1]
                record.update({'paidResponseWallMs': (time.monotonic() - started) * 1000,
                               'paidResponseTimingMeaning': 'Caller upper bound from paid process startup through wait observation and reader/paid result collection; excludes subsequent legacy census validation; not isolated server execution or lock duration'})
                evidence.persist()
                validate_counts(answers[-1], db.obj('select person_record_counts(' + lit(target) + ');'))
                require(paid_result['break_started_at'] is not None, 'Supported start_break did not succeed')
                record.update({'censusResults': answers, 'paidResult': paid_result, 'requestWallMs': (time.monotonic() - started) * 1000,
                               'timingMeaning': 'Verified census/start_break case upper bound includes paid process startup, wait observation, reader/paid result collection and post-response legacy census validation; not isolated server execution or lock duration; excludes later end_break and clock_out',
                               'stage': 'census_and_paid_completed'})
                returned = rpc('select to_jsonb(end_break(' + lit(shift) + '::uuid));')
                require(returned['break_started_at'] is None, 'Supported end_break did not succeed')
                record['returnResult'] = returned
                evidence.persist()
                if observation:
                    observed = True
                    break
            finally:
                for s in (reader, paid):
                    if s:
                        s.stop()
    finally:
        # Supported safety exit, including failure cleanup; never direct clock writes.
        closed = rpc('select to_jsonb(clock_out(' + lit(shift) + '::uuid,null::text,false,true,null::integer,null::double precision,null::double precision,null::text));')
        evidence.data['paidClockOut'] = closed
        evidence.persist()
        require(closed['clock_out_at'] is not None, 'Supported clock_out did not succeed')
    evidence.check(observed, 'Real ACTIVE census versus supported start_break G edge, return and out observed')


def plan(pins):
    return {'result': 'PLAN VALIDATED', 'databaseTests': False, **pins,
            'explicitExecuteRequired': True, 'timeoutsSeconds': {'statement': 20, 'lock': 12},
            'requiredPredecessor': 'Exact source/harness passed+complete PG17 main receipt; nine tiers, twenty samples each, observed ACTIVE paid edge',
            'phases': ['catalog/ACL and source coupling', 'zero/null/missing/current/revoked/retired requester',
                       'incoming/outgoing rollback-only RI disable', 'six sole-oldest-history direct and synthetic Auth cascade controls',
                       'supported writer/delete winner races', 'requester revocation after G',
                       'twenty complete supplemental census timings', 'two-attempt ACTIVE census paid break/return/out'],
            'gatesStillHeld': ['No Auth provider or atomic removal proof', 'No final post-Auth requester check',
                               'No accepted paid-clock latency budget', 'No production promotion', 'Full existing 65-case edge suite remains required']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check-plan', action='store_true')
    modes.add_argument('--execute-fixture', action='store_true')
    parser.add_argument('--predecessor', type=Path)
    parser.add_argument('--out', type=Path, default=os.environ.get('WORK_UNIT_METADATA_RETENTION_PG_OUT'))
    args = parser.parse_args(argv)
    if not args.execute_fixture:
        pins, _ = validate_sources()
        print(json.dumps(plan(pins), indent=2))
        return 0
    require(args.out is not None, '--execute-fixture requires a distinct --out artifact path')
    evidence = Evidence(args.out)
    try:
        pins, source = validate_sources(execute=True)
        evidence.data.update(pins)
        evidence.data['harnessSha256'] = sha(__file__)
        require(args.predecessor is not None, 'Exact predecessor receipt path required')
        require(args.predecessor.resolve() != evidence.path, 'Predecessor cannot be output path')
        raw = args.predecessor.read_bytes()
        evidence.data['predecessor'] = validate_predecessor(json.loads(raw), pins)
        evidence.data['predecessor']['receiptSha256'] = hashlib.sha256(raw).hexdigest()
        evidence.data['predecessor']['path'] = str(args.predecessor.resolve())
        parsed = validate_url(os.environ.get('WORK_ACTIVITY_ROLE_TEST_DB_URL', ''))
        evidence.data['plan'] = plan(pins)
        evidence.persist('preflight_complete')
        db = DB(parsed, evidence)
        catalog = admission(db, evidence, source)
        owner, empty, restrict_state = cases(db, evidence, catalog)
        races(db, evidence, owner, restrict_state)
        performance(db, evidence, owner, empty)
        evidence.check(db.run('select ' + OLD_GUARDS + ' and _work_unit_metadata_coverage()') == 't', 'Final frozen and candidate guards true')
        evidence.check(db.obj("select jsonb_build_object('capture_enabled',capture_enabled) from work_activity_authority_generation") == evidence.data['initialAuthorityFlags'], 'No activation/configuration flag changes')
        evidence.data['status'] = 'passed'
        evidence.persist('complete')
        print(json.dumps({'result': 'PASS', 'artifact': str(evidence.path), 'checks': len(evidence.data['checks']), 'performanceBudgetApproved': False}))
        return 0
    except BaseException as exc:
        evidence.data['status'] = 'failed'
        evidence.data['failure'] = {'type': type(exc).__name__, 'message': str(exc)[-3500:]}
        evidence.data['remainingHold'] = 'No incomplete or unobserved phase constitutes acceptance; preserve this partial artifact.'
        evidence.persist()
        raise


if __name__ == '__main__':
    sys.exit(main())
