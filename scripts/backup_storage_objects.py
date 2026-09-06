#!/usr/bin/env python3
"""Copy the bytes of every storage object in a project to a local folder.

    SUPABASE_SERVICE_ROLE_KEY=... scripts/backup_storage_objects.py \
        --ref czprjcskmzzagdztqonm --out backups/2026-09-05

Read-only against the project. Writes a manifest next to the files so the next
run can resume, and so a restore can prove it got everything back.

WHY THIS WAS REWRITTEN (2026-09-05). The first version of this script ran once,
by hand, on 2026-07-29, and three things about it meant it could never run
unattended:

  1. It read the object list out of a backup JSON produced by another script,
     so it only ever copied objects that file already knew about. The July run
     captured nine objects and NOT ONE install photo — the bucket installers
     fill every day was simply not in the list it was handed. It now asks the
     project what buckets and objects exist, so a new bucket is backed up the
     first night it exists rather than the day somebody remembers it.
  2. It asked the Management API to REVEAL the project's service key so it
     could sign a URL per object. That is a second, far more powerful
     credential to hold, and signing was a wasted round trip: the service key
     reads an object directly. It now uses SUPABASE_SERVICE_ROLE_KEY, which CI
     already holds, and never asks for a key to be revealed.
  3. A bucket over the size ceiling made it write "listing only" and copy
     NOTHING. A ceiling that turns one big file into zero backed-up files is
     worse than no ceiling. It now copies until the ceiling is reached, warns
     loudly, and records exactly what it did not get to.

The key is held in memory only. It is never printed, never written to the
manifest, and never put in a URL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from typing import Any, Callable, Dict, List, Optional, Tuple

# 2 GiB. Chosen to be larger than anything this project has held (the July
# snapshot was 23 MB) so the ceiling is a runaway-cost stop, not a routine
# limit. `--limit-bytes 0` turns it off.
DEFAULT_LIMIT = 2 * 1024 * 1024 * 1024

# Supabase's storage list endpoint caps a page at 100 whether you ask for more
# or not, so paging is not optional even on a small project.
PAGE = 100

MANIFEST_NAME = "storage-manifest.json"


class Storage:
    """The three storage calls this script makes, in one place so tests can
    replace them without a network, a key or a project."""

    def __init__(self, ref: str, key: str):
        self.base = "https://%s.supabase.co/storage/v1" % ref
        self._key = key

    def _headers(self) -> List[str]:
        return [
            "-H",
            "Authorization: Bearer %s" % self._key,
            "-H",
            "apikey: %s" % self._key,
        ]

    def buckets(self) -> List[Dict[str, Any]]:
        out = _curl(["-sS", "-f", "%s/bucket" % self.base] + self._headers())
        return json.loads(out)

    def list(self, bucket: str, prefix: str, offset: int) -> List[Dict[str, Any]]:
        body = json.dumps(
            {
                "prefix": prefix,
                "limit": PAGE,
                "offset": offset,
                # Sorted so two runs enumerate in the same order. Without it the
                # resume logic still works, but the "what did we not get to"
                # report would name different files each night for no reason.
                "sortBy": {"column": "name", "order": "asc"},
            }
        )
        out = _curl(
            [
                "-sS",
                "-f",
                "-X",
                "POST",
                "%s/object/list/%s" % (self.base, bucket),
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                "@-",
            ]
            + self._headers(),
            stdin=body,
        )
        return json.loads(out)

    def download(self, bucket: str, path: str, dest: str) -> None:
        _curl(
            [
                "-sS",
                "-f",
                "-o",
                dest,
                "%s/object/%s/%s" % (self.base, bucket, _quote(path)),
            ]
            + self._headers()
        )


def _quote(path: str) -> str:
    from urllib.parse import quote

    return quote(path, safe="/")


def _curl(args: List[str], stdin: Optional[str] = None) -> str:
    # curl rather than urllib to match the rest of scripts/: a urllib client is
    # refused by the WAF in front of the Supabase APIs, and that failure looks
    # like an outage rather than a client problem.
    proc = subprocess.run(
        ["curl"] + args,
        input=stdin,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        # curl echoes the failing URL, which carries no credential — the key is
        # only ever in a header — so this is safe to surface.
        raise RuntimeError(
            "curl exited %d: %s" % (proc.returncode, (proc.stderr or "").strip()[:300])
        )
    return proc.stdout


def walk(api: Storage, bucket: str) -> List[Dict[str, Any]]:
    """Every object in a bucket, at every depth.

    Supabase's list endpoint is a directory listing, not a tree: a "folder" comes
    back as an entry with a null id. Plansets and install media are both stored
    under a folder per project, so a non-recursive walk finds nothing at all.
    """
    found: List[Dict[str, Any]] = []
    stack = [""]
    seen_prefixes = set()
    while stack:
        prefix = stack.pop()
        if prefix in seen_prefixes:
            continue
        seen_prefixes.add(prefix)
        offset = 0
        while True:
            page = api.list(bucket, prefix, offset)
            if not page:
                break
            for entry in page:
                name = entry.get("name")
                if not name:
                    continue
                full = "%s%s" % (prefix, name)
                if entry.get("id") is None:
                    stack.append(full + "/")
                    continue
                meta = entry.get("metadata") or {}
                found.append(
                    {
                        "bucket": bucket,
                        "path": full,
                        "size": int(meta.get("size") or 0),
                        # etag changes when the bytes change, so it is what makes
                        # "skip this, it is the same file" safe. Some deployments
                        # quote it; strip so last night's value still compares.
                        "etag": str(meta.get("eTag") or meta.get("etag") or "").strip('"'),
                        "mimetype": meta.get("mimetype") or "",
                        "updated_at": entry.get("updated_at") or "",
                    }
                )
            if len(page) < PAGE:
                break
            offset += PAGE
    found.sort(key=lambda o: o["path"])
    return found


def load_manifest(path: str) -> Dict[str, Dict[str, Any]]:
    """Last run's manifest, keyed by bucket/path, or empty if there is none."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as fh:
            prior = json.load(fh)
    except (ValueError, OSError):
        # A half-written manifest means the last run died mid-write. Copying
        # everything again is slow; refusing to run is worse.
        return {}
    return {
        "%s/%s" % (o["bucket"], o["path"]): o for o in prior.get("objects", []) if o.get("path")
    }


