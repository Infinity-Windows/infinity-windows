// The server behind the `*.pwa.ts` specs (playwright.pwa.config.ts starts it).
//
// It builds TWO production bundles — the one phones are running today, from
// a git ref, and this working tree — and serves whichever a spec asks for,
// from one origin, the way GitHub Pages does. The offline spec only needs the
// new build. The upgrade spec needs both, because the thing that went wrong
// on 2026-09-25 did not exist in either build alone: the old build's entry
// asked the network for one file its worker had never saved, and the new
// deploy no longer had that file. A fresh browser profile on the new build
// was fine, and so was every dev-server spec, while every phone with the old
// worker went black.
//
// Like GitHub Pages, it answers every file with `Cache-Control: max-age=600`,
// serves a missing path as index.html with status 404 (Pages serves 404.html,
// a byte-copy of index.html — see spaFallbackPlugin in vite.config.ts), and
// ignores query strings.
//
// Usage (from app/):
//   node --experimental-strip-types e2e/support/pwaHarness.ts
//
// Env:
//   IW_MAP_PORT       port to listen on (default 5186)
//   IW_PWA_OLD_REF    git ref of the "old" build (default origin/master —
//                     what the crew is running when a pull request opens)
//   IW_PWA_REUSE=1    keep both builds from the last run instead of rebuilding
//   IW_PWA_DROP       comma-separated paths to DELETE from the new build after
//                     building it — how to watch upgrade-path.pwa.ts fail the
//                     way 2026-09-25 did:
//                       IW_PWA_DROP=assets/monitoring-BsbA4Bc6.js
//
// Control, for the test runner (never the page — a request from the page
// would go through the service worker):
//   POST /__pwa-harness/serve/old            serve the old build
//   POST /__pwa-harness/serve/new            serve the new build
//        ?missing=assets/a.js,assets/b.js    ...but answer 404 for these, the
//                                            way a deploy in progress does
//   GET  /__pwa-harness/state                which build is served, and both
//                                            builds' entry file and build id
//
// Both builds use the same fixture project as playwright.config.ts — a host
// that does not resolve and a placeholder key — so nothing here can reach the
// real database. They land in node_modules/.cache, never in dist/, so they
// cannot be mistaken for a build somebody is about to deploy or measure.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = resolve(app, "..");
const cache = join(app, "node_modules", ".cache", "pwa-e2e");
const PORT = Number(process.env.IW_MAP_PORT ?? 5186);
const OLD_REF = process.env.IW_PWA_OLD_REF ?? "origin/master";
const REUSE = process.env.IW_PWA_REUSE === "1";
const DROP = (process.env.IW_PWA_DROP ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const fixtureEnv = {
  VITE_BASE: "/",
  VITE_SUPABASE_URL: "https://e2efixture.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_e2e_fixture_not_a_secret",
};

type BuildName = "old" | "new";

interface Build {
  name: BuildName;
  dir: string;
  /** The hashed entry chunk index.html loads, e.g. `assets/index-Ab12Cd34.js`. */
  entry: string;
  /** What version.json says, and what the bundle believes it is. */
  buildId: string;
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function log(line: string): void {
  process.stderr.write(`[pwa-harness] ${line}\n`);
}

function runVite(cwd: string, outDir: string, buildId: string): void {
  try {
    execFileSync(join(app, "node_modules", ".bin", "vite"), ["build", "--outDir", outDir, "--emptyOutDir"], {
      cwd,
      env: { ...process.env, ...fixtureEnv, VITE_BUILD_ID: buildId },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    log(`the ${buildId} build failed:\n${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`);
    throw err;
  }
}

function describeBuild(name: BuildName, dir: string): Build {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const entry = /<script type="module" crossorigin src="\/(assets\/index-[\w-]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error(`${dir}/index.html has no module entry script`);
  const version = JSON.parse(readFileSync(join(dir, "version.json"), "utf8")) as { buildId: string };
  return { name, dir, entry, buildId: version.buildId };
}

/**
 * The build phones are running today: `OLD_REF`'s app/ directory, built with
 * THIS tree's node_modules (a symlink — the lockfile is the same, or close
 * enough that an old tree builds; if it ever is not, this says so).
 */
function buildOld(): Build {
  const src = join(cache, "old-src");
  const dir = join(cache, "old-dist");
  if (REUSE && existsSync(join(dir, "index.html"))) {
    log(`reusing the old build in ${dir}`);
    return describeBuild("old", dir);
  }
  let sha: string;
  try {
    sha = git("rev-parse", "--short=7", OLD_REF);
  } catch {
    throw new Error(
      `cannot resolve IW_PWA_OLD_REF=${OLD_REF}. In a shallow clone, fetch it first: git fetch --depth=1 origin master`,
    );
  }
  log(`building the old app from ${OLD_REF} (${sha})…`);
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  // The whole tree (26 MB), not app/ alone: the app imports from
  // supabase/functions/_shared and scripts/fixtures, and what else it may
  // reach for tomorrow is not this file's business.
  const tar = join(cache, "old.tar");
  git("archive", "--format=tar", "-o", tar, OLD_REF);
  execFileSync("tar", ["-xf", tar, "-C", src]);
  symlinkSync(join(app, "node_modules"), join(src, "app", "node_modules"), "dir");
  runVite(join(src, "app"), dir, `old-${sha}`);
  return describeBuild("old", dir);
}

/** This working tree, built as a deploy would build it. */
function buildNew(): Build {
  const dir = join(cache, "new-dist");
  if (REUSE && existsSync(join(dir, "index.html"))) {
    log(`reusing the new build in ${dir}`);
    return describeBuild("new", dir);
  }
  let sha = "unknown";
  try {
    sha = git("rev-parse", "--short=7", "HEAD") + (git("status", "--porcelain") === "" ? "" : "-dirty");
  } catch {
    // Not in a git checkout: the id only has to differ from the old build's.
  }
  log(`building this tree (${sha})…`);
  runVite(app, dir, `new-${sha}`);
  for (const path of DROP) {
    rmSync(join(dir, path), { force: true });
    log(`DROPPED ${path} from the new build on purpose (IW_PWA_DROP)`);
  }
  return describeBuild("new", dir);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function main(): void {
  mkdirSync(cache, { recursive: true });
  const builds: Record<BuildName, Build> = { old: buildOld(), new: buildNew() };
  for (const b of [builds.old, builds.new]) log(`${b.name}: ${b.entry} (build ${b.buildId})`);

  let serving: BuildName = "new";
  let missing = new Set<string>();

  const send = (res: ServerResponse, status: number, type: string, body: Buffer | string) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "max-age=600",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  };

  const control = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (!url.pathname.startsWith("/__pwa-harness/")) return false;
    if (url.pathname === "/__pwa-harness/state") {
      send(res, 200, TYPES[".json"], JSON.stringify({ serving, missing: [...missing], builds }));
      return true;
    }
    const m = /^\/__pwa-harness\/serve\/(old|new)$/.exec(url.pathname);
    if (m && req.method === "POST") {
      serving = m[1] as BuildName;
      missing = new Set(
        (url.searchParams.get("missing") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      log(`now serving the ${serving} build${missing.size ? `, without ${[...missing].join(", ")}` : ""}`);
      send(res, 200, TYPES[".json"], JSON.stringify({ serving, missing: [...missing] }));
      return true;
    }
    send(res, 404, TYPES[".txt"], "no such harness endpoint");
    return true;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (control(req, res, url)) return;

    const build = builds[serving];
    // Query strings never change which file is meant (Pages ignores them too).
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const relative = path.replace(/^\/+/, "");
    const file = normalize(join(build.dir, relative));
    const notFound = () => send(res, 404, TYPES[".html"], readFileSync(join(build.dir, "index.html")));
    if (!file.startsWith(build.dir) || missing.has(relative)) return notFound();
    let exists = false;
    try {
      exists = statSync(file).isFile();
    } catch {
      exists = false;
    }
    if (!exists) return notFound();
    send(res, 200, TYPES[extname(file)] ?? "application/octet-stream", readFileSync(file));
  });

  server.listen(PORT, () => log(`serving the ${serving} build on http://localhost:${PORT}/`));
}

main();
