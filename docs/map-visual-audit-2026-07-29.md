# Why the job map looks bad — investigation, 29 July 2026

Investigation only. No code, no migrations, no renderer decision taken here.
Every row count below was measured against production
(`czprjcskmzzagdztqonm`) on 29 July 2026.

---

## 1. The record: what was actually decided

### Taylor's words, verbatim

27 July, 9:53 AM — the original ask:

> audit your plan harshly, and also incorporate into your plan a way to make
> our "map" or whatever it is right now into an interactive 3d-ish rendering
> that not only makes it easier to visualize the plans but is also like almost
> higher tech and interesting to use; just takes the same core principals we
> have for it right now and gives it a tony stark like upgrade if that makes
> sense.

27 July, 10:03 AM — the constraints:

> audit your 3d job plan. when it is generated job by job, i dont want it to
> have to use ai or whatever, i want it completely coded and programmed within
> the app to be custom to the job. it should show a floor by floor rendering,
> not multiple floors at once. it doesnt need to look like how the house would
> look, very basic design, there needs to be an option to view it in 2d as well
> as 3d and for the functinoality to remain the same. investigate the
> possibilities and assume nothing

All five constraints in the brief are confirmed verbatim: no AI in the
generation path, floor by floor rather than stacked, deliberately basic
geometry, 2D and 3D as equals with identical functionality, per-job and
deterministic. Field phones on cellular is a standing constraint from the
offline-first work, not from this conversation.

### The four-stage three.js plan existed, and was then retracted

`~/.cursor/plans/infinity_remediation_and_3d_job_view_31006295.plan.md`
(34 kB, last written 29 July 12:04) is the live plan. It contains **both**
versions.

The first draft is the one the brief paraphrases: `app/src/lib/install/massing.ts`
with `snapPinToWall` / `wallSegments` / `buildMassing`; two-tap scale
calibration; a migration adding `scale_in_per_unit` and `wall_height_in` to
`project_plan_outlines` plus `sill_height_in` defaults; a lazy three.js +
`@react-three/fiber` chunk under 250 kB gzip and excluded from the
service-worker precache; `ExtrudeGeometry` walls with cut openings;
`InstancedMesh`; `frameloop="demand"`; DPR capped at 2; tap-to-open reusing
`OpeningSheet`; a saved-outline → auto-extract → pin-bounding-box fallback
ladder; status materials; a next-window beacon with camera fly-to; a sequence
scrub. Sequenced T1 geometry core / T2 renderer MVP / T3 live twin / T4 polish
and budget.

**That draft was killed in the same document**, in a section titled "Audit of
my own first draft of this feature." Quoting the plan:

> **I proposed three.js, a 250 kB lazy chunk, and rebuilding every interaction
> inside it. That is the wrong shape for this requirement.** … An axonometric
> projection of the same SVG sheet keeps one set of buttons and changes only the
> numbers fed into them. Identical functionality stops being work and becomes
> structural.

> **I invented scale calibration this feature does not need.** … Cut from v1.

> **I invented a `sill_height_in` column for something a constant solves.**

> **I planned a stacked multi-floor twin, and the data cannot support stacking
> anyway.** … One floor at a time is both what was asked for and the only honest
> option.

> **I claimed tapping a window would open "the identical OpeningSheet, zero new
> sheet." It does not.** … Parity therefore requires extracting that inline card
> into a shared component — work I had priced at zero.

The surviving plan is Phase 3, four steps: **T1** extract a headless
`useProjectMapModel` + `PinDescriptor` + shared `MapOpeningDetailCard` from
`ProjectMap.tsx` with a 2D/3D parity test; **T2** a persisted floor registry
plus three floor-correctness bug fixes; **T3** `app/src/lib/install/iso.ts`, a
pure axonometric projection where 2D is the identity case, then an SVG
"dollhouse" renderer; **T4** the lift transition, wall shading, a CI guard that
no WebGL package has been added, and Playwright screenshots of both projections.

Nothing from either version has been built. `app/src/lib/install/massing.ts`
and `iso.ts` do not exist; there is no `three` or `@react-three/*` dependency.

### One thing the record shows was never actually decided

The agent put the renderer choice to Taylor as an `AskQuestion` with two forks —
SVG isometric vs. true WebGL three.js, and whether "same functionality" includes
dragging pins in 3D. **Neither question was ever answered.** The next thing
Taylor said was "is there an upgraded plan?" So "no three.js, SVG isometric
instead" is the agent's recommendation carrying itself, not a decision Taylor
made. It is worth re-asking, because Taylor asked for **3D** and a snap-rotate
SVG projection is not that.

---

## 2. What the map actually draws today, and why it looks bad

The map is `app/src/pages/install/ProjectMap.tsx` — 1,921 lines, **zero tests**.
It has three tabs: `outline` (the drawn "map"), `building` (the raw PDF page),
and `details` (spec sheets). The complaint is about `outline`.

