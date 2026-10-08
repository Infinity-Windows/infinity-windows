#!/usr/bin/env python3
"""No-contact source/control-flow tests; no PostgreSQL results are simulated as evidence."""
import ast
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import select
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).with_name('verify-work-unit-metadata-transition-trial.py')
spec=importlib.util.spec_from_file_location('transition_trial',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
TARGET='postgresql://supabase_admin:fixture-only@localhost:5432/forge_work_activity_role_test'
INSTANCE={'systemIdentifier':'123','postmasterStart':'456','databaseOid':'42','database':m.DATABASE,'serverVersionNum':'170006'}


def good_receipt(profile):
    return {'status':'passed','stage':'complete','checks':92,'sourceSha256':profile['sourceSha256'],'harnessSha256':profile['mainHarnessSha256'],'plan':{'timeoutsSeconds':{'statement':20,'lock':12}},'tiers':[{'additionalUnrelatedRows':n,'currentUnits':u,'samplesMs':[1.0]*20} for n in (0,1000,10000) for u in (1,10,100)],'waits':[{'case':'active_batch_payroll','observed':True,'holderWasActive':True,'controlledIdleHold':False,'stage':'reader_and_payroll_completed'}]}


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.profile,cls.bodies=m.validate_source()
    def test_reviewed_input_hashes_and_exact_transition_only_change(self):
        self.assertEqual(self.profile['candidateBodySha256'],'9f39e62075a8e002c438c0fd2e80ca7b0a8cb7eca45b221d3f59d1088814c34a')
        old=self.bodies['old-transition-block.sql'].removesuffix('\n');new=self.bodies['candidate-transition-block.sql'].removesuffix('\n')
        self.assertEqual(self.bodies['candidate-scope-body.sql'].replace(new,old,1),self.bodies['old-scope-body.sql'])
    def test_default_and_plan_no_process_db_or_output(self):
        with patch.object(m,'Session',side_effect=AssertionError('no DB')),patch.object(m,'Report',side_effect=AssertionError('no output')),patch.object(m.subprocess,'Popen',side_effect=AssertionError('no process')),contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(m.main([]),0);self.assertEqual(m.main(['--check-plan']),0)
        for line in out.getvalue().splitlines():self.assertFalse(json.loads(line)['databaseContacted'])
    def test_source_drift_refuses_before_process(self):
        with patch.object(m,'sha',return_value='0'*64),self.assertRaisesRegex(RuntimeError,'profile drift'):m.validate_source()
    def test_bad_modes_and_outputs_refused(self):
        for args in [['--check-plan','--execute-fixture'],['--check-plan','--output','/tmp/not-used'],['--execute-fixture']]:
            with self.assertRaises(RuntimeError):m.main(args)
    def test_strict_url(self):
        m.validate_url(TARGET)
        for bad in ['',TARGET.replace(':5432',''),TARGET.replace('localhost','remote'),TARGET.replace('5432','5433'),TARGET.replace('fixture-only','password'),TARGET.replace('supabase_admin','postgres'),TARGET+'?host=remote',TARGET+'#fragment',TARGET.replace('5432','oops'),TARGET.replace(m.DATABASE,'postgres')]:
            with self.subTest(url=bad),self.assertRaises(RuntimeError):m.validate_url(bad)
    def test_predecessor_count_and_all_nine_twenty_sample_tiers(self):
        good=good_receipt(self.profile);m.validate_predecessor(good,self.profile)
        for field,value in [('checks',91),('status','running'),('stage','incomplete'),('sourceSha256','bad'),('harnessSha256','bad'),('waits',[]),('tiers',good['tiers'][:-1]),('plan',{})]:
            with self.subTest(field=field),self.assertRaises(RuntimeError):m.validate_predecessor({**good,field:value},self.profile)
        for bad in [float('nan'),float('inf'),-1,True]:
            v=copy.deepcopy(good);v['tiers'][0]['samplesMs'][0]=bad
            with self.assertRaises(RuntimeError):m.validate_predecessor(v,self.profile)
    def test_instance_identity_requires_complete_pg17(self):
        m.validate_instance(INSTANCE)
        for value in [{**INSTANCE,'serverVersionNum':'160001'},{**INSTANCE,'database':'production'},{**INSTANCE,'extra':'x'},{}]:
            with self.assertRaises(RuntimeError):m.validate_instance(value)
    def test_owner_session_semantics_and_timeouts(self):
        identity={**INSTANCE,'pid':1,'backendStart':'789','sessionUser':'postgres','currentUser':'postgres','superuser':False,'statementTimeout':'20s','lockTimeout':'12s','isolation':'read committed','planCacheMode':'auto','standardConformingStrings':'on','actor':m.ident(1)}
        self.assertEqual(m.identity_valid(identity,INSTANCE,m.ident(1)),(1,'789'))
        for key,value in [('sessionUser','authenticator'),('currentUser','authenticated'),('superuser',True),('statementTimeout','30s'),('lockTimeout','20s'),('planCacheMode','force_custom_plan'),('standardConformingStrings','off'),('actor',m.ident(2)),('databaseOid','43')]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):m.identity_valid({**identity,key:value},INSTANCE,m.ident(1))
    def test_native_identity_guard_and_all_six_mappings(self):
        valid='abcdefab-cdef-abcd-efab-cdefabcdefab'
        entries=[{'kind':kind,'id':valid} for kind in m.KINDS]
        self.assertEqual(len(m.keys(entries)),6);self.assertEqual(m.keys(entries*3),m.keys(entries))
        for invalid in [None,123,valid.upper(),'{'+valid+'}',valid.replace('-',''),' '+valid,valid+'\n']:
            self.assertEqual(m.keys([{'kind':'custom_work_sessions','id':invalid}]),[])
        self.assertEqual(m.keys([None,{},1,{'kind':'setup','id':valid},{'kind':'unknown','id':valid},{'kind':'custom_work_units','id':valid}]),[])
    def test_prepared_selector_is_exact_authored_parameterized_sql(self):
        for variant in ('old','candidate'):
            sql=m.selector_sql(self.bodies,variant)
            self.assertIn('$1',sql);self.assertNotIn('into normal_sources',sql);self.assertNotIn('jsonb_array_elements(sourceids)',sql)
        self.assertIn('select distinct case',m.selector_sql(self.bodies,'candidate'))
        self.assertIn("then (x->>'id')::uuid end",m.selector_sql(self.bodies,'candidate'))
    def test_main_has_one_owner_session_and_no_repair_or_planner_override(self):
        text=SCRIPT.read_text();tree=ast.parse(text)
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main');src=ast.get_source_segment(text,main)
        self.assertEqual(src.count('Session(target,report)'),1);self.assertEqual(src.count("Session(target,report,user='supabase_admin')"),1)
        for forbidden in ['create or replace function','set role ','plan_cache_mode=','create index','alter role','disable trigger']:
            self.assertNotIn(forbidden,text)
        self.assertIn("metadata_scope_transition_probe",text);self.assertIn("security invoker",text)
        self.assertIn('before_owned_main_process',text)
    def test_full_parity_holds_not_relabelled(self):
        self.assertTrue(any('184' in s for s in self.profile['held']));self.assertTrue(any('168' in s for s in self.profile['held']));self.assertTrue(any('All18' in s for s in self.profile['held']))
        self.assertEqual(len(self.profile['scopeCases']),4)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.out=Path(self.temp.name)/'new'/m.NAME;self.report=m.Report(self.out);self.p,self.b=m.validate_source()
    def test_partial_written_before_validation_failure(self):
        with tempfile.TemporaryDirectory() as d:
            out=Path(d)/'fresh'/m.NAME
            with patch.object(m,'validate_source',side_effect=RuntimeError('source failed')),patch.object(m,'Session',side_effect=AssertionError('no DB')),self.assertRaisesRegex(RuntimeError,'source failed'):m.main(['--execute-fixture','--output',str(out)])
            data=json.loads(out.read_text());self.assertEqual(data['status'],'failed');self.assertFalse(data['databaseContacted'])
    def test_output_never_overwrites_and_must_be_outside_checkout(self):
        for path in [self.out,Path('relative')/m.NAME,m.ROOT/'new'/m.NAME,Path(self.temp.name)/'other'/'wrong.json']:
            with self.assertRaises(RuntimeError):m.Report(path)
    def test_case_equality_checks_whole_order_and_exact_text(self):
        good={'ms':1,'value':{'ordered':[1,2],'token':'x'},'valueText':'{"ordered": [1, 2], "token": "x"}','review':{'a':1},'reviewText':'{"a": 1}'}
        m.result_equal(good,copy.deepcopy(good))
        for field,value in [('value',{'ordered':[2,1],'token':'x'}),('valueText','different'),('review',None),('reviewText','different')]:
            with self.assertRaises(RuntimeError):m.result_equal(good,{**good,field:value})
    def test_summary_requires_actual_finite_twenty_samples(self):
        self.assertEqual(m.summary(list(range(20))),{'medianMs':9.5,'p95Ms':18,'maxMs':19})
        for bad in [[1]*19,[1]*19+[True],[1]*19+[float('nan')]]:
            with self.assertRaises(RuntimeError):m.summary(bad)
    def test_same_session_six_warmups_and_twenty_paired_calls_exclude_warmups(self):
        outer=self;calls=[]
        class T(m.Trial):
            def timed(inner,expression,label,review=False):
                calls.append((id(inner.s),label,review));value={'unit':{'id':m.ident(30)},'manifest':{'transitions':[{'id':'existing'}]}}
                return {'ms':999 if '_warmups_' in label else 2,'value':value,'valueText':m.encoded(value),'review':{'full':'review'},'reviewText':'{"full":"review"}'}
        session=object();t=T(session,self.report,self.p,self.b,INSTANCE)
        members={m.ident(30):[{'kind':'custom_work_sessions','id':m.ident(99)}]}
        t.scopes([('supported_populated_unit',[m.ident(30)],members)])
        case=self.report.data['cases'][0];self.assertEqual(len(case['warmups']),6);self.assertEqual(len(case['pairs']),20)
        self.assertEqual(len(calls),52);self.assertEqual({x[0] for x in calls},{id(session)})
        self.assertEqual(case['summary']['old']['medianMs'],2)
        self.assertEqual(case['pairs'][0]['order'],['old','candidate']);self.assertEqual(case['pairs'][1]['order'],['candidate','old'])
        self.assertTrue(all(x[2] is True for x in calls));self.assertEqual(len(list(self.out.parent.glob('supported*.json'))),26)
    def test_mismatch_preserves_full_results_before_refusal(self):
        class T(m.Trial):
            def timed(self,expression,label,review=False):
                value={'different':label.endswith('candidate')};return {'ms':1,'value':value,'valueText':m.encoded(value),'review':None,'reviewText':None}
        t=T(object(),self.report,self.p,self.b,INSTANCE)
        with self.assertRaisesRegex(RuntimeError,'Whole ordered scope'):t.scopes([('supported_populated_unit',[m.ident(30)],{m.ident(30):[]})])
        entry=self.report.data['cases'][0]['warmups'][0];self.assertEqual(entry['equality'],'pending')
        full=json.loads(Path(entry['fullResults']['path']).read_text());self.assertIn('old',full);self.assertIn('candidate',full)
    def test_prepared_plans_before_and_after_six_executes_same_session(self):
        calls=[]
        class S:
            def query(self,sql,label):calls.append(('query',sql,label));return ''
        class T(m.Trial):
            def plan(self,sql,label):calls.append(('plan',sql,label));return [{'Plan':{'mock':True}}]
            def query(self,sql,label):calls.append(('json',sql,label));return [] if sql.startswith('execute') else {'genericPlans':0,'customPlans':7,'parameterTypes':'{jsonb}'}
        t=T(S(),self.report,self.p,self.b,INSTANCE);units=[m.ident(30)];t.plans([('supported_populated_unit',units,{units[0]:[{'kind':'custom_work_sessions','id':m.ident(99)}]}),('existing_empty_key_unit',units,{units[0]:[]})])
        self.assertEqual(len(t.prepared),2)
        for record in self.report.data['plans']:
            self.assertEqual(len(record['warmupExecutions']),6);self.assertTrue(record['notInternalPLpgSQLPlan'])
        self.assertEqual(sum(c[0]=='plan' for c in calls),8);self.assertEqual(sum(c[0]=='json' and c[1].startswith('execute') for c in calls),24)
        self.assertTrue(all('$1' in c[1] and '(jsonb)' in c[1] for c in calls if c[0]=='query'))
    def test_primary_and_cleanup_error_persist_without_masking(self):
        outer=self
        class T(m.Trial):
            def admit(inner):raise ValueError('original failure')
            def cleanup(inner):
                saved=json.loads(outer.out.read_text());outer.assertEqual(saved['primaryFailure']['message'],'original failure');raise RuntimeError('cleanup failure')
        with self.assertRaisesRegex(ValueError,'original failure'):T(None,self.report,self.p,self.b,INSTANCE).run()
        saved=json.loads(self.out.read_text());self.assertEqual(saved['cleanupFailure']['message'],'cleanup failure');self.assertEqual(saved['primaryFailure']['type'],'ValueError')
    def test_timing_clock_ends_before_review_and_quote_safe_do(self):
        calls=[]
        class T(m.Trial):
            def query(self,sql,label):calls.append(sql);return {'ms':0.25,'value':None,'valueText':None,'review':None,'reviewText':None}
        t=T(None,self.report,self.p,self.b,INSTANCE)
        t.timed(m.json_literal({'untrusted':"$measure$'; select 99; --"}),'synthetic',review='batch')
        sql=calls[0];self.assertIn(";do 'declare",sql);self.assertNotIn(';do $measure$',sql)
        self.assertLess(sql.index('ms:=extract'),sql.index('_work_unit_metadata_review'))
        self.assertIn('with ordinality',sql);self.assertIn("''; select 99; --",sql)
        t.plan("execute metadata_trial_old('[]'::jsonb)",'prepared')
        self.assertIn(";do 'declare",calls[1]);self.assertIn('explain(analyze,buffers,verbose,format json) execute',calls[1])
    def test_authored_owner_attributes_refuse_before_clone(self):
        calls=[];outer=self
        identity={**INSTANCE,'pid':1,'backendStart':'789','sessionUser':'postgres','currentUser':'postgres','superuser':False,'statementTimeout':'20s','lockTimeout':'12s','isolation':'read committed','planCacheMode':'auto','standardConformingStrings':'on','actor':m.ident(1)}
        class S:
            def query(self,sql,label):calls.append((sql,label));return ''
        class T(m.Trial):
            def query(self,sql,label):
                calls.append((sql,label))
                if label=='owner_identity_before':return identity
                return {**m.expected_metadata('_work_unit_metadata_scope',outer.b['old-scope-body.sql']),'definer':False}
        with self.assertRaisesRegex(RuntimeError,'Exact authored body'):T(S(),self.report,self.p,self.b,INSTANCE).admit()
        self.assertFalse(any('create function' in sql for sql,_ in calls))
        lock=next(sql for sql,label in calls if label=='G7712_before_A7710')
        self.assertLess(lock.index('7712'),lock.index('7710'))
    def test_membership_profile_keeps_whole_helper_one_ten_hundred(self):
        calls=[]
        class T(m.Trial):
            def plan(self,sql,label):calls.append(('plan',sql,label));return [{'Plan':{'mock':True}}]
            def query(self,sql,label):calls.append(('query',sql,label));return {'versions':0}
            def timed(self,expression,label,review=False):
                calls.append(('timed',expression,label));size=int(label.split('_')[1]);return {'ms':1,'value':self.case_data[size][1],'valueText':'{}'}
        t=T(None,self.report,self.p,self.b,INSTANCE)
        for size in (1,10,100):
            units=[m.ident(1000+n) for n in range(size)];t.case_data[size]=(units,{u:[] for u in units})
        t.members_profile()
        self.assertEqual([r['size'] for r in self.report.data['membershipProfiles']],[1,10,100])
        self.assertTrue(all(len(r['warmups'])==6 and len(r['samples'])==20 for r in self.report.data['membershipProfiles']))
        for kind,sql,label in calls:
            if kind=='plan':self.assertIn('with versions as materialized',sql);self.assertNotIn('p_units',sql)
            if kind=='query':self.assertIn('(select count(*) from versions)',sql);self.assertIn('(select count(*) from selected)',sql)
    def test_cleanup_failure_after_success_is_fatal(self):
        class T(m.Trial):
            def admit(self):pass
            def capture_members(self):return []
            def plans(self,*a):pass
            def scopes(self,*a):pass
            def members_profile(self):pass
            def guard_profile(self):pass
            def guard(self):pass
            def query(self,sql,label):return {} if label=='final_census' else identity
            def cleanup(self):raise RuntimeError('cleanup only')
        identity={**INSTANCE,'pid':1,'backendStart':'789','sessionUser':'postgres','currentUser':'postgres','superuser':False,'statementTimeout':'20s','lockTimeout':'12s','isolation':'read committed','planCacheMode':'auto','standardConformingStrings':'on','actor':m.ident(1)}
        self.report.data['baselineCensus']={};t=T(None,self.report,self.p,self.b,INSTANCE);t.identity=(1,'789')
        with self.assertRaisesRegex(RuntimeError,'cleanup only'):t.run()
        self.assertNotEqual(self.report.data['status'],'passed_limited_characterization');self.assertFalse(self.report.data['fixtureExecuted'])
    def test_rollback_and_explicit_prepared_temp_cleanup(self):
        calls=[]
        class S:
            def query(self,sql,label):calls.append(sql)
            def json(self,sql,label):calls.append(sql);return True
        t=m.Trial(S(),self.report,self.p,self.b,INSTANCE);t.prepared=['metadata_trial_old','metadata_trial_candidate'];t.cleanup()
        self.assertEqual(calls[:3],['rollback','deallocate metadata_trial_old','deallocate metadata_trial_candidate']);self.assertTrue(self.report.data['cleanup']['temporaryObjectsAbsent'])
    def test_owned_predecessor_is_executed_and_instance_bound(self):
        outer=self;calls=[]
        class Admin:
            def json(self,sql,label):calls.append(label);return True if label=='main_not_preinstalled' else INSTANCE
        class Process:
            def wait(self,timeout):return 0
            def poll(self):return 0
        def launch(args,**kw):
            saved=json.loads(outer.out.read_text());outer.assertEqual(saved['stage'],'before_owned_main_process')
            Path(kw['env']['WORK_UNIT_METADATA_COHORTS_PG_OUT']).write_text(json.dumps(good_receipt(outer.p)))
            outer.assertEqual(args,[m.sys.executable,str(m.ROOT/m.MAIN)]);return Process()
        got=m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),launch)
        self.assertEqual(got,INSTANCE);self.assertEqual(calls,['instance_before_main','main_not_preinstalled','instance_after_main']);self.assertFalse(self.report.data['predecessor']['budgetAcceptance'])
    def test_preinstalled_main_refused_without_process(self):
        class Admin:
            def json(self,sql,label):return INSTANCE if label=='instance_before_main' else False
        with self.assertRaisesRegex(RuntimeError,'0848 absent'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),lambda *a,**k: self.fail('must not launch'))
    def test_predecessor_primary_and_cleanup_failures_both_retained(self):
        outer=self
        class Admin:
            def json(self,sql,label):return INSTANCE if label=='instance_before_main' else True
        class P:
            def wait(self,timeout):raise ValueError('predecessor failure')
            def poll(self):return None
            def kill(self):
                outer.assertEqual(json.loads(outer.out.read_text())['predecessorPrimaryFailure']['message'],'predecessor failure')
                raise RuntimeError('predecessor cleanup failure')
        with self.assertRaisesRegex(ValueError,'predecessor failure'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),lambda *a,**k:P())
        saved=json.loads(self.out.read_text());self.assertEqual(saved['predecessorCleanupFailure']['message'],'predecessor cleanup failure')
    def test_predecessor_instance_change_refuses(self):
        outer=self
        class Admin:
            def json(self,sql,label):return True if label=='main_not_preinstalled' else ({**INSTANCE,'postmasterStart':'999'} if label=='instance_after_main' else INSTANCE)
        class P:
            def wait(self,timeout):return 0
            def poll(self):return 0
        def launch(*a,**kw):Path(kw['env']['WORK_UNIT_METADATA_COHORTS_PG_OUT']).write_text(json.dumps(good_receipt(outer.p)));return P()
        with self.assertRaisesRegex(RuntimeError,'instance changed'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,Admin(),launch)
    def test_persistent_transport_one_process_multiple_queries_and_pre_wait_receipt(self):
        outer=self;launched=[]
        class Process:
            def __init__(self,**kw):self.kw=kw;self.returncode=None;self.stdin=self
            def write(self,text):
                if text=='\\q\n':self.returncode=0;return
                saved=json.loads(outer.out.read_text());outer.assertEqual(saved['calls'][-1]['status'],'waiting')
                marker=re.search(r'\\echo (trial_done_\d+)',text)[1];self.kw['stdout'].seek(0,2);self.kw['stdout'].write(('true' if 'to_jsonb(true)' in text else 't')+'\n'+marker+'\n');self.kw['stdout'].flush()
            def flush(self):pass
            def poll(self):return self.returncode
            def wait(self,timeout):return self.returncode
        def launch(args,**kw):launched.append((args,kw));return Process(**kw)
        with patch.dict(os.environ,{'PGHOST':'unsafe','PGOPTIONS':'-c role=authenticated'}):s=m.Session(m.validate_url(TARGET),self.report,launch=launch)
        self.assertTrue(s.json('select to_jsonb(true)','first'));self.assertTrue(s.json('select to_jsonb(true)','second'));s.close()
        self.assertEqual(len(launched),1);self.assertNotIn('PGHOST',launched[0][1]['env']);self.assertNotIn('PGOPTIONS',launched[0][1]['env']);self.assertEqual(len(self.report.data['calls']),2)
    def scalar_wire_session(self,values):
        # Model the exact psql scalar text boundary, not SQL evaluation. The
        # actual Session.query marker/collection and Session.json decoder run.
        outer=self
        class Process:
            def __init__(self,**kw):self.kw=kw;self.returncode=None;self.stdin=self
            def write(self,text):
                if text=='\\q\n':self.returncode=0;return
                label=outer.report.data['calls'][-1]['label'];value=values.get(label,'')
                if callable(value):raw=value(text)
                elif type(value) is bool:raw=json.dumps(value) if text.lstrip().startswith('select to_jsonb(') else ('t' if value else 'f')
                elif isinstance(value,(dict,list)):raw=json.dumps(value)
                elif label=='fresh_synthetic_actor':raw='' if value is None else (json.dumps(value) if text.lstrip().startswith('select to_jsonb(') else value)
                else:raw=value
                marker=re.search(r'\\echo (trial_done_\d+)',text)[1]
                self.kw['stdout'].seek(0,2);self.kw['stdout'].write(raw+'\n'+marker+'\n');self.kw['stdout'].flush()
            def flush(self):pass
            def poll(self):return self.returncode
            def wait(self,timeout):return self.returncode
        session=m.Session(m.validate_url(TARGET),self.report,launch=lambda args,**kw:Process(**kw))
        self.addCleanup(session.close);return session
    def test_real_decoder_accepts_serialized_scalars_and_rejects_raw_psql_text(self):
        uid=m.ident(1);s=self.scalar_wire_session({'json_bool':True,'raw_bool':True,'json_uuid':lambda text:json.dumps(uid),'raw_uuid':lambda text:uid})
        self.assertIs(s.json('select to_jsonb(true)','json_bool'),True)
        with self.assertRaises(json.JSONDecodeError):s.json('select true','raw_bool')
        self.assertEqual(s.json("select to_jsonb('"+uid+"'::uuid)",'json_uuid'),uid)
        with self.assertRaises(json.JSONDecodeError):s.json("select '"+uid+"'::uuid",'raw_uuid')
        self.assertTrue(all(c['status']=='returned' for c in self.report.data['calls']))
    def test_predecessor_admission_uses_serialized_boolean_and_false_still_refuses(self):
        values={'instance_before_main':INSTANCE,'main_not_preinstalled':True};s=self.scalar_wire_session(values);calls=[]
        def launch(*args,**kwargs):calls.append(args);raise RuntimeError('process boundary reached')
        with self.assertRaisesRegex(RuntimeError,'process boundary reached'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,s,launch)
        self.assertEqual(len(calls),1)
        values['main_not_preinstalled']=False
        with self.assertRaisesRegex(RuntimeError,'0848 absent'):m.run_predecessor(m.validate_url(TARGET),self.report,self.p,s,lambda *a,**k:self.fail('must not launch'))
    def test_fresh_actor_serialization_retains_exact_actor_refusal(self):
        actor=m.ident(1);identity={**INSTANCE,'pid':1,'backendStart':'789','sessionUser':'postgres','currentUser':'postgres','superuser':False,'statementTimeout':'20s','lockTimeout':'12s','isolation':'read committed','planCacheMode':'auto','standardConformingStrings':'on','actor':actor}
        values={'owner_identity_before':identity,'fresh_synthetic_actor':actor}
        for name,body in [('_work_unit_metadata_scope','old-scope-body.sql'),('_work_unit_metadata_members','members-body.sql'),('_work_unit_metadata_coverage','coverage-body.sql')]:values['authored_attributes_'+name]=m.expected_metadata(name,self.b[body])
        s=self.scalar_wire_session(values);t=m.Trial(s,self.report,self.p,self.b,INSTANCE)
        with patch.object(t,'guard',side_effect=RuntimeError('actor boundary passed')),self.assertRaisesRegex(RuntimeError,'actor boundary passed'):t.admit()
        for wrong in [m.ident(2),'']:
            values['fresh_synthetic_actor']=wrong
            with self.subTest(actor=wrong),patch.object(t,'guard',side_effect=AssertionError('must not pass')),self.assertRaisesRegex(RuntimeError,'Eligible synthetic actor'):t.admit()
        # SQL NULL through to_jsonb is still a null/blank psql cell, not JSON null.
        values['fresh_synthetic_actor']=None
        with patch.object(t,'guard',side_effect=AssertionError('must not pass')),self.assertRaises(json.JSONDecodeError):t.admit()
    def test_cleanup_serialized_true_passes_and_false_remains_fatal(self):
        values={'temp_cleanup_check':True};s=self.scalar_wire_session(values);t=m.Trial(s,self.report,self.p,self.b,INSTANCE);t.cleanup()
        self.assertTrue(self.report.data['cleanup']['temporaryObjectsAbsent']);values['temp_cleanup_check']=False;self.report.data['cleanup']={}
        with self.assertRaisesRegex(RuntimeError,'Temporary objects survived rollback'):t.cleanup()
        self.assertTrue(self.report.data['cleanup']['rollbackConfirmed']);self.assertNotIn('temporaryObjectsAbsent',self.report.data['cleanup']);self.assertTrue(self.report.data['cleanup']['errors'])
    def test_transport_timeout_is_bounded_and_partial_survives(self):
        class P:
            returncode=None
            def __init__(self):self.stdin=self
            def write(self,*a):pass
            def flush(self):pass
            def poll(self):return None
        s=m.Session(m.validate_url(TARGET),self.report,launch=lambda *a,**k:P())
        with patch.object(m.time,'monotonic',side_effect=[0,36,37]),self.assertRaisesRegex(RuntimeError,'35 seconds'):s.query('select true','blocked')
        self.assertEqual(json.loads(self.out.read_text())['calls'][-1]['status'],'waiting');getattr(s,'reader',s.out).close();s.out.close();s.err.close()


