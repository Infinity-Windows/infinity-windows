#!/usr/bin/env python3
"""Assert the live schema really contains what the migration files declare.

`supabase db push` exiting 0 proves the CLI ran, not that the schema is right.
The 2026-07-29 audit found 26 of 68 declared tables absent from production while
every build was green, so the push needs the same kind of self-check the edge
function deploy got.

DIRECTION MATTERS, AND THIS CHECK IS DELIBERATELY ONE-WAY.

  declared but NOT live  ->  FAILS the deploy. A migration did not apply, so
                             code that expects that table or column is broken
                             in production right now.

  live but NOT declared  ->  REPORTED, never fails. `project_marks` exists in
                             production and no migration file declares it, so a
                             symmetric check would make every merge red forever.
                             A pipeline that is always red is a pipeline nobody
                             reads, and this project has already lost three
                             checks that way. Extra objects are drift worth
                             seeing, not a reason to block a deploy.

Blocking is scoped to TABLES and COLUMNS. Those are unambiguous: nothing in this
repo drops or renames one, so declared-and-absent can only mean "did not apply".
The other kinds — constraints, triggers, functions, policies, indexes — are
written here as drop-then-recreate pairs, and the extractor is a scanner rather
than a parser, so a missing verdict on those is not reliable enough to stop a
deploy. They are reported instead. Reporting something is not the same as
tolerating it: the job summary lists every one.

Migration BOOKKEEPING IS IGNORED ON PURPOSE. `supabase_migrations.schema_migrations`
holds phantom rows on production (docs/db-push-readiness.md), and an earlier
audit certified the wrong database precisely because it trusted recorded history
instead of measuring objects. Nothing here reads a `migration|` row.

Usage:
    scripts/pgq.sh scripts/live_schema.sql > /tmp/live_schema.json
    scripts/schema_verify.py /tmp/live_schema.json

Exit status: 0 when nothing declared is missing, 1 when something is.
Normally invoked through scripts/verify-schema.sh, which takes the snapshot for
you and refuses to guess which project to measure.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import migration_drift  # noqa: E402  (needs HERE on sys.path first)
import migration_objects  # noqa: E402

MIG_DIR = os.path.join(HERE, '..', 'supabase', 'migrations')

# Missing one of these means a migration did not apply and the app is broken.
BLOCKING_KINDS = ('table', 'column')

# Kinds that say nothing about schema shape (seeds, backfills, column defaults)
# — the catalog cannot prove they ran. Same set migration_drift.py skips.
UNVERIFIABLE = migration_drift.UNVERIFIABLE

# Long lists in a job summary get skimmed, not read. Cap them.
MAX_LISTED = 40


def migration_files():
    """Every migration filename, in version order (which is filename order)."""
    return sorted(f for f in os.listdir(MIG_DIR) if f.endswith('.sql'))


def declared_objects(files=None):
    """Map (kind, key) -> filename that last declared it.

    Objects a LATER migration drops are removed. Nothing in the repo does this
    today, but a future `drop table` must not turn the deploy permanently red —
    which is the failure mode this whole module is trying to avoid.
    """
    files = files if files is not None else migration_files()
    declared = {}
    dropped = {}

    for fn in files:
        path = os.path.join(MIG_DIR, fn) if not os.path.isabs(fn) else fn
        with open(path) as fh:
            sql = fh.read()

        objs, _ = migration_objects.extract(sql)
        for kind, key in objs:
            declared[(kind, key)] = fn

        for kind, key in dropped_objects(sql):
            dropped[(kind, key)] = fn

    for (kind, key), drop_fn in dropped.items():
        # Only a drop that comes after the last declaration removes the object.
        if declared.get((kind, key)) is not None and drop_fn >= declared[(kind, key)]:
            del declared[(kind, key)]
        # A dropped table takes its columns with it, so stop expecting those too.
        if kind == 'table':
            for col in [
                k for k in declared
                if k[0] == 'column' and k[1].split('.')[0] == key
                and declared[k] <= drop_fn
            ]:
                del declared[col]

    return declared


def dropped_objects(sql):
    """Objects a migration explicitly drops, in the extractor's vocabulary."""
    sql = migration_objects.strip_noise(sql)
    out = []

    for m in re.finditer(
        r'drop\s+table\s+(?:if\s+exists\s+)?([\w".]+)', sql, re.I,
    ):
        out.append(('table', migration_objects.qual(m.group(1))))

    # A single ALTER TABLE can carry several DROP COLUMN clauses.
    for m in re.finditer(
        r'alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)([^;]*)', sql, re.I,
    ):
        table = migration_objects.qual(m.group(1))
        for c in re.finditer(
            r'drop\s+column\s+(?:if\s+exists\s+)?([\w"]+)', m.group(2), re.I,
        ):
            out.append(('column', '%s.%s' % (table, migration_objects.qual(c.group(1)))))

    return out


def live_keys(paths):
    """The live catalog, reduced to the extractor's vocabulary.

    Reuses migration_drift's loader/normaliser so there is exactly one place
    that understands the snapshot format.
    """
    normalised, _checkdefs = migration_drift.normalise_live(
        migration_drift.load_live(paths),
    )
    # Migration bookkeeping is not schema. See the module docstring.
    return {k for k in normalised if not k.startswith('migration|')}


def split_key(full):
    """'column|windows.id' -> ('column', 'windows.id')."""
    kind, _, key = full.partition('|')
    return kind, key