The `outline` tab draws, in this order:

1. A `<svg viewBox="0 0 1000 …" preserveAspectRatio="none">` containing exactly
   one shape — the building polygon.
2. On top, absolutely-positioned HTML `<button class="plan-dot">` elements, one
   per opening.

That is the whole picture. No walls, no rooms, no doors, no dimensions, no
labels — one flat translucent polygon on a faint graph-paper CSS gradient, with
circles on it.

### Problem 1: the pins physically do not fit

`app/src/lib/install/openingMarkerScale.ts` sizes every pin at a **fixed 30 CSS
pixels**, and `.plan-dot` in `index.css` confirms `width: 30px; height: 30px`.
That size does not change with the sheet size, the zoom, or the number of pins.

On a 390 px phone the drawing is roughly 350 px across. For PECAN14 page 3 —
58 pins spanning x 0.136–0.783 and y 0.097–0.885 — the building occupies about
238 × 193 px ≈ 46,000 px². 58 circles of 30 px diameter is about 41,000 px².
**The pins need ~89% of the entire building's on-screen area.** For BLACK22,
42 pins in a smaller region works out to **over 100%**. They cannot help but
overlap into a solid mass of orange discs. This alone is most of "doesn't give
me a good looking visual."

### Problem 2: the outline tab has no zoom

`zoomControls` is gated to `view === "building" || view === "details"`
(`ProjectMap.tsx:1027`). The one view with the pins on it has no pinch or zoom
buttons at all — only a fullscreen toggle. And in fullscreen the sheet drops its
`aspectRatio` while the SVG keeps `preserveAspectRatio="none"`, so the building
**stretches out of shape**.

### Problem 3: on some jobs the polygon is the sheet border, not the building

`extractBuildingOutline` in `app/src/lib/install/outline.ts` (950 lines) is
genuine deterministic computer vision — pdf.js vector operator parsing first,
then an Otsu-threshold raster fallback with morphological close/open, largest
component, contour trace, RDP simplify and rectilinear snap. No `fetch`, no
`supabase`, no `invoke` anywhere in the module. The "no AI" constraint is
already satisfied.

I ran it against the real production plansets. Results:

| Sheet | Points | Bounding box | Verdict |
|---|---|---|---|
| PECAN14 p3 (58 pins) | 16 | 0.68 × 0.83 | **Real footprint.** Articulated L/T shape, pins fall inside it |
| PECAN14 p4 (48 pins) | 12 | 0.57 × 0.83 | **Real footprint**, matches its pin cloud |
| BLACK22 p1 (42 pins) | 13 | 0.91 × 0.90 | **Sheet border.** The notch at x 0.90–0.95 is the title block |
| BLACK22 p2/p3 | 17 / 10 | 0.91 × 0.90 | Sheet border |

So the extractor is right on PECAN14's floor plans and catches the page frame on
BLACK22 — where the 42 pins sit in the left two-thirds and the "building" is a
box round the whole page. The plan's instruction to "persist the auto-extracted
footprint" would persist that garbage. It needs a validation gate first: reject
any polygon whose bounding box covers most of the page, or that fails to contain
the pins.

When extraction returns nothing, the fallback at `ProjectMap.tsx:1573` is a
literal grey rounded rectangle, `<rect x=120 width=760 rx=10>`.

### Problem 4: there is nothing to colour

All 151 openings in production are status `planned`. Zero installed, zero in
progress, zero with a `sequence`, zero with a measured rough opening.
`install_events` is empty. So the status colours, the route numbering, the
installer badges and the dispatch dimming — all of which the code already
supports — render as one flat colour on every pin on every job.

### Problem 5: "floor" is a raw PDF page number

The switcher reads `Floor 3 · 1/2` because `page` is the PDF page index.
`project_plansets.story_label` exists as a column and is `NULL` on all 7 rows.
Nobody has ever named a floor.

Known, still-unfixed correctness bugs: `autos` (unpinned openings) is not
filtered by page (`ProjectMap.tsx:686`) so an unplaced opening draws on every
floor; only `manualOutlineRows[0]` renders, so a second traced polygon such as a
garage silently vanishes; and `page_number` means "page of the building PDF" for
some openings and "page of the specs PDF" for others.

---

## 3. The number that decides this: how much geometry exists

Production, 29 July 2026:

| Table | Rows |
|---|---|
| `projects` | 3 |
| `project_plansets` | 7 (`story_label` NULL on all) |
| `project_openings` | 151 (150 with pins) |
| **`project_plan_outlines`** | **0** |
| `project_marks` | 0 |
| `project_mark_specs` | 37 (all BLACK22) |
| `project_mark_elevation_views` | 54 (all BLACK22) |
| `project_windows` | 26 |
| `install_events` | **0** |
| `profiles` | 6 |

