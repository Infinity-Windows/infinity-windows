# CONTEXT.md

Shared language for the Infinity Windows ops app. Agents and humans both read this. If a term here has a definition, use the term — don't re-describe it.

Seeded 2026-08-15 from the per-unit clocking planning session. Living document: challenge terms that don't fit, and update rather than working around them.

## The domain in one paragraph

Infinity Windows installs windows and doors. A project builder models every opening in Studio before it goes to the field. Installers work a list of units, clocking each one start-to-finish. The purpose of that clocking is to build a body of real time data good enough to estimate future jobs, evaluate products, and find where time is actually lost.

## Core nouns

**Unit** — everything that fills one opening: frame package, panes, panels or doors, and the hardware required. One opening is always one unit, even when it spans multiple stories — an opening can't be left unfilled for a customer, so it's one installer's responsibility from start to finish. A unit arrives as several **packages** and is only ready to install when all of them are on hand.

**Panel** — one leaf of a unit. Has a width, a mechanism (fixed, slider, casement, hung, bifold), and for moving mechanisms a direction. The panel is the unit of evidence, not the unit — see Panel-level evidence.

**Tier** — a horizontal row of panels within a unit, at one story. A 9-pane storefront across three floors is one unit with three tiers of three panels. `UnitConfig.tiers` (Studio 100x #22) is how Studio expresses this: absent or a single entry is the ordinary flat unit, byte-identical to before tiers existed; `unitTiers()` (`app/src/lib/modelstudio/units.ts`) is the one place that reads either shape uniformly, and every tier-aware reader (signature, 3D geometry, the panel-cost formula) goes through it. Studio's `rows[]` are pane breaks — glass divisions *within* a tier — not tiers; don't conflate them.

**Story** — which floor a tier sits on. Ground level is story 1. Story lives on the tier; a single-tier unit (almost every unit) inherits its opening's story.

**Opening** — the hole in the building. One opening, one unit.

**Flash Run** — flashing performed as its own pass, usually by a different installer on a different day. Its minutes are a sibling record on the unit (not a session): they count in the unit's labor-minutes, but never in the install cohort average — flashing carries its own per-panel modifier.

## The warehouse

Settled 2026-08-17. The warehouse answers one question — *where is it* — and records one thing — *who moved it*. Everything below serves those two.

**Package** — one physical piece of a unit: its frame, its glass, its hardware, its threshold. The package is what carries a sticker, what sits somewhere, and what moves; a unit never moves, its packages do. Every package runs the same six-stage life regardless of what's inside it: blank sticker → tagged → stored → checked out → on site → installed.

**Part number** — the manufacturer's "N of M" printed on a package: `#16 2/3` is the second of three packages making up unit 16. M is the number of packages that unit was built as, and it varies — some units are one package, some are six. M is printed on the very first package to arrive — and, once a foreman mints a window's labels in advance (see Sticker), declared up front. Either way the count of what's still missing is knowable before everything is here.

**Container** — a physical box a package sits in, of a declared kind: a conex, a crate, a truck, or a building. Containers hold packages and may sit inside one other container, never deeper. Moving a container moves everything inside it in one action — that is the whole reason a container is worth tracking — and writes a movement line, because where a container has been is history, not an edit. The main warehouse is itself a container (kind: building), the one container that never moves, so "it's in the main warehouse" is sayable without inventing a shelf. A shelf is *not* a container; see below.

**Conex** — a shipping container used as warehouse storage, on the yard or on a site.

**Crate** — a container usually holding glass for units with no pre-assembled frame. A crate is a *place*, not a package: it holds packages and has a location of its own. Crates are broken down and rebuilt, so a crate's identity dies with the physical crate. A crate carries its dimensions and weight — some do not fit in any conex, and a forklift puts them on jobs whole.

**Shelf** — an addressed spot in the warehouse: zone, rack, slot. A shelf is not a container and does not act like one. A package is in a container **or** on a shelf, never both, and the only thing that puts a package on a shelf is **Set aside**, which stages it on its own job's bay and always names that job. There is no general "put this anywhere" action for a shelf the way there is for a conex — for a package, a shelf is staging, not storage.

**Sticker** — an Infinity-printed label bound to exactly one package, for that package's whole life. Two ways one is born: printed blank in batches and bound at the truck, or minted pre-bound — job, window number, part N of M — when a foreman declares a window's package count, so receiving is sticking a label on rather than typing at a truck. Either way it binds once and is never reused — a reused sticker would make every earlier record point at the wrong physical thing. A ruined sticker is Burned or Reprinted; see both.

**Tagged** — a package that has been bound to a sticker, to what it is (its part fields), and to a job — or to the Boneyard, when no job owns it yet. Until tagged, a package is untracked and cannot be found by anyone who didn't personally put it down.

**Checkout** — a package leaving storage for a job, with a reason recorded. Checking out is per-package, never per-container: an installer takes the four packages they need and the crate stays where it is until it is empty.

**Loose stock** — an on-hand package with no container and no shelf spot. The genuinely-cannot-find-it pile, and the number that says how much the warehouse is drifting.

**Area** — roughly where inside its current box a package sits. Front / Middle / Back inside anything that moves — a conex has a door end, and the door end is the front wherever it is parked — and the compass plus Middle only inside the main warehouse, which never moves. Foreman and up set it; every move clears it, because "Back" carried into a different box reads as an answer and is a lie. An area is a pointer, not an address: nothing points at it and no label prints for it (ADR-0006). The stopgap until slots are real.

**Boneyard** — the crew's word, and therefore the app's, for company stock no job owns yet. A boneyard package is tagged like any other — sticker, part fields, BONEYARD printed where the job code would go — but carries no window number, because a window number is a position on one job's plans. Not the same thing as a finished job's packages; those still belong to their job.

**Assign to job** — the foreman-and-up action that moves a package out of the Boneyard: pick the job, pick the window number, one movement line. The sticker's QR is the package's identity, so the old label still scans; a fresh printed label is offered, never required.

**Burn** — killing a minted label that never lived: the serial dies and its part slot reopens for a fresh label. Allowed only while the package has no history — Burn refuses anything that has been stored or moved and points at Reprint instead. Carries a loud warning because the paper must be destroyed: anything still wearing a burned sticker scans as nothing.

**Reprint** — fresh paper for a package that exists: same serial, same QR, history intact. For stickers that got destroyed or unreadable on a real package. The old sticker gets destroyed so there are never two.

**Home spot** — the one place a supply lives, so it can be told to someone: *"Caulk · Bin A3."* Supplies are countable and identical, so they have a home spot and a rough count rather than individual stickers.

**On hand** — how much of a supply we believe we have. Always an estimate, always shown with when it was last counted, because it is decremented by what installers say they took and corrected only by counting.

**Warehouse stations** — the five-stage funnel the hub's top reads as, in the order material actually moves: Coming in, Off the truck, Put away, Out the door, Fix a mistake (wave F, grill Q5/Q6, 2026-08-28). The five names are vocabulary now — every destination page wears a chip naming which one it belongs to, both read from the one list in `lib/warehouse/stations.ts`.

## Time and measurement

**Session** — the atomic time record: one installer, one unit, a start, a stop. Sessions are what the app stores. Everything else is derived from them. A session stops at Finish, Block, Break, or Clock Out; only Finish closes the unit — the session follows the human, the unit waits.

**Labor-minutes** — total human minutes on a unit: every session (install and helper alike) plus its flash-run minutes. What cost estimating wants.

**Wall-clock** — calendar time from first start to last stop on a unit. What a customer asking "when will my house be done" wants.

Both are derived from sessions. Neither is stored directly. Storing an aggregate would destroy the other one permanently.

**Chain** — finishing a unit hands the running clock to the next unit on the installer's list rather than stopping it. Walk time and prep time are real install cost and are captured this way, attributed to the unit being walked to. Block hands off exactly the same way — one behavior to learn; only the ended session is marked differently. The chain suppresses on multi-tier units: finishing one stops the clock, and the next unit starts fresh by hand — a storefront's teardown is not walk time. The field app's finish-proposes-next flow is the chain's UX foundation, but its clock semantics are new: today the walk between units is recorded nowhere.

**Transition** — the part of a session between finishing one unit and starting work on the next. Inside the chain, accrues to the incoming unit.

**Block** — a unit stopped by something outside the installer's control: missing hardware, wrong glass, opening not ready, waiting on equipment. Recorded with a reason. Blocked minutes are excluded from install averages and reported separately. Without this, warehouse and GC failures get recorded as slow installation. A Block is a *time state*; a *blocker issue* is the reported problem — when the reason is a reported issue, the Block references it, so the accountability trail is one record.

**Rework** — work on a unit after its Redo button is pressed, for any reason: failed inspection, damage, wrong unit, customer complaint. Any installer can press Redo, reason required; the foreman is notified, never asked first — friction belongs on hiding problems, not on admitting them. The unit returns to the work list as open, visibly marked as a redo, until finished again. The fix is timed as its own rework-tagged sessions on the *same* unit — one opening is one unit, always — kept as separate data. Excluded from estimating averages; counted in a rework rate. The original install's sessions stand as evidence.

**On-tool** — the share of a shift spent inside sessions: session minutes ÷ worked shift minutes. A crew-level efficiency lens first; low on-tool across everyone means the schedule or the warehouse is the problem, not the people. Never shown to installers.

**Summon help** — a helper's stint on a unit after answering a Summon: a session like any other, in the helper role. The clock starts at the Answer tap — the walk over is part of what that window costs. Counts in labor-minutes *and* in install evidence — a four-man lift is real install cost for that signature, and pretending it took one installer would make heavy units look cheap.

**Record** — the full story of one unit, read back on its sheet: every install round (including sent-back and redo rounds, each with its media, memo, and grade), the session-by-session timeline in plain language, and the AI's contributions labelled as AI. Nothing in the Record is stored for it — it is a *reading* of what the atoms already hold. Raw facts about one unit are visible to every role; anything that *compares* (estimate vs actual, cohort averages, per-person rollups) stays foreman+.

**Void** — the word for deleting a punch (shift), settled Wave T: the row is never erased. It carries who, when, and why (`voided_at`/`voided_by`/`voided_reason` — columns of their own, separate from an ordinary edit's trail, because a punch that was both edited and later voided must never leave only one note field to say which reason was which) and leaves every total instantly. Restorable, by the same supervisor+ tier that can void: the app-wide five-second Undo toast for right after, a persistent Restore button on the "Show removed" list after that. Hard delete — erasing the row for good — is a separate, owner-only purge door, never this one.

**Sign-off** — the worker's attestation that one pay period's hours are correct, and the supervisor's countersign after it. Layered *on top of* per-punch approval, not a replacement for it: approval is per punch and can happen any time; sign-off is per two-Monday-week pay period and only once that period has actually ended — there is nothing to attest to yet while it's still running. A supervisor edit after a period is signed doesn't undo the sign-off; it notes "edited after signing" on the row instead, so the record stays honest without unsigning anything.

**Last seen** — where a phone was, and when, the last time the app was brought to the FOREGROUND while that shift was open. One point per shift — with the fix's own accuracy radius beside it — overwritten each visit, written by the person's own device through a self-only RPC. It is deliberately not a track: there is no background location in this app and there must not be, so "last seen" can only ever say "they had the app open at 4:12, fourteen miles from where they clocked in" — never where anybody went in between. Read back on the supervisor's "Still on the clock" list, and only when it is away from **where that punch started** (the one position a shift row carries of its own — not the job, because clocking in at the shop and driving to site is a normal morning) and only when the fix was precise enough to say so.

**Far from the job** — the soft, advisory judgement that a phone is nowhere near where this job's clock-ins actually happen (800 m by default, `farFromJob`). Silent whenever anything is uncertain — no fix, no reference point, or a fix too fuzzy to tell near from far — and it never blocks anything. On the clock it earns one question, once the app is opened: switch to Travel, or "I'm still here", which holds the question for an hour.

**Evening nudge** — the company-local time of day, 5:30 PM by default and a foreman's to move, when everyone still clocked in to a JOB cost code gets one push: "Still on the job?". Travel is skipped, because somebody on Travel is already doing the thing the push would ask for. Claimed once per person per local day, so a shift nobody ever closes is asked about each evening rather than once ever.

**Gusto file** — the pay-period hours file the office uploads to payroll: one row per employee for the two weeks, regular / overtime / double, with the overtime split per calendar week rather than across the whole period. It is a FILE the office uploads, never a live link to payroll — nothing in this app talks to Gusto.

**Graveyard** — a `X_graveyard` table, holding a straight copy of every row `X` had the moment before a clean-slate migration truncated it. RLS-enabled with no policies at all, so it is invisible to the app — nothing but a direct database connection can read it — and exists purely so the owner can look, or drop it, once he's satisfied nothing needs recovering. The pattern a payroll-data wipe uses in place of a dump file (this repo is public); a plain DELETE is still fine for data nobody needs a copy of.

## The estimation model

**Signature** — the structured, computed key a unit is grouped by. Composed from kind, mechanism mix (including slide count), panel count, moving/fixed split, corner (none/corner — the side is recorded but never grouped), story per tier, and inset/outset. Dimensions and handedness never enter it: sizes are continuous evidence, and mirror images share a cohort. Versioned, so definition changes never silently fracture cohort history. Never typed by a human. A free-text name cannot be grouped on; "Bifold 5 panel" and "5-panel bifold" are two cohorts forever. Inset/outset is a new field: the extractor reads it from the spec sheets and it is confirmed at spec review, like every other spec field.

**Cohort** — all units sharing a signature.

**Panel-level evidence** — the core estimating decision. Time is modelled at the panel, not the unit:

```
estimate = unit setup cost + Σ(panel cost × mechanism × story × inset/outset)
```

Rationale: cohorts at the unit level are too sparse to trust. We may install three 9-pane storefronts ever. But one such install yields nine panels of evidence across three story levels, and every bedroom window installed feeds the same model. This is what makes a defensible storefront estimate possible before we've installed many storefronts.

**Modifier** — a coefficient estimated by pooling across all unit types, not per-cohort. The story-2 penalty is learned from every unit ever installed above ground level. Data-efficient: trustworthy after ~dozens of units rather than dozens of one specific cohort.

**Fallback ladder** — when a cohort is thin, fall back a rung: exact signature → same kind + panel count → same kind → global. A rung's number is shown at n ≥ 5; below that, fall to the next rung. The rung and its sample count are always displayed ("same kind · n=23") — the label is the real safeguard, not the threshold. When even the global rung is under n = 5, show "no estimate yet · N installs recorded" and accept a clearly-labelled manual estimate — never a computed number dressed as data.

## Standing decisions

- Sessions are the stored atom. Aggregates are always derived.
- One opening is one unit, regardless of story span.
- Unit weight comes from Strata on the order, requested per panel where possible, since the panel is the evidence unit.
- Finish never stops the clock; it proposes the next unit and remains changeable for a few minutes.
- Blocked is a first-class exit from a unit, alongside Finish and Break.
- Break and Clock Out hold the current unit open. A unit survives across days and across installers.
- Installer-vs-average is never visible to installers — foreman and above only. Revisit only if quality grading becomes QC-verified instead of self-rated; a speed ranking against self-rated quality degrades the very data this system exists to produce.
- Flash-run minutes are a sibling record, not a session: in labor-minutes, never in the install average.
- Summon help is sessions on the unit, counted in install evidence.
- Ending a break puts the installer straight back on the held unit — a minute or two of walk-back inflation accepted for zero friction (owner call).
- Sessions ship as the first installer-facing flow; there is no migration, because there was never an installed base (ADR-0003).
- The installer's first screen is one tap: clock in and land on the recommended window; the window's own gates (toolbox, before photo, flashing) stay on the sheet. The recommendation never points at a session-blocked unit.
- Nothing stores its own location. A package's location is the container holding it; a unit's location is where its packages are. One question, one answer, nothing to reconcile (ADR-0004).
- Every package lives the same six stages, whatever is inside it. A crate is a container, not a stage.
- Completeness is read off the manufacturer's part numbers, never assumed. The app says "2 of 3 here"; it never guesses that a unit needs a threshold.
- Warehouse is one screen. Actions open over it and never navigate away — the tab-switching was the symptom, two location models were the disease.
- Stickers and crate identities are never reused; both are cheaper than a trail that lies.
- Nothing about a mismatch stops the receiving line. Wrong-job checkouts warn loudly and require a reason, but are never blocked — a blocked scan is a scan that stops happening.
- Existing stock is tagged when someone touches it, not in a big-bang pass. The untagged count is the progress bar.
- One chain. Packages are the only material record, planned per window number; the unit chain — pre-issue, `window_units`, Receive-by-unit — retires (ADR-0005).
- Labels mint at declaration, pre-bound to job + window + part, and print in one batch. Receiving is sticking, not typing.
- An area is a pointer, not a place: options depend on the kind of box, every move clears it, foreman+ sets it (ADR-0006).
- Slots stay parked until the physical reorganization. Nothing new points at them until then; areas are the interim.
- The Boneyard keeps its name. The crew's word beats a cleaner word the crew would have to learn.
- Container moves are movement events, never edits. The main warehouse never moves.
- Splitting a unit's packages warns and is counted, never blocked — a frame on site while its glass waits is sometimes the job.
- Burn is for labels that never lived; Reprint is for packages that did. One action covering both would eat history.

**Rewrite a set** — wave R (2026-08-28, the Mad Moose story: a manifest
said mark #8 was 16 packages; the truck actually had 12 pieces of glass in
one crate plus 4 frame packages). Fixing a wrong declaration by hand meant
editing fifteen slot cards one at a time. Rewrite a set replaces that with
declaration-diff: the whole set is declared at once, as a short list of
{count, part type, packaging} lines, and one apply (`rewrite_set`) diffs
that declaration against reality and makes it so, atomically. Arrived
pieces never die by arithmetic — a shrinking line releases only its
never-arrived (`minted`) placeholders; if a line's new count would fall
below what has already arrived, the whole apply refuses rather than delete
real material. Retyping is free for expected material; for arrived
material it is allowed only when a whole line vanishes and exactly one new
line can unambiguously take it — anything less clear-cut refuses too.
"Start this set over" is the literal factory reset, still just
`delete_packages` on everything in the set, blank declaration after.

## The daily log

Settled 2026-08-26, wave L. One log tells one job's one day.

**Daily Log** — one per job per day, filed by a foreman, upsertable by any
foreman on that job (Q6: ONE shared log, not one per foreman — the row
remembers who touched it last). The day's story: what got done, how the
day flowed, anything worth words. Readable by foreman and up only;
installers never see it — by RLS (Q7), not just a hidden tab. Starts as a
draft that writes itself (headline, notes) from the job-day's shifts,
sessions, and redos, fully editable before it's ever saved.

**Day-flow** — Smooth / Fine / Stuck, the three-tap temperature of a day.
Picking Fine or Stuck opens four optional one-line reflections (what went
well, what went poorly, what would have helped, what's worth doing again);
Smooth clears them at save. Never a second required field — notes is the
Daily Log's only hard gate.

**Log coverage** — logged worked-days ÷ all worked-days, overall or per
job (a worked job-day is any shift or session on that job, that local
day). Surfaced today as one line for owners on Heartbeat; wave S's later
reviewer flow reads the same ratio at a 70% bar before it lets an outsider
read anything a Daily Log says.

## The partner wall

Settled 2026-08-26/27, wave S. A builder or GC gets a login too — outside
the crew entirely.

**Partner** — a builder's login (branded STG Windows & Doors, the owner's
outward brand — see Q9). Sees only the STG view (job progress, calendar,
tap-a-day) and only the jobs granted to it; never a crew screen, never a
crew table directly, under any role or rank. `profiles.is_partner` is the
flag; a partner's `role` reads 'installer' (the rank floor), but rank
stops being what decides anything the moment `is_partner` is true —
`is_partner_user()` walls off every crew table ahead of any rank check
(THE WALL, 20260950000000). Server-enforced, not just hidden nav: the
router's redirect to /stg is manners, the RLS sweep is the wall.

**Grant** — the owner handing one job to one partner login
(`partner_job_grants`, one row per pair). Explicit and per-login (Q12) —
there is no builder-orgs table in v1, so two people at the same GC each
need their own login and their own grants. Owner-only to create or revoke
(Q13), same floor as handing out a crew login.
## Crew scheduling and the AI assistant

Settled 2026-08-27, wave A (grilled across two rounds — cite, never
re-decide). The AI helper gets hands here for the first time: it can write
real draft crew assignments, but only drafts, and only at the caller's own
permission level (PERMISSION MIRROR — the scheduling tools refuse below
supervisor rank with a plain sentence; no new power enters through the chat
door).

**Saved crew** — a named team (2-6 people) a supervisor built on the Roster
because it works together. A SOFT law for the scheduling AI: it keeps a
saved crew together to the best of its ability, and when it can't, it must
say so plainly in its answer ("I split Team 1 — Sam covers Sand Hollow
alone") rather than splitting one silently.

**AI-proposed** — a draft the assistant wrote (`schedule_assignments.
created_via = 'ai'`), badged on the crew board until published; the publish
records that a human approved an AI plan. The flag itself is permanent —
publishing never clears it, so the audit trail outlives the badge — only the
CHIP's visibility is draft-scoped. `draft_assignments` (the AI's one write
tool) can never publish anything itself; a human always does that step.

## Receipts that read themselves

Settled 2026-08-28, wave P (grilled, cited in the spec's opening block —
never re-decided). A Horizon port: OCR fills a receipt, a human confirms it.

**Receipt** — a snapped purchase photo plus what the machine or a human
could tell about it: amount, vendor, purchase date, category, whether it
bills to the customer. ANYONE signed in may file one; the job is optional
(gas is often jobless) — a receipt uses the same waiting-job convention
packages.pending_job_name already established: a real job, a typed name for
one not built in the app yet, or neither.

**Fill-missing-only** — THE LAW this wave exists to enforce: the machine
never overwrites a human's typing, full stop, no exception. A null field
takes a machine reading; anything already set — by a human or by an
earlier machine pass — stays exactly as it is. Enforced in exactly one
place, atomically, in SQL (`apply_receipt_extraction`) — never
client-computed-then-written, because a read-then-write from anywhere else
can race a concurrent human edit.

**category_by** — the one field with a provenance lock: `ai` (a machine
guess) or `manual` (a human typed or flipped it — locked forever after,
immune to every future rescan). Every other extracted field (amount,
vendor, date) has no such lock; fill-missing-only protects them by never
overwriting a non-null value in the first place, machine-set or not.

## Trash and the 30 days

Settled 2026-08-28, wave D. Deleting a job is owner-only, and it is never
instant: `trash_project` sets `deleted_at`/`deleted_by`; `restore_project`
undoes it within 30 days; `purge_project` is the permanent erase, run by the
owner directly or by the nightly sweep (`purge_expired_projects`, pg_cron)
once the window has actually closed. A trashed job's own row is invisible to
everyone but the owner (RLS) — that invisibility *is* the trash list.

**Detach** — the purge's other verb besides delete. A handful of tables
carry legal-retention weight a 30-day undo can't waive: `time_shifts`
(payroll — an installer must be able to dispute a paycheck years after the
job that earned it is gone), `receipts`, `job_costs`, and `change_orders`
(money records, tax audits), `incidents` (OSHA-style safety retention), and
`daily_logs` (a foreman's day-by-day account, dispute and insurance
evidence). These rows are never deleted — the purge nulls their `project_id`
and copies the job's name into a `job_name` (or `pending_job_name`) text
column first, so "worked on PECAN14" still reads that way after PECAN14
itself is gone. Physical-thing tables detach the same way for a different
reason: `windows`, `packages`, `movements`, `service_cases`, and a photo
anchored to a surviving window/package/service case — the glass, the box,
the scan history, and the warranty case are real objects a deleted job row
can't make disappear. Everything else — openings, plans, marks, chat,
schedule slots, summons — purges outright; the 30-day window is the only
undo it ever gets.

**Passthrough** — the upload flow's one skippable question, "bill this to
the customer?" Answered at snap time or left null forever; the office can
flip it later. Not an OCR field — always a human's own yes/no.

## Maps Interactive

Settled 2026-08-28, wave V-B. The official pipeline, once plans are in:
trace the building → place and confirm marks on the sheet → refine the
model in Studio → Submit final, which becomes the crew's live 3D map.

**True north** — `northDeg`, a clockwise-degrees-from-plan-up offset set by
hand in the tracer's "Set north" mode and stored in `features.fitview`
alongside its calibration; display-only, it only rotates the mini-map's
compass rose and renames new wall submissions, never the 3D scene's own
geometry. Every writer of `features.fitview` merges instead of replacing, so
it (and everything else already there) survives an edit made anywhere else.

**Pane grid** — wave G (2026-09-01, the Mad Moose mark 7 story: a real
storefront — three stacked fixed lites beside a transom-over-door column —
rendered as four equal panels everywhere, because `extra.panels` is a flat
ONE-ROW strip and the schema itself can't say "stacked"). `pane_grid` on a
mark's `project_mark_specs.extra` (jsonb, no migration) is the additional
description that fixes this: column-major, because storefronts are built as
mullion columns, each column a list of segments read top to bottom (F
fixed, X operable, "door" a swing leaf with a hinge/meet `leaf` of L/R —
window-vendor-conventions.md's vocabulary). `lib/fitview/paneGrid.ts` is the
one place either renderer (the elevations view, the Studio unit face) reads
its raw shape — both draw only from its resolved, normalized cell list.
`pane_grid` never replaces `extra.panels`; both coexist on the same row, and
a mark with no `pane_grid` renders exactly the flat single-row layout it
always has — the fallback law, proven end to end for both renderers.
Filled the same way a rescan fills any other spec field (the receipts
precedent): fill-missing-only, a re-run of specs extraction never
overwrites a `pane_grid` that's already there.

## Vision placement

Settled 2026-08-28, wave V-A (the Mad Moose story: schedules knew the windows;
nothing knew where they lived). A foreman taps "Find placements" and AI vision
reads the building plan-set's floor-plan pages for every still-unplaced
schedule mark, never automatically — the cost stays a deliberate tap.

**Suggested vs confirmed** — vision placement writes a SUGGESTED pin
(`suggested_pin_x`/`_pin_y`/`_page_number`/`_at`/`_confidence` on
`project_openings`), never a real one. A suggestion renders as a dashed,
hollow dot in the trace tool's review tray — visually distinct from a solid
confirmed dot on purpose. Confirming (Confirm all, or dragging one dot) is
what promotes it: the same `pin_x`/`pin_y` columns ProjectMap's drag already
writes, gated the same foreman+ way. Dismissing clears the suggestion without
creating a placement, so the mark is free to be suggested again later.

**Plans place, they never count** — CAD-WINS, unchanged: schedules own
quantities, plans own positions. Vision placement locates existing marks only;
a plan callout matching no schedule mark is reported, never turned into an
opening. A mark it can't find on the plan simply stays unplaced.

**Rerun replaces unconfirmed only** — the receipts precedent, reapplied: a
mark with a real pin (`pin_x` set, however it got one) is never touched by a
later Find placements run — enforced atomically in `apply_placement_
suggestions`. A dismissed suggestion has no real pin, so it is fair game for
the next run to suggest again; dismiss means "not now," not "never."

## Studio wall tools

Settled 2026-08-31, wave W (grilled, owner's own design for the acceptance
bar — cite, never re-decide). Drag-to-draw and angle-snap join the vendored
floorplanner's existing click-click drawing; Publish stops dropping walls
that aren't the outer loop.

**Interior wall** — a partition or free-standing wall Publish used to walk
past and drop. The crew map treats one as JUST ANOTHER WALL STRIP: it
appears in the elevation walk after the exterior loop, highlights like any
wall, carries units, and is labeled "Interior" on its chip (e.g. "B1 ·
Interior 1"). Both faces of an interior wall are physically real, but
Publish writes ONE strip per interior wall — units on either face render on
that strip — the simplest honest model, not a claim that a wall has one
side. Exterior publishing's shape never changes because of this: the
silhouette (`outerPolygons`) is untouched code, only re-read afterward to
find what it did NOT consume.

**Custom mark** — a mark born in Studio instead of from a plan or a
schedule import: a "+ Add window"/"+ Add door" unit a supervisor names
(code + window/door + W×L) rather than leaving as a Studio-only decoration.
CAD-WINS is unchanged by this — extraction still never invents a mark.
Humans may, deliberately, naming one is only a draft, and Submit final's
confirm dialog is the deliberateness: it lists exactly which codes are
about to become real openings ("Adds 2 new marks to this job: D-11, W-A")
before it happens. Once confirmed, a custom mark is registered through the
same paths a plan-placed one would use and glows/assigns/QCs identically —
nothing downstream can tell an opening was born in Studio.

## Video quizzes

Settled 2026-09-01, wave Q (grilled, Q1-Q4 approved — cite, never
re-decide). A learning video can carry a 5-question quiz, generated from its
transcript and drawn on to check whether a crew member actually learned the
lesson.

**Transcript source** — paste (YouTube's own transcript panel, copied by
hand) or, for an uploaded file, Whisper transcribing our own stored copy.
The app never fetches YouTube itself: its caption endpoints answer a real
browser's UI, not a server-side request, so an edge function reaching for
one gets nothing back. Links stay YouTube-only, same as before this wave.

**Draft-first** — a supervisor's Generate produces a draft (summary +
questions) nobody but a supervisor can see; only Approve & publish copies it
onto the live, crew-visible quiz and the video's own summary. Regenerating
always makes a new draft — it never touches what crews are currently
quizzed on until the NEXT approval. The crew-board drafts precedent
(wave A), reapplied here.

**Server-scored** — correct answers never reach a client that has not
already submitted. The crew-facing read strips them entirely; scoring,
the attempt record, and the pass/fail verdict all happen inside one
SECURITY DEFINER RPC (`submit_video_quiz`), never client-computed. Pass is
4 of 5, retakes are unlimited and reshuffled, and a first pass pays points
the same way the Education Quiz tab does.

**Clearance hook** — a video may name a window type ("passing this quiz
clears the installer for…"); a first pass grants it through the same write
`setClearance` performs — the hook the app had built but never called until
this wave wired it up.

## Field truth

Settled 2026-09-03, wave E (transcripts program, Q12 + Q18 — grilled and
approved; cite, never re-decide). What the crew says about a unit when the
paperwork and the building disagree.

**Data off** — the unit is fine, its RECORD is wrong. One tap on the opening
sheet, a reason (`flag_kind`: wrong size, mirrored, not as drawn, not on the
plans, something else) and an optional note, on the same `flag_note` /
`flagged_by` / `flagged_at` columns the free-text flag always used — so every
flag raised before reasons existed reads as "something else", because nobody
was ever asked which kind it was and guessing one would invent history. It
NEVER blocks Finish: "done, data off" is the ordinary case, and the whole
point is that saying so costs nothing. It is about the record and not the
work, so it outlives the install and the QC pass — amber on the map beats
green — and stays until a foreman clears it, which is a claim that somebody
went and checked (`clear_opening_flag` is foreman+; raising one is anyone).
A data-off unit's install never enters a cohort average or the estimating
health counts: the minutes are real, but what they are minutes OF is not.
Excluded WITH its reason and counted as the data-off rate, so the evidence
pool can never quietly shrink with nobody able to say by how much.

**Missed unit** — a window or door the paperwork never had, added by whoever
is standing in front of it. `add_field_unit` checks PRESENCE, not rank: an
open shift on that job is the permission, because the person who can see the
hole is the person who should be able to record it. It becomes a real opening
coded "Missed N" with its own mark spec (source `field`), a photo, and
`flag_kind = not_on_plans`; it lands where the map was tapped, or unplaced
when there is no map. The N is issued once per job and never handed out
again — not after a rename, not after a removal — because the number is what
its measurements are filed under, and two units sharing one would put the
first one's width and height on the second one's glass order. That flag is
also the one data-off reason that never holds a unit back from being
dispatched: it is not doubt about the record, it IS the record. Every
supervisor and every lead on the job is pushed the same minute. A supervisor
then Keeps it (renaming it once the paperwork catches up), Merges it into the
mark it turned out to be, or Removes it — the last two only while it carries
no sessions and no install, because after that the row is evidence and Keep is
the honest answer. `field_added` makes it
immune to every re-extraction sweep, permanently and independently of its
flag: the extractor may drop its own guesses, never a person's record.

## Money

Settled 2026-09-03, wave Z (grilled, Q3/Q4/Q5/Q16/Q17 — cite, never
re-decide). Money stopped being a rank and became a grant, and the
database started saying no.

**Sees costs / Sees pay** — the two things an owner can hand somebody
without making them an owner (`profiles.can_see_costs`,
`profiles.can_see_pay`). Sees costs opens the money tables — job costs,
change orders, a job's bid and target margin, receipts, the AI spend
meters — and with them /costing, /ai-spend and /receipts. Sees pay opens
pay rates and nothing else, because an office manager who books job costs
has no business reading what the crew earns. Neither is a role and neither
moves a role: the nav floors are unchanged, and a grant can only ever open
a door. Read back in SQL by `can_see_costs(uid)` / `can_see_pay(uid)`
(owner, or the flag), which is what every money policy calls — widening who
sees costs is one function, not fifteen policies. Written only by the
owner-only `set_profile_grants`, and never given to a partner login. Before
this wave the lock was the nav floor, which is not a lock: it is a hidden
button, and every crew phone could read the company's bids.

**Pay rate** — what one person earns per hour, from a given day
(`pay_rates`). A HISTORY, not a current value: a raise in March must never
reprice January, so the rate that counts for a shift is the one that was in
force the day it was worked. One row per person per start date, and no end
date — a rate runs until the next one begins, so ending one is writing the
next. Somebody with no rate on file is still costed, off the old role
table, and their line on the Cost screen says "estimated — no rate on
file" rather than passing a guess off as a fact. Readable only with Sees
pay; deliberately NOT readable by the person themselves, because payroll is
where you learn what you earn.

**Receipt posts to the job** — reviewing a receipt that names a job makes
exactly ONE `job_costs` line: materials, the amount off the receipt, dated
when it was bought, labelled with the vendor and the note, carrying
"billable to customer" through from the receipt's passthrough answer. One
receipt, one line, ever — `receipts.job_cost_id` is set once and never
cleared, so un-reviewing leaves the line standing (the money was still
spent) and the receipt reads "posted" from then on. Editing the amount
afterwards moves the line with it, in one place, by trigger. A card charge
matched to a receipt that names a job posts through the same bridge.

**Company card** — the statement, as a dropped-in FILE. No bank
credentials touch this app and none ever will; a live feed is parked with
the future QuickBooks link. Because no one knows what columns a given
export uses, the mapping step IS the design: the app guesses which column
is the date, the amount, the description and the cardholder, and a human
confirms before anything is imported. It asks a fifth question no header
can answer — whether this file writes a PURCHASE as a negative number,
which Chase, Amex and most card exports do because they are describing the
balance. Inside the app money out is positive and a refund is the negative
one, so the import flips the sign once, at the door, and everything after
it reads one convention. "The same charge" is the bank's own id when the
export has one, else a hash of date + amount + description + cardholder
with the line's occurrence number on the end — so re-importing an
overlapping file adds nothing, while two crew filling up at the same pump
for the same money on the same morning stay two charges. Auto-match pairs
equal amounts within three days, vendor overlap breaking ties, one charge
to one receipt — always a proposal until somebody presses the button.
Nothing auto-deletes, and every import is undoable as a batch that keeps
whatever somebody had already matched.

## The job pipeline

Settled 2026-09-03, wave J (transcripts program, Q8 + Q9 — grilled and
approved; cite, never re-decide). The stretch between winning a bid and the
first window going in, which used to live entirely in somebody's head.

**Ready state** — whether the site is ready for us to work: `not_ready` or
`ready`, and nothing in between. Every job that already existed is `ready`,
because nobody has ever been able to say otherwise about them and inventing a
red flag for six months of live work would be a lie. From here, a job that
somebody FILLS IN is Ready by default — the person typing it knows — and a job
that ARRIVES is born Not ready: an import from Monday, a tracking job built in
one tap from the clock-in. Nobody has walked those sites. It is a foreman's
call to change (`set_project_readiness`), it shows as an amber pill beside the
mode badge and never on top of it, and a Ready job wears no pill at all —
absence is the quiet state, so the card missing a sticker is never the one that
matters.

**Materials ETA** — the day the windows are expected on a job, and separately
`materials_arrived_at`, the moment somebody said they were here. Job-level, and
deliberately NOT `package_deliveries.expected_at`, which is one truck's ETA:
merging them would make an early pallet look like the whole order landing.
Marking them arrived is one 48px tap and pressing it twice does not move the
time, because the first tap is when the truck actually showed up. An ETA that
passes with nothing arrived is the one pipeline fact that matters whatever the
start date says — late glass is late whether the job starts next week or next
spring.

**Needs a call** — the app's judgement that somebody should pick up the phone
about a job, and the single rule behind both the chip on the Jobs page and the
7 AM push. A job needs a call when it starts within a fortnight and is still
Not ready or its promised windows have not turned up, or when its promised ETA
has passed with nothing here. A PROMISE IS HALF THAT RULE: windows only count
as missing once somebody has put an ETA on the job. Without it there is nothing
to be late for, and on the morning this shipped there was no ETA anywhere —
counting a blank as "no windows" would have called every job in the company
late on day one. The rule is `needsCall` in `app/src/lib/pipeline.ts` and again in
SQL inside `claim_pipeline_nudges()`, because a sweep has to decide and claim
in one statement; a test named after that function pins the two together. The
sweep says each thing ONCE, keyed to the day it is about — a start date, a
missed ETA — never the day it was sent, so a missed morning does not lose a
warning and a moved start date earns a fresh one. Wave H adds a fourth reason
(no GC check-in in 14 days); until its table exists that reason is UNKNOWN and
never counts against a job, because "nobody has logged a check-in" is true of
every job in the company and is not news.

**What a builder can see of it** — nothing, and that was a correction. All four
pipeline facts started as columns on `projects`, which is the one table a
builder (partner) login reads whole for the jobs they were granted. That is
row-level and has no column-level half: a column there is readable by a granted
builder, now and forever after. Wave J allowed it, reasoning that readiness and
the materials dates are facts about the builder's own house. Wave H moved three
of them straight back out (`project_pipeline`, 20260981000000) because the
reasoning had the question wrong. It is not "is this fact sensitive"; it is "is
this fact ABOUT US". "Not ready" is a note we write to ourselves about a site
nobody has walked yet — read by the builder who owns that site, it is an
accusation, and "your windows still are not here" is the sentence this whole
handshake exists to let us say ourselves, in our words, at a moment we chose.
Only `sort_order` stayed: an integer that means nothing outside a list a builder
cannot see. So anything genuinely ours — a price, a margin, a cost, a wage, our
own state of readiness — goes in a table of its own with its own policy, the way
the bid and target margin moved to `project_financials`. Two waves in a row got
this wrong in the same direction; the third should not have to.

## Open questions

None right now — the next ones come from building.


## Out of scope for the current effort

Customer-facing completion estimates, product recommendations, and installer quality scoring. All real, none of them this map. They depend on clean data that doesn't exist yet.
