#!/usr/bin/env python3
"""Plan a merge of one Supabase project into another, and print it. Never runs it.

Driven by `scripts/supabase-merge.sh`. Everything here is pure: it reads two
JSON files (inventories, or full-table backups when row-level data is
available), consults the schema recovered from `supabase/migrations/`, and emits
the statements a merge *would* execute, in foreign-key dependency order.

There is no code path in this file that opens a network connection.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

from supabase_merge_lib import (  # noqa: E402
    ADVISORY,
    COLLIDING_SERIAL_COLUMNS,
    DEFERRED_FK_EDGES,
    ENFORCED,
    PICK_ONE_WINNER,
    SURROGATE_ONLY,
    IdRemapper,
    Schema,
    dedup_key,
    dedup_key_enforcement,
    dependency_cycles,
    dependency_order,
    inventory_from_backup,
    parse_migrations,
)


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def load_side(path: str) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    """Return (inventory, rows-by-table). `rows` is empty for count-only inventories."""
    raw = json.loads(Path(path).read_text())
    if "project_ref" in raw:
        return raw, {}
    rows = {k: v for k, v in raw.items() if isinstance(v, list)}
    return inventory_from_backup(path), rows


# --------------------------------------------------------------------------
# SQL rendering
# --------------------------------------------------------------------------


def sql_literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (dict, list)):
        return "'" + json.dumps(value).replace("'", "''") + "'::jsonb"
    return "'" + str(value).replace("'", "''") + "'"


def insert_statement(
    table: str,
    row: Mapping[str, Any],
    conflict: Sequence[str] | None,
    generated: Sequence[str] = (),
) -> str:
    cols = sorted(c for c in row if c not in set(generated))
    values = ", ".join(sql_literal(row[c]) for c in cols)
    stmt = f"insert into public.{table} ({', '.join(cols)})\n  values ({values})"
    if conflict:
        stmt += f"\n  on conflict ({', '.join(conflict)}) do nothing"
    else:
        # Without a natural key there is no conflict target to name; the primary
        # key is the only guard, and it only catches a literal id re-use.
        stmt += "\n  on conflict (id) do nothing"
    return stmt + ";"


# --------------------------------------------------------------------------
# The plan
# --------------------------------------------------------------------------


class Plan:
    def __init__(
        self,
        schema: Schema,
        source: Mapping[str, Any],
        target: Mapping[str, Any],
        source_rows: Mapping[str, list[dict[str, Any]]],
        target_rows: Mapping[str, list[dict[str, Any]]],
        limit: int,
    ) -> None:
        self.schema = schema
        self.source = source
        self.target = target
        self.source_rows = source_rows
        self.target_rows = target_rows
        self.limit = limit
        self.remapper = IdRemapper(schema)
        self.notes: list[str] = []
        self.blockers: list[str] = []

    # -- helpers ---------------------------------------------------------

    def source_count(self, table: str) -> int | None:
        entry = self.source.get("tables", {}).get(table)
        return None if entry is None else entry.get("rows")

    def target_count(self, table: str) -> int | None:
        entry = self.target.get("tables", {}).get(table)
        return None if entry is None else entry.get("rows")

    def tables_to_move(self) -> list[str]:
        """Tables with rows on the source side, in dependency order."""
        candidates = [
            t
            for t in self.schema.names()
            if (self.source_count(t) or 0) > 0 and t not in PICK_ONE_WINNER
        ]
        return dependency_order(self.schema, candidates)

    # -- phases ----------------------------------------------------------

    def preflight(self) -> list[str]:
        """SELECTs a human runs on both projects before anything is written."""
        checks = [
            "-- 1. Both projects must be at the same migration version, or the\n"
            "--    target is missing columns the source rows carry.\n"
            "select count(*) as applied, max(version) as latest\n"
            "  from supabase_migrations.schema_migrations;",
            "-- 2. Advisory dedup keys are not enforced by a UNIQUE index, so a\n"
            "--    project may already hold duplicates of them. Merging on a key\n"
            "--    that is already ambiguous makes it worse. Expect zero rows.",
        ]
        for table in sorted(self.schema.names()):
            key = dedup_key(table)
            if key and dedup_key_enforcement(self.schema, table) == ADVISORY:
                cols = ", ".join(key)
                checks.append(
                    f"select {cols}, count(*) from public.{table}\n"
                    f"  group by {cols} having count(*) > 1;"
                )
        checks.append(
            "-- 3. Serial collisions. Both projects backfilled SLOT-/WIN- series\n"
            "--    from 1, so the same string means different physical things.\n"
            "select 'locations' as t, serial from public.locations\n"
            "union all\n"
            "select 'windows', serial from public.windows\n"
            "  order by 1, 2;"
        )
        checks.append(
            "-- 4. Auth users. profiles.id IS auth.users.id, and auth.users rows\n"
            "--    cannot be inserted by SQL. Any source profile whose id is not\n"
            "--    already an auth user in the target is a blocker.\n"
            "select id, email, created_at, last_sign_in_at from auth.users order by created_at;"
        )
        return checks

    def statements(self) -> list[tuple[str, list[str]]]:
        """(table, statements) in dependency order."""
        out: list[tuple[str, list[str]]] = []
        deferred_cols = {t: {c for tt, c in DEFERRED_FK_EDGES if tt == t} for t, _ in DEFERRED_FK_EDGES}

        for table in self.tables_to_move():
            key = dedup_key(table)
            enforcement = dedup_key_enforcement(self.schema, table)
            rows = self.source_rows.get(table, [])
            statements: list[str] = []

            if self.target_count(table) is None:
                self.blockers.append(
                    f"{table}: {self.source_count(table)} source row(s) but the table "
                    f"does not exist in the target. Apply migrations first."
                )
                continue

            if not rows:
                statements.append(
                    f"-- {self.source_count(table)} row(s) to move. No row-level export was\n"
                    f"-- supplied for this table, so the statements cannot be written out.\n"
                    f"-- Re-run with a full backup JSON for the source to see them."
                )
                out.append((table, statements))
                continue

            self.remapper.learn(table, rows, self.target_rows.get(table, []))

            shown = rows[: self.limit] if self.limit else rows
            for row in shown:
                remapped = self.remapper.remap_row(table, row)
                for col in deferred_cols.get(table, ()):  # filled in by phase 3
                    if col in remapped:
                        remapped[col] = None
                conflict = key if enforcement == ENFORCED else None
                statements.append(
                    insert_statement(
                        table, remapped, conflict, sorted(self.schema[table].generated)
                    )
                )
            if self.limit and len(rows) > self.limit:
                statements.append(
                    f"-- ... {len(rows) - self.limit} more row(s) elided by --limit"
                )

            dropped = sorted(self.schema[table].generated & set(rows[0]))
            if dropped:
                self.notes.append(
                    f"{table}: {', '.join(dropped)} is generated always as stored. "
                    f"Postgres rejects an INSERT that names it, so it is dropped from "
                    f"every statement and recomputed."
                )
            if enforcement == SURROGATE_ONLY:
                self.notes.append(
                    f"{table}: no natural key. Every source row is appended. If the two "
                    f"projects logged the same real event, the merge cannot tell and you "
                    f"get two rows."
                )
            elif enforcement == ADVISORY:
                self.notes.append(
                    f"{table}: dedup key {key} is a convention, not a UNIQUE index. "
                    f"`on conflict` cannot be used; preflight check 2 must come back empty."
                )
            out.append((table, statements))
        return out

    def deferred_updates(self) -> list[str]:
        """Phase 3: fill in the FK edges that had to be inserted as NULL."""
        stmts: list[str] = []
        for table, column in DEFERRED_FK_EDGES:
            rows = self.source_rows.get(table, [])
            pending = [r for r in rows if r.get(column)]
            if not pending:
                stmts.append(
                    f"-- {table}.{column}: nothing to backfill "
                    f"(no source row sets it)."
                )
                continue
            for row in pending[: self.limit or len(pending)]:
                new_id = self.remapper.resolve(table, row["id"])
                fk = next(
                    f for f in self.schema[table].foreign_keys if column in f.columns
                )
                target_value = self.remapper.resolve(fk.ref_table, row[column])
                stmts.append(
                    f"update public.{table} set {column} = {sql_literal(target_value)}\n"
                    f"  where id = {sql_literal(new_id)};"
                )
        return stmts

    def winners(self) -> list[str]:
        lines: list[str] = []
        for table, why in PICK_ONE_WINNER.items():
            bare = table.split(".")[-1]
            src = self.source_count(bare)
            tgt = self.target_count(bare)
            lines.append(f"{table}: source={src if src is not None else '-'} target={tgt if tgt is not None else '-'}")
            lines.append(f"    {why}")
        lines.append(
            "window_id_counters recompute, to run after windows are merged:\n"
            "  select wt.id as window_type_id,\n"
            "         max(coalesce(substring(w.window_id from '[0-9]+$')::int, 0)) as last_seq\n"
            "    from public.window_types wt\n"
            "    left join public.windows w on w.window_type_id = wt.id\n"
            "   group by wt.id;\n"
            "  -- compare against window_id_counters.last_seq; the counter must be >= this."
        )
        return lines

    def verification(self) -> list[str]:
        src_total = sum(
            (t.get("rows") or 0) for t in self.source.get("tables", {}).values()
        )
        tgt_total = sum(
            (t.get("rows") or 0) for t in self.target.get("tables", {}).values()
        )
        lines = [
            f"-- Expected upper bound after the merge: {src_total} + {tgt_total} = "
            f"{src_total + tgt_total} rows, minus one row for every source row that "
            f"deduped onto an existing target row.",
            "",
            "-- Nothing lost: every table's count must be >= the pre-merge target count.",
            "select relname, n_live_tup from pg_stat_user_tables where schemaname='public' order by relname;",
            "",
            "-- Exact counts, because n_live_tup is an estimate:",
            "select t.table_name,\n"
            "       (xpath('/row/c/text()', query_to_xml(\n"
            "         format('select count(*) as c from %I.%I', t.table_schema, t.table_name),\n"
            "         false, true, '')))[1]::text::bigint as rows\n"
            "  from information_schema.tables t\n"
            " where t.table_schema='public' and t.table_type='BASE TABLE'\n"
            " order by 1;",
            "",
            "-- No duplicates created on any natural key. Every one of these must\n"
            "-- return zero rows.",
        ]
        for table in sorted(self.schema.names()):
            key = dedup_key(table)
            if not key:
                continue
            cols = ", ".join(key)
            lines.append(
                f"select '{table}' as t, {cols}, count(*) from public.{table}\n"
                f"  group by {cols} having count(*) > 1;"
            )
        lines += [
            "",
            "-- No orphaned foreign keys. Every one of these must return zero rows.",
        ]
        for table in sorted(self.schema.names()):
            for fk in self.schema[table].foreign_keys:
                if fk.is_auth or len(fk.columns) != 1:
                    continue
                col, ref_col = fk.columns[0], fk.ref_columns[0]
                lines.append(
                    f"select '{table}.{col}' as fk, count(*) from public.{table} c\n"
                    f"  left join public.{fk.ref_table} p on p.{ref_col} = c.{col}\n"
                    f" where c.{col} is not null and p.{ref_col} is null;"
                )
        return lines


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------


def render(plan: Plan, source_path: str, target_path: str) -> str:
    lines: list[str] = []
    add = lines.append
    rule = "-" * 78

    add("=" * 78)
    add("SUPABASE MERGE — DRY RUN. Nothing below was executed.")
    add("=" * 78)
    add(f"  generated   {dt.datetime.now(dt.timezone.utc).isoformat()}")
    add(f"  source      {plan.source['project_ref']}  ({source_path})")
    add(f"  target      {plan.target['project_ref']}  ({target_path})")
    add(f"  schema      {len(plan.schema.tables)} tables recovered from supabase/migrations/")
    add("")
    add("  Read docs/supabase-merge-plan.md before acting on any of this.")
    add("")

    cycles = dependency_cycles(plan.schema)
    if cycles:
        add(rule)
        add("PHASE 0 — foreign-key cycles in the schema")
        add(rule)
        for group in cycles:
            add(f"  cycle: {' -> '.join(group)}")
        add("  Broken by inserting these columns as NULL and filling them in phase 3:")
        for table, column in DEFERRED_FK_EDGES:
            add(f"    {table}.{column}")
        add("")

    add(rule)
    add("PHASE 1 — preflight, run these on BOTH projects and read the answers")
    add(rule)
    for check in plan.preflight():
        add(check)
        add("")

    statements = plan.statements()
    add(rule)
    add(f"PHASE 2 — insert rows, {len(statements)} table(s) in dependency order")
    add(rule)
    for i, (table, stmts) in enumerate(statements, 1):
        key = dedup_key(table)
        enforcement = dedup_key_enforcement(plan.schema, table)
        src, tgt = plan.source_count(table), plan.target_count(table)
        remapped = plan.remapper.rows_needing_new_ids(table)
        add(f"[{i:>2}/{len(statements)}] {table}")
        add(f"        source {src} row(s) -> target holds {tgt}")
        add(f"        dedup on {key if key else 'nothing — surrogate uuid only'} ({enforcement})")
        if remapped:
            add(f"        {remapped} source id(s) remap onto an existing target row")
        for stmt in stmts:
            add("        " + stmt.replace("\n", "\n        "))
        add("")

    add(rule)
    add("PHASE 3 — deferred foreign keys")
    add(rule)
    for stmt in plan.deferred_updates():
        add("  " + stmt.replace("\n", "\n  "))
    add("")

    add(rule)
    add("PHASE 4 — pick one winner (never merged)")
    add(rule)
    for line in plan.winners():
        add("  " + line.replace("\n", "\n  "))
    add("")

    add(rule)
    add("PHASE 5 — verification")
    add(rule)
    for line in plan.verification():
        add("  " + line.replace("\n", "\n  "))
    add("")

    if plan.remapper.collisions:
        add(rule)
        add("UUID COLLISIONS — same id, different real-world thing")
        add(rule)
        for c in plan.remapper.collisions:
            add(f"  {c['table']}: {c['source_id']} -> {c['new_id']} (fresh id issued)")
        add("")

    if COLLIDING_SERIAL_COLUMNS:
        add(rule)
        add("SERIAL COLLISION HAZARD")
        add(rule)
        for table, (column, example) in COLLIDING_SERIAL_COLUMNS.items():
            add(
                f"  {table}.{column} was backfilled as a generated series starting at "
                f"{example} and carries a UNIQUE index.\n"
                f"  Both projects will hold the same strings meaning different physical "
                f"things. Every merged\n  row must be re-serialised, above the target's "
                f"current maximum. This dry run does NOT do that."
            )
        add("")

    if plan.notes:
        add(rule)
        add("NOTES")
        add(rule)
        for note in sorted(set(plan.notes)):
            add(f"  - {note}")
        add("")

    add(rule)
    add("BLOCKERS" if plan.blockers else "BLOCKERS — none found")
    add(rule)
    for blocker in plan.blockers:
        add(f"  ! {blocker}")
    add("")
    add("=" * 78)
    add("END OF DRY RUN. Nothing was executed. --execute is not implemented.")
    add("=" * 78)
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--limit", type=int, default=5,
                   help="statements printed per table (0 for all)")
    p.add_argument("--out", help="also write the plan to this file")
    args = p.parse_args(argv)

    schema = parse_migrations()
    source, source_rows = load_side(args.source)
    target, target_rows = load_side(args.target)

    if source["project_ref"] == target["project_ref"]:
        print(
            f"source and target are the same project ({source['project_ref']}). "
            "Refusing to plan a merge of a project into itself.",
            file=sys.stderr,
        )
        return 2

    plan = Plan(schema, source, target, source_rows, target_rows, args.limit)
    text = render(plan, args.source, args.target)
    print(text)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text + "\n")
        print(f"\n-> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
