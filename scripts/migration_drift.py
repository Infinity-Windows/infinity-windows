#!/usr/bin/env python3
"""Diff every migration file against the live schema and print a verdict.

Reads the snapshot produced by `scripts/pgq.sh scripts/live_schema.sql` and the
declarations produced by `scripts/migration_objects.py`, then reports each file
as APPLIED / PARTIAL / MISSING with the exact objects that are absent.

Existence alone is not enough to call a file applied, so this also compares the
value list of every named CHECK constraint: a constraint that was dropped and
re-added with a wider list (the `windows_status_check` / `on_site` case) exists
under the right name while still enforcing the old rule.

Function bodies are checked separately by scripts/function_drift.py.

Usage:
    scripts/pgq.sh scripts/live_schema.sql > /tmp/live_schema.json
    scripts/migration_drift.py /tmp/live_schema.json
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
MIG_DIR = os.path.join(HERE, '..', 'supabase', 'migrations')

# Kinds that express intent rather than schema shape. The catalog cannot prove
# a seed or a backfill ran, so they are surfaced for review, never judged.
UNVERIFIABLE = {'dml', 'seed', 'colattr'}


def unqualify(name):
    """Drop a leading `public.` so qualified and bare names compare equal."""
    return name[len('public.'):] if name.startswith('public.') else name


def load_live(paths):
    keys = set()
    for p in paths:
        d = json.load(open(p))
        if isinstance(d, dict):
            raise SystemExit(f'query error in {p}: {d}')
        keys |= {r['k'] for r in d}
    return keys


def normalise_live(keys):
    """Reduce live catalog rows to the key vocabulary the extractor emits."""
    out = set()
    checkdefs = {}
    for k in keys:
        p = k.split('|')
        kind = p[0]
        if kind == 'table':
            out.add(f'table|{p[1]}')
        elif kind == 'view':
            out.add(f'table|{unqualify(p[1])}')
        elif kind == 'column':
            out.add(f'column|{p[1]}')
        elif kind in ('index', 'trigger', 'enum'):
            out.add(f'{kind}|{p[1]}|{p[2]}')
        elif kind == 'constraint':
            out.add(f'constraint|{p[1]}|{p[2]}')
        elif kind == 'policy':
            out.add(f'policy|{unqualify(p[1])}|{p[2]}')
        elif kind == 'publication':
            out.add(f'publication|{p[1]}|{unqualify(p[2])}')
        elif kind == 'anyfunction':
            out.add(f'function|{unqualify(p[1])}')
        elif kind in ('sequence', 'extension', 'bucket', 'migration'):
            out.add(f'{kind}|{p[1]}')
        elif kind == 'checkdef':
            checkdefs[p[1].lower()] = '|'.join(p[2:])
    return out, checkdefs


def quoted_values(sql):
    """The set of single-quoted literals in a constraint definition."""
    return {v.lower() for v in re.findall(r"'([^']+)'", sql)}


def declared_check_constraints():
    """Last declared definition of each named constraint, with its source file."""
    decl = {}
    for fn in sorted(os.listdir(MIG_DIR)):
        if not fn.endswith('.sql'):
            continue
        sql = re.sub(r'--[^\n]*', '', open(os.path.join(MIG_DIR, fn)).read())
        for m in re.finditer(
            r'add\s+constraint\s+([\w"]+)\s+(check[\s\S]*?)(?=;)', sql, re.I,
        ):
            decl[m.group(1).strip('"').lower()] = (fn, ' '.join(m.group(2).split()))
    return decl


def main():
    live_paths = sys.argv[1:] or ['/tmp/live_schema.json']
    live, checkdefs = normalise_live(load_live(live_paths))

    declared = subprocess.run(
        [sys.executable, os.path.join(HERE, 'migration_objects.py')],
        capture_output=True, text=True, check=True,
    ).stdout.splitlines()

    per_file = {}
    for line in declared:
        if not line.strip():
            continue
        fn, kind, key = line.split('\t')
        per_file.setdefault(fn, []).append((kind, key))

    # Constraints whose live value list no longer matches the latest migration.
    stale_constraints = {}
    for cname, (fn, definition) in declared_check_constraints().items():
        if cname not in checkdefs:
            continue
        want, have = quoted_values(definition), quoted_values(checkdefs[cname])
        if want != have:
            stale_constraints.setdefault(fn, []).append(
                f'constraint {cname}: live is missing value(s) '
                f'{sorted(want - have)}' + (f', has extra {sorted(have - want)}' if have - want else '')
            )

    verdicts = []
    for fn in sorted(set(per_file) | set(stale_constraints)):
        missing, present, notes = [], [], []
        for kind, key in per_file.get(fn, []):
            if kind in UNVERIFIABLE:
                notes.append(f'{kind}|{key}')
                continue
            full = f'{kind}|{key}'
            (present if full in live else missing).append(full)
        missing += [f'STALE {s}' for s in stale_constraints.get(fn, [])]
        if not present and not missing:
            verdict = 'DATA-ONLY' if notes else 'NO-OBJECTS'
        elif not missing:
            verdict = 'APPLIED'
        elif not present:
            verdict = 'MISSING'
        else:
            verdict = 'PARTIAL'
        verdicts.append((fn, verdict, present, missing, notes))

    for fn, verdict, present, missing, notes in verdicts:
        if verdict in ('APPLIED', 'DATA-ONLY', 'NO-OBJECTS'):
            continue
        print(f'\n=== {fn}: {verdict}  ({len(present)} present / {len(missing)} missing)')
        for m in missing:
            print(f'    MISSING  {m}')

    data_only = [f for f, v, _, _, _ in verdicts if v == 'DATA-ONLY']
    if data_only:
        print('\n=== DATA-ONLY files (seeds/backfills — verify by querying the rows)')
        for f in data_only:
            print(f'    {f}')

    print('\n===== SUMMARY =====')
    print(Counter(v for _, v, _, _, _ in verdicts))
    for fn, verdict, _, _, _ in verdicts:
        print(f'{verdict:11} {fn}')


if __name__ == '__main__':
    main()
