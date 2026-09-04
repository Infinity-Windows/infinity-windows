"""Replays every `create policy` / `drop policy` statement across
supabase/migrations/*.sql, in filename (chronological) order, to recover the
LIVE set of RLS policies that grant SELECT (directly, or via a FOR ALL
policy) to `authenticated` on each table in `public` — the same "replay to
the live state" approach supabase_merge_lib.py uses for table shape.

Exists for one reason: scripts/test_partner_wall.py uses it to assert that
every such table, except the two named in PARTNER_WALL_EXEMPT_TABLES, has
the `is_partner_user()` guard folded into its policy (wave S, S1, migration
20260950000000_partner_wall.sql — "THE WALL"). Because this replay is
dynamic rather than a hand-maintained list of the tables swept on the day
that migration was written, a FUTURE migration that adds a table with a
naive `using (true)` select policy fails that test on its own — nobody has
to remember to add the new table anywhere for the protection to apply.

CREATE sets state[(table, name)] = definition, overwriting any earlier
definition under the same name (this repo's convention for redefining a
policy is `drop policy if exists "x"; create policy "x" ...`). DROP removes
state[(table, name)] if present. A plain semicolon split, WITHOUT stripping
`$$...$$` bodies first, is safe for finding these statements even when
nested inside a `do $$ if not exists (...) then create policy ... end if;
end; $$` guard (very common in this codebase): a `create policy ... using
(...)` statement never itself contains a ';' (SQL boolean expressions
don't), so splitting the whole file on ';' still isolates each policy
statement as its own chunk, wherever it's nested — the chunk just doesn't
have to START with the keyword.

What this CANNOT recover: policies built by string-formatting a table name
into an `execute format('create policy ... %I ...', t)` call inside a loop
over an array literal — the table name is a runtime variable, not text in
the file. Every historical instance of this pattern (7 call sites, across 6
migrations, as of wave S) is hand-verified and hardcoded in
`_apply_known_dynamic_policies` below. A NEW instance of this pattern in a
future migration is deliberately NOT silently ignored: it is collected in
`unparsed` and `test_partner_wall.py` fails loudly on anything in `unparsed`
that isn't already accounted for in `KNOWN_DYNAMIC_SOURCES`, forcing a human
to teach this file the new pattern rather than let a table slip past the
wall unnoticed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"

#: Tables THE WALL's sweep (20260950000000_partner_wall.sql) deliberately
#: does not touch, and why — see that migration's own header comment, which
#: names this exact constant. Keep these two comments in sync.
#:   - projects: a partner needs their granted rows readable (the app shell
#:     names granted jobs); projects' own policy carries a hand-written
#:     partner_job_grants exists() clause instead of the mechanical guard.
#:     READ THIS BEFORE ADDING A COLUMN TO `projects`. That policy is
#:     row-level, and RLS has no column-level half: a granted builder reads
#:     the WHOLE row, every column, present and future. THE WALL's own
#:     comment ("nothing crew-only lives on `projects` itself") was true when
#:     it was written and is not a guarantee about what lands later. Wave Z
#:     hit this first — bid_amount and target_margin_pct could not be locked
#:     where they sat, so 20260978000000 MOVED them to project_financials,
#:     which carries its own policy. That is the shape to copy: anything a
#:     builder must not see belongs in its own table, not in a column here.
#:     Wave J's ready_state / materials_eta / materials_arrived_at were
#:     weighed against this, left on `projects` — and MOVED OFF AGAIN one
#:     wave later, because that judgement was wrong: a granted builder was
#:     reading our own "not ready / windows still not in" off their job row.
#:     They live in `project_pipeline` now (20260981000000, wave H, H0).
#:     TWO WAVES IN A ROW got this wrong in the same direction, which is the
#:     lesson: the question is not "is this fact sensitive" but "is this fact
#:     ABOUT US". A date the builder already knows is still ours to say, in
#:     our words, when we choose to. Only `sort_order` stayed — a bare
#:     integer whose meaning is "fourth in a list a builder cannot see".
#:   - daily_logs: a partner never reads the table at all, under any
#:     predicate — the S3 projection RPC is the only door, and daily_logs'
#:     policy (my_role_rank() >= 1) already excludes the installer-ranked
#:     partner floor before the wall would even be asked.
PARTNER_WALL_EXEMPT_TABLES: frozenset[str] = frozenset({"projects", "daily_logs"})

#: Tables declared by a migration and later DROPPED outright, so a policy
#: recovered for them is a phantom — no such table exists for a real
#: `create policy`/`alter table` to target. Excluded from the live-set
#: report entirely (not "exempt from the wall": exempt tables above still
#: exist and are readable, just deliberately not swept).
DROPPED_LATER_TABLES: frozenset[str] = frozenset({"package_events", "pending_delivery_sets"})

#: Not a `public` schema business table (Supabase Storage's own object
#: table) — out of scope for a wall about crew TABLES in `public`.
NOT_PUBLIC_SCHEMA_TABLES: frozenset[str] = frozenset({"storage"})


@dataclass
class PolicyDef:
    name: str
    table: str
    command: str  # SELECT / INSERT / UPDATE / DELETE / ALL
    roles: str
    using: str
    check: str
    source: str


@dataclass
class TableState:
    rls_enabled: bool | None = None
    policies: dict[str, PolicyDef] = field(default_factory=dict)


_CREATE_POLICY_RE = re.compile(
    r'create\s+policy\s+("(?:[^"]+)"|[a-z_][a-z0-9_]*)\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)'
    r'(?P<body>.*)$',
    re.IGNORECASE | re.DOTALL,
)
_DROP_POLICY_RE = re.compile(
    r'drop\s+policy\s+(?:if\s+exists\s+)?("(?:[^"]+)"|[a-z_][a-z0-9_]*)\s+on\s+(?:public\.)?([a-z_][a-z0-9_]*)',
    re.IGNORECASE,
)
_FOR_CMD_RE = re.compile(r'\bfor\s+(select|insert|update|delete|all)\b', re.IGNORECASE)
_TO_ROLES_RE = re.compile(r'\bto\s+([a-z0-9_,\s]+?)(?=\busing\b|\bwith\s+check\b|$)', re.IGNORECASE)
_USING_RE = re.compile(r'\busing\s*\((?P<body>.*)', re.IGNORECASE | re.DOTALL)
_CHECK_RE = re.compile(r'\bwith\s+check\s*\((?P<body>.*)', re.IGNORECASE | re.DOTALL)


def _balanced_parens(text: str) -> str:
    """`text` starts right after an opening '('. Return the text up to (not
    including) its matching close."""
    depth = 1
    for i, ch in enumerate(text):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[:i]
    return text


def _split_statements_raw(sql: str) -> list[str]:
    sql = re.sub(r"--[^\n]*", "", sql)  # line comments only; NOT $$ bodies
    return [s.strip() for s in sql.split(";") if s.strip()]


def _parse_name(raw: str) -> str:
    return raw.strip('"')


#: Every `create policy ... %I ...` built via `execute format(...)` over an
#: array-literal loop, as of wave S — hand-verified against the source by
#: reading each migration in full. See the module docstring for what happens
#: when a NEW one appears that isn't listed here.
KNOWN_DYNAMIC_SOURCES: frozenset[str] = frozenset({
    "20260715000000_inventory_core.sql",
    "20260715120000_install_capture.sql",
    "20260717005000_ops_modules.sql",
    "20260729230000_ai_spend_limits.sql",
    "20260814000000_storage_tracking.sql",
    "20260829000000_lock_movements_and_supplies.sql",
})


def _apply_known_dynamic_policies(source: str, states: dict[str, TableState]) -> None:
    if source == "20260715000000_inventory_core.sql":
        for t in ['window_types', 'locations', 'projects', 'project_windows', 'windows',
                  'window_id_counters', 'movements', 'attachments', 'cycle_counts']:
            states.setdefault(t, TableState()).policies['authenticated full access'] = PolicyDef(
                'authenticated full access', t, 'ALL', 'authenticated', 'true', 'true', source)
    elif source == "20260715120000_install_capture.sql":
        for t in ['project_plansets', 'project_openings', 'install_events']:
            states.setdefault(t, TableState()).policies['authenticated full access'] = PolicyDef(
                'authenticated full access', t, 'ALL', 'authenticated', 'true', 'true', source)
    elif source == "20260717005000_ops_modules.sql":
        for t in ['safety_talks', 'safety_acks', 'incidents', 'tools', 'supplies',
                  'supply_orders', 'qc_checks']:
            st = states.setdefault(t, TableState())
            st.rls_enabled = True
            st.policies['authenticated full access'] = PolicyDef(
                'authenticated full access', t, 'ALL', 'authenticated', 'true', 'true', source)
    elif source == "20260729230000_ai_spend_limits.sql":
        for t in ['ai_spend_limits', 'ai_usage_days', 'ai_spend_months',
                  'ai_usage_events', 'ai_spend_alerts']:
            name = t + '_select_office'
            states.setdefault(t, TableState()).policies.pop(name, None)  # drop if exists, first
            states[t].policies[name] = PolicyDef(
                name, t, 'SELECT', 'authenticated',
                'public.ai_role_rank(auth.uid()) >= 2', '', source)
    elif source == "20260814000000_storage_tracking.sql":
        for t in ['storage_containers', 'package_deliveries', 'packages',
                  'package_marks', 'package_events', 'checkout_reasons']:
            states.setdefault(t, TableState()).policies.setdefault('crew read', PolicyDef(
                'crew read', t, 'SELECT', 'authenticated', 'true', '', source))
    elif source == "20260829000000_lock_movements_and_supplies.sql":
        # Drop-by-shape: "for p in select policyname from pg_policies where
        # ... cmd in ('ALL','INSERT','UPDATE','DELETE') loop execute
        # format('drop policy %I on <table>', p.policyname)" — removes
        # whatever write-capable policy existed at this point in history
        # (verified by reading the migration: at this point that is exactly
        # the day-one "authenticated full access" FOR ALL policy on each of
        # these two tables), then adds a plain crew-read SELECT policy.
        for t in ['movements', 'supplies']:
            st = states.setdefault(t, TableState())
            for pname in [n for n, p in list(st.policies.items())
                          if p.command in ('ALL', 'INSERT', 'UPDATE', 'DELETE')]:
                del st.policies[pname]
        states['movements'].policies['movements crew read'] = PolicyDef(
            'movements crew read', 'movements', 'SELECT', 'authenticated', 'true', '', source)
        states['supplies'].policies['supplies crew read'] = PolicyDef(
            'supplies crew read', 'supplies', 'SELECT', 'authenticated', 'true', '', source)


def replay_policies() -> tuple[dict[str, TableState], list[str]]:
    """Returns (per-table policy state, unparsed create/drop policy chunks).

    `unparsed` chunks are ones that contained the literal text "create
    policy" or "drop policy" but didn't match the plain (non-dynamic)
    pattern this parser understands — expected to be exactly the
    KNOWN_DYNAMIC_SOURCES call sites, handled separately above. Anything
    else in `unparsed` is a genuinely new construct the test should fail on.
    """
    states: dict[str, TableState] = {}
    unparsed: list[str] = []

    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        text = path.read_text()
        for stmt in _split_statements_raw(text):
            low = stmt.strip().lower()
            if "create policy" in low:
                m = _CREATE_POLICY_RE.search(stmt)
                if not m:
                    unparsed.append(f"{path.name}: {stmt[:200]!r}")
                    continue
                name = _parse_name(m.group(1))
                table = m.group(2)
                body = m.group("body")
                cmd_m = _FOR_CMD_RE.search(body)
                command = cmd_m.group(1).upper() if cmd_m else "ALL"
                roles_m = _TO_ROLES_RE.search(body)
                roles = roles_m.group(1).strip() if roles_m else "PUBLIC"
                using_clause = ""
                um = _USING_RE.search(body)
                if um:
                    using_clause = " ".join(_balanced_parens(um.group("body")).split())
                check_clause = ""
                cm = _CHECK_RE.search(body)
                if cm:
                    check_clause = " ".join(_balanced_parens(cm.group("body")).split())
                st = states.setdefault(table, TableState())
                st.policies[name] = PolicyDef(name, table, command, roles, using_clause, check_clause, path.name)
            elif "drop policy" in low:
                m = _DROP_POLICY_RE.search(stmt)
                if not m:
                    unparsed.append(f"{path.name}: {stmt[:200]!r}")
                    continue
                name = _parse_name(m.group(1))
                table = m.group(2)
                states.setdefault(table, TableState()).policies.pop(name, None)
        if path.name in KNOWN_DYNAMIC_SOURCES:
            _apply_known_dynamic_policies(path.name, states)

    return states, unparsed


def live_select_granting_tables() -> dict[str, dict[str, PolicyDef]]:
    """Every table (outside DROPPED_LATER_TABLES / NOT_PUBLIC_SCHEMA_TABLES)
    that currently carries at least one live SELECT-or-ALL policy granting
    to a role including `authenticated`, mapped to its {policy_name:
    PolicyDef}. This is "every table a partner could read via REST today if
    nothing walled it off" — the wall's own enumeration target.
    """
    states, _unparsed = replay_policies()
    out: dict[str, dict[str, PolicyDef]] = {}
    for table, st in states.items():
        if table in DROPPED_LATER_TABLES or table in NOT_PUBLIC_SCHEMA_TABLES:
            continue
        select_relevant = {
            n: p for n, p in st.policies.items()
            if p.command in ("SELECT", "ALL") and "authenticated" in p.roles.lower()
        }
        if select_relevant:
            out[table] = select_relevant
    return out
