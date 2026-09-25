# AI daily logs — integration with Ask (applied by Release 2, K2.7)

Branch `codex/ai-daily-logs` deliberately did **not** edit the shared Ask files
owned by the learning build: `app/src/pages/AskInfinity.tsx`,
`supabase/functions/ask/index.ts` (the real edge path — there is no
`ask-infinity` function), and — because it is the same request path —
`app/src/lib/knowledge.ts` (`askInfinity`). The steps below were applied on
the crew-redesign Release 2 branch (`claude/r2-ai`): the migration was
renumbered 20261027000000 → 20261030000000, `person_record_counts` was rebuilt
as the union described in §0, the wiring in §1–§2 is in the three files named
above, the daily-log PGlite harness runs in CI, and the release note in §6
ships as `20261030010000_ai_actions_note.sql`. Kept as the record of the
contract; `app/src/pages/AskInfinity.dailyLog.test.tsx` and
`app/e2e/ask-daily-log.spec.ts` prove it on the real page.

## 0. Merge warning: `person_record_counts` must be UNIONED

**For the learning branch and the final integration agent.** Each build
restates `public.person_record_counts` in full, copied from the definition in
force on its own base:

- learning: `20261026000000_hex_learning_review.sql` (hex learning keys)
- daily logs: `20261030000000_ai_daily_log_contributions.sql` — copied from
  `20261024000000` plus ONE line:
  `'daily_log_contributions.actor_id', (select count(*) from daily_log_contributions where actor_id = p_id),`
- training (PR 629, merged at `9b55c94`) may also have added retention keys;
  check master before resolving.
