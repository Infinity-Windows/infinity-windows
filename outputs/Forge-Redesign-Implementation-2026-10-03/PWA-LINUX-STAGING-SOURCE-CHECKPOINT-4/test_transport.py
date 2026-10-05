import io,json,tarfile,tempfile,unittest,os,shutil
from pathlib import Path
from transport import *
import transport
from unittest.mock import patch
O=Path(__file__).resolve().parent
class Boundaries(unittest.TestCase):
 def setUp(self):
  self.root=Path(tempfile.mkdtemp(prefix='.test-transport-',dir=O));self.addCleanup(shutil.rmtree,self.root)
 def tar(self,members):
  p=self.root/'test.tar'
  with tarfile.open(p,'w',format=tarfile.USTAR_FORMAT) as t:
   for name,data,typ in members:
    i=tarfile.TarInfo(name);i.size=len(data);i.type=typ
    if typ in (tarfile.SYMTYPE,tarfile.LNKTYPE):i.linkname='../outside'
    t.addfile(i,io.BytesIO(data))
  return p
 def test_good_then_refuse_reuse(self):
  p=self.tar([('a/b',b'content',tarfile.REGTYPE)]);m={'a/b':{'bytes':7,'sha256':sha(b'content')}}
  extract_fresh(p,self.root/'new',m,sha(p.read_bytes()));self.assertEqual((self.root/'new/a/b').read_bytes(),b'content')
  with self.assertRaises(ValueError):extract_fresh(p,self.root/'new',m,sha(p.read_bytes()))
 def test_reject_before_write(self):
  cases=[[('../escape',b'x',tarfile.REGTYPE)],[('/absolute',b'x',tarfile.REGTYPE)],[('a',b'x',tarfile.SYMTYPE)],[('a',b'x',tarfile.LNKTYPE)],[('a',b'x',tarfile.REGTYPE),('a',b'x',tarfile.REGTYPE)],[('a',b'x',tarfile.REGTYPE),('A',b'x',tarfile.REGTYPE)],[('a',b'y',tarfile.REGTYPE)],[('a',b'x',tarfile.REGTYPE),('extra',b'x',tarfile.REGTYPE)],[]]
  m={'a':{'bytes':1,'sha256':sha(b'x')}}
  for rows in cases:
   p=self.tar(rows)
   with self.assertRaises(ValueError):extract_fresh(p,self.root/'dest',m,sha(p.read_bytes()))
   self.assertFalse((self.root/'dest').exists())
 def test_path_replacement_after_validation_uses_only_original_snapshot(self):
  p=self.tar([('a/b',b'original',tarfile.REGTYPE)]);original=p.read_bytes();m={'a/b':{'bytes':8,'sha256':sha(b'original')}}
  validated=transport.validated_tar_bytes
  def swap(*args):
   snapshot=validated(*args)
   self.tar([('../escaped',b'attack',tarfile.REGTYPE)]) # Replace path contents after full validation.
   return snapshot
  with patch.object(transport,'validated_tar_bytes',side_effect=swap):extract_fresh(p,self.root/'new',m,sha(original))
  self.assertEqual((self.root/'new/a/b').read_bytes(),b'original');self.assertFalse((self.root/'escaped').exists());self.assertEqual(inventory(self.root/'new'),m)
 def test_inplace_data_change_before_snapshot_hash_refuses_all_writes(self):
  p=self.tar([('a',b'original',tarfile.REGTYPE)]);digest=sha(p.read_bytes());m={'a':{'bytes':8,'sha256':sha(b'original')}}
  self.tar([('a',b'attacked',tarfile.REGTYPE)])
  with self.assertRaisesRegex(ValueError,'digest'):extract_fresh(p,self.root/'new',m,digest)
  self.assertFalse((self.root/'new').exists())
 def test_root_overlap_symlink_empty_directory_and_hardlink(self):
  with self.assertRaises(ValueError):disjoint(self.root,self.root/'nested')
  (self.root/'alias').symlink_to(self.root,target_is_directory=True)
  with self.assertRaises(ValueError):no_link_ancestors(self.root/'alias'/'future')
  (self.root/'alias').unlink();(self.root/'empty').mkdir()
  with self.assertRaises(ValueError):inventory(self.root)
  (self.root/'empty').rmdir();(self.root/'a').write_bytes(b'a');os.link(self.root/'a',self.root/'b')
  with self.assertRaises(ValueError):inventory(self.root)
 def test_hash_extra_missing_refusal(self):
  (self.root/'a').write_bytes(b'a');m=inventory(self.root);(self.root/'a').write_bytes(b'b')
  with self.assertRaises(ValueError):verify_tree(self.root,m)
  (self.root/'a').unlink()
  with self.assertRaises(ValueError):verify_tree(self.root,m)
if __name__=='__main__':unittest.main()
