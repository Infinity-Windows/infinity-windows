# CONTEXT.md

Shared language for the Infinity Windows ops app. Agents and humans both read this. If a term here has a definition, use the term — don't re-describe it.

Seeded 2026-08-15 from the per-unit clocking planning session. Living document: challenge terms that don't fit, and update rather than working around them.

## The domain in one paragraph

Infinity Windows installs windows and doors. A project builder models every opening in Studio before it goes to the field. Installers work a list of units, clocking each one start-to-finish. The purpose of that clocking is to build a body of real time data good enough to estimate future jobs, evaluate products, and find where time is actually lost.

## Core nouns

**Unit** — everything that fills one opening: frame package, panes, panels or doors, and the hardware required. One opening is always one unit, even when it spans multiple stories — an opening can't be left unfilled for a customer, so it's one installer's responsibility from start to finish. A unit arrives as several **packages** and is only ready to install when all of them are on hand.

**Panel** — one leaf of a unit. Has a width, a mechanism (fixed, slider, casement, hung, bifold), and for moving mechanisms a direction. The panel is the unit of evidence, not the unit — see Panel-level evidence.

**Tier** — a horizontal row of panels within a unit, at one story. A 9-pane storefront across three floors is one unit with three tiers of three panels. Studio's current model is flat (one `heightMm`, one `panels[]` array) and cannot express this; fixing that is open work. Studio's `rows[]` are pane breaks — glass divisions *within* a tier — not tiers; don't conflate them.

**Story** — which floor a tier sits on. Ground level is story 1. Story lives on the tier; a single-tier unit (almost every unit) inherits its opening's story.

**Opening** — the hole in the building. One opening, one unit.

**Flash Run** — flashing performed as its own pass, usually by a different installer on a different day. Its minutes are a sibling record on the unit (not a session): they count in the unit's labor-minutes, but never in the install cohort average — flashing carries its own per-panel modifier.

## The warehouse

Settled 2026-08-17. The warehouse answers one question — *where is it* — and records one thing — *who moved it*. Everything below serves those two.

**Package** — one physical piece of a unit: its frame, its glass, its hardware, its threshold. The package is what carries a sticker, what sits somewhere, and what moves; a unit never moves, its packages do. Every package runs the same six-stage life regardless of what's inside it: blank sticker → tagged → stored → checked out → on site → installed.

**Part number** — the manufacturer's "N of M" printed on a package: `#16 2/3` is the second of three packages making up unit 16. M is the number of packages that unit was built as, and it varies — some units are one package, some are six. Because M is printed on the very first package to arrive, the count of what's still missing is knowable from the first delivery onward, without anyone declaring it in advance.

**Container** — anywhere a package can sit: a conex, a crate, a shelf spot, a truck. Containers hold packages and may sit inside one other container, never deeper. Moving a container moves everything inside it in one action — that is the whole reason a container is worth tracking.

**Conex** — a shipping container used as warehouse storage, on the yard or on a site.

**Crate** — a small container, usually holding glass for units with no pre-assembled frame. A crate is a *place*, not a package: it holds packages and has a location of its own. Crates are broken down and rebuilt, so a crate's identity dies with the physical crate.

**Sticker** — an Infinity-printed label bound to exactly one package, for that package's whole life. Printed blank in batches, bound once when the package is tagged, and never reused — a reused sticker would make every earlier record point at the wrong physical thing.

**Tagged** — a package that has been bound to a sticker, a unit, and a job. Until tagged, a package is untracked and cannot be found by anyone who didn't personally put it down.

**Checkout** — a package leaving storage for a job, with a reason recorded. Checking out is per-package, never per-container: an installer takes the four packages they need and the crate stays where it is until it is empty.

**Loose stock** — an on-hand package with no container and no shelf spot. The genuinely-cannot-find-it pile, and the number that says how much the warehouse is drifting.

**Home spot** — the one place a supply lives, so it can be told to someone: *"Caulk · Bin A3."* Supplies are countable and identical, so they have a home spot and a rough count rather than individual stickers.

**On hand** — how much of a supply we believe we have. Always an estimate, always shown with when it was last counted, because it is decremented by what installers say they took and corrected only by counting.

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

## Open questions

None right now — the next ones come from building.


## Out of scope for the current effort

Customer-facing completion estimates, product recommendations, and installer quality scoring. All real, none of them this map. They depend on clean data that doesn't exist yet.
