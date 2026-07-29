# AI spend limits

**Question this answers:** can somebody with a login run up an AI bill?

**No.** Not a crew member, not a leaked login, not a retry loop. Two ceilings sit
in front of every paid AI call — one per person per day, one for the whole
company per month — and both are enforced inside the database before any money
is spent. Hitting either one does not produce an error: the question falls
through to the company brain and comes back answered.

This is the fix specified in `docs/ask-infinity-token-free.md` (Part 6), built.

---

## What it costs to be wrong

From the investigation, checked against live token counts:

| Scenario | Per day | Per month |
| --- | --- | --- |
| Realistic crew use (5 people, ~10 questions each) | $1.35 | ~$28 |
| Heavy, still legitimate | ~$5 | ~$115 |
| One person tapping send every 10 seconds | **$79** | **$1,661** |

The runaway is not somebody deciding to spend $1,661. It is a client stuck in a
retry loop, or a phone left on a jobsite with the app open. Nothing in the old
code could tell the difference, because nothing counted.

## The defaults, and why

| Setting | Default | Reasoning |
| --- | --- | --- |
| Per-user daily questions | **40** | Four times the heaviest real day the investigation found (10/person). Nobody working reaches it. The runaway hits it in **under 7 minutes**, and costs about **$1.08** getting there. |
| Company monthly ceiling | **$150** | Comfortably above the $115 heavy-but-legitimate month, so a busy month never trips it. The runaway would need to cross ten people's full daily quotas to reach it. |
| Minimum role for AI | **foreman** | Per the investigation: installers keep the free company brain, which already answers most real questions. |
| Warn the owner at | **80%** ($120) | One push, once, the moment spend crosses it — not a surprise on the invoice. |
| Batch jobs count as | **2 questions** | An owner-triggered planset extraction is worth more than a question but must still be visible on the meter. |
| Timezone for "today" | **America/Denver** | The crew's day, so quotas reset overnight rather than mid-afternoon. |

The pair is deliberately lopsided. The daily count is the real defence: it
catches a runaway in minutes for about a dollar. The monthly ceiling is the
backstop for the case the daily count cannot see — many accounts, or a genuinely
busy month — and it is set where no honest month reaches it.

All of these are editable by an owner on **AI Spend** (`/ai-spend`) without a
deploy.

## Which functions are gated, and which are not

Two different things spend money here, and they do not deserve the same rule.

**Questions** — a person tapping send. Role floor applies, daily count applies,
monthly ceiling applies.

| Function | Provider | ~Per call | Why |
| --- | --- | --- | --- |
| `ask` | Anthropic | 2.7¢ | The runaway in the investigation. Fully gated; degrades to the company brain. |
| `generate-toolbox-talk` | OpenAI (+ images) | ~8¢ | Crew-triggered and the most expensive per tap, because of the diagrams. Skips rather than degrades — a safety talk is a document, not an answer. |

**Content** — owner-triggered batch work against a planset or the knowledge
base. No role floor (the people who run these are already senior, and a
half-ingested planset is worse than none), but every call is metered and the
monthly ceiling still stops it.

| Function | Provider | ~Per run | Treatment |
| --- | --- | --- | --- |
| `extract-specs` | Anthropic vision | ~5¢/planset | Metered; ceiling only. Runs once per planset, not per curiosity. |
| `extract-schedule` | OpenAI | ~5¢/planset | Metered per batch, so a 12-batch planset books 12 reservations. |
| `transcribe-install-memo` | Whisper + vision | ~2¢/memo | Metered; whisper priced by audio minute, vision by tokens. |
| `synthesize-type-tips` | OpenAI | $0.0009/type | Metered per window type inside the loop, so a 100-type run cannot slip past mid-way. |
| `generate-howto` | OpenAI | $0.0009 | Metered. |
| `ingest-knowledge` | OpenAI embeddings | ~$0.0005 | Metered per batch. Effectively free, counted anyway so the owner screen has no blind spot. |

Nothing was left ungated. The distinction is the *role floor*, not the meter:
`extract-specs` has no role floor because it is not a thing a curious installer
can trigger, but it is still counted and still stopped by the ceiling.

