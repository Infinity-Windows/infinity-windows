> Checkpoint5 correction: see [work-cross-job-profile.md](work-cross-job-profile.md) for the declared genuine-fixture profile, capability/replay compatibility, sandbox dispositions, lossless catalogs, and current checks. See also [work-cross-job-request-version.md](work-cross-job-request-version.md) for receipt-bound original request identity and bounded legacy readiness. Historical checkpoint counts/profile hashes below remain checkpoint-specific. Capture remains held.

# Held cross-job capture kernel

This is a construction and review checkpoint on base `7016866e35e0b0c8f3a9de5735df4a736559665f`. It is not a completed cross-job rollout. Migration `20261108470000_work_cross_job_capture.sql` ends in `ROLLBACK`, and its private admission function is literal `false`. There is no activation RPC. No provider, operational records, old migrations, app code, CI, commits or branches were changed by this slice.

The worker still has one paid shift. Finishing setup and changing jobs append allocation evidence and change the selected activity; they do not update the paid row, even with identical values. Breaks and clock-out continue through the original paid routes. If a delayed break began before the newly selected activity, the paid break and return succeed while that activity remains stopped and requires a fresh choice.

## Exact source contract and generation

The first migration statements are BEGIN, a fixed deparse search path, and metadata-only namespace/source preflight. Any unexpected function overload/body/owner/security/search path, effective role/table/per-column access, relation/schema/index/trigger/policy/view state refuses before DDL. PostgreSQL 17/18 NOT NULL catalog differences are normalized through semantic column flags. The 212 generated entry wrappers, eight callbacks and 60 direct timing candidates remain enumerated in `work-cross-job-dispatch-inventory.json`; unchanged entry bodies are still frozen by the catalog, and source birth admission is before row expected-mutation exemptions.

The revision2 combined guard includes its own complete body. Its expected digest is a private immutable singleton record with a fixed key and hash shape, seeded from the reviewed assembly constant. All insert/update/delete/truncate operations are refused after seeding. Each public v2 command, snapshot, receipt and start gate, and each old report guard, independently compares the coverage function's exact source and metadata before calling it. No mutable attester can simply replace itself with `select true` and be trusted. The catalog also covers the contract table, constraints, RLS, ACLs and immutable triggers.

Old review/totals/contributor guards are replaced only by this new exact contract, in 0847. They are available with no v2 registrations, and explicitly unavailable once any v2 registration exists. This conservative global fence is a held limitation. The original report files and their expected old contracts are unchanged. New 0848 or any other catalog change needs separately reviewed combined promotion; there is no generic OR or observed-drift acceptance. Fully privileged disabling of guards, rewriting the expected proof and restoring the catalog is outside database self-attestation's trust boundary; external source/provider attestation remains mandatory.

Two source-contract corrections were deliberate: fix the deparse search path (an extension function default was otherwise qualified differently inside a SECURITY DEFINER helper), and include effective access for every individual column in addition to raw ACLs and any-column flags. These are guard strengthening/normalization, not provider metadata normalization.

Revision2 additionally captures public type definitions, enum labels/order, domain constraints, standalone composite columns, sequence ownership/access/options (excluding ordinary next-value state), foreign table/server/wrapper semantics and access, and function leakproof/cost/row-estimate/planner-support metadata. Those are deliberate reviewed changes to the catalog footprint. This local expected catalog is not an installed-provider attestation; unexplained differences must not be normalized into acceptance.

## Frozen wire construction choices

- Protocol 2 uses `work_activity_command(uuid, integer, jsonb)` and the same command/stream/personal-state coordinator. No second command engine exists. Version 1 receipts keep their original shape and values.
- In addition to the original strict envelope, v2 requires `boundaryMode: "trusted_original_tap"` and nullable UUID `expectedAllocationId`. A reference object cannot substitute for that typed UUID field. No untrusted-clock or server-arrival fallback exists.
- An allocation-producing command uses its immutable command UUID as its allocation event UUID in a separate typed table. This lets dependent offline intents freeze exact command and allocation predecessors before delivery. A stop command does not produce an allocation. Original immutable taps/payloads never change during delivery.
- `work_cross_job_snapshot(uuid)` emits protocol 2 plus `state.shift.allocationId` and the allocation-selected job. `work_cross_job_receipt(uuid)` returns the original command receipt with separately typed allocation/boundary links. Current and retained original source visibility is checked before disclosure.
- Setup completion appends the first job allocation, preserving earlier setup. The later tile tap starts General/Specific. A→B handoff closes and starts at one admitted boundary and produces exactly one transition with protocol 2. Half-open intervals follow immutable predecessor edges, including zero-length events.
- The original v1 public snapshot refuses the v2 activity projection. Legacy activity source starts on registered v2 shifts are row-fenced. Physical break/out routes retain their old paid semantics.

The fixture report contains actual source-matched request/reply examples. It is not a client parser implementation.

## Lifecycle and source ownership

General and Specific share one allocation-aware writer for direct and resumed starts. Separate shared typed writing supports unit, task, service and phase; setup uses its existing exact paid-start/resume adapter. The private adapters have functional fixtures. Public legacy unit/task/service/phase start wrappers are still fenced on v2 and need explicit adapters before activation.

