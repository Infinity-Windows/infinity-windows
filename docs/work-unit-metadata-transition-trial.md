# Limited metadata transition-selector trial

This is limited fixture code. Latest genuine run `37298452901` at `d208936fc6076df4f6ecf161f4fe5a49e13f82fa` completed the unchanged 92-control main on the same recorded database instance. The populated-unit and empty-key cases each completed six excluded warmup pairs and 20 measured pairs with whole scope/review JSON and text equality. The first old ten-unit warmup then failed with PostgreSQL SQLSTATE 42702: the unqualified `v` in `jsonb_agg(v order by n)` could name either the timed block's `v jsonb` variable or the batch column. The reconstructed query exactly matches the artifact's call-158 SQL hash and server QUERY text. No ten-unit pair or later trial stage completed.

D208's rollback attempt raised BrokenPipe and its disconnect failed. Final identity, census, rollback and temporary-object absence are **not proved** for that run. This remains distinct from run `37292636345` at `743991e12e87f6242614677f0ed6ed7b2ee6ba1b`, which failed collecting response 58 after two excluded warmup pairs and did retain successful rollback/temporary cleanup. The earlier `9624e6ec` failure and scalar-serialization correction are separate retained evidence.

The narrow D208 correction qualifies the batch aggregate columns as `q.v` and `q.n`. It preserves the VALUES tuples, scope calls, ordering, complete SELECT shape, timer boundary and review-after-timing placement. It does not set `plpgsql.variable_conflict`, change the candidate, widen timeouts, reopen a failed session or alter fatal cleanup behavior. Independent review and a new genuine run are still required. Partial timings are not performance acceptance.

The approved prototype body is `9f39e62075a8e002c438c0fd2e80ca7b0a8cb7eca45b221d3f59d1088814c34a`; original scope body is `a3b8d9aa96b41c2a9bc29c0c56a6fcb69028cf5dbe04cb411be0b26552d55800`. Both are independently saved inputs. Validation extracts the original body from pinned d083 SQL, requires exact bytes, and proves that replacing the candidate transition block with the original reproduces every original byte. Expected bodies and catalog digest never come from the database.

## No-contact checks

```sh
python3 scripts/verify-work-unit-metadata-transition-trial.py
python3 scripts/verify-work-unit-metadata-transition-trial.py --check-plan
python3 -m unittest discover -s scripts -p 'test_work_unit_metadata_transition_trial.py' -v
python3 -m py_compile scripts/verify-work-unit-metadata-transition-trial.py scripts/test_work_unit_metadata_transition_trial.py
```

The persistent psql transport uses unaligned text output. Every value read through `Session.json` must therefore be explicitly JSON-valued SQL; decoding remains strict. The pre-installation boolean, fresh actor UUID and temporary-cleanup boolean use `to_jsonb`. Bare PostgreSQL `t`/`f` or unquoted UUID text is refused, not coerced. False cleanup and foreign/empty/null actor values still fail their existing exact assertions. No-contact tests drive the real transport collector/decoder with synthetic raw psql text; they are not database execution evidence.

The child now receives a write-only stdout handle; collection uses a separately opened binary reader with its own byte cursor. A duplicated descriptor would still share the offset and is deliberately not used. The parent never seeks or reads the child's stdout/stderr writer. Raw files remain complete evidence, including failures. UTF-8 decoding waits for an exact complete LF-terminated marker line; duplicate markers, trailing bytes, missing/wrong markers, process errors and invalid UTF-8 refuse without JSON repair. That transport change did not add a response-size cap or change the existing 35-second deadline, server timing boundary, statement/lock settings or query SQL.

No-contact tests use real Python children and inherited file descriptors to force the old overwrite schedule through `Session.query`, collect 2.42MB and split Unicode/marker output, preserve earlier responses, reject malformed frames, retain stderr and release handles on exit/forced termination. These are operating-system transport tests, not PostgreSQL execution, rollback or performance proof. The existing 35 source/control-flow checks remain; 12 focused channel controls are added. The workflow's source/test/doc pins remain root-owned and must be retargeted after actual review.

