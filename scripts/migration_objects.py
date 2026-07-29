#!/usr/bin/env python3
"""Extract the database objects each migration file declares.

Emits one `kind|key` line per object, in the same vocabulary that the live
schema snapshot uses, so the two can be diffed directly. This is a pragmatic
SQL scanner, not a parser: it understands the handful of DDL shapes this repo
actually uses and deliberately ignores anything it does not recognise, so a
`MISSING` verdict is always backed by an object it positively identified.
"""
import os
import re
import sys

MIG_DIR = os.path.join(os.path.dirname(__file__), '..', 'supabase', 'migrations')

# Words that begin a table-level constraint rather than a column definition.
CONSTRAINT_KW = {
    'primary', 'foreign', 'unique', 'check', 'constraint', 'exclude', 'like',
}

# Postgres type spellings mapped to the information_schema.data_type wording the
# live snapshot reports, so `alter column ... type numeric` can be compared. Any
# type not listed is simply not emitted — an unrecognised shape must never
# produce a MISSING verdict.
TYPE_ALIASES = {
    'int': 'integer', 'int2': 'smallint', 'int4': 'integer', 'int8': 'bigint',
    'integer': 'integer', 'smallint': 'smallint', 'bigint': 'bigint',
    'bool': 'boolean', 'boolean': 'boolean',
    'float4': 'real', 'real': 'real',
    'float8': 'double precision',
    'numeric': 'numeric', 'decimal': 'numeric',
    'text': 'text', 'uuid': 'uuid', 'date': 'date',
    'json': 'json', 'jsonb': 'jsonb',
    'timestamptz': 'timestamp with time zone',
    'timestamp': 'timestamp without time zone',
}


def strip_noise(sql: str) -> str:
    """Remove line comments and string/dollar-quoted literals that confuse scanning."""
    sql = re.sub(r'--[^\n]*', '', sql)
    sql = re.sub(r'/\*.*?\*/', '', sql, flags=re.S)
    return sql


def split_top_level(body: str):
    """Split a parenthesised body on commas that are at nesting depth zero."""
    parts, depth, cur = [], 0, ''
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


def match_paren(sql: str, start: int):
    """Return the body inside the parens beginning at/after index `start`."""
    i = sql.find('(', start)
    if i < 0:
        return None, start
    depth, j = 0, i
    while j < len(sql):
        if sql[j] == '(':
            depth += 1
        elif sql[j] == ')':
            depth -= 1
            if depth == 0:
                return sql[i + 1:j], j
        j += 1
    return None, start


def qual(name: str) -> str:
    """Normalise an identifier: drop quotes and a leading public. schema."""
    name = name.strip().strip('"')
    if name.lower().startswith('public.'):
        name = name[len('public.'):]
    return name.lower()


