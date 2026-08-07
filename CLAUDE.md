# Working in this repo

Window installation ops app — warehouse inventory, install capture, time clock,
training. React 19 + TypeScript + Vite 8 + Supabase, shipped as a PWA. Installers
use it on phones, in the field, often with bad signal.

Everything below is the stuff you cannot learn by reading the code. Read it first;
it will save you rediscovering the same things every session.

## Node 22 is required, not suggested

`.nvmrc` says 22 and it means it. On Node 20, **18 test files fail to load** —
`@supabase/realtime-js` needs a native `WebSocket`, which arrives in Node 22.
The failures look like broken code and are not.

```bash
nvm use 22
```

If tests fail at import time with "native WebSocket not found", this is why.

## Commands

All from `app/`:

```bash
npm run dev      # vite dev server on :5173
npm test         # vitest — ~2050 tests, ~4 seconds
npm run lint     # oxlint — 8 known warnings, treat any increase as a regression
npm run build    # tsc -b && vite build
npm run e2e      # playwright (needs `npx playwright install` first)
```

`npm run build` typechecks `e2e/` too, so it fails when `@playwright/test` isn't
installed. To check only shipped code: `npx tsc --noEmit -p tsconfig.app.json`.

**The test suite runs in about four seconds. Run it after every change.** It is
the reason edits here can be made confidently — use it rather than reasoning about
whether something broke.

## Supabase: one shared project, and a banner that shouts

There is exactly one project — `czprjcskmzzagdztqonm`. `cp .env.example .env` is
the whole setup; the anon key is already in there and is safe (row-level security
is what protects the data). Do not create your own project. Point the app
somewhere else and a red **"Wrong database"** banner appears, because work done
against the wrong database is invisible to everyone else.

## Signing in

Public signup is off and nearly every screen needs a login. There is one test
installer account; its password lives outside the repo:

```bash
cat ~/.config/infinity-windows/test-installer.env
```

If that file is missing, **do not ask anyone for a password** — regenerate it,
see [`docs/test-account.md`](docs/test-account.md).

## Things that will trip you up

**There are two `formatApiError` functions.** `lib/errors.ts` maps PostgREST
codes to plain English; `lib/install/errors.ts` unwraps nested `{error:…}` and
appends `[code]`. Everything under `install/` uses the install one, everything
else uses the other. Follow whichever the surrounding directory uses — don't
"fix" an import to the other module.

**Never render an error with `String(err)`.** `PostgrestError` extends `Error`,
so it stringifies to raw Postgres text and leaks internal constraint names to
installers; plain thrown payloads stringify to `[object Object]`. Always
`formatApiError(err)`.

**"Table doesn't exist yet" checks go through `lib/schemaErrors.ts`.** Features
here ship ahead of their migrations and guard their reads so screens degrade to
empty instead of crashing. That guard used to be hand-written in every api module
— seventeen copies that had quietly stopped agreeing about which Postgres error
codes count. Use `isMissingTable` / `isMissingColumn` / `isMissingFunction`; don't
write a new one inline.

**Column selects are explicit on purpose.** `profiles` holds `pin_hash`, which no
client role may read, so `select("*")` against it fails by design. Add columns to
the existing constants (`PROFILE_COLS`, `OPENING_SELECT`), never widen to `*`.

**Role gating goes through `useEffectiveRole()`.** It supports "view as role", so
an owner previewing *installer* sees the installer UI faithfully while every
mutation stays keyed to the real signed-in user. Use `effectiveRole` for what the
UI shows, `realRole` for anything about identity, and wait on `isLoading` in route
guards — a null role during load is "not known yet", not "no permissions".

**`tsconfig` has `noUnusedLocals`.** Removing the last use of an import breaks the
build. Let `tsc` tell you which ones to drop.

## Maps Interactive (the 3D fit view)

The "Maps Interactive" project tab renders a tappable CSS-3D building — no
WebGL, no three.js — ported from a standalone prototype called window-viewer.

- `app/src/lib/fitview/fitviewRenderer.ts` is **vendored vanilla JS**
  (@ts-nocheck, excluded from oxlint). It is a mechanical port of the
  prototype's `index.html`; keep it diffable — fix bugs, don't React-ify.
  The host injects everything through a shim (toast, openOpening,
  onStatusChange, photos); callbacks it doesn't get render as absent UI,
  so with no shim the detail sheet is read-only.
- `adapter.ts` is the real integration: plan outline + opening pins
  (via `nearestPointOnOutline`) + mark-spec inches → the renderer's job JSON
  in metres. Scale and wall height default (30 m long side / 3.6 m) unless the
  outline's `features.fitview` carries `{ longSideM, wallHeightM }` —
  `scripts/seed-black22-fitview.mjs` writes that calibration for BLACK22 from
  the prototype's hand-traced model (safe by default: plan → --dry-run → --apply).
  NOTE: re-saving an outline from the Plan Model editor replaces `features`
  wholesale and drops the calibration; rerun the seed script.
- Hardware vocabulary (OXXO panels, hinge sides, corner units) and how to read
  Strata paperwork: [`docs/window-vendor-conventions.md`](docs/window-vendor-conventions.md).
  The adapter's `inferHardware` must agree with it; change them together.
- The plan tracer (prototype `trace.html`) is also ported: `traceRenderer.ts`
  behind the foreman+ route `/projects/:id/trace-model` ("Trace 3D model" on
  the tab). It draws footprints over the real planset page (rendered via
  pdfjs), auto-seeds dots from extracted opening pins, and Submit merges the
  survey model into `features.fitview.model` — an existing outline row's
  `points` are never overwritten (they align the flat map's CAD view).
- `fitview.css` is the prototype's CSS scoped under `.fitview-app` by native
  nesting; embed sizing overrides live in a marked block at the end. The
  original prototype lives outside this repo (a zip from Ben) — the fixture
  `fixtures/win-2423.json` is the piece worth keeping and is under test.

## Layout

- `app/src/pages/` — one file per screen; `install/` holds the job-site flows
  (dispatch board, opening sheet, plan map, planset upload)
- `app/src/lib/` — all logic and data access. `install/api.ts` is the big one.
  Pure logic is unit-tested and lives next to its `.test.ts`
- `app/src/components/` — shared UI; `ui/States.tsx` has the skeleton/empty states
- `supabase/migrations/` — schema. Also consolidated in `docs/prototype-migrations.sql`
- `vault/` — generated markdown mirror of *business data* from Supabase, for
  reading in Obsidian. Output, not source. Never hand-edit; `scripts/vault-sync.mjs`
  regenerates it and the DB stays the system of truth

## House style

Match the surrounding code. A few things that are consistent throughout and worth
keeping:

- **Comments explain why, not what** — the constraint, the incident, the migration
  that forces the shape. These are the most valuable lines in the repo; when you
  change code near one, check the comment is still true
- Plain-English UI copy — errors tell an installer what to do, not what the
  database returned
- Commit subjects are one plain sentence about the effect on a person, e.g.
  "Stop windows showing as being installed for days on end". Not conventional commits
- Degrade instead of crashing: a missing table or an offline phone should empty a
  screen, never white-screen it
