# A bay is a box, a unit is a window or a door, and a truck can make a job

**Status: accepted (owner call, 2026-09-06, after four production probes).**

ADR-0004 said a shelf is not a container, and the app kept two answers to
"where": boxes (conex, crate, truck, building) and slots (zone, rack, slot,
with a job's two staging bays among them). Every finder, every split warning
and every trail branched on the pair, and the glossary had to explain "a
shelf is staging, not storage" — a rule with no physical analogue. Two more
duplicates rode along: `packages.category` and `part_type` both answered
"what is it", and a truck for a job the office had not built yet left its
packages under a typed name with no job row behind it.

The owner ran four read-only queries against production before this was
allowed to change anything: no package sits on a slot, no supply has a slot
for a home spot, the old events table was already gone, and the typed-name
material (218 packages under seven names) was filed onto real jobs by hand
first. So the migration moves no data.

Chosen:

- **A job's staging bay is a box** of kind `bay`, one per job, made by the
  same projects trigger that used to make two slot rows, and on first ask
  by `job_bay_box`. Set aside stores into it like any other box. The J-zone
  slot rows are inactive; the `locations` table stays for the racks until a
  later pass drops it. `/labels` and `/loc` retire with it.
- **A unit is a window or a door on its mark** (`project_marks.kind`),
  backfilled from the packages' category. `category` stops being asked per
  piece and drops in a later pass once nothing reads it.
- **A truck for an unbuilt job makes a real job**: `create_placeholder_job`
  is crew work (ADR-0007) and returns a `NEW-` coded project the office
  renames; the same name typed twice returns the same job.
  `pending_job_name` stays for the deploy window and drops later.

Consequences: one location model, so `placeWhere`, `splitUnits` and the
trails lose a branch each in the next cleanup; the job page's staging-bays
panel is gone (the bay shows on the yard like any box); "Set aside" never
refuses for a missing bay again.
