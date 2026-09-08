# busybusy workflow review for Forge

Research based on official public product and help documentation. Forge must prioritize iPhone web use; computer layouts are an optional expanded view. This document applies the research to the proposal. It does not claim a signed-in busybusy usability test or access to its source code.

## Recommendation

Organize Forge around a connected daily loop: plan work, publish instructions, help the crew do the work, record what happened, and review exceptions. Make Today, Crew, Schedule, and the job's daily details understandable on an iPhone. Retain the continuous trip sheet and detailed lodging information as Forge-specific requirements.

busybusy is the primary product reference. Horizon remains useful for specific implementation patterns. Development-tool repositories can improve investigation and verification, but should not determine the app's navigation or become runtime dependencies without a demonstrated need.

## Observed architecture of the experience

The public material establishes a product and information architecture. It does not establish database tables, APIs, framework choices, hosting, or transaction guarantees.

| Documented behavior | Implication for Forge |
| --- | --- |
| Planning requests are reviewed in Scheduling, receive people/equipment, and retain a connection to the plan after approval. | Use persistent assignment/trip links and show revisions across views. |
| Dashboard summaries open filtered employee lists or detailed reports. | Every important count should lead directly to actionable records. |
| Individuals and supervisors have different ways to track work. | Present self-service and permitted crew actions in appropriate role contexts, backed by the same timekeeping system. |
| Field reports collect existing project records and have a review/submission flow. | Build a daily report from existing evidence; keep user review and source links. |

Sources: [Scheduling requests](https://helpcenter.busybusy.io/en/articles/13801355-scheduling-requests-from-project-planning), [Dashboard cards](https://helpcenter.busybusy.io/en/articles/9573317-dashboard-cards), [Time-tracking methods](https://helpcenter.busybusy.io/en/articles/9573426-3-ways-to-track-time-in-busybusy), [Field reports](https://helpcenter.busybusy.io/en/articles/9573486-create-a-field-report-ios-android).

Conceptual Forge relationship: Job → draft work/travel plan → published assignments and itinerary → recorded work and evidence → reviewed report. Planning and actual work retain separate states. Each step references existing records; a schedule never manufactures a clock entry.

## Role flows proposed for Forge

**Installer:** open Today, see current work state and assigned job, start or resume through the existing clock, open directions/instructions, capture a photo or issue in that job context, and review the day. Tomorrow and travel remain easy to reach. Unsynced activity is visibly pending.

**Foreman:** open Crew, see who is assigned and their available work status, select the relevant people for permitted actions, address blockers, then review the job day. Scope actions by actual permissions, including whose time the user can manage. Crew selection must be explicit before any group change.

**Supervisor:** open the phone Schedule agenda, choose a date/job, select crew and vehicle, add travel when needed, review conflicts and missing details, and publish. Reopen the same plan from the trip sheet or job. On a computer, the weekly board and side panel accelerate the same operations.

**Owner:** open a short list of decisions and exceptions, inspect the job or crew behind each item, and approve the proposed full-job AI draft when ready. Cost visibility follows existing grants independently of display layout.

These are proposed Forge flows, not claims that busybusy uses these exact screen names or permissions.

## Design principles to apply

1. Show work state and its next action together. A person should understand their current job, clock state, and immediate action without exploring the full menu.
2. Keep primary destinations few and stable. Place less frequent tools behind a clearly labeled More entry; retain the existing installer navigation until its current changes are reconciled.
3. Keep summaries actionable. A missing assignment or unresolved issue opens a filtered list rather than a general dashboard.
4. Preserve job/date context when moving between crew, schedule, photos, and reports. Back navigation restores the previous position and filters.
5. Distinguish local draft, pending sync, server-saved, published, and notification delivery. These are different outcomes that need distinct feedback.
6. Use progressive disclosure within a continuous trip sheet. Departure, destination, directions, lodging access, and contacts remain easy to find.

The layout, spacing, component styling, and exact navigation above are Forge recommendations. Public documentation provides workflow evidence; it is insufficient for a pixel-level evaluation of the current signed-in busybusy interface.

## One web app, two layouts

Provide Auto / Phone / Desktop in display settings, saved per browser/device. Auto is the default. Both layouts share URLs, data, permissions, validation, and mutations. Changing layout preserves current context and unsaved work. Phone mode on a laptop remains available; desktop mode on an iPhone must keep the return control reachable.

| Phone layout | Computer layout |
| --- | --- |
| Single-column Today with a prominent current action | Wider daily summary with adjacent detail |
| Day agenda and touch date selector | Weekly crew board and additional filters |
| Full-screen plan editor | Editor alongside selected assignment |
| Person cards with explicit group selection | Denser crew list with detail panel |
| Continuous trip sheet and jump links | Same trip sheet with a summary column |

Design and verify on iPhone first. Test ordinary Safari and, where supported, the Home Screen version. Cover narrow screens, increased text size, English/Spanish, keyboard visibility, browser Back, file/camera return, connection loss, and returning after the browser was suspended. Any drag interaction needs a tap-based alternative. Actual iPhone verification remains required before claiming these behaviors work.

## What changes in the implementation plan

First, map the existing Today/crew functionality and coordinate around Claude's active work. Then implement the explicit schedule/trip link and reliable publication, with phone agenda and continuous trip review. Expand the same flows for computer use. Add a job-day evidence/report increment after the basic operational loop works. Extend AI through the shared draft/review/publication flow.

Retain Forge's installation-specific work, warehouse/material readiness, lodging fields, Spanish support, and existing location policy. No backend rewrite is justified by this review. Browser capability, offline reliability, and live permissions need direct testing in Forge.

## Remaining evidence and access

Public sources are sufficient to establish this direction. A busybusy demo or authorized signed-in session would allow a closer review of real screen hierarchy and interaction details; it is optional for continuing Forge design. Forge's management test session and current Supabase schema are needed to verify implementation assumptions. The current GitHub branch and Claude changes must be refreshed before code edits. Gmail, Drive, and Backblaze access are not needed for this design work.

Implementation is tracked in `.scratch/forge-workflow/spec.md`. The first code slice converts Trip Detail into a continuous sheet. Display preferences, linked publication, and job-day reporting remain separate tracked steps. No production data changes are part of the first slice.
