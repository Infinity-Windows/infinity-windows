#!/usr/bin/env python3
"""Download the bytes of every storage object in a project, read-only.

    scripts/backup_storage_objects.py <project-ref> <out-dir> [max-total-bytes]

Reads the object list out of the project's backup JSON, downloads each object
with a short-lived signed URL, records a sha256 for each file, and writes the
result back into the backup's _storage section. Refuses to run if the total
size exceeds max-total-bytes (default 64 MiB) so a huge bucket is reported
rather than committed.

The project API key used to sign the URLs is held in memory only. It is never
printed and never written to disk.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from mgmt_query import get  # noqa: E402

DEFAULT_LIMIT = 64 * 1024 * 1024


def _service_key(ref: str) -> str:
    keys = get(f"/projects/{ref}/api-keys?reveal=true")
    if not isinstance(keys, list):
        raise SystemExit("could not read project API keys")
    for wanted in ("service_role", "secret"):
        for k in keys:
            if k.get("name") == wanted or k.get("type") == wanted:
                if k.get("api_key"):
                    return k["api_key"]
    raise SystemExit("no service key available; cannot download object bytes")


def _sign(ref: str, key: str, bucket: str, path: str) -> str:
    url = f"https://{ref}.supabase.co/storage/v1/object/sign/{bucket}/{path}"
    out = subprocess.run(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            url,
            "-H",
            f"Authorization: Bearer {key}",
            "-H",
            "apikey: " + key,
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
        ],
        input=json.dumps({"expiresIn": 600}),
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    try:
        signed = json.loads(out)["signedURL"]
    except (json.JSONDecodeError, KeyError):
        raise RuntimeError(f"could not sign {bucket}/{path}: {out[:200]}")
    return f"https://{ref}.supabase.co/storage/v1{signed}"


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    ref, out_dir = sys.argv[1], sys.argv[2].rstrip("/")
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_LIMIT

    backup_path = f"{out_dir}/2026-07-29-{ref}-full.json"
    with open(backup_path) as fh:
        backup = json.load(fh)
    storage = backup["_storage"]
    objects = storage["objects"]
    total = int(storage["total_bytes"] or 0)

    if not objects:
        storage["object_bytes_backed_up"] = True
        storage["object_bytes_note"] = "no objects exist in this project"
        _save(backup_path, backup)
        print("no storage objects to download")
        return

    if total > limit:
        storage["object_bytes_backed_up"] = False
        storage["object_bytes_note"] = (
            f"{total} bytes across {len(objects)} objects exceeds the "
            f"{limit}-byte commit limit. Only the listing is backed up; the file "
            "CONTENTS are NOT in this repository."
        )
        _save(backup_path, backup)
        print(f"TOO LARGE: {total} bytes > {limit}; listing only")
        return

    key = _service_key(ref)
    media_dir = f"{out_dir}/{ref}-storage"
    os.makedirs(media_dir, exist_ok=True)

    failures = []
    for obj in objects:
        bucket, name = obj["bucket_id"], obj["name"]
        dest = f"{media_dir}/{bucket}/{name}"
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            url = _sign(ref, key, bucket, name)
            subprocess.run(["curl", "-sS", "-f", "-o", dest, url], check=True)
            data = open(dest, "rb").read()
            obj["local_path"] = f"docs/backups/{ref}-storage/{bucket}/{name}"
            obj["sha256"] = hashlib.sha256(data).hexdigest()
            obj["downloaded_bytes"] = len(data)
            expected = int(obj["size_bytes"] or 0)
            if expected and len(data) != expected:
                raise ValueError(f"size mismatch: expected {expected}, got {len(data)}")
            obj["bytes_backed_up"] = True
        except Exception as exc:  # noqa: BLE001 - recorded, never silent
            obj["bytes_backed_up"] = False
            obj["download_error"] = str(exc)[:200]
            failures.append(f"{bucket}/{name}: {exc}"[:200])

    ok = sum(1 for o in objects if o.get("bytes_backed_up"))
    storage["object_bytes_backed_up"] = ok == len(objects)
    storage["object_bytes_local_dir"] = f"docs/backups/{ref}-storage/"
    storage["object_bytes_downloaded"] = ok
    storage["object_bytes_note"] = (
        f"all {ok} object(s), {total} bytes, downloaded and committed under "
        f"docs/backups/{ref}-storage/ with a sha256 per file"
        if ok == len(objects)
        else f"only {ok} of {len(objects)} objects downloaded; see download_error fields"
    )
    storage["download_failures"] = failures
    _save(backup_path, backup)
    print(f"downloaded {ok}/{len(objects)} objects ({total} bytes) into {media_dir}")
    if failures:
        print("FAILURES:", *failures, sep="\n  ")


def _save(path: str, backup: dict) -> None:
    with open(path, "w") as fh:
        json.dump(backup, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")


if __name__ == "__main__":
    main()
