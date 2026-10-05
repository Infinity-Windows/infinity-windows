# Held K6 fresh-session PostgreSQL fixture

This is a proposed next genuine test stage. The script has not been executed against PostgreSQL. Its static/mock tests are not runtime proof. It follows, and never replaces, the unchanged source-role, concurrency, review, totals, contributor and first inactive kernel fixtures.

`verify-work-cross-job-fresh-sessions.py --check-plan` reads pinned local sources and makes no process or database calls. Execution requires the explicit `--execute-fixture` argument, the exact disposable `localhost:5432/forge_work_activity_role_test` boundary, and the successful first kernel report. Existing kernel source `c0eaccc11ca212853a3950bb64d47805990a2b4af824755a04d92b3fdf170c07` and first harness `eb7f48d2c18d62da5d4b44659968c20de9a6ec8f7c2e1deb099a8576cb4a0ab3` remain pinned. The script installs no migration, creates/replaces no function, updates no expected catalog proof and does not enable capture. The proposed workflow addition lives only in the checkpoint output until root review.

## What a successful run would prove

Six cases stamp and retry real keyed setup-version-1 clock RPCs: database TimeZone defaults, authenticator login-role defaults, and explicit connection options, each UTC→America/Denver and the reverse. Every call launches a fresh psql process and authenticator login, then uses the existing SET ROLE authenticated route. Session identity, PID/backend start, effective TimeZone and extra_float_digits are recorded before and after SET ROLE. The source owner remains NOSUPERUSER; the caller remains NOSUPERUSER/NOINHERIT. Authenticated is NOLOGIN, and its deliberately conflicting settings demonstrate that SET ROLE does not apply another role's login defaults. The fixture never represents a superuser call as an application RPC.

Requests contain original microsecond timestamps, non-null coordinates and a Unicode note. The actual paid row is compared using PostgreSQL composite equality, preserving timestamp precision while allowing ordinary session-specific timestamp text. The retained JSON receipt must equal its original wire value exactly. Actual immutable request evidence must contain original setup_version=1 and match the shared fingerprint. The report records the pre-existing authority capture state; it does not change that setting or claim automatic setup activity was enabled.

State comparisons use global counts and exact fixture-actor rows for 22 paid, request, source, activity, history, operation and cross-job tables, plus exact authority and contract rows. They cover every table in the declared snapshot map, not every row in the entire database. No concurrency runs during this stage. The source owner reads private evidence; the runtime caller has no added grants. The six synthetic actors, projects and original paid receipts remain in this disposable database as test evidence. No existing employee or project is selected.

A read-only composite sensitivity check varies all 15 current receipt fields through the actual private helper; it does not insert fabricated receipts. NULL/infinity and adjacent-microsecond controls are separate. One actual synthetic receipt's arrived_at is temporarily moved by one microsecond through the fixture administrator, with immutable trigger states restored before the runtime retry. Both UTC and Denver must refuse with generic42501 while all catalog guards still pass. Exact original arrival time is restored in finally. This deliberately privileged corruption control tests receipt binding; it is not a supported application mutation or a claim that superusers cannot rewrite evidence.

Normal stamp/replay connections require extra_float_digits=1, including inherited role/database values. The unchanged0841 coordinate digest is known to depend on this setting. A dedicated connection option -15 must produce the original generic23514 identity conflict with no measured state change; returning to1 must replay the original untouched receipt. The old digest is neither weakened nor rewritten.

## Explicit holds

K6's global `_work_cross_job_enabled()` is literal false. The version2 clock entry rejects before operation creation, replay and paid mutation. Authority `capture_enabled=false` is a different condition and does not bypass that gate. This fixture therefore proves only actual version2 entry refusal with no measured writes. It cannot create either registered2 or legitimate nonregistered2 paid receipts. Both successful version2 fresh-session routes remain open for a separately authorized active source variant; no guard replacement, fake version2 receipt or catalog repair is allowed here.

All42 full-feature cases remain OPEN. This stage adds no concurrency, volume, paid latency, provider, browser or physical-device claim. The approved K6 migration still ends ROLLBACK and no production authorization follows from a successful fixture.

## Configuration restoration and failure handling

Only TimeZone and extra_float_digits are changed, in the database, authenticator global/database settings, and authenticated global/database settings. A separate fixture administrator snapshots original values and absence, makes transactional configuration changes, and restores those exact entries in finally. Unrelated settings such as source-pinned runtime timeouts are preserved. Restoration compares complete scoped setting maps; a failure is reported and propagated. Environment PG variables are scrubbed; controlled connection options are the only PGOPTIONS. The output must be the unused `work-cross-job-fresh-sessions.json` beside the first kernel report; existing reports and source paths are refused.

Ordinary exceptions and SQL refusal paths restore defaults. An external process kill or runner destruction cannot execute Python finally; the CI PostgreSQL service is disposable and must be destroyed after such an interruption. The script does not attempt a provider fallback or an automatic retry.

## Review and invocation

Run the no-contact controls with `python3 scripts/test_work_cross_job_fresh_sessions.py`. Root should obtain bounded source review, then add the proposed step after the existing inactive kernel stage. Set `WORK_CROSS_JOB_POSTGRES_OUT` to the successful unchanged first report and `WORK_CROSS_JOB_FRESH_SESSIONS_OUT` to a separate artifact file. The first workflow source hash is recorded as provenance rather than a runtime pin so an additive reviewed workflow step does not invalidate the unchanged kernel/harness source checks.
