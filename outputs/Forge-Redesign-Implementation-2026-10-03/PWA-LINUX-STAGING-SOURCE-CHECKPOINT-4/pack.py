"""Deterministic local content tar. No cloud publication or runtime."""
import io,tarfile,json
from pathlib import Path
from transport import inventory,sha,require,write_json,validate_tar,MAX_BYTES
O=Path(__file__).resolve().parent
m=inventory(O/'payload');write_json(O/'TRANSPORT-MANIFEST.json',m)
with tarfile.open(O/'payload.tar','w',format=tarfile.USTAR_FORMAT) as tf:
 for name,pin in m.items():
  b=(O/'payload'/name).read_bytes();entry=tarfile.TarInfo(name);entry.size=len(b);entry.mode=0o444;entry.uid=0;entry.gid=0;entry.mtime=0;entry.uname='';entry.gname='';tf.addfile(entry,io.BytesIO(b))
pins={'archiveSha256':sha((O/'payload.tar').read_bytes()),'manifestSha256':sha((O/'TRANSPORT-MANIFEST.json').read_bytes()),'archiveBytes':(O/'payload.tar').stat().st_size,'regularFiles':len(m),'payloadBytes':sum(x['bytes'] for x in m.values()),'format':'USTAR sorted files only; uid/gid/mtime zero; mode0444','published':False}
require(pins['archiveBytes']<MAX_BYTES,'tar exceeds25MB');validate_tar(O/'payload.tar',m,pins['archiveSha256']);write_json(O/'PACKAGE-PINS.json',pins);print(json.dumps(pins))
