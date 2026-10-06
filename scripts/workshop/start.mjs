#!/usr/bin/env node
// Launch Forge Workshop: the app on its own origin, against its own backend.
//
//   node scripts/workshop/start.mjs            check settings, then serve on :5278
//   node scripts/workshop/start.mjs --check    check settings only, start nothing
//   node scripts/workshop/start.mjs --env-file <path>
//
// Settings come from ONE file, app/.env.workshop.local by default (see
// app/.env.workshop.example), and from nowhere else. That is the point of this
// launcher: the shell this runs in may well have the production
// VITE_SUPABASE_URL exported, and app/.env holds the production key, so the
// child dev server gets an environment with every inherited VITE_/SUPABASE_/
// SENTRY_ variable REMOVED and only the checked workshop values put back.
// vite.config.ts turns .env loading off in workshop mode and checks again, so
// running `vite --mode workshop` by hand fails closed too.
//
// Nothing here touches the network. Until the settings pass, nothing is
// started and nothing is contacted; it prints what to fix and exits.
//
// The rules themselves live in app/src/lib/workshopIsolation.ts, loaded
// directly by Node 22's type stripping, so the launcher, the dev server and the
// browser can never disagree about what counts as production.
// Run the tests: node --test scripts/workshop/start.test.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");
export const APP = join(REPO, "app");
export const DEFAULT_ENV_FILE = join(APP, ".env.workshop.local");

/** The only keys a workshop settings file may hold. Anything else is refused, not ignored. */
export const ALLOWED_KEYS = [
  "VITE_WORKSHOP_SUPABASE_REF",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_WORKSHOP_ORIGIN",
];

/** Inherited variables that could steer the app or a tool at a backend. Never passed on. */
const INHERITED_PREFIXES = ["VITE_", "SUPABASE_", "SENTRY_"];

/** Node 22.18 is where type stripping is on by default — needed to load the shared rules. */
export function nodeProblem(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) return null;
  return `Node ${version} is too old. The workshop needs Node 22.18 or newer (run \`nvm use 22\`).`;
}

/**
 * Refuse a settings file that is one of the app's normal ones. Those are
 * loaded by every Vite mode and hold production values.
 */
export function envFileProblem(path) {
  const name = basename(path);
  if (/^\.env(\.local)?$/.test(name) || /^\.env\.(production|development|test)(\.local)?$/.test(name)) {
    return `${name} is one of the app's normal settings files (it holds production values). Use app/.env.workshop.local.`;
  }
  return null;
}

/** Parse KEY=VALUE lines. Comments and blanks are skipped; surrounding quotes are dropped. */
export function parseEnvFile(text) {
  const values = {};
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      problems.push(`Line ${i + 1} is not KEY=VALUE.`);
      return;
    }
    const [, k, v] = m;
    if (!ALLOWED_KEYS.includes(k)) {
      problems.push(`Line ${i + 1}: ${k} is not a workshop setting (allowed: ${ALLOWED_KEYS.join(", ")}).`);
      return;
    }
    values[k] = v.replace(/^(['"])(.*)\1$/, "$2");
  });
  return { values, problems };
}

/**
 * The child's environment: this process's, minus everything that could name a
 * backend, plus the admitted workshop values. The expected-project override is
 * set to the workshop's own ref so the app's "Wrong database" banner agrees.
 */
export function childEnv(parentEnv, config) {
  const env = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (!INHERITED_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  env.VITE_WORKSHOP_SUPABASE_REF = config.ref;
  env.VITE_SUPABASE_URL = config.url;
  env.VITE_SUPABASE_ANON_KEY = config.key;
  env.VITE_WORKSHOP_ORIGIN = config.origin;
  if (config.ref !== "local") env.VITE_EXPECTED_SUPABASE_PROJECT_REF = config.ref;
  return env;
}

const SETUP = [
  "Forge Workshop is not set up yet, so nothing was started and nothing was contacted.",
  "  1. cp app/.env.workshop.example app/.env.workshop.local",
  "  2. Fill in the WORKSHOP project's ref, URL and public browser key (never production's).",
  "  3. node scripts/workshop/start.mjs --check, then without --check to serve.",
].join("\n");

/**
 * Decide what to do, without doing it. Returns either the refusal to print or
 * the command to run. Pure apart from reading the settings file.
 */
export async function planLaunch({ envFile = DEFAULT_ENV_FILE, parentEnv = process.env, nodeVersion } = {}) {
  const tooOld = nodeProblem(nodeVersion);
  if (tooOld) return { ok: false, message: tooOld };
  const badFile = envFileProblem(envFile);
  if (badFile) return { ok: false, message: badFile };
  if (!existsSync(envFile)) return { ok: false, message: SETUP };

  const { admitWorkshopConfig, describeRefusal } = await import(
    pathToFileURL(join(APP, "src/lib/workshopIsolation.ts")).href
  );
  const parsed = parseEnvFile(readFileSync(envFile, "utf8"));
  const admission = admitWorkshopConfig(parsed.values);
  const problems = [...parsed.problems, ...(admission.ok ? [] : admission.problems)];
  if (problems.length) return { ok: false, message: describeRefusal(problems) };

  const { config } = admission;
  return {
    ok: true,
    config,
    command: [process.execPath, join(APP, "node_modules/vite/bin/vite.js"), "--mode", "workshop"],
    env: childEnv(parentEnv, config),
    summary: `Forge Workshop: ${config.origin}  →  backend ${config.ref} (${config.keyKind} key)`,
  };
}

async function main(argv) {
  const at = argv.indexOf("--env-file");
  if (at >= 0 && (!argv[at + 1] || argv[at + 1].startsWith("--"))) {
    console.error("--env-file needs a workshop settings file path.");
    return 2;
  }
  const envFile = at >= 0 ? resolve(argv[at + 1] ?? "") : DEFAULT_ENV_FILE;
  const plan = await planLaunch({ envFile });
  if (!plan.ok) {
    console.error(plan.message);
    return 1;
  }
  console.log(plan.summary);
  if (argv.includes("--check")) {
    console.log("Settings admitted. Nothing was started (--check).");
    return 0;
  }
  if (!existsSync(plan.command[1])) {
    console.error("The app's dependencies are not installed (app/node_modules/vite is missing). Install them in app/ first; this launcher does not.");
    return 2;
  }
  const child = spawn(plan.command[0], plan.command.slice(1), { cwd: APP, env: plan.env, stdio: "inherit" });
  return await new Promise((done) => child.on("exit", (code) => done(code ?? 1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
