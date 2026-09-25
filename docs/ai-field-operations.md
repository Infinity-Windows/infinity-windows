# Forge AI field operations (first installer loop)

Owner decisions D08–D28 (September 22, 2026); planning pack
`outputs/Forge-Vision-Planning-2026-09-22/`. Shipped in PR #628. Release 2
of the crew redesign ("the AI", `.scratch/crew-redesign/crew-redesign-spec.md`
K2.1–K2.7, owner-approved 2026-09-23) builds on it — see "Release 2" below.

## What it does

In Ask, by typing or with the microphone, a crew member can:

| Journey | How | Server |
| --- | --- | --- |
| Find a job, list its units, see who is responsible and who is working now | `get_field_context` | `ai_field_context` (names only; lists capped at 300 with whole-job counts; in-job search by unit number/name or map code, exact first) |
| Guided setup with a visible checklist (captured / said unknown / still needed / not needed) | `record_setup_answers` | draft saved per conversation (`ai_field_save_draft`, `ai_field_draft`), survives >8 messages and reload |
| Create a new job from name + location | `create_field_job` | similar jobs ⇒ choice card; usable at once, born Not ready; supervisors (else all supervisors, else owners — by login access, not On site) mentioned in the job chat |
| Create a unit or add details | `save_field_unit` | reuses same-numbered unit or map unit; map units start from the window type (frame size) — a schedule "call size" is shown, never seeded; spoken/plan or spoken/saved differences are choice cards; non-authors' changes go to review |
| Start own unit timer / idle time | `start_unit_work`, `start_idle_time` | through `custom_work_command`; see "Clock rules" |
| Stop own timer (stage outcome only) | `stop_my_work` | never approves QC, never stops helpers or the job clock |
| Release own claim | `release_unit_claim` | map-linked units: `project_openings.assigned_to` is the one owner |
| Foreman: retrospective crew record | `record_crew_work` | existing `record_crew_work`; no payroll rows, no timers; Off-today people eligible |

Voice: the original recording is saved privately (`ai-field-memos/<uid>/<request>/memo.<ext>`,
readable by the speaker and supervisors/owners, immutable), transcribed by the
existing `transcribe-description`, and stored with the transcript, captured
answers and send time on `ai_field_requests`.

## What it deliberately does NOT do (use the manual screens)

- Clock in, clock out, start a break, switch jobs — the job clock keeps its
  safety questions (toolbox, injury, hours). Cards link to it ("Open job clock").
- Approve QC or mark a whole unit complete — Unit details / QC review.
- Standalone claims or handoffs, reassigning someone else's map unit (foreman
  dispatch does that), time-off, warehouse, service, reports beyond existing Ask.
- Anything for another person's clock. Naming helpers never clocks them in.

"Whole-app operation for every role" is the owner's destination, not this release.

## Clock rules (the parts that protect payroll)

- The model can never confirm. Choices are cards the person taps
  (`ai_field_resolve`, sealed by `preview_hash`); the tool schemas have no
  confirmation field.
