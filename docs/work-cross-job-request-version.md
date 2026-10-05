# Original paid setup request identity — held checkpoint5

The checkpoint4 peer found a real counterexample: an incoming version2 paid clock-in can succeed at arrival with a review reason and intentionally receive no capture registration. Registration therefore cannot answer whether the original request was version2. Checkpoint5 separates these facts without changing the old receipt schema, CHECK, signature, or wire codec.

## Atomic evidence

`work_cross_job_clock_requests` has primary key `client_id`. Its non-null fields are `profile_id`, `shift_id`, `operation_id`, `setup_version` (1 or2), and `receipt_sha256`. The three retained UUID references deliberately have no foreign key or cascade. A profile index supports the read-only person census. No public, anon, authenticated, or service-role table privileges or policies are granted; RLS is enabled.

The AFTER INSERT trigger on the retained clock receipt stamps exactly one version record for an actual clock_in/setup_v1 receipt. It reads the existing claimed clock_in_setup operation. A BEFORE INSERT guard takes G and checks the actual transaction/backend, operation identity, actor/JWT, request UUID, claimed entry, exact requested version, receipt actor/shift/action/protocol/payload digest, and SHA256 of the entire canonical retained receipt row. Failed later capture work rolls back both paid receipt and version stamp. Ordinary retries never insert a receipt and therefore never stamp a version row. No old historical receipt is backfilled.

UPDATE, DELETE, and TRUNCATE are immutable. Helpers are private and source-pinned. Full v2 coverage pins the complete table/columns/index/RLS/ACL/constraints/types/triggers and helper source/metadata. Direct rootless INSERT controls exercise the new admission guard, and binding-mismatch replay controls deliberately retain a valid catalog so an old coverage failure cannot mask the new checks.

The replay guard keeps its original three-argument signature. Only clock-in routes query this ledger. It uses an untyped local record so paid break/return/out do not gain a request-ledger composite-type declaration or query dependency. Incoming version2 versus stored original2 is compared in both directions with the existing23514 `Clock command identity conflicts.` refusal. Older receipts with no version row remain non2, preserving the original0/1 asymmetry. If the retained receipt is absent, bounded keyed lookups distinguish a new unknown key from genuine older raw paid history. Owned old raw keys refuse incoming2 before the legacy keyed return; owned0/1 behavior is preserved. A recorded2 key whose retained receipt was removed remains unavailable rather than being reclassified as historical non2. Version evidence is bound to the exact retained receipt, not the current shift or person state. Unauthorized identities and inconsistent receipt bindings remain generic42501 `Clock receipt unavailable.`.

Shift registration remains only the existing old-reader fence: clock_in/setup_v1 receipts whose exact retained shift is registeredv2 return the existing missing envelope. Unregistered version2 paid fallback receipts remain readable and exact original version2 retries return the original paid result.

## Legacy readiness and paid safety

Legacy capability does not call or hash the full public catalog. It keeps the exact promoted dependency list, including the two new private receipt helpers, and a cheap exact source/metadata pin of its private marker. Its own body is independently pinned by the full v2 catalog. Current registeredv2 readiness keeps the old unavailable/not_ready wire and all three permission flags true.

The receipt stamp and admission helpers contain no catalog or coverage query. They use G already held by the paid root, keyed receipt lookup, operation metadata, and a small receipt fingerprint. This adds an indexed private evidence write for new successful setup requests; it is not a zero-cost or measured-latency claim. Paid safety routes retain their existing behavior. Genuine paid-writer latency/lock measurements remain root gates, and no claim is made from PGlite timings.

Controls replace the full checker with a throwing function and add unrelated public DDL. Fresh legacy capability and successful v1 paid setup/stamping still work, while synthetically enabled v2 command/snapshot/setup admissions fail independently. Declared dependency and marker drift remain strict. Displacing the new ledger relation is also tested against independent v2 refusal and paid break/return/out success.

## Real fallback cases and scope

The fixture uses actual unmodified clock selection and claim paths: registered v2; previous_shift_open arrival fallback; clock_unchecked after an old clock check; tap_after_arrival; and legacy authority capture_enabled=false while the separate v2 entry switch is synthetically enabled. It asserts actual registration disposition, original requested version, actual review reason/used-tap fields, and byte-equivalent replay with unchanged paid, receipt, source, history, and version rows. The isolated historical fixture executes the unchanged original keyed clock function before0841 is installed, so its actual old paid rows never had a retained receipt or version record. It proves historical0/1 replay parity and incoming2 refusal without removing evidence. A separate privileged corruption control removes a retained receipt from an actual recorded2 request and proves generic unavailable, not non2 classification. Read-only census, physical purge retention, and inability to recreate/restamp a purged source are also exercised. A separate test confirms literal v2 disabled still refuses entry; that is not advertised as a paid fallback path.

Fully privileged disable/rewrite/restore remains outside the immutable-table threat boundary. There is no secret signing key or claim of resistance to a database owner rewriting all evidence. External exact source/manifest review remains necessary.

## Required root integration

This is the eighth cross-job private table. Generic merge/export/import and retention census must include `work_cross_job_clock_requests`, exact PK `[client_id]`, and retained `profile_id`/`shift_id`/`operation_id` references. It must not be deduplicated by rewriting profile or shift, cascade-deleted, or silently omitted because the references are deliberately not FKs. `person_record_counts` includes `work_cross_job_clock_requests.profile_id`; that is read-only census, not a merge authorization guard. Root owns the Python registry/CLI/app retention routes; this checkpoint does not certify them or change their files.

The migration still admits only the declared18f1 predecessor, remains literal-false capture and terminalROLLBACK, and has not been installed. Checkpoint4 was held and never deployed, so this is not a backfill or conversion of already-installed v2 receipts. All42 full feature gates remain open. Actual source review, genuinePG17, roles/races/volume/client/provider checks remain separate.

Checkpoint 6 replaces the session-rendered receipt-row hash with the single canonical helper documented in `work-cross-job-receipt-fingerprint.md`. Original request-version classification, ledger schema, actor binding, immutable history and public wire formats remain unchanged.