Seven batch source checks supplement the retained 47 checks. They inspect complete ten- and hundred-unit timed SQL for both variants; verify exact calls, membership arguments, cardinality, order and timer/review placement; preserve the single-unit path; exercise the six-warmup/twenty-pair driver; and refuse missing or reordered unit results while retaining full evidence. Against the unchanged D208 wrapper, only the two new qualification tests failed (four size/variant subcases); after the one-line correction all 54 tests pass. These checks do not execute PostgreSQL or prove cleanup recovery.

Default and check-plan read local pinned source only: no process, database connection, or output mutation. Standard-library tests exercise synthetic transport and control flow. They are not measured PostgreSQL timings or genuine parity cases.

## Future workflow sequencing

The root-owned workflow must first run the unchanged prerequisite fixtures through 0846 and leave 0848 absent. The wrapper then **owns** invocation of the exact existing main harness (`63540e422154972cf0fbf7867c74cd2290eae5013ceaba79f91dde98abb7f294`), which installs and exercises unchanged d083 through its already-authored fixture procedure. Do not run that main stage separately first. No external receipt argument or workflow-created instance bridge is accepted.

Only after independent wrapper/workflow review, the disposable job may execute:

```sh
WORK_ACTIVITY_ROLE_TEST_DB_URL='postgresql://supabase_admin:fixture-only@localhost:5432/forge_work_activity_role_test' \
python3 scripts/verify-work-unit-metadata-transition-trial.py --execute-fixture \
  --output "$RUNNER_TEMP/metadata-transition-trial-new/work-unit-metadata-transition-trial.json"
```

The output directory must be unused, absolute and outside the checkout. The URL must have those exact fixture credentials, explicit port 5432, the named database, localhost or 127.0.0.1, and no query/fragment. The initial partial report is written before source, URL and predecessor validation. The future workflow must always preserve the **whole output directory**, including stdout/stderr, predecessor JSON, per-pair complete results and incomplete reports.

An administrator inspection session records actual PostgreSQL17 system identifier, postmaster start, database OID and database name before and after the owned main process. Restart/replacement refuses. The source-matched main must complete all 92 checks, all nine tiers with 20 finite samples each, and the observed active paid edge. Its completion is not latency-budget acceptance. The unchanged main commits its disposable fixture baseline; the subsequent temporary characterization is rolled back. Main failure and process-cleanup failure are separately retained. The main process has a finite 1,200-second limit with a persisted wait receipt at most five seconds apart.

## Owner and temporary-object boundary

After the predecessor, one new persistent `postgres` LOGIN is used for **all** trial plans, warmups, comparisons and timing. It must be the original function owner, nonsuperuser, with `session_user = current_user = postgres`. No role switch repairs this condition. The actor is the predecessor's actual synthetic owner, supplied through its JWT-subject GUC. This is privileged helper characterization, not authenticated public-RPC or signed-JWT verification.

The controlled transaction takes G `(7712,0)` before A `(7710,0)`, then recaptures actor eligibility and checks exact original scope/members/coverage bodies, owner, SECURITY DEFINER, volatility, ACL, search path and remaining function attributes. OID-valued support metadata is explicitly projected to bigint for JSON type stability. All four coverage guards and the exact authored `metadata_v1` proof digest must match. The original scope remains untouched.

Only a temporary result table and `pg_temp.metadata_scope_transition_probe` are created. The clone is SECURITY INVOKER, has the exact candidate body, and has ordinary/service EXECUTE revoked. There are no new indexes, planner overrides, cached results, public helper replacements, grant repairs, timeout increases or source activation changes. Statement/lock limits are 20/12 seconds; each psql response has a 35-second transport limit. The existing `plan_cache_mode` must be auto and `standard_conforming_strings` on; mismatches refuse rather than normalize. Backend identity and settings are checked before and after the trial.

Cleanup attempts terminal ROLLBACK, deallocates the two named prepared selectors, verifies the clone/result table disappeared, and closes sessions. Primary failures are saved before cleanup; cleanup/disconnect failures are independent and fatal. If psql has already exited on a SQL error, the artifact does not fabricate a confirmed rollback. Complete predecessor evidence and partial trial evidence remain available.

## Exact finite cases

Membership comes from the original helper using exact IDs authored in the unchanged main harness. All actual lists, unit IDs, and compatible-key counts are saved.

