# Window vendor conventions (Strata / Black Desert)

Ben's business knowledge base, carried over verbatim from the window-viewer
prototype when its 3D fit view was ported into this app (app/src/lib/fitview).
It is the ground truth for reading vendor spec sheets and plans, and for the
hardware vocabulary (`open`, `lights`, panel notation) the fit view renders.
The adapter's hardware inference (lib/fitview/adapter.ts) should follow these
rules; extend BOTH together. Plain bullet points are fine - correctness
matters more than formatting.

## Company

- Owner: Ben Barlow. Crew includes Hayden and Alvin (app accounts: hayden, alvin).
- Roles in the app: "surveyor" can edit everything; "installer" can only mark
  status and attach photos.
- Windows/doors are assigned to specific people per job (Assign button); job
  cards show per-person progress.

## Reading vendor paperwork (Strata / Black Desert conventions)

- Spec-sheet PDFs ("Pictures") carry one numbered CAD sheet per unit (#1-#39).
  Plan PDFs ("Plans") are architect drawings with hand-marked numbers:
  **green = doors, blue = windows**. Plans are always the OUTSIDE view.
- QTY 2 on a spec sheet means the unit appears twice on the plans; the app
  stores them as two units suffixed A/B (e.g. 12A, 12B).
- "iron" written on a plan marks a unit supplied by another vendor (iron door
  company) - NOT in our schedule. On Black Dahlia that was #7, #8, #25.
- Panel notation like "four 835 panels" means each panel is 835 mm wide.
- Corner diagrams on the spec sheet mean the unit wraps a corner. Rule:
  **the longer leg of the window goes on the longer wall.**

## Hardware / opening vocabulary

The `hand` field is the human description straight off the spec sheet; the
`open` field is the machine value that drives the drawing. Current `open`
values: `fixed`, `hinge-l`, `hinge-r`, `hinge-t`, `bipart`, `corner-meet`.

- **Slider panel notation (OXXO):** industry shorthand read from OUTSIDE,
  X = operating panel, O = fixed. Black Dahlia #30 is OXXO.
- **Strata elevation symbols:** an arrow on a panel = it SLIDES in the arrow
  direction; "F" with hatch marks = fixed; a full-height diagonal = hinged
  leaf (apex points to the hinge side); a "90 deg" arc over a flattened
  elevation marks where the unit turns a corner.
- **"Both-side handle"** = the unit opens from the MIDDLE on both sides,
  each operating panel with its own handle at the meeting point.
  Two machine values depending on geometry:
  - `open: "bipart"` - straight wall, middle pair parts outward from the
    center stile (2 center handles + outward slide arrows; edge handle
    suppressed). Example: #30, 2-track 4-panel OXXO slider.
  - `open: "corner-meet"` - the meeting point IS a 90-degree corner
    ("Sliding door 90 Corner meet" on the style line). The operating pair on
    each leg slides AWAY from the corner and stacks onto the fixed F panel.
    Handles sit either side of the corner. Renders per leg via
    `lightsSplit: [mainPanes, returnPanes]`. Example: #29 - 910x3 leg
    (F <- <-) turns to 1196x3 leg (-> -> F) + 914 French door at the far
    end of the long leg.
- "Inward, 3-point lock" / "Outward, 3-point lock" = French-door hardware,
  swing direction as stated, multipoint lock. French doors carry a
  "3 Point Lock" tag on the sheet.
- "lock interior, no key exterior" = lockable only from inside; no outside
  key cylinder.
- Hardware color is called out separately from the frame color - on Black
  Desert it is Gold hardware on Clay frames.

### Door kinds (what the app counts)

Wave X, 2026-09-03. A job card now says how many doors a job has and
which kind they are, so these five names are vocabulary, not just drawing
hints. `doorKind` (app/src/lib/install/specKinds.mjs) reads them off the
spec sheet's style line first and its operation line second:

- **slider** - "Sliding Door", "slider", "patio door". Panels run on a
  track (`open: "bipart"` / `"corner-meet"`). Black Dahlia #29, #30.
- **french** - "French Door", "French door track(Inward opening)". A pair
  of leaves with 3-point-lock hardware. Black Desert #26, #28-#39.
- **bifold** - "Bi-Fold" / "bifold" / "bi fold". Leaves fold and stack.
  No job in this repo has one yet.
- **swing** - "Swing door", "hinged", "pivot", and the commercial /
  storefront leaves whose operation line says so. Mad Moose's entries.
- **other** - a door whose paperwork does not say which. Honest, and
  countable; a foreman fixes it at spec review and the count follows.

**Counted but not drawn.** `doorKind` names five kinds; the fit view has
only `fixed`, `hinge-l`, `hinge-r`, `hinge-t`, `bipart` and `corner-meet`,
and there is no fold and no pivot among them. So a style line reading
"bi-fold", "pivot", "hinged" or "swing door" is counted as that kind and
drawn by `inferHardware` as a plain single pane, because that is the last
branch it reaches. That is a gap in the DRAWING, not a disagreement about
the unit - the two read the same words in the same order, and where the
fit view has no symbol it says nothing rather than inventing one (the same
call `hung` windows already get). Give the renderer a fold or pivot symbol
and this is the paragraph to delete. "Patio door" is NOT in this list: it
is the slider above under another name, and `inferHardware` draws it as
one.

The style line WINS over the operation line, and both win over the
operation letters - Mad Moose's French doors drew as sliders once
(app/src/lib/modelstudio/units.ts, live pilot 2026-09-02) because the
letters were read first. Where a style names two doors ("Sliding Door
with ... French Door", #29), the FIRST is the unit: the supplier writes
the unit and then its neighbours.

An operation line that is nothing but X and O letters names a **slider**,
whatever the count: X/O is slider panel notation (above) and is used for
nothing else, so "XO" is a two-panel patio slider just as "OXXO" is the
four-panel one. `openingUnitKind` already reads those letters that way on
a door's type code.

Careful with `inferHardware` here: it draws a non-OXXO letter string as a
hinged leaf, and that is a DRAWING fallback - the fit view has no slide
arrow for an odd panel count - not a statement that the door swings.
`doorKind` counts the unit; `inferHardware` draws it. They read the same
sheet in the same order, and only the drawing has that gap.

## Thresholds, tracks, sills (from the Strata sheets)

- French doors: "Low threshold", track drawn per swing - "French door track
  (Outward opening)" vs "(Inward opening)". Check which one the section
  detail shows; both exist on the same job.
- "New Track" on a slider style line = current-generation track hardware.
- Sill pan: 1.5 mm aluminum, WINDOW BOTTOM ONLY (doors sit on the track,
  no pan).
- Corner windows can be "laminated butt glaze" - glass meets glass at the
  corner with no post (#32, #33). Laminated panels are labeled on the
  elevation.
- Sheet dimensions read mm(inches); QTY line = how many identical units.

## Code rules (VERIFY with Ben / local jurisdiction - seeded from IRC)

- Tempered glass required: in and next to doors (within 24 in of the edge),
  panes with bottom edge under 18 in off the floor, tub/shower areas.
  All Black Desert glass is already tempered.
- Bedroom egress: min 5.7 sq ft clear opening, min 24 in high, min 20 in
  wide, max 44 in sill height.
- Rough-opening allowance: Ben to fill in the company standard
  (common is unit + 1/2 in each side). TODO.

## Glazing, frames, materials

- House standard on Black Desert: "Insulating tempered Low-E 366, argon,
  black IG spacers"; frames "Thermal-break aluminum, Clay" (Clay = the
  color).
- `obscure: true` = privacy glass (bathroom slots etc.); rendered frosted.
- `lights` = number of glass panes across the unit (drives mullion drawing).
- `tran` = transom split as a fraction of height from the top.

## Measurements

- ALL displayed dimensions are tape-measure inches reduced to sixteenths
  (1511 mm -> 59 1/2"), tagged W (width) and L (length). The mm value stays
  on the spec sheet as the CAD reference line only.
- Survey-measured sizes (`w`/`h`) GOVERN THE ORDER; `scan` is the estimate
  and is never used for ordering.
- Plan tracing calibrates in feet by default.

## Model / data rules

- A unit with `elev: ""` is deliberately unplaced - it must NEVER appear on
  the 3D model, only in the schedule under "Not placed on the model".
- Corner units store `legs: [mm, ...]` + `wrap: "start"|"end"` and render one
  fragment per wall. Legs may number 2 OR 3 - #32 and #11 wrap two corners.
  Each leg carries its OWN W x L size tag (the spec sheet keeps the total,
  and `w` = the sum of the legs).
- **Pane layout** comes straight off the sheet's dimension chain:
  - `panes: [mm, ...]` - pane widths, outside view left to right.
  - `panesSplit: [[...], [...]]` - same, one array per leg of a corner unit.
  - `vpanes: [mm, ...]` - stacked units, heights top to bottom; a NEGATIVE
    value is a solid spacer (#1's 153 aluminum tube).
  - `doorPanes: [i, ...]` - which panes are hinged leaves, indexed across
    all legs. Those panes get the kick plate + hinge diagonal; glass panes
    do not. Every pane shows its width label along the unit's head.
  - Without pane data the renderer falls back to equal `lights` divisions.
- Sheet corrections found on 2026-08-04 while transcribing pane chains:
  #33 corner is at 2458 (between the 2026 and 1518 panes), legs 2458+4052;
  #32 wraps twice (2153 | 5295 | 209+915 door); #11 wraps twice
  (432+2120 | 3x1835 | 597); #35 hinges LEFT, #38 hinges RIGHT.
- #25 is an INTERIOR narrow French door (clear glass, "Interior use" on the
  sheet) - deliberately absent from the exterior model. Only #7 and #8 are
  the iron vendor's.
- Standard opening view of every model is the SOUTH face.
- Separate buildings (detached garage): when focusing a unit, the other
  building goes fully invisible; same-building walls x-ray/ghost.

## Engineering guardrails (do not skip)

- Bump `SHELL_VERSION` in sw.js on EVERY release or phones keep the old app.
- Source files are ASCII-only.
- Test with real pointer sequences and screenshots; synthetic .click() lies.
  Verify visibility with elementFromPoint, not geometry alone.
- The browser pane is shared with Ben - his live taps can corrupt test
  measurements.
- users.json and .secret must never be committed or deployed.

## Ben: add your details below

Things worth writing down as they come up (Claude will use all of it):
- Supplier names, product lines, and how each vendor labels hardware/glass.
- Hardware brands and SKUs you install, and what their jargon means.
- Egress / building-code rules you follow (bedroom egress sizes, tempered
  glass zones near tubs/floors, etc.).
- Frame color names per supplier (like Clay) and their real-world colors.
- How YOUR crew reads plans - any shorthand you write on paper plans.
- Standard install details: flashing, shimming, rough-opening allowances
  (e.g. "RO = unit + 1/2 inch each side").
- Per-builder quirks (e.g. "Strata plans mark iron doors as 'iron'").

<!-- New entries go here -->
