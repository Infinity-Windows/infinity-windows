# 17 — Prettier

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`.prettierrc` + `eslint-plugin-prettier`; `npm run format`; formatting is
never a review comment.

## Forge today

oxlint only; no formatter. 309 PRs merged in 30 days carry whatever
whitespace the author's editor produced.

## Build

1. Add `prettier` as a devDependency in `app/`, a `.prettierrc` matching the
   prevailing style (double quotes, semicolons, 2 spaces, trailing commas
   `all`, printWidth 100 — confirm by sampling five files), a
   `.prettierignore` for the vendored renderers, `modelstudio/vendor`,
   `fitview.css`, generated files.
2. One formatting-only PR, no logic. HOLD: a repo-wide sweep of `app/src`
   forces every open branch into a hand-merge. Before pushing it, message the
   active build session and wait for its confirmation that nothing is
   mid-gate; on 2026-09-05 it asked that the sweep wait until its five open
   branches had merged. Land it in a quiet window, never alongside other PRs.
3. `npm run format:check` in `ci.yml`.
4. A git blame ignore file (`.git-blame-ignore-revs`) with that commit.

## Done when

- CI fails on an unformatted file and the format commit is in the blame
  ignore list.
