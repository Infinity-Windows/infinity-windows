#!/usr/bin/env python3
"""Turn a backup snapshot into a restore plan, or into SQL a person can apply.

    scripts/restore_backup.py --plan <snapshot.json[.gz]>
    scripts/restore_backup.py --sql  <snapshot.json[.gz]> --out restore.sql

Offline. Reads a file scripts/backup_project.py wrote (or one of the July
dumps in docs/backups) and never contacts a database. Applying the SQL is a
human step with psql against a project whose schema already matches — see
docs/restore-from-backup.md for the whole path, including what a snapshot
deliberately does not contain (password hashes, PIN hashes, storage bytes).

--plan prints what a restore would do: tables in an order that satisfies the
foreign keys the snapshot recorded, row counts, the credential columns that
were redacted and so come back as a marker, and anything that needs a person.

--sql writes one transaction: per-table user triggers disabled, INSERTs in
that order, triggers re-enabled. Every value is quoted and cast to the column
type the snapshot recorded, so a row round-trips exactly. Tables in a foreign
key cycle are listed at the end and need their constraints deferred by hand.
"""
from __future__ import annotations

import gzip
import json
import sys

REDACTION_MARKER = "[REDACTED-CREDENTIAL]"


def load_snapshot(path: str) -> dict:
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as fh:  # type: ignore[operator]
        return json.loads(fh.read())


def captured_tables(snapshot: dict) -> list[dict]:
    """Inventory entries with rows in the snapshot, in inventory order."""
    return [t for t in snapshot.get("_meta", {}).get("tables", []) if t.get("captured")]


