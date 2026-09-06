# 18 — Data-health chips on the jobs list

Status: needs-triage
Type: task
Size: S

Isaac decides whether the jobs list should carry these; `pipeline_nudges`
already covers part of it.

## Horizon does

`lib/dataHealth.ts` (pure): `no_crew_lead`, `no_planset`, `no_address`,
`duplicate_site`, each with a label and weight; filter chips on the jobs list
and a badge on the card; a sheets/Drive backfill uses the same keys.

## Forge today

`pipeline_nudges` and the pipeline sweep flag jobs missing steps; the jobs
page (#533) shows names and mode badges. A job with no planset, no foreman, or
a duplicate address is found by opening it.

## Build (if yes)

1. `lib/jobHealth.ts` pure: `no_foreman`, `no_planset`, `no_address`,
   `no_specs`, `duplicate_address`; tests.
2. Chips on the Jobs page filter row, a small badge on the card, both
   languages; owner/supervisor only.
3. Feed the same keys into the existing pipeline nudge so it does not become a
   second list.

## Done when

- The fixture project set shows the expected chips in an e2e on the fixture
  harness.
