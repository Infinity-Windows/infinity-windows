"""Future official Linux Node archive/binary receipt; no network and no install."""
import hashlib,json,subprocess,sys,tarfile
from pathlib import Path
from transport import sha,require,no_link_ancestors,write_json

def receipt(node,archive,checksums,target):
 node=no_link_ancestors(node).resolve();archive=no_link_ancestors(archive);checksums=no_link_ancestors(checksums)
 require(archive.name=='node-v22.23.1-linux-x64.tar.xz','wrong distribution')
 lines=[l.split() for l in checksums.read_text().splitlines() if l.endswith('  '+archive.name)]
 require(len(lines)==1 and lines[0][0]==sha(archive.read_bytes()),'official checksum mismatch')
 with tarfile.open(archive,'r:xz') as tf:
  members=[m for m in tf.getmembers() if m.name=='node-v22.23.1-linux-x64/bin/node']
  require(len(members)==1 and members[0].isfile() and not members[0].issym() and not members[0].islnk(),'missing regular Node binary')
  extracted=sha(tf.extractfile(members[0]).read())
 require(sha(node.read_bytes())==extracted,'Node binary not official archive bytes')
 r=subprocess.run([str(node),'--experimental-strip-types','--eval','console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}))'],capture_output=True,text=True,env={k:v for k,v in __import__('os').environ.items() if k not in ['NODE_PATH','NODE_OPTIONS']})
 require(r.returncode==0,'Node strip-types refusal');identity=json.loads(r.stdout);require(identity=={'version':'v22.23.1','platform':'linux','arch':'x64'},'wrong Node identity')
 py=Path(sys.executable).resolve();version=subprocess.check_output([str(py),'--version'],text=True).strip()
 value={'nodeVersion':identity['version'],'nodePath':str(node),'binarySha256':extracted,'extractedNodeSha256':extracted,'experimentalStripTypesAccepted':True,'flagArgv':['--experimental-strip-types','--eval'],'flagExit':r.returncode,'flagStderr':r.stderr,'distributionUrl':'https://nodejs.org/dist/v22.23.1/'+archive.name,'distributionPath':str(archive.resolve()),'distributionSha256':sha(archive.read_bytes()),'checksumUrl':'https://nodejs.org/dist/v22.23.1/SHASUMS256.txt','checksumPath':str(checksums.resolve()),'checksumFileSha256':sha(checksums.read_bytes()),'python3Path':str(py),'python3Version':version,'a703NodePatch':'UNKNOWN; A703 selected major 22; exact 22.23.1 is protocol difference'}
 write_json(target,value);return value
if __name__=='__main__':
 require(len(sys.argv)==5,'node archive checksums receipt');receipt(*sys.argv[1:])
