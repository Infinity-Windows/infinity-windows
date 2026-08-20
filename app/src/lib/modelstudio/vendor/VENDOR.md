Vendored VERBATIM from https://github.com/charmlinn/blueprint3d-modern
(MIT — see LICENSE here), src/ of 2026-08-13. Compiled by Vite/esbuild only:
the app's strict tsc NEVER parses these files — they are excluded in
tsconfig.app.json and reached exclusively through ../core.js (a plain-JS
re-export) typed by ../core.d.ts. Keep it verbatim; upstream diffs drop in.

Deleted from the copy, on purpose — don't restore these on an upstream
re-drop: the room-preset cluster (config/modes.ts, types/room_types.ts,
indexdb/blueprint-template.ts, templates/default.json,
templates/example.json). It was upstream's demo-app start screen: pick a
room type, get a seed floorplan. Nothing here imports config/modes.ts, the
other four files were imported only by it, and none of them are reachable
from ../core.js — a sourcemapped production build lists every vendor module
Vite bundles (35) and these are not among them. Dead, not dormant.
constants.ts is equally unbundled but STAYS: finishes.ts points at its
texture lists as the reference for the stretch/scale convention.