## How the limit is enforced

The decision is one SQL statement, not TypeScript.

```sql
insert into ai_usage_days (user_id, usage_day, calls) values (p_user_id, v_day, 1)
on conflict (user_id, usage_day) do update
  set calls = ai_usage_days.calls + 1
  where ai_usage_days.calls < v_cfg.per_user_daily_calls
returning calls into v_calls;
-- v_calls is null <=> the WHERE failed <=> quota already spent
```

This matters more than it looks. The runaway is *rapid fire*, so the naive
shape — read the count, compare, then write — loses exactly when it matters:
thirty requests all read "9 so far", all conclude they are under the limit of
ten, and all proceed. Measured on production, with an artificially widened
window to make the race visible:

```
NAIVE  limiter: fired=40 limit=10 allowed=27 denied=13    <- 2.7x overspend
ATOMIC limiter: fired=40 limit=10 allowed=10 denied=30    <- exact
```

And the real function, 30 genuinely concurrent connections against a limit of
10:

```
fired=30 allowed=10 denied=20 reasons={'user_daily': 20}
ai_usage_days -> calls = 10        (30 attempts recorded in ai_usage_events)
```

The naive number moves between runs — it is a race, which is the point. It has
never landed on the limit. The atomic one has never landed anywhere else.

Money is handled the same way but in two steps, because a call's real cost is
not known until it returns:

1. **Reserve** — book an estimate against the month, atomically, before calling
   the provider. The ceiling is therefore tested against money already *booked*,
   so fifty calls in flight are measured against each other rather than against
   a total that will not exist until they all finish.
2. **Settle** — replace the estimate with the provider's own reported token
   counts. Actual spend, not a guess at call counts.
3. **Release** — if the provider call fails, hand the reservation back. A failed
   call costs nothing and must not consume budget.

Costs are stored in **micro-dollars** (millionths), because synthesising tips
for one window type costs $0.0009 and would round to zero in cents.

## Free answers are free

The most important property, and the one that is easiest to get wrong: **a
question the company brain answers costs nobody a question from their daily 40,
and never touches the budget.**

That holds because of where the meter sits, not because of a check. `AskInfinity`
asks in this order:

1. Cached live job data — schedule, next window, my truck. No network, no model.
2. The bundled company brain. Free, offline, and the answer path for most
   questions.
3. Only if both came up empty, and only for foreman and above, the paid
   `ask` function.

So a free answer never reaches the metered function at all. Inside that function
the reservation is taken immediately before the first thing that can cost money
and after everything that cannot — including the missing-key check, which now
returns an empty answer rather than a 500, because a call that cannot spend must
not be metered either. `app/src/lib/askDegrade.test.ts` pins the ordering with
real installer questions.

The question log (`ask_question_log`) is written once, by the client, at step 2 —
before any decision about paying. A question refused by the cap is therefore
logged exactly like any other, which is what makes the "questions our notes
couldn't answer" screen honest. The edge function writes no telemetry of its own,
so there is nothing to double-count.

## Degrading instead of failing

An installer standing at an opening must never see an error because a budget
ran out. When a limit is hit, `ask` returns HTTP **200** with an empty answer
and a note:

```json
{ "answer": "", "sources": [], "limited": true, "limit_reason": "user_daily",
  "note": "Answered from the company brain. You've used today's AI questions,
           so this one came out of the company's own notes instead.
           It resets in the morning." }
```

An empty `answer` is already the client's signal to fall back to the company
brain, so the refusal needs no special handling. The note rides along and is
shown as one quiet line above the answer. None of the three notes say "error",
none mention money to a crew member, and all of them tell the reader the answer
they are about to get is real.

Live, against production:

```
Chris (installer) asks: "Do I caulk the bottom of the window?"
  verdict : {"reason":"role","allowed":false,"min_role":"foreman"}
  ask()   : HTTP 200 {"answer":"","limited":true,"limit_reason":"role"}

  Answered from the company brain. The AI assistant is for foremen and above
  — everything below comes from your company's own written notes.

  Install tip — Double-Hung 32x52 (32×52)
  Caulk flanges left/right/top, never the bottom - the bottom has to drain.
```

