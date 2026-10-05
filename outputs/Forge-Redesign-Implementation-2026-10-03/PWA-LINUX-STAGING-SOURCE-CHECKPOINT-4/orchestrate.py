"""Future cloud orchestration. Invoked only after workflow-inline bootstrap verified this root."""
import os,sys,json,time,signal,subprocess,platform,shutil
from pathlib import Path
O=Path(__file__).resolve().parent
sys.path.insert(0,str(O))
from bootstrap import verify_root,canonical
from orchestration_gates import *
from transport import load_manifest,extract_fresh,inventory
from reconstruct import R,P

class Commands:
 def __init__(self,control,env,deadline):self.control=Path(control);self.env=dict(env);self.deadline=deadline;self.receipts=[]
 def run(self,label,args,cwd=None):
  remaining=self.deadline-time.monotonic();require(remaining>0,'setup budget exhausted');start=time.monotonic();record={'argv':[str(a) for a in args],'cwd':str(cwd or O),'startedAt':time.time(),'complete':False};child=None
  try:
   with (self.control/(label+'.stdout.txt')).open('xb') as out,(self.control/(label+'.stderr.txt')).open('xb') as err:
    child=subprocess.Popen([str(a) for a in args],cwd=cwd or O,env=self.env,stdout=out,stderr=err,start_new_session=True)
    try:code=child.wait(timeout=remaining)
    except BaseException:
     try:os.killpg(child.pid,signal.SIGKILL)
     except ProcessLookupError:pass
     child.wait(timeout=2);raise
   record['exit']=code;require(code==0,label+' failed with exit '+str(code));record['complete']=True
  except BaseException as error:record['error']=str(error);raise
  finally:
   record['elapsedMs']=(time.monotonic()-start)*1000;write_new(self.control/(label+'.command.json'),record);self.receipts.append(record)
  return record

def immutable_dirs(root):
 for base,sub,files in os.walk(root,topdown=False):
  for name in files:Path(base,name).chmod(0o444)
  Path(base).chmod(0o555)

def record_gate(gates,key,path):
 require(key not in gates,'gate replay');value=read(path);require(value.get('complete',True) is not False,'failed gate receipt');gates[key]={'complete':True,'receiptPath':str(path),'receiptSha256':sha(path)}

