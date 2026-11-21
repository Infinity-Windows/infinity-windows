# Forge synthesis walkthrough plan

Written 2026-11-19 for a step-through with Matt, starting 2026-11-20. Branch `matt/forge-synthesis`.

This is a walkthrough order, not a ticket list. Each stop has the same shape: look at it in the app together, Matt decides the open questions, we fix what the decision implies, we verify. Nothing here is a commitment until Matt says so at that stop.

Source: six read-only audits of the working tree on 2026-11-19 against Matt's six-area checklist. Nothing was checked against the live database, and the Playwright specs were not run.

## Decisions so far

- 2026-11-20, Matt: **No checkpoint.** We work on top of the uncommitted files, build some into working systems, and find out what to discard. Do not commit or stash the working tree.
- 2026-11-20, Matt: **Publish is the final step of the unit import, and may be called "Finish".** Until that step, the import must not build units onto the job. (Today "Use definition" in the Shop CAD stage saves a unit to the job immediately, which conflicts with this; resolve at stop 2.)

## Findings so far

2026-11-20, read from the Supabase dashboard's Migrations page (339 rows):

- **Applied to the live database: 9 of the 11 new migrations**, `20261130000000` through `20261130080000`.
- **Not applied: `20261130090000_unit_details_optional_floor` and `20261130100000_job_unit_builder`.** So live still requires a floor on a placeholder, and the Unit Builder's own save rules (foreman creating a defined unit, confirming a placeholder, the disregard flag) are not on the database yet.
- **The rename risk is not a problem.** Live `20261129000000` is `clock_refresh_recovery` from master (PR #766), not the pilot migration. The branch does not have that file; it comes with catching up to `origin/master`.
- **The recorded SQL matches the local files for all nine.** Compared by fingerprint with two read-only selects on the migrations table: six match ignoring whitespace; the other three (030000, 040000, 050000) match once statement-ending semicolons are also ignored.
- **Not checked:** whether the live functions and tables still look the way those migrations left them (someone could have changed one by hand since).

## Stop 0 — Ground truth before touching features

Everything below rests on things we have not confirmed. Do these first; they are quick and change how careful the rest must be.

1. **Which migrations are actually on the database.** All 11 (`20261130000000` to `20261130100000`) are untracked local files. A local artifact (`app/.test-temp/live-carry-function.txt`) suggests an older carry function is live. Needs a read-only migration listing from Matt's access.
2. **The renamed migration.** Committed `20261129000000_installer_job_plan_pilot.sql` is deleted and replaced by `20261130000000_installer_job_plans.sql` with the same opening `create table`. If the old ID was applied, a push fails. Another checkout reportedly uses `20261130000000` for a different migration.
3. **An honest test baseline.** 19 test files fail. Sort them into: caused by this work (5), stale mocks already broken at HEAD (clock, Work screen), and Windows line endings (about 7). Fix the mocks so `WorkScreen.test.tsx` runs its 27 tests again; we need them for stops 3 and 4.
4. **Sign-in for the walkthrough.** Matt signs in to the preview pane on a real job so we look at the real screens, not fixtures.

Decisions for Matt:
- Is any of this uncommitted work safe to checkpoint as commits now? Roughly 100 modified and 80 new files sit only in the working tree.
- Which job do we use for the walkthrough, and is writing test units to it acceptable?

## Stop 1 — Unit details (shared by every other surface)

Look at: open the same unit from Plan, Workday, and upcoming work. Open a placeholder door on each.

Decisions for Matt:
- **Is floor required on a placeholder?** The checklist says yes. The code says no: migration `090000` dropped the check on purpose ("allow field-created units before their floor is known"), the input reads "Optional", and an e2e test expects it.
- Should the tiles on Plan and Workday use the same icon rule as the details panel?

Then fix:
- Icon fallback on Plan and Workday tiles (door/window icon instead of the dashed square; Plan tiles skip the definition diagram).
- A queued offline edit that hits a conflict silently reverts in the panel. Show it where the person is looking.
- Floor label in Spanish.
- Whichever way the floor decision goes, make the migration, the form, the probe and the test agree.

Verify: the e2e in `plan-workday.spec.ts`, plus a new test for the conflict path and one for icons.

### Stop 1 result, 2026-11-20

Matt: "okay do the unit details." Read as: floor stays required on a placeholder (his checklist), and the tiles share the panel's icon rule.

Done in the working tree:
- Floor required on a placeholder: the panel's floor input is required when creating or editing one; `20261130100000_job_unit_builder.sql` (not applied yet) restores the floor rule and the "Enter a unit number, floor, and type." message; `plan-workday.spec.ts` fills a floor and expects it in the write. The existing probe already sends a floor.
- One picture rule (`unitPicture` in `lib/install/unitDefinitionDiagram.ts`, `UnitKindIcon` in `components/install/`), used by the panel, Workday tiles, Plan unit cards and Plan chips. Plan no longer skips the saved definition diagram.
- A refused offline edit now shows in the panel ("Your last change to this unit was not saved", the reason, a link to `/stuck`).
- Floor reads "Nivel N" in Spanish in the panel.

Checked: typecheck clean; unit tests 18 failing files, same set as before minus the Capture one, none new.

Not done / not checked:
- **Not seen on screen.** As owner, `/installer-day` says "No accessible zztest project was found", and Black Desert shows no Plan tab (`?tab=planner` redirects to Overview). How Matt reaches Plan and Workday on a real job is the first question at stop 3.
- `plan-workday.spec.ts` was edited, not run. No new test for the refused-edit message or the icons.
- `20261130090000_unit_details_optional_floor.sql` is now pointless (live never got it, and `100000` replaces the function anyway). Left in place; delete on Matt's word.
- Workday and Plan group headings still say "Level N" in Spanish (the string is also the grouping key).

## Stop 2 — Unit builder and importing

Look at: `/projects/<id>/upload?preview=cad` with the Building 3 CAD and a marked plan. The layout was redesigned on 2026-11-19 and has not yet been seen signed in.

This is the thinnest area. The decisions matter more than the fixes.

Decisions for Matt:
- **What does "publish" mean?** Today Floor plan, Match and Verify write nothing; the only output is a downloaded JSON, and units are created one at a time with "Use definition". Options: (a) Verify creates the matched openings as draft units in one batch, (b) keep one-at-a-time and say so plainly in the UI, (c) something between.
- **Is the CAD reader meant to work beyond Building 3?** It only recognises the "Tech Ridge Building #3 CADs-N" export, and the count check uses a hard-coded Building 3 reference file.
- **Reimport.** Not built: import state is lost on reload and no source key is stored on a unit. Is this needed now, or after publish exists?
- **Placeholder merging.** Absorbing keeps the unit's id and history, but nothing suggests candidates and CAD values overwrite the placeholder's. Should field corrections win?
- **AI review.** The edge function looks complete but is untracked, so presumably not deployed. Deploy it, or leave it off for now?

Then fix: follows from the decisions. Small items regardless: draft quantity and label edits never reach the saved unit; no tests for the builder or the CAD reader; the function does not report caught errors.

### Stop 2 progress, 2026-11-20: the Finish step

Matt chose "Yes, Finish step". Built in the working tree:

- The last stage is now **Finish** (was Verify). It lists the units it will add with their numbers, lists what it will leave out and why, asks once ("Add N units to this job?"), then writes them one at a time through `save_unit_details`. A dropped connection can be retried without adding the first ones twice.
- Rules live in `lib/install/unitImportFinish.ts` with tests. Units are numbered mark plus a running number ("6-1", "6-2"), continuing after any unit of that mark already on the job. An opening with no CAD match, or whose CAD type is not window or door, is left out.
- The Shop CAD stage no longer creates a new unit ("Use definition" is gone). Applying a definition to a field placeholder stays, since that unit is already on the job.
- The review download is still there as a secondary button.

Not done / not checked:
- **Finish cannot succeed on the live database yet.** Creating a defined unit needs `20261130100000_job_unit_builder`, which is not applied. Until it is, Finish gets a refusal on the first unit. Applying it needs a dry-run probe first (none exists for it).
- **Not seen on screen.** The preview pane's sign-in now gets "Not available for your role" on the builder. Finish was never pressed anywhere.
- Running Finish twice on the same drawings in a new tab adds a second set (numbers continue). That is the reimport decision, still open.
- A job with a shop CAD but no floor plan has no path from a CAD definition to a unit any more, except New unit by hand without the CAD values filled in.
- 2026-11-20, Matt: "Yes I like those two rules" (numbering by mark plus running number; leaving out openings with no window/door CAD definition).
- Probe written, not run: `scripts/dry-run-probes/job-unit-builder.sql`. Running it is a GitHub workflow against the live database (rolled back) and needs the branch pushed, which conflicts with "no checkpoint" until Matt says otherwise.

Accounts for the walkthrough (Matt, 2026-11-20): owner for the builder, Plan and reporting; the test installer for Workday checks. Batch stops by account so he switches as few times as possible.

### Stop 2 on screen, 2026-11-20 (owner, job FORGE-TEST-B3-1119)

Matt named this job for the walkthrough. It has no units.

- Seen: the builder opens, the empty state, the stepper with Finish as stage 4, and the Shop CAD stage reading `Tech-Ridge-Building-3-Catalog-Shop-CADs-2026-08-20.pdf` (15 sheets, 27 definitions). "Use definition" is gone.
- **Finding: 20 of the 27 definitions come back "Type unclear" with no size.** The reader only fills type and size for a flat two-fixed-panel window (7 of them), plus Door for "Dr 110a". Under the leave-out rule, every opening matched to one of the other 20 is left out at Finish until someone sets its type by hand. This is the CAD reader / AI layer decision, now with a number on it.
- Not seen: Floor plan, Match, Finish with real openings. I could not identify which file is the marked floor plan.

### Stop 2, leave-out rule revisited, 2026-11-20

Matt loaded `Tech Ridge 1-6 Bldg 3 07-13-26 - Condensed Marked.pdf` (53 openings, 52 with a CAD match) and said: "I feel like we usually have a hit on more numbers, just from the CADs. we may need to consider what that 'leave-out' rule was meant to address."

- Seen at Finish before any change: 22 of 53 left out, 21 of them matched to a definition the reader had left without a type.
- What the rule is for: the database refuses a defined unit that is not a window or a door. The match was never the problem.
- Change: the reader now takes the type from the designation (lettered = window, "Dr" = door, "CW" = assembly). Size and configuration are still only read from simple drawings, so those definitions still show as needing review for size.
- Seen at Finish after: **50 units to add, 3 left out** (marks 24 and 25 match curtain walls CW1-CW4; 1-A has no CAD match). The left-out list now has "Match them" and "Set types in Shop CAD".
- Finish was not pressed.

Open for Matt: are curtain walls units on a job? Today a unit can only be a window or a door, so they can only come in if someone calls them one or the other. And 33 of the 50 units would be added with a type but no size.

### Stop 2, AI layer locally, 2026-11-20

Matt: "This is supposed to have an ai layer, to help match things as well. you should see it's intended to run over api, but to test locally, you can invoke codex and use the 6.1 terra model. I'll fully test this on the next job, or one Watts as the first use-case."

- Built: a dev-server-only route (`app/scripts/localCadReview.ts`, `/__local/review-cad-opening`) that answers the Match stage's review request by running the Codex CLI on `gpt-6.1-terra`. In development the "Ask" button calls it; deployed it still calls the `review-cad-opening` function. Both now read the same instructions and context from `supabase/functions/_shared/cadReviewPrompt.mts`.
- Seen working once: mark 1-A on FORGE-TEST-B3-1119, about 30 seconds, returned a choice and a reason in the panel.
- **That one answer looks doubtful.** It picked plain "A" for mark 1-A and set aside "A-1" (quantity 1), reading the circled A tag in the crop. Worth Matt's eye before trusting it.
- Not done: the deployed function is still not deployed; no test for the route; the AI is only offered on openings the matcher left unclear (1 of 53 here), and nothing asks it about CAD type or size.
- The Codex CLI is found through the desktop app's install location; `CODEX_BIN` overrides it.

### Stop 2, curtain walls and AI fill-in, 2026-11-20

Matt: "Yes, let's fill in what's readily available, but missed. Can we get curtain walls allowable? What's missing for this, just the type option?"

Curtain walls. More than the option, but not much: the type list (`UNIT_KINDS` in `lib/install/unitDetails.ts`), the database rule in `20261130100000_job_unit_builder.sql` (unapplied, so edited in place), the two unit forms, the details panel label, the shared icon, the CAD reader ("CW" designations) and the Finish rule. No preset diagram for one; it shows a grid icon. Spanish label "Muro cortina" is my wording. Not touched: Studio, the opening map, warehouse and the older extract path, which have their own window/door notion.

AI fill-in. The Shop CAD stage can ask the AI to read a drawing (one, or all unclear ones). It fills only empty fields: type, width, height, configuration, material, quantity, item number. Same function and local route as the match review (`task: "definition"`), same shared prompt file.

Seen on FORGE-TEST-B3-1119 through local Codex: all 20 unclear drawings read in about two minutes; all 27 definitions now have a type and size; Finish shows **52 units to add, 1 left out** (1-A, no CAD match).

Not checked: **the AI's values against the drawings.** Heights are consistent with the ones the text reader found (most 6'11 1/8"), which is encouraging, not proof. Finish not pressed. Live still refuses curtain walls and defined units until the migration is applied.

### Stop 2, full-screen compare and automatic AI, 2026-11-20

Matt asked for: a full-screen view of the drawings to compare dimensions, reachable from the openings list on the Match page and including the matched CAD drawing; AI working on more than one opening at a time, faster, with loading animations; and then, mid-work: "do we have ai running automatically at each step? once with the cad definitions, then once after the floorplan comes in, with counts, etc? I think that's how it should be."

Done in the working tree, seen on FORGE-TEST-B3-1119:
- **Full-screen compare** (`DrawingCompare.tsx`): plan around the opening beside its CAD drawing, the definition's size, configuration, material and quantity in the header, zoom to 400%. Opens from every Match row, from the evidence panel and from the Shop CAD drawing.
- **Sharp crops** (`drawSharpCrop`): the old crops rendered the whole sheet under a 4-megapixel cap, so a plan crop was under 200 pixels wide. Now only the cropped region is rendered. The panels and the AI both get the sharper image.
- **AI runs four at a time**, with a progress bar, a spinner on each row being read, dimmed rows waiting, and a shimmer on fields being filled. 20 drawings: about 37 seconds from loading the file, down from about two minutes.
- **AI is automatic at both steps.** Loading the shop CAD reads every drawing the text reader left unclear. Once the floor plan is read (and the CAD pass has finished), every opening without a match is compared by the AI, with the plan's counts and the CAD quantities. Buttons remain for a second look. AI answers on openings are suggestions shown on the row ("AI suggests · A"); a person still confirms.

Not done / not checked:
- Mark 1-A: the AI again suggests plain "A" over "A-1", now with a sharp image. Still looks doubtful to me; Matt to judge in the full-screen view.
- AI values not checked against drawings by a person. Finish not pressed.
- Automatic AI means every shop CAD load on the deployed app spends on the metered function (about 20 calls for this file). No setting to turn it off.
- No tests for the viewer, the pool, or the automatic runs.

## Stop 3 — Assignments, Plan, unfinished work

Look at: an installer scheduled on a job with no Plan; a job with a Plan; yesterday's unfinished unit activity today.

Decisions for Matt:
- **Who gets this?** Only installers on the new design do. Foremen on Work still see the old layout, and classic-design users see none of it. Intended for now?
- Should a foreman be able to un-mark an activity done, and mark done from Workday rather than only the Plan unit dialog?
- "Take lead" in Workday saves only on the device. Should it reach Plan?

Then fix:
- AM default depends on migration `080000` being live (stop 0).
- Unit details opened from the Opening sheet or Map show whole-unit state only.
- Two e2e specs disagree about whether a foreman can open the planner tab.
- Remove dead local-storage plan code.

## Stop 4 — Workday and timers

Look at: start a unit activity through Toolbox Talk, switch unit, switch to a general activity, toggle machinery, break, resume, switch job, clock out. Then repeat with the network off.

The most complete area. Mostly confirmation, with four real gaps.

Decisions for Matt:
- **Failed writes freeze controls.** A refused start or stop disables the activity picker, unit taps and Mark Done until reviewed at `/stuck`. The checklist says they must not. What should happen instead?
- Should machinery count on general activities? The server ignores it there.
- Whole-unit completion rules (last scheduled activity, foreman override) are enforced only in the client. Enforce on the server?

Then fix:
- A reload during Toolbox Talk loses the pending selection.
- Units added with Add Unit vanish on reload unless a timer was started.
- Placeholder creation refuses offline.
- `/installer-day` has no role guard.

Verify: the repaired `WorkScreen.test.tsx`, and run `installer-day.spec.ts` and `plan-workday.spec.ts` for real.

## Stop 5 — Corrections and reporting

Look at: `/activities` as a foreman; correct an activity; find it in Data.

Decisions for Matt:
- **Who can see `/data`?** The working tree moved it to owner-only. The review doc says supervisors have access, and a supervisor branch in the page is now unreachable.
- Should reports mark a corrected value as corrected?
- Should `/activities` be in the nav?
- Retiring older Data tabs: the comparison of saved test records against Data has not been done. Do it here.

Then fix:
- An older offline "done" can still undo a notes-only or time-only correction, or one on an open session.
- A time correction does not re-clamp machinery, so machinery can exceed the activity's duration. Machinery is not editable in the correction form.
- Regenerate the role-access doc and align the app guide once the `/data` decision is made.

## Stop 6 — Daily log and Capture

Look at: clock out after a day with units and machinery; open the desktop layout with the Capture dock; preview as an installer.

Decisions for Matt:
- Prefill lands as English text bullets in notes. Should it fill the structured fields (units today, stages)?
- When the job's log for the day already exists, a second installer's work is never added. Should it be?
- Capture stays live during "view as" and writes as you. Add a signal, or disable it?

Then fix:
- The desktop Capture dock is a full-width fixed bar that likely covers the bottom of the sidebar (view-as picker). Confirm on screen, then fix along with the safe-area test.
- 13px text on the crew screen fails the 16px rule.
- An existing Capture e2e still clicks the removed rail button; dead CSS for it.

## Stop 7 — Release readiness

Not a feature stop; what must be true before any of this ships.

- A dry-run probe for each of the eight migrations that lack one.
- Project purge covers `unit_detail_edit_history`, `installer_job_plans`, `plan_activity_done_marks`; the `installer_job_plans.updated_by` link needs handling too.
- Crew announcement in English and Spanish with role audiences.
- New pages use inline Spanish ternaries instead of `useT()`.
- Empty `supabase/functions/probe-cad-vision/` folder.
- How this lands: one branch, or reviewable slices per stop.

## Order and why

0 first because it tells us what is real. 1 before 2, 3 and 4 because every surface renders the same unit panel. 2 next because it has the largest undecided scope and Matt's decisions there may reshape it. 3 before 4 because Workday consumes the Plan. 5 and 6 read what 3 and 4 write. 7 last, but its list grows as we go.

## Stop 2, Match step clean-up (2026-11-20)

Matt's feedback on the Match step, and what changed (uncommitted, checked on FORGE-TEST-B3-1119):

- **"Why do I have to accept these 18 matches?"** He did not: count matches already carried their drawing into Finish. The "Accept N matches" button and the "awaiting group review" warning are removed; the group is now a plain notice.
- **Full screen** lives only inside an opened opening, one button on the plan picture and one on the CAD picture (the CAD one only once a drawing is chosen). The button on every table row is removed. Each opens that drawing alone at full width; "Show both drawings" puts them side by side.
- **Independent zoom**: each drawing has its own zoom (100–600%). Click zooms in on the clicked spot, drag pans, the percentage button fits it back.
- **Mark 1 now opens on A.** The evidence panel only knew label matches, not count matches, so it opened on "Choose a drawing" while the row said "Suggested · A".
- **Count check wording**: "Possible missing" is now "Not found on plan", with "Show N on the plan" and "Add N by hand".

Open questions for Matt:
- The count check exists only for Building 3 (a hand-checked list of 55 openings in code). Other jobs get no such check. Keep, generalise from CAD quantities, or drop?
- "Not found on plan" never blocks Finish, and neither does "needs attention" (those openings are left out). Is that the right rule?
- No tests cover the viewer, the zoom, or these Match changes.

## Stop 2, count check from CAD quantities (2026-11-20)

Matt chose: the count check works from CAD quantities on every job (uncommitted).

- `compareCadQuantities` (lib/install/planOpeningReview.ts, 2 tests) compares each shop drawing's stated quantity with the openings matched to it. The Match step's "Count check" panel shows it on any job where a definition has a quantity, and Finish has a "Quantities that differ" tile. It replaces the Building 3-only item-number line.
- The hand-checked Building 3 list of 55 stays as a second paragraph in the same panel, Building 3 only.
- On FORGE-TEST-B3-1119: 24 of 27 definitions state a quantity and all 24 agree with the plan.
- Limits: the text reader only knows quantities for five Building 3 drawings (a table in code). Everywhere else the quantity is whatever the AI read off the drawing or a person typed, so a wrong AI quantity gives a wrong warning or a false "agrees". A-1 has no quantity, so the unmatched 1-A is not caught by this check (it still shows under Needs attention). The mismatch rows were not seen on screen because nothing mismatched; only the unit test covers them. The check never blocks Finish.

## Stop 2, Match step second pass (2026-11-20)

Matt's second round on the Match step (uncommitted, checked on FORGE-TEST-B3-1119):

- The "18 × mark 1 matched to A" notice is removed; count matches are simply matched.
- Count check is four counts (On plan, Expected, Not found, CAD quantities agree) and short rows: "Level 1 · 109 · 0 / 1 · Not found · Show 109 · Add 109 · Not on this job".
- An opening the count expects and the plan read did not find now counts under Needs attention (Matt: "why are the two doors in count check, not found, but not in needs attention?"). "Not on this job" is new: it clears one. On the test job Needs attention is 3 (1-A, 109, 110B).
- Evidence always opens under its own row and scrolls into view, including 1-A and the count check's "Review 1-A" (it used to open at the top of the page).
- The list opens on Needs attention, and on all openings once nothing needs attention. The plan mark search is removed.
- CAD drawings can be stepped through with previous/next in the opened opening ("2 / 27"), likely drawings first (match, AI answer, family drawing, its variant), then the rest. The dropdown stays for jumping. 1-A opens on A-1, marked Likely.

Not checked: how the carousel and count row look (the test tab reloaded before a screenshot); the smooth scroll was read from element position only. No tests for any of it. The "Not on this job" choice lives only in the tab, like the rest of the draft.

## Stop 2, preview clicks and material (2026-11-20)

- Clicking a preview picture (the Shop CAD drawing, and the plan and CAD pictures in an opened opening) now opens it full screen. The Shop CAD picture used to be a download link, so a click saved a PNG. Right-click / long press still saves. Checked on the Shop CAD step; the two Match pictures use the same handler as their expand buttons and were not clicked on screen.
- Material: these drawings leave the item table's material cell blank and name it in the style line ("Thermal Break Aluminum Fixed Window"). The AI's instruction now says to take the material from the style line when the cell is blank, and not from the colour line alone. The prompt change was not re-run against the drawings.

## Stop 2, shortlists, material and inches (2026-11-20)

Matt: material was missing on uploads; material, type and configuration should be selects over a short list that can be added to, and the AI should know the list; drop feet from dimension entry. Uncommitted, checked on FORGE-TEST-B3-1119.

- **Why material was missing:** the automatic AI read only took drawings lacking a type or size. The text reader never finds material or quantity, so drawings it read cleanly were skipped. The AI now reads any drawing missing type, size, material, configuration or quantity (all 27 on Building 3, about 75 seconds).
- **Shortlists** (`lib/install/unitVocabulary.ts`, 4 tests): materials are Thermal break aluminum, Aluminum, Vinyl, Fiberglass, Wood, Aluminum-clad wood, Steel. This list is Claude's proposal, not Matt's; he has not reviewed it. Configurations are the existing diagram presets per type (Fixed, Two fixed panels, Sliding + fixed, Casement; Swing door, Sliding door).
- **Selects** (`components/install/PickOrAdd.tsx`): Material and Configuration in the Shop CAD form, and Material in the define-by-hand form, are selects with "Add another…". Values already used on the job or in this file's drafts appear as options. An added value is not saved anywhere as a list entry; it exists only where it is used. Type stays the fixed three (window, door, curtain wall) because the server refuses any other.
- **AI context:** the request carries the two lists; the prompt says to answer in that exact wording when the drawing means the same, else the drawing's own words. Result: all 27 have material "Thermal break aluminum" and a quantity; configurations came back as "Fixed" / "Two fixed panels", plus new ones the list lacks ("Three fixed panels", "Swing door with fixed windows", two curtain wall descriptions).
- **Inches only:** dimension entry is whole inches plus a fraction (with mm still available); feet are gone. This is the shared component, so the installer's unit details form and define-by-hand changed too. Unit Builder and the full-screen viewer show sizes as inches (109 1/2"). Other screens still format feet and inches.

To check: U reads as a Window with configuration "Swing door with fixed windows". AI values are still not checked against the drawings by a person. "Add another…" was not clicked on screen. The deployed function's copy of the prompt is unchanged until it is deployed.

## Stop 2 closed for now (2026-11-20)

- Matt: thermal break aluminum and aluminum are one material. "Thermal break aluminum" is off the shortlist; anything saying thermal break / thermally broken aluminum is read as "Aluminum", and the AI prompt says so. Ammon will add further options. (4 tests pass; not re-run on the drawings.)
- Matt: "this unit builder is in a great place for now." Parked for when we come back: a mobile pass over the whole Unit Builder (stepper, Match rows, evidence, full-screen viewer, carousel).
- Still open from Stop 2 and carried forward: migrations 090000 and 100000 are not live, so Finish cannot add units on the live database and was never pressed; U reads as a Window with a door configuration; AI values unchecked by a person; added options are not saved as a list.
- Next: Stop 3.

## Stop 3 — Matt's answers and direction (2026-11-20)

How it fits together, in Matt's words: installers don't need to be planned, "unless the foreman makes a placeholder unit and plans them". A separate scheduling tool puts people on jobs without job-specific planning; Workday feeds from that, "while these plans feed all of the default activities and units."

His answers to the three questions:
1. Foreman Workday: he is not familiar with it and will work it out with Ammon. "I don't want to replace things for everyone with this simpler view and tooling, depends what those foremen need." Leave foremen as they are.
2. Foreman un-marking done / marking done from Workday: "I'm not sure what kind of view they have where they need to do that. probably no." Not building it.
3. Take lead and everything like it: "units should be referenced all the same way. we need to make sure that interactions in plan and workday are referring to the same underlying thing, and that's where they're getting their status, crew, etc references."

The model he stated: a unit is "defined in unit builder (or placeholder), then scheduled and done work in activities, with a history."

Direction: first standardize how units are shown and treated in Plan and Workday. Test job: the other Forge test project, "Nov 3", which has a plan and units (its units are less well defined than Building 3's).

### Stop 3 — how Plan and Workday refer to a unit today (read 2026-11-20, nothing changed yet)

Test job: "TEST — Forge installer workday · Nov 3", FORGE-TRAIN-1103, id c8bf4d94-5086-40ed-9d8c-b3c88add2229. Workday previewed as the test installer via `/installer-day?project=…&planAs=812936d1-…`.

What is already the same: both screens list the job's openings (the Unit Builder's units), key Plan blocks and done-marks by opening id, draw the same picture (`unitPicture` / `UnitKindIcon`), and open the same details panel.

What differs:
1. **Two records per unit.** The opening, and a "work unit" (`custom_work_units`, one per opening, unique index) created the first time someone starts a timer on it. Timers and whole-unit completion hang off the work unit; Plan blocks and done-marks hang off the opening. Every screen bridges the two with its own lookup.
2. **Three sources for "activity done":** a timer ended as finished, a session marked done in Workday, and a Plan done-mark. Both screens merge them with `finishedUnitActivities`, but Workday also keeps a second version without the Plan marks.
3. **Demo data on this job.** The Nov 3 job's id is hard-coded as `BUILDING_3_PROJECT`. In development Workday adds sample plan blocks, shows 6-1, 1-1 and 1-2 as done for two activities regardless of real records, and swaps in a reviewed openings list. So on this job in dev, not everything on screen is real.
4. **Status words differ.** Workday's detail has six states (not started, in progress, running, blocked, rework, complete); Plan tiles show only Complete or Planned. Seen on screen: 1-17 has a tick and "Unit complete" while Flashing on it is "Not started" and still offers Start.
5. **Lead and crew.** The Plan saves a lead and crew per unit per activity on the server. Workday reads that, but "Take lead" saves only on that phone for that day, so the Plan and the rest of the crew never see it. An older assignment source (crew work records marked "assigned") also still feeds Workday.
6. **Whole-unit complete** is a fact on the work unit (`facts.installation_complete`), not on the opening.
7. Tiles are separate markup with different facts on them; details still show feet and inches (9'1 1/2") where the Unit Builder now shows inches.
8. Dead code: the local-storage plan (`readJobPlan` / `saveJobPlan`).

Proposed order: (A) one shared reader for a unit's state, keyed by the opening, used by both screens, with the demo data taken off real screens; (B) the same status words and tile on both; (C) Take lead saved to the Plan on the server (needs a new server function, so a migration and dry run); (D) a rule for whole-unit complete against activity status. Not looked at: the Plan's unit dialog on screen (the block would not open by script), and the Work page's embedded Workday.

### Stop 3 — unit details panel, Matt's critiques from the Plan (2026-11-20)

Changed in the shared panel, so Plan, Workday, the Opening sheet and the Map all get it (uncommitted; seen on screen in the Plan dialog and Workday's detail on the Nov 3 job):
- The picture is a light line drawing straight on the panel, as in the unit tables; the dark box is gone.
- "Edit unit" is a pencil icon button at the top right of the panel (same accessible name, so the e2e selectors still match), not a text link between the specs and the status rows.
- Face is no longer shown or asked for (panel, its edit form, and define-by-hand). Matt: the import has no direction data and Ammon never refers to it. Stored values are left alone. The fit view / Maps code was not touched.
- Spacing: the activity sits under the unit number in the dialog header; specs and the status / lead / crew rows share one label column; a rule separates them.
- Sizes read in inches (109 1/2" × 83 1/8"), matching the Unit Builder.

Still different between the two screens, for the standardizing pass: Workday puts activity status above the specs and shows lead as a sentence ("You lead this unit"); the Plan dialog puts status, lead and crew as rows under the specs.


## Stop 3 — one shared unit state for Plan and Workday (2026-11-20)

Matt: "units should be referenced all the same way... that's where they're getting their status, crew, etc references."

Done, uncommitted:

- `app/src/lib/installerWorkflow/unitState.ts` (`readUnitState`, 5 tests): one reading of a unit, always asked by opening id. It bridges timers (recorded against the work unit row), Plan done-marks, Workday marks and the Plan's lead and crew.
- Rule taken from the Plan: a unit that is complete as a whole shows every activity as Complete. `activityDone` stays the true per-activity record and is what plan carry-over uses.
- `UnitActivityFacts` in `components/install/UnitDetails.tsx`: the Activity status / Lead / Crew rows, used by the Plan's unit dialog and by Workday's detail.
- Workday (`NativeInstallerDay.tsx`): its two separate "done" checks are gone (one ignored the Plan's marks). Detail order now matches the Plan dialog: unit, then status, lead, crew. Take lead / Take over lead sits on the Lead row. Tile word "Done" is now "Complete".
- Plan (`JobPlanner.tsx`) and the unit dialog (`AgendaUnitDetails.tsx`) read the same state.

Checked on screen, Nov 3 test job, signed in as owner (Workday through `planAs` the test installer):

- 1-17 (complete as a whole): Workday tile "Complete", detail "Unit complete" + Activity status Complete. Plan dialog for Sealing: the same. Before, Workday said "Not started".
- 1-19: Not started in Workday.
- Lead: Workday shows "You", the Plan shows the test installer's name. Same person, same source.

Checks: typecheck clean; unit tests pass except the three failures that were already there (`onboardingContract`, `openingAccess`, `WorkScreen` mock).

Not done / not verified:

- `e2e/installer-day.spec.ts` was edited for the new lead row and "Complete" wording but not run.
- Take lead still saves on the device only. Saving it to the Plan needs a migration (dry-run decision pending).
- Tiles are still separate markup with separate words: the Plan editor's unit tiles say Pending / Open / Planned, Workday's say You lead / Complete.
- Running, blocked and rework states were unit-tested only, not seen on screen.
- Older "assigned" crew work records still feed Workday; dead local-storage plan code (`readJobPlan` / `saveJobPlan`) still there.
- `progressDemo` data is opt-in (`?progressDemo=1`), not shown by default.


## Stop 3 — one unit tile for Plan and Workday (2026-11-20)

Matt: "make unit tiles the same"; in Workday's add-unit list "New Unit" becomes "Create Unit", and its units get the information icon opening the same popup the Plan uses.

Done, uncommitted:

- `app/src/components/install/UnitTile.tsx` + `unitTile.css`: the Plan's tile (picture left; number, lead, status right; info icon in the corner) as one component. The Plan's picker, Workday's timer tiles and Workday's add-unit list all render it. Workday's timer tiles are the same tile at a larger size with the clock in the caption.
- Words are the same: Complete / Running / Planned / Unplanned. The Plan's "Open" is now "Unplanned"; the Plan keeps "Pending" for a booking whose time has passed. Workday's "You lead" is now the lead line "You" plus the status.
- Workday add-unit list: info icon opens the unit popup (`AgendaUnitDetails`) without selecting the unit. Button and dialog say "Create unit".
- Old Workday tile styles removed from `workdaySimple.css` and `work.css`.

Checked on screen at phone width, Nov 3 test job: Workday timer tiles, add-unit list, popup for 2-1, 1-17 shown Complete, inline details still open from a timer tile's icon; the Plan's picker unchanged in layout.

Not done / not verified:

- On a timer tile the info icon still opens the activity details under the grid (notes, fields, mark complete), not the popup. Matt to say if that should be the popup too.
- Workday tiles name the lead only when it is the viewer ("You"); another person's lead shows no name on the tile.
- The Unit Builder's inventory still has its own copy of the tile markup.
- The tile's styles are in two files (`jobPlanner.css` for the Plan, `unitTile.css` elsewhere).
- e2e specs not run. Running tile and the mark-done button not seen on screen (no timer started).
- In the Plan, units picked into the block being edited read "Unplanned" (they read "Open" before); same logic, new word.


## Stop 3 — Take lead saved to the Plan, and cleanup (2026-11-20)

Matt: "Take lead can happen over any assignment." Info icon on Workday's timer tiles moved to the top right at his request.

Done, uncommitted, nothing applied to the database:

- `supabase/migrations/20261130110000_plan_unit_lead.sql`: `take_plan_unit_lead` lets an installer make themselves lead of one unit for one activity in the Plan, over any assignment. Table `plan_unit_lead_changes` keeps every change (who, from whom, when). The Plan's revision moves, so a foreman with the Plan open is told it changed when they save.
- Claude's choices in that migration, for Matt and Ammon to confirm: the person who was lead stays on the unit as crew; only installers can take lead (the Plan only names installers); a unit the Plan does not have for that activity is refused.
- `scripts/dry-run-probes/plan-unit-lead.sql`: the trial script. NOT RUN (needs the branch pushed).
- Workday sends Take lead through the same offline queue as done-marks (`plan_unit_lead`). Until the migration is applied the request waits on the phone and the lead still shows from the device's copy. The preview sends nothing. A unit the person added themselves keeps its lead on the device only.
- Workday tiles now name another person's lead by first name (shared `useProfileNames`).
- The Unit Builder's inventory draws the shared `UnitTile` too.
- Removed dead local-storage plan code (`readJobPlan`, `saveJobPlan`).

Checks: typecheck clean; related unit tests pass (WorkScreen test still fails to load, as before). Workday and the Unit Builder inventory render on the Nov 3 job.

Not done / not verified:

- Take lead reaching the server: cannot be seen until the migration is applied. The SQL has never run anywhere.
- No one else leads a unit on the test job, so another lead's name on a tile was not seen.
- Older "assigned" crew work records still feed Workday's activity list; left alone, needs Matt's call.
- e2e specs not run.

Order to apply, once the branch can be pushed: trial-run then apply 090000 and 100000 (adding units), then 110000 (Take lead).


## Stop 4 — first pass, the fixes that need no decision (2026-11-20)

Done, uncommitted:

- `WorkScreen.test.tsx` runs again: 26 tests pass. Two repairs: the stale sign-in mock, and the Workday preview provider the screen now needs. The tests now run as a foreman, because an installer on the new design gets Workday on that screen instead. **Finding:** those 26 tests (Start day, double clock-in guards, Toolbox Talk before unit work) cover the foreman layout only. The installer's Workday path to clock-in has no unit tests of its own; only the e2e specs, which have not been run.
- Units added with + Add unit survive a reload (`lib/useStoredState.ts`, kept per job, person and day on the device). Seen on screen: added 2-1, reloaded, still there.
- A tap that was waiting on the Toolbox Talk or clock-in survives a reload (same hook, tab session only, dropped after 30 minutes so an old tap cannot start a paid timer by surprise). Unit-tested hook only; not seen on screen, it needs a real installer shift.
- `/installer-day` is behind the same role guard as Current Work (installer and above).

Not done:

- Placeholder creation offline: untouched.
- Real timers (start, switch, machinery, break, clock out, network off): not exercised. The owner preview uses local timers only; this needs the test installer signed in on a real shift on the test job.
- Lint not checked: the run is swamped by build output under `app/.test-temp/`.
- e2e specs not run.

Decisions still open for Matt (from the Stop 4 list): what a refused start or stop should do instead of freezing the controls; whether machinery counts on general activities; whether whole-unit completion rules are enforced on the server.


## Stop 4 — real timers as the test installer (2026-11-20)

Run on the live database, test installer on FORGE-TRAIN-1103, shift 1:53 PM to about 1:57 PM. Matt signed the account in; Claude signed today's Toolbox Talk as the test account at Matt's say-so (name typed: "Test installer - signed by Claude at Matt's request").

Worked:

- Tap a unit with no shift: the clock-in sheet opens with the Toolbox Talk in front. Sign, Start clock, clocked in.
- Start a unit timer (1-19 Flashing), machinery on, switch unit (1-18; machinery carries over and its counter restarts), pick a general activity (Setup; starts on the one tap, machinery control hidden), break (Rest; the activity stops), resume, start again, reload mid-timer (still running), clock out. Each was accepted by the server; nothing was left waiting.

**Bug found and fixed (uncommitted):** the first timer after clock-in was refused with "Clock in or resume your job clock before starting work." This computer's clock is 2.6 s behind the server. The shift's clock-in is stamped by the server, the start by the device, so the start landed before the shift began. `NativeInstallerDay.tsx` now starts work no earlier than the shift's clock-in. Seen working on the second try (same code path, but by then the shift was two minutes old, so the fix itself has not been seen to rescue a start). No unit test for it.

Left behind: that one refused start is still on this browser under Stuck writes ("Work needs review"). An installer cannot clear it, only export it for a foreman.

Findings, not changed:

- After Resume from a break nothing is running: the person is on the clock with no activity until they tap a unit. The clock sheet also stays open after Resume and blocks unit taps until closed.
- Machinery is Off after a break even if it was On before.
- A unit with time on it but not done reads "Planned" on its tile; the tile has no "In progress" word (the details rows do).
- Clock-out said "we'll sync it when you're back online" while online. It did reach the server.
- Decision 1 (refused writes): here the controls did NOT freeze. The banner said "Saved work needs review ... You can start new work." and a new start worked.

Not exercised: mark done, whole-unit complete, switch job, network off, Take lead on the server (function not applied), the reload-during-Toolbox-Talk fix.


## Stop 4 — shift controls inside the timer, quiet taps, clock fix tested (2026-11-20)

Matt: after a break, leave nothing running and let the person pick up a new timer. A unit tap must save silently. Break, activity/unit choice and clock-out belong inside the Workday timer, not the "On the clock" sheet; the two checkboxes and any message become a confirmation.

Done, uncommitted:

- **Late-clock start fix has a test.** The rule is now one function, `lib/installerWorkflow/startTime.ts` (`workStartTime`), used by both start paths, with a test built from the real refused case (tap 20:53:34.967, clock-in 20:53:36.785).
- **Quiet taps.** Each tap disabled every unit tile for about 30 ms while it saved, which read as the screen refreshing. Measured before: 30 disable/enable changes per tap; after: 0. A second tap while the first is saving is still ignored.
- **Shift controls in the timer** (`pages/installerPilot/WorkdayShiftControls.tsx`, `lib/shiftPunches.ts`): Break opens a small panel under the heading (Lunch / Rest / Other); on break the button is Resume; Clock out opens a confirmation with "I was injured this shift" (and what happened), "My recorded time looks wrong", then Clock out. No sheet. Cost codes are not offered here; the activity and unit say what the time is for.
- Seen on the live database as the test installer: start 1-12, Break > Rest, Resume, start again, Clock out. Each saved; nothing left waiting.

Left as is, on purpose or to decide:

- `lib/shiftPunches.ts` repeats the clock sheet's three punches rule for rule rather than changing the sheet (the classic screens take fixes only). A change to those rules now belongs in both places.
- A shift open so long that Forge asks for the real finish time still opens the sheet.
- Clocking IN (Toolbox Talk, Start clock) still uses the sheet.
- The chip in the top bar ("Clocked in 1:59 PM") still opens the full sheet.
- Injury note: the inline box is plain text, without the sheet's dictation.

Not verified: clock-out with either box ticked (deliberately not filed), any of this offline, Spanish wording by a speaker.

Seen but not mine: `ClockInBlock.test.tsx` fails (11 tests), and `pages/customWork/RecentActivities.tsx` has two type errors. Neither file was touched in this work.

## Stop 4 — clock-in stays in the sheet (2026-11-20)

Matt: "The toolbox talk and sign-in can use the popup sheet, so that clock in can stay there. by then a job/activity is at least already selected, and conditionally a unit." So clocking in and the Toolbox Talk keep using the sheet; only break, resume and clock-out moved into the timer. No change needed.

Open question from Matt: "how am I meant to review my existing work?" As an installer there is no list of today's activities and units with their times inside Workday. What exists: tracked time on each unit tile and its details panel, My timecard (`/timecard`, shift hours), Current Work (`/current-work`). The review-and-correct list is `/activities`, foreman and above only (Stop 5).

## Stop 4 — Matt's notes on the timer, second pass (2026-11-20)

Matt's notes, in his words, and what was done. All uncommitted. Nothing applied to the database.

- "removing exported pending changes isn't giving me a confirm. It didn't clear out." The remove step used the browser's own confirm box, which never appeared. It now asks on the page (`pages/customWork/QueueNotice.tsx`): Remove from this device / Keep.
- "we don't need the 'saved work needs review' message. it's apparent from the top of the page, and the nav bar." Removed from Workday.
- "completing the activity on a unit … it's moving it to the end of the table. it should stay in place, as the active timer." Then: "the active unit needs to be in the first position … sort by available as planned, completed to the end." Order is now: running unit, then what is left in the Plan's order, then done. Cause of the jump: today's carried-over Plan drops a unit once its activity is done, so it re-sorted as unplanned.
- "operating machinery is supposed to always be there." The switch shows for every activity, disabled until something is running. Then: "just the little icon", "overlapping the top right corner", "puffing smoke", "slower and more subtle", "we don't need to actually display its time, just track it", "clicking it should require a confirmation … remember their answer for 24 hours". Done as said: a tractor icon on the activity card's corner, grey idle, green with two slow wisps when on; turning it on asks "Are you operating machinery?" once per 24 hours per person on that device. Machinery carries on to the next activity when it was running.
- "the logged machinery time needs to be bound to a cumulative total variable that's updated as the machine clock runs." One function, `machineryTotal`, sums today's saved machinery plus the running stretch. "Logged machinery time" in a unit's details reads it, so it moves while the machine runs.
- Server: `save_workday_activity` drops machinery on an activity with no unit. New migration `20261130120000_machinery_any_activity.sql` removes that condition; probe `scripts/dry-run-probes/machinery-any-activity.sql`. NOT applied and never run. Until it is, machinery on a general activity turns on in the app and is then lost on the server.
- "clockout button should probably be a soft red and use the 'stop' icon, and break should be orange. Also I wanted them uniform width." Done (also in the owner preview).
- "make the Job title itself obvious that you click it to switch … get rid of the button." The job name is now the button, with a chevron (`pages/work/WorkdayJobs.tsx`). Its accessible name is "Switch job: <job>".
- "we should let them clock on a unit they can't find. we could do a local check on number … we don't want to lose the clock record. we can put that work somewhere to review, maybe in /activities." Built:
  - The create form checks the number against the units already on the phone, online or not.
  - With no signal, Workday keeps the new unit in the work queue (`unit_create`), ahead of the timer started on it, and shows it as a tile from the queue (`lib/installerWorkflow/queuedUnits.ts`).
  - If Forge refuses the unit when signal returns, the creation is dropped and the work record is kept without a unit link, named "<number> (unit not created)" with the reason in its facts. The timer saves on it as tapped. It shows under that name wherever work records are listed, `/activities` included. No separate list was added to `/activities`.
  - Tests: `queuedUnits.test.ts` (3), `queue.test.ts` (3 new). Not exercised in a browser: this browser cannot go offline.
- "screen still reloaded when I started a timer." Not reproduced. Measured on a real start as the test installer: the page was not remounted, the scroll did not move, and only the two tiles involved and the sync pill changed. The tile jumping (above) may have been what was seen. To check with Matt after these changes.
- Info icons stay as they are (Matt: "yes info icons should open as they do").

Also fixed: the clock-out and break toasts no longer say "we'll sync when you're back online" on a phone that is online; `useStoredState.test.tsx` named a test environment the repo does not have and had never run (now 3 pass).

Choices made without asking, to confirm:
- A unit refused by Forge leaves its tile; the running timer shows as "Still running" and the record is found by its "(unit not created)" name.
- The machinery confirmation is per person per device, not per shift.
- "Logged machinery time" still shows in unit details.

## Stop 4 — last notes of the day and test state (2026-11-20)

- Matt: "softly shake that machine", "a clock icon here left of the timer", "keep our planned activities inline with the others, maybe they're just subtly 'activated'". Done: the machine rumbles slightly while on; a clock icon sits left of the timer; the separate row of planned activities is gone and planned ones lead their group in the activity list, lightly lit.
- Matt: "we can work on offline units and time tracking later if this is difficult." It was built and has unit tests (above) but has not been tried in a browser with no signal. Treat it as untested in the field.

Test state at the end of the day:
- Typecheck clean except the two errors in `pages/customWork/RecentActivities.tsx` (not touched here).
- Workday unit tests: 21 files, 142 tests pass.
- Whole unit suite: 17 files fail (67 tests). None are in files changed today. Not sorted: `ClockInBlock`, `useToolboxGate`, `frontDoorKeyedClockIn`, `usePhotoPicker`, `trashCascade`, `roleAccessDoc`, `appGuide`, `crewScreenRule` and others.
- End-to-end, `installer-day.spec.ts` + `plan-workday.spec.ts`, run in Edge (Playwright's own browser is not installed) part-way through today's edits: 15 passed, 16 failed. Most failures are Plan tests that expect older routes; five are Workday tests. The specs were then edited for today's changes and NOT rerun (a run takes 30 minutes).

## Stop 4 — reload at clock-in, refusals no longer block (2026-11-20)

- Matt: "when i'm clocked out and go start a timer, it reloads the whole page." Reproduced as the test installer. Two causes, both fixed and re-measured (page not rebuilt, no error line, no disabled tiles):
  - `App.tsx` RoleLanding replaced the whole Work screen with "Loading current work…" while it looked for a service visit, the first time a shift opened after each page load. The new design now keeps the Work screen up during that lookup; a running service visit still redirects.
  - `useWork` cancels a refresh on purpose when it shows a just-saved change. The cancelled read surfaced as "CancelledError" on Workday and locked the controls for about a second. Cancelled reads are no longer treated as errors.
- Matt: "we dont want to block the picker. if locally they change, ultimately we want to track it on the server how they recorded it. we just don't want to miss things, overlaps are better." The work queue now steps past a refused change: it stays for review with its error, and everything recorded after it is sent as recorded. A change that depended on the refused one is refused in turn and kept beside it. Workday no longer disables the picker, unit taps or Mark done for a refusal. This changes the shared queue, so Current Work behaves the same way. Two tests that encoded the old rule were rewritten (`model.test.ts`, `queue.test.ts`).
- Matt cleared the refused start on the test installer himself.
- Machine icon made smaller (34px). Open: Matt worries it tempts people who don't run machines but wants it one tap away for those who do.
- Still open: whether the server should enforce the whole-unit completion rules.
- To do at the end: a comprehensive mobile check of every view (Matt).


## Workday end-to-end tests repaired (2026-11-20)

Run each file with its own config (Edge works via `launchOptions.channel: "msedge"` when Chrome is not installed):

- `e2e/plan-workday.spec.ts` (`playwright.plan-workday.config.ts`): 3 pass, 1 marked `test.fixme` (a corrected activity showing in Data with its machinery time; waits on Stop 5, the Data tab is now a dashboard).
- `e2e/installer-day.spec.ts` (`playwright.installer-day.config.ts`): 21 pass, 7 fail. Every Workday test passes. The spec's shared setup now answers `get_installer_plan` / `save_installer_plan` with an empty plan; before, the Plan tab showed "Something went wrong" in every Plan test that did not set its own plan.

The 7 left are all Plan tests, to settle at Stop 3 (the Plan), not test plumbing:

- :169 carried cards: no unit chip titled both "Activity done" and "Unit complete".
- :232 fresh planner: expects 1 saved block after the edits (line 282).
- :965 foreman and the owner-only Plan tab: the foreman stays on `?tab=planner`. Either the rule changed or it is a real access gap. Decide.
- :973 activity dropdown and :1105 skips Sunday: "Schedule" stays disabled after the steps the test takes.
- :1038 bundle move: the test reads a saved value that is null.
- :1127 Building 3 auto-publish: waits for a browser dialog that no longer opens.


## Stop 3 — Plan carryover (2026-11-20)

Matt: "last 2 days shouldn't exist. carryover should stay on current day. end time shouldn't adjust with carryover."

Done, uncommitted:

- The Plan overview starts at today (it began two days back). `JobPlanner.tsx` `overviewDates`.
- A carried card moves to today and keeps its planned hours. Before, every carried card was rewritten to 7:00-12:00, in the app (`jobPlan.ts` `currentPlanBlocks`) and on the server (`get_my_installer_plan_window`).
- Server half: `20261130130000_carry_keeps_planned_hours.sql`, NOT applied. Probe `scripts/dry-run-probes/carry-keeps-planned-hours.sql`; the older `plan-activity-completion.sql` probe now expects 13:00-17:00 instead of AM. Until this migration is applied, an installer's Upcoming work still shows every carried card as "AM" while the Plan and Workday show the planned hours.
- Tests: unit tests pass; `plan-workday.spec.ts` 3 pass + 1 fixme; `job-planner.spec.ts` 12 pass.

Found: the 7 failing Plan tests in `installer-day.spec.ts` are older copies of tests that pass in `job-planner.spec.ts` (6 by the same or a renamed title; "foreman cannot open the owner-only planner tab" is replaced there by "foreman can plan on a normal project"). Only "planner carries only cards with unfinished unit work onto the current day" has no twin. Proposed: delete the copies, move or drop the carry test. Waiting on Matt.

Open: whether to merge same-activity cards. Proposal: never merge saved cards; group by activity only where the installer reads them (Upcoming work), e.g. one "Flashing · 2 units" row.

Grouping decided and built (Matt: "Yes, group them"): Upcoming work shows one row per activity and day (`pages/work/AssignedPlan.tsx`); the Plan's cards are not merged, and each unit keeps the crew of its own card. Tests pass. Not yet seen with the test installer's real carried cards (the browser was on the owner account).

Test cleanup done (Matt: "Yes, clean up"): the six stale Plan copies are deleted from `installer-day.spec.ts` and the carried-cards test moved to `job-planner.spec.ts` (its chip check now looks for "Unit complete", the title the Plan gives a finished unit). `installer-day.spec.ts` 21 pass, `job-planner.spec.ts` 13 pass, no failures. Four passing Plan copies remain in `installer-day.spec.ts` (completed units, priority wraps, job stages, toolbox swap); same tests exist in `job-planner.spec.ts`.

The four remaining Plan copies were removed too (Matt, 2026-11-20). `installer-day.spec.ts` now holds Workday tests only; Plan tests live in `job-planner.spec.ts`.

Stop 3 checks, corrected wording (Matt, 2026-11-20): unit work carries when it was planned and not completed, started or not ("I don't think unit work needs to be 'partially' finished to carry over"). That is what the code already does, in the app and on the server: the only test is "this unit's activity is not done". And it carries at its planned hours, not "in AM".

The test installer cannot be scheduled through People > Scheduling because his profile is "Off today" (`profiles.active = false`, as is the test foreman's); the board only lists people who are on site. Read-only check, nothing changed.


## Stop 5 - /activities cleaned up (2026-11-20)

Matt: "go to /activities and just clean up that page. consistent cleaner design, and easier intuitive tooling and display."

Done, uncommitted (`pages/customWork/RecentActivities.tsx`, `SessionCorrection.tsx`, `customWork.css`):

- Each row now says what it is without opening it: time range, activity with its icon and colour, unit number, a machinery mark, "Needs review", person (and job when no job is picked), duration. Before, a row was only a person and "Flashing".
- Rows are grouped under a day line with that day's total, inside the pay period. The header shows the count and total for what is filtered.
- The whole row opens it. Details are a small facts grid (job, unit, started, ended, outcome, machinery), then the correction form, then correction history.
- Correction form: two columns, plainer labels ("Notes", "Started", "Ended"), shorter footnote. Same fields and rules. The form is shared with Custom Data.
- "Load earlier activities" moved under the table.
- Phone width checked at 375: no sideways scroll.

Tests: `recent-activities.spec.ts` passes; `plan-workday.spec.ts` 3 pass + 1 fixme (two label checks updated); customWork unit tests pass.

Not done here: the Stop 5 decisions (who sees /data, marking corrected values in reports, /activities in the nav) and the parked Data test.


## Stop 7 - the 17 failing unit-test files, sorted (2026-11-20)

Read-only sort by a subagent; nothing changed. Full unit run: 17 files / 66 tests fail, 615 files / 7964 tests pass. None is an old test to delete.

- This Windows checkout, not the code (9 files): `check-bundle-budget.test.mjs`, `check-kept-assets.test.mjs`, `frontDoorKeyedClockIn`, `learningTime`, `openingAccess`, `onboardingContract` fail because files are CRLF on disk (`core.autocrlf=true`, no `.gitattributes`); they pass in an LF copy. `usePhotoPicker.test.ts:153` compares a Windows backslash path. `aiProviderContract` trips on the empty `supabase/functions/probe-cad-vision/` folder. `memoSweep` "aborts a stuck request" is flaky (4 of 6 runs), cause not established.
- Lists and docs behind the new work (4 files): `roleAccessDoc` (docs/role-access.md lacks `/activities`), `appGuide` (no `/activities` entry), `trashCascade` (four new tables unaccounted for in project purge: `installer_job_plans`, `plan_activity_done_marks`, `plan_unit_lead_changes`, `unit_detail_edit_history`), `purgeWords` (`installer_job_plans.updated_by` blocks deleting a person: probe or `on delete set null`).
- Real break from the uncommitted work (1 file): `crewScreenRule` - `pages/work/work.css` has 8 rules under the 16px crew text floor (lines 476, 494, 495, 594, 605, 620, 625, 627; 12-14px, the Upcoming work list and the Work header links).
- Tests older than a committed change (3 files, 37 tests): `useToolboxGate`, `ClockInBlock`, `ToolboxTalkNagBanner`. Their cleanup calls `discardFailed`, which since d91ee043 (2026-10-17) refuses writes that are not yours, so state leaks between tests. Keep; fix the cleanup as `outbox.toolboxSign.test.ts` does.

Also: typecheck is clean (0 errors). Lint on real source: 0 errors, 36 warnings against the baseline of 25. `npm run lint` itself exits 1 only because it scans build output in `app/.test-temp/ammon-preview/`, which is neither ignored by oxlint nor by git.

Not established: whether any of these fail at HEAD without the uncommitted work; whether CI on Linux sees only the last 8.


## /activities editor, and the no-decision test fixes (2026-11-20)

Matt: "fix the edit that comes up when you expand an activity timer. clean it up and align it better. and when it opens, make sure it scrolls into vision well.. then fix those tests"

Editor (`SessionCorrection.tsx`, `customWork.css`, `RecentActivities.tsx`), uncommitted:
- Order is now Started | Ended, the "I checked these times" box, Outcome | Delay reason, Notes, Correction reason, then the footnote with Cancel and Save on the right. Every field has the same height and style; each Dictate button sits beside its field instead of on its own row.
- An opened row scrolls to the top of the screen with the editor under it (smooth; instant for reduced motion).
- Same form in Custom Data, so it changed there too. Not looked at there.

Tests fixed (full unit run: 17 failing files / 66 tests before, 12 files / 19 tests after):
- `useToolboxGate`, `ClockInBlock`, `ToolboxTalkNagBanner`: cleanup empties a fixture store, as `outbox.toolboxSign.test.ts` does, instead of calling the guarded `discardFailed`. 46 of 46 pass.
- `usePhotoPicker.test.ts`: compares paths with forward slashes on every machine.
- `appGuide`: `/activities` entry added to `supabase/functions/_shared/appGuide.ts`.
- `roleAccessDoc`: `docs/role-access.md` regenerated (adds Recent Activities for foreman and above).
- Lint no longer scans `app/.test-temp/`.

Still failing, waiting on Matt's calls: line endings (6 files), empty `probe-cad-vision` folder (`aiProviderContract`), purge lists (`trashCascade`, `purgeWords`), small crew-screen text (`crewScreenRule`). Unexplained: `memoSweep` (flaky) and `mediaExport` "refunds failed partial chunks", which failed 7 of 7 runs here but was not failing in the earlier full run; it races 2 ms timers against a 15 ms one and its code is untouched.

Crew-screen text (Matt, 2026-11-20: "Yes, raise them"): the eight sub-16px sizes in `pages/work/work.css` are now 16px (Work header links, today's job line, Upcoming work labels and rows). `crewScreenRule` passes. Not seen in a browser as an installer; rows in Upcoming work will be taller.


## Matt's notes while the tests ran (2026-11-20)

- "this many dictation buttons are going to make this so ugly on mobile. I think we remove them all." Removed from the activity correction form (plain fields). Dictation elsewhere is untouched.
- "we need to not show test jobs and timers on the work dashboard." Data > Work Dashboard (`dataReview/ActivityExplorer.tsx`) now leaves out jobs flagged as testing, from the totals and from the Jobs filter. Seen as owner: no training job. Not covered: company-work time by a test login with no job (the app cannot read which logins are test logins).
- "jobs also display some of their unit info, above the tab navigations ... make sure that's still showing when the plan is selected." The unit counts line was hidden on the Plan tab; it now shows on every tab (`ProjectDetail.tsx`).
- "where does that info come from? our unit builder should be able to feed that info." It is the `project_scope_counts` view: openings counted from `project_openings`; window / door / door kind read from the job's mark specs (`project_mark_specs`) matched on the unit's mark; storeys from the traced model or the job's own field. The Unit Builder writes `project_openings.unit_details.kind`, which the view does not read. So a builder unit adds to "openings" but lands in "unknown" rather than windows or doors, and curtain walls have no count at all. Feeding it needs a migration changing the view. Not done; proposed.
- "On machinery affected activities, I do need the machine timer(s) and access to edit the in and out on that." Not built. Today only a total is stored per activity (`workday_machinery_ms`); the on/off times are not kept, so there is no in and out to edit. Needs a decision and a migration.

## Machine timers and the Unit Builder spec feed (2026-11-20)

Matt: "On machinery affected activities, I do need the machine timer(s) and access to edit the in and out on that" and "independent, so we can show multiple. but group under the activity it was pressed during."

- Migration `20261130150000_machine_timers.sql` (not applied): each switch-on/off is kept as a timer on its activity (`workday_machinery_spans`); a foreman replaces the list through `correct_workday_machinery`, with a reason, and the total follows. Probe `machine-timers.sql`.
- App: the correction form on `/activities` and Data shows "Machine timers" with In/Out per timer, remove and add. Only appears once the column exists. Activities recorded before the migration keep a total and no timers.
- Tests: `plan-workday.spec.ts` "a foreman corrects a machine timer's out time…" passes (4 pass, 1 fixme); customWork unit tests 82 pass.

Matt: "if it has the information, then yes I would say write specs."

- Migration `20261130140000_unit_builder_feeds_specs.sql` (not applied, written by a subagent, read through but not dry-run): a trigger on `project_openings` offers a unit's kind, size (outside frame or drawing basis only), configuration and material to its mark's spec. New mark: unconfirmed `field` spec. Existing unconfirmed spec: blanks only. Confirmed spec: untouched. Placeholders write nothing. `project_scope_counts` reads the unit's own kind first and gains `curtain_walls`. Probe `unit-builder-feeds-specs.sql`.
- App: job header shows curtain walls (guarded for a database without the column).
- Open: `rename_field_unit` / `merge_field_unit` move or delete any `field` spec by mark, written when a field spec belonged to one "Missed N" unit; a builder mark's shared spec could follow one renamed unit. The app's spec classifier knows only window/door and may reset `curtain_wall` when a foreman edits that spec. 140000 sorts before 150000; apply in order.

## Units tab and last finished activity (2026-11-20)

- Matt: dry-run, push and branch work wait until everything is ready to commit; tomorrow is for testing and deploying.
- The Unit Builder is now the job's "Units" tab (`?tab=units`), beside Plan, for the same people who get Plan. `/upload` is unchanged and its `?preview=cad` address still opens the builder.
- Unit details show "Last finished: <activity> · <when>" when anything has been finished on the unit, in the Plan, Workday and wherever a unit is opened on its own. Tiles unchanged; left for the job-completeness screens.

## Checklist review (2026-11-20, end of day)

- Job header is the same on every tab; the Plan no longer swaps the code for the name.
- The clock-out log is the daily log, prefilled from Workday records as text bullets in Notes.
- Matt's six-part checklist compared against the build. Conflicts: "defaulting to AM" (carry now keeps planned hours); unit detail saves have no conflict check; an older offline "done" can still undo some corrections; a time correction does not re-fit machinery or machine timers. Not on the checklist: machine timers, spec feed, Units tab, test jobs hidden on the dashboard, grouped Upcoming work, Take lead, offline unit creation.
- Matt: remaining work is mobile views, cleanup and intentional commits; tomorrow is testing and deploying.
