#!/usr/bin/env python3
"""No-contact constructor/receipt/parser tests. These do NOT certify PG behavior."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).with_name('verify-work-unit-metadata-retention-postgres.py')
spec = importlib.util.spec_from_file_location('retention_fixture', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
URL = 'postgresql://supabase_admin:fixture-only@localhost:5432/forge_work_activity_role_test'
PINS = {'sourceSha256': 'a' * 64, 'mainHarnessSha256': 'b' * 64, 'enrolled': True}


def predecessor():
    return {'status': 'passed', 'stage': 'complete', 'sourceSha256': PINS['sourceSha256'],
            'harnessSha256': PINS['mainHarnessSha256'], 'plan': {'timeoutsSeconds': {'statement': 20, 'lock': 12}},
            'tiers': [{'additionalUnrelatedRows': r, 'currentUnits': u, 'samplesMs': [1.0] * 20} for r, u in sorted(m.MATRIX)],
            'waits': [{'case': 'active_batch_payroll', 'observed': True, 'holderWasActive': True,
                       'controlledIdleHold': False, 'stage': 'reader_and_payroll_completed'}]}


def catalog():
    fks, indexes, triggers = [], [], []
    for t in m.TABLES:
        fks.append({'table': t, 'constraint': 'metadata_actor_retention', 'kind': 'f', 'delete': 'r', 'update': 'a',
                    'validated': True, 'deferrable': False, 'deferred': False,
                    'childColumns': ['actor_id'], 'parent': 'profiles', 'parentColumns': ['id']})
        indexes.append({'table': t, 'name': 'work_unit_metadata_actor_' + t.removeprefix('_work_unit_metadata_'),
                        'valid': True, 'ready': True, 'live': True, 'unique': False, 'keys': 1, 'attributes': 1,
                        'method': 'btree', 'predicate': None, 'expressions': None, 'column': 'actor_id'})
        for name, typ, incoming in (('RI_FKey_check_ins', 5, False), ('RI_FKey_check_upd', 17, False),
                                    ('RI_FKey_restrict_del', 9, True), ('RI_FKey_noaction_upd', 17, True)):
            triggers.append({'table': 'profiles' if incoming else t, 'constraintTable': t, 'name': 'fixture_' + name,
                             'function': name, 'functionSchema': 'pg_catalog', 'internal': True, 'type': typ,
                             'enabled': 'O', 'deferrable': False, 'deferred': False, 'opposite': True})
    return {'fks': fks, 'indexes': indexes, 'triggers': triggers}


class NoContactTests(unittest.TestCase):
    def setUp(self):
        self.subprocess = patch.object(m.subprocess, 'run', side_effect=AssertionError('FORBIDDEN SUBPROCESS'))
        self.popen = patch.object(m.subprocess, 'Popen', side_effect=AssertionError('FORBIDDEN POPEN'))
        self.run_mock = self.subprocess.start()
        self.popen_mock = self.popen.start()
        self.addCleanup(self.subprocess.stop)
        self.addCleanup(self.popen.stop)

    def test_import_has_no_environment_or_subprocess_requirement(self):
        with patch.dict(os.environ, {}, clear=True):
            fresh = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(fresh)
        self.run_mock.assert_not_called()
        self.popen_mock.assert_not_called()

    def test_default_and_check_plan_never_contact(self):
        with patch.object(m, 'validate_sources', return_value=(PINS, 'rollback;')):
            for args in ([], ['--check-plan']):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(m.main(args), 0)
                plan = json.loads(output.getvalue())
                self.assertIs(plan['databaseTests'], False)
                self.assertIs(plan['explicitExecuteRequired'], True)
        self.run_mock.assert_not_called()
        self.popen_mock.assert_not_called()

    def test_default_stale_source_refuses_without_contact(self):
        with patch.object(m, 'validate_sources', side_effect=AssertionError('source mismatch')):
            with self.assertRaisesRegex(AssertionError, 'source mismatch'):
                m.main([])
        self.run_mock.assert_not_called()

    def test_modes_mutually_exclusive(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            m.main(['--check-plan', '--execute-fixture'])

    def test_execute_without_output_never_contacts(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(AssertionError, 'distinct --out'):
            m.main(['--execute-fixture'])
        self.run_mock.assert_not_called()

    def test_source_failure_preserves_partial(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'validate_sources', side_effect=AssertionError('pin mismatch')):
            p = Path(d) / 'partial.json'
            with self.assertRaisesRegex(AssertionError, 'pin mismatch'):
                m.main(['--execute-fixture', '--out', str(p)])
            receipt = json.loads(p.read_text())
            self.assertEqual(receipt['status'], 'failed')
            self.assertEqual(receipt['failure']['message'], 'pin mismatch')
            self.assertIs(receipt['databaseContacted'], False)

    def test_predecessor_failure_preserves_partial_before_url_or_contact(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'validate_sources', return_value=(PINS, 'rollback;')):
            p, old = Path(d) / 'partial.json', Path(d) / 'old.json'
            old.write_text(json.dumps({**predecessor(), 'status': 'failed'}))
            with self.assertRaisesRegex(AssertionError, 'Predecessor'):
                m.main(['--execute-fixture', '--out', str(p), '--predecessor', str(old)])
            self.assertFalse(json.loads(p.read_text())['databaseContacted'])
            self.run_mock.assert_not_called()

    def test_bad_url_preserves_partial_after_valid_predecessor(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'validate_sources', return_value=(PINS, 'rollback;')), patch.dict(os.environ, {'WORK_ACTIVITY_ROLE_TEST_DB_URL': 'postgres://remote/production'}):
            p, old = Path(d) / 'partial.json', Path(d) / 'old.json'
            old.write_text(json.dumps(predecessor()))
            with self.assertRaisesRegex(AssertionError, 'exact localhost'):
                m.main(['--execute-fixture', '--out', str(p), '--predecessor', str(old)])
            saved = json.loads(p.read_text())
            self.assertFalse(saved['databaseContacted'])
            self.assertEqual(saved['predecessor']['status'], 'source_matched_complete')
            self.run_mock.assert_not_called()

    def test_output_cannot_overwrite_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'receipt.json'
            p.write_text('preserve me')
            with self.assertRaisesRegex(AssertionError, 'already exists'):
                m.Evidence(p)
            self.assertEqual(p.read_text(), 'preserve me')

    def test_partial_persist_before_wait(self):
        with tempfile.TemporaryDirectory() as d:
            e = m.Evidence(Path(d) / 'partial.json')
            class FakeDB:
                def wait_snapshot(self, *_):
                    saved = json.loads(e.path.read_text())
                    self.saved_stage = saved['waits'][0]['stage']
                    raise TimeoutError('genuine wait missing')
            record = {'case': 'test', 'observed': False}
            e.data['waits'].append(record)
            db = FakeDB()
            with self.assertRaises(TimeoutError):
                m.capture_wait(db, e, record, None, None)
            self.assertEqual(db.saved_stage, 'observing_actual_G')
            self.assertFalse(json.loads(e.path.read_text())['waits'][0]['observed'])


    def run_mock_performance(self, fail_post_response_validation=False):
        """Run the real performance orchestration with a simulated clock and DB.

        These durations exercise timer boundaries; none is a PG measurement.
        Reader/paid completion consumes 200 ms; later legacy validation 750 ms.
        """
        clock = {'now': 100.0}
        complete = {'legacy': 0, **dict.fromkeys(m.KEYS, 0)}
        calls = []

        class FakeDB:
            sample_calls = 0
            sample_validations = 0
            post_response_validations = 0
            paid_finished = False

            def person(self, n):
                calls.append('person')
                return m.uid(n)

            def run(self, sql):
                if sql != 'select capture_enabled from work_activity_authority_generation':
                    raise AssertionError('Unexpected mock SQL: ' + sql)
                return 't'

            def obj(self, sql, user='postgres'):
                if 'create temp table retention_measure' in sql:
                    self.sample_calls += 1
                    clock['now'] += .010
                    return {'serverMs': 12.5, 'value': complete.copy()}
                if sql.startswith('select person_record_counts('):
                    if self.paid_finished:
                        self.post_response_validations += 1
                        clock['now'] += .750
                        calls.append('post_response_validation')
                        return {'legacy': int(fail_post_response_validation)}
                    self.sample_validations += 1
                    clock['now'] += .005
                    return {'legacy': 0}
                if 'sign_toolbox_talk(' in sql:
                    calls.append('sign_toolbox_talk')
                    return {'profile_id': m.uid(50)}
                if 'clock_in(' in sql:
                    calls.append('clock_in')
                    return {'id': m.uid(501)}
                if 'end_break(' in sql:
                    calls.append('end_break')
                    return {'break_started_at': None}
                if 'clock_out(' in sql:
                    calls.append('clock_out')
                    return {'clock_out_at': 'mock-clock-out'}
                raise AssertionError('Unexpected mock SQL: ' + sql)

            def until(self, query, seconds):
                return [{'pid': 101, 'state': 'active'}]

            def wait_snapshot(self, holder, waiter, active):
                if active is not True:
                    raise AssertionError('Expected ACTIVE observation')
                clock['now'] += .030
                return [{'holderPid': holder.pid, 'waiterPid': waiter.pid,
                         'holderLogin': holder.login, 'waiterLogin': waiter.login,
                         'holderState': 'active', 'blockingPids': [holder.pid],
                         'gateClass': 7712, 'gateObject': 0}]

        class FakeSession:
            def __init__(self, db, label, sql, user='authenticator', role_sql=''):
                self.db, self.label, self.login = db, label, user
                self.is_paid = label == 'retention_paid_waiter'
                self.pid = 102 if self.is_paid else 101
                self.expected_role = 'authenticated' if self.is_paid else 'service_role'
                self.expected_actor = m.uid(50) if self.is_paid else None
                if self.is_paid:
                    if 'start_break(' not in sql or role_sql != m.auth(m.uid(50)):
                        raise AssertionError('Supported paid request/actor changed')
                    calls.append('start_break')
                    clock['now'] += .020
                elif role_sql != 'set role service_role;':
                    raise AssertionError('Expected service reader')

            def identity(self):
                return {'pid': self.pid, 'sessionUser': self.login,
                        'currentRole': self.expected_role, 'actor': self.expected_actor,
                        'statementTimeout': '20s', 'lockTimeout': '12s'}

            def finish(self):
                if self.is_paid:
                    clock['now'] += .050
                    self.db.paid_finished = True
                    calls.append('paid_response')
                    return [{'break_started_at': 'mock-break-start'}]
                clock['now'] += .100
                calls.append('reader_response')
                return [complete.copy()]

            def stop(self):
                calls.append('stop_' + self.label)

        with tempfile.TemporaryDirectory() as d:
            evidence = m.Evidence(Path(d) / 'mock-performance.json')
            db = FakeDB()
            with patch.object(m, 'Session', FakeSession), patch.object(m.time, 'monotonic', side_effect=lambda: clock['now']), contextlib.redirect_stdout(io.StringIO()):
                if fail_post_response_validation:
                    with self.assertRaisesRegex(AssertionError, 'Old census changed'):
                        m.performance(db, evidence, m.uid(1), m.uid(2))
                else:
                    m.performance(db, evidence, m.uid(1), m.uid(2))
            saved = json.loads(evidence.path.read_text())
        self.run_mock.assert_not_called()
        self.popen_mock.assert_not_called()
        self.assertEqual(db.sample_calls, 20)
        self.assertEqual(db.sample_validations, 20)
        self.assertEqual(db.post_response_validations, 1)
        self.assertEqual(len(saved['timings']), 20)
        self.assertTrue(all(t['status'] == 'passed' for t in saved['timings']))
        self.assertEqual(saved['timingSummary']['samples'], 20)
        self.assertIs(saved['timingSummary']['budgetApproved'], False)
        return saved, calls

    def test_paid_response_timer_excludes_later_legacy_validation(self):
        saved, calls = self.run_mock_performance()
        record = saved['waits'][0]
        self.assertAlmostEqual(record['paidResponseWallMs'], 200.0, places=6)
        self.assertAlmostEqual(record['requestWallMs'], 950.0, places=6)
        self.assertAlmostEqual(record['requestWallMs'] - record['paidResponseWallMs'], 750.0, places=6)
        self.assertLess(record['paidResponseWallMs'], record['requestWallMs'])
        self.assertIn('not isolated server execution or lock duration', record['paidResponseTimingMeaning'])
        self.assertIn('post-response legacy census validation', record['timingMeaning'])
        self.assertEqual(record['stage'], 'census_and_paid_completed')
        self.assertIs(record['observed'], True)
        self.assertIsNone(record['returnResult']['break_started_at'])
        self.assertEqual(saved['paidClockOut']['clock_out_at'], 'mock-clock-out')
        for name in ('sign_toolbox_talk', 'clock_in', 'start_break', 'end_break', 'clock_out'):
            self.assertEqual(calls.count(name), 1)
        self.assertLess(calls.index('paid_response'), calls.index('post_response_validation'))
        self.assertLess(calls.index('post_response_validation'), calls.index('end_break'))
        self.assertLess(calls.index('end_break'), calls.index('clock_out'))

    def test_paid_response_timer_survives_failed_later_validation_and_safety_out(self):
        saved, calls = self.run_mock_performance(fail_post_response_validation=True)
        record = saved['waits'][0]
        self.assertAlmostEqual(record['paidResponseWallMs'], 200.0, places=6)
        self.assertNotIn('requestWallMs', record)
        self.assertNotEqual(record['stage'], 'census_and_paid_completed')
        self.assertNotIn('end_break', calls)
        self.assertEqual(calls.count('clock_out'), 1)
        self.assertEqual(saved['paidClockOut']['clock_out_at'], 'mock-clock-out')


class ValidationTests(unittest.TestCase):
    def test_exact_urls_only(self):
        for scheme in ('postgresql', 'postgres'):
            for host in ('localhost', '127.0.0.1'):
                self.assertEqual(m.validate_url(URL.replace('postgresql', scheme).replace('localhost', host)).hostname, host)
        bad = [URL.replace(':fixture-only', ':other'), URL.replace(':fixture-only', ''),
               URL.replace(':5432', ''), URL.replace(':5432', ':6432'), URL.replace('localhost', '::1'),
               URL.replace('localhost', 'prod.example.com'), URL.replace('supabase_admin', 'postgres'),
               URL.replace('role_test', 'prod'), URL + '?host=prod', URL + '#anything',
               URL.replace('5432', 'bad'), '']
        for value in bad:
            with self.subTest(value=value), self.assertRaises(AssertionError):
                m.validate_url(value)

    def test_predecessor_accepts_complete_observation_without_budget_claim(self):
        value = predecessor()
        value['performanceBudget'] = 'HOLD'
        result = m.validate_predecessor(value, PINS)
        self.assertFalse(result['performanceBudgetApproved'])

    def test_predecessor_status_source_stage_and_deadlines_strict(self):
        changes = [('status', 'failed'), ('stage', 'measuring'), ('sourceSha256', 'c' * 64), ('harnessSha256', 'd' * 64)]
        for key, value in changes:
            receipt = predecessor()
            receipt[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                m.validate_predecessor(receipt, PINS)
        receipt = predecessor()
        receipt['plan']['timeoutsSeconds']['lock'] = 20
        with self.assertRaises(AssertionError):
            m.validate_predecessor(receipt, PINS)

    def test_predecessor_all_matrix_and_real_samples_required(self):
        for mutation in ('missing', 'duplicate', 'few', 'nan', 'boolean', 'negative'):
            r = predecessor()
            if mutation == 'missing': r['tiers'].pop()
            elif mutation == 'duplicate': r['tiers'][0] = copy.deepcopy(r['tiers'][1])
            elif mutation == 'few': r['tiers'][0]['samplesMs'].pop()
            else: r['tiers'][0]['samplesMs'][0] = {'nan': float('nan'), 'boolean': True, 'negative': -1}[mutation]
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                m.validate_predecessor(r, PINS)

    def test_predecessor_unobserved_or_idle_wait_never_accepted(self):
        for key, value in (('observed', False), ('holderWasActive', False), ('controlledIdleHold', True), ('stage', 'waiting')):
            r = predecessor()
            r['waits'][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                m.validate_predecessor(r, PINS)

    def test_census_preserves_all_legacy_keys(self):
        old = {'time_shifts.profile_id': 2, 'old.another': 0}
        value = {**old, **dict.fromkeys(m.KEYS, 0)}
        self.assertEqual(m.validate_counts(value, old), value)
        for changed in ({**value, 'time_shifts.profile_id': 0}, {k: v for k, v in value.items() if k != m.KEYS[0]}, {**value, 'unknown': 0}):
            with self.assertRaises(AssertionError):
                m.validate_counts(changed, old)

    def test_census_rejects_noninteger_negative_nonfinite_boolean_overflow(self):
        old = {'legacy': 0}
        for invalid in (-1, True, False, None, '0', 1.1, float('nan'), float('inf'), 9007199254740992):
            with self.subTest(invalid=invalid), self.assertRaises(AssertionError):
                m.validate_counts({**old, **dict.fromkeys(m.KEYS, 0), m.KEYS[0]: invalid}, old)

    def test_exact_catalog_admitted(self):
        m.validate_catalog(catalog())

    def test_each_fk_semantic_drift_refuses(self):
        for key, value in (('kind', 'c'), ('delete', 'c'), ('update', 'r'), ('validated', False),
                           ('deferrable', True), ('deferred', True), ('childColumns', ['id']), ('parent', 'auth.users'), ('parentColumns', ['other'])):
            c = catalog(); c['fks'][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                m.validate_catalog(c)

    def test_index_drift_refuses(self):
        for key, value in (('valid', False), ('ready', False), ('live', False), ('unique', True), ('keys', 2),
                           ('attributes', 2), ('method', 'hash'), ('predicate', 'actor_id is not null'), ('expressions', 'lower(actor_id)'), ('column', 'id')):
            c = catalog(); c['indexes'][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                m.validate_catalog(c)

    def test_incoming_outgoing_trigger_drift_refuses(self):
        for index in (0, 2):
            for key, value in (('enabled', 'D'), ('enabled', 'R'), ('internal', False), ('type', 0),
                               ('functionSchema', 'public'), ('deferrable', True), ('deferred', True), ('opposite', False), ('table', 'auth.users')):
                c = catalog(); c['triggers'][index][key] = value
                with self.subTest(index=index, key=key), self.assertRaises(AssertionError):
                    m.validate_catalog(c)
        c = catalog(); c['triggers'].pop()
        with self.assertRaises(AssertionError): m.validate_catalog(c)

    def test_error_diagnostics_require_actual_sqlstate_constraint_table(self):
        err = 'ERROR:  23001: restriction\nTABLE NAME:  _work_unit_metadata_floors\nCONSTRAINT NAME:  metadata_actor_retention\n'
        got = m.error_state(err, '23001', 'metadata_actor_retention', '_work_unit_metadata_floors')
        self.assertEqual(got['sqlstate'], '23001')
        for error, state, constraint, table in ((err, '23503', 'metadata_actor_retention', None),
                                               (err.replace('CONSTRAINT NAME:', 'DETAIL:'), None, 'metadata_actor_retention', None),
                                               (err, None, 'metadata_actor_retention', '_work_unit_metadata_commands'),
                                               ('connection refused', '42501', None, None)):
            with self.assertRaises(AssertionError): m.error_state(error, state, constraint, table)

    def test_last_authored_body_wins(self):
        bodies = m.source_bodies((m.ROOT / m.SOURCE_REL).read_text())
        self.assertIn('metadataActorRetentionTriggers', bodies['_work_unit_metadata_coverage'])
        self.assertIn("p_actor_id is not null", bodies[m.CENSUS])
        self.assertIn('person_record_counts(p_id)||', bodies[m.CENSUS])

    def test_frozen_parent_last_census_is_0844(self):
        source = (m.ROOT / 'supabase/migrations/20261108440000_work_unit_review.sql').read_text()
        import re
        self.assertIsNotNone(re.search(r'create or replace function public\.person_record_counts\(p_id uuid\).*?as \$\$(.*?)\$\$;', source, re.S))

    def test_fixture_seed_is_labeled_and_does_not_disable_controls(self):
        for i, table in enumerate(m.TABLES):
            seed = m.isolated_insert(table, m.uid(20 + i), i)
            self.assertIn('insert into ' + table, seed)
            self.assertIn('2000-01-01', seed)
            self.assertNotIn('disable', seed.lower())
            self.assertNotIn('work_unit_metadata_command(', seed)

    def test_runtime_session_settings_and_environment_are_fixed(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {'PGHOST': 'remote', 'PGOPTIONS': '-c statement_timeout=0'}):
            db = m.DB(m.validate_url(URL), m.Evidence(Path(d) / 'test.json'))
            self.assertNotIn('PGHOST', db.env)
            self.assertNotIn('PGOPTIONS', db.env)
            self.assertEqual(db.env['PGCONNECT_TIMEOUT'], '3')
            self.assertIn('authenticator:fixture-only@localhost:5432', db.argv('authenticator')[1])
            with self.assertRaises(AssertionError): db.argv('service_role')
            self.assertIn("statement_timeout='20s'", m.SETTINGS)
            self.assertIn("lock_timeout='12s'", m.SETTINGS)

    def test_successful_held_sessions_not_mislabeled_active(self):
        source = PATH.read_text()
        self.assertNotIn('pg_sleep', source)
        self.assertNotIn('re.sub(r\'rollback', source)
        self.assertNotIn('capture_enabled=true', source)
        self.assertEqual(source.count("'paidPerformanceClaim': False"), 3)
        self.assertIn('for attempt in range(2)', source)
        self.assertIn("'controlledIdleHold': False", source)
        self.assertIn('and l.classid=7712 and l.objid=0 and l.objsubid=2 and not l.granted', source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
