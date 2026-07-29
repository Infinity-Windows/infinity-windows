#!/usr/bin/env python3
"""Turn the raw Management API responses into one inventory file per project.

Called by `scripts/supabase-inventory.sh`, which does all the HTTP. Keeping the
shaping here means the JSON contract lives next to the code that reads it
(`scripts/supabase_merge_lib.load_inventory`) and can be unit tested without a
network call.

An API error for one section degrades that section to `null` and keeps going: a
project whose storage cannot be read is still worth inventorying, and a `null`
is honest in a way that a `0` is not.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any


def _rows(path: str | None) -> tuple[list[dict[str, Any]], str | None]:
    """Read a Management API response. Returns (rows, error message)."""
    if not path:
        return [], "not requested"
    try:
        data = json.loads(Path(path).read_text() or "null")
    except (OSError, json.JSONDecodeError) as exc:
        return [], f"unreadable response ({exc})"
    if data is None:
        return [], "empty response"
    if isinstance(data, dict):
        message = data.get("message") or data.get("error") or json.dumps(data)[:200]
        return [], str(message)
    if not isinstance(data, list):
        return [], f"unexpected response type {type(data).__name__}"
    return [r for r in data if isinstance(r, dict)], None


def build(args: argparse.Namespace) -> dict[str, Any]:
    projects, _ = _rows(args.projects)
    meta = next((p for p in projects if p.get("id") == args.ref), {})

    table_rows, tables_err = _rows(args.tables)
    column_rows, columns_err = _rows(args.columns)
    migration_rows, migrations_err = _rows(args.migrations)
    auth_rows, auth_err = _rows(args.auth)
    storage_rows, storage_err = _rows(args.storage)
    function_rows, functions_err = _rows(args.functions)

    columns_by_table: dict[str, dict[str, str]] = {}
    nullable_by_table: dict[str, list[str]] = {}
    for row in column_rows:
        table = row.get("table_name")
        column = row.get("column_name")
        if not table or not column:
            continue
        columns_by_table.setdefault(table, {})[column] = row.get("data_type") or "unknown"
        if row.get("is_nullable") == "YES":
            nullable_by_table.setdefault(table, []).append(column)

    tables: dict[str, Any] = {}
    for row in table_rows:
        name = row.get("table_name")
        if not name:
            continue
        count = row.get("row_count")
        tables[name] = {
            "rows": int(count) if count is not None else None,
            "columns": columns_by_table.get(name, {}),
            "nullable": sorted(nullable_by_table.get(name, [])),
        }

    migration = migration_rows[0] if migration_rows else {}
    auth = auth_rows[0] if auth_rows else {}

    inventory: dict[str, Any] = {
        "project_ref": args.ref,
        "name": meta.get("name"),
        "region": meta.get("region"),
        "organization_id": meta.get("organization_id"),
        "created_at": meta.get("created_at"),
        "status": meta.get("status"),
        "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "management-api",
        "tables": tables,
        "table_count": len(tables),
        "total_rows": sum(t["rows"] or 0 for t in tables.values()),
        "migrations": {
            "count": migration.get("migration_count"),
            "latest": migration.get("latest_version"),
        },
        "auth": {
            "users": auth.get("user_count"),
            "signed_in": auth.get("signed_in_count"),
        },
        "storage": {
            "buckets": [
                {
                    "name": b.get("bucket"),
                    "public": b.get("public"),
                    "objects": b.get("objects"),
                }
                for b in storage_rows
            ],
            "total_objects": sum(int(b.get("objects") or 0) for b in storage_rows),
        },
        "functions": sorted(
            (
                {
                    "slug": f.get("slug"),
                    "name": f.get("name"),
                    "status": f.get("status"),
                    "version": f.get("version"),
                    "updated_at": f.get("updated_at"),
                }
                for f in function_rows
                if f.get("slug")
            ),
            key=lambda f: f["slug"] or "",
        ),
        "errors": {
            k: v
            for k, v in {
                "tables": tables_err,
                "columns": columns_err,
                "migrations": migrations_err,
                "auth": auth_err,
                "storage": storage_err,
                "functions": functions_err,
            }.items()
            if v
        },
    }
    return inventory


def render(inv: dict[str, Any]) -> str:
    """The human-readable half of the report."""
    lines: list[str] = []
    add = lines.append

    add(f"Project      {inv['project_ref']}  {inv.get('name') or '(name unavailable)'}")
    add(f"Region       {inv.get('region') or '?'}")
    add(f"Org          {inv.get('organization_id') or '?'}")
    add(f"Created      {inv.get('created_at') or '?'}")
    add(f"Status       {inv.get('status') or '?'}")
    add("")

    tables = inv["tables"]
    populated = {n: t for n, t in tables.items() if (t["rows"] or 0) > 0}
    empty = sorted(n for n, t in tables.items() if t["rows"] == 0)

    add(f"Tables       {len(tables)} in public "
        f"({len(populated)} with rows, {len(empty)} empty)")
    add(f"Rows         {inv['total_rows']} total")
    mig = inv["migrations"]
    add(f"Migrations   {mig['count'] if mig['count'] is not None else 'no history table'}"
        f"   latest {mig['latest'] or '-'}")
    auth = inv["auth"]
    add(f"Auth users   {auth['users'] if auth['users'] is not None else 'unreadable'}"
        f"   ({auth['signed_in'] if auth['signed_in'] is not None else '?'} have signed in)")
    buckets = inv["storage"]["buckets"]
    add(f"Storage      {len(buckets)} bucket(s), {inv['storage']['total_objects']} object(s)")
    for b in buckets:
        visibility = "public" if b["public"] else "private"
        add(f"               {b['name']:<20} {visibility:<8} {b['objects']} object(s)")
    add(f"Functions    {len(inv['functions'])} deployed")
    for f in inv["functions"]:
        add(f"               {f['slug']:<32} v{f.get('version') or '?'} {f.get('status') or ''}")
    add("")

    if populated:
        add("Row counts (non-empty tables):")
        for name in sorted(populated, key=lambda n: (-(populated[n]["rows"] or 0), n)):
            add(f"  {name:<36} {populated[name]['rows']:>7}")
        add("")

    if empty:
        # Listed on purpose. An empty table is a very different thing from a
        # missing one, and reading them side by side is how the difference gets
        # noticed.
        add(f"Empty but present ({len(empty)}):")
        add("  " + ", ".join(empty))
        add("")

    if inv["errors"]:
        add("Could not read:")
        for section, message in inv["errors"].items():
            add(f"  {section}: {message}")
        add("")

    return "\n".join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ref", required=True)
    p.add_argument("--projects")
    p.add_argument("--tables")
    p.add_argument("--columns")
    p.add_argument("--migrations")
    p.add_argument("--auth")
    p.add_argument("--storage")
    p.add_argument("--functions")
    p.add_argument("--out", required=True)
    args = p.parse_args()

    inventory = build(args)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n")

    print(render(inventory))
    print(f"-> {out}")
    if inventory["errors"]:
        print("(sections above marked unreadable are recorded as null, not zero)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