The batch functions do not degrade, they **skip** — returning `skipped: true`.
There is no local fallback for extracting a planset, and half-extracted data is
worse than none.

## Telling the owner

The ceiling being hit has to be visible immediately, not discovered on an
invoice. The runtime channel is the **existing web push** (`send-push`), for
three reasons: the owners already have it, the person who needs to act is a
business owner rather than an on-call engineer, and it needs no new secret. The
CI Slack notifier (`scripts/slack-notify.sh`) was deliberately not reused — it
fires from GitHub Actions on build failure, cannot be reached from an edge
function without a new webhook secret, and would put a business spending alert
in a developer channel.

The alert fires **once** per month per threshold, enforced by a unique key on
`(usage_month, level)` rather than by application logic. The call that crosses
the line is the one that carries the owner IDs to notify; every other call
carries none, so 40 refusals produce one push. Resolving *who* to notify happens
inside `ai_spend_reserve`, which already has the privilege to read `profiles`.

## The owner's screen

**AI Spend** (`/ai-spend`, owner-only in the nav, readable by supervisor and
above). It leads with a plain-English line — "You've used $18 of your $150
budget this month" — then shows who used it, what used it, the two limits with
Save, and any alert raised. Everything comes from one RPC,
`ai_spend_overview()`, which checks the caller's rank itself.

An installer cannot raise the limits, and not because the button is hidden:

```
installer -> ai_spend_set_limits(9999, 9999999, ...)
  ERROR: P0001: ai_spend_set_limits: owner only
```

## Security

- Every table is RLS-enabled. Nothing is client-writable by anyone, ever; all
  writes go through RPCs on the service-role key.
- Table privileges are revoked from `anon` **and** `authenticated` before
  anything is granted, then only `SELECT` is granted back. This project's
  default privileges hand every new table in `public` the full set to
  `authenticated`, so `grant select` on its own would have left crew members
  holding insert/update/delete on the spend counters. RLS would still have
  stopped them, but that makes RLS the only thing in the way — one permissive
  policy added later and it becomes a write hole. Verified in the live catalog:
  `authenticated` now lists `SELECT` and nothing else on all five tables, and
  `anon` lists nothing at all.
- `EXECUTE` on `ai_spend_reserve` / `_settle` / `_release` is **revoked** from
  `public`, `anon` and `authenticated` and granted only to `service_role` — so a
  signed-in user cannot settle their own bill or release a reservation. Supabase
  grants `EXECUTE` to `PUBLIC` by default, so the revoke is explicit.
- `ai_spend_overview` and `ai_spend_set_limits` are reachable by signed-in users
  and check `auth.uid()`'s rank internally. Rank is never taken from the caller.
- The role ladder is **not** duplicated. `ai_role_rank(uuid)` delegates to
  `role_rank(text)` from the profiles lockdown migration, which mirrors
  `roleRank()` in `app/src/lib/install/types.ts`. `my_role_rank()` cannot be
  used here: the meter judges the user the edge function was called *for*, and
  it runs on the service-role key where `auth.uid()` is null.
- `search_path` is pinned to `public` on all six functions.
- The migration creates only its own five tables and touches neither `profiles`
  nor any existing policy.

## Failure behaviour

Two rules, both chosen so this feature can never become the outage:

- **Fail open on plumbing.** If the RPC is missing (migration not yet applied)
  or the service-role key is absent, the guard allows the call. A metering
  outage must not take the assistant offline.
- **Fail closed on money.** If the database says no, it is no.
- The guard never throws. `enforced = false` in the settings row turns
  enforcement off while still recording usage, if the owner ever needs that.

## Tables

| Table | Holds |
| --- | --- |
| `ai_spend_limits` | The single settings row (id = 1). |
| `ai_usage_days` | One row per person per day: calls, cost. |
| `ai_spend_months` | One row per month: booked and settled spend. |
| `ai_usage_events` | One row per attempt, allowed or refused — the audit trail. |
| `ai_spend_alerts` | One row per threshold crossed per month. |
