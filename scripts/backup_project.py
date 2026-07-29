#!/usr/bin/env python3
"""Take a read-only, restorable snapshot of a Supabase project.

Captures every row of every non-empty table in the non-system schemas, the
schema DDL needed to rebuild those tables, the auth roster (without password
hashes), the storage inventory, the edge function and secret *names*, and the
applied migration history.

    scripts/backup_project.py <project-ref> <out-dir>

Every statement it runs is a SELECT. It never writes to the project.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from mgmt_query import get, query  # noqa: E402

SYSTEM_SCHEMAS = (
    "pg_catalog",
    "information_schema",
    "auth",
    "storage",
    "realtime",
    "_realtime",
    "extensions",
    "graphql",
    "graphql_public",
    "vault",
    "pgsodium",
    "pgsodium_masks",
    "supabase_migrations",
    "supabase_functions",
    "net",
    "cron",
    "pgbouncer",
)

# Credential columns whose values must never land in the repository. Matched on the
# exact column name, deliberately: a pattern like /pin/ would also wipe out
# project_openings.pin_x and pin_y, which are the plan pin coordinates and are real data.
REDACTED_COLUMNS = frozenset(
    {
        "pin",
        "pin_hash",
        "pin_salt",
        "password",
        "wifi_password",
        "encrypted_password",
        "password_hash",
        "secret",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "service_role_key",
        "anon_key",
        "auth",  # Web Push subscription auth secret
        "p256dh",  # Web Push subscription public key
        "private_key",
    }
)
REDACTION_MARKER = "[REDACTED-CREDENTIAL]"

# Password material is deliberately excluded from the roster below.
AUTH_USER_COLUMNS = """
    id, email, phone, role, aud,
    created_at, updated_at, confirmed_at, email_confirmed_at, phone_confirmed_at,
    last_sign_in_at, invited_at, banned_until, deleted_at,
    is_super_admin, is_sso_user, is_anonymous,
    raw_app_meta_data, raw_user_meta_data
"""


def user_schemas() -> str:
    quoted = ",".join(f"'{s}'" for s in SYSTEM_SCHEMAS)
    return (
        f"nspname not in ({quoted}) and nspname not like 'pg\\_%' "
        "and nspname not like 'timescaledb%'"
    )


def list_schemas(ref: str) -> list[str]:
    rows = query(ref, f"select nspname from pg_namespace where {user_schemas()} order by 1")
    return [r["nspname"] for r in rows]


def list_tables(ref: str, schemas: list[str]) -> list[dict]:
    if not schemas:
        return []
    quoted = ",".join(f"'{s}'" for s in schemas)
    return query(
        ref,
        f"""
        select n.nspname as schema, c.relname as name,
               case c.relkind when 'r' then 'table' when 'p' then 'partitioned'
                              when 'v' then 'view' when 'm' then 'matview'
                              when 'f' then 'foreign' else c.relkind::text end as kind,
               c.relrowsecurity as rls_enabled
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ({quoted}) and c.relkind in ('r','p','v','m','f')
        order by 1, 2
        """,
    )


def primary_key_columns(ref: str, schemas: list[str]) -> dict[tuple[str, str], list[str]]:
    quoted = ",".join(f"'{s}'" for s in schemas)
    rows = query(
        ref,
        f"""
        select n.nspname as schema, c.relname as name,
               array_agg(a.attname order by k.ord) as cols
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
        join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where con.contype = 'p' and n.nspname in ({quoted})
        group by 1, 2
        """,
    )
    return {(r["schema"], r["name"]): _pg_array(r["cols"]) for r in rows}


def _pg_array(value) -> list[str]:
    """The Management API renders Postgres arrays as literals like '{id,seq}'."""
    if isinstance(value, list):
        return [str(v) for v in value]
    inner = str(value).strip().lstrip("{").rstrip("}")
    return [c.strip().strip('"') for c in inner.split(",") if c.strip()]


def row_counts(ref: str, tables: list[dict]) -> dict[tuple[str, str], int]:
    counts: dict[tuple[str, str], int] = {}
    batch: list[dict] = []
    for t in tables:
        if t["kind"] not in ("table", "partitioned"):
            continue
        batch.append(t)
        if len(batch) == 25:
            counts.update(_count_batch(ref, batch))
            batch = []
    if batch:
        counts.update(_count_batch(ref, batch))
    return counts


def _count_batch(ref: str, batch: list[dict]) -> dict[tuple[str, str], int]:
    union = " union all ".join(
        f"""select '{t["schema"]}' as s, '{t["name"]}' as t, count(*) as n """
        f"""from "{t["schema"]}"."{t["name"]}\""""
        for t in batch
    )
    return {(r["s"], r["t"]): int(r["n"]) for r in query(ref, union)}


