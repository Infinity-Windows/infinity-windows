#!/usr/bin/env python3
"""Read-only review of a schema dump before a workshop import. Never executes SQL.

Findings report statement kind/object identity only, never function bodies or
credentials. A clean report is a screening check, not permission to import.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from urllib.parse import urlsplit
from pathlib import Path
from pglast import ast, parse_sql

PRODUCTION_REFS = ("czprjcskmzzagdztqonm", "jvsyhtarnvmdilsgksdi")
EXTERNAL = re.compile(r"(?:\bnet\s*\.|\bcron\s*\.|\bvault\s*\.|\bdblink\s*\(|\bhttp_(?:get|post|put|delete|request)\b)", re.I)
DATA_KINDS = {"InsertStmt", "UpdateStmt", "DeleteStmt", "CopyStmt", "TruncateStmt", "DoStmt", "CallStmt", "CreateTableAsStmt", "RefreshMatViewStmt", "CreateUserMappingStmt", "CreateForeignServerStmt", "CreateFdwStmt", "CreateForeignTableStmt", "CreateSubscriptionStmt", "AlterSystemStmt", "CreateRoleStmt", "AlterRoleStmt", "CreateEventTrigStmt"}

def identity(node):
    if isinstance(node, ast.CreateFunctionStmt):
        return ".".join(x.sval for x in node.funcname)
    relation = getattr(node, "relation", None)
    if relation is not None:
        return ".".join(x for x in (getattr(relation, "schemaname", None), getattr(relation, "relname", None)) if x)
    return None

def raw_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from raw_strings(child)
    elif isinstance(value, (tuple, list)):
        for child in value:
            yield from raw_strings(child)

def without_locations(value):
    if isinstance(value, dict):
        return {k:without_locations(v) for k,v in value.items() if k != "location"}
    if isinstance(value,(tuple,list)):
        return [without_locations(v) for v in value]
    return value

def audit(sql: str, allowed_origins=()) -> dict:
    if any(o not in ("http://127.0.0.1:5278",) for o in allowed_origins):
        raise ValueError("Only this workshop's local app origin may be reviewed as a link")
    # pg_dump v17 wraps output with non-SQL psql restrict commands. Permit only
    # those two wrappers; any other psql command is flagged instead of ignored.
    meta = [line for line in sql.splitlines() if line.lstrip().startswith("\\")]
    issues = [{"kind": "psql-command", "object": None} for line in meta if not re.match(r"^\s*\\(?:unrestrict|restrict)\s+[A-Za-z0-9]+\s*$", line)]
    clean = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("\\"))
    rows = parse_sql(clean)
    for raw in rows:
        kind = type(raw.stmt).__name__
        name = identity(raw.stmt)
        # Inspect the parsed values, not offsets into a Unicode SQL string:
        # parser byte/character positions are unsafe around multibyte text.
        parsed = raw.stmt()
        fragment = "\n".join(raw_strings(parsed))
        if kind in DATA_KINDS:
            issues.append({"kind": "data-or-execution", "statement": kind, "object": name})
        if kind == "CreateExtensionStmt" and raw.stmt.extname in ("pg_net", "pg_cron", "http", "wrappers", "dblink"):
            issues.append({"kind":"external-extension", "statement":kind, "object":raw.stmt.extname})
        if kind == "SelectStmt" and without_locations(parsed) != without_locations(parse_sql("SELECT pg_catalog.set_config('search_path', '', false);")[0].stmt()):
            issues.append({"kind": "top-level-query", "statement": kind, "object": name})
        if any(ref in fragment for ref in PRODUCTION_REFS):
            issues.append({"kind": "production-reference", "statement": kind, "object": name})
        urls=re.findall(r"https?://[^\s\x27\x22\\]+",fragment)
        url_bad=any(f"{urlsplit(u).scheme}://{urlsplit(u).netloc}" not in allowed_origins for u in urls)
        if EXTERNAL.search(fragment) or url_bad:
            issues.append({"kind": "external-effect-review", "statement": kind, "object": name})
    return {"sha256": hashlib.sha256(sql.encode()).hexdigest(), "statements": len(rows), "screening_passed": not issues, "issues": issues}

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("schema", type=Path);ap.add_argument("--out",type=Path,required=True);ap.add_argument("--allow-workshop-links",action="store_true");args=ap.parse_args()
    result=audit(args.schema.read_text(),("http://127.0.0.1:5278",) if args.allow_workshop_links else ());args.out.write_text(json.dumps(result,indent=2)+"\n")
    print(f"Schema screening: {result['statements']} statements, {len(result['issues'])} findings; no SQL executed")
    raise SystemExit(0 if result["screening_passed"] else 1)
if __name__=="__main__":main()
