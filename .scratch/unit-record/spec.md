# Unit Record — read back what the field already saves

Status: settled (grilled 2026-08-17, six decisions, all recommendations accepted)

## Why now

Recon (two agents, full inventory) found the app captures nearly everything and
shows almost none of it back per unit:

- `install_events`: memo topics, grade, server-derived minutes, raw transcript,
  AI `photo_findings` (string[]), voided rounds — grade/memo/transcript/findings
  never re-displayed once installed.
- `attachments`: before/after photos, optional walkthrough video, voice memo —
  linked to the opening only via `install_event_id` (no `opening_id` column);
  never rendered for one specific install (only type-brain aggregates and the
  job photo feed, which doesn't even select the linkage columns).
- `unit_sessions`: full who/when/role/block/rework timeline — fetched on the
  sheet and collapsed to one minutes number (`laborBreakdown`), rows never shown.
- `unit_redos`: reason/pressed_by/resolved_at — past redos never listed.
- `opening_phases.photo_path`: flashing finished-work photo — write-only.
- QC rows can pass/callback an opening but carry no link to its sheet.
- `/completed-installs` is a "Coming soon" stub (out of scope this round).

## Settled decisions

1. **The Record lives on the OpeningSheet** — a section below the Installed
   card. Every selection surface (map pin, dispatch row, jobs list, QC) already
   drills to the sheet; one window = one door. QC rows gain the missing link.
2. **Visible to every role.** Raw facts about one window are the job's history,
   not a comparison. What stays foreman+ is anything that compares: estimate vs
   actual, cohort averages, per-person rollups. (CONTEXT.md Record entry.)
3. **Media is fetched through install events — no migration.** Media belongs to
   an install *round*; querying by the opening's event ids (voided included)
   gives per-round history for free. No `opening_id` column on attachments.
4. **Every round shows**, clearly labeled: "Round 1 — sent back: <reason>",
   "Round 2 — current". Redo fixes appear as labeled rework entries. Void ≠
   delete was the point; the Record is where that pays off.
5. **Full session timeline, plain sentences**: "Isaac started · 8:02", "Blocked
   — missing hardware · 9:14", "Maria helped · 22m". Newest last. The
   dispute-settler.
6. **AI write-only fields surfaced, labeled as AI**: voice memo playable +
   AI topic split beside it; raw transcript behind a fold; `photo_findings` as
   an "AI noticed" note. AI content always labeled so an observation is never
   mistaken for a human's call.

Correction recorded: there is no "before video" capture today — before/after
are photos (required), video is the optional walkthrough at submit. A
before-video capture step was explicitly deferred ("not yet — show back what's
already captured first").

## Shape

- `app/src/lib/install/record.ts` — queries (events incl. voided w/ memo +
  findings; attachments by event ids w/ signed URLs; opening redos) + pure
  builders (`buildTimeline`, `groupRounds`) with tests.
- OpeningSheet Record section: rounds w/ media + memo + grade, timeline,
  flashing photo (signed from `opening_phases.photo_path` — raw path in
  install-media, NOT bucket-prefixed like attachments.storage_path).
- Qc.tsx: row links to the opening sheet.

## Out of scope this round

- `/completed-installs` browser, Photos-page unit filter, mark-number search.
- Before-video capture (deferred by owner).
- Any new capture step; the Record is read-only.
