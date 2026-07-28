#!/usr/bin/env python3
"""Detect functions whose live body differs from the last migration to define it.

`create or replace function` is invisible to an existence check: the function is
already there from an earlier migration, so a later migration that rewrites its
body looks "applied" while the database still runs the old logic. This compares
the whitespace-normalised body text instead.

Usage:
    scripts/function_drift.py /tmp/live_functions.json
"""
import json
import os
import re
import sys

MIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'supabase', 'migrations')


def norm(s: str) -> str:
    """Collapse whitespace so formatting-only differences do not register."""
    return re.sub(r'\s+', ' ', s or '').strip().lower()


def migration_bodies():
    """Map function name -> (defining file, body) for the last definition seen."""
    latest = {}
    for fn in sorted(os.listdir(MIG_DIR)):
        if not fn.endswith('.sql'):
            continue
        sql = open(os.path.join(MIG_DIR, fn)).read()
        for m in re.finditer(
            r'create\s+(?:or\s+replace\s+)?function\s+([\w".]+)\s*\(', sql, re.I,
        ):
            name = m.group(1).strip('"').lower()
            if name.startswith('public.'):
                name = name[len('public.'):]
            # Body is the first dollar-quoted block after the signature.
            tail = sql[m.end():]
            dq = re.search(r'\$(\w*)\$(.*?)\$\1\$', tail, re.S)
            if dq:
                latest[name] = (fn, dq.group(2))
    return latest


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/iwdrift/live7.json'
    live = {}
    for row in json.load(open(path)):
        name, _args, src = row['k'].split('|#|', 2)
        live.setdefault(name.lower(), []).append(src)

    declared = migration_bodies()
    drifted, absent, ok = [], [], 0
    for name, (fn, body) in sorted(declared.items()):
        if name not in live:
            absent.append((name, fn))
            continue
        if any(norm(s) == norm(body) for s in live[name]):
            ok += 1
        else:
            drifted.append((name, fn))

    print(f'functions matching their latest migration: {ok}')
    print(f'\nfunctions ABSENT from the database ({len(absent)}):')
    for name, fn in absent:
        print(f'    {name:45} <- {fn}')
    print(f'\nfunctions whose LIVE BODY DIFFERS from the latest migration ({len(drifted)}):')
    for name, fn in drifted:
        print(f'    {name:45} <- {fn}')


if __name__ == '__main__':
    main()
