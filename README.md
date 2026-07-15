# Window Ops App

Operations + training brain for a window installation company.

## What's here

- `app/` — Warehouse inventory PWA (React + Vite + Supabase). Scan-first: QR license plate on every window, QR address on every rack slot.
- `supabase/migrations/` — Database schema (window types, unique windows, locations, jobs, movement log) plus demo seed.
- `scripts/weekly-report.mjs` — Inventory health report written into the vault.
- `docs/` — Planning and team notes, including the [warehouse reorg playbook](docs/warehouse-reorg-playbook.md) and [hardware shopping list](docs/inventory-hardware-shopping-list.md).
- `vault/` — Obsidian-friendly markdown mirror (wiki view; DB remains system of truth).

## Inventory model

- Every physical window gets a unique ID (`W-CAS3050-0042`) and a QR sticker. Photos, voice memos, and install records attach to that exact unit.
- Every storage spot gets a `ZONE-RACK-SLOT` address (`S-03-B`) and a QR label.
- Zones: `R` receiving, `J` job staging (one bay per contract), `S` type-sorted stock, `D` damage/hold.
- Every touch is a scan: receive, putaway (system-suggested slot), move, load-out, install, cycle count. All events land in an append-only `movements` log.

## Running the app

```bash
cd app
cp .env.example .env   # fill in Supabase URL + anon key
npm install
npm run dev
```

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
