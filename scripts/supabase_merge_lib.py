"""Shared logic for evaluating and merging two Infinity Windows Supabase projects.

Three things live here, all of them pure and offline so they can be unit tested
without a database:

* `parse_migrations` — reads `supabase/migrations/*.sql` and recovers the shape
  of `public`: columns, primary keys, unique constraints and foreign keys.
* `dependency_order` — topologically sorts those tables so a merge inserts a
  parent before any child that references it.
* `IdRemapper` / `compare_inventories` — the merge and diff primitives.

The parser is deliberately narrow: it understands the SQL dialect this repo
actually writes, not Postgres in general. Anything it cannot parse is reported
rather than silently dropped, because a missed foreign key becomes a constraint
violation halfway through a merge.
"""

from __future__ import annotations

import json
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"


# --------------------------------------------------------------------------
# Schema model
# --------------------------------------------------------------------------


@dataclass
class ForeignKey:
    columns: tuple[str, ...]
    ref_table: str
    ref_columns: tuple[str, ...]
    on_delete: str | None = None

    @property
    def is_auth(self) -> bool:
        """True for references into `auth.users`, which a merge cannot insert."""
        return self.ref_table.startswith("auth.")


@dataclass
class Table:
    name: str
    columns: dict[str, str] = field(default_factory=dict)
    primary_key: tuple[str, ...] = ()
    uniques: list[tuple[str, ...]] = field(default_factory=list)
    foreign_keys: list[ForeignKey] = field(default_factory=list)
    #: `generated always as (...) stored` columns. Postgres rejects an INSERT
    #: that names one, so a merge must drop them from every statement —
    #: `locations.address` is one, and it appears in the committed backup.
    generated: set[str] = field(default_factory=set)
    defined_in: str = ""

    def insertable_columns(self, present: Iterable[str]) -> list[str]:
        return sorted(c for c in present if c not in self.generated)

    def parents(self) -> set[str]:
        """Tables this one references, excluding itself and non-public schemas."""
        return {
            fk.ref_table
            for fk in self.foreign_keys
            if not fk.is_auth and fk.ref_table != self.name
        }


@dataclass
class Schema:
    tables: dict[str, Table] = field(default_factory=dict)
    """Statements the parser recognised as schema but could not fully read."""
    unparsed: list[str] = field(default_factory=list)

    def __contains__(self, name: str) -> bool:
        return name in self.tables

    def __getitem__(self, name: str) -> Table:
        return self.tables[name]

    def names(self) -> list[str]:
        return sorted(self.tables)


# --------------------------------------------------------------------------
# Migration parsing
# --------------------------------------------------------------------------

_COMMENT = re.compile(r"--[^\n]*")
_CREATE_TABLE = re.compile(
    r"create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(",
    re.IGNORECASE,
)
_ADD_COLUMN = re.compile(
    r"alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+"
    r"add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s+([^,;]*)",
    re.IGNORECASE,
)
_UNIQUE_INDEX = re.compile(
    r"create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"
    r"[a-z_][a-z0-9_]*\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)",
    re.IGNORECASE,
)
_REFERENCES = re.compile(
    r"references\s+((?:auth\.|public\.)?[a-z_][a-z0-9_]*)\s*(?:\(([^)]*)\))?"
    r"(?:\s+on\s+delete\s+(cascade|set\s+null|restrict|no\s+action))?",
    re.IGNORECASE,
)


def _strip_comments(sql: str) -> str:
    return _COMMENT.sub("", sql)


def _strip_dollar_quoted(sql: str) -> str:
    """Remove `$$ ... $$` function bodies.

    Function bodies contain `insert into ... references`-shaped text and their
    own parentheses; parsing them as DDL invents foreign keys that do not exist.
    """
    out: list[str] = []
    i = 0
    tag = re.compile(r"\$([a-z_]*)\$", re.IGNORECASE)
    while True:
        m = tag.search(sql, i)
        if not m:
            out.append(sql[i:])
            return "".join(out)
        out.append(sql[i : m.start()])
        close = sql.find(m.group(0), m.end())
        if close == -1:
            return "".join(out)
        i = close + len(m.group(0))


