# Forge AI daily logs and job photos

Authorized September 23, 2026. Built on branch `codex/ai-daily-logs`
(4943076) and wired into Ask by Release 2 of the crew redesign (K2.7): the
migration is `20261030000000_ai_daily_log_contributions.sql`, the Ask page
opens the card from "Build today's daily log" (typed, spoken or the Daily log
card), and `docs/ai-daily-logs-integration.md` records the contract that was
applied. Verify deployment before describing it as live.

## What it does

An installer or foreman says "Build today's daily log" (or taps that preset).
A card shows the job and date prominently and collects work completed
(required), units/stages, people, problems or delays and notes; day flow,
weather and the four reflections stay one tap away. One voice message can
answer several fields. "I don't know" is stored as unknown; a field never
answered stays missing. Known context (unit records, job clock) is offered
with its source and used only if tapped.

Photos can be taken or picked on the card. Each shows its thumbnail and the
job it goes to — fixed when attached. A later job named in chat is offered,
never chosen, and never moves a photo; a photo on a different job than the log
blocks Save until the person moves or removes it.

Save shows the existing shared log and the exact text to be added. The receipt
is the server's: who saved it, when, whether it started the day's log, and a
link to the job's Logs tab. Photos then upload through the normal queue, and
each reports its own state (waiting on this phone, uploading, waiting for
signal, saved, did not upload + Try again). A saved log never implies a photo
arrived.

## Rules that protect other people's words

- `file_daily_log` (manual editor) still replaces the shared row; it is
  unchanged. AI drafts use `append_daily_log_contribution` (20261030000000),
  the only writer of `daily_log_contributions`.
- `daily_logs.revision` counts changes to what the log says. The phone sends
  the revision it showed; any other is `stale` and **nothing is written**.
- The contribution id is minted when the draft starts. Resending the same words
  (double tap, lost response, reload mid-save) returns the saved receipt; other
  words under a used id are refused. The phone freezes the sent payload and
  resends it unchanged until the server answers.
- Additions are appended under an "Added by <name> with Forge AI:" header;
  `filed_by` keeps the first author; day flow, weather and reflections fill only
  empty values.
- Caller: internal crew role, not partner, not retired, access not removed; a
  test login only reaches the sandbox job (`_ai_job_visible`).
- The request names the account that pressed Save (`p_actor`); anything but
  `auth.uid()` is refused before anything is read. The phone also checks the
  account on screen and the auth session immediately before sending, and
  before each photo hand-off, so a sign-in change never sends one person's
  words or photos as another's.
- Evidence: every Ask message whose answers went into the entry is kept, in
  order, as `source_request_ids` — each must be the actor's own
  `ai_field_requests` row, all from one conversation.
- Answers are validated null-safely: a missing status, a captured answer with no
  words, or a non-object is refused.
- Photos link by their upload id (`attachments.client_id`); a link counts only
  for a row on the same job uploaded by the same account, and a photo can
  belong to one entry.

## On the phone

- Typed words are kept exactly as typed and trimmed only when sent.
- A body over 8,000 characters is shown whole with a "too long" problem; it is
  never cut.
- The work date is editable (today or earlier); changing it re-reads that
  day's shared log.
- A photo goes to the job that was showing when it was picked, even if the job
  changes while it is being stamped; Save waits until every picked photo is
  kept or refused.
- Every change is applied to the draft as it is when it lands, and writes to
  the phone are ordered; a failed write is shown, never hidden.
- "Start another entry" is refused while a saved entry's photos have not
  reached the upload queue, except through a clearly labelled discard.
- The upload queue's stable-id path is atomic and only reuses an entry for the
  same account, job and file; anything else is refused.

## Model boundary

The model gets one tool, `record_daily_log_answers`, whose schema has no job,
date, photo, destination, save or confirmation field. Photo captions are never
sent to it (only a photo count). No image content is sent; vision is not used.

## Evidence (local, synthetic only)

- `PGLITE_MODULE=… node scripts/verify-ai-daily-logs.mjs` — 121 checks: roles,
  partner/revoked/retired/unknown/anon, sandbox fence, validation (including
  absent status/value), actor mismatch, source-request ownership/conversation,
  append/never replace, idempotent replay after the log moved on, stale refusal,
  manual-edit revision, unknown vs missing, direct-write denial, photo linking.
- `scripts/test-ai-daily-logs-postgres.sh` — disposable PostgreSQL 16, nine
  concurrent sessions: four same-id saves → one entry and three replayed
  receipts; four people on one empty job-day → one saved, three stale; one
  session sending another account's draft → refused, nothing written.
- Vitest: `lib/aiDailyLogs/*.test.ts(x)`, `lib/offline/stableUploadId.test.ts`,
  `components/aiDailyLogs/AiDailyLogCard.test.tsx`.
- Playwright at 390×844 (`e2e/ai-daily-logs.spec.ts`, harness page, network
  replayed, real IndexedDB and fixture auth session): key-by-key typing with a
  line break, lost response retried once, stalled second photo, Save waiting on
  photo preparation, stale append, ambiguous job, chat/caption cannot move a
  photo, account switch and reload, date change, a session switched under the
  screen, Spanish.
- Not done: live database, deployment, physical iPhone/carrier network, real
  Ask model calls, the Ask page wiring itself.
