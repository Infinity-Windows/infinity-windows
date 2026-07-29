# Ask Infinity without paying per question

*Investigation and recommendation — 29 July 2026. Written for the owner, not for engineers.*

---

## The recommendation, in plain English

**Stop worrying about the money. Go token-free anyway — for a completely
different reason.**

1. **The cost you are afraid of does not exist.** A crew of eight installers
   asking ten questions each, every working day, costs about **$46 a month**.
   Even ten installers asking twenty questions a day is about **$115 a month**.
   That is less than one water-leak callback. The money was never the problem.

2. **The real problem is that a language model can make up a flashing
   sequence, and your crew has no signal in a basement.** Both of those are
   solved by the same thing: put the company's own answers *in the app*, on the
   phone, and look them up with plain word matching. No AI at answer time. It
   physically cannot invent an instruction, and it works with the phone in
   airplane mode.

3. **Do not turn the AI answering back on for crew.** Instead: bundle the
   knowledge you already have into the app and give it a search box that
   actually works. Today Ask Infinity correctly answers **6 out of 28** real
   installer questions. Bundling what you *already own* — no new writing, no
   AI — takes that to **17 out of 28** correct, with **21 out of 28** useful.
   That is a bigger improvement than switching the AI on would give you, and it
   costs nothing per question, forever.

**What to build:** ship the company brain inside the app (about 37 kilobytes of
text — smaller than one job photo), with a real search over it. **What to cut:**
the crew-facing AI answering. **What to stop worrying about:** the bill.
**What to build anyway, because it takes a day:** a hard spend cap, so no future
feature can ever surprise you.

---

## Part 1 — What works today with no API key

Ask Infinity already has a no-AI path. It tries three things in order:

1. Look up a window type in the catalog.
2. Look for a word in the built-in glossary.
3. If the question contains words like "how" or "what", print a tour of the app.

**Assessment: it is not useful in the field, and it is worse than it looks.**

Three specific findings:

- **The catalog lookup only works if the installer types the type code almost
  exactly.** It searches for the *entire question* as a phrase inside the type
  code, name or category. So "SH3252" works. "single hung" returns **nothing**,
  because the catalog spells it "Single-Hung" with a hyphen. The app's own
  suggestion button, the one that says *"Single hung tips"*, returns nothing
  from the catalog. I verified this against the live database.

- **The two example buttons shipped on the screen both fail.** *"Single hung
  tips"* falls all the way through to *"I don't have a saved answer for that
  yet."* *"What is flashing?"* — a question the glossary answers beautifully —
  falls through to the **app tour**, because the glossary matching only looks
  for a glossary heading spelled out inside the question, and no heading is
  literally called "flashing".

- **The "app tour" catch-all is the worst part.** Any question containing
  "how", "what", "where", "use", "do I", "help", "start", "install", "point",
  "scan" or "warehouse" gets a paragraph about which tab does what. Of my 28
  test questions, **15 got the app tour** — a confident, irrelevant answer to a
  question about caulking or flashing. That trains crew to stop asking.

- **The catalog lookup needs signal anyway.** It queries the server. In a
  basement, that step fails and only the glossary is reachable. The code
  describes this path as the "offline brain"; two thirds of it is not offline.

One thing that *is* genuinely good: the app shell, including the glossary, is
already cached on the phone for offline use. The plumbing for a real offline
brain is there. It is just not being fed.

---

## Part 2 — Measuring the brain (exact numbers from the live database)

Queried production (`czprjcskmzzagdztqonm`), read-only, 29 July 2026.

### The window catalog

| | Count |
|---|---|
| Window types total | **130** |
| — real catalog entries | **102** |
| — provisional junk from plan extraction | **28** (22%) |
| Types with install tips | **11** |
| Types with watch-outs | **11** |
| Types with a difficulty rating | **102** (all real ones) |
| Types with a tutorial link | **0** |
| Types with a generated how-to | **3** |
| Types with any free-text notes | **9** |
| Types with a recorded install count or typical time | **0** |

