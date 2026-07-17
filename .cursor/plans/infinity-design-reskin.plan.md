---
name: Infinity design reskin
overview: 'Reskin the working Window Ops React app so it looks essentially identical to Ammon''s Infinity design (Claude Design export), keeping all existing logic/data. This plan is written as a self-contained handoff so a fresh LOCAL Cursor agent can execute it cheaply on the Mac.'
todos:
  - id: handoff
    content: 'Cloud agent: commit this plan + HANDOFF.md pointing at origin/claude-version design files, push so the local agent can read it'
    status: pending
  - id: extract-ds
    content: 'Extract Infinity design tokens (colors, Barlow fonts, radii, shadows, animations) from Infinity.dc.html + _ds/styles.css into app/src/index.css variables'
    status: pending
  - id: shell
    content: 'Reskin app shell + bottom nav (Layout.tsx), SignIn, PinGate; swap icons/manifest to Infinity branding'
    status: pending
  - id: installer-path
    content: 'Reskin installer screens to Infinity: Home/RoleLanding, MyWork, OpeningSheet, Education, Points, TimeClock'
    status: pending
  - id: lead-path
    content: 'Reskin lead screens: ProjectDetail hub, ProjectMap, Crew, DispatchBoard, Analytics, Qc, Costing'
    status: pending
  - id: support-screens
    content: 'Reskin support screens: Safety, Tools, Supplies, Training, MemoReview, Admin, WindowDetail, Search, Scan, Receive'
    status: pending
  - id: verify
    content: 'Per screen: keep logic untouched, run build+lint+test (95 green), commit one screen per commit'
    status: pending
isProject: false
---
# Reskin Window Ops to Ammon's Infinity design

## Decisions locked (from the planning chat)
- Match Ammon's Infinity design as closely as possible — it should look like we never redesigned it, just made it real.
- The working React app (`app/`) is the source of truth. Claude Design is only a sketchpad for new/changed screens; we do NOT run off it or keep a mirror copy in sync.
- Ammon's exported design already lives in the repo on branch `origin/claude-version`: `Infinity.dc.html` (full mockup, all screens), `_ds/nocturne-*/styles.css` (design system), `support.js`, `icon-192.png` / `icon-512.png`, `manifest.webmanifest`.
- This work should be executed by the LOCAL agent (cost savings). The cloud agent's only remaining job is to commit this plan + a `HANDOFF.md` and push, so the local agent can read it.

## How the local agent picks this up
1. On the Mac: `cd ~/Desktop/window-ops-app && git pull`
2. Open a new agent chat in local Cursor and say: "Read `.cursor/plans/` and `HANDOFF.md`, then start the Infinity reskin."
3. Reference the design source anytime with: `git show origin/claude-version:Infinity.dc.html` and `git show origin/claude-version:_ds/nocturne-ffcb7d00-cc94-48e5-a5dd-d1d8f65cf4f9/styles.css`.

## Design system to extract from Infinity (target look)
- Background `#0C0B0A`, card `#141210` / `#1E1B18`, text `#F3F0EB`, muted `#A39C92`, accent orange `#FF6A1A` (hover `#FF8A4A`).
- Fonts: `Barlow` (body) + `Barlow Condensed` (headings/labels), from Google Fonts.
- Rounded cards, soft shadows, pill buttons, subtle pulse/bar animations (`infPulse`, `infBar`, `infBlink` keyframes already in the mockup).
- Mobile-first phone-frame feel; dark status bar; offline banner styled amber.
- Pull exact tokens from `_ds/.../styles.css` and the `<style>` block in `Infinity.dc.html`.

## Approach: theme first, then screen by screen
Nearly all styling lives in one place — [app/src/index.css](app/src/index.css) — so most of the look changes there once, and every screen inherits it. Per-screen work is mostly matching layout/structure to Infinity.

### Phase 1 — Foundation (biggest visual payoff)
- Add Barlow fonts; replace color variables and base styles in [app/src/index.css](app/src/index.css) with the Infinity palette + type scale.
- Restyle the app shell and bottom nav in [app/src/components/Layout.tsx](app/src/components/Layout.tsx) to match Infinity's tab bar (icons, active state, orange accent, badges).
- Restyle [app/src/pages/SignIn.tsx](app/src/pages/SignIn.tsx) and [app/src/components/PinGate.tsx](app/src/components/PinGate.tsx) as the branded entry screens.
- Swap app icons/manifest to Infinity's (`icon-192.png`, `icon-512.png`, `manifest.webmanifest`, theme-color `#0C0B0A`).

### Phase 2 — Installer path (what crews see most)
- [app/src/pages/RoleLanding / Home](app/src/pages/Home.tsx), [app/src/pages/MyWork.tsx](app/src/pages/MyWork.tsx), the staged install sheet [app/src/pages/install/OpeningSheet.tsx](app/src/pages/install/OpeningSheet.tsx), [app/src/pages/Education.tsx](app/src/pages/Education.tsx), [app/src/pages/Points.tsx](app/src/pages/Points.tsx), [app/src/pages/TimeClock.tsx](app/src/pages/TimeClock.tsx).

### Phase 3 — Lead path
- [app/src/pages/ProjectDetail.tsx](app/src/pages/ProjectDetail.tsx) (hub tabs), [app/src/pages/install/ProjectMap.tsx](app/src/pages/install/ProjectMap.tsx), [app/src/pages/Crew.tsx](app/src/pages/Crew.tsx), [app/src/pages/install/DispatchBoard.tsx](app/src/pages/install/DispatchBoard.tsx), [app/src/pages/Analytics.tsx](app/src/pages/Analytics.tsx), [app/src/pages/Qc.tsx](app/src/pages/Qc.tsx), [app/src/pages/Costing.tsx](app/src/pages/Costing.tsx).

### Phase 4 — Support screens
- Safety, Tools, Supplies, Training, MemoReview, Admin, WindowDetail, Search, Scan, Receive.

## Guardrails while reskinning
- Change look only — do not alter data flow, RPC calls, or query keys. After each screen, run `npm run build`, `npm run lint`, `npm test` (95 tests should stay green).
- Reskin one screen per commit so it's easy to review and roll back.
- Keep the existing offline/PIN/toast behavior intact.

## Reference: screen mapping (Infinity ↔ our app)
Infinity and our app already cover the same features, so it's a 1:1 restyle rather than new screens: Home, Install, Map, Project, Crew, Clock, Points, Learn, Scan, Warehouse, Supplies, Tools, Safety, Quality, Locate, Brain, Profile.