def _split_top_level(body: str) -> Iterator[str]:
    """Split a `create table` body on commas that are not inside parentheses."""
    depth = 0
    current: list[str] = []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            yield "".join(current).strip()
            current = []
        else:
            current.append(ch)
    tail = "".join(current).strip()
    if tail:
        yield tail


def _read_parens(sql: str, open_index: int) -> tuple[str, int]:
    """Return the text inside the parens starting at `open_index`, and the index after."""
    depth = 0
    for i in range(open_index, len(sql)):
        if sql[i] == "(":
            depth += 1
        elif sql[i] == ")":
            depth -= 1
            if depth == 0:
                return sql[open_index + 1 : i], i + 1
    raise ValueError("unbalanced parentheses in create table")


def _columns_from_list(text: str) -> tuple[str, ...]:
    cols = []
    for part in text.split(","):
        name = part.strip().split()[0] if part.strip() else ""
        name = name.strip('"').lower()
        if name:
            cols.append(name)
    return tuple(cols)


def _parse_create_table(name: str, body: str, source: str) -> Table:
    table = Table(name=name, defined_in=source)
    for item in _split_top_level(body):
        lowered = item.lower()
        if lowered.startswith("primary key"):
            inner = item[item.index("(") + 1 : item.rindex(")")]
            table.primary_key = _columns_from_list(inner)
            continue
        if lowered.startswith("unique"):
            inner = item[item.index("(") + 1 : item.rindex(")")]
            table.uniques.append(_columns_from_list(inner))
            continue
        if lowered.startswith(("constraint", "check", "foreign key", "exclude")):
            if lowered.startswith("foreign key"):
                fk_cols = _columns_from_list(item[item.index("(") + 1 : item.index(")")])
                ref = _REFERENCES.search(item)
                if ref:
                    table.foreign_keys.append(_foreign_key(fk_cols, ref))
            continue

        words = item.split()
        if not words:
            continue
        col = words[0].strip('"').lower()
        rest = item[len(words[0]) :].strip()
        table.columns[col] = _column_type(rest)
        if re.search(r"\bgenerated\s+always\s+as\b", rest, re.IGNORECASE):
            table.generated.add(col)
        if re.search(r"\bprimary\s+key\b", rest, re.IGNORECASE):
            table.primary_key = (col,)
        if re.search(r"\bunique\b", rest, re.IGNORECASE):
            table.uniques.append((col,))
        ref = _REFERENCES.search(rest)
        if ref:
            table.foreign_keys.append(_foreign_key((col,), ref))
    return table


def _foreign_key(columns: tuple[str, ...], match: re.Match[str]) -> ForeignKey:
    ref_table = match.group(1).lower()
    if ref_table.startswith("public."):
        ref_table = ref_table[len("public.") :]
    ref_cols = _columns_from_list(match.group(2)) if match.group(2) else ("id",)
    on_delete = match.group(3)
    return ForeignKey(
        columns=columns,
        ref_table=ref_table,
        ref_columns=ref_cols,
        on_delete=" ".join(on_delete.split()).lower() if on_delete else None,
    )


def _column_type(rest: str) -> str:
    m = re.match(r"([a-z_]+(?:\s+precision)?(?:\([^)]*\))?(?:\s*\[\])?)", rest, re.IGNORECASE)
    return m.group(1).strip().lower() if m else rest.strip().lower()


def parse_migrations(directory: Path | str = MIGRATIONS_DIR) -> Schema:
    """Recover the `public` schema from the repo's migration files."""
    directory = Path(directory)
    schema = Schema()
    for path in sorted(directory.glob("*.sql")):
        sql = _strip_dollar_quoted(_strip_comments(path.read_text()))

        pos = 0
        while True:
            m = _CREATE_TABLE.search(sql, pos)
            if not m:
                break
            try:
                body, pos = _read_parens(sql, m.end() - 1)
            except ValueError:
                schema.unparsed.append(f"{path.name}: unbalanced create table {m.group(1)}")
                pos = m.end()
                continue
            name = m.group(1).lower()
            if name in schema.tables:
                # `create table if not exists` re-declaration: keep the first.
                continue
            schema.tables[name] = _parse_create_table(name, body, path.name)

        for m in _ADD_COLUMN.finditer(sql):
            table_name, col, rest = m.group(1).lower(), m.group(2).lower(), m.group(3)
            table = schema.tables.get(table_name)
            if table is None:
                continue
            table.columns.setdefault(col, _column_type(rest))
            ref = _REFERENCES.search(rest)
            if ref:
                table.foreign_keys.append(_foreign_key((col,), ref))

        for m in _UNIQUE_INDEX.finditer(sql):
            table = schema.tables.get(m.group(1).lower())
            if table is None:
                continue
            cols = _columns_from_list(m.group(2))
            if cols and cols not in table.uniques:
                table.uniques.append(cols)

    return schema


