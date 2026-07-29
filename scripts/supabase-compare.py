#!/usr/bin/env python3
"""Compare two or more Supabase inventories before merging them.

    python3 scripts/supabase-compare.py docs/inventory/*.json
    python3 scripts/supabase-compare.py --json a.json b.json
    python3 scripts/supabase-compare.py --backup docs/backups/*.json b.json

The one thing this tool refuses to blur is the difference between a table that
does not exist and a table that exists with no rows. Reading "0" for both is how
a production database was once reported clean while it was 31 tables short (see
docs/migration-drift-2026-07-29-production.md), and it is why the merge was
misdiagnosed the first time.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

from supabase_merge_lib import (  # noqa: E402
    MISSING,
    TableComparison,
    compare_inventories,
    inventory_from_backup,
    load_inventory,
    migration_leader,
    total_rows,
)


def _cell(state: str, count: int | None, width: int) -> str:
    if state == MISSING:
        return "MISSING".rjust(width)
    return str(count).rjust(width)


def is_uninitialised(inventory: dict[str, Any]) -> bool:
    """True for a project whose public schema has never been created.

    Such a project has no schema to disagree about, but comparing it table by
    table makes every table in every other project read as MISSING — which
    buries the real gaps under a wall of false ones and inverts the exit code.
    It is reported on its own instead. Note this is specifically "zero tables",
    not "zero rows": a project with empty tables has a schema and is compared
    normally, because empty and missing are exactly the distinction this tool
    exists to keep apart.
    """
    return not inventory.get("tables")


def render(
    inventories: Sequence[dict[str, Any]],
    comparisons: Sequence[TableComparison],
    uninitialised: Sequence[dict[str, Any]] = (),
) -> str:
    refs = [inv["project_ref"] for inv in inventories]
    width = max(11, max(len(r) for r in refs))
    lines: list[str] = []
    add = lines.append

    add("=" * (38 + (width + 2) * len(refs)))
    add("Supabase project comparison")
    add("=" * (38 + (width + 2) * len(refs)))
    add("")
    for inv in inventories:
        add(
            f"  {inv['project_ref']}  {inv.get('name') or '(unnamed)'}"
            f"   captured {inv.get('captured_at') or '?'}"
        )
        mig = inv.get("migrations") or {}
        auth = inv.get("auth") or {}
        storage = inv.get("storage") or {}
        add(
            f"      {len(inv.get('tables', {})):>3} tables"
            f" · {total_rows(inv):>5} rows"
            f" · {mig.get('count') if mig.get('count') is not None else '?':>3} migrations"
            f" · {auth.get('users') if auth.get('users') is not None else '?'} auth users"
            f" · {storage.get('total_objects') if storage.get('total_objects') is not None else '?'} storage objects"
            f" · {len(inv.get('functions') or [])} functions"
        )
    add("")

    if uninitialised:
        add("NOT COMPARED — no public schema at all")
        for inv in uninitialised:
            auth = inv.get("auth") or {}
            storage = inv.get("storage") or {}
            add(
                f"  {inv['project_ref']}  {inv.get('name') or '(unnamed)'}"
                f"   0 tables · {auth.get('users') or 0} auth users"
                f" · {storage.get('total_objects') or 0} storage objects"
                f" · {len(inv.get('functions') or [])} functions"
            )
        add("  An empty project has nothing to merge and nothing to lose. Excluded from")
        add("  the table comparison below so it does not report every table as MISSING.")
        add("")

    # --- headline: the distinction that matters -----------------------------
    missing_with_data = [
        c for c in comparisons if c.verdict == "MISSING WHERE DATA EXISTS ELSEWHERE"
    ]
    missing_no_data = [
        c for c in comparisons if c.verdict == "missing in some projects (no data anywhere)"
    ]
    differing = [c for c in comparisons if c.verdict == "row counts differ"]
    empty_everywhere = [c for c in comparisons if c.verdict == "exists everywhere, empty everywhere"]
    identical = [c for c in comparisons if c.verdict == "identical row counts"]

    add("SUMMARY")
    add(f"  {len(missing_with_data):>4}  table(s) MISSING somewhere but holding data elsewhere  <- schema gap with real data at stake")
    add(f"  {len(missing_no_data):>4}  table(s) missing somewhere, empty wherever they exist   <- schema gap only, no data to move")
    add(f"  {len(differing):>4}  table(s) present everywhere with different row counts")
    add(f"  {len(empty_everywhere):>4}  table(s) present everywhere and empty everywhere")
    add(f"  {len(identical):>4}  table(s) present everywhere with matching row counts")
    add("")

    # --- the table ----------------------------------------------------------
    header = "  " + "TABLE".ljust(38) + "".join(r.rjust(width + 2) for r in refs) + "   VERDICT"
    add(header)
    add("  " + "-" * (len(header) - 2))
    for c in comparisons:
        cells = "".join(
            _cell(c.states[r], c.counts[r], width).rjust(width + 2) for r in refs
        )
        add(f"  {c.table.ljust(38)}{cells}   {c.verdict}")
    add("")

    # --- schema differences -------------------------------------------------
    schema_diffs = [c for c in comparisons if c.column_only_in or c.type_differences]
    add(f"COLUMN DIFFERENCES ({len(schema_diffs)} table(s))")
    if not schema_diffs:
        add("  none — every table present in more than one project has the same columns")
    for c in schema_diffs:
        add(f"  {c.table}")
        for col, holders in sorted(c.column_only_in.items()):
            absent = [r for r in refs if c.counts[r] is not None and r not in holders]
            add(f"    column {col!r} only in {', '.join(holders)} (absent from {', '.join(absent)})")
        for col, types in sorted(c.type_differences.items()):
            rendered = ", ".join(f"{r}={t}" for r, t in sorted(types.items()))
            add(f"    column {col!r} types differ: {rendered}")
    add("")

    # --- migrations ---------------------------------------------------------
    lead = migration_leader(inventories)
    add("MIGRATIONS")
    for ref, count in lead["counts"].items():
        add(f"  {ref}  {count if count is not None else 'unknown (no history table read)'}")
    if lead["leader"] and lead["spread"]:
        add(f"  ahead: {lead['leader']} by {lead['spread']} applied version(s)")
    elif lead["leader"]:
        add("  every project that could be read has applied the same number")
    if lead["unknown"]:
        add(f"  unreadable: {', '.join(lead['unknown'])}")
    add("")

    # --- storage & functions ------------------------------------------------
    add("STORAGE BUCKETS")
    all_buckets = sorted(
        {b["name"] for inv in inventories for b in (inv.get("storage") or {}).get("buckets", [])}
    )
    if not all_buckets:
        add("  none reported")
    for bucket in all_buckets:
        cells = []
        for inv in inventories:
            found = next(
                (
                    b
                    for b in (inv.get("storage") or {}).get("buckets", [])
                    if b["name"] == bucket
                ),
                None,
            )
            cells.append("MISSING" if found is None else str(found.get("objects")))
        add(f"  {bucket.ljust(30)}" + "".join(c.rjust(width + 2) for c in cells))
    add("")

    add("EDGE FUNCTIONS")
    all_functions = sorted(
        {f["slug"] for inv in inventories for f in (inv.get("functions") or [])}
    )
    if not all_functions:
        add("  none reported")
    for slug in all_functions:
        holders = [
            inv["project_ref"]
            for inv in inventories
            if any(f["slug"] == slug for f in (inv.get("functions") or []))
        ]
        marker = "" if len(holders) == len(refs) else f"   <- only on {', '.join(holders)}"
        add(f"  {slug}{marker}")
    add("")

    return "\n".join(lines)


def to_json(
    inventories: Sequence[dict[str, Any]],
    comparisons: Sequence[TableComparison],
) -> dict[str, Any]:
    return {
        "projects": [
            {
                "ref": inv["project_ref"],
                "name": inv.get("name"),
                "tables": len(inv.get("tables", {})),
                "rows": total_rows(inv),
                "migrations": (inv.get("migrations") or {}).get("count"),
                "auth_users": (inv.get("auth") or {}).get("users"),
                "functions": [f["slug"] for f in (inv.get("functions") or [])],
            }
            for inv in inventories
        ],
        "migrations": migration_leader(inventories),
        "tables": [
            {
                "table": c.table,
                "states": c.states,
                "counts": c.counts,
                "verdict": c.verdict,
                "column_only_in": c.column_only_in,
                "type_differences": c.type_differences,
            }
            for c in comparisons
        ],
    }


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="+", help="inventory JSON files from scripts/supabase-inventory.sh")
    p.add_argument("--backup", action="append", default=[],
                   help="a full-table backup JSON to treat as an inventory (tables it omits read as unknown, not zero)")
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON instead of text")
    args = p.parse_args(argv)

    inventories: list[dict[str, Any]] = []
    for path in args.backup:
        inventories.append(inventory_from_backup(path))
    for path in args.files:
        try:
            inventories.append(load_inventory(path))
        except ValueError:
            # A backup passed positionally still works, rather than erroring out
            # on a file the user obviously meant to compare.
            inventories.append(inventory_from_backup(path))

    uninitialised = [inv for inv in inventories if is_uninitialised(inv)]
    comparable = [inv for inv in inventories if not is_uninitialised(inv)]

    if len(comparable) < 2:
        if uninitialised and comparable:
            print(render(comparable, [], uninitialised))
            print("Only one project has a schema; there is nothing to compare it against.")
            return 0
        p.error("need at least two inventories with a public schema to compare")

    comparisons = compare_inventories(comparable)

    if args.json:
        payload = to_json(comparable, comparisons)
        payload["uninitialised"] = [
            {"ref": inv["project_ref"], "name": inv.get("name")} for inv in uninitialised
        ]
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(render(comparable, comparisons, uninitialised))

    # Non-zero when a table holds data in one project and does not exist in
    # another: that is the case a human must resolve before any merge runs.
    return 1 if any(
        c.verdict == "MISSING WHERE DATA EXISTS ELSEWHERE" for c in comparisons
    ) else 0


if __name__ == "__main__":
    sys.exit(main())
