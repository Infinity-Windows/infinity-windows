# Held selected-unit contributor read

0846 adds `work_unit_contributors_read(uuid,uuid,integer default 1)` without editing0841–0845. It answers who has recorded labor or named work evidence on one selected unit, at one server timestamp. Three overlapping people working3h,2h,1h produce6manhours. Every person/task amount and the unit denominator comes from the same proven interval set; machine time is a subset.

The migration ends with `ROLLBACK`. It is a held review candidate, not an applied production migration. Promotion requires a separately reviewed non-ROLLBACK artifact and new exact source, provider, compatibility and operational receipts. Capture and deployment are not enabled here.

## Contract and privacy

The v1 request accepts canonical project/unit UUIDs and protocol1; it accepts no person, actor, date, live-tail or permission override. The reply is either `{protocolVersion:1,availability:"unavailable",contributors:null}` or the frozen strict contributor structure recorded in `Unit-Contributions/PROTOCOL-CHECKPOINT.md`. Durations and incarnation are exact canonical decimal strings. The window is all retained selected-unit evidence through `asOf`, not a payroll/date filter.

Named disclosure requires the actual current internal supervisor/owner role, then every current and retained original job/opening/service/fact permission. Installer access to aggregate activity, a foreman's job/final-QC grant, or client preview is insufficient. Service, anon and PUBLIC cannot execute the new endpoint; no client role can execute its private helpers. Only minimal current display name and retirement state accompany original profile UUIDs. Missing names are not replacements for source identity. No wages, gross payroll, break deductions, roster, safety narrative or area/rate is returned.

Positive known labor can be shown while complete attribution is unavailable. Open shifts, unknown source/history, unmapped legacy timers and unlinked named work have fixed reasons; unknown time is never added as zero. A real empty proven unit is complete zero. A validated zero-duration tap goes in `zeroOnly` only when complete and closed, with no live tail, worked count or percentage. An incomplete zero claim becomes a timing-uncertain person. A zero-only audit has unavailable share plus `zero`, even when other people have positive time. Definitive whole shares are available only for complete positive attribution. A person with both named evidence and an unproven timer—including a validated zero tap made incomplete by unlinked named evidence—appears in both evidence lists but is counted once. Pure named work without a timer claim or retained timer remains untimed-only. Unit and person live flags both require positive live microseconds. Legacy helper timer subjects remain uncertain rather than disappearing or attributing time to the requester. Future named timestamps/dates do not assert work beyond asOf; overlong UTF-16 names refuse the whole reply. Unlinked QC participation can therefore make completed-unit labor partial; matching a timer's person/date/task is not a causal link.

Current nonvoid partial/finished crew participants, started phases, nonvoid legacy installers, checked QC and final-review actors are separate named evidence. Crew records moved to another unit no longer display against the old unit, while retained original/current permission closure remains. Phase/install/QC sources with a different current opening do not become current named work through an old mapping; that mapping uncertainty is explicit. A filer/creator/requester is not inferred to have performed work. Retired people/tasks retain historical amounts and stable IDs; versions never collapse by labels.

## Read architecture

Lock order remains READ COMMITTED →G7712→actual actor/real role→7710→fresh actor/role. The server captures one timestamp after admission. No unit/person/shift row lock, new lock class, persistent counter, callback or clock refusal is introduced.

The reader checks frozen0844/0845 coverage plus its own source guard, resolves the canonical unit, calls `_work_unit_review_scope` once and `_work_unit_review_view` once. Null admission from either returns generic unavailable. FinalQC approval does not gate labor.

Distinct related shifts come from current/captured/original source discovery. The focused copied ledger validates each once. Its baseline is frozen0845 `_work_totals_shift`; its intended differences are provenance, zero/negative validation and a request-local proof map. The map deduplicates direct source proof and permission results by source kind/ID, binds them to the actual actor, and exists only inside this G-held invocation. The existing visibility helper still recursively performs some indexed parent proof lookups; no claim of one physical query for every parent is made. The read does not call one unit-scope RPC per person or per task.

The private ledger retains the old internal paid/setup/classified/gap/break reconciliation so positive-source parity can be checked at the same synthetic timestamp. These fields are stripped from the public contract. It does not fabricate a current payroll allocation from an original captured project; reviewed or ambiguous cross-job shifts remain incomplete. No existing payroll body, trigger, source retention or ACL is changed.