| Case ID | Existing input | Timed scope calls per request |
|---|---|---:|
| `supported_populated_unit` | Unit `00000000-0000-4000-8000-000000650030` | 1 |
| `existing_empty_key_unit` | Unit `00000000-0000-4000-8000-000000680000` | 1 |
| `existing_10_light_units` | Units 671000–671009, using the same UUID prefix | 10 |
| `existing_100_light_units` | Units 680000–680099, using the same UUID prefix | 100 |

The first case must have compatible keys and real transition payloads; the second must have no compatible keys and an exact empty transition array. Every timed unit must return its own complete nonnull scope. These are the predecessor's **current final baseline** values. The first unit was created through the predecessor's supported activity path, but its paid shift may now be closed; its label is populated, not currently active. No new sources or payroll requests are seeded.

For each case there are six whole-function warmup requests per variant, excluded from summaries, then 20 pairs alternating old/candidate and candidate/old. The populated branch therefore executes at least six times per variant on the same backend before its measurement series. Empty branch calls do not warm the skipped transition query. Batch expressions execute all listed scope calls and include ordered JSON aggregation in their server duration; no per-unit savings are multiplied into a claimed batch saving.

Full old/candidate scope JSON and its canonical PostgreSQL text must match, as must the complete review JSON/text computed from each scope. Reviews are computed after the scope timer stops. Ordered arrays, manifest contents, tokens, origins and null fields are retained; hashes alone cannot pass. Each returned pair is written before comparison, preserving mismatches. Results must also equal the first result at the same locked baseline. The transaction uses the installed read-committed setting and retained G/A locks; complete repeated equality detects a changed projection. This is not a claim of a repeatable-read MVCC snapshot or an active payroll test.

Reported counts are completed driver requests. Calls per batch follow the authored expression; no independent function/ledger invocation instrumentation is claimed. Successful finite comparison never changes the `fullPG17Review184`, `fullPG17Membership168`, or `all18Categories` false fields.

## Plans and shared costs

The exact old and candidate transition SELECTs are extracted from the pinned bodies, with only the PL/pgSQL assignment removed and `sourceids` replaced by a jsonb parameter. Each is PREPAREd once on the same owner backend. For populated and empty input, the wrapper saves EXPLAIN ANALYZE/BUFFERS/VERBOSE/FORMAT JSON EXECUTE before and after six actual prepared executions, plus custom/generic execution counters. Plans show actual chosen indexes or scans; no plan is asserted in advance. The candidate empty SELECT plan characterizes that SQL shape, although its function branch skips the query.

These prepared plans do **not** reveal the internal PL/pgSQL cached plan. Expanded membership plans likewise characterize its authored SQL with actual inputs rather than claiming access to an internal SQL-function plan. No first-call plan or literal-only selector EXPLAIN substitutes for the prepared phase.

The unchanged shared membership helper is measured whole for 1/10/100 units: six excluded warmups then 20 server samples, expanded authored-body plans and counts for versions, units, roots, mapped openings, windows, service units, summons, crew, custom sessions, visits, selected and grouped CTEs. Each guard also has separate 6/20 server samples, and the existing G gate has one separately labelled probe. No isolated measurements are added or subtracted to claim an RPC breakdown. Raw server samples and transport/collection wall times are different fields. Nothing is compared causally with another runner, older genuine run or PGlite measurement.

## Holds and next boundary

The original 184 ordered-review, 168 ordered-membership and all18-category PGlite drivers have not been ported. Their prior CI results are context only. Full candidate PG17 parity remains mandatory before integration. The finite trial also leaves held: positive mapped-kind coverage, malformed/noncanonical/null identity SQL controls, historical/tombstoned/transferred/shared/duplicate identities, separate +0/+1000/+10000 trial tiers, dense shared/distinct-shift work, internal PL/pgSQL plan observation, public authenticated RPC/payroll52/retention/census/24RI revalidation, active paid-wait acceptance, provider/device and production integration.

Canonical lowercase UUID guards and all six mappings are copied unchanged from the reviewed candidate; `setup` remains excluded from selection and no unsupported helper transition row is invented. Offline classification tests are not genuine PG17 coverage of those cases. The full held list is part of the authored profile and every execution report.

Root owns actual independent source review, the new workflow, enrollment, runtime and subsequent integration decisions. A successful limited trial is a measurement input, not integration or release approval.