def unchanged(prior: Dict[str, Any], live: Dict[str, Any], local: str) -> bool:
    """Whether last night's copy of this object can stand.

    Size AND etag, plus the file actually being on disk. Etag alone would trust
    a manifest entry whose file somebody deleted; size alone would miss an edit
    that happened to preserve the length.
    """
    if not prior.get("copied"):
        return False
    if not os.path.exists(local):
        return False
    if int(prior.get("size") or -1) != int(live.get("size") or -2):
        return False
    if not prior.get("etag") or prior.get("etag") != live.get("etag"):
        return False
    return os.path.getsize(local) == int(live.get("size") or -2)


def run(
    api: Storage,
    out_dir: str,
    limit_bytes: int,
    log: Callable[[str], None] = print,
) -> Dict[str, Any]:
    media_dir = os.path.join(out_dir, "storage")
    manifest_path = os.path.join(out_dir, MANIFEST_NAME)
    prior = load_manifest(manifest_path)

    buckets = [b["name"] for b in api.buckets() if b.get("name")]
    buckets.sort()
    log("buckets: %s" % (", ".join(buckets) or "(none)"))

    objects: List[Dict[str, Any]] = []
    for bucket in buckets:
        objects.extend(walk(api, bucket))

    total_bytes = sum(o["size"] for o in objects)
    log("%d object(s), %d bytes across %d bucket(s)" % (len(objects), total_bytes, len(buckets)))

    copied = reused = skipped = failed = 0
    bytes_written = 0
    warnings: List[str] = []
    failures: List[str] = []

    for obj in objects:
        key = "%s/%s" % (obj["bucket"], obj["path"])
        local = os.path.join(media_dir, obj["bucket"], obj["path"])
        was = prior.get(key)

        if was and unchanged(was, obj, local):
            obj["copied"] = True
            obj["sha256"] = was.get("sha256", "")
            obj["reused"] = True
            reused += 1
            continue

        if limit_bytes and bytes_written + obj["size"] > limit_bytes:
            # The whole point of the rewrite: warn and keep going rather than
            # turn one oversized bucket into an empty backup.
            obj["copied"] = False
            obj["skipped_reason"] = "would exceed the %d-byte ceiling" % limit_bytes
            skipped += 1
            continue

        os.makedirs(os.path.dirname(local), exist_ok=True)
        try:
            api.download(obj["bucket"], obj["path"], local)
            with open(local, "rb") as fh:
                data = fh.read()
            if obj["size"] and len(data) != obj["size"]:
                raise ValueError("size mismatch: listed %d, got %d" % (obj["size"], len(data)))
            obj["sha256"] = hashlib.sha256(data).hexdigest()
            obj["copied"] = True
            obj["reused"] = False
            copied += 1
            bytes_written += len(data)
        except Exception as exc:  # noqa: BLE001 - recorded per object, never silent
            obj["copied"] = False
            obj["error"] = str(exc)[:200]
            failed += 1
            failures.append("%s: %s" % (key, str(exc)[:160]))

    if skipped:
        warnings.append(
            "%d object(s) were not copied because the run reached the %d-byte ceiling. "
            "Everything under the ceiling WAS copied. Raise --limit-bytes, or pass 0 "
            "to turn the ceiling off." % (skipped, limit_bytes)
        )

    per_bucket = {}
    for bucket in buckets:
        rows = [o for o in objects if o["bucket"] == bucket]
        per_bucket[bucket] = {
            "objects": len(rows),
            "bytes": sum(o["size"] for o in rows),
            "copied": sum(1 for o in rows if o.get("copied")),
        }

    manifest = {
        "generated_at": _now(),
        "bucket_count": len(buckets),
        "buckets": per_bucket,
        "object_count": len(objects),
        "total_bytes": total_bytes,
        "copied": copied,
        "reused": reused,
        "skipped_over_ceiling": skipped,
        "failed": failed,
        "limit_bytes": limit_bytes,
        "warnings": warnings,
        "failures": failures,
        "objects": objects,
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")

    log(
        "copied %d, reused %d, skipped %d, failed %d (%d bytes written)"
        % (copied, reused, skipped, failed, bytes_written)
    )
    for line in warnings:
        log("WARNING: %s" % line)
    for line in failures:
        log("FAILED: %s" % line)
    return manifest


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ref", required=True, help="Supabase project ref")
    ap.add_argument(
        "--out",
        required=True,
        help="folder to write storage/ and %s into (a dated folder)" % MANIFEST_NAME,
    )
    ap.add_argument(
        "--limit-bytes",
        type=int,
        default=DEFAULT_LIMIT,
        help="stop copying once this many new bytes have been written; 0 for no ceiling",
    )
    args = ap.parse_args(argv)

    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not key:
        print(
            "SUPABASE_SERVICE_ROLE_KEY is not set. It is the credential that reads "
            "every object regardless of row-level security; without it this can only "
            "see public buckets.",
            file=sys.stderr,
        )
        return 2

    manifest = run(Storage(args.ref, key), args.out.rstrip("/"), args.limit_bytes)
    # A failure to copy an object is a failed backup. A ceiling skip is a warning
    # the job summary reports, because the rest of the copy is still good.
    return 1 if manifest["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