def fetch_rows(ref: str, schema: str, name: str, pk: list[str] | None) -> list[dict]:
    order = f' order by {", ".join(chr(34) + c + chr(34) for c in pk)}' if pk else ""
    return query(ref, f'select * from "{schema}"."{name}"{order}')


def redact(rows: list[dict], schema: str, table: str, log: list[str]) -> list[dict]:
    """Blank out credential values in place, and say exactly what was blanked."""
    for column in sorted(REDACTED_COLUMNS):
        hits = sum(1 for r in rows if r.get(column) not in (None, ""))
        if not hits:
            continue
        for r in rows:
            if r.get(column) not in (None, ""):
                r[column] = REDACTION_MARKER
        log.append(f"{schema}.{table}.{column}: {hits} value(s) redacted")
    return rows


def capture_schema(ref: str, schemas: list[str]) -> dict:
    if not schemas:
        return {}
    quoted = ",".join(f"'{s}'" for s in schemas)
    q = lambda sql: query(ref, sql)  # noqa: E731
    return {
        "columns": q(
            f"""
            select table_schema as schema, table_name as "table", column_name as column,
                   ordinal_position as position, data_type, udt_name,
                   is_nullable, column_default, character_maximum_length,
                   numeric_precision, numeric_scale, is_identity, identity_generation,
                   is_generated, generation_expression
            from information_schema.columns
            where table_schema in ({quoted})
            order by table_schema, table_name, ordinal_position
            """
        ),
        "constraints": q(
            f"""
            select n.nspname as schema, c.relname as "table", con.conname as name,
                   case con.contype when 'p' then 'primary key' when 'f' then 'foreign key'
                        when 'u' then 'unique' when 'c' then 'check'
                        when 'x' then 'exclude' else con.contype::text end as type,
                   pg_get_constraintdef(con.oid) as definition
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ({quoted})
            order by 1, 2, 3
            """
        ),
        "indexes": q(
            f"""
            select schemaname as schema, tablename as "table", indexname as name,
                   indexdef as definition
            from pg_indexes where schemaname in ({quoted})
            order by 1, 2, 3
            """
        ),
        "foreign_keys": q(
            f"""
            select n.nspname as schema, c.relname as "table", con.conname as name,
                   fn.nspname as references_schema, fc.relname as references_table,
                   pg_get_constraintdef(con.oid) as definition,
                   con.confupdtype as on_update, con.confdeltype as on_delete
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
            join pg_class fc on fc.oid = con.confrelid
            join pg_namespace fn on fn.oid = fc.relnamespace
            where con.contype = 'f' and n.nspname in ({quoted})
            order by 1, 2, 3
            """
        ),
        "views": q(
            f"""
            select schemaname as schema, viewname as name, definition
            from pg_views where schemaname in ({quoted})
            union all
            select schemaname, matviewname, definition
            from pg_matviews where schemaname in ({quoted})
            order by 1, 2
            """
        ),
        "functions": q(
            f"""
            select n.nspname as schema, p.proname as name,
                   pg_get_function_identity_arguments(p.oid) as arguments,
                   pg_get_functiondef(p.oid) as definition,
                   l.lanname as language, p.prosecdef as security_definer
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_language l on l.oid = p.prolang
            where n.nspname in ({quoted}) and p.prokind in ('f','p')
            order by 1, 2, 3
            """
        ),
        "triggers": q(
            f"""
            select n.nspname as schema, c.relname as "table", t.tgname as name,
                   pg_get_triggerdef(t.oid) as definition
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
            where not t.tgisinternal and n.nspname in ({quoted})
            order by 1, 2, 3
            """
        ),
        "rls_policies": q(
            f"""
            select schemaname as schema, tablename as "table", policyname as name,
                   permissive, roles, cmd, qual as using_expression,
                   with_check as with_check_expression
            from pg_policies where schemaname in ({quoted})
            order by 1, 2, 3
            """
        ),
        "rls_enabled": q(
            f"""
            select n.nspname as schema, c.relname as "table",
                   c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r','p') and n.nspname in ({quoted})
            order by 1, 2
            """
        ),
        "enums": q(
            """
            select n.nspname as schema, t.typname as name,
                   array_agg(e.enumlabel order by e.enumsortorder) as values
            from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
            join pg_enum e on e.enumtypid = t.oid
            where n.nspname not in ('pg_catalog','information_schema')
            group by 1, 2 order by 1, 2
            """
        ),
        "sequences": q(
            f"""
            select sequence_schema as schema, sequence_name as name, data_type,
                   start_value, minimum_value, maximum_value, increment
            from information_schema.sequences
            where sequence_schema in ({quoted})
            order by 1, 2
            """
        ),
        "extensions": q(
            """
            select e.extname as name, e.extversion as version, n.nspname as schema
            from pg_extension e join pg_namespace n on n.oid = e.extnamespace
            order by 1
            """
        ),
    }


