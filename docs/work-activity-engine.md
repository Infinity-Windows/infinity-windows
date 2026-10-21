# Activity engine substrate

This is the private, inactive first implementation step of the Work activity engine. It does not start capture, change Classic timers, intercept payroll, install a dispatcher, or claim that existing writers enforce one personal activity. The owner has authorized the full redesign; the remaining gates are implementation and verification requirements.

Development baseline is unit candidate `f88b94358ed6a6cd43b7932c5cf0bbb7c4777451`. The authoritative unit command is `20261108300000_work_unit_observations.sql`. Its receipt-to-fact seam and every preexisting function/trigger remain unchanged here. Root owns the later rebase onto the actual unit release.

The implementation contract is the shared `ACTIVITY-ENGINE-IMPLEMENTATION-CONTRACT.md`, frozen SHA-256 `dcdb89687480fe18eb7cdc666e2f7df233af914b4076e914891b3ec0ba4570d7`. Reserved substrate is `20261108400000`; complete future cutover is `20261108410000`. G is the source-audited two-key transaction lock `(7712,0)`. Configuration gate `(7710,0)` and the prior 7711 reservation are not repurposed.

## What was built

`20261108400000_work_activity_engine_substrate.sql` adds six private tables, private helpers, guards on those new tables, and `setup` as a permitted kind in the existing private state. Every new table has explicit RLS and revoked PUBLIC/anon/authenticated privileges; every new helper explicitly revokes EXECUTE. There is no public issuer, capture RPC, source backfill, activation flag change or existing timing trigger replacement.

| Table | Stable identity / purpose | Retention and merge classification |
|---|---|---|
| `work_activity_observations` | `id`; server-issued actor/device/revision/shift/current-stream basis with bounded expiry | Immutable retained support evidence; operational UUIDs are plain, not cascading FKs. No pruning API in this slice. |
| `work_activity_streams` | `id`, unique actor/device/generation; exact immutable command head | Retained identity. At most one current active/blocked generation per actor/device; retired generation cannot reactivate. Generic merge requires manual reconciliation. |
| `work_activity_transaction_context` | `id`, actual backend PID and top-level xid8 | Ephemeral only. Deferred constraint rejects COMMIT if any frame remains. Never copied as retained evidence. |
| `work_activity_expected_mutations` | `id`; exact, single-use allowance attached to a frame | Ephemeral only; deleted by frame close after consumption. No cascading operational FK or history. |
| `work_setup_sessions` | `id`; original owner/shift/clock request, private start/end transition IDs | Retained allocation evidence. One open setup per person, one initial segment per owner/clock, one successor per resumed segment. No operational parent FK. |
| `personal_activity_transition_sources` | `id`, unique transition/source/relationship | Immutable retained source UUID/revision/evidence linked to the actual lifecycle subject. No operational source FK. |

Root owns the generic merge registry/manual-reconciliation guards, purge/sandbox/person-census integration and actual-schema checks. These are release obligations; this migration alone does not establish that those surrounding registries are complete. Stable retained rows must not be imported as independent generic inserts. Context/allowance rows must be absent at committed state, not merged or retained as history.

The existing foundation state, command and transition tables remain the authority. The state initializer creates only revision 0 with `integrity_state='review'`; it never guesses an active legacy source or repairs overlaps. No state-advance/coordinator writer is introduced. `setup` satisfies the foundation's same all-or-none active/resume constraints. New capture metadata/answer schemas and complete state transition enforcement remain cutover work.

## Private stream and observation operations

- `_work_activity_gate()` acquires G and requires READ COMMITTED. It is revoked and not an app RPC.
- `_work_activity_actor()` enters G before reading the actual `_work_config_internal` predicate. Retired/revoked/partner/unsupported-role actors are refused. Eligible QA actors can own a private observation; no job/company details are returned here.
- `_work_activity_ensure_state()` creates/locks the caller's private default state only.
- `_work_activity_observe(device_uuid)` issues an immutable basis after G. Expiry is at most issuance +16 hours and, for an observed shift, at most its actual clock-in + `shift_cap_hours()`. The shift must belong to the actor. Expired or inconsistent shift state requires reconciliation; the helper does not repair it. It records the current active/blocked generation and exact command head, plus state revision and last transition.
- `_work_activity_establish_payload(jsonb)` strictly validates and canonicalizes **only** the metadata-only establishment DTO. Unknown fields, SQL/JSON null errors, coercible strings, invalid UUID/timestamps, unsafe/fractional sequence/revision/skew, partial prior identities and oversized input fail. Canonical timestamps are UTC with six fractional digits, independent of session timezone.
- `_work_activity_establish_stream(command_uuid,jsonb)` serializes with G, resolves exact actor/protocol/hash/full-payload replay before expiry/state checks, then compares a fresh basis, expected revision/last transition/shift and exact old generation/head. Success retires the old generation and writes the new stream plus one immutable `noop` command receipt. It creates no activity or transition. Semantic stale/expired/unavailable-basis outcomes have durable conflict/refusal receipts and leave the current stream untouched. Command/sequence identity collision is an error that never overwrites the prior receipt.

