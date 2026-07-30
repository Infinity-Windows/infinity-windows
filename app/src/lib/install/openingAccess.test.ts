import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatApiError } from "./errors";
import {
  describeOpeningDeletion,
  foremanOnlyRefusal,
  OPENING_CREATE_DENIED,
  OPENING_DELETE_DENIED,
  type DeletableOpening,
} from "./openingAccess";

const MIGRATION =
  "../../../../supabase/migrations/20260730180000_foreman_only_opening_create_delete.sql";

/** A shape PostgREST returns when a guard raises. */
const refusal = (message: string) => ({
  message,
  code: "42501",
  details: null,
  hint: null,
});

function opening(over: Partial<DeletableOpening> = {}): DeletableOpening {
  return {
    opening_code: "12",
    status: "planned",
    ro_width_in: null,
    ro_height_in: null,
    condition: "unknown",
    flag_note: null,
    assigned_to: null,
    assignee: null,
    ...over,
  };
}

describe("the app and the database say the same thing", () => {
  // If someone reworded the raise in SQL without touching the constant here,
  // the app would stop recognising the refusal and fall back to "… [42501]".
  const sql = readFileSync(new URL(MIGRATION, import.meta.url), "utf8");

  it("uses the exact sentence the migration raises for a create", () => {
    expect(sql).toContain(`raise exception '${OPENING_CREATE_DENIED}'`);
  });

  it("uses the exact sentence the migration raises for a delete", () => {
    expect(sql).toContain(`raise exception '${OPENING_DELETE_DENIED}'`);
  });
});

describe("foremanOnlyRefusal", () => {
  it("recognises each guard on this table", () => {
    expect(foremanOnlyRefusal(refusal(OPENING_CREATE_DENIED))).toBe(OPENING_CREATE_DENIED);
    expect(foremanOnlyRefusal(refusal(OPENING_DELETE_DENIED))).toBe(OPENING_DELETE_DENIED);
    // The mark-move guard from 20260730160000 opens the same way, so one
    // detector covers it too.
    const move = "Only a foreman or above can move a mark on the plan.";
    expect(foremanOnlyRefusal(refusal(move))).toBe(move);
  });

  it("leaves every other failure alone", () => {
    // A bare RLS denial carries the same 42501 and tells a person nothing.
    expect(
      foremanOnlyRefusal({ message: "new row violates row-level security policy", code: "42501" }),
    ).toBeNull();
    expect(foremanOnlyRefusal({ message: "Failed to fetch" })).toBeNull();
    expect(foremanOnlyRefusal(new Error("network down"))).toBeNull();
    expect(foremanOnlyRefusal(null)).toBeNull();
    expect(foremanOnlyRefusal("nope")).toBeNull();
  });

  it("strips the Postgres code the crew would otherwise see", () => {
    expect(formatApiError(refusal(OPENING_DELETE_DENIED))).toContain("[42501]");
    expect(formatApiError(new Error(OPENING_DELETE_DENIED))).toBe(OPENING_DELETE_DENIED);
  });
});

describe("describeOpeningDeletion", () => {
  it("says plainly when there is nothing to lose", () => {
    expect(describeOpeningDeletion({ opening: opening(), referencedElsewhere: false }))
      .toBe(
        "Remove #12?\n\nNothing has been recorded against it yet, so this only removes the mark. It cannot be undone.",
      );
  });

  it("names the job when it knows it", () => {
    expect(
      describeOpeningDeletion({
        opening: opening(),
        referencedElsewhere: false,
        jobLabel: "BLACK22",
      }),
    ).toContain("Remove #12 from BLACK22?");
  });

  it("leads with the install history, which is the thing nobody can retype", () => {
    const text = describeOpeningDeletion({
      opening: opening({
        status: "installed",
        assigned_to: "u1",
        assignee: { display_name: "Mike" },
        ro_width_in: 35.5,
      }),
      referencedElsewhere: true,
    });
    expect(text).toBe(
      "Remove #12?\n\nThis also deletes its install history, the work assigned to Mike and the rough opening someone measured. It cannot be undone.",
    );
  });

  it("counts install history from a reference even when the status has not caught up", () => {
    expect(
      describeOpeningDeletion({ opening: opening(), referencedElsewhere: true }),
    ).toContain("its install history");
  });

  it("names an assignee it cannot put a name to", () => {
    expect(
      describeOpeningDeletion({
        opening: opening({ assigned_to: "u1", assignee: null }),
        referencedElsewhere: false,
      }),
    ).toContain("the work assigned to someone");
  });

  it("lists a single loss without an 'and'", () => {
    expect(
      describeOpeningDeletion({
        opening: opening({ flag_note: "sill is rotten" }),
        referencedElsewhere: false,
      }),
    ).toBe("Remove #12?\n\nThis also deletes the flag raised on it. It cannot be undone.");
  });

  it("ignores an unknown condition and an empty flag", () => {
    expect(
      describeOpeningDeletion({
        opening: opening({ condition: "unknown", flag_note: "   " }),
        referencedElsewhere: false,
      }),
    ).toContain("Nothing has been recorded against it yet");
  });

  it("counts a condition check that was actually made", () => {
    expect(
      describeOpeningDeletion({
        opening: opening({ condition: "damaged" }),
        referencedElsewhere: false,
      }),
    ).toContain("the condition check");
  });

  it("counts a height-only measurement", () => {
    expect(
      describeOpeningDeletion({
        opening: opening({ ro_height_in: 107.5 }),
        referencedElsewhere: false,
      }),
    ).toContain("the rough opening someone measured");
  });
});