The custom/service callbacks distinguish every source binding, preserve legacy behavior, and use same-shift indexes. An unrelated closed service visit must not be invalidated just because a later custom activity breaks. Service inspection precedes the closer in the actual frozen trigger order, so it uses OLD/NEW physical boundaries. Expanded mixed-visit, saturation, scalar-break-edit and volume fixtures remain open.

At clock-out, a still-live source is valid only if its actual/effective start is at or before clock-out. Its end may still be null because the lifecycle closer runs later. Closed sources must end by clock-out. This preserves ordinary and zero-length closures while flagging future-start or late-ending sources. Review expressions return strict booleans, source birth refuses multiple open paid shifts, and failed-save cleanup remains outside the protected inner block so stale resume records cannot reappear through rollback. The held switch is STABLE.

Saving a resume candidate checks its actual effective start before closure and exact closure afterward. Resume independently checks the immutable break transition's before-state, closure identity and absence of a successor, actual paid OLD/NEW break-return history, binding/effective start/allocation head, current gates and authority. A forged nullable cache is not provenance. False resume clears the complete tuple; contained writer failures roll back source, metadata, binding and temporary write context. No new deferred constraint is added to paid commit.

## Run the held checks

Use Node 22 and the already installed PGlite module. No installation is needed.

```sh
source ~/.nvm/nvm.sh
nvm use 22
PGLITE_MODULE=/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-work-cross-job-capture.mjs
PGLITE_MODULE=/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-work-cross-job-v1.mjs
WORK_ACTIVITY_MATCHED_SCHEMA=scripts/fixtures/work-activity-engine-online-schema.sql PGLITE_MODULE=/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-work-cross-job-payroll.mjs
python3 scripts/verify-work-cross-job-inventory.py
python3 scripts/verify-work-cross-job-catalog-delta.py
```

Revision2 passed 204 local functional assertions, 20 strict preflight/postreplacement guard controls, all 182 original contributor/totals regression assertions and all 52 original payroll/setup/helper assertions. All 92 original functional assertion labels are retained. These are distinct fixture sets, not the 42 full design acceptance cases. All 42 full acceptance cases remain open. The catalog delta records all replaced and added functions, full metadata for all 220 generated wrappers/callbacks, the 60 direct timing candidates and relevant trigger definitions/order. It complements the build generator's smaller transformation manifest.

The normal verifier never regenerates expected hashes. The build script deterministically assembles 0847 and its coverage SQL from the frozen source, authored runtime/catalog and reviewed contract constant. `--freeze-preflight` / `--freeze-coverage` only work with an explicit pending marker; any source-contract refresh requires a reviewed reason and new receipt. The fixture's synthetic activation uses a separately computed exact catalog, never a `coverage=true` stub. Only disposable fixture construction temporarily disables the proof-row trigger to substitute that synthetic expected digest; no migration or operational route does so.

PGlite proves sequential disposable SQL behavior only. It cannot establish genuine role/session timing, lock waits, production plans, provider rehearsal, browser durability, PWA compatibility or device behavior. The earlier 3.392s p95 / 3.386s paid wall warning is a contributor artifact, not a cross-job measurement.

## Required next slices

1. Close the public v2 start adapters and remaining domain-negative/mixed-service/phase-effective-interval cases against the same frozen kernel; preserve the G→7710 ordering and root entry ownership.
2. Build the v2 proof ledger, per-job read/export mappings and signed reviewed-amendment route. `amendment` is reserved in the held schema but refused by ordinary self-allocation admission; no signed-correction API exists yet. Do not treat that reserved enum as implemented corrections.
3. Complete semantic dispositions in `work-cross-job-reader-inventory.json`, including raw Classic/edge/export readers, person merges and cached clients. Its 77 files are direct textual candidates, not complete semantic coverage. Root's supplemental audit also identifies indirect job-time/export/ledger/statistics consumers, scheduling memory/repeat seeds and pure helpers. Raw physical-anchor costing, log drafts, audience/recent suggestions and Ask remain unfenced by report guards. Immutable guards prevent a generic rewrite of retained allocation identity; an actual supported merge workflow still needs review.
4. Root-owned client journal/controller/PWA work must exercise frozen dependent intents, identity/logout/quota failures, original receipts, and the paid queue independently. Existing stores/photo blobs remain untouched.
   The current servicing `timeNeedsReview` client predicate also treats physical-shift job A versus service job B as invalid. Backend `review_required=false` does not make that client allocation-aware; root's supplemental map retains it as an explicit version-aware validation blocker.
5. Independent source review, genuine roles/two-session races/volume/paid-writer wait, provider forced rollback and physical device verification are mandatory. Both owner policy decisions (untrusted live boundary and allowable paid latency) remain pending.

The next smallest backend assignment is public start adapter and callback-domain closure. Keep the new proof-ledger/amendment work separately owned, then promote one combined exact guard only after those frozen candidates are reviewed together. Activation remains false throughout.
