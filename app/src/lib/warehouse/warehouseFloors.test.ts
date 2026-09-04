// Who may do what in the warehouse, read off the migrations themselves.
//
// ADR-0007 (owner call, 2026-09-04) drops the foreman+ rank check from the
// everyday warehouse RPCs and deliberately leaves it on the ones that END
// something. The UI now shows or hides buttons on exactly that split, and a
// button and a server that disagree is the failure this file exists to catch
// — in both directions: a live button in front of a closed door reads as a
// broken app, and a hidden button in front of an open one is a rule nobody
// wrote down.
//
// A source test is the honest check, for the same reason movementEvents.test.ts
// is one: no runner here can reach production, but the migration files ARE
// the schema's history, and the LAST definition of a function is what is
// live. Same replay, same rule.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../supabase/migrations",
);

/** The body of the LAST migration that defines `fn` — i.e. what is live. */
function currentBody(fn: string): string {
  const opener = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:public\\.)?${fn}\\s*\\(`,
    "i",
  );
  let latest: string | null = null;
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(migrationsDir, file), "utf8");
    const at = sql.search(opener);
    if (at === -1) continue;
    const end = sql.indexOf("$$;", at);
    latest = sql.slice(at, end === -1 ? undefined : end);
  }
  if (latest === null) throw new Error(`no migration defines ${fn}`);
  return latest;
}

/** Every shape a rank check is written in across this tree. */
const RANK_CHECKS = [
  "is_foreman_plus",
  "_is_lead",
  "v_role = 'installer'",
  "v_role in ('installer'",
  "my_role_rank()",
];

/** Opened by ADR-0007 — the eighteen everyday warehouse actions. */
const OPENED = [
  "mint_packages",
  "mint_mark_packages",
  "add_project_mark",
  "set_mark_part_total",
  "save_storage_container",
  "set_package_area",
  "set_package_window",
  "assign_package_to_job",
  "add_supply",
  "set_supply_home",
  "create_takeoff",
  "acknowledge_takeoff",
  "ready_takeoff",
  "create_manual_delivery",
  "file_pending_packages",
  "add_delivery_set",
  "update_delivery",
  "rewrite_set",
];

/** Kept foreman+ by ADR-0007 — the actions that end something. */
const STILL_FOREMAN = ["burn_packages", "delete_packages", "delete_delivery"];

/** Kept supervisor+ by ADR-0007 — scheduling and settings, not warehouse work. */
const STILL_SUPERVISOR = ["schedule_delivery", "save_checkout_reason"];

describe("the warehouse's open doors (ADR-0007)", () => {
  it.each(OPENED)("%s asks nothing about rank", (fn) => {
    const body = currentBody(fn);
    for (const check of RANK_CHECKS) {
      expect(body, `${fn} still gates on ${check}`).not.toContain(check);
    }
  });

  it.each(OPENED)("%s still wants you signed in", (fn) => {
    expect(currentBody(fn)).toContain("auth.uid() is null");
  });

  it.each(OPENED)("%s still refuses a builder login", (fn) => {
    // The wall used to be a side effect of the rank check: a partner's role
    // reads 'installer', so foreman+ shut them out by accident. Opening the
    // rank without this line would have opened the warehouse to builders.
    expect(currentBody(fn), `${fn} lost the partner wall`).toContain(
      "public.is_partner_user()",
    );
  });
});

describe("the warehouse's doors that stayed shut (ADR-0007)", () => {
  it.each(STILL_FOREMAN)("%s is still foreman and up", (fn) => {
    expect(currentBody(fn)).toContain("is_foreman_plus(auth.uid())");
  });

  it.each(STILL_SUPERVISOR)("%s is still supervisor and up", (fn) => {
    // Both spell it the same way: the role is read, and installer OR foreman
    // is refused. Pinning the shape, not just the words, so a rewrite that
    // quietly drops one of the two names fails here.
    const body = currentBody(fn);
    expect(body).toContain("v_role in ('installer', 'foreman')");
  });
});