def compare(declared, live):
    """Directional comparison. Returns (blocking, advisory, extra)."""
    blocking = []
    advisory = []
    for (kind, key), fn in sorted(declared.items(), key=lambda kv: (kv[1], kv[0])):
        if kind in UNVERIFIABLE:
            continue
        full = '%s|%s' % (kind, key)
        if full in live:
            continue
        (blocking if kind in BLOCKING_KINDS else advisory).append((fn, full))

    return blocking, advisory, live_only(declared, live)


def live_only(declared, live):
    """Objects the live database has and no migration declares.

    Scoped to public tables and to columns of tables the repo does declare.
    Reporting every live-only object would mean thousands of rows of Supabase's
    own internals (auth functions, storage policies, extension enums), and a
    report nobody can read is a report nobody reads.
    """
    declared_tables = {key for kind, key in declared if kind == 'table'}
    declared_columns = {key for kind, key in declared if kind == 'column'}

    tables = set()
    columns = set()
    for full in live:
        kind, key = split_key(full)
        if kind == 'table':
            # A dot means another schema (storage.objects, vault views). Only
            # public relations are ours to declare.
            if '.' in key or key in declared_tables:
                continue
            tables.add(key)
        elif kind == 'column':
            table = key.split('.')[0]
            # Columns of an undeclared table are covered by the table entry.
            if table not in declared_tables or key in declared_columns:
                continue
            columns.add(key)

    # Don't list a column whose table is itself being reported.
    columns = {c for c in columns if c.split('.')[0] not in tables}
    return {'tables': sorted(tables), 'columns': sorted(columns)}


def render(blocking, advisory, extra, project):
    """The job summary. Markdown, because it lands in $GITHUB_STEP_SUMMARY."""
    out = []
    ok = not blocking

    if ok:
        out.append('### Schema verified against `%s`' % project)
        out.append('')
        out.append('Every table and column the migration files declare exists.')
    else:
        out.append('### Schema does NOT match the migrations (`%s`)' % project)
        out.append('')
        out.append(
            '%d object(s) the repo declares are missing from the live database. '
            'A migration did not apply, so anything in the app that uses these '
            'is broken right now.' % len(blocking),
        )
        out.append('')
        for fn, full in blocking[:MAX_LISTED]:
            out.append('- `%s` — declared by `%s`' % (full, fn))
        if len(blocking) > MAX_LISTED:
            out.append('- …and %d more' % (len(blocking) - MAX_LISTED))
        out.append('')
        out.append('Fix: **docs/db-push-readiness.md**, then re-run this workflow.')

    if advisory:
        out.append('')
        out.append(
            '#### %d other declared object(s) not found (not blocking)'
            % len(advisory),
        )
        out.append('')
        out.append(
            'Constraints, triggers, functions, policies and indexes are written '
            'as drop-then-recreate pairs here and the extractor is a scanner, '
            'not a parser, so these are reported rather than trusted. Worth a '
            'look; not worth stopping a deploy.',
        )
        out.append('')
        for fn, full in advisory[:MAX_LISTED]:
            out.append('- `%s` — declared by `%s`' % (full, fn))
        if len(advisory) > MAX_LISTED:
            out.append('- …and %d more' % (len(advisory) - MAX_LISTED))

    if extra['tables'] or extra['columns']:
        out.append('')
        out.append('#### In the database but declared by no migration')
        out.append('')
        out.append(
            'These are real drift: the live database has them and the repo '
            'cannot recreate them. Each one needs a migration written for it. '
            'This does NOT fail the deploy — blocking on it would make every '
            'merge red and teach everyone to ignore this job.',
        )
        out.append('')
        for t in extra['tables'][:MAX_LISTED]:
            out.append('- table `%s`' % t)
        for c in extra['columns'][:MAX_LISTED]:
            out.append('- column `%s`' % c)

    return '\n'.join(out) + '\n', ok


def result_line(blocking, advisory, extra):
    """One machine-readable line for scripts/verify-schema.sh to parse."""
    return '::result:: missing=%d advisory=%d live_only_tables=%d live_only_columns=%d tables=%s' % (
        len(blocking),
        len(advisory),
        len(extra['tables']),
        len(extra['columns']),
        ','.join(extra['tables']) or '-',
    )


def main(argv):
    paths = [a for a in argv[1:] if not a.startswith('--')]
    if not paths:
        sys.stderr.write(
            'usage: schema_verify.py <live_schema.json> [more.json ...]\n'
            'Take the snapshot with: scripts/pgq.sh scripts/live_schema.sql\n',
        )
        return 2

    project = os.environ.get('SUPABASE_PROJECT_REF', 'the live database')
    declared = declared_objects()
    live = live_keys(paths)

    if not live:
        # An empty snapshot means the query failed or measured nothing. Calling
        # that "everything is missing" would be as wrong as calling it healthy,
        # and verify-functions.sh already learned this lesson the hard way.
        sys.stderr.write(
            'FAIL: the live schema snapshot is empty, so nothing was compared.\n'
            'This proves nothing either way. Check that scripts/pgq.sh reached '
            'the project and that SUPABASE_PROJECT_REF names the right one.\n',
        )
        return 1

    blocking, advisory, extra = compare(declared, live)
    summary, ok = render(blocking, advisory, extra, project)
    sys.stdout.write(summary)
    sys.stdout.write('\n' + result_line(blocking, advisory, extra) + '\n')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
