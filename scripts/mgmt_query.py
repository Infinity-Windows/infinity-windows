#!/usr/bin/env python3
"""Read-only Supabase Management API query helper (library form of scripts/pgq.sh).

Refuses anything that is not a read-only statement, so a backup run can never
mutate the database it is copying.
"""
from __future__ import annotations

import json
import os
import re
import subprocess

API = "https://api.supabase.com/v1"

_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|"
    r"vacuum|reindex|call|do)\s",
    re.IGNORECASE,
)


def _token() -> str:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token:
        raise SystemExit("set SUPABASE_ACCESS_TOKEN to an sbp_ management token")
    return token


def _curl(args: list[str]) -> str:
    proc = subprocess.run(
        ["curl", "-sS", *args, "-H", f"Authorization: Bearer {_token()}"],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def query(ref: str, sql: str):
    """Run a single read-only SQL statement and return the parsed rows."""
    if _FORBIDDEN.search(sql):
        raise SystemExit(f"refusing to run a non-SELECT statement:\n{sql[:200]}")
    body = json.dumps({"query": sql})
    out = subprocess.run(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            f"{API}/projects/{ref}/database/query",
            "-H",
            f"Authorization: Bearer {_token()}",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
        ],
        input=body,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise SystemExit(f"unexpected API response: {out[:400]}")


def get(path: str):
    out = _curl([f"{API}{path}"])
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"_raw": out[:400]}
