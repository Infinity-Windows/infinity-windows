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

Legacy baseline rows preserve current evidence but cannot prove missing pre-install intermediate history. The same existing unknown-origin flag is set when a retained mutation does not match the terminal captured state for that source; a later captured update/delete therefore cannot invent a missing source origin or intervening state. Affected units remain unproven until a separately reviewed reconciliation mechanism exists. Recreated physical UUIDs do not inherit old approval. Exhausted source epochs or unsafe personal state cannot certify acceptance. No trusted Data cohort is fabricated.

Source closure also includes actual live anchored rows. A live source without matching terminal retained material, or a missing live row whose terminal capture is not a tombstone, is unproven even after disabled triggers are restored. Immutable `predecessor_id` edges define append order under the existing G-before-row writer discipline. `recorded_at` may tie or move backward, and XIDs may be allocated before G acquisition, so neither sorts the chain. `tx_order` still retains intermediate transaction order. A valid source has one root, one terminal head and a complete connected chain; missing parents, forks, cycles or multiple heads make review unproven. No mutable pointer, finite counter, unique-parent constraint, foreign key, extra lock or new payroll refusal is added. The indexed generic append keeps working even when topology is uncertain. Captured A → B → A stays proven; captured A → B followed by bypassed A, then captured A → C, stays unproven. Exact source-linked safety matches its source directly; it does not depend on a separately collected participant list. Actual participant keys include session/helper `profile_id` and phase `started_by`, so phase-only workers also participate in current dirty-state and source-less safety checks. Creator/reviewer IDs are not guessed to be work subjects.

Source-less safety and a currently dirty subject state remain conservative across that person’s included units. Backdated arrivals and incomplete intervals make timestamp overlap insufficient to prove that uncertainty belongs elsewhere. This may withhold acceptance on more than one historically touched unit; it is an explicit availability tradeoff, not proof that those units have defects. Exact known source events and ordinary work still preserve unrelated units. Narrowing this requires separately proven reconciliation, not a guessed overlap window.

An exact installed catalog contract attests relevant function bodies/security/ACLs, source/private triggers, columns, RLS/owners and the private live-source view. Drift returns unproven. A privileged administrator can still bypass all capture, erase an inserted row, or change and restore material to the exact latest captured state before any reader or captured mutation observes it. Returning to an older nonterminal captured value is now detected. No current-row query can reconstruct that fully erased history. Before such maintenance the source owner must deliberately replace `_work_unit_review_coverage()` with a private false-returning body and retain the change record; coverage may be restored only after reviewed reconciliation and source re-attestation. There is no automatic DDL-event monitor or new maintenance RPC/latch in this correction. Client/service roles cannot perform that source-owner operation. Re-enabling a trigger or restoring its bytes alone never constitutes reconciliation. The bounded live-hole and unknown-origin checks are implemented; full privileged bypass detection remains a procedural boundary.

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

Production remains gated on exact-revision genuine PG/race results, provider namespace/installed-source evidence, independent actual-Claude review, and integration acceptance. Full history closure currently materializes retained source versions while holding G; selected output size is bounded. The local PGlite volume tiers below are measured, while genuine-role/global-lock timings and production timeout headroom remain separate gates. Do not claim a passed small fixture proves production throughput.

Generic cross-project merge refuses any evidence in the new private tables on either side, including conflicting duplicate IDs and count-only inventory. Account census includes retained actors/observers and original nested identities. Operational deletion cannot cascade away these records.

## Production-volume gate plan