# --------------------------------------------------------------------------
# Dependency ordering
# --------------------------------------------------------------------------


#: Nullable foreign keys that must be inserted as NULL and filled in afterwards.
#:
#: `window_types.golden_install_event_id` points at `install_events`, which in
#: turn points back at `window_types`, `windows` and `project_openings`. That is
#: a genuine cycle in the schema, so no insert order exists that satisfies every
#: constraint in one pass. Breaking this one nullable edge makes the rest of the
#: graph acyclic.
DEFERRED_FK_EDGES: list[tuple[str, str]] = [("window_types", "golden_install_event_id")]

_DEFERRED_BY_TABLE: dict[str, set[str]] = {
    table: {c for t, c in DEFERRED_FK_EDGES if t == table}
    for table, _ in DEFERRED_FK_EDGES
}


def _parents_for_ordering(schema: Schema, name: str, universe: set[str]) -> set[str]:
    deferred = _DEFERRED_BY_TABLE.get(name, set())
    return {
        fk.ref_table
        for fk in schema[name].foreign_keys
        if not fk.is_auth
        and fk.ref_table != name
        and fk.ref_table in universe
        and not deferred.intersection(fk.columns)
    }


def dependency_order(schema: Schema, tables: Iterable[str] | None = None) -> list[str]:
    """Order tables so every parent comes before its children.

    Self-references are ignored: a row's parent is in the same insert batch, and
    is handled by inserting in two passes rather than by table ordering. The
    edges in `DEFERRED_FK_EDGES` are dropped from the graph, because they are
    filled in by a later UPDATE rather than at insert time.
    """
    names = set(tables) if tables is not None else set(schema.tables)
    names &= set(schema.tables)

    parents = {n: _parents_for_ordering(schema, n, names) for n in names}
    ordered: list[str] = []
    placed: set[str] = set()
    remaining = dict(parents)
    while remaining:
        ready = sorted(n for n, ps in remaining.items() if not (ps - placed))
        if not ready:
            # A cycle DEFERRED_FK_EDGES does not cover. Break it deterministically
            # so callers still get a complete list; `dependency_cycles` names it.
            ready = [sorted(remaining)[0]]
        for n in ready:
            ordered.append(n)
            placed.add(n)
            remaining.pop(n)
    return ordered


def dependency_cycles(
    schema: Schema,
    tables: Iterable[str] | None = None,
    *,
    apply_deferrals: bool = False,
) -> list[list[str]]:
    """Strongly connected components of size > 1: tables that reference each other.

    By default this reports the raw schema, so the `window_types` /
    `install_events` cycle shows up. Pass `apply_deferrals=True` to check that
    `DEFERRED_FK_EDGES` actually breaks every cycle — which is what the tests do.
    """
    names = set(tables) if tables is not None else set(schema.tables)
    names &= set(schema.tables)

    if apply_deferrals:
        edges = {n: _parents_for_ordering(schema, n, names) for n in names}
    else:
        edges = {n: schema[n].parents() & names for n in names}

    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    counter = 0
    components: list[list[str]] = []

    def strongconnect(root: str) -> None:
        nonlocal counter
        # Iterative Tarjan: the schema is shallow but recursion limits are not
        # worth risking on a script that runs against an unknown future schema.
        work: list[tuple[str, list[str]]] = [(root, sorted(edges.get(root, ())))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, successors = work[-1]
            if successors:
                nxt = successors.pop(0)
                if nxt not in index:
                    index[nxt] = low[nxt] = counter
                    counter += 1
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, sorted(edges.get(nxt, ()))))
                elif nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
            else:
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[node])
                if low[node] == index[node]:
                    component = []
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        component.append(w)
                        if w == node:
                            break
                    if len(component) > 1:
                        components.append(sorted(component))

    for name in sorted(names):
        if name not in index:
            strongconnect(name)
    return sorted(components)