Your two suspicions were both correct. The 28 provisional rows are named
"Mark #1", "Mark #2" and so on — they came out of reading plansets, not out of
your catalog, and they are 22% of the table. And tips were seeded for 11 types,
not the 130 the catalog implies.

### The knowledge base (the Obsidian vault side)

| | Count |
|---|---|
| Knowledge documents indexed | **0** |
| Knowledge chunks indexed | **0** |

Correct: **nothing has ever been uploaded**. The retrieval half of the AI
feature has no corpus at all. Even with an API key, it would be answering from
live app data only.

### Field experience captured

| | Count |
|---|---|
| Install events logged | **0** |
| Install memos / attachments of any kind | **0** |
| Transcribed voice memos | **0** |
| Job notes | **0** |
| Written procedures | **0** |

Also correct. **Nothing has been learned from a real install yet.** The
"tips build up as crews log installs" promise the app makes to installers has
never fired once. Of the 11 types with tips, only 1 was AI-synthesized; the
other 10 were hand-seeded.

For scale: 6 people, 2 projects, 109 openings.

### The glossary in the code

| | Count |
|---|---|
| Glossary terms | **105** |
| Install procedure steps | **18** |
| Terms that duplicate a catalog window type | **0** |

**The glossary is the most underrated asset you have, and it does not overlap
the catalog at all.** They are complementary: the catalog is *products*
(SH3252), the glossary is *craft* (flashing lap order, shim rules, weep holes,
lift weights, when glass must be tempered). The glossary entries are not
dictionary stubs — they carry real judgement. "Sequence is law: sill first,
jambs overlapping the sill, head last." "Two snug shim points per side is the
rule on aluminum." "Two people minimum over 150 lb, three above the first
story." That is exactly what an installer asks about, and it is already written,
already in the app, already offline — and almost entirely unreachable through
the current search.

### The 11 seeded types are also better than they look

Those 88 tip and watch-out lines are real company knowledge, not filler. They
include *"St. George standard: caulk off the top and side weep holes, leave the
bottom drains open"* and *"Confirm stucco vs rock before setting depth — it
changes the setout ~1 in (rock) vs ~1.5 in (stucco)."*

**Every single one of the nine example questions you listed is already answered
somewhere in those 88 lines.** Drain side, flashing order, caulking the bottom,
shim-before-centre, stucco versus rock setout, two-person lift thresholds,
out-of-level openings, hopper clearance, bay bracing. All of it. The company
does not have a knowledge problem on the basics. It has a *retrieval* problem.

That matters for what you build next: the missing 91 types would largely repeat
the same five tips (drain out, flash sides then top, caulk three sides not the
bottom, level then centre, test the operation). You do **not** need 130 × 5
hand-written tips. You need the tips you have to be findable by topic.

---

## Part 3 — The scored question set

I invented 28 questions an installer would actually ask, then ran them three
ways: through today's code exactly as written, through a plain keyword search
over the content that already exists, and against the honest question "does
this genuinely need a language model?"

"Today" and "Local index" mean *the top answer shown was correct*.

