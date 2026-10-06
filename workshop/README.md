# Forge Workshop

This branch is a practice environment, not a production release branch. Do not merge the whole branch into master: its production workflows are intentionally quarantined.

The Git baseline is production `ee08f7f`, with the later export change from production `3561c02` consumed as workshop cherry-pick `3baf3fb7` with the workshop guard. The approved steel shell is mounted locally. Field roles and /work now show just Clock in and today’s toolbox talk before a shift. The full redesigned native activity engine is still held in its separately owned candidate. Its assembly refusal has not been removed or bypassed. The workshop is where that integration can be developed safely; a functioning workshop is not proof the full redesign is complete.

## Open the practice app

Use `http://127.0.0.1:5278/` on this laptop. It connects to the separate hosted Supabase project `magcghmnbjiukidyalxd`. The browser shows a WORKSHOP banner and cannot use a production Supabase endpoint in this mode.

The new Clock in button is deliberately pending until the native first-tap paid setup is qualified and connected. It does not invoke the old clock-in behavior. General/Specific grids and the new Data integration are still root-owned work. Existing open shifts keep their established controls. This is an in-progress workshop, not a completed redesign.

Use the Phone view link, or `http://127.0.0.1:5278/workshop-phone.html`, to open the actual app at 390 or 320 pixels. The outer preview mounts no app/clock/outbox and the iframe alone runs the app. Its phone override is local to that frame, without changing the shared display preference, and survives a reload inside the frame. On a narrow Codex panel the picture scales while the app keeps the chosen layout width. It is not a substitute for physical-device testing.

The five real test accounts and passwords are in `~/.config/forge-workshop/LOGINS.md`, outside Git with private file permissions. Sign out and use another account to test its actual permissions. Owner View As is a separate layout preview.

Start from this repository with Node 22.23.1:

```
node scripts/workshop/start.mjs --check
node scripts/workshop/start.mjs
```

The launcher reads only `app/.env.workshop.local`; it strips inherited backend and monitoring variables. It refuses missing settings, privileged browser keys, production references, an unapproved project, and an unsafe origin. `.env.workshop.local` contains only the workshop's public browser key and is gitignored. Admin and management credentials stay outside this repository.

## Data and integrations

The baseline was captured as public schema only, encrypted before leaving the CI runner, reviewed locally, and imported into the empty workshop in one transaction. An initial missing vector extension caused a fully rolled-back attempt; the final import installed that extension and committed. No production Auth rows, photos, timecards, Vault values, cron jobs, or Edge Function secrets were copied. Two generated app-link origins in SQL function bodies were rewritten to the local workshop origin. Forty storage policy definitions were separately recreated against the workshop's own storage service.

Synthetic users use `@forge-workshop.invalid`. Invented jobs use `WKDESERT` and `WKSTAGE`. Their ordinary `is_test=false` flags intentionally exercise regular app permissions; safety comes from the separate database, origin and credentials. They are not real employees or jobs. Public signup is off. Actual email/push/AI/payroll/webhook integrations are not configured, and no Edge Functions were deployed. Those features are outside the initial workshop acceptance scope.

The inherited GitHub workflows are inert under `workshop/quarantined-workflows/`. Vercel automatic Git deployment is disabled in this branch. The one-time schema capture used schema-only commands with the existing backup workflow credentials; that is not an enforced read-only database credential. It was quarantined after successful capture. Ongoing production metadata inspection uses a separate project-scoped Database Read token verified as `supabase_read_only_user`, with transaction read-only on. Workshop writes use a distinct project-scoped token and an exact-target transport; there is no production write command in `scripts/workshop/manage.py`.

## Checks

`playwright.workshop.config.ts` runs only explicit `*.workshop.ts` acceptance cases against the local guarded server and actual workshop Auth/DB. It starts no fixture server and intercepts no API replies. Credentials and browser test results are private, and traces are off to keep typed passwords out of recordings. It must not be run against production. These cases are deliberately excluded from ordinary Playwright discovery.

```
python3 -m unittest discover -s scripts/workshop -p 'test_*.py'
node --test scripts/workshop/start.test.mjs
cd app
npx playwright test --config playwright.workshop.config.ts
```

The schema screening script never executes SQL and is a conservative filter, not a complete security audit. The installed baseline's real roles, persisted workday and isolation checks are separate evidence.

## Still to qualify

Hosted frontend is waiting for permission to create a separate Vercel project on the existing company team. No website was published. The localhost link needs this laptop's development server running. Physical iPhone behavior and a full weak-signal workday remain later checks. The full redesigned time engine, final unit QC/analytics integration remain a root-owned stage integration. The steel-theme visual shell is being integrated separately against the approved October 5 interactive reference.

The new start surface hides the off-clock legacy clock drawer action and shows any saved/refused clock changes with their recovery link. Other inherited legacy routes remain outside the qualified new paid-setup scope and require the main integration audit before a completed redesign or release claim.
