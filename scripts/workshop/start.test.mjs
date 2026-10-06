// Run: node --test scripts/workshop/start.test.mjs   (Node 22.18+)
//
// Every key here is synthetic: a JWT built in this file with a fake
// signature, or an obviously made-up publishable key. None is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, envFileProblem, nodeProblem, parseEnvFile, planLaunch } from "./start.mjs";

const WORKSHOP_REF = "magcghmnbjiukidyalxd";
const PROD_REF = "czprjcskmzzagdztqonm";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ...claims })}.fake-signature`;

function settings(lines) {
  const dir = mkdtempSync(join(tmpdir(), "forge-workshop-"));
  const file = join(dir, ".env.workshop.local");
  writeFileSync(file, lines.join("\n"));
  return file;
}

const good = [
  `VITE_WORKSHOP_SUPABASE_REF=${WORKSHOP_REF}`,
  `VITE_SUPABASE_URL=https://${WORKSHOP_REF}.supabase.co`,
  `VITE_SUPABASE_ANON_KEY=${jwt({ ref: WORKSHOP_REF, role: "anon" })}`,
];

const PARENT = {
  PATH: "/usr/bin",
  VITE_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: jwt({ ref: PROD_REF, role: "anon" }),
  VITE_SENTRY_DSN: "https://example.invalid/1",
  SUPABASE_SERVICE_ROLE_KEY: "do-not-pass",
  SENTRY_AUTH_TOKEN: "do-not-pass",
};

test("an admitted workshop launches vite in workshop mode with only workshop values", async () => {
  const plan = await planLaunch({ envFile: settings(good), parentEnv: PARENT });
  assert.equal(plan.ok, true, plan.message);
  assert.deepEqual(plan.command.slice(2), ["--mode", "workshop"]);
  assert.equal(plan.env.VITE_SUPABASE_URL, `https://${WORKSHOP_REF}.supabase.co`);
  assert.equal(plan.env.VITE_EXPECTED_SUPABASE_PROJECT_REF, WORKSHOP_REF);
  assert.equal(plan.env.VITE_WORKSHOP_ORIGIN, "http://127.0.0.1:5278");
  assert.equal(plan.env.PATH, "/usr/bin");
  // Nothing inherited from the shell that could name production survives.
  assert.equal(plan.env.VITE_SENTRY_DSN, undefined);
  assert.equal(plan.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(plan.env.SENTRY_AUTH_TOKEN, undefined);
  assert.ok(!JSON.stringify(plan.env).includes(PROD_REF));
});

test("a missing settings file prints setup steps and starts nothing", async () => {
  const plan = await planLaunch({ envFile: join(tmpdir(), "no-such-dir", ".env.workshop.local") });
  assert.equal(plan.ok, false);
  assert.match(plan.message, /nothing was started and nothing was contacted/);
});

test("the app's normal settings files are refused outright", async () => {
  for (const name of [".env", ".env.local", ".env.production", ".env.development.local"]) {
    assert.ok(envFileProblem(`/x/app/${name}`), name);
  }
  assert.equal(envFileProblem("/x/app/.env.workshop.local"), null);
  const plan = await planLaunch({ envFile: "/x/app/.env" });
  assert.equal(plan.ok, false);
});

test("a production ref, URL or key is refused", async () => {
  for (const lines of [
    [`VITE_WORKSHOP_SUPABASE_REF=${PROD_REF}`, `VITE_SUPABASE_URL=https://${PROD_REF}.supabase.co`, `VITE_SUPABASE_ANON_KEY=${jwt({ ref: PROD_REF, role: "anon" })}`],
    [good[0], `VITE_SUPABASE_URL=https://${PROD_REF}.supabase.co`, good[2]],
    [good[0], good[1], `VITE_SUPABASE_ANON_KEY=${jwt({ ref: PROD_REF, role: "anon" })}`],
  ]) {
    const plan = await planLaunch({ envFile: settings(lines) });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /production/);
  }
});

test("missing values, service-role and secret keys are refused", async () => {
  const missing = await planLaunch({ envFile: settings([good[1], good[2]]) });
  assert.match(missing.message, /VITE_WORKSHOP_SUPABASE_REF is not set/);
  const service = await planLaunch({ envFile: settings([good[0], good[1], `VITE_SUPABASE_ANON_KEY=${jwt({ ref: WORKSHOP_REF, role: "service_role" })}`]) });
  assert.match(service.message, /service-role/);
  const secret = await planLaunch({ envFile: settings([good[0], good[1], "VITE_SUPABASE_ANON_KEY=sb_secret_notarealkey123"]) });
  assert.match(secret.message, /secret key/);
  // The refusal never repeats the key back.
  assert.ok(!secret.message.includes("notarealkey123"));
});

test("unknown keys in the settings file are refused, not passed through", () => {
  const { values, problems } = parseEnvFile(`# c\n\nVITE_SUPABASE_URL="https://x.supabase.co"\nVITE_SENTRY_DSN=x\n`);
  assert.equal(values.VITE_SUPABASE_URL, "https://x.supabase.co");
  assert.equal(values.VITE_SENTRY_DSN, undefined);
  assert.equal(problems.length, 1);
});

test("childEnv strips every inherited backend variable", () => {
  const env = childEnv(PARENT, { ref: "local", url: "http://127.0.0.1:54321", key: "k", origin: "http://127.0.0.1:5278" });
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL", "VITE_WORKSHOP_ORIGIN", "VITE_WORKSHOP_SUPABASE_REF"]);
});

test("Node older than 22.18 is refused before the shared rules are loaded", () => {
  assert.ok(nodeProblem("20.11.0"));
  assert.ok(nodeProblem("22.17.1"));
  assert.equal(nodeProblem("22.23.1"), null);
});