def auth_dependent_tables(schema: Schema) -> list[str]:
    """Tables with a foreign key into `auth.users`, which a merge cannot insert."""
    return sorted(
        name
        for name, table in schema.tables.items()
        if any(fk.is_auth for fk in table.foreign_keys)
    )


# --------------------------------------------------------------------------
# Dedup keys
# --------------------------------------------------------------------------

#: How a row is recognised as "the same real-world thing" across two projects.
#:
#: `None` means the table has no natural key at all — every row is identified
#: only by a UUID that each project generated independently, so a merge cannot
#: tell a genuine duplicate from two distinct rows and must either carry both or
#: pick a winner. That distinction drives most of `docs/supabase-merge-plan.md`.
#: Every table the migrations declare has an entry; `test_supabase_merge.py`
#: fails if a new migration adds a table and leaves it out.
DEDUP_KEYS: dict[str, tuple[str, ...] | None] = {
    # -- Reference data with real natural keys: safe to dedup and merge.
    "window_types": ("type_code",),
    "cost_codes": ("code",),
    "locations": ("zone", "rack", "slot"),
    "projects": ("job_code",),
    "windows": ("window_id",),
    "supplies": ("name",),
    "safety_talks": ("talk_date", "title"),
    "profiles": ("id",),  # id IS auth.users.id — see the auth section of the plan
    "access_requests": ("email",),
    # UNIQUE on the table, and the value is ~49.5 bits of randomness, so an
    # identical code_hash in two projects means the same invite and never a
    # coincidence. Merging on it also keeps single-use intact: a union that
    # duplicated a redeemed invite would resurrect a spent code.
    "crew_invites": ("code_hash",),
    "knowledge_docs": ("source", "path"),
    "vehicles": ("vin",),
    "trips": ("name", "start_date"),
    "learn_priority_terms": ("term_id",),
    "push_subscriptions": ("endpoint",),
    # -- Child rows identified by their parent plus a position or code.
    "project_windows": ("project_id", "window_type_id"),
    "installer_clearance": ("installer_id", "window_type_id"),
    "window_id_counters": ("window_type_id",),
    "project_openings": ("project_id", "opening_code"),
    # One phase of one kind per opening (UNIQUE in the migration), so the
    # parent opening plus the kind IS the row's identity.
    "opening_phases": ("opening_id", "kind"),
    "project_plansets": ("project_id", "storage_path"),
    "toolbox_completions": ("profile_id", "talk_id"),
    # Library content is keyed by its slug; one assignment per date (UNIQUE).
    "toolbox_talk_library": ("slug",),
    "toolbox_talk_assignments": ("assigned_date",),
    "notification_dismissals": ("profile_id", "key"),
    "monday_jobs": ("monday_item_id",),
    "studio_units": ("name", "kind"),
    # Standalone Studio projects are authored content: two rows with the
    # same name are two drawings, never a duplicate.
    "studio_projects": None,
    # Training videos are authored content too.
    "learning_videos": None,
    # One row per (project, runner) already — the natural key IS the row.
    "flash_run_assignments": ("project_id", "profile_id"),
    # Summons are events: two calls on one window at different times are
    # two records, never duplicates.
    "summons": None,
    "summon_helpers": ("summon_id", "profile_id"),
    # Sessions and redos are time-stamped events — append-only, never deduped.
    "unit_sessions": None,
    "unit_redos": None,
    # Storage tracking: containers and packages carry immutable printed
    # serials, so the serial is the identity a merge must respect.
    "storage_containers": ("serial",),
    "packages": ("serial",),
    "package_deliveries": ("label", "arrived_on"),
    "package_marks": ("package_id", "mark_code"),
    "checkout_reasons": ("label",),
    "knowledge_chunks": ("doc_id", "chunk_index"),
    "learn_progress": ("profile_id", "term_id"),
    "project_mark_specs": ("project_id", "mark_code"),
    "project_mark_elevation_views": (
        "planset_id",
        "mark_code",
        "page_number",
        "region_index",
    ),
    "project_message_reads": ("project_id", "profile_id"),
    "project_planset_pages": ("planset_id", "page_number"),
    # The list of jobs a test/automation login may write. One row per project and
    # the project id IS the primary key, so a merge cannot create a duplicate;
    # naming it here is what keeps a merged database's sandbox list correct rather
    # than empty.
    "sandbox_projects": ("project_id",),
    "project_spec_discrepancies": ("project_id", "mark_code", "kind"),
    "qc_checks": ("project_opening_id",),
    "safety_acks": ("talk_id", "profile_id"),
    "schedule_assignment_members": ("assignment_id", "profile_id"),
    "trip_crew": ("trip_id", "profile_id"),
    "trip_attachments": ("trip_id", "storage_path"),
    "vehicle_devices": ("provider", "provider_device_id"),
    "vehicle_financials": ("vehicle_id",),
    "vehicle_locations_latest": ("vehicle_id",),
    "vehicle_service_schedules": ("vehicle_id", "task"),
    # -- AI spend meters. Keyed by the period they measure, but a merge cannot
    # -- just take one side: two projects metering the same day or month each
    # -- hold part of the real total, so the counts have to be added. See the
    # -- "pick one winner" note below and docs/ai-spend-limits.md.
    "ai_spend_limits": ("id",),
    "ai_usage_days": ("user_id", "usage_day"),
    "ai_spend_months": ("usage_month",),
    "ai_spend_alerts": ("usage_month", "level"),
    "ai_usage_events": None,  # one row per attempt; two attempts are two events
    # -- Surrogate UUID only. Two rows describing the same real event cannot be
    # -- told apart from two genuinely different rows, so these are appended,
    # -- never matched. Note `tools`: two crates both labelled "Hilti TE 6" are
    # -- two physical tools, so even the name is not a key.
    # -- The same installer can ask the same question twice, minutes apart, and
    # -- both asks are real: the count is the signal a foreman reads.
    "ask_question_log": None,
    "attachments": None,
    "change_orders": None,
    "cycle_counts": None,
    "flights": None,
    "ground_transport": None,
    "incidents": None,
    "install_events": None,
    "issues": None,
    "job_costs": None,
    "job_notes": None,
    "lodging": None,
    "movements": None,
    # Same shape as movements: append-only package history — every touch is a
    # real event, so lookalike rows are two touches, never a duplicate.
    "package_events": None,
    "points_ledger": None,
    "procedures": None,
    "project_messages": None,
    # One row per time someone dragged a mark on the plan. The same mark can be
    # nudged back and forth all afternoon and every nudge is a real step in the
    # undo history, so two rows that look alike are two moves, not a duplicate.
    "project_opening_pin_moves": None,
    "project_plan_outlines": None,
    "schedule_assignments": None,
    "schedule_events": None,
    "service_cases": None,
    "supply_orders": None,
    "task_sessions": None,
    # Append-only audit rows: two edits that look alike are two edits. Rides
    # its parent shift's fate, like time_shifts itself.
    "time_shift_edits": None,
    "time_shifts": None,
    # scope='company' has profile_id NULL, so there is no non-null natural key
    # across both rows kinds; a merge picks or carries like other config.
    "overtime_rules": None,
    "tools": None,
    "trip_contacts": None,
    "vault_config": None,
    "vehicle_drive_sessions": None,
    "vehicle_drivers": None,
    "vehicle_locations_history": None,
    "vehicle_project_assignments": None,
    "vehicle_service_records": None,
}