Per job:

| Job | Openings | Pinned | Pages | `project_windows` | Outlines | Install events |
|---|---|---|---|---|---|---|
| PECAN14 | 106 | 105 | 2 (p3, p4) | 24 | **0** | 0 |
| BLACK22 | 42 | 42 | 1 (p1) | **0** | **0** | 0 |
| OAKRIDGE | 3 | 3 | 1 | 2 | **0** | 0 |

**`project_plan_outlines` has 0 rows. Confirmed.** And this is the fact that
matters most: `app/src/pages/install/PlanModelEditor.tsx` is a **1,769-line
manual tracing tool** — place corners on a faded plan, auto-square to 90°, draw
interior dividers, cut wall openings, save. It has been shipped for weeks and
**has never once been used on any job**.

Openings, by contrast, cost nothing: all 151 were created in single 1–3 minute
batches, machine-read from FreeText annotations already marked on the customer's
PDF. Only PECAN14 has more than one floor's worth of pins.

### The undeployed asset nobody is using as a map

`project_mark_elevation_views` has 54 rows for BLACK22 — deterministically
extracted, named views with per-mark positions and crop boxes: `FRONT ELEVATION
- SOUTH` (8 marks), `RIGHT ELEVATION - EAST` (7), `LEFT ELEVATION - WEST` (6),
`REAR ELEVATION - NORTH` (8), plus courtyard and property views. These are the
architect's own drawings of the building's faces, with every window located on
them. Today they are used only as small reference thumbnails inside a window's
detail card (`MarkElevationViews.tsx`), never as a map view. This is the closest
thing to real, good-looking, per-job building geometry that exists in the
database — and it exists for exactly one job of three.

---

## 4. Renderer, or data? Both — but not in the order the plan assumes

**A three.js renderer would change nothing on two of three jobs.** For BLACK22
and OAKRIDGE there is no footprint to extrude — a 3D engine would extrude the
page border, or a bounding box, and the result would be a featureless slab with
the same overlapping pins glued to it. Prettier lighting on the same absence.

But the blunt version of "there's no geometry, so the renderer is irrelevant"
is **not quite true here**, and it would be dishonest to lead with it:

- **What only real geometry fixes:** walls you can recognise as this house,
  rooms, interior layout, correct window placement along a wall, anything
  floor-by-floor on BLACK22 (which has one page of pins), and any 3D worth the
  name.
- **What a better renderer alone fixes:** nothing, if "renderer" means WebGL.
- **What can be made to look decent from data that exists today:** more than you
  would guess. PECAN14 already has a genuine 16-point footprint available
  deterministically on both its floors, plus 106 located windows and named
  window types. It looks bad today because 58 fixed-size pins are stacked on top
  of each other inside a polygon you cannot zoom into, drawn as a flat grey
  shape with no wall thickness. Every one of those is presentation.

### Where geometry would have to come from

1. **Deterministic PDF extraction — works today, free, half-reliable.** Already
   built, already AI-free, correct on PECAN14, wrong on BLACK22. Needs a
   validation gate and persistence. Foreman cost: **0 minutes.**
2. **Hand-placed pins — already done, free.** All 151 came from PDF annotations
   the customer already marked up. Foreman cost: **0 minutes** when the plan is
   marked; a few minutes of dragging when it is not.
3. **Manual tracing in `PlanModelEditor` — reliable, and nobody does it.**
   12–20 corner taps per floor plus dividers. Realistically **4–6 minutes per
   floor, 8–12 minutes per job**, and it must be redone if the planset is
   re-uploaded. Zero jobs have paid this cost voluntarily.
