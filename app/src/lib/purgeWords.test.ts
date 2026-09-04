import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasWorkHistory,
  isTombstoneEmail,
  shapeFor,
  tombstoneEmail,
  UNKNOWN_RECORDS,
} from "../../../supabase/functions/_shared/purgeLogin";
import {
  historyHighlights,
  probeKey,
  removalResultSentence,
  removalSentence,
  WORK_HISTORY_PROBES,
} from "./purgeWords";

/**
 * The decision that decides whether a person's record survives.
 *
 * Everything here is the pure half of "Remove this login": the server takes one
 * count per table and hands it to these functions, and the same functions write
 * the sentence the owner reads before he presses the button. If the sentence
 * and the action could ever disagree, the confirm sheet would be a lie — so
 * they are one piece of code and this is where it is pinned.
 */

const NOTHING = Object.fromEntries(
  WORK_HISTORY_PROBES.map((p) => [probeKey(p), 0]),
);

describe("hasWorkHistory", () => {
  it("is false when every count is zero", () => {
    expect(hasWorkHistory(NOTHING)).toBe(false);
    expect(hasWorkHistory({})).toBe(false);
  });

  it("is true on a single row anywhere", () => {
    for (const probe of WORK_HISTORY_PROBES) {
      expect(hasWorkHistory({ ...NOTHING, [probeKey(probe)]: 1 })).toBe(true);
    }
  });

  it("counts a table it has never heard of as history", () => {
    // A count the server took for something added after this file was written
    // still means "there is something here", and the safe answer to a surprise
    // is keep it — so the check reads the whole object, not only the probes it
    // knows the names of.
    expect(hasWorkHistory({ "some_table_added_later.author": 1 })).toBe(true);
    expect(hasWorkHistory({ "some_table_added_later.author": 0 })).toBe(false);
  });
});

describe("shapeFor", () => {
  it("hard-deletes a login with nothing behind it", () => {
    expect(shapeFor(NOTHING)).toBe("deleted");
  });

  it("retires a login the moment anything is on file", () => {
    expect(shapeFor({ ...NOTHING, "time_shifts.profile_id": 1 })).toBe("retired");
  });

  it("retires on a RESTRICT table on its own — the delete would fail anyway", () => {
    // unit_sessions.profile_id has no ON DELETE clause, so a hard delete errors
    // rather than cascading. Counting it is what keeps that from ever happening.
    expect(shapeFor({ "unit_sessions.profile_id": 2 })).toBe("retired");
    expect(shapeFor({ "daily_logs.filed_by": 1 })).toBe("retired");
  });
});

describe("the sentence the owner reads", () => {
  it("says deleted, and says the email comes free", () => {
    expect(removalSentence("Eduardo", NOTHING)).toBe(
      "Nothing on file for Eduardo — the account will be deleted and the email freed.",
    );
  });

  it("names what is on file and promises to keep it", () => {
    const counts = {
      ...NOTHING,
      "time_shifts.profile_id": 14,
      "receipts.uploaded_by": 3,
    };
    expect(removalSentence("Enrique", counts)).toBe(
      "Enrique has 14 punches and 3 receipts on file — the login will be closed, " +
        "the email freed, and every record kept under their name.",
    );
  });

  it("uses the singular for one row", () => {
    expect(removalSentence("Mia", { "receipts.uploaded_by": 1 })).toContain(
      "1 receipt on file",
    );
  });

  it("names three things at most and says there is more", () => {
    const counts = {
      "time_shifts.profile_id": 9,
      "unit_sessions.profile_id": 8,
      "install_events.installer_id": 7,
      "receipts.uploaded_by": 6,
      "certifications.profile_id": 5,
    };
    const sentence = removalSentence("Dave", counts);
    expect(sentence).toContain("9 punches, 8 work sessions and 7 installs");
    expect(sentence).toContain(", and more, on file");
    expect(sentence).not.toContain("receipt");
  });

  it("falls back to a person rather than a blank when the name is missing", () => {
    expect(removalSentence(null, NOTHING)).toContain("This person");
    expect(removalSentence("   ", { "receipts.uploaded_by": 1 })).toContain(
      "This person has",
    );
  });

  it("orders the highlights the way the probe list does", () => {
    const highlights = historyHighlights({
      "project_messages.author_id": 4,
      "time_shifts.profile_id": 2,
    });
    expect(highlights.map((h) => h.key)).toEqual([
      "time_shifts.profile_id",
      "project_messages.author_id",
    ]);
  });
});