New limits fail generically, without truncating names or reweighting amounts:500 candidate shifts;10,000 related transition rows and10,000 related source children; inherited5,000 transitions/5MB per ledger;5MB request proof map and5MB ledger payload;200 distinct people across evidence types;2,000 person/version groups;4,000 named references;1MB public payload. Inherited review scope/history limits still apply before this assembly. Size limits bound admitted relations, not an assertion that PostgreSQL cannot allocate transient memory while evaluating an inherited aggregate.

## Exact source and namespace

The first migration block examines only catalog metadata and refuses any existing public RPC overload or new private-prefix routine/relation before candidate DDL. It never replaces an unknown object. Runtime coverage also detects unknown overloads/private relations.

The new guard covers reused proof and permission helpers, the private/public contributor routines, profile/name columns and G triggers, projects/sandbox and grant dependencies, retained source/named tables, RLS/policies, effective table and column privileges, constraints and the source view. It attests function body, language, kind, result, argument identities/defaults, strictness, parallel property, owner, SECURITY DEFINER, volatility and search path. PostgreSQL17/18 NOT NULL flags are normalized semantically; unknown CHECK/FK/column privilege drift is not ignored or erased. Source and metadata hashes are exported using SQL canonical jsonb hashing, not JavaScript object hashing.

The own coverage body is necessarily outside its own fixed-point hash. Deliberately altered/erased privileged maintenance remains an inherited trust boundary; no read can reconstruct deliberately destroyed history. Normal profile deletion/census, protected source history and source-incarnation validation remain mandatory. This candidate introduces no durable table needing purge/merge registration.

## Verification and execution

Run with Node22 and the existing disposable PGlite runtime:

```sh
node scripts/verify-work-unit-contributors.mjs
PGLITE_MODULE=/tmp/forge-qc-tests/node_modules/@electric-sql/pglite/dist/index.js WORK_ACTIVITY_MATCHED_SCHEMA=scripts/fixtures/work-activity-engine-online-schema.sql node scripts/verify-work-unit-contributors-payroll.mjs
node scripts/verify-work-unit-contributors-volume.mjs
python3 scripts/verify-work-unit-contributors-postgres.py --check-plan
```

The focused verifier pins the frozen old fixture and executes all its assertions unchanged before the new cases. `--build-contributor-coverage` only regenerates0846's exact new guard in the source-matched disposable database. Output environment variables are `WORK_UNIT_CONTRIBUTORS_CATALOG_OUT`, `WORK_UNIT_CONTRIBUTORS_WIRE_OUT`, and `WORK_UNIT_CONTRIBUTORS_VOLUME_OUT`.

The genuine harness requires actual PostgreSQL17, nonsuperuser postgres and noninheriting authenticator logins in the exact disposable localhost database, after the existing0844 and0845 genuine fixtures have installed their held candidates. It records pre-existing history/live/transition census separately; its additional0/1k/10k live/source tiers and0/100/1k target mutations are not mislabeled an empty baseline. Identifiers/menu codes are distinct from predecessor fixtures. Normal triggers remain enabled. Seeds commit in100-row batches; RPC/clock limits stay20s statement/12s lock. Partial evidence persists after each batch/read, including failures.

Planned genuine waits are actual project hiding, caller-role revocation and profile renaming holding G, followed by the new read; then a real active contributor RPC holding G/7710 blocking an actual `start_break`. The payroll attempt is bounded to two observations and never substitutes an idle transaction or sleep. Break/resume/out must succeed. Thirty measured new-endpoint reads produce median/p95/max plus source lookup and full RPC EXPLAIN ANALYZE BUFFERS. Ten samples/tier means reported p95 is the maximum; this is characterization, not a statistically mature production budget.

Source-matched PGlite tests and the saved per-statement replay validate sequential SQL and harness setup. They do not establish genuine login, PostgreSQL17 parity or concurrent waits. Final exact hashes, counts, corpus and limitations are in the shared `Unit-Contributions/BACKEND-HANDOFF.md` and `SOURCE-MANIFEST.json`.

## Remaining release gates

Coordinator-owned actual namespace/provider forced-rollback probe, genuine PostgreSQL role/race/volume run, independent implementation review, client corpus pin and route/privacy/phone acceptance remain required. Production/live throughput approval remains held: inherited global source closure under G dominates large-scope latency. Wider same-cohort aggregation, explicit cross-job payroll lineage/reconciliation, legacy reconciliation and fully erased privileged-maintenance recovery are separate full-goal work; this one-unit labor read does not close them.