def capture_auth(ref: str) -> dict:
    users = query(ref, f"select {AUTH_USER_COLUMNS} from auth.users order by created_at")
    identities = query(
        ref,
        """
        select id, user_id, provider, provider_id, email,
               created_at, updated_at, last_sign_in_at
        from auth.identities order by created_at
        """,
    )
    hashed = query(
        ref,
        """
        select count(*) filter (where encrypted_password is not null
                                  and encrypted_password <> '') as with_password,
               count(*) as total
        from auth.users
        """,
    )
    return {
        "users": users,
        "identities": identities,
        "user_count": len(users),
        "password_hashes": {
            "captured": False,
            "users_with_a_password_hash": int(hashed[0]["with_password"]),
            "note": (
                "auth.users.encrypted_password was deliberately NOT captured. "
                "Restoring this project means users re-set their passwords or "
                "sign in again through their provider."
            ),
        },
    }


def capture_storage(ref: str) -> dict:
    buckets = query(
        ref,
        """
        select id, name, owner, public, avif_autodetection, file_size_limit,
               allowed_mime_types, created_at, updated_at
        from storage.buckets order by id
        """,
    )
    objects = query(
        ref,
        """
        select id, bucket_id, name, owner, version,
               (metadata->>'size')::bigint as size_bytes,
               metadata->>'mimetype' as mime_type,
               metadata->>'cacheControl' as cache_control,
               created_at, updated_at, last_accessed_at
        from storage.objects order by bucket_id, name
        """,
    )
    total = sum(int(o["size_bytes"] or 0) for o in objects)
    return {
        "buckets": buckets,
        "objects": objects,
        "bucket_count": len(buckets),
        "object_count": len(objects),
        "total_bytes": total,
    }


def capture_functions(ref: str) -> dict:
    fns = get(f"/projects/{ref}/functions")
    if not isinstance(fns, list):
        return {"error": "could not list edge functions", "response": fns}
    secrets = get(f"/projects/{ref}/secrets")
    names = sorted(s["name"] for s in secrets) if isinstance(secrets, list) else []
    return {
        "functions": [
            {
                "slug": f.get("slug"),
                "name": f.get("name"),
                "status": f.get("status"),
                "version": f.get("version"),
                "entrypoint_path": f.get("entrypoint_path"),
                "verify_jwt": f.get("verify_jwt"),
                "created_at": f.get("created_at"),
                "updated_at": f.get("updated_at"),
            }
            for f in fns
        ],
        "function_count": len(fns),
        "secret_names": names,
        "secret_values_captured": False,
        "source_note": (
            "Function source is not inlined here; the deployed slugs are tracked "
            "in this repository under supabase/functions/."
        ),
    }


