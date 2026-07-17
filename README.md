# Window Ops App

Concept prototype for a window installation ops + training brain. Local dev only — perfect these flows before merging into an existing app.

## What's here

- `app/` — Warehouse inventory + install capture PWA (React + Vite + Supabase). Scan-first: QR license plate on every window, QR address on every rack slot.
- `supabase/migrations/` — Database schema + prototype upgrades (also consolidated in [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql) for paste into the SQL editor).
- `supabase/functions/` — OpenAI Edge Functions: Whisper transcription + topic split, tip synthesis, AI schedule extract fallback.
- `scripts/weekly-report.mjs` / `scripts/vault-sync.mjs` — Manual laptop scripts that write markdown into `vault/`.
- `docs/` — Planning notes, hardware list, [catalog CSV template](docs/window-types-template.csv), the [$1M→$10M scaling roadmap](docs/roadmap-scale-1m-to-10m.md), and the [10x plan](docs/roadmap-10x.md).
- `vault/` — Obsidian-friendly markdown mirror (wiki view; DB remains system of truth).

## Product loops to perfect

1. **Unified job hub** — `/projects/:id` tabs: Overview, Warehouse, Map, Brain.
2. **Single install path** — every install goes through the opening sheet as a
   staged **Check → Install → Capture** flow (exceptions collapse behind "More").
3. **Installer-first** — installers land on **My work** with an install-first
   bottom bar (My work / Clock / Learn / Points / Find); leads run the warehouse bar.
4. **Smart assign & dispatch** — search shows slot + status, prefers staged/loaded,
   sets `project_id`, logs a movement; the dispatch board ranks on learned
   per-installer stats.
5. **Demand rollup** — confirmed openings → `project_windows` quantities.
6. **OpenAI brain** — voice → Whisper + topic fields; tip synthesis + golden video
   in the pre-install briefing; AI extract when deterministic PDF parse finds nothing.

### The flywheel (make it true)

- **QC → learning** — a callback counts as a "problem" in type rollups,
  `learned_difficulty`, and per-installer stats, so rework-prone types route to
  proven-clean installers automatically.
- **Points truth** — install points are **pending** until QC sign-off (confirmed
  on pass, voided on callback); quizzes and the sequence game write real ledger points.
- **Costing truth** — labor cost is derived from clocked `time_shifts` × role rate;
  manual entries are adjustments on top.
- **Education → clearance → dispatch** — a knowledge score (105-term glossary +
  18-step procedure, spaced-repetition + games) gates clearance suggestions, which
  gate what dispatch can assign.

## Modules

Time clock (server-persisted breaks), job costing, education (Daily 5 / Quiz /
Sequence / Glossary), points & leaderboard, safety talks + incidents, tools,
supplies, QC sign-off, crew + roles, admin access requests, and a device PIN gate
(verified server-side; the PIN value never reaches the client).

## Running locally

```bash
cd app
cp .env.example .env   # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

## Supabase setup (prototype)

1. Paste [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql) into the SQL editor (after the base schema is applied). It bundles all prototype migrations in order and is safe to re-run.
2. Deploy Edge Functions: `transcribe-install-memo`, `synthesize-type-tips`, `extract-schedule`, `generate-howto`.
3. Set Edge Function secret `OPENAI_API_KEY` (never in client / git).
4. Create crew users under Authentication → Users, then set roles on the Crew screen.

The bundle seeds the thin modules (tools, a week-long safety-talk rotation) and
adds how-to guides for `CAS3050`, `DH2846`, and `PIC6060` so every screen shows
real content out of the box.

Optional vault mirror (manual):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/vault-sync.mjs
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/weekly-report.mjs
```

## Tests

```bash
cd app && npm test
```