- Every timing change is refused (`stale`, nothing changed) when: the request is
  over five minutes old; the phone reported a queued clock/timer change
  (`clock_pending_sync` — queued breaks/clock-outs on real shift ids and queued
  custom-work starts/stops are read from the phone's durable queues); or the
  person's clock **version** differs from the one the phone read before Send
  (`ai_field_clock_version`). The version counts every change to the job clock,
  custom, map, task and flashing timers, including changed-and-changed-back.
- Start time = the phone's Send moment only when the unchanged open shift and the
  last change are both ordered before it; otherwise a "Start now" card.
  Break resume, job switch and late taps start at the tap. Nothing is backdated
  or silently restamped.
- Timing taps (Start now, Join as helper, End break and start) re-read the
  phone's queues at the moment of the tap and refuse while anything is pending.
- Repeated starts return the running timer; retries return saved receipts.

## Accounts and phones

- A field message carries the account it was captured under (`actor_id`);
  `ask` refuses it (403) unless that is the verified caller, before anything is saved.
- The Ask page re-checks the signed-in account before every upload,
  transcription and Ask call. A switch mid-way stops the message; it stays
  unsent on the phone for its speaker. Late replies never land in another
  person's screen.
- Voice uploads have a two-minute deadline through response-body completion. A stalled upload leaves the original available to retry under the same request and path.
- Unsent messages are kept in IndexedDB (`forge-ai-field`) per account, saved
  only when the transaction commits. If the phone cannot keep a recording, it
  stays on screen with Send now / Download until a request holds it.

## Off today is not access removed (authorization fix beyond AI)

`custom_work_internal()` used to require `profiles.active`, which is the Crew
page's On site / Off today switch; `restore_access` does not set it. Off-today
foremen could not file yesterday's crew records and off-today installers lost
Custom Data. It now checks `retired_at` / `access_revoked_at` (plus the existing
partner and role checks). `record_crew_work` people and the crew-record picker
use the same rule. Removed, retired and partner logins stay denied.

## AI spend floor

`20261024010000_installer_ai_floor.sql` sets `ai_spend_limits.min_role` to
`installer` **only if it is still the default `foreman`**. Caps, multiplier,
alert threshold, `enforced` and time zone are untouched. The live value was not
readable from here (management token expired); check it after deploy.

## Retention

- Requests, receipts and referenced recordings are kept with the record. A login
  with any of them is retired rather than deleted (`person_record_counts`).
  The already-approved company-wide three-month purge remains pending separate implementation. This release does not delete company payroll/history.
- Recordings no request refers to (never sent) are removed after **90 days** by
  the nightly GitHub workflow `ai-field-memo-sweep.yml`, using the existing
  `SUPABASE_SERVICE_ROLE_KEY` secret: `ai_field_claim_orphan_memos` marks each
  under the same lock a request attaches it with, the Storage API deletes the
  bytes, `ai_field_finish_memo_cleanup` clears markers only when the object is
  gone and keeps failures for retry. After cleanup the phone's own copy can be
  uploaded again to the same path. Reinsertion waits until its cleanup marker is cleared. Each network call has a 30-second deadline and the workflow stops after 10 minutes, well before its one-hour lease.

## Registrations

Purge probes (`purgeWords.ts`), trash cascade, merge `DEDUP_KEYS` (171 tables),
sandbox fence (`attach_sandbox_guards` in the same migration), release notes
(`20261024020000`, EN/ES, three audiences), query roots (`FIELD_QUERY_ROOTS`
invalidated after receipts; no new roots).

## Evidence (local, synthetic only)

- `node scripts/verify-ai-field-operations.mjs --pglite=…` — real migrations over
  platform stubs in PGlite (reviewer also ran it on PostgreSQL 16).
- Vitest: `fieldTools`, `fieldExecutor`, `fieldAsk`, `memoSweep`, `FieldCards`,
  `UnitEditor`, `askRouting`, `crewEligible`.
- Reviewer: live synthetic OpenAI strict-tool smoke (no DB writes) and
  fixture-only Chromium phone tests.
- Not done by this branch: deployment, live database, physical iPhone, installer
  live login (banned test login), push delivery of chat mentions. The existing test-account storage boundary also blocks private user-prefixed audio uploads, so the test foreman smoke covers text operations; it does not broaden storage permissions.

## Post-deploy sandbox smoke (root runs it; do not run against real accounts)

`scripts/smoke-ai-field-sandbox.mjs` with the authorised test foreman and the
automation sandbox job id. It refuses to run unless the login is a test profile
and the job is the sandbox; the default saves only synthetic AI request/receipt audit rows, with no business, unit, timer or payroll changes (`--write` adds unit
AI-SMOKE-1; `--no-ask` skips the one paid Ask call). It checks the read
contract, that a test login cannot create a job, that a question changes
nothing, and that a message naming another account is refused.

## Known gaps

- Independent PostgreSQL 16 tests use separate concurrent connections for competing unit claims, competing starts by one person, duplicate job creation, competing cleanup leases, and request attachment versus cleanup. Platform auth/storage are fixture stubs; these are not live production races.
- Chat mentions are saved; whether a push reaches a supervisor's phone depends
  on the existing chat notification path and was not verified.
- Offline: field requests need a connection. Messages are kept and never start
  timers late; the older clock outbox has no per-account binding (unchanged).
- The Ask page's account/voice orchestration is covered by pure-function tests
  and the reviewer's browser spec, not by an in-repo browser test.

## Release 2 — the AI (crew redesign K2.1–K2.7)

**One list (K2.1).** `supabase/functions/_shared/askCapabilities.ts` is the
capability registry: each action's roles, questions, what it changes, its
receipt kind, its model tools, and whether it is live. The Ask function
derives its tool list from it (`askToolNames` → `toolDefsFor`; a tool no
capability claims never reaches the model — `askCapabilities.test.ts` pins
both directions) and tells the model the same list the person's cards show,
including what is NOT in Ask yet and which screen to use, who may use an
action above their role, and the boundary. PERMISSION MIRROR is unchanged:
tools are offered, executors refuse below rank.

**Action cards (K2.2).** Four per role plus "All actions", from the registry
(`components/ask/ActionCards.tsx`): installer Build a unit · Daily log · My
hours; foreman Build a unit · Daily log; supervisor/owner Plan the schedule ·
Job summary · Hours report. Take supplies (Release 4), Crew status and Units
completed (Release 3) are absent from the cards and listed under All actions
with "Use the <screen> for this". A running unit puts "Finish unit N" first.
Cards hide as soon as the composer has text or a recording starts; "Actions"
brings them back; a card sends its own words as a field request and never
discards what was typed. A typed first message that names a unit and its type
or size ("Unit 4 on Smith is a bifold door", "La unidad 4 es una puerta
plegable", "unit 4 bifold 8 by six") is routed as the same field request
without the card (`describesUnit` in `lib/askRouting.ts`); questions, hours or
schedule talk and problem reports about a unit stay with the local answers —
a miss costs one card tap, a false route saves a request nobody meant.

**Context tag (K2.3).** The job page and the unit sheet open Ask with
`location.state.askContext` (`contextTagFromInput` checks it). The tag rides
with every message (`field.context` / `context_tag`), fills the setup's
blanks only (`seedContextTag`), is named to the model with the rule to name
the job and unit before the first save on them, and is dropped when another
account signs in on the phone.

**Boundary and one-tap buttons (K2.4).** The AI never changes a clock or
break, signs a toolbox talk, approves, publishes or clocks anyone else; the
registry test reads the Ask function's sources and fails on any such RPC.
"Going to lunch" calls `offer_clock_button` (`_shared/clockButtons.ts`),
which writes nothing; the reply carries `buttons`, the phone shows each only
when it fits the real clock state (`lib/clockOneTap.ts`), and the tap uses
the clock sheet's own path — `start_break`/`end_break`, or the same queued
write with no signal; a `pending:` clock-in is refused. Clock in and clock
out open the job clock, whose safety questions stay there.

**Receipts (K2.5).** Every receipt card opens with Saved in Forge / Needs
your choice / Nothing changed from `receipt.status` (`lib/askReceiptGuard.ts`);
the checklist says it is kept for the conversation. A reply that reads as
done (English or Spanish, sentence by sentence, conditionals and negations
excused) with no receipt, report card or applied draft behind it gets
"Nothing was saved yet" on the phone automatically.

**Voice (K2.6).** Ask's microphone sends `language=auto` to
`transcribe-description`, which then forces no language on the provider
(dictation mics on text fields keep their field's language). The model
answers in the language the person used and asks only about unclear
quantities, sizes, people or variants.

**Daily log (K2.7).** `docs/ai-daily-logs.md`. Every daily-log turn is a
field request; the first message carries the draft from the awaited fresh
`start()`; `readDailyLogContext` refuses another account's or conversation's
draft; the reply's `daily_log` is applied only to this draft, account and
conversation, and refused (and said so) without a saved message behind it;
Save calls `append_daily_log_contribution` (migration 20261030000000).
**Answers are saved in English** (owner decision 2026-09-24): the log is one
company record the office reads, so the model translates faithfully — same
facts, nothing added, names, numbers and unit codes exact — while the reply
to the person stays in their language (K2.6). The person's own words are
not lost: the field request keeps the recording and the transcript as the
entry's evidence (`source_request_ids`).

**What the model is told, after the first live scoring (2026-09-24).** Two
models scored 31/48 live (`outputs/Forge-AI-Model-Scores-2026-09-24/`), and
most misses were instruction gaps, fixed in the prompts and tool descriptions
(`fieldTools.ts`, `aiDailyLog.ts`, `askCapabilities.ts`), not in the tools:
a start/stop/finish request is acted on at once and the database's card or
receipt speaks — the model never reads the clock and answers in prose
instead (that is how the not-clocked-in, on-break and wrong-job cards never
reached the phone); describing a unit is never a save (one model saved unit
7 the person had only described); the job named in the message beats the
draft and the clock (one model asked "did you mean Smythe?" after the person
said Smythe, another quietly kept Smith); "I don't know X" always reaches
the tool; a similar existing job still goes through `create_field_job` so
the person gets the choice card; everything is "so far" / "en el borrador"
until a receipt says done — never guardé, registré, anoté; screens are named
exactly as the registry writes them. The router now sends "set up unit 2"
and past work on a unit ("Ben and Ana installed unit 4 yesterday", the
Record crew work card's job) as field requests — the two crew-record cases
could never reach their tool by typing before.

**Evaluation set.** `scripts/ask-eval/cases.json` + `scripts/ask-eval.mjs`:
48 realistic requests through the real tool layer with a stubbed model (in
CI) or, manually and opt-in, a real model (`--live`, `--only a,b,c` for a
targeted spend). See the runner's header. Scoring: receipts, writes,
buttons, tool calls and unknown-versus-missing are exact; text values
(checklist values, daily-log answers) are compared normalized — case,
punctuation, whitespace, one leading article, a plural "s" — because the
office reads "Lift was late" and "The lift was late" the same, and a grader
that fails them hides the misses that matter; daily-log answers must be
English; a role-gated action passes refused by its tool OR never called and
said to be someone else's (a write never passes). A stubbed trajectory that
calls a tool the request never offered fails the case: that is how the two
routing gaps above were found.

## Loading cost

Ask-only English/Spanish strings stay with its lazy route and keep typed keys and matching placeholders. The job Custom Data tab now loads its editor when opened, using the existing loading placeholder. Initial bundle: 253.1 kB gzip against the unchanged 260 kB limit.