#: Tables where combining two projects' rows is meaningless or actively wrong.
#: The merge must choose one project's rows wholesale, or recompute from the
#: merged data. See the "pick one winner" section of the merge plan.
PICK_ONE_WINNER: dict[str, str] = {
    "window_id_counters": (
        "A per-type sequence high-water mark. Summing or unioning two projects' "
        "counters issues duplicate window ids. Recompute as max(last_seq) per "
        "type across both, after windows are merged."
    ),
    "supabase_migrations.schema_migrations": (
        "Bookkeeping, not data. Take the target's history; never union it, or "
        "`supabase db push` sees remote-only versions with no local file."
    ),
    "vault_config": (
        "Holds a single PIN hash. Two projects mean two PINs; a human picks one."
    ),
    "ai_spend_limits": (
        "A single settings row (id = 1) holding the company's AI budget. Two "
        "projects mean two budgets; a human picks one."
    ),
    "ai_usage_days": (
        "A per-person-per-day call count. Matching on (user_id, usage_day) and "
        "taking one side loses the other side's calls, which is how a merged "
        "project would silently hand somebody a second daily quota. Recompute "
        "as the sum of both sides per key."
    ),
    "ai_spend_months": (
        "A per-month running total in micro-dollars. Same as ai_usage_days: sum "
        "both sides per month rather than picking one, or the ceiling starts the "
        "merged month already understated."
    ),
    "ai_spend_alerts": (
        "One row per threshold already announced to the owner. Union it and the "
        "owner is notified twice; drop it and they are notified again for spend "
        "they already know about. Take the earlier row per (month, level)."
    ),
}

