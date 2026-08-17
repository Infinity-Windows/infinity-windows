# CONTEXT.md

Shared language for the Infinity Windows ops app. Agents and humans both read this. If a term here has a definition, use the term — don't re-describe it.

Seeded 2026-08-15 from the per-unit clocking planning session. Living document: challenge terms that don't fit, and update rather than working around them.

## The domain in one paragraph

Infinity Windows installs windows and doors. A project builder models every opening in Studio before it goes to the field. Installers work a list of units, clocking each one start-to-finish. The purpose of that clocking is to build a body of real time data good enough to estimate future jobs, evaluate products, and find where time is actually lost.

## Core nouns

**Unit** — everything that fills one opening: frame package, panes, panels or doors, and the hardware required. One opening is always one unit, even when it spans multiple stories — an opening can't be left unfilled for a customer, so it's one installer's responsibility from start to finish.

**Panel** — one leaf of a unit. Has a width, a mechanism (fixed, slider, casement, hung, bifold), and for moving mechanisms a direction. The panel is the unit of evidence, not the unit — see Panel-level evidence.

**Tier** — a horizontal row of panels within a unit, at one story. A 9-pane storefront across three floors is one unit with three tiers of three panels. Studio's current model is flat (one `heightMm`, one `panels[]` array) and cannot express this. Fixing that is open work.

**Story** — which floor a tier sits on. Ground level is story 1.

**Opening** — the hole in the building. One opening, one unit.

**Flash Run** — flashing performed as its own pass, usually by a different installer on a different day. Its minutes belong to the unit even though the unit was already marked finished.

## Time and measurement

**Session** — the atomic time record: one installer, one unit, a start, a stop. Sessions are what the app stores. Everything else is derived from them.

**Labor-minutes** — total human minutes across all sessions on a unit. What cost estimating wants.

**Wall-clock** — calendar time from first start to last stop on a unit. What a customer asking "when will my house be done" wants.

Both are derived from sessions. Neither is stored directly. Storing an aggregate would destroy the other one permanently.

**Chain** — finishing a unit hands the running clock to the next unit on the installer's list rather than stopping it. Walk time and prep time are real install cost and are captured this way, attributed to the unit being walked to.

**Transition** — the part of a session between finishing one unit and starting work on the next. Inside the chain, accrues to the incoming unit.

**Block** — a unit stopped by something outside the installer's control: missing hardware, wrong glass, opening not ready, waiting on equipment. Recorded with a reason. Blocked minutes are excluded from install averages and reported separately. Without this, warehouse and GC failures get recorded as slow installation.

**Rework** — a unit reinstalled after failing inspection. Recorded as a separate unit record, labelled as rework. Excluded from estimating averages; counted in a rework rate.

## The estimation model

**Signature** — the structured, computed key a unit is grouped by. Composed from kind, mechanism mix, panel count, moving/fixed split, story per tier, and inset/outset. Never typed by a human. A free-text name cannot be grouped on; "Bifold 5 panel" and "5-panel bifold" are two cohorts forever.

**Cohort** — all units sharing a signature.

**Panel-level evidence** — the core estimating decision. Time is modelled at the panel, not the unit:

```
estimate = unit setup cost + Σ(panel cost × mechanism × story × inset/outset)
```

Rationale: cohorts at the unit level are too sparse to trust. We may install three 9-pane storefronts ever. But one such install yields nine panels of evidence across three story levels, and every bedroom window installed feeds the same model. This is what makes a defensible storefront estimate possible before we've installed many storefronts.

**Modifier** — a coefficient estimated by pooling across all unit types, not per-cohort. The story-2 penalty is learned from every unit ever installed above ground level. Data-efficient: trustworthy after ~dozens of units rather than dozens of one specific cohort.

**Fallback ladder** — when a cohort is thin, fall back a rung: exact signature → same kind + panel count → same kind → global. Sample count is shown in the UI so a foreman knows whether to trust the number. Minimum sample count for showing a number is undecided.

## Standing decisions

- Sessions are the stored atom. Aggregates are always derived.
- One opening is one unit, regardless of story span.
- Unit weight comes from Strata on the order, requested per panel where possible, since the panel is the evidence unit.
- Finish never stops the clock; it proposes the next unit and remains changeable for a few minutes.
- Blocked is a first-class exit from a unit, alongside Finish and Break.
- Break and Clock Out hold the current unit open. A unit survives across days and across installers.

## Open questions

- Exact field list composing the signature.
- Whether story lives on the tier, the opening, or the project.
- Minimum sample count before a cohort average is shown.
- Whether flash-run time is a session on the unit or a sibling record.
- Whether installer-vs-average is ever visible to installers. Caution: the moment installers know they're ranked on speed, the timer stops measuring install duration and starts measuring what they want us to see — degrading the estimating data this whole system exists to produce. Quality is currently a self-rating, which compounds this.

## Out of scope for the current effort

Customer-facing completion estimates, product recommendations, and installer quality scoring. All real, none of them this map. They depend on clean data that doesn't exist yet.
