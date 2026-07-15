# Window Ops App

Operations + training brain for a window installation company.

## What's here

- `app/` — Warehouse inventory + install capture PWA (React + Vite + Supabase). Scan-first: QR license plate on every window, QR address on every rack slot.
- `supabase/migrations/` — Database schema (window types, unique windows, locations, jobs, movement log, plansets, project openings, install events) plus demo seed.
- `scripts/weekly-report.mjs` — Inventory health report written into the vault (local). Prefer the scheduled `weekly-report` Edge Function in production.
- `scripts/vault-sync.mjs` — Mirrors install memos from Supabase into `vault/windows/<type_code>/install-memos/` (local). Prefer webhook-driven `vault-autofile` Edge Function.
- `docs/` — Planning and team notes, including the [warehouse reorg playbook](docs/warehouse-reorg-playbook.md), [hardware shopping list](docs/inventory-hardware-shopping-list.md), and [catalog CSV template](docs/window-types-template.csv).
- `vault/` — Obsidian-friendly markdown mirror (wiki view; DB remains system of truth).
- `supabase/functions/` — Edge Functions: Whisper transcription, tip synthesis, AI extract, vault autofile, weekly report.
- `.github/workflows/ci.yml` — vitest + lint + build on every push.

## Inventory model

- Every physical window gets a unique ID (`W-CAS3050-0042`) and a QR sticker. Photos, voice memos, and install records attach to that exact unit.
- Every storage spot gets a `ZONE-RACK-SLOT` address (`S-03-B`) and a QR label.
- Zones: `R` receiving, `J` job staging (one bay per contract), `S` type-sorted stock, `D` damage/hold.
- Every touch is a scan: receive, putaway (system-suggested slot), move, load-out, install, cycle count. All events land in an append-only `movements` log.

## Install capture module (`Install` tab)

Field + office flow for "this project's openings → this physical window → this install evidence → type-level learning." Code lives under `app/src/pages/install/` and `app/src/lib/install/` with a clean boundary from the warehouse module.

Three IDs stay distinct:

- `window_types.type_code` — catalog product (~100 designs), where AI learning stacks
- `windows.window_id` — physical unit (`W-CAS3050-0042`), the warehouse license plate
- `project_openings.id` — hole in the wall on this job's planset, the map pin

Flow:

1. **Planset upload** — drop the job's PDF into the `plansets` bucket. The window schedule is parsed client-side (pdf.js text extract + deterministic mark/type/qty patterns, fuzzy-matched against `window_types`) into draft openings. DWG/DXF files are accepted and stored raw with "conversion queued" — client-side CAD conversion isn't possible; a server-side ODA converter step can fill `converted_pdf_path` later. No AI call in v1; the extract module exposes an `ExtractStrategy` seam so an AI fallback can slot in later.
2. **Opening review** — editable draft list (code, type, location); confirm before install. Confirmed openings are never overwritten by a re-extract (same guardrail philosophy as the Horizon BOM rule).
3. **Project map** — plan pages render client-side to images; each opening is a tappable pin (normalized `pin_x`/`pin_y`), colored by status (planned / assigned / installed). Unplaced openings get a "place pin" tap-to-drop mode.
4. **Opening sheet** — assign the physical unit by QR scan or search (`assign_window_to_opening` RPC validates the type matches), record a voice memo against the fixed topic prompts (`vault/_schemas/install-memo-topics.md`), snap photos, grade 1–5, minutes. Submit writes `install_events`, marks the opening installed, and runs the existing `install_window` RPC when a unit is linked.
5. **Offline queue** — voice/photo uploads land in IndexedDB first and retry on reconnect, so dead spots on site never lose a memo.
6. **Type brain card** — per-type install count, median minutes, average grade, and recent memos from `install_events`.

Voice memos upload as raw audio (`install-media` bucket) with the transcript fields left for a later Whisper step; installers can also type topic notes directly.

## Running the app

```bash
cd app
cp .env.example .env   # fill in Supabase URL + anon key
npm install
npm run dev
```

## Deploy (Vercel)

Root `vercel.json` builds `app/` and rewrites all routes to the SPA. Connect the GitHub repo to a Vercel project with:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Every push to `master` should auto-deploy. Camera scanning needs HTTPS.

## One-time cloud setup

1. Create a Supabase project (free tier) at supabase.com
2. Run the SQL in `supabase/migrations/` (SQL editor, in filename order)
3. Create crew users under Authentication -> Users
4. Put the project URL + anon key in `app/.env`
5. Deploy `app/` to Vercel or Cloudflare Pages with those two env vars

## Tests

```bash
cd app && npm test
```
