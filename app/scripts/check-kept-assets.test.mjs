import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KEPT_ASSETS, auditKeptAssets, sha256 } from "./check-kept-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const kept = [
  {
    file: "assets/monitoring-OLDHASH.js",
    sha256: sha256("the exact bytes"),
    keepUntil: "2026-11-01",
    imports: ["assets/rolldown-runtime-R.js"],
    why: "old entries import it",
  },
];
const healthy = {
  kept,
  readBuilt: () => Buffer.from("the exact bytes"),
  readSource: () => Buffer.from("the exact bytes"),
  precache: 'precacheAndRoute([{url:"assets/index-A.js",revision:null}]);',
  today: "2026-10-01",
};

describe("auditKeptAssets", () => {
  it("passes a build that carries the exact file, unprecached, before its date", () => {
    expect(auditKeptAssets(healthy)).toEqual({ problems: [], reminders: [] });
  });

  it("fails when the file is missing from the build — the 2026-09-25 shape", () => {
    const { problems } = auditKeptAssets({ ...healthy, readBuilt: () => null });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("dist/assets/monitoring-OLDHASH.js is missing");
    expect(problems[0]).toContain("Old phones cannot start the app");
  });

  it("fails when the bytes are not the ones the old entry expects", () => {
    const { problems } = auditKeptAssets({
      ...healthy,
      readBuilt: () => Buffer.from("something else"),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not hold the bytes old phones expect");
  });

  it("fails when the source copy in public/ is gone or changed", () => {
    expect(auditKeptAssets({ ...healthy, readSource: () => null }).problems[0]).toContain(
      "public/assets/monitoring-OLDHASH.js is gone",
    );
    expect(
      auditKeptAssets({ ...healthy, readSource: () => Buffer.from("edited") }).problems[0],
    ).toContain("not the file old phones expect");
  });

  it("fails when the service worker precaches it: only old workers ask for it", () => {
    const { problems } = auditKeptAssets({
      ...healthy,
      precache: '[{url:"assets/monitoring-OLDHASH.js",revision:null}]',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("precaches assets/monitoring-OLDHASH.js");
    expect(problems[0]).toContain("globIgnores");
  });

  it("reminds, and still passes, once the keep-until date has gone by", () => {
    const { problems, reminders } = auditKeptAssets({ ...healthy, today: "2026-11-02" });
    expect(problems).toEqual([]);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("was due to go on 2026-11-01");
  });
});

describe("the kept files themselves", () => {
  it.each(KEPT_ASSETS)("public/$file holds the bytes the old entry expects", (asset) => {
    const bytes = readFileSync(join(here, "..", "public", asset.file));
    expect(sha256(bytes)).toBe(asset.sha256);
  });

  it.each(KEPT_ASSETS)("$file imports only what an old worker precached", (asset) => {
    // The kept file is loaded by an OLD entry from an OLD worker's copy of
    // the app, so its imports are answered by that worker's precache, not by
    // this build. Everything it imports has to be listed — and nothing it
    // imports may be another monitoring chunk, which no worker ever held.
    const code = readFileSync(join(here, "..", "public", asset.file), "utf8");
    const imports = [...code.matchAll(/from\s*["']\.\/([\w.-]+\.js)["']|import\s*["']\.\/([\w.-]+\.js)["']/g)]
      .map((m) => `assets/${m[1] ?? m[2]}`)
      .sort();
    expect(imports).toEqual([...asset.imports].sort());
    expect(imports.some((f) => f.includes("monitoring-"))).toBe(false);
  });

  it.each(KEPT_ASSETS)("$file is kept out of the precache in vite.config.ts", (asset) => {
    const config = readFileSync(join(here, "..", "vite.config.ts"), "utf8");
    expect(config).toContain(`'${asset.file}',`);
  });
});
