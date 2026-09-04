import { describe, expect, it } from "vitest";
import {
  assignmentText,
  assignmentTimelineRows,
  type OpeningAssignmentEvent,
} from "./assignmentHistory";
import { CATALOG, translate, type Lang, type TFn } from "../i18n";

const NAMES: Record<string, string> = { sam: "Sam", jed: "Jed", maria: "Maria" };
const nameOf = (id: string) => NAMES[id] ?? null;

// The REAL catalog, in whichever language — so a key that does not exist
// renders as "" here and fails the assertion, rather than reaching a phone.
const tIn = (lang: Lang): TFn => (key, vars) => translate(CATALOG, lang, key, vars);
const t = tIn("en");

function ev(over: Partial<OpeningAssignmentEvent> = {}): OpeningAssignmentEvent {
  return {
    id: "e1",
    opening_id: "o1",
    project_id: "p1",
    from_profile: null,
    to_profile: "sam",
    changed_by: "jed",
    changed_at: "2026-09-01T13:40:00Z",
    via: "dispatch",
    ...over,
  };
}

describe("assignmentText", () => {
  it("says who a unit was given to and who gave it", () => {
    expect(assignmentText(ev(), nameOf, t)).toBe("Assigned to Sam by Jed");
  });

  it("says both people when a unit moves from one list to another", () => {
    expect(
      assignmentText(ev({ from_profile: "sam", to_profile: "maria" }), nameOf, t),
    ).toBe("Moved from Sam to Maria by Jed");
  });

  it("says whose list a unit came off", () => {
    expect(
      assignmentText(ev({ from_profile: "sam", to_profile: null }), nameOf, t),
    ).toBe("Taken off Sam's list by Jed");
  });

  it("falls back to Crew for somebody the roster cannot name", () => {
    expect(assignmentText(ev({ to_profile: "left-in-2024" }), nameOf, t)).toBe(
      "Assigned to Crew by Jed",
    );
  });

  it("drops the 'by' half rather than inventing an actor", () => {
    // changed_by is auth.uid(), which is null for anything the server itself
    // did. "by nobody" would be a worse answer than saying nothing.
    expect(assignmentText(ev({ changed_by: null }), nameOf, t)).toBe("Assigned to Sam");
  });

  it("still says something when both ends are empty", () => {
    expect(
      assignmentText({ from_profile: null, to_profile: null, changed_by: "jed" }, nameOf, t),
    ).toBe("Assignment cleared by Jed");
  });
});

describe("assignmentTimelineRows", () => {
  it("carries the change time so the Record can merge and sort it", () => {
    const rows = assignmentTimelineRows(
      [ev(), ev({ id: "e2", from_profile: "sam", to_profile: null, changed_at: "2026-09-02T09:00:00Z" })],
      nameOf,
      t,
    );
    expect(rows).toEqual([
      { at: "2026-09-01T13:40:00Z", text: "Assigned to Sam by Jed", kind: "assign" },
      { at: "2026-09-02T09:00:00Z", text: "Taken off Sam's list by Jed", kind: "assign" },
    ]);
  });

  it("is empty for a unit nobody ever handed out", () => {
    expect(assignmentTimelineRows([], nameOf, t)).toEqual([]);
  });
});

describe("every sentence reads in Spanish too", () => {
  // A crew-facing string that only exists in English is the failure this
  // guards: translate() returns "" for a key the catalog has not got, so an
  // empty line here is a missing entry, and an English one is an untranslated
  // entry. The whole log has to read for a Spanish-first installer.
  const es = tIn("es");

  it("names both people, with the mover first, the way Spanish says it", () => {
    expect(assignmentText(ev(), nameOf, es)).toBe("Jed se la asignó a Sam");
    expect(
      assignmentText(ev({ from_profile: "sam", to_profile: "maria" }), nameOf, es),
    ).toBe("Jed la pasó de Sam a Maria");
    expect(
      assignmentText(ev({ from_profile: "sam", to_profile: null }), nameOf, es),
    ).toBe("Jed la quitó de la lista de Sam");
  });

  it("has a Spanish string for every shape, including the nameless ones", () => {
    const shapes = [
      ev(),
      ev({ from_profile: "sam", to_profile: "maria" }),
      ev({ from_profile: "sam", to_profile: null }),
      ev({ from_profile: null, to_profile: null }),
      ev({ changed_by: null }),
      ev({ from_profile: "sam", to_profile: "maria", changed_by: null }),
      ev({ from_profile: "sam", to_profile: null, changed_by: null }),
      ev({ from_profile: null, to_profile: null, changed_by: null }),
      ev({ to_profile: "left-in-2024" }),
    ];
    for (const shape of shapes) {
      const line = assignmentText(shape, nameOf, es);
      expect(line).not.toBe("");
      expect(line).not.toBe(assignmentText(shape, nameOf, t));
    }
  });
});
