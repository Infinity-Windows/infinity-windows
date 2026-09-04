import { describe, expect, it } from "vitest";
import {
  actuallyChanged,
  addCrewIds,
  allCrewIds,
  clockTimeLabel,
  clockedInPushBody,
  clockedOutPushBody,
  countCrewOutcomes,
  crewToClockOut,
  onClockCrewIds,
  outcomeKind,
  planCrewClockIn,
  refusalReason,
  toggleCrewId,
  withSkipped,
  type CrewClockMember,
} from "./crewClock";

const OFFICE = "job-office";
const SITE = "job-site";

const ROSTER: CrewClockMember[] = [
  { id: "a", name: "Ana", onClock: true, openProjectId: OFFICE },
  { id: "b", name: "Ben", onClock: true, openProjectId: SITE },
  { id: "c", name: "Cara", onClock: false, openProjectId: null },
  { id: "d", name: "Dan", onClock: true, openProjectId: null },
  { id: "e", name: "Eve", onClock: false, openProjectId: null },
];

describe("planCrewClockIn", () => {
  it("leaves somebody on another job alone, and names them, when Move is off", () => {
    const plan = planCrewClockIn(ROSTER, ["a", "b", "c"], OFFICE, false);
    expect(plan.willClockIn).toEqual(["a", "c"]);
    expect(plan.elsewhere).toEqual(["b"]);
    expect(plan.alreadyHere).toEqual(["a"]);
  });

  it("brings them over when Move is ticked", () => {
    const plan = planCrewClockIn(ROSTER, ["a", "b", "c"], OFFICE, true);
    expect(plan.willClockIn).toEqual(["a", "b", "c"]);
    expect(plan.elsewhere).toEqual(["b"]);
  });

  it("still sends the people already on this job, so the roster can report it", () => {
    const plan = planCrewClockIn(ROSTER, ["a"], OFFICE, false);
    expect(plan.willClockIn).toEqual(["a"]);
    expect(plan.alreadyHere).toEqual(["a"]);
    expect(plan.elsewhere).toEqual([]);
  });

  // Somebody on the clock against NO job is not "already here" for any job:
  // moving them onto one is a real change and needs the same permission.
  it("treats an open punch with no job as being somewhere else", () => {
    const plan = planCrewClockIn(ROSTER, ["d"], OFFICE, false);
    expect(plan.willClockIn).toEqual([]);
    expect(plan.elsewhere).toEqual(["d"]);
    expect(planCrewClockIn(ROSTER, ["d"], OFFICE, true).willClockIn).toEqual(["d"]);
  });

  it("ignores ids that are not on the roster, and keeps roster order", () => {
    const plan = planCrewClockIn(ROSTER, ["e", "ghost", "c"], OFFICE, false);
    expect(plan.willClockIn).toEqual(["c", "e"]);
  });

  // No job picked yet: nobody counts as "already here", so the sheet's skip
  // warning does not flash a wrong number before a job is chosen.
  it("says nobody is already here when no job is picked", () => {
    const plan = planCrewClockIn(ROSTER, ["a", "b"], null, false);
    expect(plan.alreadyHere).toEqual([]);
    expect(plan.elsewhere).toEqual(["a", "b"]);
    expect(plan.willClockIn).toEqual([]);
  });
});

describe("crewToClockOut", () => {
  it("is only the people who are actually on the clock", () => {
    expect(crewToClockOut(ROSTER, ["a", "c", "d", "e"])).toEqual(["a", "d"]);
  });

  it("is empty when nobody picked is on the clock", () => {
    expect(crewToClockOut(ROSTER, ["c", "e"])).toEqual([]);
  });
});

