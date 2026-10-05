"""Pure/source-only gates shared with fake offline tests. No subprocess at import."""
import json,hashlib,os,re,stat,tarfile,posixpath,time
from pathlib import Path
NODE_SHA='9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578'
CHECKSUM_SHA='158f2e2c580c610b9cef2853f3444c7369b84cc23e7ad764e3c40e9d60d82ea0'
NODE_NAME='node-v22.23.1-linux-x64'
NODE_URL='https://nodejs.org/dist/v22.23.1/'+NODE_NAME+'.tar.xz'
CHECKSUM_URL='https://nodejs.org/dist/v22.23.1/SHASUMS256.txt'
REQUIRED=['root','toolchain','dependencies','reconstruction','binding','resolution','browserInstall','metadata','stage']
def require(ok,msg):
 if not ok:raise ValueError(msg)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def write_new(p,v):
 with Path(p).open('x') as f:json.dump(v,f,indent=2);f.write('\n')
def reject_environment(env):
 for key in ['NODE_PATH','NODE_OPTIONS','NODE_PRESERVE_SYMLINKS']:require(key not in env,key+' must be unset')
 for key in env:
  if key in ['PWA_PACKAGE','PWA_CONTROL','PWA_SCRATCH','PWA_UNIQUE','PWA_PYTHON']:continue
  plain=re.sub(r'^npm_(?:package_)?config_','',key.lower())
  if re.match(r'^(?:pwdebug|_?pw_|_?pwtest|playwright_|selenium_remote_)',plain):require(key=='PLAYWRIGHT_BROWSERS_PATH','unexpected browser/launch env '+key)
 return {k:v for k,v in env.items() if k.startswith(('PLAYWRIGHT_','SELENIUM_'))}
def verify_download(archive,checksums):
 require(sha(archive)==NODE_SHA,'chosen Node distribution checksum mismatch');require(sha(checksums)==CHECKSUM_SHA,'official checksum-file mismatch')
 matches=[line.split() for line in Path(checksums).read_text().splitlines() if line.endswith('  '+NODE_NAME+'.tar.xz')]
 require(len(matches)==1 and matches[0][0]==NODE_SHA,'official Node entry mismatch')
 return {'distributionSha256':NODE_SHA,'checksumFileSha256':CHECKSUM_SHA,'distributionUrl':NODE_URL,'checksumUrl':CHECKSUM_URL}
def extract_official_node(archive,checksums,target):
 verify_download(archive,checksums);target=Path(target);require(not target.exists(),'toolchain destination reused');target.mkdir()
 # Full official distribution, including npm. Files first, symlinks last; never extract through a link.
 with tarfile.open(archive,'r:xz') as tf:
  members=tf.getmembers();seen=set();total=0;links=[]
  for m in members:
   name=m.name.rstrip('/');require(name.startswith(NODE_NAME+'/') or name==NODE_NAME,'Node prefix mismatch');require(not name.startswith('/') and '\\' not in name and all(x not in ('','.','..') for x in name.split('/')),'unsafe Node member');require(name.casefold() not in seen,'duplicate Node member');seen.add(name.casefold());require(m.isdir() or m.isfile() or m.issym(),'Node hardlink/special refused');total+=m.size
   if m.issym():
    resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),m.linkname));require(not m.linkname.startswith('/') and resolved.startswith(NODE_NAME+'/'),'Node symlink escape');links.append((m,resolved))
  require(total<400_000_000,'Node expanded size cap')
  for m in members:
   p=target/m.name
   if m.isdir():p.mkdir(parents=True,exist_ok=True)
   elif m.isfile():
    p.parent.mkdir(parents=True,exist_ok=True)
    with p.open('xb') as f:f.write(tf.extractfile(m).read())
    p.chmod(m.mode&0o755)
  for m,resolved in links:
   p=target/m.name;p.parent.mkdir(parents=True,exist_ok=True);require((target/resolved).exists(),'dangling official symlink');p.symlink_to(m.linkname)
 return target/NODE_NAME/'bin/node'
def dependency_hashes(root,pins):
 result={}
 for name in ['package.json','package-lock.json']:
  p=Path(root)/name;want=pins['sourceFiles']['app/'+name]['sha256'];require(p.is_file() and not p.is_symlink() and sha(p)==want,'dependency '+name+' pin mismatch');result[name]=want
 return result
def ready_value(gates,unique,start,end,resolution,setup_started_at):
 require(set(gates)==set(REQUIRED),'READY missing/extra gate');require(all(v.get('complete') is True and re.fullmatch('[a-f0-9]{64}',v.get('receiptSha256','')) for v in gates.values()),'READY premature/incomplete')
 require(0<=end-start<=1800,'setup budget exceeded');require(resolution['node']['nodeVersion']=='v22.23.1' and resolution['platform']=='linux' and resolution['arch']=='x64','READY Node/platform mismatch')
 require(resolution['environment'].get('NODE_PRESERVE_SYMLINKS','MISSING') is None,'READY preserve symlinks env')
 return {'unique':unique,'ready':True,'setupCompleted':True,'setupStartedAt':setup_started_at,'setupCompletedAt':time.time(),'setupElapsedMs':(end-start)*1000,'resolutionSha256':gates['resolution']['receiptSha256'],'gates':gates,'node':resolution['node'],'python3Path':resolution['node']['python3Path'],'python3Version':resolution['node']['python3Version']}
def classify_final(driver_exit,block,elapsed_seconds):
 incomplete={'status':'INCOMPLETE','completed':False,'originalTestExits':[],'reason':'missing or incomplete driver receipt'}
 if driver_exit!=0:return {**incomplete,'reason':'driver/outer-watchdog exit '+str(driver_exit)}
 if elapsed_seconds>1500 or elapsed_seconds<0:return {**incomplete,'reason':'outer block time exceeded'}
 if not isinstance(block,dict) or block.get('terminal') is True or block.get('completed') is not True or block.get('phase')!='final' or block.get('stopReason') is not None:return incomplete
 if block.get('elapsedMs',float('inf'))>1470000 or block.get('deadline')!=1470000 or block.get('start')!=0:return {**incomplete,'reason':'invalid process-origin timing receipt'}
 rows=block.get('results',[])
 if len(rows)!=4 or [r.get('mode') for r in rows]!=['baseline','blob','baseline','stream'] or [r.get('index') for r in rows]!=[1,2,3,4]:return incomplete
 for row in rows:
  child=row.get('child',{});e=row.get('originalTestExit');expected='complete pass' if e==0 else 'complete assertion failure'
  if type(e) is not int or e not in (0,1) or row.get('continue') is not True or row.get('reason')!=expected or child.get('code')!=e or child.get('signal') or child.get('error') or child.get('timedOut'):return incomplete
 return {'status':'DIAGNOSTIC_COMPLETE_MECHANISM_UNASSESSED','completed':True,'originalTestExits':[r['originalTestExit'] for r in rows],'reason':None,'mechanism':'UNKNOWN','earlyWorkerCoverage':'UNKNOWN'}
def finalize_once(path,driver_exit,block,elapsed_seconds):
 path=Path(path)
 if path.exists():return read(path) # First outer decision is immutable; later orphan files never salvage it.
 result={**classify_final(driver_exit,block,elapsed_seconds),'driverExit':driver_exit,'outerElapsedSeconds':elapsed_seconds,'terminal':True};write_new(path,result);return result
