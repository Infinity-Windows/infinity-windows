Vendored VERBATIM from https://github.com/charmlinn/blueprint3d-modern
(MIT — see LICENSE here), src/ of 2026-08-13. Compiled by Vite/esbuild only:
the app's strict tsc NEVER parses these files — they are excluded in
tsconfig.app.json and reached exclusively through ../core.js (a plain-JS
re-export) typed by ../core.d.ts. Keep it verbatim; upstream diffs drop in.