describe("selection helpers", () => {
  it("selects everyone, and everyone on the clock", () => {
    expect(allCrewIds(ROSTER)).toEqual(["a", "b", "c", "d", "e"]);
    expect(onClockCrewIds(ROSTER)).toEqual(["a", "b", "d"]);
  });

  it("toggles one row without disturbing the others or duplicating it", () => {
    expect(toggleCrewId(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleCrewId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(toggleCrewId(["a"], "a")).toEqual([]);
  });
});

// The roster's two "select" buttons are given the rows the SEARCH BOX is
// showing, not the whole company. addCrewIds is the half that makes that safe
// to do repeatedly: it adds, so a name found by a second search never unticks
// the first one's.
describe("addCrewIds", () => {
  it("adds the visible rows without dropping what is already ticked", () => {
    expect(addCrewIds(["a", "b"], ["c", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("never duplicates somebody already selected", () => {
    expect(addCrewIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(addCrewIds(["a"], ["a"])).toEqual(["a"]);
  });

  it("is a copy, never the same array back", () => {
    const before = ["a"];
    const after = addCrewIds(before, []);
    expect(after).toEqual(["a"]);
    expect(after).not.toBe(before);
  });

  // Filtering to one name and tapping "Select all" must tick ONE person, not
  // the forty-one on the full roster (2026-09-04 review).
  it("ticks only what was handed to it", () => {
    const visible = ROSTER.filter((m) => m.name === "Ben");
    expect(addCrewIds([], allCrewIds(visible))).toEqual(["b"]);
  });
});

// Fourteen names ticked, eleven lines back, and no word about the other three
// is not an answer — it is a puzzle. The skipped people come first, because
// they are the part of the answer that is not "done".
describe("withSkipped", () => {
  const SERVER = [
    { profile_id: "c", outcome: "clocked_in" },
    { profile_id: "e", outcome: "clocked_in" },
  ];

  it("puts the people no request carried at the top of the answer", () => {
    expect(withSkipped(SERVER, ["b"])).toEqual([
      { profile_id: "b", outcome: "skipped" },
      ...SERVER,
    ]);
  });

  it("takes the word to use, so a clock-out says what is actually true", () => {
    expect(withSkipped([], ["c", "e"], "already_out")).toEqual([
      { profile_id: "c", outcome: "already_out" },
      { profile_id: "e", outcome: "already_out" },
    ]);
  });

  // A race can send somebody the plan meant to skip. The server's word wins.
  it("never repeats an id the server already answered for", () => {
    expect(withSkipped(SERVER, ["c", "b"])).toEqual([
      { profile_id: "b", outcome: "skipped" },
      ...SERVER,
    ]);
  });

  it("does not duplicate a skipped id given twice", () => {
    expect(withSkipped([], ["b", "b"])).toEqual([
      { profile_id: "b", outcome: "skipped" },
    ]);
  });

  it("is just the server's list when nothing was skipped", () => {
    expect(withSkipped(SERVER, [])).toEqual(SERVER);
  });

  it("reads as its own outcome, not as an unknown word", () => {
    expect(outcomeKind(withSkipped([], ["b"])[0].outcome)).toBe("skipped");
  });
});

describe("outcomeKind / refusalReason", () => {
  it("reads every outcome the server can send", () => {
    expect(outcomeKind("clocked_in")).toBe("clocked_in");
    expect(outcomeKind("already_on_this_job")).toBe("already_on_this_job");
    expect(outcomeKind("moved_from_other_job")).toBe("moved_from_other_job");
    expect(outcomeKind("clocked_out")).toBe("clocked_out");
    expect(outcomeKind("already_out")).toBe("already_out");
    expect(outcomeKind("refused:They are not an active crew member.")).toBe("refused");
  });

  it("never shows a raw word it does not understand", () => {
    expect(outcomeKind("something_new")).toBe("unknown");
    expect(outcomeKind("")).toBe("unknown");
    expect(outcomeKind(null)).toBe("unknown");
  });

  it("pulls the plain sentence out of a refusal", () => {
    expect(refusalReason("refused: Already on MADMOOSE.")).toBe("Already on MADMOOSE.");
    expect(refusalReason("clocked_in")).toBe("");
    expect(refusalReason(undefined)).toBe("");
  });
});

describe("countCrewOutcomes / actuallyChanged", () => {
  const RESULTS = [
    { profile_id: "a", outcome: "clocked_in" },
    { profile_id: "b", outcome: "moved_from_other_job" },
    { profile_id: "c", outcome: "already_on_this_job" },
    { profile_id: "d", outcome: "refused:They are not an active crew member." },
  ];

  it("counts each kind", () => {
    const counts = countCrewOutcomes([
      ...RESULTS,
      { profile_id: "e", outcome: "skipped" },
    ]);
    expect(counts.skipped).toBe(1);
    expect(counts.clocked_in).toBe(1);
    expect(counts.moved_from_other_job).toBe(1);
    expect(counts.already_on_this_job).toBe(1);
    expect(counts.refused).toBe(1);
    expect(counts.clocked_out).toBe(0);
  });

  // Nobody is pushed about a punch that did not move: telling somebody
  // already on the job that they were "clocked in" is a false alert — and
  // somebody the request never carried is the clearest case of all.
  it("only pushes the people something actually happened to", () => {
    expect(actuallyChanged(RESULTS)).toEqual(["a", "b"]);
    expect(actuallyChanged(withSkipped(RESULTS, ["z"]))).toEqual(["a", "b"]);
    expect(
      actuallyChanged([
        { profile_id: "x", outcome: "clocked_out" },
        { profile_id: "y", outcome: "already_out" },
      ]),
    ).toEqual(["x"]);
  });
});

describe("push copy", () => {
  /** A local time built from parts, so the label is not timezone-dependent. */
  const at = (h: number, m: number) =>
    new Date(2026, 8, 4, h, m, 0, 0).toISOString();

  it("writes the hour the same way on every phone", () => {
    expect(clockTimeLabel(at(7, 3))).toBe("7:03 AM");
    expect(clockTimeLabel(at(16, 30))).toBe("4:30 PM");
    expect(clockTimeLabel(at(0, 5))).toBe("12:05 AM");
    expect(clockTimeLabel(at(12, 0))).toBe("12:00 PM");
  });

  it("says nothing rather than Invalid Date", () => {
    expect(clockTimeLabel(null)).toBe("");
    expect(clockTimeLabel("not a time")).toBe("");
  });

  it("names who did it, where, and when", () => {
    expect(clockedInPushBody("Marlene", "OFFICE", at(7, 3))).toBe(
      "Marlene clocked you in at OFFICE, 7:03 AM.",
    );
    expect(clockedOutPushBody("Marlene", at(16, 30))).toBe(
      "Marlene clocked you out, 4:30 PM.",
    );
  });

  it("drops the clause it cannot fill instead of leaving a gap", () => {
    expect(clockedInPushBody("Marlene", null, at(7, 3))).toBe(
      "Marlene clocked you in, 7:03 AM.",
    );
    expect(clockedInPushBody("Marlene", "OFFICE", null)).toBe(
      "Marlene clocked you in at OFFICE.",
    );
    expect(clockedOutPushBody("  ", at(16, 30))).toBe(
      "A supervisor clocked you out, 4:30 PM.",
    );
  });
});
