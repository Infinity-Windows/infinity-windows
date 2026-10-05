import unittest,tempfile,shutil,os,sys,json,time,hashlib
from pathlib import Path
from unittest.mock import patch
from bootstrap import verify_root,plan_paths
import bootstrap as bootmodule
from orchestration_gates import *
import orchestrate
O=Path(__file__).resolve().parent

def cleanup(root):
 for base,dirs,files in os.walk(root,followlinks=False):
  Path(base).chmod(0o700)
  for f in files:
   p=Path(base)/f
   if not p.is_symlink():p.chmod(0o600)
 shutil.rmtree(root)
class Controls(unittest.TestCase):
 def setUp(self):self.root=Path(tempfile.mkdtemp(prefix='.test-orchestration-',dir=O));self.addCleanup(cleanup,self.root)
 def source(self):
  root=self.root/'source';root.mkdir();(root/'helper.py').write_text('safe');manifest={'files':{'helper.py':{'bytes':4,'sha256':sha(root/'helper.py')}}};write_new(root/'MANIFEST.json',manifest);return root,sha(root/'MANIFEST.json')
 def test_root_pin_commit_extra_case_link_and_missing_refusals(self):
  root,pin=self.source();commit='a'*40;self.assertEqual(verify_root(root,pin,commit,commit)['verifiedFiles'],2)
  for ph,ch in [('0'*64,commit),(pin,'b'*40)]:
   with self.assertRaises(ValueError):verify_root(root,ph,commit,ch)
  for name in ['extra','HELPER.py']:
   (root/name).write_text('x')
   with self.assertRaises(ValueError):verify_root(root,pin,commit,commit)
   (root/name).unlink()
   if not (root/'helper.py').exists():(root/'helper.py').write_text('safe')
  (root/'helper.py').unlink();(root/'helper.py').symlink_to(root/'MANIFEST.json')
  with self.assertRaises(ValueError):verify_root(root,pin,commit,commit)
  (root/'helper.py').unlink()
  with self.assertRaises(ValueError):verify_root(root,pin,commit,commit)
 def test_failed_inline_bootstrap_records_pin_error_before_any_helper_execution(self):
  workspace=self.root/'workspace';workspace.mkdir();temp=self.root/'runner';temp.mkdir();package=workspace/bootmodule.PACKAGE_REL;package.mkdir(parents=True);(package/'MANIFEST.json').write_text('{}')
  env={'GITHUB_WORKSPACE':str(workspace),'RUNNER_TEMP':str(temp),'GITHUB_RUN_ID':'77','GITHUB_RUN_ATTEMPT':'1','SOURCE_COMMIT':'a'*40,'REVIEWED_MANIFEST':'0'*64,'GITHUB_ENV':str(self.root/'env'),'GITHUB_OUTPUT':str(self.root/'out')}
  with patch.dict(os.environ,env,clear=True),patch.object(bootmodule.subprocess,'check_output',return_value='a'*40+'\n') as git:
   with self.assertRaisesRegex(ValueError,'root manifest pin'):bootmodule.main()
  receipt=read(temp/'pwa-response-77-1-control/BOOTSTRAP.json');self.assertFalse(receipt['complete']);self.assertEqual(receipt['requestedManifestSha256'],'0'*64);self.assertIn('root manifest pin',receipt['error']);self.assertFalse((self.root/'env').exists());self.assertEqual(git.call_count,1)
 def test_scratch_reuse_overlap_and_nonexact_commit(self):
  temp=self.root/'temp';checkout=self.root/'checkout';temp.mkdir();checkout.mkdir();paths=plan_paths(temp,checkout,'123-1');paths['scratch'].mkdir()
  with self.assertRaises(ValueError):plan_paths(temp,checkout,'123-1')
  with self.assertRaises(ValueError):plan_paths(temp,temp/'repo','123-2')
  root,pin=self.source()
  with self.assertRaises(ValueError):verify_root(root,pin,'main','main')
 def test_environment_counterexamples_including_npm_aliases(self):
  reject_environment({'PWA_CONTROL':'/control','PLAYWRIGHT_BROWSERS_PATH':'/new'})
  for key in ['NODE_OPTIONS','NODE_PATH','NODE_PRESERVE_SYMLINKS','PWDEBUG','PW_TEST_CONNECT_WS_ENDPOINT','PW_TEST_REUSE_CONTEXT','npm_config_pwdebug','npm_package_config_pwdebug','PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH','SELENIUM_REMOTE_URL']:
   with self.assertRaises(ValueError):reject_environment({key:''})
 def test_realistic_runner_environment_is_supported_and_browser_values_recorded(self):
  env={'PWD':'/home/runner/work/forge','OLDPWD':'/home/runner','SHLVL':'1','_':'/usr/bin/python3','HOME':'/home/runner','PATH':'/opt/node/bin:/usr/bin','SELENIUM_JAR_PATH':'/usr/share/java/selenium-server.jar','ImageOS':'ubuntu24','PWA_CONTROL':'/control','PWA_PACKAGE':'/source','PWA_SCRATCH':'/scratch','PWA_UNIQUE':'1-1','PWA_PYTHON':'/usr/bin/python3','PLAYWRIGHT_BROWSERS_PATH':'/browser'}
  self.assertEqual(reject_environment(env),{'PLAYWRIGHT_BROWSERS_PATH':'/browser','SELENIUM_JAR_PATH':'/usr/share/java/selenium-server.jar'})
 def test_launch_affecting_prefixes_and_aliases_stay_refused(self):
  for key in ['PWDEBUGIMPL','PWTEST_UNDER_TEST','PWTEST_CLI_EXECUTABLE_PATH','_PW_TEST_CONNECT','npm_config_pw_test_connect_ws_endpoint','npm_package_config_pwtest_under_test','npm_config_playwright_browsers_path','npm_package_config_selenium_remote_url','PLAYWRIGHT_DOWNLOAD_HOST','SELENIUM_REMOTE_CAPABILITIES']:
   with self.subTest(key=key),self.assertRaises(ValueError):reject_environment({'PWD':'/work',key:''})
 def test_wrong_node_checksum_and_changed_dependency_lock(self):
  a=self.root/'node.tar.xz';a.write_bytes(b'fake');c=self.root/'SHASUMS256.txt';c.write_text(NODE_SHA+'  '+NODE_NAME+'.tar.xz\n')
  with self.assertRaisesRegex(ValueError,'distribution'):verify_download(a,c)
  deps=self.root/'deps';deps.mkdir();pins={'sourceFiles':{}}
  for name in ['package.json','package-lock.json']:(deps/name).write_text('{}');pins['sourceFiles']['app/'+name]={'sha256':sha(deps/name)}
  dependency_hashes(deps,pins);(deps/'package-lock.json').write_text('{"changed":1}')
  with self.assertRaisesRegex(ValueError,'lock'):dependency_hashes(deps,pins)
 def test_READY_missing_failed_or_expired_gate_refused(self):
  gates={k:{'complete':True,'receiptSha256':'a'*64} for k in REQUIRED};resolution={'node':{'nodeVersion':'v22.23.1','python3Path':'/python','python3Version':'Python3'},'platform':'linux','arch':'x64','environment':{'NODE_PRESERVE_SYMLINKS':None}}
  self.assertTrue(ready_value(gates,'1-1',0,50,resolution,0)['ready'])
  for mutation in ['missing','failed','expired']:
   g=json.loads(json.dumps(gates));end=50
   if mutation=='missing':del g['metadata']
   if mutation=='failed':g['browserInstall']['complete']=False
   if mutation=='expired':end=1801
   with self.assertRaises(ValueError):ready_value(g,'1-1',0,end,resolution,0)
 def completed(self):
  return {'phase':'final','completed':True,'stopReason':None,'elapsedMs':5000,'deadline':1470000,'start':0,'results':[{'index':i+1,'mode':m,'continue':True,'originalTestExit':e,'reason':'complete assertion failure' if e else 'complete pass','child':{'code':e,'signal':None,'error':None,'timedOut':False}} for i,(m,e) in enumerate(zip(['baseline','blob','baseline','stream'],[0,1,0,1]))]}
 def test_final_assertion_outcomes_distinct_from_outer_timeout_or_terminal(self):
  b=self.completed();x=classify_final(0,b,6);self.assertTrue(x['completed']);self.assertEqual(x['originalTestExits'],[0,1,0,1])
  for code in [None,1,124,137,-15]:self.assertFalse(classify_final(code,b,6)['completed'])
  for mutated in [None,{**b,'terminal':True},{**b,'phase':'validating'},{**b,'completed':False},{**b,'stopReason':'watchdog'},{**b,'elapsedMs':1470001}]:self.assertFalse(classify_final(0,mutated,6)['completed'])
  self.assertFalse(classify_final(0,b,1501)['completed'])
 def test_late_orphan_receipts_cannot_salvage_frozen_outer_decision(self):
  p=self.root/'OUTER-FINAL.json';first=finalize_once(p,None,None,0);before=p.read_bytes();self.assertFalse(first['completed']);second=finalize_once(p,0,self.completed(),5);self.assertEqual(second,first);self.assertEqual(p.read_bytes(),before)
 def test_failed_install_stops_before_READY_without_real_IO(self):
  s=self.root/'scratch';control=self.root/'control';control.mkdir();tool=self.root/'toolchain';browsers=self.root/'browsers';py=Path(sys.executable).resolve();boot={'startedMonotonic':time.monotonic(),'startedAt':time.time(),'unique':'1-1','paths':{'scratch':str(s),'toolchain':str(tool),'browsers':str(browsers)},'pythonPath':str(py),'complete':True};write_new(control/'BOOTSTRAP.json',boot)
  def fake_extract(*args):
   (s/'provenance/plan2').mkdir(parents=True);(s/'dependencies/app').mkdir(parents=True);write_new(s/'provenance/plan2/COMMITTED-DEPENDENCY-PINS.json',{'fake':True})
  node=tool/NODE_NAME/'bin/node'
  def fake_node(*args):node.parent.mkdir(parents=True);node.write_text('fake');return node
  class FakeCommands:
   def __init__(self,*args):self.env={}
   def run(self,label,args,cwd=None):
    if label=='node-receipt':write_new(s/'provenance/NODE-BINARY-RECEIPT.json',{'distributionSha256':NODE_SHA,'checksumFileSha256':CHECKSUM_SHA,'python3Path':str(py)})
    if label=='npm-ci':raise ValueError('npm-ci injected failure')
    return {'complete':True}
  with patch.dict(os.environ,{'PATH':os.environ['PATH']},clear=True),patch.object(orchestrate.platform,'system',return_value='Linux'),patch.object(orchestrate.platform,'machine',return_value='x86_64'),patch.object(orchestrate.shutil,'which',return_value=str(py)),patch.object(orchestrate,'Commands',FakeCommands),patch.object(orchestrate,'load_manifest',return_value={}),patch.object(orchestrate,'extract_fresh',side_effect=fake_extract),patch.object(orchestrate,'verify_download',return_value={}),patch.object(orchestrate,'extract_official_node',side_effect=fake_node),patch.object(orchestrate,'dependency_hashes',return_value={}):
   with self.assertRaisesRegex(ValueError,'npm-ci injected'):orchestrate.setup(O,boot,control)
  self.assertFalse((s/'provenance/READY.json').exists());self.assertFalse(read(control/'SETUP-RESULT.json')['complete'])
 def test_full_fake_setup_writes_READY_only_after_all_nine_gates(self):
  s=self.root/'scratch';control=self.root/'control';control.mkdir();tool=self.root/'toolchain';browsers=self.root/'browsers';py=Path(sys.executable).resolve();boot={'startedMonotonic':time.monotonic(),'startedAt':time.time(),'unique':'2-1','paths':{'scratch':str(s),'toolchain':str(tool),'browsers':str(browsers)},'pythonPath':str(py),'complete':True};write_new(control/'BOOTSTRAP.json',boot);calls=[]
  def fake_extract(*args):
   (s/'provenance/plan2').mkdir(parents=True);(s/'dependencies/app').mkdir(parents=True);write_new(s/'provenance/plan2/COMMITTED-DEPENDENCY-PINS.json',{});write_new(s/'provenance/GIT-OBJECTS.json',{})
  node=tool/NODE_NAME/'bin/node'
  def fake_node(*args):node.parent.mkdir(parents=True);node.write_text('fake');return node
  binary={'distributionSha256':NODE_SHA,'checksumFileSha256':CHECKSUM_SHA,'python3Path':str(py),'python3Version':'Python fake','nodeVersion':'v22.23.1','nodePath':str(node)}
  class FakeCommands:
   def __init__(self,*args):self.env={}
   def run(inner,label,args,cwd=None):
    calls.append(label);self.assertFalse((s/'provenance/READY.json').exists())
    write_new(control/(label+'.command.json'),{'complete':True,'exit':0,'argv':[str(a) for a in args]})
    if label=='node-receipt':write_new(s/'provenance/NODE-BINARY-RECEIPT.json',binary)
    if label=='npm-version':(control/'npm-version.stdout.txt').write_text('npm fake')
    if label=='reconstruct':
     (s/'reconstruction-receipts').mkdir();write_new(s/'reconstruction-receipts/DERIVED-RECONSTRUCTION.json',{})
     for d in [s/'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current',s/'PWA-F9-WORKER-PARITY-REHEARSAL-1/derived-pairs']:d.mkdir(parents=True)
    if label=='bind':write_new(s/'provenance/EXECUTION-ADDITIONS.json',{})
    if label=='resolution':write_new(s/'provenance/RESOLUTION-RECEIPT.json',{'node':binary,'platform':'linux','arch':'x64','environment':{'NODE_PRESERVE_SYMLINKS':None},'playwrightCLI':str(s/'dependencies/app/node_modules/playwright/cli.js')})
    if label=='metadata':write_new(control/'BROWSER-METADATA.json',{'registryName':'chromium-headless-shell','browserLaunched':False})
    if label=='verify-stage':(control/'verify-stage.stdout.txt').write_text('{}')
    return {'complete':True}
  with patch.dict(os.environ,{'PATH':os.environ['PATH']},clear=True),patch.object(orchestrate.platform,'system',return_value='Linux'),patch.object(orchestrate.platform,'machine',return_value='x86_64'),patch.object(orchestrate.shutil,'which',return_value=str(py)),patch.object(orchestrate,'Commands',FakeCommands),patch.object(orchestrate,'load_manifest',return_value={}),patch.object(orchestrate,'extract_fresh',side_effect=fake_extract),patch.object(orchestrate,'verify_download',return_value={}),patch.object(orchestrate,'extract_official_node',side_effect=fake_node),patch.object(orchestrate,'dependency_hashes',return_value={'lock':'exact'}):result=orchestrate.setup(O,boot,control)
  self.assertTrue(result['complete']);ready=read(s/'provenance/READY.json');self.assertEqual(set(ready['gates']),set(REQUIRED));self.assertTrue(ready['setupCompleted']);self.assertEqual(calls,['download-node','download-checksums','node-receipt','npm-version','npm-ci','reconstruct','bind','resolution','chromium-install','metadata','verify-stage'])
  self.assertEqual(ready['resolutionSha256'],sha(s/'provenance/RESOLUTION-RECEIPT.json'));self.assertEqual(ready['browserMetadataSha256'],sha(control/'BROWSER-METADATA.json'))
if __name__=='__main__':unittest.main()