def restore_order(snapshot: dict) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Parents before children, from the recorded foreign keys.

    Returns (ordered, cyclic). A table that references itself is not a cycle
    for this purpose: with triggers disabled a self-reference inserts fine.
    """
    tables = [(t["schema"], t["table"]) for t in captured_tables(snapshot)]
    present = set(tables)
    deps: dict[tuple[str, str], set[tuple[str, str]]] = {t: set() for t in tables}
    for fk in snapshot.get("_schema", {}).get("foreign_keys", []):
        child = (fk["schema"], fk["table"])
        parent = (fk["references_schema"], fk["references_table"])
        if child in present and parent in present and child != parent:
            deps[child].add(parent)
    ordered: list[tuple[str, str]] = []
    remaining = dict(deps)
    while remaining:
        ready = sorted(t for t, ds in remaining.items() if not (ds & set(remaining)))
        if not ready:
            break
        ordered.extend(ready)
        for t in ready:
            del remaining[t]
    cyclic = sorted(remaining)
    return ordered, cyclic


def column_types(snapshot: dict) -> dict[tuple[str, str, str], dict]:
    return {
        (c["schema"], c["table"], c["column"]): c
        for c in snapshot.get("_schema", {}).get("columns", [])
    }


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _quote_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql_literal(value, col: dict | None) -> str:
    """A value from the snapshot as a SQL literal cast to its recorded type.

    The Management API hands back timestamps, numerics, uuids and arrays as
    strings and json as parsed values; quoting everything as text and casting
    to the recorded udt is what makes each of those come back as itself.
    """
    if value is None:
        return "NULL"
    udt = (col or {}).get("udt_name") or ""
    data_type = (col or {}).get("data_type") or ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)) or data_type in ("json", "jsonb"):
        text = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
        return _quote_text(text) + "::" + (udt or "jsonb")
    if isinstance(value, (int, float)) and data_type in (
        "integer", "bigint", "smallint", "double precision", "real", "numeric"
    ):
        return repr(value)
    text = value if isinstance(value, str) else str(value)
    if not udt:
        return _quote_text(text)
    if udt.startswith("_"):
        return _quote_text(text) + "::" + _quote_ident(udt[1:]) + "[]"
    if udt in ("text", "varchar", "bpchar"):
        return _quote_text(text)
    return _quote_text(text) + "::" + _quote_ident(udt)


def insert_statements(snapshot: dict, schema: str, table: str, batch: int = 200) -> list[str]:
    key = table if schema == "public" else f"{schema}.{table}"
    rows = snapshot.get(key) or []
    if not rows:
        return []
    types = column_types(snapshot)
    columns = sorted({c for r in rows for c in r.keys()})
    ident = f"{_quote_ident(schema)}.{_quote_ident(table)}"
    col_list = ", ".join(_quote_ident(c) for c in columns)
    out: list[str] = []
    for start in range(0, len(rows), batch):
        values = []
        for r in rows[start : start + batch]:
            values.append(
                "(" + ", ".join(sql_literal(r.get(c), types.get((schema, table, c))) for c in columns) + ")"
            )
        out.append(f"insert into {ident} ({col_list}) values\n  " + ",\n  ".join(values) + ";")
    return out


def redacted_columns(snapshot: dict) -> list[str]:
    return list(snapshot.get("_meta", {}).get("redactions", []))


def plan(snapshot: dict) -> str:
    meta = snapshot.get("_meta", {})
    ordered, cyclic = restore_order(snapshot)
    counts = {(t["schema"], t["table"]): t.get("row_count", 0) for t in captured_tables(snapshot)}
    lines = [
        f"Restore plan for project {meta.get('project_ref')} "
        f"(snapshot exported {snapshot.get('exported_at')})",
        f"  {meta.get('total_rows')} rows across {len(ordered) + len(cyclic)} tables; "
        f"{len(snapshot.get('_migrations', []))} migrations were applied at export time.",
        "",
        "Order (parents first, from the recorded foreign keys):",
    ]
    for s, t in ordered:
        lines.append(f"  {s}.{t}  {counts[(s, t)]} rows")
    if cyclic:
        lines.append("")
        lines.append("In a foreign-key cycle — insert with constraints deferred, by hand:")
        for s, t in cyclic:
            lines.append(f"  {s}.{t}  {counts[(s, t)]} rows")
    red = redacted_columns(snapshot)
    lines.append("")
    if red:
        lines.append(f"Credential columns come back as {REDACTION_MARKER} and must be re-issued:")
        lines.extend(f"  {r}" for r in red)
    else:
        lines.append("No credential columns were redacted in this snapshot.")
    auth = snapshot.get("_auth", {})
    storage = snapshot.get("_storage", {})
    lines.append("")
    lines.append("Needs a person, because the snapshot does not hold it:")
    lines.append(
        f"  {auth.get('user_count', 0)} auth users are listed by email but without password "
        "hashes — they sign in again or reset their password."
    )
    objs = storage.get("object_count", 0)
    have_bytes = sum(1 for o in storage.get("objects", []) if o.get("sha256"))
    lines.append(
        f"  {objs} storage objects are inventoried; {have_bytes} have their bytes captured "
        "(scripts/backup_storage_objects.py). The rest come from the storage bucket itself."
    )
    lines.append("  Edge function secrets are listed by name only; set them again from GitHub.")
    return "\n".join(lines)


def render_restore_sql(snapshot: dict) -> str:
    meta = snapshot.get("_meta", {})
    ordered, cyclic = restore_order(snapshot)
    parts = [
        f"-- Restore of project {meta.get('project_ref')} from a snapshot exported {snapshot.get('exported_at')}.",
        "-- Generated by scripts/restore_backup.py. Apply with psql to a project whose",
        "-- schema already matches (run the migrations first). One transaction: it all",
        "-- lands or none of it does.",
        "begin;",
    ]
    for s, t in ordered:
        parts.append(f"alter table {_quote_ident(s)}.{_quote_ident(t)} disable trigger user;")
    for s, t in ordered:
        stmts = insert_statements(snapshot, s, t)
        if stmts:
            parts.append(f"-- {s}.{t}: {len(snapshot.get(t if s == 'public' else f'{s}.{t}') or [])} rows")
            parts.extend(stmts)
    for s, t in ordered:
        parts.append(f"alter table {_quote_ident(s)}.{_quote_ident(t)} enable trigger user;")
    if cyclic:
        parts.append("-- The tables below sit in a foreign-key cycle and are NOT restored here.")
        parts.append("-- Insert them in a second transaction with `set constraints all deferred`,")
        parts.append("-- which only works if the constraints are deferrable.")
        for s, t in cyclic:
            parts.append(f"--   {s}.{t}")
    parts.append("commit;")
    return "\n".join(parts) + "\n"


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[1] == "--plan":
        print(plan(load_snapshot(argv[2])))
        return
    if len(argv) == 5 and argv[1] == "--sql" and argv[3] == "--out":
        sql = render_restore_sql(load_snapshot(argv[2]))
        with open(argv[4], "w") as fh:
            fh.write(sql)
        print(f"wrote {argv[4]} ({len(sql)} bytes). Read docs/restore-from-backup.md before applying it.")
        return
    raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