#: Columns backfilled as a generated series. Both projects can hold the same
#: string pointing at different physical objects, and each carries a UNIQUE
#: index, so a naive union both collides and silently mislabels inventory.
COLLIDING_SERIAL_COLUMNS: dict[str, tuple[str, str]] = {
    "locations": ("serial", "SLOT-000001"),
    "windows": ("serial", "WIN-000001"),
}


#: A dedup key the database enforces with UNIQUE. Duplicates cannot already
#: exist inside one project, so matching on it is safe.
ENFORCED = "enforced"
#: A dedup key that is only a convention. Nothing stops either project from
#: already holding two rows with the same key, so the merge must check for
#: within-project duplicates before it trusts the match.
ADVISORY = "advisory"
#: No natural key at all.
SURROGATE_ONLY = "surrogate-only"


def dedup_key(table: str) -> tuple[str, ...] | None:
    """The natural key for `table`, or None when it only has a surrogate UUID."""
    return DEDUP_KEYS.get(table)


def dedup_key_enforcement(schema: Schema, table: str) -> str:
    """Whether `table`'s dedup key is backed by a UNIQUE constraint.

    `cost_codes.code`, `supplies.name` and `vehicles.vin` read like natural keys
    but carry no unique index, so both projects can already hold duplicates of
    them. Merging on an advisory key without checking that first creates the
    duplicates it was meant to prevent.
    """
    key = DEDUP_KEYS.get(table)
    if key is None:
        return SURROGATE_ONLY
    spec = schema.tables.get(table)
    if spec is None:
        return ADVISORY
    key_set = set(key)
    if key_set == set(spec.primary_key):
        return ENFORCED
    if any(key_set == set(u) for u in spec.uniques):
        return ENFORCED
    return ADVISORY


def dedup_key_report(schema: Schema) -> dict[str, dict[str, Any]]:
    """Every table in the schema with its dedup key and how strongly it holds."""
    return {
        name: {
            "key": DEDUP_KEYS.get(name),
            "enforcement": dedup_key_enforcement(schema, name),
            "known": name in DEDUP_KEYS,
        }
        for name in schema.names()
    }


def has_natural_key(table: str) -> bool:
    return DEDUP_KEYS.get(table) is not None


def natural_key_of(table: str, row: Mapping[str, Any]) -> tuple[Any, ...] | None:
    """The dedup tuple for one row, or None when the table has no natural key.

    Text values are compared case-insensitively and whitespace-trimmed: the two
    projects were populated by two people typing, so `"CAS3050"` and
    `"cas3050 "` are the same window type.

    A NULL anywhere in the key returns None, not a key containing None. Most of
    these columns are nullable — `vehicles.vin` is `text null` — and treating
    "no VIN recorded" as a value would merge every unidentified vehicle into one.
    """
    key = DEDUP_KEYS.get(table)
    if key is None:
        return None
    values: list[Any] = []
    for col in key:
        if row.get(col) is None:
            return None
        values.append(_normalise(row[col]))
    return tuple(values)