4. **AI planset extraction.** `ANTHROPIC_API_KEY` **is now set** in production
   and all 11 edge functions are `ACTIVE` — the brief's premise that the key is
   missing is out of date. Whether the key is *valid* is unverified; PR
   [#179](https://github.com/Infinity-Windows/infinity-windows/pull/179) is
   adding exactly that check. Regardless, this path is **barred by Taylor's own
   constraint** — geometry must be coded, not AI-generated — so it is not an
   option for the map even if the key works.

---

## 5. Recommendation

### Lead with this

The map does not need a rendering engine. It needs the drawing to be legible.
Right now 58 thirty-pixel pins are stacked inside a building that occupies about
238 × 193 pixels on a phone, in a view that has no zoom, and every pin is the
same colour because not one window has been installed in this app. Rendering
that in 3D produces the same illegible pile with a shadow under it.

### Cheapest change that meaningfully improves it this week, using data that exists

In rough order of impact per hour, all of it presentation-layer and none of it
requiring new data entry:

1. **Add pinch/zoom to the `outline` tab.** It already exists for the other two
   tabs. Largest single win, smallest change.
2. **Stop drawing pins at a fixed 30 px.** Scale to the sheet, shrink when
   crowded, show the mark code only for the selected or nearby pin. The pin
   cloud stops being a blob.
3. **Fix the fullscreen distortion** — `preserveAspectRatio="none"` plus a
   dropped `aspectRatio` stretches the building.
4. **Validate and persist the auto-extracted footprint.** Reject polygons whose
   bounding box covers most of the page (that is the sheet border) or that do
   not contain the pins. PECAN14 gets a saved, offline, correct outline for
   free; BLACK22 correctly falls through instead of drawing a page frame.
5. **Fall back to the hull of the pin cloud** when extraction is rejected. 150
   of 151 openings are pinned, so every job gets a plausible building shape.
6. **Draw it like a building, not a blob** — wall thickness as a stroked band,
   a shaded interior, a drop shadow, floor names from
   `project_plansets.story_label` instead of "Floor 3". Pure SVG and CSS.

That is a few days of work, no migration beyond a nullable outline write, no new
dependency, and it holds every one of Taylor's constraints.

### Is the four-stage 3D plan worth doing yet?

**No. It is out of order, and the isometric version is too.**

Not because it is a bad design — the SVG-isometric rewrite is a better design
than the three.js draft. Because of what the database says: **zero install
events, ever.** All 151 openings are `planned`, none has a sequence, none has a
measured opening, one of three jobs has no `project_windows` at all, and the
manual tracing tool that would give the feature something to render has been
live for weeks with zero uses.

The plan's most attractive part is the "live twin" — status materials, a
next-window beacon, a timeline scrub that fills the building in as the crew
works. Every one of those needs install data that does not exist. Building a
live twin of a job nobody has started is building a dashboard for an empty
table.

What should come first, in order:

1. **The legibility fixes above.** Days, not weeks.
2. **One real install day.** Until an installer completes a window in this app,
   nobody knows whether the map is even the right tool for finding a window on
   site — and the status colours, the dispatch route and the sequence scrub
   stay theoretical.
3. **Then** decide on isometric, with real usage to argue from, and with the
   renderer fork actually put to Taylor rather than assumed.

### Data-entry burden per option, in minutes per job

| Option | Foreman minutes per job | Notes |
|---|---|---|
| Legibility fixes (1–6 above) | **0** | Nothing to enter |
| Confirm/rename floors | **~0.5** | One-time, per job |
| Persist validated auto-outline | **0** | Automatic; 0–1 min to nudge if wrong |
| Manual trace in `PlanModelEditor` | **8–12** | 4–6 min per floor; repeat on re-upload; **0 jobs have ever done it** |
| Full wall/room geometry for real 3D | **20–45** | Will not happen on a job site |

The 8–12 minute number is the one that kills this feature. A foreman with a
truck to unload does not spend twelve minutes tapping corners so the map looks
nicer, and the evidence is that none has.

### Assumptions in the prior plan that are now false

- **"Only 4 of 10 edge functions are deployed."** All **11** are `ACTIVE`.
- **"`ANTHROPIC_API_KEY` is not set."** It is set, to a unique non-placeholder
  value. Validity unverified; PR #179 addresses that.
- **"26 tables missing from production."** Production now has **76** public
  tables, including every one the plan listed as missing —
  `project_mark_specs`, `push_subscriptions`, `knowledge_docs`, `vault_config`,
  `schedule_events`, `trips`, the vehicle tables. That drift is closed.
- **"Add a `project_planset_pages` floor registry."** A table with that exact
  name **already exists** in production, for extraction progress
  (`planset_id, page_number, ok, attempts, mark_count, error`). The floor
  registry needs a different name, or that table needs extending.
- **"Nothing in the schema relates a page to a floor."** `project_plansets`
  already has `kind` and `story_label`. `story_label` is NULL on all 7 rows —
  unused, not absent.
- **"Persist the auto-extracted footprint."** Would persist the sheet border on
  BLACK22. Needs validation first.
- **"108 of 109 openings pinned across 2 projects."** Now **150 of 151 across
  3 projects**.
- **"`ProjectMap.tsx` is 1,834 lines."** Now **1,921**.
- **`scripts/pgq.sh` defaulting to the wrong project ref** — fixed; the ref is
  now required with no default.
- **"The renderer decision is made."** It is not. The `AskQuestion` offering
  SVG-isometric vs. three.js was never answered.

### One thing that is better than the plan assumed

`project_mark_elevation_views` — 54 rows, named building faces with every window
located on them, deterministically extracted, already in the database. Nobody
has considered using the elevations *as* the map. For a window installer,
standing outside looking at a wall, "here is the front of the building with your
window circled on it" may be a more useful and far better-looking visual than
any floor plan, isometric or otherwise. It exists for one job of three today,
and it is worth an hour to find out why PECAN14 and OAKRIDGE have none before
committing to a floor-plan-shaped answer.
