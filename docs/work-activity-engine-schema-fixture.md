# Activity application schema fixture — release remains held

This fixture reconstructs application database rules from repository source and
checks the resulting PostgreSQL catalog against the installed schema metadata.
It gives the engine tests real tables, foreign keys, row policies, grants and
callbacks. It does not copy employee records or connect to a remote database.

The checked-in SQL is a **disposable test fixture, never a migration**. The
production cutover retains its assembly refusal and full installed graph guard.
The fixture leaves capture disabled; the independent-backend tests enable it
only in their fresh, exact-name localhost test database.

## Evidence and scope

The manifest pins the SQL bytes, every historical migration through 08400000,
reconstruction tools and installed metadata files. Installed shape payload SHA:
`07a8d23ea5c9170f3b24e6e06f3307c2b6b3728c527c5c39df5d88e1309d2b40`.
The installed server was PostgreSQL 17.6. Local reconstruction used the existing
PGlite 0.5.8 runtime, reporting PostgreSQL 18.3. The new independent-backend job
uses PostgreSQL 17 because the installed ACLs include `MAINTAIN`.

Verified matches include 220 ordinary tables and all 2,375 included column
attribute records,
465 CHECK expressions, 661 included defaults/generated expressions, 718
PK/UNIQUE/FK definitions, 519 indexes, five views, 237 row policies, 611 exact
complete application function definitions and their actual owner/security/volatility/config/
effective ACLs, 234 relation authority records, 60 column ACL records, and 194
application triggers with their exact definitions/enabled states. Dropped column
positions and nine sequence configurations are retained. Sequence bounds travel
through JSON as exact decimal strings, avoiding JavaScript integer rounding.
Expression candidates are accepted only after PostgreSQL compiles them and the
catalog deparser hash matches the installed hash. Every source-backed policy is
matched by relation and policy name; identically named policies on another
relation cannot qualify it.

Explicit exclusions remain:

- `knowledge_chunks`, its vector lookup function and three indexes; the local
  bundled runtime has no vector extension. This relation and function are not
  selected timing entry/trigger graph members. No fake vector type is installed.
- Eight expression indexes owned by provider `auth.users`. All included auth
  columns, generated expression, defaults, CHECK, plain keys and grants are
  matched. Provider account-management behavior remains outside the online
  G-first guarantee.
- Other provider schemas/extensions and actual production role memberships and
  attributes. `auth.uid`, `auth.role` and `auth.jwt` are fixture claim readers;
  application permission helpers are actual source bodies. The disposable
  database bootstrap role is a superuser; the installed `postgres` role is not.
  Caller-role/maintenance admission therefore still needs its separate tests.
- The 730-routine complete installed graph guard. The runtime fixture executes
  the exact 221 original-entry body/authority guard, then all authored cutover
  DDL, all 212 replacements and the complete authored trigger assembly. It
  deliberately omits only the larger graph guard because of the stated external
  exclusions. This omission is never applied to the repository migration.

The fixture is not proof that every legacy branch has executed, that the engine
is ready to activate, or that a reduced catalog equals the entire installed DB.

## Reproduce locally without installation

Use the already available Node 22 and PGlite runtime. `PGLITE_MODULE` must resolve
to its existing `dist/index.js`. The reconstruction reads metadata from the
shared output directory; CI consumes the frozen checked-in SQL and manifest.

```sh
python3 scripts/build-work-activity-engine-schema-fixture.py \
  --schema-evidence ../outputs/Forge-Redesign-Implementation-2026-10-03 \
  --output /tmp/work-activity-schema-candidates.json
WORK_ACTIVITY_SCHEMA_CANDIDATES=/tmp/work-activity-schema-candidates.json \
WORK_ACTIVITY_SCHEMA_PARTIAL_OUT=/tmp/work-activity-online-schema.sql \
node scripts/verify-work-activity-engine-schema-fixture.mjs
WORK_ACTIVITY_MATCHED_SCHEMA=scripts/fixtures/work-activity-engine-online-schema.sql \
node scripts/verify-work-activity-engine-schema-runtime.mjs
```

The reconstruction also writes the paired manifest automatically and refuses
any unresolved object beyond the ten named vector/provider exclusions.
The reconstruction imports its exact serialized output into a second fresh
PGlite before writing the export. The runtime has the analogous
`WORK_ACTIVITY_MATCHED_CUTOVER_OUT` export mode; it imports the exact exported
cutover schema into a second fresh PGlite before writing it, before synthetic
post-cutover cases. No export alone is described as runtime/race evidence.

The independent-backend harness retains its strict localhost, port, exact DB
name and fresh-schema guards, sanitized libpq environment, bounded waits,
observed PID/blocking edges and process cleanup. `--source-matched` selects this
fixture; the existing mode remains the smaller development fixture. Synthetic
profile creation in this mode includes actual auth FK rows and required names.
The CI job name explicitly says release held.

## Cancelled-helper correction

The installed `complete_summon_help(uuid)` body from the original summons
migration still completed cancelled helpers: a synthetic cancelled record with
zero minutes became completed with 60 minutes. Later `close_summon` and
`expire_summons` already protected cancellation, but this personal endpoint did
not. The generated cutover deliberately adds `and canceled_at is null` to this
one UPDATE. The original source hash remains guarded; the changed body hash and
manifest identify the correction explicitly.

The source-matched runtime proves the original counterexample, corrected RPC
refusal with unchanged helper/unit/state/transition evidence, and successful
completion of a legitimately active helper with an unchanged full payroll shift
and closure of its own helper unit session. This is sequential local evidence;
independent-backend and actual installed-schema gates remain separate.