- clock integrity (Release 0, PR #640): `20261028000000_clock_integrity.sql`
  adds `'time_clock_actions.profile_id'` (the clock-tap ledger cascades off
  profiles). #640 merges first, and since this branch was rebased onto it
  (2026-09-25) the 20261030 definition carries that key too.

Migrations apply in name order, so **whichever file is last replaces the others
entirely**: shipped as-is, 20261030 would silently DROP the learning (and any
training) keys, and a person with those records could be hard-deleted. On merge,
rebuild the 20261030 definition as the UNION of every restatement on master plus
the daily-log line — never take one file's version. `app/src/lib/purgeWords.test.ts`
("the SQL and the probe list agree") fails if either side's keys are missing,
and `WORK_HISTORY_PROBES` in `app/src/lib/purgeWords.ts` needs both sides'
entries. Do not resolve this conflict by taking one file's version.

## 1. The request carries the draft, and it is a field request

While a daily log draft is open, EVERY Ask turn — voice AND typed — MUST go
through the field-request path (`body.field` with `actor_id`, `request_id`,
`conversation_id`, `sent_at`, `input_kind`). That is what saves its
`ai_field_requests` row (transcript, recording path, conversation) — the
evidence the saved entry lists in `source_request_ids`. It must never be
answered from the cache or the brain. A typed turn gets its request id from
`pressSend()`, exactly as operational text turns already do.

There is no silent fallback. A reply whose `daily_log` has answers but no
`request_id` or `conversation_id` is REFUSED by the phone
(`applyDailyLogReply` → `{ applied: false, reason: "missing_evidence" }`) and
nothing is added to the draft. The host must tell the person those words were
not recorded (keep the message for resend, as unsent field messages are kept),
never render them as captured.

### `app/src/lib/knowledge.ts` — `askInfinity`

```ts
export async function askInfinity(question, history, field?: FieldMeta, dailyLog?: DailyLogAskContext | null) {
  const { data, error } = await supabase.functions.invoke("ask", {
    body: { question, history, timeZone: ..., ...(field ? { field } : {}), ...(dailyLog ? { daily_log: dailyLog } : {}) },
  });
  ...
  return { ..., ...(data?.daily_log ? { dailyLog: data.daily_log } : {}) };
}
```

### `app/src/pages/AskInfinity.tsx`

```tsx
import { AiDailyLogCard } from "../components/aiDailyLogs/AiDailyLogCard";
import { useAiDailyLogDraft } from "../lib/aiDailyLogs/useAiDailyLogDraft";
import { applyDailyLogReply, asksForDailyLog, dailyLogContextForMessage, dailyLogSuggestion } from "../lib/aiDailyLogs/askBridge";

// The REAL signed-in person (identity), never a role-preview identity.
const logs = useAiDailyLogDraft(me ? { userId: me.id, email: me.email ?? null, displayName: me.display_name ?? null } : null);
const [logOpen, setLogOpen] = useState(false);
const logOpenRef = useRef(false);           // read inside send()/run(), never the closed-over state

// Visible preset: first suggestion chip. Tapping it sends its query like any message.
suggestions = [dailyLogSuggestion(lang), ...suggestions];

// In send(): a daily-log message is operational (gets a field request id).
const dailyLogMsg = logOpenRef.current || asksForDailyLog(q);
const operationalNow = !!voiceMeta || isOperationalAsk(q, ...) || fieldActive || dailyLogMsg;

// In run(), after `meta` is known and the stillOwner() check, BEFORE askInfinity:
const daily = await dailyLogContextForMessage(logs, q, { cardOpen: logOpenRef.current, suggestedJob: openShiftJob ?? null });
if (daily.open) { logOpenRef.current = true; setLogOpen(true); }
if (!isCurrent(g) || (meta && !(await stillOwner(g, meta.actor_id)))) { /* existing other-account path */ }
const { ..., dailyLog } = await askInfinity(q, history, meta ?? undefined, daily.context);
if (dailyLog && isCurrent(g)) {
  const applied = applyDailyLogReply(logs, dailyLog);
  // "missing_evidence": the words were NOT recorded — say so and keep the message.
  // "not_this_draft": a late reply for another draft/account/conversation — ignore.
  if (!applied.applied && applied.reason === "missing_evidence") showNotRecorded(q);
}

// Render while open (above the composer):
{logOpen && <AiDailyLogCard controller={logs} onAnswerByVoice={startRecording} suggestions={knownContext} />}
```

Why `dailyLogContextForMessage` and not `logs.draft`: `send()` closes over the
render it was created in. On the very first message ("Build my daily log — I
set six frames with Ben"), `logOpen` is false and `logs.draft` is null in that
closure, so a request built from them carries no draft, the model gets no
tool, and the facts in that message are lost. The helper awaits
`logs.start()`, which RETURNS the fresh draft, and builds the context from that
value (`logs.snapshot()` gives the same without starting). Voice follows the
same path: `send(transcript, voiceMeta)` runs `run()`, which calls the helper
with the transcript. Tested: `app/src/lib/aiDailyLogs/askBridge.test.ts`
("the first message").

`knownContext` (optional): `{ units_stages: { value: draft.notesDraft, source: "unit_records" } }`
from `buildDraftForJobDay` in `lib/dailyLogs.ts`, and a crew line with
`source: "job_clock"`. Shown only on an empty field; used only on tap.

## 2. Edge function (`supabase/functions/ask/index.ts`)

```ts
import {
  DAILY_LOG_SYSTEM_PROMPT, DAILY_LOG_TOOLS, DAILY_LOG_TOOL_NAMES, dailyLogActivityLine,
  dailyLogContextBlock, dailyLogExecutor, dailyLogReplyPayload, newDailyLogToolState, readDailyLogContext,
} from "../_shared/aiDailyLog.ts";

// After the `field` block (the caller is verified; `conversation` is the field
// message's conversation_id). ONLY inside a field request, so every answer has
// an ai_field_requests row behind it:
const dailyCtx = field ? readDailyLogContext(body.daily_log, userId, conversation) : null;
const daily = dailyCtx ? newDailyLogToolState(dailyCtx) : null;
const dailyTool = daily ? dailyLogExecutor(daily) : null;   // writes nothing anywhere

const tools = [...SCHEDULING_TOOLS, ...REPORTING_TOOLS, ...(field ? FIELD_TOOLS : []), ...(daily ? DAILY_LOG_TOOLS : [])];
const executeTool = (name, input) => dailyTool && DAILY_LOG_TOOL_NAMES.has(name) ? dailyTool(name, input) : /* existing routing */;
system: SYSTEM_PROMPT + (field ? FIELD_SYSTEM_PROMPT + ... : "") + (daily ? DAILY_LOG_SYSTEM_PROMPT + dailyLogContextBlock(daily.context) : "") + ...
// toolActivityLine: fall back to dailyLogActivityLine(name).

// Put it INSIDE `reply` before ai_field_finish, so a replayed (already
// answered) message returns it too:
const reply = { answer, artifacts, sources, ...(toolActivity.length ? { toolActivity } : {}),
  ...(daily ? { daily_log: dailyLogReplyPayload(daily, { requestId: field!.requestId, conversationId: conversation }) } : {}) };
```

- `readDailyLogContext` returns null for a context whose `actor_id` is not the
  verified caller, or whose `conversation_id` differs from this field message's
  conversation. (Returning 403 like `fieldActorMatches` is also fine.)
- `conversation` needs to be hoisted out of the `if (body.field …)` block.
- A daily-log turn needs BOTH ids: if the field message has no
  `conversation_id`, do not register the daily-log tool for it (the phone would
  refuse the reply as `missing_evidence` anyway). The phone always sends one
  (`currentConversation(userId)` in `lib/fieldAsk.ts`).
- Captions never reach the model; the phone sends only `photo_count`.
- Job lookup stays with `get_field_context`. To offer its matches as buttons,
  add `job_candidates: [{ project_id, label }]` to `daily_log`; they are only offered.

## 3. Evidence contract: every contributing message, in order

`applyDailyLogReply(logs, reply.daily_log)` applies each `tool_inputs` entry
with that reply's `request_id`/`conversation_id`:

- The draft keeps EVERY Ask message whose answers it took — first to last,
  once each (`draft.sources.requestIds`), not only the first memo or the last
  answer — and freezes that list into the Save payload (`sourceRequestIds` →
  `p_source_request_ids`, part of the content hash).
- The first answered message fixes the draft's conversation; a reply from any
  other conversation, draft or account is ignored (`not_this_draft`).
- A reply with no evidence is refused (`missing_evidence`, see §1).
- Cap: 50 messages (the server's limit). A NEW 51st message is not applied —
  its evidence could not be kept — and its words are held, not lost: the card
  shows "the last answer was NOT added" with **Keep those words as my typed
  text** (`keepHeldAsTyped`), which records them as the person's own typed
  answers. A message already listed may keep adding answers.
- Server (`_daily_log_sources`): each id must be the actor's own
  `ai_field_requests` row, all from one conversation, no repeats; a foreign
  or unknown id refuses the whole save (nothing written).

## 4. No alternate write path

The AI path cannot reach `file_daily_log` (the manual editor's whole-row
upsert). Checked on this branch's base and on the current ai-learning-review
Ask registry: no Ask tool writes daily logs (`daily_logs` there is a read-only
job summary). `app/src/lib/aiDailyLogs/registry.test.ts` asserts it from source:
the model's only daily-log tool is `record_daily_log_answers`; nothing in
`lib/aiDailyLogs`, `components/aiDailyLogs`, `_shared/aiDailyLog.ts` or
`supabase/functions/ask` names `file_daily_log`/`fileDailyLog`/
`enqueueDailyLog` or writes `daily_logs` directly; and the reviewed Save's
only writing RPC is `append_daily_log_contribution`. The manual editor
(`lib/dailyLogs.ts`, the offline outbox handler) keeps using `file_daily_log`
unchanged. If the integration registers daily-log tools in `ask/index.ts`,
that test keeps guarding it.

## 5. The save contract (already implemented here)

`append_daily_log_contribution(p_id, p_actor, p_project_id, p_log_date,
p_expected_revision, p_answers, p_body, p_photo_ids, p_source_request_ids)`:

- `p_actor` must equal `auth.uid()` (42501 otherwise) — the learning review's
  `p_actor` rule. The phone also re-checks the screen's account AND
  `supabase.auth.getSession()` immediately before the request.
- The content hash covers project, date, answers, body, photos and sources; a
  retry of the same words returns `already_saved`, different words under a used
  id are refused.

## 6. After integrating

- Run `app/e2e/ai-daily-logs.spec.ts` (harness) and add a spec through the real
  Ask page: first message with facts, voice, reply applied, Save.
- Release notes in a NEW migration (not 20261030000000), IDs appended to
  `INCLUDED_UPDATE_IDS`. Draft (audience installer 0, foreman 1, supervisor 2, owner 3):
  - `2026-09-23-ai-daily-log` — EN "Build today's daily log in Ask" / "Say or type what you got done; Forge AI fills the log and you check it. Your part is added under what others wrote — nothing is replaced. Add photos; each shows its own upload status." ES "Haz el registro del día en Ask" / "Di o escribe lo que hiciste; Forge AI llena el registro y tú lo revisas. Tu parte se agrega debajo de lo que otros escribieron; no se reemplaza nada. Agrega fotos; cada una muestra su propio estado."
- Deploy order: migration `20261030000000` before the frontend; verify
  `sandbox_guard_census()` is empty.

## Contract summary

| Piece | Where |
| --- | --- |
| Tool name / schema / prompt | `supabase/functions/_shared/aiDailyLog.ts` (`record_daily_log_answers`, `DAILY_LOG_TOOLS`, `DAILY_LOG_SYSTEM_PROMPT`) |
| Server context / executor / reply | same file: `readDailyLogContext(raw, callerId, conversationId)`, `dailyLogExecutor`, `dailyLogReplyPayload(state, { requestId, conversationId })` |
| First-message context | `dailyLogContextForMessage(controller, text, { cardOpen, suggestedJob })` in `app/src/lib/aiDailyLogs/askBridge.ts` |
| Reply | `applyDailyLogReply(controller, reply.daily_log)` → `{ applied: true }` or `{ applied: false, reason: "missing_evidence" \| "not_this_draft" \| "unreadable" }` |
| Controller | `useAiDailyLogDraft(actor)` → `AiDailyLogController` (`start` returns the draft; `snapshot()`) |
| Card | `<AiDailyLogCard controller jobs? suggestions? onAnswerByVoice? />` |
| Preset | `dailyLogSuggestion(lang)`, `asksForDailyLog(text)`, `DAILY_LOG_PRESET` |
| Only writer | SQL `append_daily_log_contribution` (20261030000000) |