| # | Question | Today | Local index |
|---|---|---|---|
| 1 | Which side does the drain side face? | — nothing | **yes** |
| 2 | What order do I flash — sill, jambs or head? | wrong entry | **yes** |
| 3 | Do I caulk the bottom of the window? | app tour | **yes** |
| 4 | Do I shim before I centre it, or after? | partial | **yes** |
| 5 | How deep does it set back on stucco? | app tour | no |
| 6 | How far back on rock veneer? | app tour | **yes** |
| 7 | How heavy before I need a second man? | app tour | partial |
| 8 | The opening is out of level — what now? | **yes** | **yes** |
| 9 | How much swing clearance does a hopper need? | app tour | **yes** |
| 10 | How do I brace a bay while I set it? | app tour | **yes** |
| 11 | Can I caulk over the weep holes? | **yes** | **yes** |
| 12 | How many shims per side on an aluminium jamb? | **yes** | **yes** |
| 13 | How tight do I run pressure plate screws? | **yes** | no |
| 14 | Backer rod, or just caulk? | **yes** | **yes** |
| 15 | The slider drags — what did we do wrong? | app tour | **yes** |
| 16 | Rollers before or after I square the frame? | wrong entry | **yes** |
| 17 | What screws go in a commercial door's top hinge? | app tour | **yes** |
| 18 | Is this glass supposed to be tempered here? | — nothing | **yes** |
| 19 | Tips for a 72×48 slider? | app tour | **yes** |
| 20 | "Single hung tips" *(a button in the app)* | — nothing | no |
| 21 | "What is flashing?" *(a button in the app)* | app tour | partial |
| 22 | How long should a casement take me? | app tour | no |
| 23 | What's the difficulty on a bay? | app tour | partial |
| 24 | Can I re-use the old sill pan? | wrong entry | partial |
| 25 | What did Ammon say about this job last week? | app tour | no |
| 26 | It's raining and the opening is open — what now? | app tour | no |
| 27 | What torque on anchors into concrete? | app tour | no |
| 28 | Reveal is tight one side — which corner is off? | **yes** | **yes** |

### The scores

| | Result |
|---|---|
| **Answered correctly today** | **6 of 28 (21%)** |
| **Answered correctly by a plain local index over existing content** | **17 of 28 (61%)** |
| **Useful answer somewhere in the three results shown** | **21 of 28 (75%)** |
| Content for it exists somewhere in the system right now | 19 of 28 (68%) |
| Genuinely needs a language model | **1 of 28 (4%)** |

Two things stand out.

**Nearly tripling the useful answer rate requires no AI and no new writing.**
Every point of that improvement comes from indexing text the company already
owns — 105 glossary entries, 18 procedure steps and 88 tip lines. That is 211
searchable entries, 37 kilobytes. It fits on the phone with room to spare.

**Almost nothing genuinely needs a language model.** Of the 7 remaining misses:
three are search tuning (question 5, 13 and 20 — fixable in an afternoon);
three are content nobody has written yet (rain contingency, anchor torque,
typical install times — a foreman writes those in an hour, or they come out of
memos once crews start recording them); and exactly **one** — "what did Ammon
say about this job last week?" — genuinely needs a model, and even then it
mostly needs *live data*, not reasoning.

**One honest warning about the local search.** It is not always right. Asked
about pressure plate torque, it confidently offered "King Stud" instead. So the
app must **show three results with their titles and let the installer pick**,
not present one answer as gospel. The failure mode of a keyword search is
"showed you something unhelpful". The failure mode of a language model is
"invented a caulking instruction." Those are not the same kind of wrong.

---

## Part 4 — The four options, honestly

### Option A — Pure local lookup, no tokens ever

**Cost:** $0 per question, forever.
**Offline:** perfect. Everything ships in the app bundle, which the phone
already caches. Works in a basement, works in a canyon, works with the SIM out.
**Reliability:** answers 17 of 28 today, and rises as content is written.
**Hallucination risk:** zero. It can only show sentences a human wrote.
**Weakness:** phrasing. It matches words, so an installer using a word nobody
wrote gets nothing useful. Mitigated with a small synonym list (caulk→sealant,
drags→binds, second man→lift) and by showing three results instead of one.
**Verdict:** this is the floor, and it should be the default for every crew
question, in every option below.

### Option B — Local first, LLM only on a miss, with caps

**Cost:** roughly a tenth of today's projected bill, because 60–75% of questions
never reach the model. Perhaps $5–15 a month.
**Offline:** the local half works; the AI half silently doesn't. The installer
sees a different quality of answer depending on where they stand, which is
confusing.
**Hallucination risk:** the model is called precisely on the hard questions
nobody wrote an answer for — the worst possible moment to be inventive. This
option optimises the bill by concentrating the risk.
**Verdict:** the tempting option and the wrong one for field questions. It is
defensible only for office/admin questions.

### Option C — Server-side LLM restricted by role, with quotas