def extract(sql: str):
    objs = []
    raw = sql
    sql = strip_noise(sql)

    # create table [if not exists] name ( ... )
    for m in re.finditer(r'create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)', sql, re.I):
        table = qual(m.group(1))
        objs.append(('table', table))
        body, _ = match_paren(sql, m.end())
        if body:
            for part in split_top_level(body):
                part = part.strip()
                if not part:
                    continue
                first = part.split()[0].strip('"').lower()
                if first in CONSTRAINT_KW:
                    continue
                objs.append(('column', f'{table}.{first}'))

    # alter table name add column [if not exists] col [, add column ...]
    # A single ALTER TABLE can carry several comma-separated ADD COLUMN clauses,
    # so scan the whole statement rather than stopping at the first match.
    for m in re.finditer(
        r'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)([^;]*)', sql, re.I,
    ):
        table = qual(m.group(1))
        for c in re.finditer(
            r'add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"]+)', m.group(2), re.I,
        ):
            objs.append(('column', f'{table}.{qual(c.group(1))}'))

    # create [or replace] view / materialized view — lives alongside tables in
    # the catalog snapshot, so record it under the same kind.
    for m in re.finditer(
        r'create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?([\w".]+)',
        sql, re.I,
    ):
        objs.append(('table', qual(m.group(1))))

    # create sequence [if not exists] name
    for m in re.finditer(
        r'create\s+sequence\s+(?:if\s+not\s+exists\s+)?([\w".]+)', sql, re.I,
    ):
        objs.append(('sequence', qual(m.group(1))))

    # create extension [if not exists] "name"
    for m in re.finditer(
        r'create\s+extension\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[\w]+)', sql, re.I,
    ):
        objs.append(('extension', qual(m.group(1))))

    # alter table x alter column y set default / drop not null — a shape the
    # catalog can confirm, but only via column attributes rather than existence.
    for m in re.finditer(
        r'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)[^;]*?alter\s+column\s+([\w"]+)\s+(set\s+default|drop\s+not\s+null|set\s+not\s+null)',
        sql, re.I,
    ):
        action = ' '.join(m.group(3).split()).lower().replace(' ', '_')
        objs.append(('colattr', f'{qual(m.group(1))}.{qual(m.group(2))}|{action}'))

    # alter table x alter column y type z — invisible to an existence check,
    # because the column is already there under the old type. Missing this shape
    # is how 20260728140000 (project_mark_specs.width_in int -> numeric) went
    # unnoticed while every other object in the file read as applied.
    for m in re.finditer(
        r'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)\s+alter\s+column\s+([\w"]+)\s+(?:set\s+data\s+)?type\s+([\w ]+?)\s*(?:;|using\b|collate\b)',
        sql, re.I,
    ):
        want = TYPE_ALIASES.get(' '.join(m.group(3).split()).lower())
        if want:
            objs.append(('coltype', f'{qual(m.group(1))}.{qual(m.group(2))}|{want}'))

    # alter table name add constraint cname
    for m in re.finditer(
        r'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)\s+add\s+constraint\s+([\w"]+)',
        sql, re.I,
    ):
        objs.append(('constraint', f'{qual(m.group(1))}|{qual(m.group(2))}'))

    # create [unique] index [concurrently] [if not exists] name on table
    for m in re.finditer(
        r'create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w"]+)\s+on\s+([\w".]+)',
        sql, re.I,
    ):
        objs.append(('index', f'{qual(m.group(2))}|{qual(m.group(1))}'))

    # create policy "name" on table
    for m in re.finditer(
        r'create\s+policy\s+("(?:[^"]+)"|[\w]+)\s+on\s+([\w".]+)', sql, re.I,
    ):
        objs.append(('policy', f'{qual(m.group(2))}|{qual(m.group(1))}'))

    # create [or replace] function name(
    for m in re.finditer(
        r'create\s+(?:or\s+replace\s+)?function\s+([\w".]+)', sql, re.I,
    ):
        objs.append(('function', qual(m.group(1))))

    # create trigger name ... on table
    for m in re.finditer(
        r'create\s+(?:or\s+replace\s+)?trigger\s+([\w"]+)[\s\S]{0,200}?\bon\s+([\w".]+)', sql, re.I,
    ):
        objs.append(('trigger', f'{qual(m.group(2))}|{qual(m.group(1))}'))

    # alter publication p add table t[, t2]
    for m in re.finditer(
        r'alter\s+publication\s+([\w"]+)\s+add\s+table\s+([^;]+)', sql, re.I,
    ):
        pub = qual(m.group(1))
        for t in m.group(2).split(','):
            t = qual(t)
            if t:
                objs.append(('publication', f'{pub}|{t}'))

    # create type x as enum (...)
    for m in re.finditer(r'create\s+type\s+([\w".]+)\s+as\s+enum', sql, re.I):
        body, _ = match_paren(sql, m.end())
        if body:
            for v in re.findall(r"'([^']+)'", body):
                objs.append(('enum', f'{qual(m.group(1))}|{v}'))

    # alter type x add value 'v'
    for m in re.finditer(
        r"alter\s+type\s+([\w\".]+)\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'", sql, re.I,
    ):
        objs.append(('enum', f'{qual(m.group(1))}|{m.group(2)}'))

    # Data-rewriting statements need a human decision, so flag them separately.
    for m in re.finditer(r'^\s*(update|delete\s+from)\s+([\w".]+)', sql, re.I | re.M):
        objs.append(('dml', f'{m.group(1).split()[0].lower()}|{qual(m.group(2))}'))
    for m in re.finditer(r'^\s*insert\s+into\s+([\w".]+)', sql, re.I | re.M):
        objs.append(('seed', qual(m.group(1))))

    return objs, raw


def main():
    # With no arguments, scan the whole migrations directory. With arguments,
    # scan only those files, so a single migration can be inspected on its own.
    if len(sys.argv) > 1:
        targets = [(os.path.basename(p), p) for p in sys.argv[1:]]
    else:
        targets = [
            (fn, os.path.join(MIG_DIR, fn))
            for fn in sorted(os.listdir(MIG_DIR))
            if fn.endswith('.sql')
        ]

    rows = []
    for fn, path in targets:
        sql = open(path).read()
        objs, _ = extract(sql)
        seen = set()
        for kind, key in objs:
            if (kind, key) in seen:
                continue
            seen.add((kind, key))
            rows.append(f'{fn}\t{kind}\t{key}')
    sys.stdout.write('\n'.join(rows) + '\n')


if __name__ == '__main__':
    main()
