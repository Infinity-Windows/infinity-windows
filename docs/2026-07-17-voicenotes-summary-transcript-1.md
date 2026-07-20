# VoiceNotes Summary — Transcript #1 (Taylor + Ammon, 2026-07-17)

> Source: VoiceNotes-generated summary of the first strategy conversation ("St. George Windows app for QR-tracked installs, voice memos and role-based dashboards"). Provided by Taylor as a reference/benchmark for the depth of detail expected. Companion to the raw transcript at `docs/transcript-2026-07-17-strategy-conversation.md`.

## Overview
St. George Windows discussed splitting into sales/procurement vs installation/services and building an app that standardizes installation execution while tracking every window/door from plan set through warehouse to install and warranty. The meeting aligned on role-based UX (installer/foreman/supervisor/owner), tight time/task tracking, voice-memo-based knowledge capture for AI, and adding warehouse + equipment + safety workflows to remove crew-lead bottlenecks and improve speed/quality/accountability.

## Business context & objectives
- Company currently installs mostly commercial windows/doors (some high-end/custom residential); wide variety of products and configurations (e.g., multi-panel sliders, bifolds, stationary units).
- Key variability: frame material (vinyl vs aluminum), color, jobsite conditions; vinyl performance concerns in high heat (St. George), aluminum preferred for heat tolerance.
- Every install requires at least a 1-year warranty; need traceability to revisit issues, identify failure points, and continuously improve procedures.
- Current pain points:
  - No consistent accountability procedure.
  - Crew lead is a bottleneck for decisions/instructions (flashing type, hardware locations, locating doors/materials).
  - Warehouse/material organization is weak; standard hardware locations not defined.
- Direction: reduce "thinking time" for installers via prompts/standard steps + pre-vetted guidance; increase installation throughput and quality while producing defensible records for warranty/service.

## Product cataloging & standardization
- Goal to list/capture every product the sales team offers and map each to install guidance and expected timing.
- Standardization focus: "install doesn't change too aggressively" despite configuration options; capture repeatable patterns and only add detail when there's a peculiarity.

## End-to-end tracking model (plan set -> warehouse -> job -> install -> warranty)
- Plan set/CAD ingestion as the earliest step:
  - Upload PDF plan set or CAD so the system can "understand what we need" before materials arrive.
  - Pre-create IDs for each expected window/door; assign/activate IDs on arrival.
  - Use "unassigned" pre-printed IDs to detect missing items on delivery.
- Warehouse tracking:
  - Each item gets a unique ID (QR code suggested) to track lifecycle: arrival -> storage location -> job assignment -> movement -> delivery -> install -> after-service.
  - "Warehouse" is an umbrella for multiple storage locations (main warehouse, containers, other sites); IDs should always resolve to a current location.
  - Movement workflow: batch select multiple IDs for a project load-out, then confirm drop-off/unload at jobsite with condition notes (e.g., "none damaged").
  - Office visibility into missing/broken/damaged items to trigger reorders quickly.
- Installation tracking:
  - Link install data to the window/door ID (CAD numbering referenced: e.g., project/building/story/casita + door/window number).
  - Capture installer identity, time taken, complications, and install method so failures can be traced back to procedure and responsible parties.

## Roles & permissions (implementation vs tracking)
- Core distinction: implementers (installers) vs trackers/decision makers (foreman/supervisor/owner).
- Installers:
  - Should not see the full database/analytics; only what's needed to execute assigned work efficiently.
  - Primary UI is "my tasks" for today (and optionally tomorrow/week).
- Foremen:
  - Assign windows/doors to installers; manage crew execution and solve installer-level issues quickly.
  - Should not be burdened with "uncontrollable" project unknowns (e.g., stucco vs rock decision affecting setback); those must be resolved before crews arrive.
- Supervisors:
  - Ensure plan sets are up to date, materials are correct/on site, blockers removed, GC conversations handled; maintain project "green light."
  - Need near-instant project "heartbeat" view (progress and anomalies) across crews/projects.
- Owners/supervisors:
  - Full data access for comparisons (foreman vs foreman, project difficulty vs performance) and accountability conversations.

## Installer workflow & UX principles
- Proposed primary navigation: "My Work/Jobs" and "Warehouse," linked but clearly separated.
- Task model:
  - Each window/door = one task.
  - Installer opens app -> selects project (or is already clocked into project) -> sees assigned tasks -> starts/ends tasks per window/door.
  - Completion should be "spam-friendly": minimal taps; transitions should take <5 seconds.
- Time tracking:
  - Track three buckets: on task, off task (transition/prep while clocked in), and break time.
  - Discussed whether prep time should count as install time; leaned toward including prep in the installation measure for realistic effort, with explicit break tracking.
  - Time tracking doubles as clock-in/out ("I landed on job, I'm doing this task").
- Scheduling is necessary for deconfliction and throughput:
  - Open question raised: who schedules windows/doors to installers (foreman vs office).

