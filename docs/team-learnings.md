# Window Ops App — What We Learned

*Shareable notes for the team · 2026-07-13*

---

## What we’re building

- App to **optimize operations + training** for a window installation company
- Closed catalog of **~100 window types** used across all projects
- Goal: attach rich knowledge to each window type; AI helps installers on the next job
- New collab (partner + Claude Code locally); separate product from Horizon Solar Hub

---

## Product north star

- Installer opens a window type and sees: **time target, difficulty, ~5 tips, 1 video, watch-outs**
- Every install makes the next one smarter

---

## Collaboration (build together virtually)

- **GitHub = source of truth** (not “local only” folders)
- Both clone the same repo; use **branches + PRs**
- Cursor vs Claude Code doesn’t matter if you share git
- Share secrets via **1Password** / `.env.example` — never commit real keys
- Each person runs the app **locally**; optional later: one staging URL
- Avoid: AirDrop projects, Dropbox’d `node_modules`, one laptop as “the server”

---

## Hardware / hosting (beginner, long-term)

- **Your laptop** = write code, run locally, open Obsidian
- **Cloud** = the always-on brain (not a home server)
- Recommended stack: **Supabase (Postgres + storage + auth)** + **GitHub** + later a web host
- **Don’t buy** GPUs / homelab servers for AI — use hosted AI APIs
- Backups live in the cloud (Supabase + Git), not only on one Mac

---

## The “brain” — how it should work

- **Database = system of truth** (phones, AI, auto-filing)
- **Obsidian = human wiki** (browse, edit, train — local app over synced files)
- Same knowledge, two views — Obsidian is **not** worthless and **not** the phone API
- App must **auto-file** into the brain — no manual “put this in Obsidian”
- Wrong: untagged transcript dumps, or RAG with no `window_type_id`

---

## Obsidian vs cloud (clearing confusion)

- Obsidian runs **locally**; a vault is a **folder of markdown**
- “Cloud vault” = that folder (or a copy) synced via **GitHub / Obsidian Sync / Drive**
- Best for us: **DB in Supabase** + **markdown mirror in Git** + open folder in Obsidian

---

## Real-time save → sorted into vault

1. Installer logs install (window type + time + grade + voice)
2. App writes to **Supabase** (instant)
3. Server also writes a `.md` under `windows/<window-type-id>/install-memos/`
4. Sync to GitHub / Mac → Obsidian shows the new note
5. Installer-facing tips read from **DB** (don’t wait on Obsidian)

**Sort rule:** one window type = one folder; every install stacks there

---

## Data model (clean & scalable)

### Per window type (catalog)

- Specs, seeded difficulty, tutorial, tips/pitfalls, canonical video(s), common parts

### Per physical install (event)

- `window_type_id` **required**
- Job / crew / date
- **Minutes to install**
- **Quality grade** (fixed rubric)
- Voice memo → structured topics
- Context: new vs retrofit, opening condition, access, weather
- Photos; full video optional later

### Rollups (computed)

- Median / P90 time, avg quality, failure rate
- Difficulty updated from outcomes (not only gut feel)
- Top tips mined from memos

---

## What to gather first (AI priority)

### P0 (do these always)

- Correct window type ID
- Install time
- Quality grade
- Short structured voice (obstacles / what helped / do again)

### P1

- Retrofit vs new, opening condition, access
- Failure modes, parts/tools that mattered

### P2

- Problem photos, one golden tutorial video per type

### P3

- Per-install full video (low ROI early)

---

## Voice memos

- After each window: talk through a **fixed topic list**
- Transcript stored with **that window type** alongside past installs
- AI synthesizes **tutorial + tips** from the stack
- Keep **raw memos forever**; regenerate synthesis (don’t overwrite truth)

---

## Obsidian: worth it or not?

- **Use Obsidian if** trainers will browse/edit knowledge like a wiki
- **Skip at first if** you only need phones to work — ship DB + app, add Obsidian when useful
- **Never** replace the database with Obsidian alone
- **Benefit of Obsidian:** human editing, links, search, offline study, non-dev contributions
- **Benefit of DB-only:** fewer moving parts, still a complete product

---

## Phased plan

0. **Lock ~100 window IDs** (wrong IDs = permanent pain)
1. Capture every install: type + time + grade + 60–90s voice
2. In-app “brain card” for each type
3. AI tips after ~5–10 installs per type (humans edit)
4. Golden videos / richer media

---

## One-liner for the team

> **Build on our laptops. Host the brain in Supabase. Version code + vault notes in GitHub. Use Obsidian as the wiki. Auto-file every install by window type so AI can make the next install better.**
