"""Future no-build reconstruction; never invoked by import. Off uses transport pins."""
import json,subprocess,sys
from pathlib import Path
from transport import sha,require,inventory,verify_tree,no_link_ancestors,write_json
R='PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2';P='PWA-F9-WORKER-PARITY-REHEARSAL-1'
def reconstruct(scratch,receipt_dir,python_executable):
 s=no_link_ancestors(scratch); receipts=no_link_ancestors(receipt_dir);require(receipts.parent==s,'receipts must be scratch sibling');receipts.mkdir()
 originals=s/'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current';runtime=s/R
 pins=json.loads((runtime/'RUNTIME-PINS.json').read_text()); transport=json.loads((s/'provenance/plan2/TRANSPORT-INVENTORY.json').read_text())
 verifier=runtime/'verify-original-archives.py';require(sha(verifier.read_bytes())==pins['originalVerifierSha256'],'verifier mismatch')
 def attest(phase):
  original_map=inventory(originals)
  require(len(original_map)==660,'original file count')
  r=subprocess.run([python_executable,str(verifier),str(originals),str(receipts/('original-'+phase+'.json')),'current-f9'],capture_output=True,text=True)
  (receipts/('original-'+phase+'.txt')).write_text(r.stdout+r.stderr);require(r.returncode==0,'strict original verifier failed');return original_map
 before=attest('before');target=s/P/'derived-pairs';require(not target.exists(),'derivative target exists');target.mkdir()
 result={}
 for mode in ['off','baseline','blob','stream']:
  pin=transport['derivativeInputs'][mode];mb=(s/P/f'DERIVED-{mode}-MANIFEST.json').read_bytes();worker=(s/P/'workers'/mode/'sw.js').read_bytes()
  require(sha(mb)==pin['manifestSha256'] and sha(worker)==pin['workerSha256'],'delta mismatch')
  manifest=json.loads(mb);require(manifest['new']['sha256']['sw.js']==pin['workerSha256'],'manifest worker mismatch')
  pair=target/mode;pair.mkdir();expected={}
  for side in ['old','new']:
   source=originals/(side+'-dist'); entries=inventory(source);hashes={k:v['sha256'] for k,v in entries.items()}
   require(len(entries)==330,'side count');allowed=dict(hashes)
   if side=='new':allowed['sw.js']=pin['workerSha256']
   require(manifest[side]['sha256']==allowed,'delta changed nonworker/original')
   for name in entries:
    dest=pair/(side+'-dist')/name;dest.parent.mkdir(parents=True,exist_ok=True)
    data=worker if side=='new' and name=='sw.js' else (source/name).read_bytes()
    with dest.open('xb') as f:f.write(data) # Independent bytes; no copy-on-write or link.
    dest.chmod(0o444);expected[side+'-dist/'+name]={'bytes':len(data),'sha256':sha(data)}
  verify_tree(pair,expected);result[mode]=expected
 after=attest('after');require(before==after,'original changed');write_json(receipts/'DERIVED-RECONSTRUCTION.json',result)
 return result
if __name__=='__main__':
 require(len(sys.argv)==4,'scratch receipts exact-python');reconstruct(*sys.argv[1:])
