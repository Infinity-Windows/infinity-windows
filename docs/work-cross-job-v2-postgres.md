# First finite protocol 2 PostgreSQL fixture

This is reviewable fixture source, not an executed PostgreSQL result. The candidate migration remains literal-false and ends in `ROLLBACK`. No provider, app, device, production activation, or paid-wait budget is proved by the source tests.

The fixture checks a limited but useful path: an installer starts one paid shift on job A, assigns work to A and then B, takes a paid-clock break, resumes B, and clocks out without changing the original paid job, start time, or cost code. A separate owner publishes the available activities. General and specific custom work are included; the other four source families remain open.

## Safe default and source checks

From the checkout root:

```sh
python3 scripts/verify-work-cross-job-v2-postgres.py
python3 scripts/verify-work-cross-job-v2-postgres.py --check-plan
python3 -m unittest discover -s scripts -p 'test_work_cross_job_v2_postgres.py' -v
python3 -m py_compile scripts/verify-work-cross-job-v2-postgres.py scripts/test_work_cross_job_v2_postgres.py
```

Default and `--check-plan` read pinned local inputs only. They do not start processes, contact a database, or write runtime evidence. The tests use standard-library mocks and source/AST checks. Their successful result cannot establish that the generated SQL executes successfully.

## Future disposable execution

A separately reviewed workflow must first install the unchanged 0841–0846 prerequisites into a disposable PostgreSQL 17 service. It must leave 0847 absent. Then, and only in that fixture, the explicit executor can run:

```sh
WORK_ACTIVITY_ROLE_TEST_DB_URL='postgresql://supabase_admin:fixture-only@127.0.0.1:5432/forge_work_activity_role_test' \
python3 scripts/verify-work-cross-job-v2-postgres.py --execute-fixture \
  --output "$RUNNER_TEMP/work-cross-job-v2-new/work-cross-job-v2.json"
```

The output directory must not already exist and must be outside the checkout. The accepted target is exactly `localhost` or `127.0.0.1`, explicit port 5432, the named database, and the shown fixture-only administrator credentials. Query parameters, fragments, other hosts, ports, databases, and credentials are refused. No dependency installation is performed by this executor.

The executor first writes a durable partial report, even before source and target validation. It invokes the exact pinned inert-47 script followed by the exact pinned fresh-session-66 script, preserving their original output files and process logs under `predecessors/`. It checks their source identities and exact success fields, including 22 fresh version 1 logins. Supplied JSON files are never accepted as substitutes for these executions. It records the actual server system identifier, postmaster start, database OID, database name, and PostgreSQL version before and after each predecessor. Any identity change refuses continuation. It also requires unchanged database/role settings around each predecessor and the whole authored catalog after each. Settings are compared as sorted database/role/configuration maps, so RESET/SET ordering does not cause a false failure. All rows and values are retained; duplicate roles/databases or configuration keys, unknown fields, and malformed entries are refused.

The read-only instance query uses the fixture administrator where PostgreSQL permissions require it. There is no grant repair or owner normalization. A preinstalled 0847 or mismatched old catalog is refused. Consequently, the new workflow must not run the old 47/66 installation separately before this executor. The existing 47/66 workflow is unchanged.

Inspection/construction calls use 20-second statement and 12-second lock limits, a 35-second psql process limit, and a 3-second connection limit. Actual authenticator logins retain and assert the installed 8-second statement and lock limits. Each predecessor process has a finite 1,200-second budget; durable partial evidence is refreshed before every wait, at most five seconds apart. These are fixture limits, not evidence that a paid action meets an owner latency budget.

## Authored construction boundary

The two new authored catalog JSON files are byte-for-byte copies of the reviewed brief inputs. Source validation permits exactly one catalog difference: the body hash of private `_work_cross_job_enabled()` changes from `select false` to `select true`. Function owner, ACL, security-definer status, search path, all other function bodies, indexes, constraints, triggers, types, and the rest of the catalog must remain exactly equal to the authored input.

The expected active digest is computed by PostgreSQL from the **authored** active JSON through `jsonb::text`. It is never learned from the live catalog. Live catalog values are compared against that authored object before and after construction. In one transaction, fixture construction replaces the one private gate body, verifies the whole authored active catalog, temporarily disables only `work_cross_job_contract_immutable` to enroll that authored expected digest in its proof row, and immediately restores the trigger. Coverage must then pass. Before enrollment, the executor requires no enabled `pg_event_trigger` entries. This is the plain `postgres:17` disposable fixture boundary; it establishes no permission to bypass Supabase event-trigger policies. An unexpected policy fails clearly without disabling it. The authority row is changed through its existing gate for the finite fallback/active scenarios. No coverage stub, extra audit trigger, custom type, cache, index, owner/ACL repair, or parent-body edit is allowed.

Cleanup attempts to restore the authored inert gate, original proof digest, and false capture flag while retaining all synthetic histories. An ambiguous interrupted construction is classified only against the two authored catalogs; an unknown catalog is refused instead of normalized. A primary scenario failure is persisted before cleanup begins. A cleanup failure is recorded separately, retains both errors when both fail, and makes even an otherwise successful run fail. The success flag is set only after restoration succeeds. The original migration file is never rewritten.

## Corrections to the initial brief

The coordinator approved these source-backed corrections to `GENUINE-V2-ACTIVE-FIXTURE-BRIEF-1/BUILD-BRIEF.json`. They supersede its broader statements and are also recorded in the new pinned profile:

