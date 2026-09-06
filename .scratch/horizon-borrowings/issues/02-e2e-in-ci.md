# 02 — Run the e2e suite in CI

Status: ready-for-agent
Type: task
Size: M

## Horizon does

`.github/workflows/test.yml`: `e2e-smoke` (one public spec, blocking),
`e2e-gated` (tagged specs, matrix of `chromium` and `iphone-13`, blocking,
specs skip cleanly when secrets are missing), `e2e-postdeploy`
(`workflow_dispatch` only, for specs that can only pass once a fix is live).
Videos and reports uploaded as artifacts for 14 days on every run.
`playwright.config.ts` has retries 1 in CI, trace on first retry.

## Forge today

59 specs in `app/e2e/` on a 390×844 iPhone viewport, port 5183, every
Supabase call replayed from committed fixtures (`e2e/support/supabaseFixtures.ts`)
— no login, no network, no secrets. Nothing in `.github/workflows/` runs them.
`npm run build` already typechecks `e2e/`. Known flaky under a full run:
`studio-holes`, `delivery-receive`, `vision-placement` (pass isolated; rule in
memory: `--repeat-each 3` before calling a red spec a flake). e2e runs dirty
the screenshot baselines in `e2e/__screenshots__/`.

## Build

1. A new job in `ci.yml` (or a sibling `e2e.yml` on `pull_request` + push to
   master): Node from `.nvmrc`, `npm ci`, `npx playwright install --with-deps
   chromium`, `npm run e2e`. Cache the browser download.
2. Two tiers, like Horizon: everything except the flaky trio is blocking; the
   trio runs in a second job with `continue-on-error: true` and a comment that
   says which PR moves each one back to blocking.
3. Upload `e2e/test-results/` and traces on failure (retain 14 days). Keep
   `video: off` as today; traces are enough.
4. Screenshot baselines: either assert the run leaves `git status` clean for
   `__screenshots__` (so a visual change must be committed on purpose) or
   exclude them from the diff check — decide and write the reason in the job.
5. Add `retries: process.env.CI ? 1 : 0` to `playwright.config.ts`.
6. Wire the job into `notify-failure` (push-only, same as the others).
7. `CLAUDE.md` Commands section: note that e2e now runs in CI and how to read a
   red one.

## Done when

- A PR that breaks `opening-sheet.spec.ts` goes red on the PR.
- Three consecutive green runs on master with the blocking tier.
- Runtime under 15 minutes; if not, shard by file with `--shard`.
