"""Verify the entire immutable reader source archive before any destination write.

This module uses only the Python standard library. No bundled source is imported.
"""
import argparse
import hashlib
import io
import json
import os
import re
import stat
import tarfile
from pathlib import Path, PurePosixPath

MANIFESTS = {
    'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-1': '57c3e7b498cd5134bd17f99a7cba337fe8d83c6a3c047d0c825df2e66b1b8686',
    'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-2': '13c0e341fca7f0c9f27c7418d0e19dfccdbe2ada338a58beca13683e79429f09',
    'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-3': 'c54049b093270d02952bd3d3e5fe8e5f547a84901b598d7654b29c0774f0af7b',
    'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-4': 'c9a58cff0701c72bc4f58f982fa68bb480eba07b80bd34c99d85e47938f1446d',
    'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-5': 'cad789b5b104318498a26098eed50afad5dd8f81bdf739dd1ecfc2b5061b718f',
    'COMBINED-GENUINE-EXECUTOR-SOURCE-CHECKPOINT-6': '192ef7d8f40fcc87da11e56df022255c9822b1818374c88b6bd5d177f5528c57',
    'COMBINED-READER-CHARACTERIZATION-SOURCE-CHECKPOINT-4': '2d4c23fe57bcf5d827640c35deec4b3a3b955f5d6049a6bd0262ecfec7ba4d9c',
    'COMBINED-F6C04-READER-TIMEOUT-DIAGNOSIS-1': 'e06bea763a75a39305f55869d155a25f59d965d4b272bb7395ed84274fff81e7',
    'COMBINED-F6C04-READER-TIMEOUT-DIAGNOSIS-3': '44681780ec32b643250cd1a4eefbabd40d6c1a40cef6bc10b65e4c2b127fba31',
    'COMBINED-READER-CHARACTERIZATION-SAFETY-REVIEW-1': '8e7115a0bb9a1d7cf5ff98735f0d7d72a2e880632996e0b8c90e0809636436e1',
    'COMBINED-READER-CHARACTERIZATION-SAFETY-REVIEW-2': 'ad24102e6afd132a9d75ef605334f1b9519765393b83f82de01a6ea06c3bdc62',
}
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_MEMBER = 12 * 1024 * 1024
EXPECTED_COUNT = 431
HEX = re.compile(r'[0-9a-f]{64}\Z')


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def safe_name(value):
    require(isinstance(value, str) and value and '\\' not in value and '\x00' not in value, 'unsafe name')
    rel = PurePosixPath(value)
    require(not rel.is_absolute() and all(x not in ('', '.', '..') for x in value.split('/')) and str(rel) == value, 'unsafe path')
    return rel


def manifest_rows(raw):
    data = json.loads(raw)
    require(isinstance(data, dict) and isinstance(data.get('files'), (list, dict)), 'invalid manifest')
    files = data['files']
    if isinstance(files, dict):
        entries = [dict(value, path=key) for key, value in files.items() if isinstance(value, dict) and set(value) == {'bytes', 'sha256'}]
        require(len(entries) == len(files), 'invalid manifest map')
    else:
        entries = files
    result = {}
    for row in entries:
        require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'invalid manifest row')
        name = str(safe_name(row['path']))
        require(name != 'MANIFEST.json' and name not in result, 'duplicate manifest path')
        require(type(row['bytes']) is int and 0 <= row['bytes'] <= MAX_MEMBER, 'invalid manifest size')
        require(isinstance(row['sha256'], str) and HEX.fullmatch(row['sha256']), 'invalid manifest digest')
        result[name] = {'bytes': row['bytes'], 'sha256': row['sha256']}
    return result


def inspect(raw, digest):
    require(len(raw) <= MAX_ARCHIVE and HEX.fullmatch(digest) and sha(raw) == digest, 'archive digest/size mismatch')
    observed = {}
    folded = set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tar:
        for member in tar:
            name = str(safe_name(member.name))
            require(member.isfile() and member.size <= MAX_MEMBER, 'nonregular or oversized member')
            require(name not in observed and name.casefold() not in folded, 'duplicate/case-colliding member')
            require(PurePosixPath(name).parts[0] in MANIFESTS, 'unexpected source directory')
            stream = tar.extractfile(member)
            require(stream is not None, 'unreadable member')
            content = stream.read(MAX_MEMBER + 1)
            require(len(content) == member.size, 'member size mismatch')
            observed[name] = content
            folded.add(name.casefold())
    expected = {}
    for directory, manifest_sha in MANIFESTS.items():
        key = directory + '/MANIFEST.json'
        require(key in observed and sha(observed[key]) == manifest_sha, 'manifest missing/digest mismatch')
        expected[key] = {'bytes': len(observed[key]), 'sha256': manifest_sha}
        for rel, row in manifest_rows(observed[key]).items():
            path = directory + '/' + rel
            require(path not in expected and path.casefold() not in {x.casefold() for x in expected}, 'manifest collision')
            expected[path] = row
    require(len(expected) == EXPECTED_COUNT and set(observed) == set(expected), 'member inventory mismatch')
    for name, content in observed.items():
        row = expected[name]
        require(len(content) == row['bytes'] and sha(content) == row['sha256'], 'member content mismatch: ' + name)
    return observed


def extract(archive, digest, destination):
    # Open exactly one bounded archive buffer, then validate every byte before mkdir.
    with archive.open('rb') as source:
        raw = source.read(MAX_ARCHIVE + 1)
        require(len(raw) <= MAX_ARCHIVE and source.read(1) == b'', 'archive too large')
    observed = inspect(raw, digest)
    destination = Path(destination).absolute()
    parent = destination.parent
    require(parent.exists() and parent.is_dir() and not parent.is_symlink(), 'unsafe destination parent')
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.mkdir(destination.name, 0o700, dir_fd=parent_fd)  # exclusive; reused destination refused
        root_fd = os.open(destination.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            for name, content in sorted(observed.items()):
                parts = safe_name(name).parts
                current = os.dup(root_fd)
                try:
                    for part in parts[:-1]:
                        try:
                            os.mkdir(part, 0o700, dir_fd=current)
                        except FileExistsError:
                            pass
                        next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                        os.close(current)
                        current = next_fd
                    fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=current)
                    try:
                        with os.fdopen(fd, 'wb') as output:
                            output.write(content)
                    except BaseException:
                        raise
                finally:
                    os.close(current)
        finally:
            os.close(root_fd)
    finally:
        os.close(parent_fd)
    return {'status': 'ALL_431_SOURCE_FILES_VERIFIED_AND_EXTRACTED', 'archiveSha256': digest, 'files': len(observed), 'databaseContacted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(extract(args.archive, args.sha256, args.destination), indent=2))
