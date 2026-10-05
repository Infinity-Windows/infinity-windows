"""Source-only fixture packaging; no SQL, provider or database operations."""
def require(ok, message='Source bundle check failed'):
    if not ok:
        raise RuntimeError(message)

import argparse, hashlib, json, tarfile
from pathlib import Path, PurePosixPath
EXPECTED = {'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-1': '57c3e7b498cd5134bd17f99a7cba337fe8d83c6a3c047d0c825df2e66b1b8686', 'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-2': '13c0e341fca7f0c9f27c7418d0e19dfccdbe2ada338a58beca13683e79429f09', 'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-3': 'c54049b093270d02952bd3d3e5fe8e5f547a84901b598d7654b29c0774f0af7b', 'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-4': 'c9a58cff0701c72bc4f58f982fa68bb480eba07b80bd34c99d85e47938f1446d', 'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-5': 'cad789b5b104318498a26098eed50afad5dd8f81bdf739dd1ecfc2b5061b718f'}

def sha(b):
    return hashlib.sha256(b).hexdigest()

def verify(archive, digest, destination):
    require(not destination.exists() and sha(archive.read_bytes()) == digest)
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        names = [m.name for m in members]
        require(len(names) == len(set(names)) == 294)
        for m in members:
            rel = PurePosixPath(m.name)
            require(m.isfile() and (not rel.is_absolute()) and ('..' not in rel.parts) and (rel.parts[0] in EXPECTED))
        expected = {}
        for (name, h) in EXPECTED.items():
            member = name + '/MANIFEST.json'
            raw = tar.extractfile(member).read()
            require(sha(raw) == h)
            expected[member] = {'bytes': len(raw), 'sha256': h}
            for row in json.loads(raw)['files']:
                rel = PurePosixPath(row['path'])
                require(not rel.is_absolute() and '..' not in rel.parts)
                key = name + '/' + str(rel)
                require(key not in expected)
                expected[key] = row
        require(set(names) == set(expected))
        for m in members:
            raw = tar.extractfile(m).read()
            row = expected[m.name]
            require(len(raw) == row['bytes'] and sha(raw) == row['sha256'])
        destination.mkdir(parents=True)
        for m in members:
            path = destination / Path(m.name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(tar.extractfile(m).read())
    return {'status': 'ALL_294_SOURCE_FILES_VERIFIED_AND_EXTRACTED', 'archiveSha256': digest, 'manifests': EXPECTED, 'databaseContacted': False}
if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--sha256', required=True)
    p.add_argument('--destination', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(verify(a.archive, a.sha256, a.destination), indent=2))
