Vendored VERBATIM from https://github.com/charmlinn/blueprint3d-modern
(MIT — see LICENSE here), src/ of 2026-08-13. Compiled by Vite/esbuild only:
the app's strict tsc NEVER parses these files — they are excluded in
tsconfig.app.json (vitest.config.ts excludes this whole directory from
test discovery too, so the two *.test.ts files living in here run under
neither tsc nor `npm run test`) — and reached exclusively through
../core.js (a plain-JS re-export) typed by ../core.d.ts. Keep it
verbatim; upstream diffs drop in.

One deliberate exception to "keep it verbatim": `constants.ts` (the
upstream demo's furniture catalog, ~60 items, plus FLOOR_TEXTURES /
WALL_TEXTURES) was deleted in the chore/prune-pass cleanup, 2026-08-20.
Every item's `image`/`model` pointed at `cdn-images.archybase.com` — a
third-party CDN irrelevant to a windows/doors installer, and the same one
finishes.ts's own comment (`../finishes.ts`) already cites as the reason
Infinity built its own local, network-independent finish catalog instead.
Re-verified before deleting, both ways two prior audits had already found:
zero `import` of `constants` anywhere in `app/src` OR inside `vendor/`
itself (nothing here ever consumed its own demo catalog either), and zero
trace of its content (`archybase`, item keys like `bedOne`, item names) in
a real `npm run build` output. If a future upstream re-sync restores this
file, re-run that same check before assuming it's live again — copying an
upstream directory wholesale doesn't imply it's reachable from `core.js`.

## Unused by Infinity

Capabilities that upstream ships, that Vite bundles because `core.js`'s
export chain reaches them, but that no Infinity code path ever exercises.
Left in place on purpose — this is the "don't re-audit it" note, not a
todo list:

- **HUD rotate arrows** (`three/hud.ts`) — reachable via `three/main.ts`'s
  `Main`, the 3D scene class every `Blueprint3d` instance builds as its
  own `.three` property (`core.js`'s whole reason to export `Blueprint3d`
  at all). Draws a rotate gizmo over a selected item; the app's own 3D
  drag-handle system (`ModelStudio.tsx`) is what installers and
  estimators actually touch.
- **Animated 2D/3D camera toggle** (`three/main.ts`, `Main.setViewMode` /
  `getViewMode`) — an `animejs`-driven camera fly between a top-down "2D"
  framing and the normal 3D perspective. Public methods, never called from
  `app/src`; the Studio only ever runs in one camera mode.
- **Native `CornerItem`** (`items/corner_item.ts`) — reachable via
  `items/factory.ts` (imported by `model/scene.ts`, which every Blueprint3d
  instance builds). Infinity's corner units (window 16's shape) are built
  by the app's own parametric geometry instead (`cornerGeometryInfo` /
  `buildUnitGeometry` in `../unitGeometry.ts`), never by the vendor's
  built-in corner item class.
- **GLB/GLTF loader** (`loaders/GLBLoader.ts`) — `model/scene.ts` always
  constructs one (`this.glbLoader = new GLBLoader()`), so it's unavoidably
  in the bundle. It only ever actually loads something for an item whose
  saved `model` URL ends in `.glb`/`.gltf` — every Infinity unit is the
  parametric box `applyUnitGeometry` builds instead (see `unitGeometry.ts`
  and the prune-pass note above), so in practice it never fires on real
  project data.

**Not on this list, checked and found dead rather than dormant:** the
upstream "room mode" cluster — `config/modes.ts` (room-type presets:
bedroom/living-room/office/kitchen/bathroom/generator/wealth-corner, each
mapped to a default floorplan), `indexdb/blueprint-template.ts` (the
IndexedDB template-cache types those presets serialize into), and
`templates/default.json` / `templates/example.json` (the presets'
seed data) — are used ONLY by `config/modes.ts` and each other.
`config/modes.ts` itself has zero importers anywhere in `app/src` or
`vendor/`, by the same grep that cleared `constants.ts` above. Not
"dormant" (Vite never even pulls them into a chunk) — genuinely
unreachable, same as `constants.ts` was. Left in place rather than
deleted in the prune pass that removed `constants.ts` (narrower scope,
separate change under review); flagged as a follow-up rather than
documented here as something kept on purpose, since nothing keeps it.
