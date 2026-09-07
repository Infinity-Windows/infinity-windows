# ADR-0011: Job facts are the job's answers; the unit spec stays authoritative, and the green light warns, never blocks

Date: 2026-09-06. Status: accepted (owner-approved plan, S4 of the installer
operating system, `.scratch/installer-os/installer-os-spec.md`).

## Context

Before this migration, nothing job-level answered "what's the exterior finish
on this house" or "what fasteners does this job use" — an installer either
asked whoever filed the mark spec or asked again on site. The closest things
on file were the GC handshake's job-level `set_preference` (which the GC
*said* he wants, and which "decides nothing about a unit" by the design in
`app/src/lib/gc.ts`) and each unit's own `project_mark_specs.extra.inset_outset`
(the signature's authoritative per-unit answer). Neither is a place a foreman
can write down "it's stucco, butyl tape, flange screws at 3-inch centers,
metal sill pans, and here's the GC's cell number" once, for the whole crew, on
one job.

Readiness had the same shape problem: `project_pipeline.ready_state` could be
flipped to `ready` by any foreman with nothing behind the flag — no planset,
no crew for day one, no confirmation the GC's site rules were on file. A job
could read "ready" while half of what makes a job actually ready was still
open.

## Decisions

1. **`project_build_facts` is one row per job**, not a log and not a
   per-unit table. Exterior finish, set depth, flashing system, fasteners,
   sill pan, site rules, GC contact, and a note per elevation — filled in
   over time, one field at a time, through `upsert_build_facts` (foreman+).
   Every column is nullable on purpose: a job's facts start empty and get
   filled in as somebody learns them, not all at once from a form.

2. **The per-unit spec still wins for its own unit.** `project_mark_specs.extra`
   is what actually gets installed at one opening; job facts are the job's
   *default* answer, useful for every unit that doesn't say otherwise. S5
   (the read-only card on the unit sheet) shows the job fact and, when a
   unit's own spec disagrees, shows the spec's value with the line "This
   unit's spec says `<value>`; it wins." Nothing in this migration changes
   which one is authoritative — it only gives the job-level default a home.

3. **`green_light_items(project_id)` is computed, never stored.** Six
   questions — planset on file and extracted, exterior finish and set depth
   recorded, materials ETA ahead of day one, GC contact and site rules
   recorded, day-one crew and truck assigned, a toolbox talk pinned to that
   first morning — read straight off the tables that already hold the
   answer. A view that has to be kept in sync by hand is a view that drifts;
   a function that reads live tables cannot.

4. **The checklist warns, never blocks.** `set_project_readiness` refuses
   only the manual flip to `ready` while any item is open, in one plain
   sentence naming them. Nothing else about a job — clocking in, installing
   units, filing a receipt — is gated by it. A crew's ability to work was
   never going to wait on a form.

5. **Seeding from the GC handshake happens once, quietly.** The first
   `upsert_build_facts` call on a job with `project_gc_checkins` on file
   fills `set_depth` / `exterior_note` / `gc_contact_name` from the latest
   check-in before the caller's own patch is applied. The GC already told us
   once; a foreman should not have to type it again for free.

## Consequences

- Migration `20261001000000_project_build_facts.sql`: the table (RLS on,
  default grants revoked, RPC-only writes, sandbox-guarded, partner-walled —
  a client/GC login never reads it, same as `project_pipeline` and
  `project_gc_checkins`), `upsert_build_facts`, `green_light_items`, and the
  warn-not-block change to `set_project_readiness`.
- `app/src/lib/install/buildFacts.ts` is the one place both S4 (the
  foreman-facing card) and S5 (the installer-facing card, a later step) read
  and write from.
- The Job facts card lives on a job's Overview tab, foreman+ only; the
  installer's own read-only view is S5, on the unit sheet, not here.
- A supervisor's Home and Heartbeat both surface a job's open green-light
  count under "Awaiting you" — the same warning, wherever a supervisor
  actually lands.
