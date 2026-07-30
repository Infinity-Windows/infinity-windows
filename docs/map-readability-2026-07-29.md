# Is the job map readable on a phone? — 29 Jul 2026

The redesigned job map, photographed at 390 px (iPhone 14/15 width, device pixel
ratio 2) on three real jobs, with a measurement attached so "readable" is not
just an opinion.

Run it yourself:

```bash
cd app && npm run e2e
```

That starts the dev server if one is not already up, replays every Supabase call
from committed fixtures, and rewrites the screenshots below. No login, no token,
no network.

## What the numbers mean

Two pins **badly overlap** when the smaller of the two is more than half buried —
their centres are closer than half its drawn diameter. A drawn pin is 30 px when
it carries its mark number and 18 px when the page is too busy for numbers (the
tap target stays 30 px either way, which is why the measurement uses the ink and
not the button).

- **bad pairs** — how many pairs of pins, out of every possible pair, are that
  badly stacked. A page of pins piled on one spot scores 1.0.
- **pins involved** — how many pins are in any bad overlap at all. This is the
  number a crew would feel: 0 means every mark is its own countable dot.

Measured 29 Jul 2026 on branch `readable-2d-job-map`:

| job | sheet | marks drawn | bad pairs | fraction | pins involved | median gap between neighbours |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| BLACK22 | building outline, floor 1 | 42 | 0 / 861 | **0.00000** | **0 / 42** | +1.7 px |
| PECAN14 | building outline, floor 3 | 58 | 17 / 1653 | **0.01028** | **24 / 58 (0.41)** | −1.8 px |
| OAKRIDGE | original plan, page 1 | 3 | 0 / 3 | **0.00000** | **0 / 3** | +57.7 px |

The test fails above 0.02 on the pair fraction and above 0.5 on pins involved.
Those limits are not decoration: stacked pins score 1.0 on both, and PECAN14's
floor 3 already sits at 0.41, so the limit there is barely 1.2× the current worst
case — any real regression on that sheet turns the harness red.

## BLACK22 — 42 marks on one sheet

Every mark is countable and nothing is buried. The shape is derived from the
marks themselves (header: "shape from the marks"), because nobody has traced this
building — `project_plan_outlines` is empty for all three jobs.

![BLACK22 job map sheet at 390px](../app/e2e/__screenshots__/BLACK22-sheet-390.png)

Whole screen, including the openings list:

![BLACK22 job map, full page](../app/e2e/__screenshots__/BLACK22-map-390.png)

## PECAN14 — 57 marks on floor 3 (48 more on floor 4)

The busiest sheet in the company, and the one place where the redesign has not
finished the job. Along the bottom wall a run of marks is a chain of touching
circles: 24 of 58 pins are more than half buried by a neighbour, and the median
neighbour gap is −1.8 px (i.e. touching). It is still countable in a way the
old 30 px five-encoding pins were not, but this sheet is where the next
improvement belongs.

![PECAN14 job map sheet at 390px](../app/e2e/__screenshots__/PECAN14-sheet-390.png)

![PECAN14 job map, full page](../app/e2e/__screenshots__/PECAN14-map-390.png)

## OAKRIDGE — 3 marks, the sparse case

Sparse pages behave: numbers stay on (3 of 3 pins labelled), and neighbours sit
57.7 px apart. Nothing looks broken for having only three marks.

**But this screenshot is of the "Original plan" view, not the building outline,
and that is a real finding rather than a test convenience.** OAKRIDGE's three
marks are recorded on page 1, while the planset the job points at
(`PVTH_Bldg_14_Marked.pdf`) has its floor sheets detected on pages 3 and 4. The
outline view opens on the first detected floor sheet, so it draws the derived
building with **zero marks on it**, and the page switcher only offers pages 3
and 4 — there is no way to reach the marks from that view at all. The harness
says so loudly (`!! OAKRIDGE: the BUILDING OUTLINE view rendered 0 pins`) and
falls back to the original-plan view, which pages by the sheets that actually
carry pins.

Two things are tangled here and both are worth a look:

1. OAKRIDGE is stale seed data — its pins are round numbers like 0.25 / 0.30 and
   its planset is a cover sheet for a different building (Pecan Valley Bldg 14).
2. Independently of that, a job whose marks sit on a page the floor-plan detector
   did not pick has no route to its own pins in the outline view.

![OAKRIDGE job map sheet at 390px](../app/e2e/__screenshots__/OAKRIDGE-sheet-390.png)

![OAKRIDGE job map, full page](../app/e2e/__screenshots__/OAKRIDGE-map-390.png)

## What this replaced (not photographed)

No "before" shots were taken — capturing them means checking out an older commit,
and this branch was being edited at the same time. For the record, the previous
behaviour on these same sheets was: a fixed grey rounded rectangle bearing no
relation to the building, stretched with `preserveAspectRatio="none"`, and 30 px
pins carrying five encodings at once (status colour, door/window colour,
installer initials, route sequence, and an always-on mark number) — which on
BLACK22 meant 42 overlapping words.

## How the harness gets past sign-in

`app/e2e/support/supabaseFixtures.ts` intercepts every Supabase call with
`page.route` and serves JSON captured from production by
`app/e2e/capture-fixtures.mjs`. Honest accounting of what is real and what is not:

**Real production data** — the pin coordinates, page numbers, statuses, mark
codes, window types, assignees, and planset rows for all three jobs, straight out
of `project_openings` / `project_plansets`. The building outlines are computed by
the app's own code from those real pins (BLACK22) or traced from the real PDF
(PECAN14). `project_plan_outlines` is genuinely empty for these jobs, so the
fixture is an empty list.

**Real planset PDFs** — read from `docs/backups/…-storage/plansets/`, i.e. the
actual uploaded files. This matters: which pages are floor plans is decided by
reading the PDF, so a placeholder would have opened PECAN14 on page 1 and
produced a convincing screenshot of an empty building.

**Stubbed** — the signed-in user is a made-up installer ("E2E Fixture", not a
real crew member), and `my_pin_status` answers `false`, i.e. "no PIN on this
device". A PIN is verified server-side and its value never reaches the client, so
there is no honest way to type one in a test. The permissions wizard and
first-run tips are pre-dismissed so a modal is not photographed instead of the
map.

## CI

**Not wired into `.github/workflows/ci.yml`, deliberately.** The harness reads
the real planset PDFs out of `docs/backups/…-storage/plansets/`, roughly 12 MB of
binaries that a fresh CI checkout does not necessarily have, and without them the
PECAN14 case silently becomes a screenshot of the wrong page. Adding the job
today would buy a flaky check, not a safety net. Making it CI-ready means
committing a small, fixed planset fixture whose floor-plan detection is pinned —
worth doing, but it is a change to what is being tested, not a change to the
pipeline.
