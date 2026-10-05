"""Verify existing prerequisite source. This module never contacts a database."""
import argparse,hashlib,json
from pathlib import Path,PurePosixPath

def verify(repository):
    pins=json.loads(Path(__file__).with_name('prerequisite-pins.json').read_text())['files']
    for name,digest in pins.items():
        rel=PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts:raise RuntimeError('Unsafe input path')
        path=repository/Path(name)
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
            raise RuntimeError('Prerequisite source mismatch: '+name)
    return {'status':'SOURCE_VERIFIED','files':len(pins),'databaseContacted':False}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--repository',type=Path,required=True);a=p.parse_args()
    print(json.dumps(verify(a.repository),indent=2))
