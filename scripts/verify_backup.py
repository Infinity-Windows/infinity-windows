#!/usr/bin/env python3
"""Prove a backup file matches the live database it claims to copy.

    scripts/verify_backup.py <project-ref> <out-dir>

Re-counts every table directly against the project, re-lists the live catalog,
re-checks auth/storage totals, and re-hashes every downloaded storage object.
Exits non-zero on any mismatch. Read-only.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from backup_project import (  # noqa: E402
    REDACTED_COLUMNS,
    REDACTION_MARKER,
    list_schemas,
    list_tables,
    row_counts,
)
from mgmt_query import query  # noqa: E402


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    ref, out_dir = sys.argv[1], sys.argv[2].rstrip("/")
    path = f"{out_dir}/2026-07-29-{ref}-full.json"

    problems: list[str] = []
    checks: list[str] = []

    with open(path) as fh:
        backup = json.load(fh)
    checks.append(f"JSON parses ({os.path.getsize(path)} bytes)")

    if backup.get("project_id") != ref:
        problems.append(f"project_id is {backup.get('project_id')!r}, expected {ref!r}")

    # 1. The live catalog must not contain a table the backup never mentions.
    schemas = list_schemas(ref)
    live = list_tables(ref, schemas)
    live_keys = {(t["schema"], t["name"]) for t in live}
    inventory = {(e["schema"], e["table"]): e for e in backup["_meta"]["tables"]}
    missing = live_keys - set(inventory)
    extra = set(inventory) - live_keys
    if missing:
        problems.append(f"tables in the live catalog but absent from the backup: {sorted(missing)}")
    if extra:
        problems.append(f"tables in the backup but not in the live catalog: {sorted(extra)}")
    checks.append(f"catalog matches: {len(live_keys)} relations in {len(schemas)} user schema(s)")

    # 2. Every row count must match the live database exactly.
    live_counts = row_counts(ref, live)
    mismatched, verified_rows = 0, 0
    for key, count in sorted(live_counts.items()):
        entry = inventory.get(key)
        if entry is None:
            continue
        if entry.get("row_count") != count:
            problems.append(f"{key[0]}.{key[1]}: backup says {entry.get('row_count')}, live says {count}")
            mismatched += 1
            continue
        if count == 0:
            continue
        json_key = entry.get("json_key") or (
            key[1] if key[0] == "public" else f"{key[0]}.{key[1]}"
        )
        stored = backup.get(json_key)
        if not isinstance(stored, list):
            problems.append(f"{key[0]}.{key[1]}: has {count} live rows but no rows in the backup")
            mismatched += 1
        elif len(stored) != count:
            problems.append(f"{key[0]}.{key[1]}: {len(stored)} rows stored, {count} live")
            mismatched += 1
        else:
            verified_rows += count
    checks.append(
        f"row counts re-verified against the live database: "
        f"{len(live_counts)} tables, {verified_rows} rows, {mismatched} mismatches"
    )

    if verified_rows != backup["_meta"]["total_rows"]:
        problems.append(
            f"_meta.total_rows is {backup['_meta']['total_rows']}, verified {verified_rows}"
        )

    for failure in backup["_meta"].get("capture_failures") or []:
        problems.append(f"capture failure recorded in the backup: {failure}")

    # 3. Auth and storage totals.
    live_users = int(query(ref, "select count(*) as n from auth.users")[0]["n"])
    if live_users != backup["_auth"]["user_count"]:
        problems.append(f"auth users: backup {backup['_auth']['user_count']}, live {live_users}")
    checks.append(f"auth users match: {live_users}")

    live_obj = query(
        ref,
        "select count(*) as n, coalesce(sum((metadata->>'size')::bigint),0) as b "
        "from storage.objects",
    )[0]
    if int(live_obj["n"]) != backup["_storage"]["object_count"]:
        problems.append(
            f"storage objects: backup {backup['_storage']['object_count']}, live {live_obj['n']}"
        )
    if int(live_obj["b"]) != int(backup["_storage"]["total_bytes"]):
        problems.append(
            f"storage bytes: backup {backup['_storage']['total_bytes']}, live {live_obj['b']}"
        )
    checks.append(f"storage matches: {live_obj['n']} objects, {live_obj['b']} bytes")

    # 4. Every downloaded object still hashes to what was recorded.
    hashed = 0
    for obj in backup["_storage"]["objects"]:
        if not obj.get("bytes_backed_up"):
            problems.append(f"object bytes not backed up: {obj['bucket_id']}/{obj['name']}")
            continue
        local = obj["local_path"]
        if not os.path.exists(local):
            local = f"{out_dir}/{ref}-storage/{obj['bucket_id']}/{obj['name']}"
        if not os.path.exists(local):
            problems.append(f"missing downloaded file: {obj['local_path']}")
            continue
        digest = hashlib.sha256(open(local, "rb").read()).hexdigest()
        if digest != obj.get("sha256"):
            problems.append(f"sha256 mismatch for {obj['local_path']}")
        elif os.path.getsize(local) != int(obj["size_bytes"] or 0):
            problems.append(f"size mismatch for {obj['local_path']}")
        else:
            hashed += 1
    checks.append(f"storage object bytes re-hashed on disk: {hashed}/{len(backup['_storage']['objects'])}")

    # 5. No credential value may survive in any stored row.
    leaked = 0
    for key, value in backup.items():
        if key.startswith("_") or not isinstance(value, list):
            continue
        for row in value:
            if not isinstance(row, dict):
                continue
            for column in REDACTED_COLUMNS & set(row):
                if row[column] not in (None, "", REDACTION_MARKER):
                    problems.append(f"unredacted credential left in {key}.{column}")
                    leaked += 1
    checks.append(
        f"credential columns redacted: {len(backup['_meta'].get('redactions') or [])} "
        f"recorded, {leaked} unredacted values found"
    )

    # 6. Schema DDL must actually be present for the tables we captured.
    ddl = backup.get("_schema") or {}
    if live_keys and not ddl.get("columns"):
        problems.append("_schema.columns is empty although the project has tables")
    cols_by_table = {(c["schema"], c["table"]) for c in ddl.get("columns", [])}
    no_ddl = {k for k in live_keys if k not in cols_by_table}
    if no_ddl:
        problems.append(f"no column DDL captured for: {sorted(no_ddl)}")
    checks.append(
        f"schema DDL present: {len(ddl.get('columns', []))} columns, "
        f"{len(ddl.get('constraints', []))} constraints, {len(ddl.get('indexes', []))} indexes, "
        f"{len(ddl.get('rls_policies', []))} RLS policies, {len(ddl.get('functions', []))} functions, "
        f"{len(ddl.get('triggers', []))} triggers, {len(ddl.get('views', []))} views, "
        f"{len(ddl.get('enums', []))} enums, {len(ddl.get('extensions', []))} extensions"
    )

    print(f"=== verifying {path}")
    for c in checks:
        print(f"  OK   {c}")
    for p in problems:
        print(f"  FAIL {p}")
    if problems:
        raise SystemExit(f"{len(problems)} verification problem(s) for {ref}")
    print(f"  ALL CHECKS PASSED for {ref}")


if __name__ == "__main__":
    main()