describe("the result line", () => {
  it("says the account is gone", () => {
    expect(removalResultSentence("Eduardo", "deleted")).toContain("is gone");
  });

  it("says the record is kept", () => {
    expect(removalResultSentence("Enrique", "retired")).toContain(
      "every record is still filed under their name",
    );
  });
});

describe("the tombstone address", () => {
  const uid = "11111111-2222-4333-8444-555555555555";

  it("is the uid on the reserved .invalid TLD, so it can never be a mailbox", () => {
    expect(tombstoneEmail(uid)).toBe(`${uid}@removed.invalid`);
  });

  it("is recognisable, so a tombstone never gets shown as somebody's address", () => {
    expect(isTombstoneEmail(tombstoneEmail(uid))).toBe(true);
    expect(isTombstoneEmail("mike@forgewd.com")).toBe(false);
    expect(isTombstoneEmail(null)).toBe(false);
    expect(isTombstoneEmail("")).toBe(false);
  });

  it("is unique per person, which is the whole reason it carries the uid", () => {
    expect(tombstoneEmail("a")).not.toBe(tombstoneEmail("b"));
  });
});

describe("when the server could not check at all", () => {
  it("reads as history, so the record is kept", () => {
    expect(shapeFor({ [UNKNOWN_RECORDS]: 1 })).toBe("retired");
  });

  it("still promises the right thing, without inventing a list", () => {
    const sentence = removalSentence("Dave", { [UNKNOWN_RECORDS]: 1 });
    expect(sentence).toBe(
      "Dave has work on file — the login will be closed, the email freed, " +
        "and every record kept under their name.",
    );
  });
});

describe("the probe list itself", () => {
  it("has no duplicate keys — a duplicate would double-count one table", () => {
    const keys = WORK_HISTORY_PROBES.map(probeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every RESTRICT foreign key to profiles in the schema", () => {
    // These eight columns have no ON DELETE clause, so a hard delete against a
    // person who appears in any of them FAILS. Missing one would turn "delete
    // the account" into a 500 on a phone.
    const restrict = [
      "unit_sessions.profile_id",
      "unit_redos.pressed_by",
      "daily_logs.filed_by",
      "summons.requested_by",
      "opening_phases.started_by",
      "opening_phases.submitted_by",
      "time_shift_edits.edited_by",
      "flash_run_assignments.assigned_by",
    ];
    const keys = new Set(WORK_HISTORY_PROBES.map(probeKey));
    for (const key of restrict) expect(keys.has(key)).toBe(true);
  });
});

/**
 * THE RULE LIVES TWICE, ON PURPOSE, AND THE TWO COPIES ARE PINNED HERE.
 *
 * SQL owns the counting — `person_record_counts` in 20260987000000, because a
 * count that RLS shortened would make a person look emptier than they are, and
 * because no edge function may name `pay_rates` (wave Z; app/src/lib/
 * payRates.test.ts scans for it). TypeScript owns the words and the order they
 * are said in. The join between them is the key strings, and a key added on one
 * side and not the other is silent: the count would be taken and never named,
 * or named and never taken.
 */
describe("the SQL and the probe list agree", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const MIGRATION = join(
    HERE,
    "../../../supabase/migrations/20260987000000_remove_login_start_fresh.sql",
  );

  /** Every `'table.column',` key inside person_record_counts's jsonb object. */
  function sqlKeys(): string[] {
    const sql = readFileSync(MIGRATION, "utf8");
    const body = sql.split("create or replace function public.person_record_counts")[1];
    if (!body) throw new Error("person_record_counts is not in the migration");
    const object = body.split("$$;")[0];
    return [...object.matchAll(/'([a-z_]+\.[a-z_]+)'\s*,/g)].map((m) => m[1]);
  }

  it("finds the function at all, so this test is not vacuous", () => {
    expect(sqlKeys().length).toBeGreaterThan(10);
  });

  it("counts exactly what the probe list names, in the same set", () => {
    expect(new Set(sqlKeys())).toEqual(
      new Set(WORK_HISTORY_PROBES.map(probeKey)),
    );
  });

  it("names pay_rates in SQL and nowhere in an edge function", () => {
    // The reason the counting moved into the database at all. If this ever
    // fails because pay_rates left the SQL, the probe list is now lying about
    // what gets checked before an account is deleted.
    expect(sqlKeys()).toContain("pay_rates.profile_id");
  });
});