**Cost:** small, because only a handful of office users can call it.
**Offline:** irrelevant; office users have desks and Wi-Fi.
**Hallucination risk:** acceptable, because a supervisor asking "what's on the
schedule Thursday" can sanity-check the answer, and a wrong answer doesn't leak
water into a wall.
**Verdict:** **keep this, narrowly.** Foreman and above, questions about jobs,
schedules, issues and chat. Never for install technique, never for crew.

### Option D — Move the AI spend from read time to write time

*(Pay AI when content is created — transcribing memos, turning them into tips
per window type, generating how-tos — then crew queries hit a free local index.)*

I tested this hardest, because you suspected it was right.

**It is right, and it is even cheaper than you think.** Synthesising tips for a
window type costs **$0.0009**. Doing all 102 real types costs **9 cents**.
Adding a how-to for every type costs another 9 cents. Embedding the entire
brain costs half a cent. **Building the whole company brain from scratch,
end to end, costs about 23 cents** — a one-time spend, plus roughly **$2.40 a
month** to transcribe 200 voice memos.

The economics you described are exactly correct: cost scales with *how much
content the company creates* (predictable, one-time per item, reviewable before
it ships) instead of with *crew curiosity* (unpredictable, unbounded, and
repetitive — the same five installers asking the same flashing question a
hundred times, paying full price each time).

**Where it could fail, and whether it does:** the worry is phrasing variety —
pre-generated answers only help if crew's words find them. My test says it
mostly holds: 17 of 28 correct on the top result, 21 of 28 useful in a
three-result list, using nothing smarter than word matching over 211 entries.
That is the honest ceiling for a first version, and it is well above where the
app is now. Two cheap upgrades push it higher: a synonym list for how installers
actually talk, and — when the phone *does* have signal — a smarter online search
over the same content that costs **$0.0000004 per question** (it embeds the
question; it does not generate an answer). Effectively free, and still incapable
of inventing anything.

**The one real limitation:** write-time synthesis needs someone to write or
record something first. Today that is 0 memos and 0 install events. So this
option's ceiling is set by whether crew actually record memos — which is a
management problem, not a technology problem.

### Offline, specifically

Installers lose signal, and an answer that needs a round trip is worthless in a
basement. The app already caches its whole shell on the phone. So:

- **Ships on the device (works with no signal):** the 105 glossary terms, the
  18 procedure steps, the 88 tip lines — everything in the recommendation. 37 KB.
- **Should also ship, and currently doesn't:** the 102 real window types with
  their difficulty and how-tos, so a type lookup stops needing the server.
  Ballpark 100–200 KB. Refresh it whenever the phone has signal.
- **Cannot ship, and must degrade gracefully:** live job data (today's
  schedule, chat, which unit is on which truck). Cache the user's own day, and
  say plainly when a figure is from this morning rather than right now.

---

## Part 5 — What it actually costs

### Sources (checked 29 July 2026)