## Data capture: voice memos, photos, and AI learning
- Voice memo purpose:
  - A through Z step-by-step description of the install, capturing procedure, rationale, complications, and lessons learned.
  - AI uses transcripts to build a searchable "brain," compare similar installs, learn difficulty, and generate guidance.
- Memo length strategy:
  - Very detailed memos are valuable early to build gold-standard guidance; after sufficient coverage, reduce memo requirement for common products unless updated/unique situation arises.
  - Suggested threshold: after ~20 (possibly 30–40) detailed memos per common product/type, voice memos can be reduced/removed until a change/exception occurs.
- "Gold standard expert" concept:
  - One highly knowledgeable installer could create authoritative install memos across products, but risks: large time commitment and missing jobsite-specific issues.
  - Case-specific issues (e.g., out-of-level wall) still require field capture; approach discussed:
    - Installer flags a complication in-app.
    - Foreman/supervisor/expert provides advice; record it as a memo to enrich the knowledge base.
    - AI can flag "new topic" transcripts for review and incorporation into standard guidance.
- Photo capture requirements tied to task completion:
  - Key install proof points: flashing, level/plumb, inset/outset orientation, drain/outside confirmation.
  - Cosmetic finish: caulk quality (tape lines, tooling smoothness) via photos.
  - Damage reporting:
    - Preliminary damage upon unboxing (photo + alert to foreman/supervisor for install vs hold decision).
    - Accidents during install (scratches, broken glass, drops) with photo evidence.
  - If damaged/out-of-scope issue occurs: installer can skip/defer the task pending resolution; task escalates upward.

## Difficulty/quality/points system concepts
- Difficulty rating per window/door type and per specific install to improve estimating and planning for "hard doors" (e.g., complex sliders, switchable glass, multi-person/day installs).
- Employee grading/points:
  - Use time and quality signals (on/off task, break, anomaly detection like "30 minutes on a 10-minute window") to identify performance issues.
  - Recognition that some delays are out of installer control; need "grace" or exception handling when materials arrive damaged or site conditions block work.
- Data comparison:
  - Cross-reference installs with multiple installers on one door (e.g., 3-person door) to gather multiple perspectives while still counting as one installed unit.

## Issue management & escalation
- Maintain an issues list visible to foremen/supervisors (not installers).
- Prioritization concept:
  - Categorize urgency (e.g., urgent issues with "!!!" that jump ahead of lower-urgency items).
  - Within each priority band, resolve in chronological order.

## Warehouse & equipment tracking (beyond windows/doors)
- Need an equipment section for high-value tools/machinery and scheduling constraints:
  - Track trailers/flatbeds via IDs; scan to reserve/assign to a job.
  - Track specialized suction-cup machines (e.g., ~$30k–$50k units; up to 3,000 lb lift; ~9,000 lb machine weight) to avoid crew conflicts and plan sequencing across multiple projects.
  - Use equipment + window requirements data to plan: which crews can proceed on non-machine windows while waiting for machine availability.

## Safety & training
- Emphasize safety procedures for heavy material drops (crated glass, metal frames, forklifts, straps, chains).
- Need training content: forklift use, safe strapping/rigging, chain/strap ratings, transfer procedures, and where equipment is stored/parked.

## Open questions / decisions to be made
- Who owns scheduling and assignment of windows/doors to installers (foreman vs office vs supervisor)?
- Final policy for prep/transition time: included in task time vs tracked separately (leaned toward including prep in install time while keeping explicit break tracking).
- Voice memo policy: track primarily per installer vs per window/door; discussion leaned toward associating memos to the door/window ID while allowing multiple memos per install when multiple installers participate.
- Define the minimal required "task completion" checklist (which photos/fields are mandatory vs optional by difficulty).

## Action items
- Define who is responsible for scheduling/assigning windows/doors to installers (foreman vs office/supervisor).
- Specify the installer home screen flow (open app -> project -> tasks -> start/end task -> next task/break) and the minimum-tap interactions required.
- Decide and document the time model rules (on task vs off task vs break) including whether prep/transition time is counted within install time.
- Finalize voice memo requirements:
  - Whether memos are associated primarily to installer, door/window ID, or both.
  - Threshold for when memos are no longer required for a product type (e.g., 20/30/40) and the exception process for new issues.
- Define the required photo checklist per task (flashing, level, drain/outside, cosmetic caulk, preliminary damage, accident reporting).
- Design the escalation workflow for damaged/missing/problem windows (skip task -> escalate -> resolve -> resume).
- Define roles/permissions and what each role can view/do (installer vs foreman vs supervisor vs owner), including who can see the issues list and who can assign tasks.
- Outline the warehouse workflow requirements (pre-created IDs from plan set, receiving, location tracking across multiple storage sites, batch move/load/unload with condition reporting).
- Define equipment tracking scope (trailers/flatbeds, suction-cup machines) and how equipment reservations interact with job schedules.
- Identify required safety training modules to host in the system (forklift, rigging/strapping/chain ratings, safe unloading procedures).