class NativeTransportTests(unittest.TestCase):
    """Actual Python children/file descriptors; never a database or psql result."""
    CHILD = r"""
import json,os,sys,time
mode=sys.argv[1]
def write(data):
    while data:
        n=os.write(1,data);data=data[n:]
for line in sys.stdin:
    if line=='\\q\n':
        if mode=='linger':time.sleep(30)
        break
    if not line.startswith('\\echo '):continue
    marker=line[6:].strip().encode()
    value={'value':'x'*2423450+'é🙂','literal':'trial_done_1','order':[3,2,1]}
    data=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()+b'\n'
    if mode=='race':
        write(data);os.write(int(sys.argv[2]),b'R')
        assert os.read(int(sys.argv[3]),1)==b'G'
        write(marker+b'\n');os.write(int(sys.argv[2]),b'D')
    elif mode=='partial':
        split=data.index('é'.encode())+1
        write(data[:split]);time.sleep(.04);write(data[split:])
        write(marker[:5]);time.sleep(.04);write(marker[5:]);time.sleep(.04);write(b'\n')
    elif mode=='trailing':write(data+marker+b'\nUNEXPECTED\n')
    elif mode=='duplicate':write(data+marker+b'\n'+marker+b'\n')
    elif mode=='unterminated':write(data+marker);sys.exit(0)
    elif mode=='wrong':write(data+b'trial_done_999\n');sys.exit(0)
    elif mode=='stderr':
        os.write(2,b'ERROR: controlled child failure\n');sys.exit(7)
    elif mode=='invalid_utf8':write(b'\xff\n'+marker+b'\n')
    else:write(data+marker+b'\n')
"""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.report=m.Report(Path(self.temp.name)/'new'/m.NAME)
    def start(self,mode,pass_fds=(),extra=()):
        launched=[]
        def launch(args,**kwargs):
            self.assertEqual(args[0],'psql')
            saved=json.loads(self.report.path.read_text());self.assertEqual(saved['stage'],'before_postgres_connection')
            proc=subprocess.Popen([sys.executable,'-u','-c',self.CHILD,mode,*map(str,extra)],pass_fds=pass_fds,**kwargs)
            launched.append(proc);return proc
        s=m.Session(m.validate_url(TARGET),self.report,launch=launch)
        def cleanup():
            try:s.close()
            except (RuntimeError,BrokenPipeError):pass
            if s.proc.poll() is None:s.proc.kill();s.proc.wait(timeout=5)
            if s.proc.stdin is not None:s.proc.stdin.close()
        self.addCleanup(cleanup)
        return s,launched
    def expected(self):return {'value':'x'*2423450+'é🙂','literal':'trial_done_1','order':[3,2,1]}
    def test_real_child_shared_offset_interleaving_preserves_entire_large_result(self):
        ready_r,ready_w=os.pipe();resume_r,resume_w=os.pipe()
        for fd in [ready_r,ready_w,resume_r,resume_w]:self.addCleanup(os.close,fd)
        s,_=self.start('race',(ready_w,resume_r),(ready_w,resume_r))
        # Force exactly the shared-offset failure schedule after the child writes
        # the full result, before it writes the completion marker. This wraps
        # the collector used by Session itself, not a reimplementation of query.
        outer=self;name='reader' if hasattr(s,'reader') else 'out';handle=getattr(s,name)
        class Reader:
            first=True
            def seek(self,offset):
                if self.first:
                    self.first=False
                    outer.assertTrue(select.select([ready_r],[],[],5)[0]);outer.assertEqual(os.read(ready_r,1),b'R')
                    handle.seek(offset);os.write(resume_w,b'G')
                    outer.assertTrue(select.select([ready_r],[],[],5)[0]);outer.assertEqual(os.read(ready_r,1),b'D')
                else:handle.seek(offset)
            def __getattr__(self,name):return getattr(handle,name)
        setattr(s,name,Reader())
        self.assertEqual(s.json('select fixture_value','large_race'),self.expected())
        raw=s.out_path.read_bytes();self.assertTrue(raw.startswith(b'{"value":'));self.assertTrue(raw.endswith(b'\ntrial_done_1\n'))
        self.assertEqual(json.loads(raw.splitlines()[0]),self.expected());s.close()
        self.assertTrue(s.reader.closed and s.out.closed and s.err.closed)
    def test_real_child_partial_unicode_and_marker_need_complete_newline(self):
        s,_=self.start('partial');self.assertEqual(s.json('select fixture_value','partial'),self.expected())
        self.assertTrue(s.out_path.read_bytes().endswith(b'trial_done_1\n'))
    def test_real_child_one_process_two_large_responses_preserves_history(self):
        s,launched=self.start('normal')
        self.assertEqual(s.json('select fixture_value','first'),self.expected());first=s.out_path.read_bytes()
        self.assertEqual(s.json('select fixture_value','second'),self.expected());raw=s.out_path.read_bytes()
        self.assertTrue(raw.startswith(first));self.assertEqual(raw.count(b'\ntrial_done_'),2);self.assertEqual(len(launched),1)
        self.assertEqual([c['status'] for c in self.report.data['calls']],['returned','returned'])
    def test_real_child_trailing_output_refuses_and_retains_raw_evidence(self):
        s,_=self.start('trailing')
        with self.assertRaisesRegex(RuntimeError,'Unexpected trailing'):s.query('select fixture_value','trailing')
        self.assertTrue(s.out_path.read_bytes().endswith(b'UNEXPECTED\n'));self.assertEqual(self.report.data['calls'][-1]['status'],'waiting')
    def test_real_child_duplicate_marker_refuses(self):
        s,_=self.start('duplicate')
        with self.assertRaisesRegex(RuntimeError,'Unexpected trailing'):s.query('select fixture_value','duplicate')
    def test_real_child_unterminated_marker_does_not_return_on_exit(self):
        s,_=self.start('unterminated')
        with self.assertRaisesRegex(RuntimeError,'Persistent psql exited'):s.query('select fixture_value','unterminated')
        self.assertEqual(self.report.data['calls'][-1]['status'],'waiting')
    def test_real_child_wrong_marker_is_not_completion(self):
        s,_=self.start('wrong')
        with self.assertRaisesRegex(RuntimeError,'Persistent psql exited'):s.query('select fixture_value','wrong')
    def test_real_child_error_retains_stderr_and_close_refuses(self):
        s,_=self.start('stderr')
        with self.assertRaisesRegex(RuntimeError,'controlled child failure'):s.query('select fixture_value','error')
        with self.assertRaisesRegex(RuntimeError,'psql failure'):s.close()
        self.assertTrue(s.reader.closed and s.out.closed and s.err.closed);self.assertIn('controlled child failure',s.err_path.read_text())
    def test_real_child_invalid_utf8_is_not_repaired(self):
        s,_=self.start('invalid_utf8')
        with self.assertRaises(UnicodeDecodeError):s.json('select fixture_value','invalid_utf8')
        self.assertTrue(s.out_path.read_bytes().startswith(b'\xff'))
    def test_real_child_forced_close_is_failure_and_releases_handles(self):
        s,_=self.start('linger');wait=s.proc.wait;calls=[]
        def bounded_wait(timeout):
            calls.append(timeout)
            if len(calls)==1:raise subprocess.TimeoutExpired('controlled child',timeout)
            return wait(timeout=timeout)
        with patch.object(s.proc,'wait',side_effect=bounded_wait),self.assertRaisesRegex(RuntimeError,'forced termination'):s.close()
        self.assertIsNotNone(s.proc.poll());self.assertTrue(s.reader.closed and s.out.closed and s.err.closed)
        self.assertEqual(calls,[5,5])
    def test_failed_launch_closes_separate_handles_and_retains_partial(self):
        handles=[]
        def launch(*args,**kwargs):handles.extend([kwargs['stdout'],kwargs['stderr']]);raise OSError('controlled launch failure')
        with self.assertRaisesRegex(OSError,'controlled launch failure'):m.Session(m.validate_url(TARGET),self.report,launch=launch)
        self.assertTrue(all(h.closed for h in handles));self.assertEqual(json.loads(self.report.path.read_text())['stage'],'before_postgres_connection')
    def test_source_never_repositions_inherited_output_descriptor(self):
        src=ast.get_source_segment(SCRIPT.read_text(),next(x for x in ast.parse(SCRIPT.read_text()).body if isinstance(x,ast.ClassDef) and x.name=='Session'))
        self.assertNotIn('self.out.seek',src);self.assertNotIn('self.out.read',src);self.assertNotIn('self.err.seek',src);self.assertNotIn('os.dup(',src)
        self.assertIn("self.out_path.open('rb')",src)