The establishment envelope has the contract's exact eleven top-level keys: deviceId, clientGeneration, clientSequence (0), predecessorCommandId (null), expectedRevision, basis, shiftRef, tappedAt, clockCheckedAt, clockSkewMs and intent. Intent is `{kind:'establish_stream', previousGeneration, previousHeadCommandId}`. Both previous fields are null only when there is no prior stream. `shiftRef` is the observed shift or null before clock-in; establishment does not accept a queued-clock reference.

Stream guards independently bind the pointer to the actual immutable command's actor/subject/device/generation/sequence, exact payload identity fields and canonical hash. Receipt `result` is the exact eight-field core: protocolVersion, commandId, status, reasonCode, beforeRevision, afterRevision, transitionId, effectiveAt. Applied heads also require the actual matching transition/profile/revisions/boundary. Result effectiveAt is null or UTC `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Private source detail belongs in separate evidence/projection, not an extra receipt-core field.

A stream advances by exactly one sequence with the previous head as predecessor. Refusal/conflict changes its status to blocked; only explicit fresh exact-head establishment can recover to a new generation. Retired generations retain their receipts. No generic head-advance RPC/helper, work command DTO, request lease admission, queued clock resolution or dispatcher is provided yet; those belong to the complete coordinator. A source-only global lock argument is not two-device test evidence.

## Transaction context

`_work_activity_context_open(route,cause,boundary,parent)` creates a private self frame using actual `auth.uid()`, `pg_backend_pid()` and `pg_current_xact_id()`, after G. A private guard verifies those values and the held gate. It supports one root per transaction, one child per parent and depth at most 16. Identity cannot be updated. The selected boundary must be finite. Parent/child and subject identities are explicit.

This is a low-level **identity** primitive, not a new authorization route. It requires an existing signed-in actor, not new-capture eligibility. That distinction is necessary so an otherwise permitted payroll close is not blocked merely because a person lost new-start eligibility. The future public adapters must retain their exact existing self/admin/crew target authority. This slice's factory and table constraint are self-only; a future multi-person/admin factory and reviewed constraint change must implement those exact authority checks before cutover. No existing app caller can execute any context helper now.

`_work_activity_expect` registers an exact table OID, operation, source/person UUID, column mask and bounded before/after field values. It checks real column names and supported source relations. UPDATE masks require both before and after values for each allowed column. Identity must match the frame. Each snapshot is at most 8192 UTF-8 bytes. `_work_activity_consume` checks those values with **exact per-column JSON equality**, not recursive JSON containment, and rejects unapproved changed columns or second consumption.

Neither helper performs a source write. It is not proof of a real mutation when a trusted test directly passes it JSON. The future legacy adapters must invoke consumption from the actual trusted OLD/NEW path. Only the new private setup source has that concrete trigger integration in this slice. No old table receives a timing trigger.

`_work_activity_context_assert` requires the current actor/backend/top transaction and a leaf frame; GUCs and trigger depth have no authority. `_work_activity_context_close` requires all expected changes consumed and child frames gone, deletes ephemeral allowances, then the frame. A deferred constraint trigger prevents a frame from surviving COMMIT. Savepoint rollback unwinds nested frames/allowances/deferred events automatically. The eventual outer route must acquire G outside any caught subtransaction whose locks must survive.

This solves transaction identity and private expectation mechanics. It does **not** prove complete public first-G entry closure, direct-DML statement-frame pairing, cascade handling, multi-person lock order, callback replacement or partial-success payroll composition. Those remain hard cutover gates.

## Setup and evidence guards

New setup insertion requires eligible internal actor plus an exact actual-row expectation in the current frame. The frame cause/boundary must match the segment. Deferred checks bind initial setup to an existing actor-bound `time_clock_actions` clock-in, the original clock UUID, actual shift clock-in, and the matching private lifecycle transition. A resumed setup requires the same owner/shift/original clock as a prior segment ended for break, and a matching break-end transition. A closed interval is immutable; no delete or reopen path exists.

A valid open setup may close once through an exact private frame. The end transition must have the correct owner. A typed immutable `personal_activity_transition_sources` event under that transition must match the original setup/shift, closure cause and exact `selected_end_at`; the source closes at `greatest(start,selected_end_at)`. A single root clock-in can therefore close an old shift and open the new one with one personal revision while preserving each source boundary. Missing or mismatched child evidence rejects the whole transaction. The exact private frame fixes the selected source boundary before the write; the child evidence cannot choose a different one afterward. It must not require the original operational clock row still to exist, nor current new-start eligibility. Original start evidence remains immutable. This is a private guard property tested with synthetic rows, not an enabled payroll-close route.

