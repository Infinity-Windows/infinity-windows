#!/usr/bin/env node
// Fail the build when the app's ENTRY chunk grows past a budget — the one
// file every phone downloads before it can render anything, no matter which
// route it opens first.
//
// Route-level code splitting (App.tsx) took this file from ~2.8 MB
// (~860 kB gzip, three.js/Draco/pdf.js all riding along with the shell) down
// to a few hundred kB. BUDGET_GZIP_KB is set ~10% above that measured size —
// tight enough that a real regression (an eager import creeping back in,
// a heavy library imported at the top of App.tsx) fails CI, loose enough
// that normal week-to-week drift in the shell's own code does not.
//
// Deliberately checks ONLY the entry chunk, not the whole dist/ directory:
// per-route chunks are SUPPOSED to grow as features are added — that is the
// entire point of splitting them out. What must not silently regress is the
// one file that loads before a route has even been chosen.

import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** ~10% over the post-split measurement (233 kB gzip at the time this was
 * written) — see the file header for why the margin exists at all. */
export const BUDGET_GZIP_KB = 260;

/**
 * Pick the built entry chunk out of a `dist/assets` file listing. PURE.
 *
 * Vite names it `index-<hash>.js`; a source map or a CSS file of the same
 * stem must not be mistaken for it, so this matches the exact pattern Vite
 * emits rather than a loose "starts with index" check.
 */
export function findEntryChunk(files) {
  return files.find((f) => /^index-[\w-]+\.js$/.test(f)) ?? null;
}

/**
 * The pass/fail decision. PURE — takes bytes in, never touches disk, so it
 * is the part a test can drive without a real build.
 */
export function checkBudget(gzipBytes, budgetKb = BUDGET_GZIP_KB) {
  const gzipKb = gzipBytes / 1024;
  const ok = gzipKb <= budgetKb;
  const message = ok
    ? `entry chunk: ${gzipKb.toFixed(1)} kB gzip (budget ${budgetKb} kB) — ok`
    : `entry chunk grew to ${gzipKb.toFixed(1)} kB gzip, over the ${budgetKb} kB budget. ` +
      `If this is a real feature addition to the 6-AM shell, raise BUDGET_GZIP_KB in ` +
      `scripts/check-bundle-budget.mjs deliberately. If it's not, something an installer ` +
      `doesn't need on first open is being imported eagerly again — check for a static ` +
      `import in App.tsx (or something it reaches without React.lazy) that should be lazy.`;
  return { ok, gzipKb, message };
}

function main() {
  const assetsDir = join(root, "dist", "assets");
  let files;
  try {
    files = readdirSync(assetsDir);
  } catch {
    console.error(`No dist/assets directory at ${assetsDir} — run \`npm run build\` first.`);
    process.exit(1);
    return;
  }

  const entry = findEntryChunk(files);
  if (!entry) {
    console.error(`Couldn't find an entry chunk (index-*.js) under ${assetsDir}.`);
    process.exit(1);
    return;
  }

  const raw = readFileSync(join(assetsDir, entry));
  const gzip = gzipSync(raw, { level: 9 });
  const { ok, message } = checkBudget(gzip.length);

  console.log(`${entry}: raw ${(raw.length / 1024).toFixed(1)} kB, ${message}`);
  if (!ok) process.exit(1);
}

// Only run when invoked directly (`node scripts/check-bundle-budget.mjs`),
// not when a test imports the pure functions above. Comparing decoded paths
// rather than building a `file://` string by hand: this repo's own working
// copy lives under a directory with a space in it ("infinity windows"), and
// a hand-built URL leaves that space un-encoded while `import.meta.url`
// percent-encodes it — the two never match, so this run silently does
// nothing on this exact machine unless the path is decoded first.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