def capture_migrations(ref: str) -> list[dict]:
    exists = query(
        ref,
        """
        select count(*) as n from information_schema.tables
        where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'
        """,
    )
    if not int(exists[0]["n"]):
        return []
    cols = {
        c["column_name"]
        for c in query(
            ref,
            """
            select column_name from information_schema.columns
            where table_schema = 'supabase_migrations'
              and table_name = 'schema_migrations'
            """,
        )
    }
    select = "version" + (", name" if "name" in cols else "")
    return query(
        ref, f"select {select} from supabase_migrations.schema_migrations order by version"
    )


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    ref, out_dir = sys.argv[1], sys.argv[2].rstrip("/")

    project = get(f"/projects/{ref}")
    schemas = list_schemas(ref)
    tables = list_tables(ref, schemas)
    counts = row_counts(ref, tables)
    pks = primary_key_columns(ref, schemas) if schemas else {}

    out: dict = {
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        ),
        "project_id": ref,
    }

    inventory, failures, redactions = [], [], []
    for t in tables:
        key = (t["schema"], t["name"])
        count = counts.get(key)
        entry = {
            "schema": t["schema"],
            "table": t["name"],
            "kind": t["kind"],
            "row_count": count,
            "rls_enabled": t["rls_enabled"],
            "captured": False,
        }
        if t["kind"] in ("view", "matview"):
            entry["note"] = "view; definition captured under _schema.views, rows not stored"
        elif count:
            try:
                rows = fetch_rows(ref, t["schema"], t["name"], pks.get(key))
                if not isinstance(rows, list) or len(rows) != count:
                    raise ValueError(f"expected {count} rows, API returned {rows!r:.120}")
                json_key = t["name"] if t["schema"] == "public" else f'{t["schema"]}.{t["name"]}'
                out[json_key] = redact(rows, t["schema"], t["name"], redactions)
                entry["captured"] = True
                entry["json_key"] = json_key
            except Exception as exc:  # noqa: BLE001 - recorded, never silent
                entry["error"] = str(exc)[:300]
                failures.append(f'{t["schema"]}.{t["name"]}: {exc}'[:300])
        else:
            entry["note"] = "empty table; no rows to store"
        inventory.append(entry)

    out["_meta"] = {
        "project_ref": ref,
        "project_name": project.get("name") if isinstance(project, dict) else None,
        "organization_id": project.get("organization_id") if isinstance(project, dict) else None,
        "region": project.get("region") if isinstance(project, dict) else None,
        "project_created_at": project.get("created_at") if isinstance(project, dict) else None,
        "database_version": (project.get("database") or {}).get("version")
        if isinstance(project, dict)
        else None,
        "captured_by": "scripts/backup_project.py (read-only Management API)",
        "user_schemas": schemas,
        "table_count": sum(1 for t in tables if t["kind"] in ("table", "partitioned")),
        "view_count": sum(1 for t in tables if t["kind"] in ("view", "matview")),
        "non_empty_table_count": sum(1 for e in inventory if e["captured"]),
        "total_rows": sum(e["row_count"] or 0 for e in inventory if e["captured"]),
        "tables": inventory,
        "capture_failures": failures,
        "redactions": redactions,
        "redaction_note": (
            f"Values in these columns were replaced with {REDACTION_MARKER} so no live "
            "credential is committed. Row and column structure is otherwise intact. "
            "Restoring means re-issuing those PINs and keys."
        )
        if redactions
        else "no credential columns held values in this project",
    }
    out["_schema"] = capture_schema(ref, schemas)
    out["_auth"] = capture_auth(ref)
    out["_storage"] = capture_storage(ref)
    out["_edge_functions"] = capture_functions(ref)
    out["_migrations"] = capture_migrations(ref)

    path = f"{out_dir}/2026-07-29-{ref}-full.json"
    with open(path, "w") as fh:
        json.dump(out, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")
    print(f"wrote {path}")
    print(
        f"  {out['_meta']['total_rows']} rows from "
        f"{out['_meta']['non_empty_table_count']}/{out['_meta']['table_count']} tables, "
        f"{out['_auth']['user_count']} auth users, "
        f"{out['_storage']['object_count']} storage objects"
    )
    if failures:
        print("  CAPTURE FAILURES:", *failures, sep="\n    ")


if __name__ == "__main__":
    main()
