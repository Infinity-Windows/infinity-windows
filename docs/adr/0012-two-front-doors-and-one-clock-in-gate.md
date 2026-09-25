# ADR-0012: Two front doors, one set of records, and one clock-in gate

Date: 2026-09-23. Status: accepted (owner-approved crew redesign spec,
Release 1 — `.scratch/crew-redesign/crew-redesign-spec.md` K-X2, K1.1–K1.9;
grill log Q1–Q9, the Q64 owner change and Q69).

## Context

The crew redesign gives installers and foremen a new front door — a Work
screen that answers "clocked in? where? what's next?", a Schedule tab, a
five-tab phone bar without a Clock tab — and the owner decided how it
reaches people: "roll out the new design option to everybody to have the
option to switch to. But still have the old option as well." So the old
screens do not go away, some people will be on each design on the same day,
and payroll and reports must see one company.

The owner also set a rule about time: "paid time starts the moment someone
starts the toolbox talk". Today the first clock-in of the day is refused
until the talk is signed (`clock_in`'s gate, 20260813000000), so the talk is
read off the clock. The rule reverses that order — and it must switch on for
everyone at once, on a date the owner picks at the start of a pay period
(Q69), never per person and never for a shift already recorded.

## Decisions

1. **Two designs, one app, one database.** A person's front door is
   `profiles.ui_design` ("classic" | "new"), written only by the self-scoped
   `set_my_ui_design` (the language column's shape). The owner's master
   switch per release, `company_settings.new_design_r1_enabled`, wins over
   every choice — off means everyone is on classic at once; choices are kept
   for when it comes back. The pure rule is `lib/design/design.ts`
   (`resolveDesign`); an unknown master switch (no signal, an older database)
   reads as ON so a phone in a dead spot is never bounced back to classic in
   the morning. The resolved answer is cached on the device for the first
   paint, the same way the language is.

2. **The classic screens are frozen; a new design screen is a new file.**
   `RoleLanding` and `/my-schedule` fork on the design; `bottomBarForRole` and
   `menuForRole` take it as an argument and leave the classic branch byte for
   byte as it was (nav.test pins this). Work, the Schedule tab and their
   sheets live under `pages/work/` and `components/work/`; the classic
   landings gained exactly one thing, the one-time "Try the new Forge" card.
   Both designs call the same writes — the same `clockIn`, the same outbox,
   the same custom-work commands, the same `create_issue` — so there is
   nothing to reconcile.

3. **The new screens' strings ride in their own chunk.** The entry chunk sits
   a hair under its budget (`scripts/check-bundle-budget.mjs`), and Release 1
   adds a hundred-odd strings. `lib/i18n/workCatalog.ts` (and
   `designCatalog.ts` for the settings card) register themselves into the live
   catalog when their chunk loads; `TKey` includes their keys through a
   type-only import, so `t("work.…")` is checked like any other key while the
   entry pays nothing. Settings itself left the eager shell for the same
   reason — it is the one shell screen nobody needs at 6 AM with no signal.

4. **Start day is a plan, decided in one place.** `lib/work/startDay.ts`
   turns three facts — a talk exists, it is signed, the paid-time rule is on
   — into one of three plans: clock in; the talk first and its signature is
   the clock-in (today's timing); or clock in first and sign on the clock
   (the owner's rule). Unknown facts fail OPEN to "clock in": the server is
   the backstop, and a talk that could not load must not strand a crew who
   may already be signed. Unit work is locked only on a POSITIVELY known
   unsigned talk, in words, never by a greyed button alone.

5. **One clock-in gate, one unit-work gate.** `_toolbox_gate_open(uid)`
   (20261031000000) is the single copy of "may this shift begin": today's
   signature on record, OR the owner's date has arrived. All six `clock_in`
   overloads call it: the five older ones re-issued verbatim, and Release
   0's keyed overload (20261028000000 — the client id, the mode and the tap
   time; the one the app calls) restated from that migration's final body
   with only its inline check swapped for the gate, so the rule opens the
   door the phone actually uses (Codex review of #642, 2026-09-25). The rule
   cannot be forgotten by one path; any later overload keeps calling it.
   Unit work has its own gate, `_unit_work_gate(uid)`
   — today's signature and never the date — called by every RPC that starts
   a timer on a unit: `start_opening_work`, `start_opening_phase`,
   `start_unit_session`, `resume_opening_phase`, `custom_work_command`'s
   unit start (Current Work, the new Work screen and the AI field tool
   `start_unit_work` all end there) and `answer_summon` (its trigger opens a
   helper session). It had to be put BACK: 20260969000000 had dropped the
   signature check from the first three because "an open shift proves the
   talk is signed", which is exactly what the paid-time rule stops being
   true — the practice-run probe caught it. This is what makes "unit work
   stays locked until signed" true on the server and not only on the screen.
   Prep time waits for the same signature (the owner's answer, 2026-09-24:
   "exactly like unit work" — it is paid job work, and the talk is the safety
   step for the day, not for one window): the one path that starts it,
   `custom_work_command`'s start with no unit — Work's Prep time button,
   Current Work and the AI field tool `start_idle_time` all end there — calls
   `_prep_time_gate(uid)` in the same place, refusing in its own sentence,
   "Sign today's toolbox talk before starting work." Breaks, clock-out and
   the break-end resume are not gated: they end or continue time, they never
   start work. Servicing's visit timers (`service_visit_command`) are left
   alone — none of its kinds pass the unit-work gate either. All three gates
   read one `_toolbox_signed_today`. On the phone, a start refused for the
   signature is the one refusal `useWork.command` throws to the tap and drops
   from the queue (nothing was written, and a retry after signing would carry
   the unsigned tap's time); every other refusal stays queued for review.

6. **Payroll never reads the rule.** The rule changes WHEN a shift begins and
   nothing else. `paidTimeRule.test.ts` totals the same fixture shifts —
   straddling the effective date — with the rule off and on, through
   `shiftHours`, the export rows, the weekly overtime split and the Gusto
   CSV, and gets identical output; a structural test fails if any payroll
   module ever imports the rule.

7. **Prep time is a display rename.** `custom_work_sessions.kind = 'idle'`,
   the stored stage `"Idle time"` and the AI tool `start_idle_time` are
   unchanged; every user-facing occurrence says Prep time / "Tiempo de
   preparación" (one Spanish term, replacing two), with six one-tap reasons.
   The AI's tool description teaches both names.

8. **The crew screen rule is tested, not promised.** `lib/work/
   crewScreenRule.test.ts` reads `work.css` for 48px targets (56px primary),
   16px text and word-carrying states; `e2e/new-design-work.spec.ts` and
   `schedule-offline.spec.ts` measure the rendered screens for the same, plus
   a 4.5:1 contrast ratio, on a 375×667 phone. Change a size and the tests
   say why not.

## Consequences

- Rollback of the new design is one owner tap; rollback of the paid-time rule
  is clearing one date. Neither touches a record.
- Two landings exist until the owner retires the classic one (the spec's
  recommendation: review after 60 days with the K-X3 task timings). Until
  then a fix to a shared behaviour goes in the shared lib, not in one design.
- Anything added to the new screens' strings goes in `workCatalog.ts`, and
  any new component under `components/work/` imports it for its side effect.
- Release 0's clock integrity (#640, which merges first) is under this, and
  Start day does not inherit it for free: the tap that starts the day — the
  signature, when signing is the clock-in — stamps ONE punch (the one-time id
  and the tap time) before the geolocation wait, and `startShiftOrQueue`
  hands that same punch and mode to `clockIn`, to `enqueueClockIn` and to the
  clock sheet on a hand-off. A fresh punch on a retry turns a lost reply into
  a second shift. And Work offers no clock-in until the shared clock state is
  known — `useClock().loading` (the open shift and this phone's queued
  punches) and the saved data's restore — saying "Recovering your clock…"
  meanwhile (Codex review of #642, 2026-09-25).
- A new RPC that starts a timer on a unit calls `_unit_work_gate(uid)` right
  after its open-shift check; one that starts Prep time calls
  `_prep_time_gate(uid)` there. `scripts/verify-new-front-door.mjs` pins both
  lists of gated functions and the practice-run probe reads them off the real
  database, so one added without its gate fails a check by name.
