# Genuine PostgreSQL 17 metadata retention fixture

This is a source-ready extension of the complete main metadata fixture. It defaults to a **no-contact plan**. It never installs a migration, changes a catalog guard, enables capture, invokes an Auth provider, or changes operational people or jobs. It can operate only against the explicit local disposable database and fixture credentials.

The script pins metadata source `d083b38b07bb51f9f34d7b6c114fcdfcaf4c16b91a1541b7c51f2f11d5459c44`, main harness `63540e422154972cf0fbf7867c74cd2290eae5013ceaba79f91dde98abb7f294`, and frozen 0841/0844/0845/0846 parents. A source change requires a separately reviewed enrollment. No expected catalog hash is taken from the database.

## Local source checks

```sh
python3 scripts/test_work_unit_metadata_retention_postgres.py
python3 scripts/verify-work-unit-metadata-retention-postgres.py --check-plan
python3 scripts/verify-work-unit-metadata-retention-postgres.py
```

The default and `--check-plan` do not start `psql`. Source drift refuses before database contact. The constructor tests use Python's standard library and mock subprocess entry points for no-contact paths. They validate the test harness, not PostgreSQL behavior.

## Root-owned genuine execution

Only after independent review and the main fixture passes **against the same disposable database**:

```sh
WORK_ACTIVITY_ROLE_TEST_DB_URL='postgresql://supabase_admin:fixture-only@localhost:5432/forge_work_activity_role_test' \
python3 scripts/verify-work-unit-metadata-retention-postgres.py \
  --execute-fixture \
  --predecessor /absolute/path/to/work-unit-metadata-cohorts-postgres.json \
  --out /absolute/path/to/work-unit-metadata-retention-postgres.json
```

The output must be a distinct, nonexistent file. Keep the receipt and main predecessor artifact in an `always()` upload step, including failures. The extension writes its initial partial receipt before validating source pins, predecessor, or URL. It persists before every bounded wait and records partial session transcripts during cleanup. A killed workflow can leave `status: running`; that is incomplete evidence, not acceptance.

The main receipt must be `passed`/`complete`, match the enrolled SQL and main harness hashes, contain all nine volume tiers with twenty real finite samples each, and show the actual active reader/paid-clock edge. It need not claim an approved latency budget. The JSON receipt binds source and completion; the root-owned workflow must enforce that the predecessor and this extension use the same fresh disposable instance. Live source-body, authored contract, self-attester, catalog, and frozen-guard checks independently verify the installed candidate.

## What the extension checks

1. Actual PG17, nonsuperuser `postgres` LOGIN, noninheriting `authenticator` LOGIN, exact source body and self-attester attributes, authored expected catalog hash, and three unchanged frozen guards. The FK/index/RI inventory requires six `ON DELETE RESTRICT` author links, six valid one-column B-tree indexes, and all 24 internal RI trigger semantic records. It checks `service_role`-only census EXECUTE and actual ordinary-role SQLSTATE 42501.
2. Complete legacy census plus exactly six author keys; zero-existing, nonexistent, and null targets; current, revoked, and retired supplied requesters; and the trusted service null-requester path. Legacy `person_record_counts` must match its final authored definition in **0844** exactly.
3. One incoming and one outgoing internal RI trigger are disabled only inside privileged rollback controls. New admission must refuse while all three old guards stay true. All four public metadata entries and the service census refuse. The rollback restores the original catalog without rewriting a guard.
4. Six independent synthetic people each have one sole oldest row in one author-history table and zero values in every legacy key. These are explicitly marked **privileged constraint-isolation seeds**, not runtime command proof. Direct profile deletion and synthetic `auth.users` cascade deletion must emit the exact `metadata_actor_retention` constraint and exact child table. PG17 establishes whether its real RESTRICT SQLSTATE is 23001 or 23503; all twelve cases must then agree. Each failed deletion preserves the exact profile/name, auth identity, and historical row. Retirement preserves name/history while new writes and supplied-requester admission refuse.
5. Real LOGIN races: a supported metadata publish commits before Auth deletion, an empty synthetic Auth deletion commits before a supported propose command, and requester revocation commits before the service census recaptures owner authority. Both connection identities, actual `pg_blocking_pids`, and granted/waiting advisory **G `(7712,0)`** are saved before releasing the winner. Authenticated writers use fresh `authenticator` connections and `SET ROLE authenticated` with the actual actor. The three held transactions prove correctness only.
6. Twenty timed **complete legacy plus supplemental census** calls run at the predecessor fixture baseline. A separate two-attempt protocol observes a genuinely ACTIVE census holding G while a supported `start_break` waits. It uses a fresh synthetic actor, a supported toolbox signature, and a supported clock-in on the predecessor's synthetic project; the actor is in the supported setup state. Supported `end_break` and `clock_out` must also succeed. No sleeping or deliberately idle lock holder can satisfy this performance case. If the actual active edge is too fast to observe, or either attempt exceeds the unchanged **20-second statement / 12-second lock** limits, the fixture fails with preserved partial evidence. There is no retry escalation or relaxed timeout.

The active paid-clock record keeps two distinct caller timers. `paidResponseWallMs` is captured immediately after the paid result is collected, before the later legacy census query. It includes paid process startup, wait observation, and collecting both reader and paid results; it is not isolated server execution or lock duration. `requestWallMs` remains the broader verified census/start_break case upper bound, including the **post-response legacy census validation**; it ends before the later `end_break` and `clock_out` safety calls. Each field carries its timing meaning in the artifact. A failed later validation retains the earlier response timer without claiming that the case passed.

The earlier genuine 83-check receipt and its approximately 1,258.17 ms broad upper bound remain historical evidence for that original measurement. They are not relabeled as paid-response timing, and neither timer accepts a paid-clock latency budget. The simulated delays in the no-contact timing tests validate measurement boundaries only; they are not PostgreSQL measurements.

The extension does not change the capture flag. The main fixture already enables capture only in its disposable database. Synthetic profile operations legitimately increment authority revision; the final comparison checks the activation flag, while the migration file remains terminal `ROLLBACK`.

## Remaining release gates

Even a complete run does not approve paid-clock latency, prove Auth-provider behavior, or certify atomic person removal. The existing edge operation still performs distributed Auth ban/email/profile steps and has no new final post-Auth requester check. The full existing 65-case edge suite, exact peer review, accepted performance budget, and source-coupled database-before-edge deployment remain separate gates. No production activation, deployment, merge, commit, or push is performed by this script.
