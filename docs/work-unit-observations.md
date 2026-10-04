# Unit dimension observations

This slice adds normalized dimension observations, immutable fact revisions,
a current pointer and a permission-safe read to the existing
`custom_work_command(uuid,text,jsonb)` unit/link transaction. It adds no second
unit writer, independent verification, QC decision, timing gate or vocabulary.
Data must continue treating these facts as **not QC accepted**. The existing
unit/link branch still updates session attribution; it is not timing-free.

## Request contract

The optional top-level `dimension_observation` in the unit data is:

```ts
{
  width: number; height: number;  // positive, finite, bounded after conversion
  unit: 'in' | 'ft' | 'mm' | 'cm';
  source: 'measured' | 'plans' | 'estimated';
  sourceReference?: string | null; // trimmed, 1–500 characters when supplied
}
```

Unknown keys and wrong JSON types are refused. Inches use exact PostgreSQL
numeric arithmetic: inches unchanged, feet ×12, millimetres ÷25.4, centimetres
÷2.54. Results must be positive and no greater than 100000 inches. Display
rounding is outside this migration.

Whenever the key is present, `expected_fact_revision` must be a nonnegative
safe integral JSON number and match the current fact revision. Numeric strings
and JSON null are refused. The ordinary unit `revision` CAS remains required. Source authorization precedes
the private fact-revision mismatch response.
Old clients without the new key retain their ordinary unit CAS; no stale
fact-version rejection is claimed for versionless legacy requests.

- **Key omitted:** ordinary full-facts legacy save. A change in width, height,
  measurement_source or area_source creates `legacy_observation` when both
  dimensions exist, otherwise `incomplete`. No observer or raw provenance is
  invented. An unchanged tuple leaves the private revision alone.
- **Object:** save the supplied raw observation and derived inches. Mirror
  width_in, height_in and measurement_source into legacy facts; map area_source
  to Measured, From plans or Estimated respectively. Supplied mirror values
  must agree exactly. This is a fresh assertion even when dimensions match.
- **JSON null:** reset, with `dimension_observation_reason` a JSON string of
  3–500 trimmed characters. Remove all four dimension/source mirrors and save
  a `cleared` revision. Keep unrelated valid facts.

Validate the original caller facts before merging, then validate the final
facts with the actual existing `validate_custom_work_facts`. Numeric strings,
zero dimensions and malformed unknown_fields cannot be hidden by an overwrite.
A new object removes only valid width_in/height_in unknown markers. Incomplete
legacy saves remain legal and do not block payroll break or clock-out.

An unchanged-dimensions relink creates a `relink` revision only when a previous
private fact exists. It copies that observation and its origin unchanged.
Moving a never-observed unit does not manufacture historical observations.

## Legacy provenance preservation

The old validator permits arbitrary source text up to 4000 characters, subject
to its 20000-byte entire-facts limit. Preserve both source fields verbatim in
`legacy_measurement_source` and `legacy_area_source`, in the applied intent,
and in the next revision's before snapshot. Do not force those fields into the
new observation source enum.

Only case-insensitive trimmed Measured, Plans/From plans and Estimated map to
known normalized sources. Any supplied unknown label or conflicting recognized
labels leaves normalized source unknown. If either recognized label says
Estimated, estimated remains true even when the other source conflicts. False
is recorded only for a consistently recognized nonestimated source. These
values never confer verification or QC acceptance.

The before/applied JSON bounds are 32768 bytes: sufficient for the legal
20000-byte legacy dimension/source subset, a 4096-byte accepted observation and
bounded reason/context metadata. Observation requests are limited to 4096 bytes
of PostgreSQL JSONB text; stored raw observations have an 8192-byte ceiling for
headroom. A source reference may contain up to 500 characters, including
multibyte text, within the request limit. Normalization trims the reference and
recursive null stripping removes an omitted optional reference before storage.
Neither source strings nor old evidence are
truncated. Other unrelated facts remain in the canonical unit/history.

## Source authority and original identity

Each revision separates the unit's binding at write time (`project_id`,
`opening_id`) from the observation's immutable origin:

- `origin_kind = job`: original project/opening, original unit author and QA
  partition are retained plain values.
- `origin_kind = unassigned`: original unit author UUID and QA partition are
  retained separately from the person who measured. No project/opening.
- `origin_kind = none`: reset or fully empty legacy tuple; no original raw
  evidence to project and no standalone-author restriction to infer.

Fresh assertions establish origin. Pure relinks carry the predecessor's origin
unchanged. Clearing removes current origin; historical revisions and the before
snapshot remain private and immutable. No operational/profile foreign keys or
backfill replace original identities.

Every protected write, including authors and new creators, checks actual
current/destination sources and any prior origin after the canonical unit row
wait. Prior origin is required even when replacing or resetting, since the
before snapshot retains its evidence. The shared `_work_unit_fact_context_visible`
predicate also gates the read:

- A job must pass the real `_ai_job_visible`. QA accounts remain confined to
  sandbox jobs; real supervisor visibility retains its existing semantics.
- A current mapped opening must exist, remain unremoved and match its current
  unit job. A stored origin opening must remain unremoved and its live project
  must independently be visible, even after it moved from the stored job.
- An unassigned source requires its original author or current internal
  owner/supervisor, in the retained test/real partition. Observer identity is
  not author identity. This does not relax the existing sandbox trigger, which
  refuses QA writes with no resolvable sandbox project. A granted foreman cannot acquire standalone provenance
  merely by moving it to a granted job.

