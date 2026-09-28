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
//
// Also reports (and separately gates) the recursive STATIC-import closure
// reachable from the built HTML's script and modulepreload roots. This is the
// core startup JS graph, not a complete network trace: app effects can start
// dynamic downloads immediately after mount. Shrinking the entry
// chunk by making some dependency's OWN import dynamic (Scanner.tsx's
// html5-qrcode, outline.ts's pdf.js OPS) can leave a file still reachable
// through this closure if something else the entry reaches still imports it
// statically — the entry-byte number alone would not catch that. Closure
// bytes have their own ceiling; route-level dynamic chunks may keep growing
// without changing that cost. We also gate that every file in the
// closure is in the service worker's precache manifest, the same shape of
// problem #664/#667 caused (see check-kept-assets.mjs) — a static
// first-screen dependency the worker never cached is a phone with no signal
// that cannot render anything at all.

import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** ~10% over the post-split measurement (233 kB gzip at the time this was
 * written) — see the file header for why the margin exists at all. */
export const BUDGET_GZIP_KB = 260;
/** 755.5 KiB measured after this split, with about 11% room for shell growth. */
export const FIRST_SCREEN_GZIP_KB = 840;

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

/**
 * Basenames of chunks a built file statically imports — `import ... from
 * "./chunk-hash.js"` or a bare `import "./chunk-hash.js"` — in Vite/rolldown
 * output. PURE (source text in, basenames out). Deliberately does NOT match
 * a dynamic `import("./chunk.js")` call: that syntax is exactly a
 * React.lazy()/lazyOptional() split, code that is SUPPOSED to wait for its
 * route or tab rather than load with everything else. Same pattern already
 * proven against this build's real output in check-kept-assets.test.mjs.
 */
export function staticImportsOf(source) {
  const names = new Set();
  const re = /from\s*["']\.\/([\w.-]+\.js)["']|import\s*["']\.\/([\w.-]+\.js)["']/g;
  let m;
  while ((m = re.exec(source))) names.add(m[1] ?? m[2]);
  return [...names];
}

/**
 * Walk the static-import graph from one or more built HTML roots. A missing
 * built chunk throws: no apparent saving can be claimed from a broken graph.
 */
export function staticImportClosure(entryFiles, readChunk) {
  const roots = Array.isArray(entryFiles) ? entryFiles : [entryFiles];
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    const source = readChunk(file);
    if (source === null) throw new Error(`Built first-screen chunk is missing: ${file}`);
    for (const dep of staticImportsOf(source)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen];
}

/** All eager script and modulepreload roots emitted in the built HTML. */
export function htmlScriptRoots(html) {
  const roots = new Set();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    if (!/\btype=["']module["']|\brel=["']modulepreload["']/.test(tag)) continue;
    for (const match of tag.matchAll(/(?:\/|\.?\/?)assets\/([\w.-]+\.js)/g)) roots.add(match[1]);
  }
  return [...roots];
}

/**
 * Which closure files the built service worker's precache manifest (the
 * text of dist/sw.js) never mentions. PURE. The same substring check
 * check-kept-assets.mjs already uses against the same file: Workbox's
 * generated manifest lists each entry as `"url":"assets/<file>"`, so a plain
 * substring match finds it without parsing the manifest's exact JSON shape,
 * which stays readable if that shape drifts slightly between versions.
 */
export function missingFromPrecache(closureFiles, precacheText) {
  return closureFiles.filter((file) => !precacheText.includes(`assets/${file}`));
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

  let failed = !ok;

  let closure;
  try {
    const html = readFileSync(join(root, "dist", "index.html"), "utf8");
    const htmlRoots = htmlScriptRoots(html);
    if (!htmlRoots.includes(entry)) throw new Error(`Built HTML does not reference the entry chunk: ${entry}`);
    closure = staticImportClosure(htmlRoots, (file) => {
      try { return readFileSync(join(assetsDir, file), "utf8"); }
      catch { return null; }
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
    return;
  }
  let closureGzipBytes = 0;
  for (const file of closure) {
    closureGzipBytes += gzipSync(readFileSync(join(assetsDir, file)), { level: 9 }).length;
  }
  const closureKb = closureGzipBytes / 1024;
  console.log(
    `first-screen JS: ${closure.length} chunk(s), ${closureKb.toFixed(1)} kB gzip ` +
      `(budget ${FIRST_SCREEN_GZIP_KB} kB)`,
  );
  if (closureKb > FIRST_SCREEN_GZIP_KB) {
    console.error(`First-screen JS exceeds ${FIRST_SCREEN_GZIP_KB} kB. Check eager imports or deliberately revise this measured budget.`);
    failed = true;
  }

  let precacheText;
  try {
    precacheText = readFileSync(join(root, "dist", "sw.js"), "utf8");
  } catch {
    console.error(`No dist/sw.js under ${join(root, "dist")} — run \`npm run build\` first.`);
    process.exit(1);
    return;
  }
  const missing = missingFromPrecache(closure, precacheText);
  if (missing.length > 0) {
    console.error(
      `${missing.length} first-screen chunk(s) are statically imported but not in the service ` +
        `worker's precache: ${missing.join(", ")}. A phone with no signal can't render its first ` +
        `screen without these — check they weren't added to globIgnores in vite.config.ts (that's ` +
        `for OLD kept assets only, see check-kept-assets.mjs), or that whatever imports them was ` +
        `meant to stay static rather than become React.lazy()/lazyOptional().`,
    );
    failed = true;
  } else {
    console.log(`first-screen closure: zero chunks missing from the SW precache`);
  }

  if (failed) process.exit(1);
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
