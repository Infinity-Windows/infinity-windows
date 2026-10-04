# Private unit review candidate

This held candidate lets a second authorized person corroborate a unit's original dimensions and lets an authorized reviewer submit, reject, or approve its installation work. An installer can claim a correction; only the final reviewer marks the correction verified. An authorized foreman may approve their own work, but cannot independently corroborate their own dimension observation.

The original observation stays unchanged, including its estimated/measured/plans source and observer. Review is a private ledger, separate from timekeeping. A recorded pass is accepted only while its complete unit-specific work basis remains current and proven. A subsequent work or binding change makes that pass historical without deleting it. Dimension corroboration has its own currentness rule.

## Boundary and ownership

`20261108440000_work_unit_review.sql` deliberately ends with `ROLLBACK`. It requires the exact prior `_work_activity_row_event()` and account census bodies. Frozen 0841/0843 files are unchanged. No release, activation, production test records, payroll policy changes, or migration-history repair are included.

Public RPCs are `work_unit_review_read(uuid)`, `work_unit_review_command(uuid,integer,jsonb)`, and `work_unit_review_command_receipt(uuid)`. The shared activation contract specifies their exact protocol. Only authenticated callers can execute them; all seven new tables and all private helpers deny ordinary client/service raw access. Reads and commands enforce READ COMMITTED, G7712, a fresh actual actor, 7710, and then the command/unit CAS sequence. Full current and original source visibility precedes material disclosure. Hidden/missing sources share an unavailable projection.

Exact dimension strings use SQL `numeric`, positive 1–100 character decimal grammar, canonical trailing/leading zero normalization, and rational cross-multiplication: inch 1, foot 12, mm 5/127, cm 50/127. Display rounding and JavaScript numbers never decide equality.

## Lifecycle evidence

The additive generic engine journal retains every meaningful OLD/NEW mutation, including null-starter phases and intermediate changes that the old personal transition aggregation collapsed. It has no operational FK, bounded payload check, review counter, or review callback. It retains the root operation UUID and actual transition IDs even after ephemeral operation cleanup. An unbounded numeric transaction-local order distinguishes intermediate events; UUIDs provide immutable event identities.

The original personal-event projection is preserved after the generic append. Payroll does not call a review helper, allocate a review revision, lock review 7710, serialize a review manifest, or inspect a review pointer. The extra durable write still has normal database resource-failure risk; it cannot truthfully promise zero additional I/O failure probability.

| Source family | Evidence used |
| --- | --- |
| Custom unit / fact / capture metadata | Physical incarnation, current and original bindings, immutable observation/fact, captured original context, completion changes |
| Opening | Assignment, project/removal, status, confirmation, work start/end and flashing requirement; cosmetic labels/pins excluded |
| Custom / unit / mapped task sessions | Exact source identities and all retained interval/binding changes |
| Phase progress | Active/paused/submitted state and every intermediate mutation, including no starter |
| Service | Actual unit/opening/window-assignment bridge, current/original visit and project, work/outcome evidence and service-specific permission |
| Summon/helper | Actual summon-to-opening association, original/current bindings, participation intervals |
| Redo / legacy QC / install | Reopen/callback/resolution and installation/void evidence; legacy pass does not create private acceptance |
| Crew work and participants | Actual unit report, stage/outcome/completion, participants and voids |
| Normal and safety transitions | Exact source children with archived transition-ID correlation; missing/collapsed pre-journal provenance is unproven |
| Shift | Current included-interval validity and retained adverse status/binding/interval changes; unrelated later activity or breaks on the same shift do not advance the unit token |

The full SQL manifest—not a global authority counter—is compared with the submitted manifest. Immutable opening event identities close status ABA without adding a finite review counter to payroll. Permissions and sensitive original contexts are rechecked now. Active claims, incomplete phases, relevant resume intent, unresolved redo/callback and review-required source state prevent acceptance.

Legacy baseline rows preserve current evidence but cannot prove missing pre-install intermediate history. Affected units remain unproven until a separately reviewed reconciliation mechanism exists. Recreated physical UUIDs do not inherit old approval. Exhausted source epochs or unsafe personal state cannot certify acceptance. No trusted Data cohort is fabricated.

An exact installed catalog contract attests relevant function bodies/security/ACLs, source/private triggers, columns, RLS/owners and the private live-source view. Drift returns unproven. An administrator bypassing capture must explicitly invalidate this contract before maintenance; restoring an unchanged trigger does not reconstruct the missing events. Reconciliation/maintenance tooling is not delivered here.

## Verification and outstanding gates

Run on Node 22:

```sh
node scripts/verify-work-unit-review.mjs
PGLITE_MODULE=/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js WORK_ACTIVITY_MATCHED_SCHEMA=scripts/fixtures/work-activity-engine-online-schema.sql node scripts/verify-work-unit-review-payroll.mjs
python3 -m unittest scripts/test_supabase_merge.py -q
python3 scripts/verify-work-unit-review-concurrency.py --check-plan
```

The focused fixture can export actual wire results with `WORK_UNIT_REVIEW_WIRE_OUT`. `--build-coverage` regenerates the exact catalog attestation and must be followed by review and a normal source-matched rerun; it is not an installation shortcut.

The concurrency fixture runs only after the existing engine genuine-role bootstrap, against its exact disposable localhost PG17 database and actual `postgres NOSUPERUSER` / `authenticator NOINHERIT` logins. It requires six observed `pg_blocking_pids` edges, not simulated role switching. Local PGlite and `--check-plan` are not genuine-role/race evidence. Provider metadata probes are a separate read-only fragment for the coordinator's forced-rollback assembly.

Production remains gated on exact-revision genuine PG/race results, provider namespace/installed-source evidence, independent actual-Claude review, and integration acceptance. Full history closure currently materializes retained source versions while holding G; selected output size is bounded, but production-volume query latency is not yet benchmarked. Measure representative history under the real statement timeout and optimize indexed closure before enabling this read on large histories. Do not claim a passed small fixture proves production throughput.

Generic cross-project merge refuses any evidence in the new private tables on either side, including conflicting duplicate IDs and count-only inventory. Account census includes retained actors/observers and original nested identities. Operational deletion cannot cascade away these records.