class BatchSQLTests(unittest.TestCase):
    """Inspect complete generated SQL and driver invariants; never execute SQL."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.report=m.Report(Path(self.temp.name)/'new'/m.NAME);self.p,self.b=m.validate_source()
    def inputs(self,size):
        units=[m.ident(21000+n if size==10 else 30000+n) for n in range(size)]
        # Distinct lists prove that neither array order nor per-unit membership
        # can be replaced with one repeated literal by the expression builder.
        members={u:[{'kind':'custom_work_units','id':u},{'kind':'custom_work_sessions','id':m.ident(50000+n),'note':"original ' note"}] for n,u in enumerate(units)}
        return units,members
    def generated(self,size,variant,review='batch'):
        captured=[]
        class T(m.Trial):
            def query(inner,sql,label):captured.append((sql,label));return {'ms':.5,'value':None,'valueText':None}
        t=T(None,self.report,self.p,self.b,INSTANCE);units,members=self.inputs(size)
        expression=t.expression(variant,units,members);t.timed(expression,'generated_only',review=review)
        sql=captured[0][0];prefix="truncate pg_temp.metadata_trial_result;do '";suffix="';select value from pg_temp.metadata_trial_result"
        self.assertTrue(sql.startswith(prefix) and sql.endswith(suffix))
        body=sql[len(prefix):-len(suffix)].replace("''", "'")
        return units,members,expression,body,sql
    def assert_qualified_batch(self,size):
        for variant in ('old','candidate'):
            with self.subTest(size=size,variant=variant):
                _,_,expression,body,_=self.generated(size,variant)
                self.assertIn('declare t timestamptz;v jsonb;r jsonb;ms double precision;',body)
                self.assertIn('v:='+expression+';ms:=',body)
                self.assertIn('(select jsonb_agg(q.v order by q.n) from (values ',expression)
                self.assertTrue(expression.endswith(') q(n,v))'))
                self.assertNotRegex(expression,r'jsonb_agg\(\s*v\b|order by\s+n\b')
    def test_complete_ten_batch_qualifies_column_references_in_timed_block(self):self.assert_qualified_batch(10)
    def test_complete_hundred_batch_qualifies_column_references_in_timed_block(self):self.assert_qualified_batch(100)
    def test_batch_scope_calls_memberships_and_order_are_exact(self):
        for size in (10,100):
            for variant in ('old','candidate'):
                with self.subTest(size=size,variant=variant):
                    units,members,expression,_,_=self.generated(size,variant)
                    function='public._work_unit_metadata_scope' if variant=='old' else 'pg_temp.metadata_scope_transition_probe'
                    tuples=re.findall(r'\((\d+),'+re.escape(function)+r'\(',expression)
                    self.assertEqual(tuples,[str(n) for n in range(size)])
                    self.assertEqual(expression.count(function+'('),size)
                    positions=[]
                    for n,u in enumerate(units):
                        expected=function+'('+m.lit(m.ident(1))+'::uuid,'+m.lit(u)+'::uuid,'+m.json_literal(members[u])+')'
                        self.assertEqual(expression.count(expected),1);positions.append(expression.index(expected))
                    self.assertEqual(positions,sorted(positions))
    def test_batch_timer_stops_before_review_and_result_collection(self):
        for size in (10,100):
            for variant in ('old','candidate'):
                _,_,expression,body,sql=self.generated(size,variant)
                start='begin t:=clock_timestamp();v:=';stop=';ms:=extract(epoch from clock_timestamp()-t)*1000;'
                self.assertIn(start+expression+stop,body)
                review="select jsonb_agg(public._work_unit_metadata_review("+m.lit(m.ident(1))+"::uuid,x) order by n) into r from jsonb_array_elements(v) with ordinality q(x,n);"
                self.assertIn(stop+review+'insert into pg_temp.metadata_trial_result',body)
                self.assertIn("'review',r,'reviewText',r::text,'value',v,'valueText',v::text",body)
                self.assertNotIn('variable_conflict',sql);self.assertEqual(body.count('clock_timestamp()'),2)
    def test_single_unit_expression_keeps_direct_scope_and_review(self):
        units,members=self.inputs(10);t=m.Trial(None,self.report,self.p,self.b,INSTANCE)
        for variant in ('old','candidate'):
            expression=t.expression(variant,units[:1],members)
            self.assertNotIn('jsonb_agg',expression);self.assertNotIn('values ',expression)
            function='public._work_unit_metadata_scope' if variant=='old' else 'pg_temp.metadata_scope_transition_probe'
            self.assertEqual(expression,function+'('+m.lit(t.actor)+'::uuid,'+m.lit(units[0])+'::uuid,'+m.json_literal(members[units[0]])+')')
    def test_batches_keep_six_warmups_twenty_pairs_and_full_results(self):
        for size in (10,100):
            with self.subTest(size=size):
                units,members=self.inputs(size);calls=[]
                class T(m.Trial):
                    def timed(inner,expression,label,review=False):
                        calls.append((expression,label,review))
                        value=[{'unit':{'id':u},'manifest':{'transitions':[]},'retained':{'null':None,'ordered':[n,0]}} for n,u in enumerate(units)]
                        review_value=[{'unitId':u,'ordinal':n} for n,u in enumerate(units)]
                        return {'ms':999 if '_warmups_' in label else 2,'value':value,'valueText':m.encoded(value),'review':review_value,'reviewText':m.encoded(review_value)}
                t=T(object(),self.report,self.p,self.b,INSTANCE);case_id='existing_'+str(size)+'_light_units';t.scopes([(case_id,units,members)])
                case=self.report.data['cases'][-1];self.assertEqual(case['completedTimedRequestsPerVariant'],{'warmups':6,'measurements':20})
                self.assertEqual(len(calls),52);self.assertTrue(all(call[2]=='batch' for call in calls));self.assertEqual(case['scopeCallsPerRequestFromAuthoredExpression'],size)
                self.assertEqual(case['summary']['old'],{'medianMs':2.0,'p95Ms':2,'maxMs':2});self.assertFalse(case['runtimeFunctionInvocationCounterMeasured'])
                self.assertEqual([entry['order'] for entry in case['pairs']],([['old','candidate'],['candidate','old']]*10))
                for phase in ('warmups','pairs'):
                    for entry in case[phase]:
                        pair=json.loads(Path(entry['fullResults']['path']).read_text());m.result_equal(pair['old'],pair['candidate'])
                        self.assertEqual([x['unit']['id'] for x in pair['old']['value']],units)
                        self.assertEqual(entry['equality'],'passed')
    def test_batch_missing_or_reordered_units_refuse_with_full_evidence(self):
        for size in (10,100):
            for failure in ('missing','reordered'):
                with self.subTest(size=size,failure=failure):
                    units,members=self.inputs(size);wrong=units[:-1] if failure=='missing' else list(reversed(units))
                    class T(m.Trial):
                        def timed(inner,expression,label,review=False):
                            value=[{'unit':{'id':u}} for u in wrong]
                            return {'ms':1,'value':value,'valueText':m.encoded(value),'review':[],'reviewText':'[]'}
                    t=T(None,self.report,self.p,self.b,INSTANCE);name='negative_'+str(size)+'_'+failure
                    with self.assertRaisesRegex(RuntimeError,'Every timed existing unit'):t.scopes([(name,units,members)])
                    case=self.report.data['cases'][-1];self.assertEqual(case['warmups'][0]['equality'],'pending')
                    pair=json.loads(Path(case['warmups'][0]['fullResults']['path']).read_text());self.assertEqual([x['unit']['id'] for x in pair['old']['value']],wrong)
                    self.assertEqual(case['pairs'],[])


if __name__=='__main__':unittest.main(verbosity=2)