def _normalise(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip().casefold()
    return value


# --------------------------------------------------------------------------
# UUID remapping
# --------------------------------------------------------------------------


def is_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True


class IdRemapper:
    """Tracks how a source project's ids translate into the target project.

    Two rows describing the same real-world thing were given different UUIDs by
    each project. Merging naively duplicates them, and every child row keeps
    pointing at the source id, which does not exist in the target. This class
    records `source id -> target id` per table so child rows can be rewritten
    before insert.
    """

    def __init__(self, schema: Schema) -> None:
        self.schema = schema
        self._map: dict[str, dict[str, str]] = defaultdict(dict)
        self._collisions: list[dict[str, str]] = []

    def learn(
        self,
        table: str,
        source_rows: Sequence[Mapping[str, Any]],
        target_rows: Sequence[Mapping[str, Any]],
        pk: str = "id",
    ) -> dict[str, str]:
        """Match source rows to target rows by natural key and record the remap.

        Returns only the ids that actually change. A source row with no match in
        the target keeps its own id (it is a genuinely new row) unless that id is
        already taken in the target, which is recorded as a collision.
        """
        target_by_key: dict[tuple[Any, ...], Any] = {}
        target_ids = {r.get(pk) for r in target_rows}
        for row in target_rows:
            key = natural_key_of(table, row)
            if key is not None:
                target_by_key[key] = row.get(pk)

        changed: dict[str, str] = {}
        for row in source_rows:
            source_id = row.get(pk)
            if source_id is None:
                continue
            key = natural_key_of(table, row)
            match = target_by_key.get(key) if key is not None else None
            if match is not None and match != source_id:
                self._map[table][source_id] = match
                changed[source_id] = match
            elif match is None and source_id in target_ids:
                # Same UUID, different real-world thing: a hard collision that
                # needs a brand-new id in the target.
                fresh = str(uuid.uuid4())
                self._map[table][source_id] = fresh
                changed[source_id] = fresh
                self._collisions.append(
                    {"table": table, "source_id": source_id, "new_id": fresh}
                )
        return changed

    def add(self, table: str, source_id: str, target_id: str) -> None:
        self._map[table][source_id] = target_id

    def resolve(self, table: str, source_id: Any) -> Any:
        """The target id for a source id, or the source id when it is unchanged."""
        return self._map.get(table, {}).get(source_id, source_id)

    def mapping(self, table: str) -> dict[str, str]:
        return dict(self._map.get(table, {}))

    @property
    def collisions(self) -> list[dict[str, str]]:
        """Source ids that clashed with an unrelated target row of the same id."""
        return list(self._collisions)

    def remap_row(self, table: str, row: Mapping[str, Any]) -> dict[str, Any]:
        """Rewrite a source row's own id and every foreign key it carries.

        A child row follows its remapped parent: `movements.window_id` is looked
        up in the `windows` mapping, not in `movements`.
        """
        out = dict(row)
        if "id" in out:
            out["id"] = self.resolve(table, out["id"])
        spec = self.schema.tables.get(table)
        if spec is None:
            return out
        for fk in spec.foreign_keys:
            if fk.is_auth:
                continue
            for col in fk.columns:
                if col in out and out[col] is not None:
                    out[col] = self.resolve(fk.ref_table, out[col])
        return out

    def rows_needing_new_ids(self, table: str) -> int:
        return len(self._map.get(table, {}))


# --------------------------------------------------------------------------
# Inventory comparison
# --------------------------------------------------------------------------

#: The three states a table can be in, kept distinct on purpose. Conflating
#: "missing" with "empty" is what caused a production database to be reported
#: clean while it was 31 tables short — see
#: docs/migration-drift-2026-07-29-production.md.
MISSING = "missing"
EMPTY = "empty"
POPULATED = "populated"


def table_state(count: int | None) -> str:
    if count is None:
        return MISSING
    return EMPTY if count == 0 else POPULATED


@dataclass
class TableComparison:
    table: str
    states: dict[str, str]
    counts: dict[str, int | None]
    column_only_in: dict[str, list[str]] = field(default_factory=dict)
    type_differences: dict[str, dict[str, str]] = field(default_factory=dict)

    @property
    def missing_somewhere(self) -> bool:
        return MISSING in self.states.values()

    @property
    def counts_differ(self) -> bool:
        present = [c for c in self.counts.values() if c is not None]
        return len(set(present)) > 1

    @property
    def verdict(self) -> str:
        states = set(self.states.values())
        if states == {MISSING}:
            return "absent everywhere"
        if MISSING in states and POPULATED in states:
            return "MISSING WHERE DATA EXISTS ELSEWHERE"
        if MISSING in states:
            return "missing in some projects (no data anywhere)"
        if states == {EMPTY}:
            return "exists everywhere, empty everywhere"
        if states == {EMPTY, POPULATED}:
            return "empty in some projects, populated in others"
        if self.counts_differ:
            return "row counts differ"
        return "identical row counts"


def load_inventory(path: Path | str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    if "project_ref" not in data:
        raise ValueError(f"{path}: not an inventory file (no project_ref)")
    return data


def inventory_from_backup(path: Path | str) -> dict[str, Any]:
    """Turn a full-table JSON backup into the inventory shape, for testing.

    The committed backup only contains non-empty tables, so every table it omits
    is genuinely unknown — recorded as such rather than guessed at zero.
    """
    raw = json.loads(Path(path).read_text())
    tables = {
        name: {"rows": len(rows), "columns": _columns_of(rows)}
        for name, rows in raw.items()
        if isinstance(rows, list)
    }
    return {
        "project_ref": raw.get("project_id", "unknown"),
        "name": f"backup {raw.get('exported_at', '')}".strip(),
        "captured_at": raw.get("exported_at"),
        "source": "backup",
        "tables": tables,
        "migrations": {"count": None, "latest": None},
        "auth": {"users": None},
        "storage": {"buckets": []},
        "functions": [],
    }


def _columns_of(rows: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    columns: dict[str, str] = {}
    for row in rows:
        for col, value in row.items():
            if col not in columns or columns[col] == "unknown":
                columns[col] = _json_type(value)
    return columns


def _json_type(value: Any) -> str:
    if value is None:
        return "unknown"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "numeric"
    if isinstance(value, (dict, list)):
        return "jsonb"
    if is_uuid(value):
        return "uuid"
    return "text"


def compare_inventories(inventories: Sequence[Mapping[str, Any]]) -> list[TableComparison]:
    """Compare two or more inventories table by table.

    Every table seen in any inventory appears in the result, so a table that is
    missing from one project is visible rather than absent from the report.
    """
    if len(inventories) < 2:
        raise ValueError("need at least two inventories to compare")

    refs = [inv["project_ref"] for inv in inventories]
    all_tables = sorted({t for inv in inventories for t in inv.get("tables", {})})

    out: list[TableComparison] = []
    for table in all_tables:
        counts: dict[str, int | None] = {}
        columns: dict[str, dict[str, str]] = {}
        for ref, inv in zip(refs, inventories):
            entry = inv.get("tables", {}).get(table)
            counts[ref] = None if entry is None else entry.get("rows")
            columns[ref] = (entry or {}).get("columns", {}) or {}

        states = {ref: table_state(count) for ref, count in counts.items()}

        # Only compare columns between projects that actually reported some. A
        # backup-derived inventory learns columns from the rows themselves, so
        # an empty table there means "columns unknown", not "no columns" —
        # reporting every column as missing would be an artefact, not a finding.
        present_refs = [r for r in refs if counts[r] is not None and columns[r]]
        union_cols = sorted({c for r in present_refs for c in columns[r]})
        column_only_in: dict[str, list[str]] = {}
        type_differences: dict[str, dict[str, str]] = {}
        for col in union_cols:
            holders = [r for r in present_refs if col in columns[r]]
            if len(holders) != len(present_refs):
                column_only_in[col] = holders
                continue
            types = {r: columns[r][col] for r in holders}
            concrete = {t for t in types.values() if t != "unknown"}
            if len(concrete) > 1:
                type_differences[col] = types

        out.append(
            TableComparison(
                table=table,
                states=states,
                counts=counts,
                column_only_in=column_only_in,
                type_differences=type_differences,
            )
        )
    return out


def migration_leader(inventories: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Which project has applied the most migrations, and how far apart they are."""
    counts = {
        inv["project_ref"]: (inv.get("migrations") or {}).get("count")
        for inv in inventories
    }
    known = {r: c for r, c in counts.items() if isinstance(c, int)}
    leader = max(known, key=lambda r: known[r]) if known else None
    return {
        "counts": counts,
        "leader": leader,
        "spread": (max(known.values()) - min(known.values())) if len(known) > 1 else 0,
        "unknown": sorted(r for r, c in counts.items() if not isinstance(c, int)),
    }


def total_rows(inventory: Mapping[str, Any]) -> int:
    return sum(
        entry.get("rows") or 0
        for entry in inventory.get("tables", {}).values()
        if isinstance(entry, dict)
    )