`personal_activity_transition_sources` requires a real transition belonging to its stated person. Source UUIDs survive operational deletion. Each before/after evidence object is limited to 8192 UTF-8 bytes. Setup effective events additionally require typed original shift, finite selected boundary and cause. It is supplemental evidence, not an extra payable interval stream.

## Source-driven entry manifest

`scripts/work-activity-engine-manifest.json` is generated by the verifier's `--write-manifest` mode. It records hashes of prior migrations, latest textual function signatures/arguments/security mode/volatility/body hash, advisory/row-lock evidence, conservative called function names, explicit drops and relevant trigger/policy/table/function ACL history. It conservatively follows reverse callers by function name and includes source parents and explicit workflow/crew/AI routes. It removes recognized explicit dropped overloads in source order; current source has six clock-in and two clock-out overloads.

The parser is an evidence collector, not a PL/pgSQL compiler or installed catalog. Conditional/dynamic SQL, unresolved drops, overload resolution, actual ACL/RLS effects, trigger ordering and FKs need a real-schema catalog reconciliation. The manifest is an input to that work, not a statement that every candidate is a callable writer or that the closure is complete. The normal verifier fails if prior source hashes or extracted evidence drift.

## Verification and export

Use the existing runtime; no install is required:

```sh
PGLITE_MODULE=/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js \
/Users/emmatimpson/.nvm/versions/node/v22.23.1/bin/node scripts/verify-work-activity-engine-substrate.mjs
```

`WORK_ACTIVITY_SCHEMA_OUT=/absolute/path/schema.sql` exports the exact schema/bootstrap SQL executed by this verifier, including actual foundation/configuration/unit/substrate migrations and actual extracted dependency helper bodies, then closes before fixture records/cases. It retains the original role DDL. A real-PG harness may make role creation cluster-idempotent only behind its fresh exact-local-database guard. Export is not a full production schema; simplified source table shapes and omitted unrelated routines are documented in the script and require separate actual-schema verification. The fixture uses the actual internal/QA/sandbox helpers, not always-true permission stubs.

The current suite passes 231 checks in the disposable PGlite runtime. A separate fresh PGlite replay of the exported schema confirms zero people, punches, commands or contexts and denied authenticated helper execution. These are sequential local checks, not actual PostgreSQL backend races.

The normal suite checks real private ACL/RLS, unchanged preexisting fixture function OIDs/bodies/triggers/policies, unchanged nonempty legacy payroll/session rows, strict input/replay/rotation/refusal identity, expiry/shift cap, exact context and savepoint behavior, commit closure, actual setup/clock/ledger matching, retained-source deletion and byte bounds. It includes a negative-assertion self-test. No tests create real employee punches or connect to a server.

Independent review, actual PostgreSQL backend races, full installed-schema rollback/ACL/closure, merge/purge registries, full CI, old/current PWA tests and measured payroll latency remain root's gates. The complete engine needs 08410000, the client journal/observation protocol, canonical source adapters and paid setup through the existing clock-in route. Keep capture disabled until that complete cutover and acceptance are ready.

## Client handoff: proposed wire contract and undecided projection

The frozen implementation contract reserves these future public names/signatures; **none is installed by this migration**:

- `work_activity_snapshot(p_device_id uuid)` — own state plus server-issued observation and that device's current stream identity. It is VOLATILE because observation issuance writes private metadata.
- `work_activity_command(p_command_id uuid, p_protocol_version integer, p_payload jsonb)` — protocol 1 capture/establishment command, with actor exclusively `auth.uid()`.
- `work_activity_command_receipt(p_command_id uuid)` — current actor's immutable eight-field receipt core only; absent and foreign IDs are indistinguishable.

There is no separate public stream RPC. `intent.kind='establish_stream'` goes through the command RPC; its private normalizer and executor are implemented here. The eleven-field envelope and establishment intent above are fixed by the executable normalizer. The frozen architecture contract section 6 specifies the later switch/stop/finish_setup intent variants; those variants are not validated or executable here. Preserve command UUID, complete original payload and actor/device/generation/sequence across retries. Local auth generation is a dispatch guard, not `clientGeneration`. Sequence zero establishes; later commands begin at one. Rotation uses the exact observed prior generation/head, not an erased local counter. A refused establishment reserves its attempted sequence-zero identity and requires a newly authored generation/command for another establishment.

The exact **snapshot JSON property names**, projected state/source shape, capability discriminator, unavailable-receipt encoding, and command response wrapper around receipt versus fresh projection remain undecided implementation details. The next coordinator/client joint slice must freeze and test those together before a dispatcher uses them. Do not infer a public DTO from database snake_case rows or return raw normalized payloads/history. The private eight-field receipt core and the establishment payload are already concrete. Existing payroll break/end-break/out keep their existing RPCs and queues; no parallel activity route is reserved for them.

Root reported an unresolved prior-master PWA once-only reload assertion (two navigations, while candidate 742/743 passed). This remains part of full-cutover old/current-client acceptance; this substrate makes no PWA change.