| Thing | Price | Source |
|---|---|---|
| Claude Sonnet 5 (the model configured) | $2 per million words-in, $10 per million out — *introductory, until 31 Aug 2026*; $3 / $15 after | [anthropic.com/pricing](https://www.anthropic.com/pricing#api) |
| GPT-4o-mini (used to write tips) | $0.15 in / $0.60 out per million | OpenAI pricing |
| Text embeddings (search) | $0.02 per million | [OpenAI docs](https://developers.openai.com/api/docs/models/text-embedding-3-small) |
| Whisper voice transcription | $0.006 per minute of audio | [OpenAI docs](https://developers.openai.com/api/docs/models/whisper-1) |

A note on "tokens": roughly ¾ of a word each. Every Ask question sends the
whole company context — app guide, projects, the user's assigned windows,
issues, inventory, chat — which measures about **12,000 tokens in and 300 out**
once a knowledge base exists. That is the number the costs below are built on.

### Read time — what you are afraid of

**About 2.7 cents per question** today (4.1 cents once introductory pricing
ends in September).

| Crew | Questions each per day | Per month | Now | From September |
|---|---|---|---|---|
| 6 | 5 | 630 | **$17** | $26 |
| 8 | 10 | 1,680 | **$46** | $69 |
| 10 | 20 | 4,200 | **$115** | $173 |

**Put that next to one callback.** A single leak traced to a reversed flashing
lap — tear-out, re-flash, drywall, paint, an unhappy GC — is thousands. Your
worst realistic monthly AI bill is a rounding error against one bad install.
**The cost fear is unfounded. Let it go.**

### The tail you *should* care about — and it is real

There is no rate limit and no spend cap on any AI function in this codebase.
Any signed-in user can call the Ask function as often as they like; there is no
role check on it either. So:

- One person tapping send every ten seconds for an eight-hour day: **$79**.
- The same behaviour every working day for a month: **$1,661**.

That is not a plausible accident, but it is the number that exists today with
nothing standing in its way — and a leaked login or a runaway retry loop gets
there without anyone deciding to. This is why a cap is worth a day of work even
though the normal bill is trivial.

### Write time — the comparison

| | Cost |
|---|---|
| Write tips for one window type | **$0.0009** |
| Write tips for **all 102** real types | **$0.09** |
| Add a how-to for all 102 types | **$0.09** |
| Make the whole 211-entry brain searchable | **$0.0005** |
| Index a 2-million-word Obsidian vault | **$0.04** |
| **Build the entire brain, one time** | **≈ $0.23** |
| Transcribe 50 voice memos a month (2 min each) | $0.60/mo |
| Transcribe 200 voice memos a month | **$2.40/mo** |
| Transcribe 500 voice memos a month (3 min each) | $9.00/mo |

**Building the complete company brain costs less than a coffee. Answering
questions about it costs $46 a month, every month, forever.** And the brain,
once built, is reviewable — a foreman reads the 5 tips for a slider once and
approves them. Nobody reviews the 1,680 answers the model gives in a month.

### The spend cap, exactly as it should be built

This is a solved problem. Specifically:

1. A small table recording every AI call: who, which function, when, tokens in
   and out, and the cost in cents.
2. Before any AI call: refuse if that user is over **40 calls today**, or if the
   company is over **$50 this calendar month**. Both numbers live in a settings
   row you can change without a code release.
3. When the cap is hit, don't error — fall through to the local answer, and
   quietly tell the office, not the installer.
4. Only foreman and above can reach an AI-backed answer at all. Installers get
   the local brain, always.
5. A single admin screen showing spend this month and the top askers.

That is a day of work. Build it regardless of which option you choose, because
it means no future AI feature can ever surprise you.

---

## Part 6 — Hallucination risk, which matters more than the money

This is the argument that should decide it.

A language model asked "do I caulk the bottom of the window?" with no company
note in front of it will answer. It will answer confidently, in complete
sentences, in your app, wearing your company's name. Most of the time it will
even be right — general practice is to leave the bottom open. But it will be
right *by coincidence*, not because it read your standard. And your standard is
specific: *"St. George standard: caulk off the top and side weep holes, leave
the bottom drains open."* A generic answer that says "seal the perimeter"
sounds equally authoritative and puts water in a wall.

Three things make this worse than it sounds in your particular case:

1. **The knowledge base is empty.** The whole safety mechanism — "answer only
   from the company's notes" — depends on there being notes. There are zero.
   With the key switched on today, the model would answer install-technique
   questions from its general training and nothing else. The guardrail is
   written and correct; it is guarding an empty room.

2. **The audience cannot referee it.** A new installer asking about flashing
   order is asking *because they do not know*. They have no way to spot a
   plausible wrong answer. The people best able to catch an error are the
   people least likely to be asking.

3. **The errors are expensive and silent.** A wrong flashing lap is invisible
   at sign-off and shows up two winters later as a leak, a warranty claim, and
   an argument about who pays. There is no test that catches it on the day.

Weigh that against what you give up. A lookup that cannot invent answers 61% of
these questions correctly and says nothing on the rest. A model answers close to
100% of them — but some percentage of that is confident fiction, and you cannot
tell which. **In this trade, "cannot be wrong" beats "can answer anything."**
Silence is a safe answer. A made-up caulking instruction is not.

---

## Part 7 — What to build

**Recommendation: Option D (pay at write time) with Option A as the crew-facing
front door, and Option C kept narrowly for office roles.**

### Effort estimate

| # | Work | Effort |
|---|---|---|
| 1 | **Bundle the brain into the app.** Take the 105 glossary terms, 18 procedure steps and 88 tip lines into one searchable list that ships with the app. 37 KB. | **1 day** |
| 2 | **Replace the search.** Word-level matching with a synonym list for how installers actually talk, instead of today's exact-phrase matching. Show the top three with headings and where each came from. Delete the app-tour catch-all — say "I don't have that written down yet" and offer to send it to the foreman. | **1–2 days** |
| 3 | **Cache the catalog on the phone.** The 102 real types with difficulty, tips and how-tos, refreshed whenever there's signal, so type lookup stops needing the server. | **1 day** |
| 4 | **Hide the 28 provisional rows** from the catalog everywhere, not just in Ask. They are plan-extraction leftovers named "Mark #1". | **half a day** |
| 5 | **Build the spend cap and the usage log** as specified in Part 5. | **1 day** |
| 6 | **Turn on write-time synthesis.** Transcribe memos, synthesise tips per type, generate how-tos, on a schedule; a foreman approves before crew see them. Most of this code already exists and is unused. | **2–3 days** |
| 7 | **Log the questions the brain could not answer.** This is the single highest-value thing on the list: it tells you exactly what to write next, in your crew's own words. | **half a day** |
| 8 | **Office-only AI, behind the cap.** Foreman and above, job/schedule/issue questions only. Never install technique. | **1 day** |

**Total: 8–10 working days.** Items 1, 2 and 7 alone — about three days — take
the app from 6 correct answers out of 28 to 17, for zero ongoing cost.

### What to cut

- **The crew-facing AI answering path.** Don't set the Anthropic key for
  installer use. Right now it's off and the screen quietly serves an app tour
  instead; that is worse than either alternative and should be fixed either way.
- **The idea of hand-writing tips for 130 window types.** You need topics, not
  products. The 11 seeded types already cover the general practice; the gap is
  a dozen topic-level answers (rain contingency, anchor torque, typical times)
  and better search.
- **Waiting for the Obsidian vault to be uploaded before anything works.** It's
  a nice-to-have that costs 4 cents to index. It is not the plan.

### What would have to be true for me to be wrong

I would be wrong if:

- **Crew mostly ask about job data, not craft.** If the real questions are
  "where's my truck", "what's on Thursday", "what did the GC say" — that's
  synthesis across live data, and a model does it far better than word matching.
  *Test this cheaply:* build item 7 first and read a month of real questions
  before committing to the rest. If most of them are live-data questions,
  Option C widens and my recommendation shrinks.
- **The tips corpus never grows.** If crews never record memos, the local brain
  stays at 61% and never improves, while a model would at least attempt
  everything. My answer to that is that a stuck-at-61% brain that cannot lie
  still beats a 100%-attempt brain that sometimes does — but it would be a
  closer call than I've made it.
- **Crew actually have signal everywhere.** If every job is a suburban retrofit
  with full LTE, the offline argument mostly evaporates and this comes down to
  hallucination risk alone. That is still enough to carry the recommendation,
  but it becomes an argument rather than a slam dunk.
- **Phrasing variety is worse in the wild than in my test.** I wrote the 28
  questions myself. They are honest, but they are mine. If real installers
  phrase things far stranger, the 61% is optimistic. Item 7 measures this for
  real within a month.

---

### Reproducing the measurements

Every number in Parts 2 and 5 came from read-only queries against production
(`czprjcskmzzagdztqonm`) and from the code on `master` at `c6dcf0d`, on
29 July 2026. The scoring in Part 3 came from replaying the exact matching logic
in `AskInfinity.tsx` and `api.ts` against the live catalog, then re-running the
same 28 questions through a keyword index over the glossary, the procedure steps
and the 88 seeded tip lines.
