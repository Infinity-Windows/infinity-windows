# ADR-0010: "On job site" is checked out, and a job's material story has a last page

Date: 2026-09-06. Status: accepted (owner, four confirmed decisions).

## Context

The owner asked for a way to collect all of a job's material and move it to
"On Job Site", through a view where some units can be held back; for that
material to leave the conexes, trucks and bays when it goes; and for a
per-job "Unit Movement Finalized" button that puts the job and its units into
a warehouse history that is hidden from the main warehouse but can be read
later.

The warehouse already had a per-package `checked_out` state whose write
(`checkout_packages`) clears the box, records the destination job, who did
it and why, and is undoable from the unit card. It had no "on site" state, no
bulk-by-job action, no notion of a job being done in the warehouse, and no
history screen.

## Decisions

1. **"On job site" is the checked-out state.** Sending a whole job to site is
   `checkout_packages` over the pieces the person chose, reason "Sent to job
   site". One state, one ledger line, one undo. No new package status.
2. **Finalizing refuses while anything of the job is still in a box**, and
   names the boxes. Hiding a job while glass sits in Conex 4 would make that
   glass invisible to everyone. The way past the refusal is
   `boneyard_job_leftovers`: each remaining piece becomes company stock
   through `reassign_package`, so it stays visible on the yard and each move
   is undoable on its own. (Owner: "a mix of refuse, and an option to move
   product to the Boneyard".)
3. **Foreman and up finalize and reopen.** Sending to site is everyday crew
   work (ADR-0007). Hiding a whole job from the warehouse is a lead's tap, and
   reopening is the same door.
4. **Warehouse-only.** `projects.materials_finalized_at` is a stamp on the
   job; `projects.status` is the office's and is not touched. History shows
   the finalize date; the install side keeps its own close-out.

## Consequences

- Migration `20260999000000`: the stamp, two job-level ledger events
  (`finalized`, `reopened`), `finalize_job_materials`, `reopen_job_materials`,
  `boneyard_job_leftovers`. Finalizing also turns the job's (empty) bay off.
- The warehouse page partitions finalized jobs' packages out client-side,
  beside the testing partition (`lib/warehouse/sendToSite.ts`). Packages are
  never rewritten by finalizing, so reopening is a stamp clear.
- `/warehouse/send/:job` is the one screen for both halves; `/warehouse/history`
  lists finalized jobs. Both are installer-level doors; the finalize and
  reopen buttons inside gate on foreman+ and the server refuses below that.
