# Installer operating system — eight steps that give an installer everything the crew lead used to carry

Status: owner-approved (grill 2026-09-06, Q1–Q12 all recommendations). Source review: "Forge Operating System Review" (2026-09-06). Builds recommendations 1, 2, 3 and 6 of that review, architecture items A, C, E and G, and closes audit proposals C, F, I from `docs/audit-installer-2026-08-17.md`.

## Provenance and facts to verify before building

Line numbers drift; read the file and confirm each anchor.

**Landing and chrome**
- `/` has three landings by rank: installer → My Work, foreman → Home, supervisor+ → Heartbeat (`app/src/App.tsx:134-142` `RoleLanding`). Anything meant for "the landing" goes on all three.
- My Work today, top to bottom (`app/src/pages/MyWork.tsx:394-745`): header, SaveJobsStrip, LiveSummonsStrip, ClockInBlock (the morning hero, PR #580), LogTodayChip (foreman+ only), SendRecordingButton, name hint, Today strip (`:418-481`, reads `listMyPublished`, vehicle links, trips), new-units toast, Continue-install card (`:491-506`), empty states (`:508-561`), Next card (`:563-582`), stat grid (`:586-599`), memo-review link (`:601-605`), flash-run cards, per-job unit lists (`:620-657`), Done today with Unsubmit (`:659-683`), SkillTree (`:685-703`), RoleMaps (`:705`).
- Bottom bar for rank 0: Menu · Today (ready badge) · Capture · Clock · Ask (`app/src/lib/nav.ts:357-378`, rendered `app/src/components/Layout.tsx:375-422`). Ready badge counts `openingReadiness(o).status === "ready"` (`Layout.tsx:107-117`).
- Installer drawer: `installerMenu()` (`app/src/lib/nav.ts:568-629`): loop paths `/`, `/warehouse`, `/my-schedule`; Time pill; eleven-item "More" fold (`:576-595`).
- Capture sheet tiles for an installer: photo, receipt, gallery, scan (`app/src/components/nav/CaptureSheet.tsx:105-134`; daily log hidden at `:169`).
- Core values strip crossfades every 8 s at the top of every page (`app/src/components/CoreValuesStrip.tsx`).
- One-tap clock-in path is guarded by `app/e2e/clock-in-once.spec.ts`; it must stay green.

**Unit sheet** (`app/src/pages/install/OpeningSheet.tsx`, 2,834 lines)
- Order of sections: chain banner `:1393-1441`, header `:1443-1451`, moved notice, type/status card `:1461-1497`, SpecCard `:1499-1522`, PartsPanel `:1527`, message banner `:1534`, not-on-the-clock gate `:1540-1564`, stage stepper `:1566-1580`, done card `:1582-1649`, redo card `:1651-1701`, UnitRecordCard `:1707`, undo history `:1710-1727`, notes `:1734-1765`, ready gate banner `:1767-1794`, CHECK stage `:1796-2373` (type brain, physical window, rough opening, condition, before photo, flashing, summon, start button), DataOffCard `:2381-2392`, MissedUnitActions `:2394-2406`, site note `:2408-2445`, INSTALL stage `:2447-2586`, CAPTURE stage `:2588-2758`, done modal `:2761-2814`.
- The README already names the stages Check, Install, Capture, More.

**Schedule data for Tomorrow**
- `schedule_assignments` (project_id, start_date, end_date, start_time, status draft|published|…, published_at) and `schedule_assignment_members` (assignment_id, profile_id, role) — `supabase/migrations/20260721010000_crew_scheduling.sql`. Truck link: `vehicle_project_assignments.assignment_id` — `supabase/migrations/20260723030000_vehicle_schedule_link.sql`.
- Read path: `listMyPublished` in `app/src/lib/schedule/api.ts:259-299` (published only, date-windowed); My Schedule page `app/src/pages/MySchedule.tsx`.

**Job facts: what exists**
- Nothing job-level for flashing, fasteners, sill pan, site rules. The GC handshake stores `project_gc_checkins.set_preference` (inset|outset|unknown), `exterior_material`, `interior_material`, `contact_name` — `supabase/migrations/20260981000000_gc_handshake.sql:319-353`; by design "it decides nothing about a unit" (`app/src/lib/gc.ts:20-23`).
- Per-mark `inset_outset` lives in `project_mark_specs.extra` (`supabase/migrations/20260828000000_mark_spec_extra_merge.sql`) and stays authoritative for a unit.
- Readiness: `ReadinessBadge.tsx` and `project_pipeline.ready_state` exist with no itemised source.
- Vocabulary already in the glossary (`app/src/lib/glossary.ts`): Butyl flashing tape, Paper flashing (stucco), Sill pan (formed metal, PVC, fluid-applied), End dam, WRB, Anchor schedule, Fastening sequence.

**Spanish**
- 70 of 93 page files never call `useT(` (`grep -L "useT(" app/src/pages/**/*.tsx`). Installer-path files without it: SignIn, JoinCrew, Scan, MySchedule, Timecard, Travel, TripDetail, Tools, MemoReview, Suggestions, Settings, StuckWrites, Supplies, Takeoffs, Warehouse, storage/*, AskInfinity.
- Catalog: `app/src/lib/i18n/catalog.ts` (append new keys at the END; mid-file edits conflict with every open branch). Test that every key carries en AND es: `app/src/lib/i18n/i18n.test.ts:106-128`. `translate()` never returns a bare key (`translate.ts:4`).
- Language picker component exists: `app/src/components/LanguagePicker.tsx`; profile language is set in Settings.

**Design system (law, do not fork)**
- Tokens in `app/src/index.css:3-121`: light-first OKLCH palette (coral primary), dark mirror under `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]` (byte-identical blocks), `--font-display` Barlow Condensed, `--font-body` Inter, 4-pt spacing scale, type ramp, `--motion` single duration, safe-area and `--tabbar-h` tokens. Section auras via `data-section` (`:200-204`). Motion policy comment `:73-76`: a hover must NEVER move layout.
- 48 px glove targets for day-flow buttons (`index.css:2658-2666`); bottom-bar tab 48 px (`:6339`).
- Shared components today: `components/ui/States.tsx` (SkeletonList, SkeletonCard, EmptyState, QueryError) and `components/ui/Explain.tsx`. The repeated shapes worth extracting: `.wh-row/-main/-title/-sub/-actions`, `.wh-card`, StageChip's solid/soft pair, `.action-btn`, `.next-card`, `.home-card`.
- CSS for this program is scoped under `[data-section="install"]` (the warehouse did the same under `[data-section="warehouse"]`), appended at the END of `index.css`.
- `design/infinity/` (Nocturne, July) is NOT the live system; ignore it.

**Audit proposals still open** (`docs/audit-installer-2026-08-17.md` §2): C Scan page two typed boxes; F any installer can add catalog items; I supplies preview sorts by name.

## Builder laws

- Read `CLAUDE.md`, `CONTEXT.md`, `docs/agents/*.md` first. Use CONTEXT.md terms (unit, opening, session, chain, Redo, summon, Data off).
- One step = one branch `installer/<step-slug>` in its own worktree under `.claude/worktrees/`, one PR, landed one at a time through the full gate: `npm test`, `npm run lint` (≤ 25 warnings), `npm run build`, `npx tsc --noEmit -p tsconfig.app.json`, the python suites CI runs, and targeted e2e on ports ≥ 5199 after `pgrep -f "node_modules/.bin/playwrigh[t] test"` is empty. Run `scripts/checkpoint.sh` from the main checkout after each merge.
- Migration numbering: the number is free only when no branch anywhere has it; tell the build session the number and branch before opening the PR; merge in number order. Step 4's number is reserved: `20261001000000`.
- Any migration that adds an RPC or an INSERT path must be CALLED as an owner on a sandbox job (BLACK22 or MADMOOSE) inside a rolled-back dry run before merge, never just checked for existence (the #578 lesson). This session has no production credential; ask the build session to run the dry run.
- New tables: RLS on, default grants revoked, partner-wall exemption decided explicitly (builders never see job facts), sandbox guards attached, every SECURITY DEFINER function pinned `set search_path = public, pg_temp` with EXECUTE revoked from public/anon and granted to authenticated.
- Every new label ships en + es, appended at the end of `catalog.ts`. Never render `String(err)`; use the `formatApiError` of the surrounding directory. New nav routes need an `appGuide.ts` entry and `UPDATE_DOCS=1 npx vitest run src/lib/roleAccessDoc.test.ts`.
- Screens that change look regenerate their e2e screenshot baselines in the same PR and say so in the body.
- No employee names, user ids, project ids or point totals in commits, PR bodies, tests or this folder. Sample copy uses "with two others", never names.
- Nothing about data flow changes in a design pass: same RPCs, same query keys, same outbox behaviour. If a split needs a data change, that is a separate step.
- Glossary additions for this program: **Job facts** (the job-level build answers a supervisor records once: exterior finish, set depth, flashing system, fasteners, sill pan, site rules, GC contact, notes per elevation) and **Green light checklist** (the itemised list behind a job's ready state; warns, never blocks). Add both to CONTEXT.md and an ADR ("Job facts are job-level answers; the unit spec stays authoritative") in step 4.

## S1 — First open downloads a fraction of today's JavaScript (review item A)

Settled by Q2 (recommendation). Make every route lazy except the shell: the three landings, the unit sheet, Projects, ProjectDetail, Warehouse, SignIn, JoinCrew, Settings, StuckWrites, Diagnostics; clock and capture sheets stay in Layout. pdf.js, three.js and Draco must leave the entry chunk. Every chunk stays in the PWA precache so offline keeps working. Add `app/scripts/check-bundle-budget.mjs` and a CI step that fails when the entry chunk's gzip size exceeds the budget. Acceptance: entry chunk under 700 kB gzip (report the real number), precache manifest lists the chunks, clock-in-once and one opening-sheet e2e green.

## S2 — One list of query keys with the offline flag on it (review item C)

Settled by Q2. `app/src/lib/queryKeys.ts` with typed builders and an `offline: true` flag per key; `OFFLINE_KEYS` in `queryClient.ts` becomes derived from it; the persister reads the flag. A test fails when a page uses a string-literal query key. Land it before any screen adds new cached reads. Do not regress the persisted-cache path (#535: the cache was once deleted on launch).

## S3 — Spanish on the installer's first fourteen screens, with a floor test (review rec 3)

Settled by Q9 (recommendation, option b). Screens: SignIn, JoinCrew, Scan, MySchedule, Timecard, Travel, TripDetail, Tools, MemoReview, Suggestions, Settings, StuckWrites, Supplies, Takeoffs. Sign in gets a language switch above the form (stored in localStorage before login, written to the profile language at first sign-in if the profile has none). Add a test that fails when a route with `minRole: "installer"` renders a page that never calls `useT`, with an allow-list of the remaining files that may only shrink. While in Scan: fold the two typed boxes into one (audit C). While in Supplies: low-stock first in the preview (audit I). Out of scope here: Warehouse, storage/*, Ask — S3b, the very next PR, with the allow-list shrinking to empty.

## S4 — Job facts table and the green-light checklist (review recs 1 + 6)

Settled by Q5, Q6, Q7 (recommendations). Migration `20261001000000_project_build_facts.sql`:
- `project_build_facts` — one row per project: `exterior_finish` (stucco|rock|siding|brick|other), `exterior_note`, `set_depth` (inset|outset|unknown), `set_depth_inches numeric(4,2)`, `flashing_system` (butyl_tape|paper_flashing|fluid_applied|other), `flashing_note`, `fastener_type` (flange_screw|jamb_screw|concrete_screw|other), `fastener_length_in numeric(4,2)`, `fastener_spacing_in numeric(4,1)`, `fastener_note`, `sill_pan` (required|not_required|unknown), `sill_pan_type` (metal|pvc|fluid|tape|none), `site_rules text`, `gc_contact_name`, `gc_contact_phone`, `note_north`, `note_south`, `note_east`, `note_west`, `updated_by`, `updated_at`. Pick-list values are the owner's to confirm (owner action below); keep `other` + note on every list.
- RLS: every crew role reads; foreman+ writes (supervisor+ creates, foreman+ updates); partner users never (add to the partner-wall enumerated list as client-facing-hidden). Sandbox guard attached.
- An RPC `upsert_build_facts(p_project_id, p_patch jsonb)` (definer, pinned, authenticated only) so the form can save one field at a time offline through the outbox.
- A view or pure function `green_light_items(project_id)` returning the six items with `answered boolean` and `who` (role): plan set on file and extracted; exterior finish and set depth recorded; material ETA before start; GC contact and site rules recorded; crew and truck assigned for day one; toolbox talk scheduled. Sources already exist: plansets/extraction, `project_build_facts`, `project_pipeline` materials ETA, `schedule_assignments` + vehicle link for the first published day, toolbox pin-to-date.
- Seed from `project_gc_checkins` when facts are empty (set_preference → set_depth, exterior_material → exterior_note).
- Green light warns, never blocks: `ready_state` cannot be set to ready by hand while items are open (RPC refuses with a plain sentence listing them); nothing else is gated.
- Dry run: call `upsert_build_facts` and read `green_light_items` as an owner on a sandbox job inside a rolled-back transaction (build session).
- UI in the same step: a "Job facts" card on the job Overview tab for foreman+ (supervisor+ sees the six checklist items above the fields, red until answered, each naming who answers it); the open items also appear on the supervisor's Home under "Awaiting you". Installers do not see this card on the job page; they see S5.

## S5 — Job facts card on every unit sheet (review rec 1, installer half)

Settled by Q5/Q6. First card under the spec card, both languages, cached offline through S2's flag. Shows only answered fields, in this order: exterior finish, set depth (and the inch), flashing, fasteners, sill pan, the note for the unit's elevation (derive elevation from the opening's plan pin / elevation view when known, else show all four), site rules, GC contact. If the unit's own spec carries an inset/outset that disagrees, show the spec's value and the line "This unit's spec says <value>; it wins." Empty state: "No job facts yet. Ask your foreman." with a Show-me link into Ask. No editing on the sheet.

## S6 — Today, rebuilt around the first minute (review rec 2 + Q3, Q4, Q10, Q11)

Settled by Q3, Q4, Q10, Q11 (recommendations). Order above the fold: LiveSummonsStrip when ringing → ClockInBlock hero (unchanged one-tap path; Continue-install card takes its place when a unit is running) → **Tomorrow line** → Next card → per-job unit lists → one line of counts (assigned · ready · done). Under a "More" fold, closed by default: Done today (with Unsubmit), Points and badges (SkillTree), How your day works (RoleMaps), Send a recording, Save jobs offline (the strip). Core values strip moves to the bottom of Today for installers and stops crossfading while a shift is open; unchanged on Home and Heartbeat.

Tomorrow line: "Tomorrow · <job> · <start time> · <truck> · with N others · <count> units" from the next published assignment after today for this person (`listMyPublished` window extended to +7 days, published only, never drafts); tap opens My Schedule. Nothing published: "Tomorrow: not scheduled yet". Under it a row of five day chips (Mon–Fri of the current week, today marked, a dot on days with a published assignment). The same line and chips render on Home and Heartbeat (three landings rule; on those landings it reads the signed-in person's own schedule).

Drawer regrouped for installers: Work (Today, Jobs, Schedule, Warehouse, Supplies), Me (Timecard, Points, Learn, Safety, Travel, Photos), Help (Ask, Suggestions, Stuck writes, Diagnostics, Settings, Notifications). Bottom bar unchanged. Regenerate `docs/role-access.md`.

Design pass on Today uses the kit shapes extracted in this step (G, minimum set): `ListRow`, `StatusChip`, `Field` — one file each under `components/ui/`, built on existing tokens, CSS appended under `[data-section="install"]`. Hover never moves layout; every tap target ≥ 48 px.

## S7 — The unit sheet as three steps with one button each (review item E + Q8)

Settled by Q8 (recommendation, option b), after S5 lands. Split `OpeningSheet.tsx` into stage components (`CheckStage`, `InstallStage`, `CaptureStage`, `SheetMore`) with the sheet as the stage router; sticky stage header (back, unit code, type icon, stepper); the stage's one primary button pinned above the tab bar (Start install / Done — capture it / Submit install); everything exceptional under "More": Redo, undo history, notes, site note, Data off, missed-unit actions, unit record. Gates (toolbox, before photo, flashing, clocked in) stay exactly where the server enforces them. No data-flow change; the install e2e specs and the chain/grace behaviour are the guard. Add a `Sheet` (bottom sheet with focus trap and Escape) to the kit while here, used by the done modal.

## S8 — Each remaining installer tool, one PR each

Settled by Q1/Q2. In this order, each adopting the kit and Spanish, each answering one question with one button: Clock sheet, My Schedule, Timecard, Travel + Trip detail, Supplies (+ audit I if not done in S3), Scan (+ audit C if not done in S3), Photos, Learn, Points, Safety + Toolbox history, Notifications, Stuck writes + Diagnostics, Settings, Suggestions, Ask, Memo review, Tools, Takeoffs. Catalog adding stays open to every crew role with a duplicate check before insert (audit F, Q12).

## Owner actions

- Confirm or replace the pick-list values in S4 (flashing systems, fastener types, sill pan types). Defaults ship with `other` + note so nothing blocks.
- After S4 is live, fill Job facts for every active job (the supervisor's list on Home will show them).
- React to the clickable mock of Today and the unit sheet before S6/S7 start.

## Open items (deferred on purpose)

- "Only ping me when I'm named" — waits for the notification center (borrowing 11), which needs a preference table that does not exist.
- Spanish on Warehouse, storage/*, Ask — S3b, immediately after S3.
- Full component kit (Dialog, EmptyState variants) — grows as screens are touched, never as a standalone rewrite.
- One outbox (review item D) and reads-through-lib (F) — next block.
- Foreman "My crew now", supervisor Blockers board, Office landing — next in the review's roadmap, after this installer program.

## Amendment 2026-09-07 — job facts reshaped on the owner's live feedback

After S4/S5 shipped, the owner reshaped the card (separate session, branch `installer/job-facts-lines`, migration `20261002000000_job_facts_lines`): exterior finish, exterior note, set depth and inches become `exterior_lines` (a list of situations, one row each on the unit sheet); `flashing_system_other`, `fastener_type_other` and a single `elevation_notes` are added; sill pan fields and the four per-side notes are dropped; GC name and phone are edited on the GC card. Where this file and that migration disagree, the migration wins. S7 keeps the card's mount under the spec card and does not change its props.
