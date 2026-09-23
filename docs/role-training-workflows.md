# Role workflow blueprint review (2026-09-23)

A review of the workflows the three Using Forge walkthroughs propose, set against what the app does today. **These are proposals.** This release ships the videos only. It changes no clock, navigation, payroll, QC or learning behaviour. Each section records the current behaviour, the owner's proposal, where the two conflict, and a recommendation to confirm before anyone builds it. Source brief: `../outputs/Forge-Role-Walkthroughs-2026-09-23/OWNER-DIRECTION.md`.

## 1. Start of day: clock tap → job → toolbox talk

- **Today:** `ClockSheet` / `ClockInBlock` choose job, cost code and mode in one sheet. The server refuses the day's first clock-in until today's toolbox talk is signed (migration `20260813000000`). The client holds the button once it knows the talk is unsigned. A foreman or supervisor may record a *group sign-in*, a weaker attestation that satisfies the same gate (CONTEXT.md). Injury and time confirmations are part of clocking out.
- **Proposed:** one "clock in" tap first, then choose or create the job (with AI help), then sign the toolbox talk before unit work starts.
- **Conflict:** "Tap first, sign later" moves the moment paid time starts ahead of the safety gate. Today the gate *is* the start of paid time. Two new states would appear: a job not yet chosen, and a person on the clock but unsigned. Offline-captured punches must keep their saved timestamps.
- **Recommendation:** keep the canonical order on the server: no paid job shift before today's signature. Make the *screen* feel like one flow. A single Start button opens job selection (suggested job pre-selected), and the talk comes next in the same sheet. The shift is created on signing, stamped at the first tap only if the owner decides the minutes spent reading are paid. That is a payroll decision to make explicitly, with an audit note, never by default. Safety answers, injury questions and group sign-in stay exactly as they are.

## 2. Foreman timecards: own card by default, focused approvals

- **Today:** `timecardPermissions.ts`: a foreman may edit their own card and installers' cards, and approve installer and foreman weeks. Supervisors and owners can do everything, including foreman and supervisor cards. The full team timecard screen is what a foreman sees.
- **Proposed:** open to "My timecard"; approvals live in a compact queue.
- **Conflict:** none in principle. The risk is losing the approvals the owner still wants foremen to give, or widening them by accident.
- **Recommendation:** show the foreman's own card by default, with a badge that opens an approvals queue scoped by the same `canApproveTimecard` / `canEditTimecard` rules the RPCs enforce. The queue is a filter over the existing screen, not a new permission. Foremen still cannot edit supervisor or owner cards. The historical crew-work record (`foreman-crew-unit-records.md`) stays separate from payroll time.

## 3. Helpers: invite and accept, never clock somebody in silently

- **Today:** *Summon help*. A helper answers a Summon in their own app, and their helper session starts at the Answer tap (CONTEXT.md). Crew invites (`crew-invites.md`) are app-account invitations, which is a different thing. A foreman's crew unit record names who worked but adds no payroll hours.
- **Proposed:** invite a teammate to a unit, flag if they are busy elsewhere, and they accept or decline.
- **Conflict:** an invite that started the other person's timer, or ended their current unit or break, would change somebody's paid time without their action.
- **Recommendation:** build it as Summon with a named recipient. Nothing changes for the recipient until they accept on their own phone. On accept, the app resolves their current job, unit and break state (end, pause or switch) with their confirmation. The sender sees "busy on unit X" from existing session data, not a guess. A crew record that names a person never clocks that person in.

## 4. One-mile geofence (backlog)

- **Today:** no geofence. `jobProximity.ts` / `farFromJob.ts` give a **soft**, foreground-only question ("You're 14 miles from … — switch to Travel?"). It stays silent when the fix is missing, stale or too inaccurate, and it never blocks. Jobs have text addresses, not coordinates.
- **Proposed (deferred by the owner):** flag or restrict clock-in more than a mile from the job address.
- **Conflict:** a hard block with poor GPS, a stale sample, a shop day, travel or a bad address would stop real work, or invite backdated punches to make up for it.
- **Recommendation:** when this is built, warn before any block. Every check records the fix, its accuracy radius, the sample age and the job's geocode source. If accuracy is worse than the radius or the sample is stale, **ask** rather than decide. An offline clock-in keeps its saved time and is checked when it syncs. Any override (by the person, or a supervisor's exception) is recorded with who, when and why. A failed check never erases or moves hours. At most it marks the punch for review. Nothing in the videos may show this as live.

## 5. Learning evidence vs reviewed guidance; trusted submitters

- **Today:** Ask saves original questions, answers and field evidence for review, and Hexcore reviews linked cases. Only a reviewed revision becomes guidance, and unreviewed answers are labelled as needing review (`20261022000000_hex_portal_learning.sql`, `hex-portal.md`). Lessons, quizzes and clearances are separate and supervisor-published.
- **Proposed:** a short proctored debrief after each unit, routed automatically to review and Hexcore. Supervisors may "trust" a contributor so their reports go straight into the archive.
- **Conflict:** automatic routing is fine. Treating routed or trusted material as *verified* would turn an installer's observation into an instruction with nobody accountable.
- **Recommendation:** keep five distinct objects, each labelled as what it is: installer completion, QC approval, original evidence, reviewed lesson and published guidance. A trusted-submitter setting is explicit and scoped (a person plus a topic or unit family). It records the responsible reviewer and when it expires. It covers only **archive acceptance**. It never marks content as reviewed, never covers safety, structural or warranty topics, and stays visible on every item it lets through. Nothing becomes authoritative guidance without a named reviewer.

## Also from the brief

- Suggested units come from continuation, existing assignments and available units. No automatic dispatch or schedule optimisation is shown as live.
- Voice and typed answers fill the same visible, editable fields. The original audio and transcript are kept, and each shows saved, pending or failed status.
- Role menus hide features without removing access the role already has. "Who's clocked in" (a crew activity view) is not permission to read anyone's payroll history.