Use the genuine-role PG17 disposable fixture with the production statement/lock timeouts. Measure a clean baseline, then 1,000 and 10,000 unrelated retained closed source rows, and a targeted unit with 100 and 1,000 retained mutations, including former bindings. In each tier record at least 20 exact read/receipt timings and `EXPLAIN (ANALYZE, BUFFERS)` for the source-closure SQL, then observe a real payroll-safety request waiting behind a review read. Assert the unrelated unit's token/acceptance remains unchanged and that hidden prior bindings still refuse; collect failures and maximum lock hold, not just averages. All data must be synthetic and disposable. The PGlite version has executed all three tiers at SQL `c57c35d4…`: p95 read/command/receipt in milliseconds was 12.7/21.4/4.2 at baseline, 21.8/32.1/13.7 at 1,000/100, 215.0/238.8/208.9 at 10,000/1,000. Each operation has 20 samples. The largest tier used temporary buffers; all tiers preserved unrelated token/acceptance and refused hidden former bindings. Unrelated volume is seeded as pairs of synthetic immutable birth/tombstone rows; target mutations use actual source triggers. This is sequential PGlite/SET ROLE evidence, not an actual login or waiting-payroll proof.

Run `WORK_UNIT_REVIEW_VOLUME_OUT=/tmp/review-volume.json node scripts/verify-work-unit-review.mjs` for the source-matched probe. Run `python3 scripts/verify-work-unit-review-volume.py --check-plan` to inspect the genuine plan. The genuine harness runs **after** the review concurrency fixture in that same disposable localhost PG17 database, verifies exact installed source bodies, and measures server-side read/submit/receipt time in separate transactions. It observes actual `start_break` blocking behind an authenticated review holder with G7712 and 7710, then verifies `end_break` and `clock_out`. Controlled holder duration includes test barrier/poll/release overhead and is reported separately from RPC latency. Its bounded 12-second statement/8-second lock settings are fixture limits; production settings are not inferred. EXPLAIN/BUFFERS covers both aggregate scope-function buffer/time use and the actual extracted versions/source-selection CTE with target bindings; the latter exposes the nested closure plan. It does not expand every other internal PL/pgSQL statement. Genuine execution remains pending coordinator CI.

The optimization candidate is source-kind-specific indexed closure over both OLD and NEW anchors plus live rows, replacing full materialization while preserving every historical association. Expression indexes may add ordinary journal index I/O but must not add a review counter, validation or callback to payroll. Keep exact manifest equivalence, source-hole, permission, ABA and six-wait tests while optimizing. Simply changing 7710 to shared mode does not remove the existing exclusive G7712 bottleneck; changing lock semantics without that analysis is not a demonstrated performance fix. Activation requires an agreed latency budget with headroom under the real timeout, measured on representative history.

## Provider default EXECUTE correction

Provider diagnostic run `37219041988` proved that all bodies, owners, columns, triggers, private table ACLs and view metadata matched, but exactly 18 newly created private engine helpers inherited `service_role` EXECUTE. The actual names/roles are preserved in `UNIT-REVIEW-COVERAGE-PROVIDER-ACTUAL-MISMATCHES.json`. Migration 0844 now revokes only those 18 exact signatures from service_role. Frozen 0841/0843 bytes, function bodies, owner access, role memberships and production default privileges are unchanged. Public SECURITY DEFINER entry points still call their helpers as the source owner. No supported frontend/Edge call targets these private helper names.

The focused disposable fixture now explicitly gives new functions the same service-role default EXECUTE before installing 0841. It proves all 18 inherited grants exist before 0844 and all 18 are denied afterward, while source-owner execution remains available. It also tests actual service-role calls to an invoker validator and a definer helper are refused, and retains every prior payroll/lifecycle test. This fixture-local default privilege setup is never part of a migration or provider batch. The ACL correction preserved the strict expected digest; the subsequent predecessor-column/body change regenerates that exact contract explicitly. Unknown drift is not accepted.

For future catalog diagnosis, `WORK_UNIT_REVIEW_CATALOG_OUT` exports schema metadata plus PostgreSQL-canonical category/item/attribute hashes. `WORK_UNIT_REVIEW_DIAGNOSTIC_SQL` executes the metadata-only diagnostic in the disposable fixture, verifies seven matching categories, and verifies a deliberately disabled trigger is isolated as exactly one mismatching attribute. Neither mode connects to a provider or exports operational rows/function bodies.
