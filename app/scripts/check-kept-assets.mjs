#!/usr/bin/env node
// Fail the build when a file that OLD phones still ask the network for is
// missing from `dist/`, has changed, or has been precached.
//
// WHY THIS EXISTS. Every build's entry used to import `monitoring-BsbA4Bc6.js`
// statically (React had been folded into the crash monitor's chunk — see the
// codeSplitting note in vite.config.ts), and the service worker deliberately
// never precached that chunk. So a phone running one of those builds loads its
// own index.html and entry from the worker's copy, and then asks the NETWORK
// for that one file. The first deploy whose bundle no longer contained it
// (#664, 2026-09-25) turned every such phone and laptop black: the app could
// not start, so it could not notice the new build and update itself either.
// Rolled back within the hour (#667).
//
// The way out is to keep serving the exact file until every phone has moved
// on. `public/assets/` carries the bytes into every build (Vite copies public/
// verbatim), vite.config.ts keeps it out of the precache (only old workers
// ask for it, and they fetch from the network), scripts/verify-pages.sh
// checks the live site still answers for it after every deploy, and this
// script checks the build output before that deploy happens.
//
// Each entry says what it imports. A kept file is loaded by an OLD entry, so
// the phone's OLD worker is what answers those imports, never this build —
// which is why every import has to be something that old worker precached.
// For monitoring-BsbA4Bc6.js that was proved by building master 18e59d4
// (2026-09-25): its only import, rolldown-runtime-aKtaBQYM.js, is in that
// build's precache manifest and is not a monitoring chunk. Record the same
// proof for anything added here.
//
// RETIRING ONE. After `keepUntil`, delete the file from public/assets/, its
// line in vite.config.ts's globIgnores, and its entry here. The date is when
// every phone that opened the app in the weeks before the fix will have
// updated (the app catches up within minutes of being opened); a phone that
// has not opened Forge at all since then goes black once, and recovers the
// next time it is fully closed and reopened with signal, because the waiting
// worker takes over then.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The files old phones still ask for. `file` is the path under both
 * `public/` and `dist/`; `sha256` is of the exact bytes an old entry expects
 * (a hashed filename promises specific content, so a changed file is as bad
 * as a missing one); `imports` is what the old worker must already hold.
 */
export const KEPT_ASSETS = [
  {
    file: "assets/monitoring-BsbA4Bc6.js",
    sha256: "7f3eb759a9c9f935dca8cf2ff3ae4e7ada98535e524dd3d3daf7ae309b27f536",
    keepUntil: "2026-11-01",
    imports: ["assets/rolldown-runtime-aKtaBQYM.js"],
    why: "every build before 2026-09-25 imported it from its entry (#664, #667)",
  },
];

/** SHA-256 of a buffer, as hex. PURE. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The decision. PURE — takes readers, never touches disk itself, so a test
 * can drive it with a fake dist.
 *
 * `readBuilt(file)` / `readSource(file)` return the bytes of a file under
 * dist/ or public/, or null when it is not there. `precache` is the source of
 * the built service worker (dist/sw.js), which carries the precache manifest
 * inline. `today` is an ISO date.
 *
 * Returns the problems that fail the build, and the reminders that do not: a
 * file past its keep-until date is a reminder, not a failure. A build that
 * turns red on a calendar date, with nothing changed, is a build somebody
 * fixes by deleting the check.
 */
export function auditKeptAssets({ kept = KEPT_ASSETS, readBuilt, readSource, precache, today }) {
  const problems = [];
  const reminders = [];
  for (const asset of kept) {
    const source = readSource(asset.file);
    if (source === null) {
      problems.push(
        `public/${asset.file} is gone. Old phones still ask for it (${asset.why}); ` +
          `it is not due to go until ${asset.keepUntil}.`,
      );
    } else if (sha256(source) !== asset.sha256) {
      problems.push(
        `public/${asset.file} is not the file old phones expect: its SHA-256 is not ` +
          `${asset.sha256}. A hashed filename promises specific bytes.`,
      );
    }
    const built = readBuilt(asset.file);
    if (built === null) {
      problems.push(
        `dist/${asset.file} is missing from the build. Old phones cannot start the app ` +
          `without it (${asset.why}). Vite copies public/ into dist/ — check public/${asset.file}.`,
      );
    } else if (sha256(built) !== asset.sha256) {
      problems.push(
        `dist/${asset.file} does not hold the bytes old phones expect (SHA-256 ${asset.sha256}). ` +
          `Something in the build overwrote the copy from public/.`,
      );
    }
    if (precache.includes(asset.file)) {
      problems.push(
        `The service worker precaches ${asset.file}. Only OLD workers ask for that file, from ` +
          `the network; a new one downloading it puts ${Math.round((built ?? source ?? "").length / 1024)} kB ` +
          `on every phone for nothing. Add it to globIgnores in vite.config.ts.`,
      );
    }
    if (today > asset.keepUntil) {
      reminders.push(
        `${asset.file} was due to go on ${asset.keepUntil}. If no phone can still be on a build ` +
          `that asks for it, delete public/${asset.file}, its globIgnores line in vite.config.ts ` +
          `and its entry in scripts/check-kept-assets.mjs.`,
      );
    }
  }
  return { problems, reminders };
}

function readOrNull(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function main() {
  const precache = readOrNull(join(root, "dist", "sw.js"));
  if (precache === null) {
    console.error("No dist/sw.js — run `npm run build` first; this reads the build output.");
    process.exit(1);
    return;
  }
  const { problems, reminders } = auditKeptAssets({
    readBuilt: (file) => readOrNull(join(root, "dist", file)),
    readSource: (file) => readOrNull(join(root, "public", file)),
    precache: precache.toString("utf8"),
    today: new Date().toISOString().slice(0, 10),
  });
  for (const line of reminders) {
    // A GitHub Actions annotation when run there, a plain line anywhere else.
    console.log(process.env.GITHUB_ACTIONS ? `::warning title=Kept asset due to go::${line}` : line);
  }
  if (problems.length) {
    for (const line of problems) console.error(line);
    process.exit(1);
    return;
  }
  console.log(
    `kept assets: ${KEPT_ASSETS.length} file(s) old phones still ask for are in dist/, ` +
      `unchanged and not precached`,
  );
}

// Only when invoked directly, never when a test imports the pure functions —
// the same decoded-path comparison scripts/check-bundle-budget.mjs explains.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
