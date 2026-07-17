# HANDOFF — Infinity Windows

Read this first. It carries the full context from the planning chat so a fresh
(local) Cursor agent can continue without re-explaining anything.

## Where things stand
- The app in `app/` is a working React + Vite + Supabase PWA. It is the source of truth.
- The "100x quality" work is done (staged install flow, installer-first nav, the
  QC/points/costing/education flywheel, 105-term glossary, seeds). 95 tests pass;
  `npm run build`, `npm run lint`, `npm test` are all green.
- Next effort: **reskin the app to look like Ammon's Infinity design** — same
  features, just made to look like the mockup. Do not change logic/data, only look.

## The design source (Ammon's Infinity, from Claude Design)
Reference files are vendored into this repo under `design/infinity/`:
- `design/infinity/Infinity.dc.html` — the full mockup, every screen. Open it in a
  browser to see the target look. (It is a Claude Design export, not runnable app code.)
- `design/infinity/_ds/styles.css` — the base "Nocturne" design system it sits on.
- `design/infinity/manifest.webmanifest`, `icon-192.png`, `icon-512.png` — app branding.

They also live on the `origin/claude-version` branch if you need the originals
(`git show origin/claude-version:Infinity.dc.html`).

## Exact Infinity design tokens (pulled from the mockup)
Use these when restyling `app/src/index.css`:

Colors
- Page background: `#0C0B0A`
- Surfaces / cards: `#141210`, `#181614`, `#1E1B18` (raised), `#26211C`
- Text: `#F3F0EB` (primary), `#D8D2C9` / `#E8E3DB` (secondary), `#A39C92` (muted), `#5C564E` (faint)
- Accent orange: `#FF6A1A` (primary), `#FF8A4A` (hover), `#2A1A0E` (orange-tinted bg)
- Amber / warning: `#FFB020`   Danger / red: `#FF5A48`
- Success green: `#3ECF6E` (on `#173023`)   Info blue: `#4A9DFF` / `#7FB7FF`

Type
- Headings, labels, numbers, kickers: **Barlow Condensed** (500–700), often uppercase with letter-spacing.
- Body text: **Barlow** (400–600).
- Load both from Google Fonts.

Shape
- Border radius: 10–16px on cards/buttons (12, 14, 16 most common); ~11px on chips/controls.
- Dark theme, soft shadows, pill buttons, subtle pulse animations (`infPulse`, `infBar`, `infBlink` in the mockup's `<style>`).

## The plan
Full step-by-step is in `.cursor/plans/infinity-design-reskin.plan.md`. Order:
1. Foundation — fonts + color tokens + base styles in `app/src/index.css`; app shell + bottom nav in `app/src/components/Layout.tsx`; `SignIn`, `PinGate`; swap icons/manifest.
2. Installer path — `Home`/RoleLanding, `MyWork`, `install/OpeningSheet`, `Education`, `Points`, `TimeClock`.
3. Lead path — `ProjectDetail`, `install/ProjectMap`, `Crew`, `install/DispatchBoard`, `Analytics`, `Qc`, `Costing`.
4. Support — `Safety`, `Tools`, `Supplies`, `Training`, `MemoReview`, `Admin`, `WindowDetail`, `Search`, `Scan`, `Receive`.

Most of the look lives in one file — `app/src/index.css` — so Phase 1 changes cascade everywhere.

## How to run the reskin (local agent)
1. `cd app && npm run dev` to see the app live while you work.
2. Work one screen per commit. After each screen: `npm run build`, `npm run lint`, `npm test` (keep 95 green).
3. Change look only — do not touch RPC calls, query keys, or data flow. Keep offline/PIN/toast behavior intact.
4. Compare against `design/infinity/Infinity.dc.html` open in a browser tab.

## Collaboration workflow (Taylor + Ammon)
- Always `git pull` before starting; work on your own branch (`yourname/what-you-did`); `git commit` + `git push`; open a Pull Request on GitHub; the other person merges.
- Never both edit `master` directly at once.
- `.env` (Supabase keys) is never committed — it's git-ignored and shared privately.
- Repo: `taylorhorizon/infinity-windows` (private). Default branch `master`.
- Prefer the local agent for daily work (cheap); use Slack `@Cursor` only for quick/away-from-desk tasks (cloud cost).