def setup(package,bootstrap,control):
 start=bootstrap['startedMonotonic'];deadline=start+1800;env=dict(os.environ);reject_environment(env)
 require('PLAYWRIGHT_BROWSERS_PATH' not in env,'browser root must be newly enrolled');require(platform.system()=='Linux' and platform.machine()=='x86_64','Linux x64 runner required')
 s=Path(bootstrap['paths']['scratch']);toolchain=Path(bootstrap['paths']['toolchain']);browsers=Path(bootstrap['paths']['browsers']);unique=bootstrap['unique'];py=Path(bootstrap['pythonPath']);require(py==Path(sys.executable).resolve(),'Python path changed');require(Path(shutil.which('python3')).resolve()==py,'PATH python3 differs')
 for p in [s,toolchain,browsers]:canonical(p);require(not p.exists(),'setup root reused')
 env['PYTHONDONTWRITEBYTECODE']='1';browsers.mkdir();env['PLAYWRIGHT_BROWSERS_PATH']=str(browsers);cmd=Commands(control,env,deadline);gates={};record_gate(gates,'root',control/'BOOTSTRAP.json')
 status={'complete':False,'setupStartedAt':bootstrap['startedAt'],'setupStartedMonotonic':start,'runner':{'platform':platform.platform(),'uname':list(platform.uname()),'ImageOS':env.get('ImageOS'),'ImageVersion':env.get('ImageVersion')},'playwrightEnvironment':reject_environment(env),'unique':unique}
 def interrupted(signum,frame):raise RuntimeError('setup signal '+str(signum))
 previous={sig:signal.signal(sig,interrupted) for sig in [signal.SIGTERM,signal.SIGINT]}
 try:
  pp=read(package/'PACKAGE-PINS.json');manifest=load_manifest(package/'TRANSPORT-MANIFEST.json',pp['manifestSha256']);extract_fresh(package/'payload.tar',s,manifest,pp['archiveSha256'])
  downloads=control/'downloads';downloads.mkdir();archive=downloads/(NODE_NAME+'.tar.xz');checksums=downloads/'SHASUMS256.txt'
  for label,url,dest in [('download-node',NODE_URL,archive),('download-checksums',CHECKSUM_URL,checksums)]:
   cmd.run(label,['curl','--fail','--show-error','--location','--proto','=https','--proto-redir','=https','--tlsv1.2','--retry','0','--connect-timeout','30','--max-time','300','--output',dest,url])
  choice=verify_download(archive,checksums);write_new(control/'NODE-DOWNLOAD.json',choice);node=extract_official_node(archive,checksums,toolchain).resolve();env['PATH']=str(node.parent)+os.pathsep+env['PATH'];cmd.env=env
  def helper(label,name,*args):return cmd.run(label,[py,'-E','-s','-B',package/name,*args])
  helper('node-receipt','node-receipt.py',node,archive,checksums,s/'provenance/NODE-BINARY-RECEIPT.json')
  binary=read(s/'provenance/NODE-BINARY-RECEIPT.json');require(binary['distributionSha256']==NODE_SHA and binary['checksumFileSha256']==CHECKSUM_SHA,'binary receipt chosen pin mismatch');require(binary['python3Path']==str(py),'binary receipt Python mismatch');record_gate(gates,'toolchain',s/'provenance/NODE-BINARY-RECEIPT.json')
  cmd.run('npm-version',[node,toolchain/NODE_NAME/'lib/node_modules/npm/bin/npm-cli.js','--version'])
  deps=s/'dependencies/app';dp=read(s/'provenance/plan2/COMMITTED-DEPENDENCY-PINS.json');before=dependency_hashes(deps,dp)
  cmd.run('npm-ci',[node,toolchain/NODE_NAME/'lib/node_modules/npm/bin/npm-cli.js','ci'],deps);after=dependency_hashes(deps,dp);require(before==after,'npm modified dependency pins')
  write_new(control/'DEPENDENCIES.json',{'complete':True,'hashes':after,'commandReceiptSha256':sha(control/'npm-ci.command.json'),'npmVersion':(control/'npm-version.stdout.txt').read_text().strip(),'packageLockGitReceiptSha256':sha(s/'provenance/GIT-OBJECTS.json')});record_gate(gates,'dependencies',control/'DEPENDENCIES.json')
  helper('reconstruct','reconstruct.py',s,s/'reconstruction-receipts',py);record_gate(gates,'reconstruction',s/'reconstruction-receipts/DERIVED-RECONSTRUCTION.json')
  for d in [s/'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current',s/P/'derived-pairs']:immutable_dirs(d)
  cmd.run('bind',[node,package/'bind-execution.mjs',s,node,unique]);record_gate(gates,'binding',s/'provenance/EXECUTION-ADDITIONS.json')
  cmd.run('resolution',[node,s/R/'app/resolution-probe.mjs']);record_gate(gates,'resolution',s/'provenance/RESOLUTION-RECEIPT.json');resolution=read(s/'provenance/RESOLUTION-RECEIPT.json');cli=Path(resolution['playwrightCLI']);require(cli==s/'dependencies/app/node_modules/playwright/cli.js','wrong installer CLI')
  cmd.run('chromium-install',[node,cli,'install','--with-deps','chromium']);record_gate(gates,'browserInstall',control/'chromium-install.command.json')
  cmd.run('metadata',[node,package/'browser-metadata.mjs',s,control/'BROWSER-METADATA.json']);metadata=read(control/'BROWSER-METADATA.json');require(metadata['registryName']=='chromium-headless-shell' and metadata['browserLaunched'] is False,'wrong browser metadata');record_gate(gates,'metadata',control/'BROWSER-METADATA.json')
  helper('verify-stage','verify-stage.py',s);write_new(control/'STAGE-VERIFICATION.json',{'complete':True,'result':json.loads((control/'verify-stage.stdout.txt').read_text()),'commandReceiptSha256':sha(control/'verify-stage.command.json')});record_gate(gates,'stage',control/'STAGE-VERIFICATION.json')
  ready=ready_value(gates,unique,start,time.monotonic(),resolution,bootstrap['startedAt']);ready['browserMetadataSha256']=sha(control/'BROWSER-METADATA.json');ready['browserEnvironment']=reject_environment(env);write_new(s/'provenance/READY.json',ready)
  require(time.monotonic()<=deadline,'setup budget exceeded at READY');status.update({'complete':True,'gates':gates,'node':str(node),'python':str(py),'browserEnvironment':ready['browserEnvironment'],'readySha256':sha(s/'provenance/READY.json')})
 except BaseException as error:status['stopReason']=str(error);raise
 finally:
  status['elapsedMs']=(time.monotonic()-start)*1000;status['setupCompletedAt']=time.time();write_new(control/'SETUP-RESULT.json',status)
  for sig,handler in previous.items():signal.signal(sig,handler)
 return status

