"""No-contact transport validation. Importing this module has no side effects."""
import hashlib,json,os,re,stat,tarfile,io
from pathlib import Path,PurePosixPath
MAX_BYTES=25_000_000
sha=lambda b:hashlib.sha256(b).hexdigest()
def require(ok,message):
 if not ok:raise ValueError(message)
def safe_name(name):
 require(isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9_.@/-]+',name) is not None,'unsafe path')
 require(not name.startswith('/') and all(x not in ('','.','..') for x in name.split('/')),'unsafe path')
 return name
def check_names(names):
 seen=set();paths=set(names)
 for name in names:
  safe_name(name); folded=name.casefold();require(folded not in seen,'duplicate/case collision');seen.add(folded)
  require(not any(str(p) in paths for p in PurePosixPath(name).parents if str(p)!='.'),'file/directory conflict')
def no_link_ancestors(path):
 path=Path(os.path.abspath(path))
 for part in [*reversed(path.parents),path]:
  if part.exists() or part.is_symlink():require(not part.is_symlink(),'symlink ancestor')
 return path
def disjoint(*roots):
 paths=[no_link_ancestors(x) for x in roots]
 for i,a in enumerate(paths):
  for b in paths[i+1:]:require(a!=b and a not in b.parents and b not in a.parents,'root overlap')
 return paths
def inventory(root):
 root=no_link_ancestors(root);require(root.is_dir(),'missing tree');out={};dirs=[]
 for base,sub,files in os.walk(root,followlinks=False):
  for name in sub+files:
   p=Path(base)/name; s=p.lstat();require(not stat.S_ISLNK(s.st_mode),'symlink in tree')
   rel=p.relative_to(root).as_posix();safe_name(rel)
   if stat.S_ISDIR(s.st_mode):dirs.append(rel)
   else:
    require(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'special file/hardlink refused');b=p.read_bytes();out[rel]={'bytes':len(b),'sha256':sha(b)}
 check_names(list(out));require(len({p.casefold() for p in [*out,*dirs]})==len(out)+len(dirs),'case collision')
 expected_dirs={str(p) for name in out for p in PurePosixPath(name).parents if str(p)!='.'}
 require(set(dirs)==expected_dirs,'extra empty directory')
 return dict(sorted(out.items()))
def verify_tree(root,expected):
 require(inventory(root)==expected,'missing/extra/hash/size tree mismatch')
def load_manifest(path,expected_sha):
 raw=Path(path).read_bytes();require(sha(raw)==expected_sha,'untrusted manifest');m=json.loads(raw);check_names(list(m));require(sum(x['bytes'] for x in m.values())<MAX_BYTES,'payload too large');return m
def validated_tar_bytes(path,manifest,archive_sha):
 # Read a single bounded byte snapshot from one handle. Renaming/replacing the
 # path after this read cannot swap the bytes subsequently parsed or extracted.
 with Path(path).open('rb') as f:
  require(os.fstat(f.fileno()).st_size<MAX_BYTES,'tar too large')
  raw=f.read(MAX_BYTES)
 require(len(raw)<MAX_BYTES,'tar too large');require(sha(raw)==archive_sha,'tar digest mismatch')
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as tf:
  members=tf.getmembers();check_names([m.name for m in members]);require(set(m.name for m in members)==set(manifest),'tar extra/missing entries')
  for m in members:
   require(m.type==tarfile.REGTYPE and not m.pax_headers and not m.linkname,'nonregular or extended tar entry')
   pin=manifest[m.name];require(m.size==pin['bytes'],'tar size mismatch')
   require(sha(tf.extractfile(m).read())==pin['sha256'],'tar content mismatch')
 return raw

def validate_tar(path,manifest,archive_sha):
 validated_tar_bytes(path,manifest,archive_sha)

def extract_fresh(path,dest,manifest,archive_sha):
 dest=no_link_ancestors(dest);require(not dest.exists(),'destination already exists');disjoint(path,dest)
 raw=validated_tar_bytes(path,manifest,archive_sha) # Immutable snapshot, full validation before any writes.
 dest.mkdir()
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as tf:
  for member in tf:
   # Defense in depth: even each buffered entry is checked before creating its path.
   safe_name(member.name);require(member.name in manifest,'unexpected write member')
   data=tf.extractfile(member).read();pin=manifest[member.name]
   require(len(data)==pin['bytes'] and sha(data)==pin['sha256'],'changed write member')
   p=dest/member.name;p.parent.mkdir(parents=True,exist_ok=True)
   with p.open('xb') as f:f.write(data)
   p.chmod(0o444)
 verify_tree(dest,manifest)
 return dest
def write_json(path,value):
 with Path(path).open('x') as f:json.dump(value,f,indent=2);f.write('\n')
