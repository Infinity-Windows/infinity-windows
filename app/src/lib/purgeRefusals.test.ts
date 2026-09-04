import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALREADY_REMOVED,
  PURGE_CANNOT_RECORD,
  PURGE_TEST_LOGIN_REFUSED,
  purgeRowRefusal,
} from "../../../supabase/functions/_shared/purgeLogin";

/**
 * THE REFUSALS ON A ONE-WAY DOOR.
 *
 * "Remove this login" cannot be undone: one shape deletes the account, the
 * other bans it and hands its email address to a tombstone. So the things that
 * stop it are worth more than the thing that does it, and the ones that depend
 * only on the target row are pure and tested here rather than buried in an
 * endpoint nothing can run locally.
 *
 * The preview and the real removal run this same ladder, which is the point:
 * the confirm sheet must be able to say "this will not work" before the owner
 * reads a sentence promising that it will.
 */

const OK = {
  isPartner: false,
  isTest: false,
  alreadyRetired: false,
  canRecordRetirement: true,
};

describe("purgeRowRefusal", () => {
  it("lets an ordinary crew login through", () => {
    expect(purgeRowRefusal(OK)).toBeNull();
  });

  it("refuses a builder's login — it belongs to the job grants", () => {
    const refusal = purgeRowRefusal({ ...OK, isPartner: true });
    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toContain("builder's login");
  });

  it("refuses the automation login the tests sign in with", () => {
    // Either shape ends it for good — the delete removes the account, the
    // retire hands its address to a tombstone — so the password in
    // ~/.config/infinity-windows/test-installer.env would stop working and
    // every end-to-end check that signs in with it would stay red.
    const refusal = purgeRowRefusal({ ...OK, isTest: true });
    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toBe(PURGE_TEST_LOGIN_REFUSED);
  });

  it("refuses a login that was already removed", () => {
    expect(purgeRowRefusal({ ...OK, alreadyRetired: true })?.error).toBe(
      ALREADY_REMOVED,
    );
  });

  it("refuses when the database cannot record the removal", () => {
    // The half-state this exists to prevent: the account gets banned, its email
    // gets handed back, and then the write that says "removed for good" has no
    // column to land in. What is left reads as an ordinary switched-off login
    // under a working "Let them back in" button, which un-bans an account whose
    // only address is now a tombstone nobody can type.
    const refusal = purgeRowRefusal({ ...OK, canRecordRetirement: false });
    expect(refusal?.status).toBe(409);
    expect(refusal?.error).toBe(PURGE_CANNOT_RECORD);
  });

  it("tells the owner what to do instead, in words, not a code", () => {
    for (const bad of [
      { ...OK, isPartner: true },
      { ...OK, isTest: true },
      { ...OK, alreadyRetired: true },
      { ...OK, canRecordRetirement: false },
    ]) {
      const error = purgeRowRefusal(bad)?.error ?? "";
      expect(error.length).toBeGreaterThan(30);
      expect(error).not.toMatch(/PGRST|null|undefined|\[object/);
    }
  });
});

/**
 * The two doors that could bring a removed login back, and the fact they read.
 *
 * `retired_at` is the flag, but the ADDRESS is the fact. A stamp can fail after
 * the ban and the rename have already happened, and on a database that is
 * behind the app there is no column to stamp at all — so both doors also ask
 * whether the account's email is already a tombstone. A source scan, because
 * these live in an edge function that no test here can execute; asserting the
 * check is present is worth more than asserting nothing.
 */
describe("nothing revives a login whose address was handed back", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SOURCE = readFileSync(
    join(HERE, "../../../supabase/functions/manage-crew-access/index.ts"),
    "utf8",
  );

  function action(name: string): string {
    const from = SOURCE.indexOf(`case "${name}": {`);
    expect(from, `${name} is not in manage-crew-access`).toBeGreaterThan(0);
    const next = SOURCE.indexOf('      case "', from + 10);
    const end = next === -1 ? SOURCE.indexOf("      default:", from) : next;
    return SOURCE.slice(from, end);
  }

  it('"Let them back in" checks the address, not only the flag', () => {
    const body = action("restore_access");
    expect(body).toContain("target.retired_at");
    expect(body).toContain("hasTombstoneEmail");
  });

  it('"New password code" checks the address too', () => {
    const body = action("reissue_login");
    expect(body).toContain("targetRow.retired_at");
    expect(body).toContain("isTombstoneEmail");
  });

  it("removal refuses on the row before it bans or renames anything", () => {
    const body = action("purge_login");
    const refusedAt = body.indexOf("purgeRefusal");
    const bannedAt = body.indexOf("auth.admin");
    expect(refusedAt).toBeGreaterThan(0);
    expect(bannedAt).toBeGreaterThan(0);
    expect(refusedAt).toBeLessThan(bannedAt);
  });

  it("no longer swallows a failed retirement stamp", () => {
    // The fallback that wrote access_revoked_at and returned ok is what made
    // the half-state, and it is gone. If it comes back, so does the bug.
    expect(SOURCE).not.toContain("PGRST204");
  });
});
