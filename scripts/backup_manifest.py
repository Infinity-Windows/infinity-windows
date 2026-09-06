#!/usr/bin/env python3
"""Write the MANIFEST.json that makes a backup checkable.

    SUPABASE_ACCESS_TOKEN=... scripts/backup_manifest.py \
        --ref czprjcskmzzagdztqonm --out backups/2026-09-05

A dump file proves the CLI ran. It does not prove the dump holds the rows the
database held — a `pg_dump` that silently stopped halfway still writes a file,
still exits 0, and still tars up into an archive somebody will not open for a
year. So at the moment of the dump this asks the live database, once per table,
how many rows it has, and writes those numbers down beside the dump.

scripts/restore_verify.py then restores the dump into a throwaway Postgres and
insists the numbers come back. That pair — a count taken at dump time and the
same count taken after a restore — is the whole reason to trust the backup.

Read-only. Every query goes through scripts/mgmt_query.py, which refuses
anything that is not a SELECT.

The three "spot rows" are the check counts cannot do: a table can have exactly
the right number of rows and the wrong bytes in them. Only a hash of the row is
written down, never the row, because these tables hold crew names and hours.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from typing import Any, Callable, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import backup_project  # noqa: E402
from backup_project import list_schemas, list_tables, row_counts  # noqa: E402

MANIFEST_NAME = "MANIFEST.json"
SPOT_ROWS = 3


def canonical(row: Any) -> str:
    """One text form for a row, so a hash taken here and a hash taken after a
    restore can be compared at all. Both sides feed in `to_jsonb(t)::text`, so
    Postgres has already normalised the values; this only pins key order."""
    return json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)


def row_hash(row: Any) -> str:
    return hashlib.sha256(canonical(row).encode("utf-8")).hexdigest()


def spot_row_sql(schema: str, table: str) -> str:
    # `order by 1` over the row's own jsonb: a total order that depends only on
    # the data, so it picks the same row before and after a restore. Ordering by
    # ctid or by insertion order would not — a restore renumbers both.
    return 'select to_jsonb(t)::text as j from "%s"."%s" t order by 1 limit 1' % (schema, table)


def pick_spot_tables(counts: Dict[Any, int], limit: int = SPOT_ROWS) -> List[Any]:
    """The biggest non-empty tables, ties broken by name so two runs agree."""
    live = [(k, n) for k, n in counts.items() if n > 0]
    live.sort(key=lambda kv: (-kv[1], kv[0]))
    return [k for k, _ in live[:limit]]


def collect_spot_rows(ref: str, keys: List[Any], query: Callable) -> List[Dict[str, Any]]:
    out = []
    for schema, table in keys:
        rows = query(ref, spot_row_sql(schema, table))
        if not rows:
            continue
        parsed = json.loads(rows[0]["j"])
        out.append(
            {
                "schema": schema,
                "table": table,
                # The id the restore check will look the row up by. Absent on a
                # table with no `id` column, in which case the restore repeats
                # the ordering query instead.
                "id": parsed.get("id"),
                "sha256": row_hash(parsed),
            }
        )
    return out


def file_digest(path: str) -> Dict[str, Any]:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return {"bytes": os.path.getsize(path), "sha256": h.hexdigest()}


VERSION_SQL = "select current_setting('server_version_num') as v"


def version_from_num(num: Any) -> str:
    """Postgres's own `server_version_num`, as a dotted version.

    Postgres 10 and later pack the version as major * 10000 + minor, so this is
    arithmetic and not parsing. `server_version` is deliberately not the thing
    asked for: Debian- and Ubuntu-packaged servers append a vendor string to it
    ("15.8 (Ubuntu 15.8-1.pgdg22.04+1)"), and the restore test splits this value
    on the first dot to choose an image.
    """
    try:
        n = int(str(num).strip())
    except (TypeError, ValueError):
        return ""
    if n < 100000:  # 9.x packed the number differently; nothing here runs one
        return ""
    return "%d.%d" % (n // 10000, n % 10000)


def header_version(dump_path: str) -> str:
    """The version pg_dump wrote into a dump's own header, where it survived.

    Only `data.sql` is worth asking, and the reason is worth writing down: the
    SCHEMA pipeline in `supabase db dump` ends with `sed -E "/^--/d"`, which
    deletes EVERY comment line in the file — the `-- Dumped from database
    version 15.8` header along with them. The data-only pipeline keeps comments
    on purpose ("Never delete SQL comments because multiline records may begin
    with them"), so its header is still there.

    This used to read schema.sql, which meant it returned "" against every real
    dump the CLI has ever produced, and the weekly restore test could never get
    past choosing an image.
    """
    if not os.path.exists(dump_path):
        return ""
    with open(dump_path, errors="replace") as fh:
        for _ in range(40):
            line = fh.readline()
            if not line:
                break
            m = re.search(r"Dumped from database version ([0-9.]+)", line)
            if m:
                return m.group(1)
    return ""


def postgres_version(ref: str, out_dir: str, query: Callable) -> str:
    """Which Postgres this dump came out of.

    Asked of the database rather than read out of the dump, because what the
    dump says about itself depends on a sed pipeline inside a CLI that this
    repository does not own. The restore test picks its image from this value,
    and restoring a 15 dump into 17 mostly works and quietly is not the same
    database, so it has to be right rather than merely present.
    """
    rows = query(ref, VERSION_SQL)
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        got = version_from_num(rows[0].get("v", ""))
        if got:
            return got
    return header_version(os.path.join(out_dir, "data.sql"))


def git_sha() -> str:
    # In Actions the checked-out sha is the one that matters and is already in
    # the environment; on a laptop, ask git.
    env = os.environ.get("GITHUB_SHA", "").strip()
    if env:
        return env
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - a manifest without a sha is still useful
        return ""


def storage_summary(out_dir: str) -> Dict[str, Any]:
    path = os.path.join(out_dir, "storage-manifest.json")
    if not os.path.exists(path):
        return {"present": False, "note": "no storage manifest in this folder"}
    with open(path) as fh:
        sm = json.load(fh)
    return {
        "present": True,
        "buckets": sm.get("buckets", {}),
        "object_count": sm.get("object_count", 0),
        "total_bytes": sm.get("total_bytes", 0),
        "copied": sm.get("copied", 0),
        "reused": sm.get("reused", 0),
        "skipped_over_ceiling": sm.get("skipped_over_ceiling", 0),
        "failed": sm.get("failed", 0),
        "warnings": sm.get("warnings", []),
    }


def build(
    ref: str,
    out_dir: str,
    started_at: str,
    finished_at: str,
    query: Optional[Callable] = None,
) -> Dict[str, Any]:
    if query is None:
        from mgmt_query import query as live_query  # noqa: PLC0415

        query = live_query

    # backup_project owns the catalog SQL, and reusing it is the point: a
    # manifest that counted a different set of tables than the backup script
    # does would be a manifest that lies. Its helpers reach the database through
    # its own module-level `query`, so that is the seam the tests replace — this
    # whole function then runs offline against a fake catalog.
    prior_query, backup_project.query = backup_project.query, query
    try:
        schemas = list_schemas(ref)
        tables = list_tables(ref, schemas)
        counts = row_counts(ref, tables)
        spot = collect_spot_rows(ref, pick_spot_tables(counts), query)
    finally:
        backup_project.query = prior_query

    table_rows = [
        {"schema": s, "table": t, "rows": n} for (s, t), n in sorted(counts.items())
    ]
    total_rows = sum(r["rows"] for r in table_rows)

    dumps = {}
    for name in ("roles.sql", "schema.sql", "data.sql"):
        path = os.path.join(out_dir, name)
        if os.path.exists(path):
            dumps[name] = file_digest(path)

    return {
        "project_ref": ref,
        "git_sha": git_sha(),
        "started_at": started_at,
        "finished_at": finished_at,
        "postgres_version": postgres_version(ref, out_dir, query),
        "schemas": schemas,
        "table_count": len(table_rows),
        "total_rows": total_rows,
        "tables": table_rows,
        "spot_rows": spot,
        "dumps": dumps,
        "storage": storage_summary(out_dir),
    }


def summary_markdown(manifest: Dict[str, Any]) -> str:
    """The few lines a person should read in the morning.

    Deliberately totals, not a table-by-table breakdown: a workflow summary on a
    public repository is public, and how many installs the company has done is
    the company's business.
    """
    storage = manifest.get("storage") or {}
    lines = [
        "- **%s tables**, %s rows counted at dump time"
        % (manifest.get("table_count", 0), manifest.get("total_rows", 0)),
        "- **%s stored files**, %s bytes, across %s bucket(s)"
        % (
            storage.get("object_count", 0),
            storage.get("total_bytes", 0),
            len(storage.get("buckets") or {}),
        ),
        "- Postgres %s, from commit `%s`"
        % (manifest.get("postgres_version") or "unknown", (manifest.get("git_sha") or "")[:7]),
    ]
    if storage.get("failed"):
        lines.append("- **%s stored file(s) could not be copied**" % storage["failed"])
    for warning in storage.get("warnings") or []:
        lines.append("- WARNING: %s" % warning)
    return "\n".join(lines) + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ref", required=True)
    ap.add_argument(
        "--out",
        default=None,
        help="the dated backup folder (default: today's under backups/, which is gitignored)",
    )
    ap.add_argument("--started-at", default="", help="ISO time the dump began")
    ap.add_argument(
        "--summary", default="", help="also write the job-summary markdown to this path"
    )
    args = ap.parse_args(argv)

    if not os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip():
        print(
            "SUPABASE_ACCESS_TOKEN is not set, so the row counts that make this "
            "backup checkable cannot be taken.",
            file=sys.stderr,
        )
        return 2

    from backup_storage_objects import default_out_dir  # noqa: PLC0415

    out = (args.out or default_out_dir()).rstrip("/")
    import datetime

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = build(args.ref, out, args.started_at or now, now)

    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, MANIFEST_NAME), "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")

    if args.summary:
        with open(args.summary, "w") as fh:
            fh.write(summary_markdown(manifest))

    print(
        "manifest: %d tables, %d rows, %d storage object(s) in %d bucket(s)"
        % (
            manifest["table_count"],
            manifest["total_rows"],
            manifest["storage"].get("object_count", 0),
            len(manifest["storage"].get("buckets", {}) or {}),
        )
    )
    if not manifest["dumps"]:
        print("no dump files in %s — the manifest describes nothing" % out, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