1. The executor itself owns both predecessor executions and same-instance verification. External success receipts alone cannot establish a shared database.
2. Review, totals, and contributor version 1 coverage guards are true before the first registered version 2 shift. SQL 0847 intentionally makes all three false once any registered version 2 shift exists. The fixture requires this refusal, exact cross-job coverage, and unchanged guard bodies. It does not claim version 2 report-reader support.
3. A version-refused snapshot may create a private observation before returning an unavailable envelope. The fixture records observation changes separately and requires unchanged paid, source, command, allocation, and receipt business rows. Protocol-mismatched commands still require unchanged measured business rows. `personal_activity_state` remains inside full business-row equality. The fixture requires its actor row to exist from the preceding supported paid operation before each refusal snapshot; it does not hide a state insertion or refresh. A read refusal is not represented as a zero-write claim for every table.

These corrections are the explicit brief-2 requirements; no new brief file or peer approval is implied by this document.

## Finite source-derived cases

Every worker call uses a new authenticator LOGIN, actual `SET ROLE authenticated`, and a JWT-subject GUC (`request.jwt.claim.sub`). This proves the database subject used by `auth.uid()`, not provider verification of a signed JWT. The executor records backend identity and checks the expected identity, timezone, float formatting, and installed timeout before the public call. The owner publishes definitions/menu selections; installers sign the supported toolbox-talk API and capture work. An installer publishing attempt must fail without changing definitions.

The executor distinguishes a requested-version-2 clock fallback while capture is false from literal-private-gate rejection. A fallback request retains its original version and remains unregistered when identically retried after capture is enabled. An original version 1 clock cannot be promoted to version 2 by reusing its ID. Registered version 2 shifts reject version 1 activity commands; unregistered shifts reject version 2 commands.

For both general and specific custom work, it checks a registered original version 2 clock, stream establishment/noop, finish-setup A, switch A, switch B, supported break/return, and clock-out. Original command IDs, predecessor IDs, revisions, physical shift IDs, allocation boundaries, original taps, and source/binding projects are checked against the actual SQL wire contracts. The command reply has three keys; lookup has four and supplies allocation. No invented project/cost fields are added to allocation receipts. The keyed six-argument `start_break` and twelve-argument `clock_out` return full shift rows; keyed five-argument `end_break` returns exactly `{outcome, shift}`, with `outcome = ended` required. Every response preserves the original shift/person/job/cost/start. Break start, return, and clock-out must retain their exact synthetic taps, clear/retain break state correctly, and retain the expected break duration and paid status. PostgreSQL timestamp strings are compared as timezone-aware instants, including microseconds.

Original clock retries use fresh UTC and America/Denver logins and require equality of the complete paid row and all 15 retained receipt fields, including original protocol and microseconds. A changed float-format session must be refused for the original request. Read-only adjacent-microsecond fingerprint sensitivity is included. This first version does **not** corrupt a retained version 2 receipt or disable its immutable trigger; actual corrupted-receipt replay remains open. The unchanged 66 predecessor has its own version 1 corruption controls.

Paid-row equality includes tuple `xmin` and `ctid` around activity commands, plus public action and retained receipt counts. Baseline/final census records total paid/source/allocation/receipt counts. `pg_stat_all_tables.n_tup_upd` is informational because PostgreSQL statistics may lag. No extra audit DDL is introduced, so these measurements do not claim an exact count of SQL UPDATE statements.

The old public paid-clock receipt reader remains version 1 and unavailable for registered version 2 shifts. Successful deliberate identical-original clock retry is tested; automatic client recovery, resend policy, and a version 2 paid receipt reader are not supplied. All taps are synthetic fixture values satisfying the existing trusted-original grammar. They do not resolve the owner's live unverified-clock boundary policy.

## Remaining work and review boundary

An actual PostgreSQL 17 run, independent source review, and a separately reviewed workflow are required before any genuine version 2 success claim. The source-matched inert-47 and fresh-version-1-66 proofs remain different evidence from the new finite version 2 cases. No fixed new runtime check count is promised before executing the exact candidate.

All 42 full kernel acceptance cases and all 20 client cases remain open. Other source families (unit, task, service, phase), version 2 concurrency, volume, active paid-wait latency, combined 0848 catalogs, devices, provider deployment, native durable storage, request/reply transport provenance, UI, service-job versus physical-job policy, and the version 2 paid-clock reader remain outside this first fixture. Global activation stays false. This source checkpoint authorizes no production operation.

## Source assumption review for checkpoint 2

The complete installed keyed clock and signing bodies in 0841 were read, together with the owner unit constructor, observation/state helpers, and the captured schema. A null talk ID is supported: the signing function preserves the synthetic text snapshot and inserts a nullable talk reference. The owner unit request uses revision 0, expected fact revision 0, and a valid positive estimated inch observation on a visible, nonremoved opening. Seed `cost_codes` and `project_openings` columns have captured defaults for omitted required fields; the opening creation guard explicitly permits the fixture connection with no JWT subject. These are privileged disposable seeds, not runtime APIs.

`_clock_pick_time_at` accepts a zero-skew tap older than arrival when the clock check is within 24 hours, the tap is within the 16-hour cap, and it follows the prior punch. The synthetic 4–10-minute-old timeline meets those source conditions; actual returned timestamps still must match or the fixture fails. No live clock-boundary policy is inferred. Exact source ranges, hashes, and limits are frozen in checkpoint 2 `SOURCE-ASSUMPTIONS.md`. Runtime execution and independent closure review remain pending.