def verified_setup(bootstrap,control):
 status=read(control/'SETUP-RESULT.json');require(status.get('complete') is True,'setup incomplete');s=Path(bootstrap['paths']['scratch']);ready_path=s/'provenance/READY.json';require(sha(ready_path)==status['readySha256'],'READY changed');ready=read(ready_path)
 require(ready.get('ready') is True and ready.get('setupCompleted') is True and ready['unique']==bootstrap['unique'],'invalid READY');require(set(ready['gates'])==set(REQUIRED),'missing READY gates')
 for value in ready['gates'].values():require(value['complete'] is True and sha(value['receiptPath'])==value['receiptSha256'],'gate receipt changed')
 metadata=read(control/'BROWSER-METADATA.json');require(sha(metadata['selectedExecutable'])==metadata['executableSha256'],'browser executable changed');require(Path(metadata['selectedExecutable']).resolve()==Path(metadata['selectedExecutable']),'browser path symlink');require(metadata['registryName']=='chromium-headless-shell','wrong selected browser')
 binary=read(s/'provenance/NODE-BINARY-RECEIPT.json');require(sha(binary['nodePath'])==binary['binarySha256'],'Node binary changed');require(binary['python3Path']==str(Path(sys.executable).resolve()),'Python changed')
 return status,ready

def block(package,bootstrap,control):
 result_path=control/'OUTER-FINAL.json';require(not result_path.exists(),'outer decision already terminal');start=time.monotonic();exit_code=None;block_receipt=None
 try:
  status,ready=verified_setup(bootstrap,control);env=dict(os.environ);reject_environment(env);require('PLAYWRIGHT_BROWSERS_PATH' not in env,'unexpected inherited browser root');env.update(ready['browserEnvironment']);env['PYTHONDONTWRITEBYTECODE']='1';env['PATH']=str(Path(status['node']).parent)+os.pathsep+env['PATH'];reject_environment(env)
  s=Path(bootstrap['paths']['scratch']);node=status['node'];args=['timeout','--signal=TERM','--kill-after=5s','1495s',node,str(package/'driver.mjs'),str(s),bootstrap['unique']]
  write_new(control/'BLOCK-DISPATCH.json',{'argv':args,'startedAt':time.time(),'startedMonotonic':start,'retry':0})
  with (control/'BLOCK.stdout.txt').open('xb') as out,(control/'BLOCK.stderr.txt').open('xb') as err:exit_code=subprocess.run(args,env=env,cwd=package,stdout=out,stderr=err,timeout=1501).returncode
  if exit_code==0:
   # Final gates precede the first immutable outer completion decision.
   verify_root(package,bootstrap['rootManifestSha256'],bootstrap['sourceCommit'],subprocess.check_output(['git','-C',os.environ['GITHUB_WORKSPACE'],'rev-parse','HEAD'],text=True).strip())
   verified_setup(bootstrap,control)
   post=Commands(control,env,start+1500);post.run('final-stage',[bootstrap['pythonPath'],'-E','-s','-B',package/'verify-stage.py',s])
  path=s/('PWA-RESPONSE-EXPERIMENT-RUNS-'+bootstrap['unique'])/'BLOCK-RECEIPT.json'
  if path.is_file() and not path.is_symlink():block_receipt=read(path)
 except BaseException as error:exit_code=None;write_new(control/'BLOCK-OUTER-ERROR.json',{'error':str(error)});raise
 finally:
  result=finalize_once(result_path,exit_code,block_receipt,time.monotonic()-start)
 return result

def final_fallback(bootstrap,control):
 # Missing outer final is always incomplete. Never scan late arm/orphan receipts for recovery.
 path=control/'OUTER-FINAL.json'
 if path.exists():return read(path)
 return finalize_once(path,None,None,0)

def main():
 action=sys.argv[1];require(action in ['setup','block','finalize'],'unknown action');control=canonical(os.environ['PWA_CONTROL']);bootstrap=read(control/'BOOTSTRAP.json');require(bootstrap.get('complete') is True,'bootstrap incomplete');require(Path(bootstrap['root'])==O,'helper root changed')
 head=subprocess.check_output(['git','-C',os.environ['GITHUB_WORKSPACE'],'rev-parse','HEAD'],text=True).strip();verify_root(O,bootstrap['rootManifestSha256'],bootstrap['sourceCommit'],head)
 if action=='setup':
  try:setup(O,bootstrap,control)
  except BaseException as error:
   if not (control/'SETUP-RESULT.json').exists():write_new(control/'SETUP-RESULT.json',{'complete':False,'stopReason':str(error),'elapsedMs':(time.monotonic()-bootstrap['startedMonotonic'])*1000})
   raise
 elif action=='block':result=block(O,bootstrap,control);sys.exit(0 if result['completed'] else 1)
 else:result=final_fallback(bootstrap,control);sys.exit(0 if result['completed'] else 1)
if __name__=='__main__':main()
