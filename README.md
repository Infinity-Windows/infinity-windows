# Window Ops App

Concept prototype for a window installation ops + training brain. Local dev only — perfect these flows before merging into an existing app.

## What's here

- `app/` — Warehouse inventory + install capture PWA (React + Vite + Supabase). Scan-first: QR license plate on every window, QR address on every rack slot.
- `supabase/migrations/` — Database schema + prototype upgrades (also consolidated in [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql) for paste into the SQL editor).
- `supabase/functions/` — OpenAI Edge Functions: Whisper transcription + topic split, tip synthesis, AI schedule extract fallback.
- `scripts/weekly-report.mjs` / `scripts/vault-sync.mjs` — Manual laptop scripts that write markdown into `vault/`.
- `docs/` — Planning notes, hardware list, [catalog CSV template](docs/window-types-template.csv), and the [$1M→$10M scaling roadmap](docs/roadmap-scale-1m-to-10m.md).
- `vault/` — Obsidian-friendly markdown mirror (wiki view; DB remains system of truth).

## Product loops to perfect

1. **Unified job hub** — `/projects/:id` tabs: Overview, Warehouse, Map, Brain.
2. **Single install path** — every install goes through the opening memo sheet (no warehouse-only "Mark installed" when openings exist).
3. **Smart assign** — search shows slot + status, prefers staged/loaded, sets `project_id`, logs a movement.
4. **Demand rollup** — confirmed openings → `project_windows` quantities.
5. **OpenAI brain** — voice → Whisper + topic fields; tip synthesis on the brain card; AI extract when deterministic PDF parse finds nothing.

## Running locally

```bash
cd app
cp .env.example .env   # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

## Supabase setup (prototype)

1. Paste [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql) into the SQL editor (after the base schema is applied).
2. Deploy Edge Functions: `transcribe-install-memo`, `synthesize-type-tips`, `extract-schedule`.
3. Set Edge Function secret `OPENAI_API_KEY` (never in client / git).
4. Create crew users under Authentication → Users.

Optional vault mirror (manual):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/vault-sync.mjs
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/weekly-report.mjs
```

## Tests

```bash
cd app && npm test
```
