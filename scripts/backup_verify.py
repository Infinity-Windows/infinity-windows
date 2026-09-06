#!/usr/bin/env python3
"""Prove a backup archive reads back as what its manifest says.

    scripts/backup_verify.py <archive.tar.gz | unpacked-directory>

Exit 0 when every dump named in MANIFEST.json is present, the same size and
the same sha256, and every stored file that storage-manifest.json hashed
still hashes the same. Exit 1 on any mismatch — or when there is no manifest,
because a copy nobody can check is not a copy anybody should trust.

WHY A SEPARATE STEP. "Write the manifest" hashes the dumps and "Package it"
tars them, in the same job, from the same memory. Nothing between them and
the upload ever reads the archive back. A tar that truncated, a disk that
filled, a dump the next step overwrote — every one of those uploads a file
with a confident manifest inside it, and the Sunday restore test finds out
six days later. This unpacks the archive to a fresh directory, with no memory
of the step that wrote it, and re-hashes everything before it leaves.

A stored file the manifest lists but the archive lacks is REPORTED, not
failed: the nightly job already fails itself at the end when the file copy
came up short, and says so in its own words. What this fails on is a file
that is there and is not what the manifest says it is.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tarfile
import tempfile


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def unpack(archive: str, into: str) -> str:
    """Extract and return the one top-level directory the archive holds."""
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        for m in members:
            if m.name.startswith("/") or ".." in m.name.split("/"):
                raise SystemExit(f"refusing to unpack {archive}: unsafe path {m.name!r}")
        tar.extractall(into)
    tops = sorted({m.name.split("/")[0] for m in members if m.name})
    if len(tops) != 1:
        raise SystemExit(f"{archive} holds {len(tops)} top-level entries; expected the one dated directory")
    return os.path.join(into, tops[0])


def verify_dir(root: str) -> tuple[list[str], list[str], dict]:
    """(problems, warnings, counts) for an unpacked backup directory."""
    problems: list[str] = []
    warnings: list[str] = []
    counts = {"dumps": 0, "objects_checked": 0, "objects_missing": 0}

    manifest_path = os.path.join(root, "MANIFEST.json")
    try:
        with open(manifest_path) as fh:
            manifest = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return [f"MANIFEST.json is missing or unreadable ({exc}); nothing can be checked"], warnings, counts

    dumps = manifest.get("dumps") or {}
    if not dumps:
        problems.append("MANIFEST.json names no dumps, so there is nothing to check the archive against")
    for name, expected in sorted(dumps.items()):
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            problems.append(f"{name} is named in the manifest but is not in the archive")
            continue
        size = os.path.getsize(path)
        if size != expected.get("bytes"):
            problems.append(f"{name} is {size} bytes; the manifest says {expected.get('bytes')}")
        digest = sha256_of(path)
        if digest != expected.get("sha256"):
            problems.append(f"{name} does not hash to what the manifest says (got {digest[:12]}…, expected {str(expected.get('sha256'))[:12]}…)")
        counts["dumps"] += 1

    storage_manifest = os.path.join(root, "storage-manifest.json")
    if os.path.isfile(storage_manifest):
        try:
            with open(storage_manifest) as fh:
                objects = (json.load(fh) or {}).get("objects") or []
        except (OSError, json.JSONDecodeError) as exc:
            problems.append(f"storage-manifest.json is unreadable ({exc})")
            objects = []
        for obj in objects:
            expected = obj.get("sha256")
            bucket, rel = obj.get("bucket"), obj.get("path")
            if not expected or not bucket or not rel:
                continue
            local = os.path.join(root, "storage", bucket, rel)
            if not os.path.isfile(local):
                counts["objects_missing"] += 1
                continue
            if sha256_of(local) != expected:
                problems.append(f"storage/{bucket}/{rel} does not hash to what storage-manifest.json says")
            counts["objects_checked"] += 1
        if counts["objects_missing"]:
            warnings.append(
                f"{counts['objects_missing']} stored file(s) the manifest lists are not in the archive "
                "(the nightly job reports that on its own)"
            )
    return problems, warnings, counts


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write(__doc__)
        return 2
    target = argv[1]
    if os.path.isdir(target):
        problems, warnings, counts = verify_dir(target)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            root = unpack(target, tmp)
            problems, warnings, counts = verify_dir(root)
    for w in warnings:
        print(f"WARNING: {w}")
    if problems:
        print(f"FAIL: the archive does not read back as its manifest says ({len(problems)} problem(s)):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(
        f"OK: archive reads back as its manifest says — {counts['dumps']} dump(s) and "
        f"{counts['objects_checked']} stored file(s) re-hashed from a fresh unpack."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
