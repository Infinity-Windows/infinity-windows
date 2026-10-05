import json,sys,tempfile,unittest,shutil
from pathlib import Path
from transport import sha,inventory,write_json
from reconstruct import reconstruct,R,P
O=Path(__file__).resolve().parent
class Reconstruction(unittest.TestCase):
 def fixture(self,invalid=False):
  s=Path(tempfile.mkdtemp(prefix='.test-reconstruct-',dir=O));self.addCleanup(shutil.rmtree,s);r=s/R;r.mkdir()
  # Synthetic strict-verifier stand-in only: reconstruction's real invocation contract is exercised.
  verifier=b'import pathlib,sys\npathlib.Path(sys.argv[2]).write_text("{}")\n'
  (r/'verify-original-archives.py').write_bytes(verifier);write_json(r/'RUNTIME-PINS.json',{'originalVerifierSha256':sha(verifier)})
  original=s/'PWA-F9-CURRENT-FAIL-ARTIFACT/_temp/pwa-current'
  for side in ['old','new']:
   d=original/(side+'-dist');d.mkdir(parents=True)
   for i in range(329):(d/f'f{i}.js').write_text(str(i))
   (d/'sw.js').write_text('original '+side)
  originalmaps={side:inventory(original/(side+'-dist')) for side in ['old','new']};deltas={}
  for mode in ['off','baseline','blob','stream']:
   d=s/P/'workers'/mode;d.mkdir(parents=True);b=('worker '+mode).encode();(d/'sw.js').write_bytes(b)
   manifest={side:{'sha256':{k:v['sha256'] for k,v in originalmaps[side].items()}} for side in ['old','new']};manifest['new']['sha256']['sw.js']=sha(b)
   if invalid and mode=='off':manifest['new']['sha256']['f1.js']='0'*64
   raw=json.dumps(manifest).encode();(s/P/f'DERIVED-{mode}-MANIFEST.json').write_bytes(raw);deltas[mode]={'manifestSha256':sha(raw),'workerSha256':sha(b)}
  (s/'provenance/plan2').mkdir(parents=True);write_json(s/'provenance/plan2/TRANSPORT-INVENTORY.json',{'derivativeInputs':deltas});return s,original
 def test_four_pairs_independent_no_mutation_and_refuse_reuse(self):
  s,original=self.fixture();before=inventory(original);result=reconstruct(s,s/'receipts',sys.executable)
  self.assertEqual(list(result),['off','baseline','blob','stream']);self.assertEqual(inventory(original),before)
  for mode in result:
   actual=inventory(s/P/'derived-pairs'/mode);self.assertEqual(actual,result[mode]);self.assertEqual(len(actual),660)
   expected=dict(before);worker=('worker '+mode).encode();expected['new-dist/sw.js']={'bytes':len(worker),'sha256':sha(worker)}
   self.assertEqual(actual,expected) # Exact old330 and new329 nonworkers, plus selected new worker.
   self.assertEqual((s/P/'derived-pairs'/mode/'new-dist/sw.js').read_bytes(),worker)
  f='new-dist/f0.js';a=original/f;b=s/P/'derived-pairs/off'/f;self.assertNotEqual(a.stat().st_ino,b.stat().st_ino);self.assertEqual(b.stat().st_nlink,1);self.assertEqual(b.stat().st_mode&0o222,0)
  with self.assertRaises((ValueError,FileExistsError)):reconstruct(s,s/'again',sys.executable)
 def test_nonworker_change_refuses_no_fallback(self):
  s,_=self.fixture(invalid=True)
  with self.assertRaisesRegex(ValueError,'nonworker'):reconstruct(s,s/'receipts',sys.executable)
  self.assertFalse((s/P/'derived-pairs/off/new-dist/f1.js').exists())
if __name__=='__main__':unittest.main()
