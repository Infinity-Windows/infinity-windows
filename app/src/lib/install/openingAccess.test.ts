import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatApiError } from "./errors";
import {
  describeOpeningDeletion,
  foremanOnlyRefusal,
  OPENING_CREATE_DENIED,
  OPENING_DELETE_DENIED,
  OPENING_RESTORE_DENIED,
  REMOVED_LIST_DENIED,
  type DeletableOpening,
} from "./openingAccess";

const MIGRATION =
  "../../../../supabase/migrations/20260730180000_foreman_only_opening_create_delete.sql";
const SOFT_DELETE =
  "../../../../supabase/migrations/20260730210000_soft_delete_openings.sql";

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

  const softDelete = readFileSync(new URL(SOFT_DELETE, import.meta.url), "utf8");

  it("reuses that same sentence when a removal is refused", () => {
    // Hiding a window and deleting one are refused with identical words, so a
    // foreman is never told two different things about the same rule.
    expect(softDelete).toContain(`raise exception '${OPENING_DELETE_DENIED}'`);
  });

  it("uses the exact sentences the soft delete raises", () => {
    expect(softDelete).toContain(`raise exception '${OPENING_RESTORE_DENIED}'`);
    expect(softDelete).toContain(`raise exception '${REMOVED_LIST_DENIED}'`);
  });

  // The other direction, which is the one that actually decays: a sentence
  // added to the SQL that the app does not recognise reaches a foreman as raw
  // Postgres text with a `[42501]` on the end.
  it("recognises every sentence the soft delete can raise", () => {
    const raised = [...softDelete.matchAll(/raise exception '((?:[^']|'')+)'/g)].map((m) =>
      m[1].replace(/''/g, "'"),
    );
    expect(raised.length).toBeGreaterThan(4);
    for (const sentence of raised) {
      // `%` is a plpgsql placeholder; the app matches the shape around it.
      const rendered = sentence.replace("%", "12");
      expect(foremanOnlyRefusal({ message: rendered, code: "42501" })).toBe(rendered);
    }
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
    expect(foremanOnlyRefusal(refusal(OPENING_RESTORE_DENIED))).toBe(OPENING_RESTORE_DENIED);
  });

  it("recognises the sentences that are not about a role at all", () => {
    const cases = [
      "That window or door is already installed, so it can't be removed. Undo the install first.",
      "That window or door has a unit from the warehouse against it. Take the unit off it first.",
      "There is already a #12 on this job, so this one cannot come back under that name. Remove or rename the one that is there first.",
      "Use Remove or Put back to hide a window or door, so the job keeps a record of who did it.",
    ];
    for (const message of cases) {
      expect(foremanOnlyRefusal(refusal(message))).toBe(message);
    }
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
        "Remove #12?\n\nNothing has been recorded against it yet, so this just takes the mark off the job. You can put it back from Removed at the bottom of this screen.",
      );
  });

  it("never claims a removal cannot be undone, because it can", () => {
    // The old wording said exactly that, and it was true while this really did
    // delete the row. Saying it now would be a lie at the worst moment.
    const everyShape = [
      describeOpeningDeletion({ opening: opening(), referencedElsewhere: false }),
      describeOpeningDeletion({ opening: opening(), referencedElsewhere: true }),
      describeOpeningDeletion({
        opening: opening({ status: "installed", flag_note: "x" }),
        referencedElsewhere: true,
        jobLabel: "ZZTEST",
      }),
    ];
    for (const text of everyShape) {
      expect(text).not.toContain("cannot be undone");
      expect(text).not.toContain("deletes");
      expect(text).toContain("put it back");
    }
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
      "Remove #12?\n\nIt goes off the job along with its install history, the work assigned to Mike and the rough opening someone measured — nothing is deleted. You can put it back from Removed at the bottom of this screen.",
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
    ).toBe(
      "Remove #12?\n\nIt goes off the job along with the flag raised on it — nothing is deleted. You can put it back from Removed at the bottom of this screen.",
    );
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