After these source checks, the author can edit their own facts. A nonauthor
needs owner/supervisor or current foreman with explicit dimensions_edit grants
on every old/current/destination/original job, including the original opening's
live project. Ordinary nondimensional edits retain their legacy author/lead role rule,
subject to current/destination job and mapping visibility before unit CAS. A
never-observed legacy move remains outside the new private-fact administration
rule. No global foreman grant, scheduled-role inference or grant backfill occurs.

Source/actor checks are fresh after the unit wait. This slice does not serialize
all concurrent role, source or grant changes through a global configuration lock
and makes no universal commit-time authorization claim. No advisory lock is
added after a unit row, which would invert existing crew/AI lock orders.

## Private storage and physical unit lifetime

All three tables have RLS enabled, no policies and no public/anon/authenticated
table grants. All helpers are nonclient-callable. Immutable revisions reuse
`work_capture_immutable_record`; the only foreign keys stay inside the retained
private graph. Unit, command, profile, project and opening UUIDs survive normal
operational deletion without blocking its existing cascade path.

`work_unit_fact_current` advances under the canonical unit lock. Context epochs
record unit binding, opening move/removal and project delete/restore, plus a
separate `unit_incarnation` token. The absent baseline is 0; first relevant
change is 1. INSERT after deletion advances the retained token again. Triggers
use real OLD/NEW rows and take ordinary epoch-row locks; they acquire no new
advisory/global lock or unit/fact lock from a parent opening/project trigger.

Only unit incarnation is consumed now. An absent canonical unit UUID with
retained current/history is refused before creation and rechecked after the
INSERT wait. An operationally restored unit with a changed incarnation cannot
read or amend the old pointer as its new current facts. Retained evidence is
not deleted to allow revision 0. Explicit recovery/reconciliation is required;
this slice supplies no recovery RPC. Ordinary relinks change binding epochs,
not physical incarnation, and continue to work.

Other context epochs are recorded for future verification/QC invalidation,
including away-and-back and deletion/restoration. They do not establish QC
currentness in this slice.

## Canonical receipt seam

`_work_record_unit_fact(command_id, applied_unit_intent, before, unit_id)` runs
once after the actual canonical history and command receipt INSERT. It obtains
auth.uid itself and checks receipt actor, unit/link action, target/result UUID,
and applied dimension/raw-legacy-source tuple against the saved canonical unit.
It writes the revision and advances the pointer in the same transaction; any
failure rolls everything back. No GUC, trigger depth, synthetic UUID or new
public write RPC establishes provenance. Its single explicit private call site
is the transaction boundary; merely possessing an old receipt is not client
permission to invoke it.

For `record_crew_work`, the nested unit command uses the same request UUID. The
helper runs before the outer crew function rewrites the command payload to the
crew envelope. Applied intent therefore remains separate immutable evidence.
Final crew envelope association, whole_complete composition and a forced outer
rollback need the coordinator's actual integration test.

The absent-row path uses INSERT ON CONFLICT(id) DO NOTHING and refuses a lost
create; the existing-row path uses UPDATE after its row lock and CAS. No blind
upsert overwrites another creator. Separate receipt IDs can still contend on
the same unit; actual two-backend tests are required to prove those waits.

## Read contract

`work_unit_fact_current_read(uuid)` requires an active internal login and checks
current source before retrieving private fact identifiers. It then checks unit
incarnation and the independent origin. Failures expose no partial observation
or source identifiers. A permitted unit without private history returns revision
0 and observation null. A cleared assigned unit remains readable by ordinary
visible-job crew, including after a relink; it is not treated as standalone
provenance. Returned raw observation, inches, actor and recordedAt are evidence,
not verification or final QC.

## Verification and remaining gates

The sequential verifier runs the candidate SQL and extracted real helper bodies
in historical order, including the actual sandbox guard. It uses synthetic
profiles/projects only and does not connect to a server. The refusal helper has
a positive self-test so a successful statement cannot count as a refusal.
Focused refusals assert equality of units, revisions, pointers, epochs, history
and command receipts before/after, not just an exception code.

Run with the existing local runtime (no install):

```sh
PGLITE_MODULE=/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js \
/Users/emmatimpson/.nvm/versions/node/v22.23.1/bin/node scripts/verify-work-unit-observations.mjs
```

`WORK_UNIT_SCHEMA_OUT=/absolute/path/schema.sql` exports the exact executed
bootstrap/dependency/candidate DDL, then closes PGlite and exits before fixture
records and regression cases. This supports the separate disposable real
PostgreSQL harness without copying permission implementations. It neither
connects to a real database nor includes synthetic fixture data in the export.

The previous preinserted-row fixture is correctly labeled **existing-row
protection**. It sees that row in SELECT FOR UPDATE and proves neither the
absent-row INSERT-conflict path nor a concurrent create race.

Still required before release: candidate-bound independent review, real
PostgreSQL two-backend waits/CAS/creation/authorization tests, actual-schema
rollback, crew composition/outer rollback, unchanged payroll behavior, purge and
manual-merge integration, full required CI and release approval. The sequential
verifier's latest executed result and exact file hashes are in the shared
UNIT-OBSERVATION-ASTRA-CORRECTION-REPORT.md. No field, production, verification,
QC or active capture guarantee follows from this slice.
