# Lesson write-ups and supervisor approval for the Hex-Portal archive

Status: **candidate on branch `codex/ai-learning-review`. Not merged, not deployed, not live-verified.** Hexcore currently has no linked projects, so no real delivery can happen yet. Migration `20261026000000_hex_learning_review.sql`, edge function `hex-portal-review`. Receiver contract: Hexcore `docs/hex-portal/forge-learning-review-contract.md` (version 1), pinned in `scripts/fixtures/hex-learning-contract.json`.

## What a crew member does

Tell Ask what happened on a job or unit (voice or text), or open a saved Hex-Portal case and tap **Write up the lesson**. The card keeps the five headings — Issue, What happened, Impact, Lesson learned, Preventive action — as a checklist with a missing count. Anything not known is marked **Unknown** explicitly; silence is still "missing". Impact may include the author's own estimate of minutes lost and cost; it is labelled self-reported and never touches payroll, clocks or anyone's time.

Ask only prepares the card. It cannot save, send, choose the reviewer, forward or approve — those are taps. A reviewer named by voice is only looked up: one exact match is preselected, several or none means the person chooses from the list.

**Save draft** keeps it on the phone first ("Saved on this phone — not sent") and syncs through the durable queue, bound to the account that wrote it. **Send** is online only and submits exactly the revision and words on screen. If another screen changed it, or a saved change failed, nothing is sent: the card shows the conflict and **Show the latest version**, which sets the author's own failed saves of that write-up aside (their words stay visible to copy) and never touches other queued work.

## Who decides (roles)

| Person | May |
| --- | --- |
| Installer | Write, send to a named foreman/supervisor/owner. Never approves, not even their own. |
| Foreman (and `lead`) | Review a write-up sent to them: ask for changes (note required) or **forward** it to an exact named supervisor/owner. Never final-approves, not even their own. |
| Supervisor (and `admin`), owner (and `big_boss`) | Final approval of the exact displayed revision, when named, or explicitly as recorded oversight. May reassign a stuck write-up with a reason, and withdraw. |

- A current supervisor or owner may name themselves and **explicitly** approve their own displayed revision (explicit final review is still required). Nothing is approved automatically; a save never approves; an approval never carries over to a new revision.
- Every change names the account that tapped (`p_actor`) and the revision on screen; a switched sign-in or stale tab changes nothing, a retried tap returns what already happened.
- Role, login access (`retired_at`, `access_revoked_at`, partner) and job visibility are re-checked at submit, forward, approval, packet read and receipt recording. `profiles.active` (On site / Off today) is not access.
- The named reviewer sees the write-up in **Sent to me for review** and gets one in-app notification per submitted revision (`hex_learning_waiting`); a forward notifies exactly the named supervisor; a retried tap does not repeat it. No chat or push message is sent.

## Evidence and recordings

- The original Hex-Portal case (question, answer, sources) and each Ask field message (original transcript and recording) stay where they were; nothing is copied.
- A write-up keeps **every** contributing field message (`source_request_ids`), first to last. Each must be the author's own and from the same Ask conversation; later messages are appended, none dropped. The approval fingerprint binds this exact list.
- The named reviewer can play exactly those recordings while the write-up is with them; not the rest of the author's conversation. Speakers and supervisors/owners already had access; nothing else widened.

## Delivery: exact receipts only

Approval first becomes **pending delivery**. The approver's tap (or a later **Retry** by the author, a reviewer who handled it, or a current supervisor/owner) calls `hex-portal-review`, which, as that person:

1. reads `hex_portal_review_packet` (exact approval, current caller, current supervisor/owner approver, 64-hex fingerprint);
2. posts `{version,caseId,revision,reviewerId,approvalEventId}` to Hexcore with the existing server transport secret and the caller's own JWT (no stored credential, no background sender);
3. accepts only a response repeating the exact ids, revision and fingerprint with a receipt id and time; HTTP 200 alone is not delivery;
4. re-reads the packet; if anything changed, nothing is recorded as received;
5. records through a service-only function that re-checks, in its own transaction, the live approval, approver and caller.

Screen states: **Approved — not sent yet**; **Approved — waiting for job connection** (`needs_link`: a supervisor/owner must connect the job in Hex-Portal, then Retry); **pilot paused** (Retry later); **did not go through** (Retry); **Received by Hex-Portal for learning review** (receipt id and time; an archive receipt, not published guidance); **Removed in Hexcore** (terminal, no retry, Forge record kept). Without the server secret nothing is sent and the screen says so.

Hexcore reads only supervisor/owner-approved, non-withdrawn, not-removed snapshots through `hex_portal_approved_cases(p_project_id, p_after, p_case_id, p_limit default 31)`: at most 30 per page, the 31st only as lookahead, `nextCursor` the last returned case.

Approval archives a traceable field observation. It is not a verified installation instruction, is never auto-published as guidance, and never overrides manufacturer or safety rules.

## Withdrawal

A current supervisor/owner can **Withdraw from Hex-Portal** with a reason. Locally it is immediate: out of every export and packet, and no path back to approved (a correction is a new case). The removal waits in `hex_learning_withdrawals` until Hexcore returns its exact receipt; the screen distinguishes "withdrawn here — removal not confirmed", "did not go through (Retry removal)" and "Hex-Portal confirmed removal". Any current supervisor/owner can complete a pending removal even if the original withdrawer or approver has left, the pilot is paused or the job was never linked. The withdrawal packet carries the historical withdrawer (`withdrawnBy` from an opaque `withdrawn_actor_id` snapshot, `withdrawnByRole`) and the current `callerId`/`callerRole`.

The withdrawal marker is part of the write-up's history, not extra retention: the case, recordings and transcripts follow the existing rules (kept with the record; a login with them is retired rather than deleted; a deleted job cascades its write-ups, history, deliveries and withdrawals).

## Registrations

`person_record_counts` + `purgeWords.ts` (author, reviewer, decider, withdrawer, event actor, delivery/removal callers), trash cascade note, merge `DEDUP_KEYS`, `attach_sandbox_guards`, outbox op `hex_learning_draft` (+ Stuck writes label), query roots `hexLearningReviews`, `hexLearningReview`, `hexLearningWaiting`, release note `2026-09-23-learning-review` in `INCLUDED_UPDATE_IDS`, `function_secrets.py` + `config.toml` for `hex-portal-review` (reuses `HEX_PORTAL_SITES_TOKEN`). The `/crew` guidance proxy (`hex-portal`) is unchanged.

## Evidence (local, synthetic only)

`scripts/verify-hex-learning-review.mjs` (PGlite, in CI), Vitest `hexReviewBridge`, `hexLearning`, `learningTools`, `LearningReviewForm`, `LearningReviewDetail`, `hexPortalOutbox`, `askRouting`. Phone browser checks are run separately by the parent QA suite. Not done here: deployment, live database, live Hexcore delivery, physical iPhone.
