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

## Amended 2026-09-07 — the owner's first look at the card

After one look at the live card, Isaac changed four things, shipped as
migration `20261002000000_job_facts_lines.sql`:

1. **Exterior finish and set depth are a list, not two columns.** A house is
   brick on the front and stucco on the sides; the crew hits both. Each
   *exterior situation* is a finish, its set depth, the inch, and a note, in
   `project_build_facts.exterior_lines` (jsonb, replaced whole on every save,
   at most 20). Decision 1 above still holds — one row per job — the row
   just carries a list. Decision 2 changes shape: the unit's spec now "wins"
   only when it names a set depth that no recorded situation uses; a unit on
   the stucco side whose spec says inset agrees with the stucco line.
2. **"Other" is a box, not a dead end.** `flashing_system_other` and
   `fastener_type_other` hold the real name when the pick-list has no word
   for it, and that name is what the unit sheet shows.
3. **No sill pan.** A sill pan is a fact about a unit, and the unit spec is
   where it belongs. The two columns are dropped.
4. **One elevation-notes box** replaces the four per-side notes; the side is
   written into the text when it matters.

The GC's name and number stay on the row (the handshake seeds the name and
the green-light checklist reads it) but are shown and edited on the GC card
at the top of the job, beside the rest of the GC's information — the owner's
call was about where they live on the page, not in the database.

In the same breath, the per-job cost-code subset (`project_cost_codes`,
migration 20260973000000) was retired: every clock-in offers the whole active
library. The table and its RPC stay in the database, unread.
