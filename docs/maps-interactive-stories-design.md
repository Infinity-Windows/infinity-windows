# Maps Interactive: stories — design for multi-story models (up to 8)

Owner/supervisor tool for building editable 3D models of homes and apartment
buildings, story by story. Installers and foremen see the model; they never
edit it here. The theme stays what it has always been: **make the window
install as obvious and visual as possible, let the app build as much as it
can itself, and where the drawings don't say — label it unclear instead of
guessing.**

Grounded in three inputs: a UX study of Home Design 3D (Steam, v4.2+ floors)
and the tools that beat it at multi-story editing; a study of US drafting
conventions for how plan sets actually encode stories (AIA/NCS numbering,
level datums, typical-floor notes); and an audit of what this codebase
already has. Sources and the full heuristic table live at the bottom.

---

## 1. What we already have (more than expected)

- **The renderer already knows floor levels.** `building.levels[]` drives the
  framing view's rim bands and cripple-stud runs, and window `y` is an
  absolute height — Ben used exactly this to fake BLACK22's great-room
  clerestories (#6, #24 at y=3.6 m inside one 4.7 m volume).
- **Multi-mass footprints already render** (`building.footprints[]` — the
  Black Dahlia is two masses today).
- **Sheet text extraction exists** (`extractSheetTextLines` returns positioned
  text per PDF page) — the raw material for "this sheet says SECOND FLOOR
  PLAN".
- **Openings already carry `page_number`**, and elevation crops per mark
  already exist (`MarkElevationViews`) — the two strongest story signals are
  already flowing through the pipeline.
- The tracer has per-image registration, action-level undo, auto-trace and
  auto-place. Stories extend it; nothing gets thrown away.

## 2. Data model

Extend `features.fitview.model` (existing single-story models stay valid —
absence of `stories` means one story, exactly today's shape):

```jsonc
building: {
  stories: [
    {
      n: 1,                     // 1..8 (no hard cap in data; UI designs for 8)
      name: "Ground",           // display name; split-levels get real names
      elevM: 0,                 // floor datum, metres above story 1's floor
      heightM: 3.05,            // floor-to-plate for THIS story (podium ≠ typical)
      footprints: [[…]],        // per-story masses; a partial upper story is
                                //   just a smaller polygon (BLACK22's great room)
      partial: false,           // mezzanine/loft flag: own datum, not a full story
      source: "traced" | "copied" | "detected"
    }
  ]
}
window: {
  story: 2,                     // geometric story band it sits in
  servesStory: 1,               // double-height: the room's floor it belongs to
  storyConfidence: "confirmed" | "probable" | "unclear",
  storyEvidence: "A-103 title: THIRD FLOOR PLAN",   // always show the why
  y: 0.9                        // sill, metres above ITS OWN story's floor
                                //   (was: above ground — relative survives edits)
}
```

Three deliberate calls:

- **Per-story heights, not one number.** Podium apartments have a tall ground
  story; the section's level datums disagree with "N × 3 m" and the drawings
  win.
- **`story` vs `servesStory`.** A great-room clerestory sits in the story-2
  band but belongs to a room whose floor is story 1. Installers care about
  both: one decides where it renders, the other decides the lift/scaffold.
  This is the honest model of the BLACK22 case.
- **Sill height relative to its own floor.** Editing a story's height must not
  silently move every window above it; relative sills make story edits local.

## 3. The tracer becomes a story editor (supervisor+)

Borrowed deliberately, each from the tool that does it best:

- **Elevator switcher** (Home Design 3D): a story rail — `▲ / 2 of 3 / ▼` plus
  numbered chips `1 2 3 … 8`. Up past the top offers to add a story. Works
  in the tracer and (view-only) in the 3D tab.
- **Ghost of the story below, always** (Sweet Home 3D): while tracing story 2,
  story 1's walls render light under the plan image, so the upper footprint
  snaps visually to the lower one. In 3D, the active story carries a colored
  outline (HD3D's "blue line", in coral).
- **Three-intent Add Story dialog** (RoomSketch3D): **Copy the footprint
  below** (the 90% case for houses) · **Draw from scratch** (ghost as guide)
  · **Partial story** (mezzanine/great-room band — BLACK22's answer: trace
  the small box over the great room, done).
- **Selective copy** (Houzz Pro): copying a story asks what comes along —
  footprint only, or footprint + windows-in-place (for apartment floors that
  really repeat).
- **Typed entry everywhere + snapping you can turn off** — HD3D's two most
  hated frictions, inverted into features. Every dimension (wall length,
  story height, sill) gets slider *and* a type-in field; wall snap is a
  toggle.
- **Per-story wall height** with per-wall override later. HD3D's per-room-only
  rule blocks real buildings; we start per-story (matches the data model) and
  leave per-mass override room.
- **Assigning windows to stories, manually**: the dot tray groups by story;
  the active story's dots are solid, other stories' fade. Drag a tray chip
  while story 2 is active → it's a story-2 window. Moving an existing window
  up a story is: switch story, drag its dot on. An **Unclear** tray section
  holds anything auto-detection couldn't place (see §5) — placing it is one
  drag.
- **Scale**: keep the calibration line, and add the auto-suggestion we
  already have the data for — pins mark positions and specs know true widths,
  so the app can PROPOSE the scale and the line becomes a one-tap confirm.

Role change (action item): the trace route is currently foreman+; this
feature's spec is **owner/supervisor edit only** — gate `MapsTrace` and Submit
with `isSupervisorPlus`, leave the 3D tab visible to everyone.

## 4. The 3D tab grows story controls (everyone)

- **Story chips** beside the wall chips: `ALL · 1 · 2 · … · 8`. Tap a story:
  other stories drop to a dim x-ray so "the story-3 windows" is one tap and
  unmissable — the apartment-building payoff.
- Slab lines render between stories (the `levels` machinery, promoted from
  framing-only to always-on subtle bands).
- Search/schedule rows show the story ("W-312 · Level 3"), and the detail
  sheet shows story + serves-story with the evidence line.
- Rendering cost stays CSS-3D-cheap: a story is just another set of wall
  faces from its own footprint at its own base height — the multi-mass
  machinery already does the hard part.

## 5. Auto-build: read the plans, assign the stories, admit uncertainty

The pipeline, mapped onto research heuristics H1–H6 (full table below) and
existing code. **Governing rule: two independent signals agreeing = confirmed;
one = probable; conflict or none = unclear — never silently pick.**

1. **Sheet-title grammar** over `extractSheetTextLines` output: match
   `(FIRST|1ST|…|MAIN|UPPER|LOWER|GROUND|BASEMENT|TYPICAL|LEVELS? \d+(-\d+)?)
   … (FLOOR|LEVEL) … PLAN`, filtered against DEMO/EXISTING/CEILING/FRAMING/
   FOUNDATION/ROOF sheets. Relative words (MAIN/UPPER) resolve against the
   whole set. → a **page → story map**.
2. **Openings already have `page_number`** → most windows get their story
   free, with evidence "sheet A-102: SECOND FLOOR PLAN". This is the single
   biggest win and it's nearly zero new extraction.
3. **Schedule LEVEL/FLOOR column** (specs pipeline already parses schedules)
   and **mark-encodes-floor** (`W-201`, doors `201…`) — validated against #2
   on known marks before being trusted, per the research's warning that many
   sets number by TYPE not floor.
4. **Elevation level lines** — the arbiter for the hard cases. We already
   crop marks on elevations; extending extraction to read datum labels
   (`FIN. FLR.`, `T.O. PLATE`, `LEVEL n` + heights) gives (a) true per-story
   heights for the model and (b) story-banding for exactly the windows the
   floor plans argue about. The research is blunt: double-height/clerestory
   marks have **no settled home** on floor plans — sometimes upper plan,
   sometimes dashed on lower, sometimes elevation-only. That is BLACK22's #6
   and #24, and why "unclear" is a first-class answer.
5. **Typical-floor expansion** (apartments): "TYPICAL FLOOR — LEVELS 2-6"
   expands into cloned stories with synthesized per-story marks
   (`L3-W12`), per-story heights from the section, mirroring on "OPP. HAND"
   floors — and everything cloned from a "SIMILAR" sheet lands as
   **probable**, never confirmed, because the drawings only assert
   near-identity.
6. **Auto-trace per story**: outline extraction pointed at each mapped plan
   page seeds that story's footprint; the story editor's ghost + drag fixes
   the rest.

**The Unclear queue** is the same pattern the app already trusts for specs
review: a strip of unplaced windows, each showing its conflicting evidence,
resolved by dragging onto a story. Nothing enters the crew's view as fact
that a human didn't either confirm or the drawings didn't doubly prove.

## 6. Rough draft → final

A model carries a status: **Draft** (banner on the 3D tab: "model is a draft
— sizes and stories may move") until a supervisor marks it **Confirmed**.
Auto-built content starts Draft; the crew always knows which one they're
looking at. Re-running auto-build never overwrites human-confirmed
assignments (same rule as pins: extraction seeds, people decide).

## 7. Phasing

- **Phase 1 — stories exist (manual).** Data model + renderer stacking +
  story rail/ghost/Add-Story in the tracer + story chips in the tab + role
  tightening to supervisor+. BLACK22 gets modeled *properly*: partial story-2
  box over the great room, #6/#24 assigned story 2 / serves story 1.
- **Phase 2 — the app reads stories.** Title grammar + page→story map +
  openings auto-assignment + Unclear queue + evidence lines.
- **Phase 3 — apartments & arbiters.** Typical-floor expansion, schedule
  LEVEL column, mark-prefix validation, elevation datum reading (per-story
  heights + double-height arbitration), auto-scale suggestion.
- **Big bet — full auto-build:** upload a set, get a Draft 8-story model with
  confidence-labeled windows, supervisor resolves the Unclear tray, marks
  Confirmed. Phases 1–3 are each independently shippable steps toward it.

## Appendix: research heuristics (condensed)

| # | Signal | Confidence rules |
|---|---|---|
| H1 | Sheet-title grammar per plan viewport | High with explicit ordinal/level; Medium for MAIN/UPPER/LOWER; reject DEMO/EXISTING/RCP/FOUNDATION/ROOF |
| H2 | Sheet-number ladder (A-101→A-102…) | Medium as cross-check only; NCS says sequence is user-defined; area-splits break it |
| H3 | Mark encodes floor (`201`, `W-3xx`) | High only after validating against known-sheet marks with zero contradictions |
| H4 | Schedule LEVEL/FLOOR column | High; `LOCATION` (room names) only Medium |
| H5 | Elevation level-line banding | High for tagged windows inside a band; the arbiter for double-height; flags straddlers/gables |
| H6 | Typical-floor notes ("LEVELS 2-6", "SIM.", "OPP. HAND") | High for explicit ranges; "SIMILAR" floors land as probable, never confirmed |

Known unclear-by-nature: untagged clerestories; SIMILAR/opposite-hand floors;
split-level ordinals (model by datum, ask for names); title/schedule
conflicts; raster sets with failed OCR; type-based marks with no level info;
windows straddling level lines.

Key sources: NCS v5 FAQ (sheet numbering, basement/mezzanine designators);
Archtoolbox sheet-number guide; Life of an Architect (window schedules);
STRUCTURE magazine (5-over-2 podium); IBC §505 (mezzanines); Home Design 3D
official support KB + TUTO videos 2/3/14/16/17 (floors, walls, import,
openings); Sweet Home 3D multi-level guide (level tabs + ghosting); Houzz Pro
(selective floor duplication); RoomSketch3D (three-intent Add Floor); Chief
Architect KB-00303/KB-00172 (reference display, copy-to-floor).
