# __screenshots__

Pictures the Playwright specs write while they run — not visual-regression
baselines. No spec in this repo asserts against a file in this directory (no
`toHaveScreenshot` / `toMatchSnapshot`, and nothing reads a path back in); the
actual checks are DOM/data assertions made before the screenshot is taken.
These are for a human to eyeball, and their bytes change on every run
(recompression, anti-aliasing) even when nothing meaningful did, so treat a
diff here as noise, not a regression.

That's why `.gitignore` excludes `*.png` here: run `npm run e2e` (or the
`storage`/`studio` specs) and look at whatever lands in your working copy.

Six files are the exception and stay committed:
`BLACK22-map-390.png`, `BLACK22-sheet-390.png`, `PECAN14-map-390.png`,
`PECAN14-sheet-390.png`, `OAKRIDGE-map-390.png`, `OAKRIDGE-sheet-390.png`.
`docs/map-readability-2026-07-29.md` embeds those six by path so the audit
renders on GitHub. Re-running the suite regenerates them too, and yes, that
still shows up as a diff — an accepted cost of keeping that doc's pictures
real. If that stops being worth it, freeze copies into a docs asset folder
instead of writing over the tracked files.

`overlap.md` is rewritten in full by every `job-map.spec.ts` run the same way,
but it's a data table, not a screenshot, so it's outside this policy.

(Older screenshots that nothing referenced — `storage/`, `studio/`, and the
`-numbers-390.png` / `-fullscreen-390.png` variants — were removed from git in
the `chore/prune-pass` cleanup. Git history still has them.)
