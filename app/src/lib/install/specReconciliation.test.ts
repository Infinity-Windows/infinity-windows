import { describe, expect, it } from "vitest";
import {
  describeAcknowledged,
  describeReconciliation,
  installerMissingSpecMessage,
  markLabel,
  planMarksFromOpenings,
  reconcileSpecsWithPlans,
  reconciliationLines,
  specHasSize,
  type DiscrepancyKind,
  type PlanMark,
  type ReconcileSpec,
} from "./specReconciliation";

/** A complete, healthy spec row for `mark`. */
function spec(mark: string, over: Partial<ReconcileSpec> = {}): ReconcileSpec {
  return {
    mark_code: mark,
    style: `Thermal Break Aluminum Fixed Window (mark ${mark})`,
    width_in: 36,
    height_in: 72,
    image_bbox: [0.1, 0.1, 0.5, 0.5],
    ...over,
  };
}

function planMark(mark: string, units = 1, isDoor = false): PlanMark {
  return { mark, units, isDoor };
}

/** Marks + specs that agree completely. */
function healthy(marks: string[]) {
  return {
    planMarks: marks.map((m) => planMark(m)),
    specs: marks.map((m) => spec(m)),
  };
}

const kinds = (r: ReturnType<typeof reconcileSpecsWithPlans>) =>
  r.discrepancies.map((d) => `${d.kind}:${d.mark}`);

describe("planMarksFromOpenings", () => {
  it("collapses openings into distinct marks with unit counts", () => {
    const marks = planMarksFromOpenings([
      { opening_code: "7" },
      { opening_code: "8" },
      { opening_code: "8-2" },
      { opening_code: "8-3" },
    ]);
    expect(marks).toEqual([
      { mark: "7", units: 1, isDoor: false },
      { mark: "8", units: 3, isDoor: false },
    ]);
  });

  it("sorts marks the way a human reads them, not lexically", () => {
    const marks = planMarksFromOpenings(
      ["10", "2", "1", "13A", "13B", "9"].map((c) => ({ opening_code: c })),
    );
    expect(marks.map((m) => m.mark)).toEqual(["1", "2", "9", "10", "13A", "13B"]);
  });

  it("treats the door flag as evidence when present, never its absence", () => {
    const marks = planMarksFromOpenings([
      { opening_code: "26", window_types: { category: "window" } },
      { opening_code: "26-2", window_types: { category: "Patio Door" } },
      { opening_code: "27", window_types: { category: null } },
    ]);
    expect(marks.find((m) => m.mark === "26")?.isDoor).toBe(true);
    expect(marks.find((m) => m.mark === "27")?.isDoor).toBe(false);
  });

  it("ignores openings with no usable code", () => {
    expect(planMarksFromOpenings([{ opening_code: "" }, { opening_code: null }])).toEqual([]);
  });
});

describe("which marks are called doors", () => {
  it("believes the spec description over the plans", () => {
    // Black Desert #26: the plans file it as a window, the sheet calls it a
    // French door. The map now says door, so this must too.
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("26", 1, false)],
      specs: [
        spec("26", {
          style: "Thermal break Aluminum French Door (Low track)",
          width_in: null,
          height_in: null,
        }),
      ],
    });
    expect(markLabel(r.discrepancies[0])).toBe("#26 (door)");
  });

  it("believes the description the other way too", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("2", 1, true)],
      specs: [
        spec("2", {
          style: "Thermal Break Aluminum Fixed Window",
          width_in: null,
          height_in: null,
        }),
      ],
    });
    expect(markLabel(r.discrepancies[0])).toBe("#2");
  });

  it("falls back to the plans for a mark with no spec to read", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7", 1, true)],
      specs: [],
    });
    expect(markLabel(r.discrepancies[0])).toBe("#7 (door)");
  });
});

describe("a job where the two documents agree", () => {
  // Smith / PV Townhomes Bldg 14 as it stands in the database today: 24 marks
  // on the plans, 24 specs, every one of them complete. This must stay silent.
  const smithMarks = Array.from({ length: 24 }, (_, i) => String(i + 1));

  it("reports nothing at all for Smith", () => {
    const r = reconcileSpecsWithPlans(healthy(smithMarks));
    expect(r.planMarkCount).toBe(24);
    expect(r.specMarkCount).toBe(24);
    expect(r.discrepancies).toEqual([]);
    expect(r.reconciled).toBe(true);
  });

  it("produces an empty report rather than a cheerful one", () => {
    const r = reconcileSpecsWithPlans(healthy(smithMarks));
    expect(describeReconciliation(r)).toBeNull();
    expect(describeAcknowledged(r)).toBeNull();
    expect(reconciliationLines(r.open)).toEqual([]);
  });

  it("matches an opening instance to its base mark (18-2 is mark 18)", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: planMarksFromOpenings([
        { opening_code: "18-2" },
        { opening_code: "18" },
      ]),
      specs: [spec("18")],
    });
    expect(r.planMarkCount).toBe(1);
    expect(r.reconciled).toBe(true);
  });

  it("compares marks case-insensitively (13a is 13A)", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("13a")],
      specs: [spec("13A")],
    });
    expect(r.reconciled).toBe(true);
  });
});

describe("marks on the plans with no spec sheet", () => {
  it("finds Black Desert's #7 and #8", () => {
    // The supplier's sheet numbers its panels #1…#39 and skips 7 and 8
    // outright (page 2's four panels read #5, #6, #9, #10).
    const planMarks = Array.from({ length: 39 }, (_, i) => planMark(String(i + 1)))
      .filter((m) => m.mark !== "25");
    const specs = Array.from({ length: 39 }, (_, i) => String(i + 1))
      .filter((m) => m !== "7" && m !== "8")
      .map((m) => spec(m));

    const r = reconcileSpecsWithPlans({ planMarks, specs });
    expect(r.planMarkCount).toBe(38);
    expect(r.specMarkCount).toBe(37);
    expect(
      r.discrepancies.filter((d) => d.kind === "mark_without_spec").map((d) => d.mark),
    ).toEqual(["7", "8"]);
  });

  it("says so in the user's own words", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7"), planMark("8"), planMark("9")],
      specs: [spec("9")],
    });
    expect(describeReconciliation(r)).toBe(
      "2 marks on the plans have no spec sheet: #7 and #8.",
    );
  });

  it("uses singular wording for a single mark", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7"), planMark("9")],
      specs: [spec("9")],
    });
    expect(describeReconciliation(r)).toBe(
      "1 mark on the plans has no spec sheet: #7.",
    );
  });

  it("names a door as a door, and stays quiet about windows", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7", 1, true), planMark("8", 1, false)],
      specs: [],
    });
    expect(describeReconciliation(r)).toBe(
      "2 marks on the plans have no spec sheet: #7 (door) and #8.",
    );
  });

  it("carries the unit count so a foreman knows the size of the hole", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7", 3)],
      specs: [],
    });
    expect(r.discrepancies[0]).toMatchObject({ mark: "7", units: 3 });
  });

  it("counts a spec row with no usable content as no spec at all", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7")],
      specs: [
        {
          mark_code: "7",
          style: null,
          glass: null,
          color: null,
          size_code: null,
          width_in: null,
          height_in: null,
        },
      ],
    });
    expect(kinds(r)).toEqual(["mark_without_spec:7"]);
  });
});

describe("specs with no window on the plans", () => {
  it("finds Black Desert's #25", () => {
    // #25 is on the spec sheet as an interior French door whose drawing panel
    // the supplier left blank — hence no size and no elevation either.
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("24"), planMark("26")],
      specs: [
        spec("24"),
        spec("25", {
          style: "Non-Thermal break Aluminum Narrow French Door (Interior use)",
          width_in: null,
          height_in: null,
          size_code: null,
          image_bbox: null,
        }),
        spec("26"),
      ],
    });
    expect(kinds(r)).toEqual(["spec_without_mark:25"]);
    expect(r.discrepancies[0]).toMatchObject({
      mark: "25",
      units: 0,
      hasSize: false,
      style: "Non-Thermal break Aluminum Narrow French Door (Interior use)",
    });
  });

  it("mentions the missing size in passing rather than as a second problem", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("24")],
      specs: [
        spec("24"),
        spec("25", { width_in: null, height_in: null, size_code: null }),
      ],
    });
    expect(describeReconciliation(r)).toBe(
      "1 spec has no window on the plans: #25 — no size given either.",
    );
  });

  it("drops the size aside when the orphan spec is fully dimensioned", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("24")],
      specs: [spec("24"), spec("25")],
    });
    expect(describeReconciliation(r)).toBe(
      "1 spec has no window on the plans: #25.",
    );
  });
});

describe("both directions at once — the real Black Desert report", () => {
  const planMarks = Array.from({ length: 39 }, (_, i) => planMark(String(i + 1)))
    .filter((m) => m.mark !== "25");
  const specs = Array.from({ length: 39 }, (_, i) => String(i + 1))
    .filter((m) => m !== "7" && m !== "8")
    .map((m) =>
      m === "25"
        ? spec(m, {
            style: "Non-Thermal break Aluminum Narrow French Door (Interior use)",
            width_in: null,
            height_in: null,
            size_code: null,
            image_bbox: null,
          })
        : spec(m),
    );

  it("finds exactly three things and nothing else", () => {
    const r = reconcileSpecsWithPlans({ planMarks, specs });
    expect(kinds(r)).toEqual([
      "mark_without_spec:7",
      "mark_without_spec:8",
      "spec_without_mark:25",
    ]);
    expect(r.reconciled).toBe(false);
  });

  it("reads as plain English a foreman could act on", () => {
    const r = reconcileSpecsWithPlans({ planMarks, specs });
    // #25 reads "(door)" although no opening on the plans claims it: the
    // supplier's own line calls it a French door, and that is the thing the
    // foreman has to go and ask about.
    expect(describeReconciliation(r)).toBe(
      "2 marks on the plans have no spec sheet: #7 and #8. " +
        "1 spec has no window on the plans: #25 (door) — no size given either.",
    );
  });

  it("speaks about the blocking direction first", () => {
    const r = reconcileSpecsWithPlans({ planMarks, specs });
    expect(reconciliationLines(r.open).map((l) => l.kind)).toEqual([
      "mark_without_spec",
      "spec_without_mark",
    ]);
  });
});

describe("half a spec", () => {
  it("flags a mark on the plans whose spec carries no size", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("12")],
      specs: [spec("12", { width_in: null, height_in: null, size_code: null })],
    });
    expect(kinds(r)).toEqual(["spec_without_size:12"]);
    expect(describeReconciliation(r)).toBe("1 spec has no size on it: #12.");
  });

  it("accepts a raw call size as a size", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("12")],
      specs: [
        spec("12", { width_in: null, height_in: null, size_code: "3060" }),
      ],
    });
    expect(r.reconciled).toBe(true);
  });

  it("flags a spec whose elevation drawing never arrived", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("18B")],
      specs: [spec("18B", { image_bbox: null })],
    });
    expect(kinds(r)).toEqual(["spec_without_drawing:18B"]);
    expect(describeReconciliation(r)).toBe("1 spec has no drawing: #18B.");
  });

  it("raises size and drawing separately — they are two different errands", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("18B")],
      specs: [
        spec("18B", {
          width_in: null,
          height_in: null,
          size_code: null,
          image_bbox: null,
        }),
      ],
    });
    expect(kinds(r)).toEqual(["spec_without_size:18B", "spec_without_drawing:18B"]);
  });

  it("lets a complete duplicate row rescue a thin one", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("5")],
      specs: [
        spec("5", { width_in: null, height_in: null, size_code: null }),
        spec("5"),
      ],
    });
    expect(r.reconciled).toBe(true);
  });
});

describe("labelling a discrepancy as a known supplier gap", () => {
  const planMarks = [planMark("7"), planMark("8"), planMark("9")];
  const specs = [spec("9")];

  it("moves a labelled mark off the open list without losing it", () => {
    const r = reconcileSpecsWithPlans({
      planMarks,
      specs,
      acknowledgements: [{ mark_code: "7", kind: "mark_without_spec" }],
    });
    expect(r.discrepancies).toHaveLength(2);
    expect(r.open.map((d) => d.mark)).toEqual(["8"]);
    expect(r.acknowledged.map((d) => d.mark)).toEqual(["7"]);
    expect(r.reconciled).toBe(false);
  });

  it("drops the labelled mark out of the open sentence", () => {
    const r = reconcileSpecsWithPlans({
      planMarks,
      specs,
      acknowledgements: [{ mark_code: "7", kind: "mark_without_spec" }],
    });
    expect(describeReconciliation(r)).toBe(
      "1 mark on the plans has no spec sheet: #8.",
    );
  });

  it("reports what is being chased, separately", () => {
    const r = reconcileSpecsWithPlans({
      planMarks,
      specs,
      acknowledgements: [
        { mark_code: "7", kind: "mark_without_spec" },
        { mark_code: "8", kind: "mark_without_spec" },
      ],
    });
    expect(describeReconciliation(r)).toBeNull();
    expect(describeAcknowledged(r)).toBe(
      "Being chased with the supplier: #7 and #8.",
    );
  });

  it("keeps the note the office wrote", () => {
    const r = reconcileSpecsWithPlans({
      planMarks,
      specs,
      acknowledgements: [
        { mark_code: "7", kind: "mark_without_spec", note: "  emailed Strata 7/28  " },
      ],
    });
    expect(r.acknowledged[0].note).toBe("emailed Strata 7/28");
  });

  it("labels one kind without silencing another on the same mark", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("18B")],
      specs: [
        spec("18B", {
          width_in: null,
          height_in: null,
          size_code: null,
          image_bbox: null,
        }),
      ],
      acknowledgements: [{ mark_code: "18B", kind: "spec_without_size" }],
    });
    expect(r.open.map((d) => d.kind)).toEqual(["spec_without_drawing"]);
    expect(r.acknowledged.map((d) => d.kind)).toEqual(["spec_without_size"]);
  });

  it("matches a label written in a different case", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("13A")],
      specs: [],
      acknowledgements: [{ mark_code: "13a", kind: "mark_without_spec" }],
    });
    expect(r.open).toEqual([]);
    expect(r.acknowledged).toHaveLength(1);
  });

  it("a label for something that no longer disagrees changes nothing", () => {
    // The supplier sent the missing sheet and a re-extract picked it up: the
    // stale acknowledgement must not resurrect the finding.
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7")],
      specs: [spec("7")],
      acknowledgements: [{ mark_code: "7", kind: "mark_without_spec" }],
    });
    expect(r.reconciled).toBe(true);
    expect(describeReconciliation(r)).toBeNull();
    expect(describeAcknowledged(r)).toBeNull();
  });
});

describe("edge cases", () => {
  it("a project with no openings and no specs has nothing to say", () => {
    const r = reconcileSpecsWithPlans({ planMarks: [], specs: [] });
    expect(r.reconciled).toBe(true);
    expect(describeReconciliation(r)).toBeNull();
  });

  it("openings with no specs at all report every mark", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("1"), planMark("2")],
      specs: [],
    });
    expect(kinds(r)).toEqual(["mark_without_spec:1", "mark_without_spec:2"]);
  });

  it("ignores spec rows with no usable mark", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("1")],
      specs: [spec("1"), { mark_code: "" }],
    });
    expect(r.reconciled).toBe(true);
  });

  it("collapses duplicate plan marks into one entry", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: [planMark("7", 2), planMark("7", 3)],
      specs: [],
    });
    expect(r.planMarkCount).toBe(1);
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0].units).toBe(5);
  });

  it("survives null-ish input without throwing", () => {
    const r = reconcileSpecsWithPlans({
      planMarks: undefined as unknown as PlanMark[],
      specs: undefined as unknown as ReconcileSpec[],
    });
    expect(r.reconciled).toBe(true);
  });
});

describe("specHasSize", () => {
  it("accepts any one of width, height, or a raw call size", () => {
    expect(specHasSize({ mark_code: "1", width_in: 36 })).toBe(true);
    expect(specHasSize({ mark_code: "1", height_in: 72 })).toBe(true);
    expect(specHasSize({ mark_code: "1", size_code: "3060" })).toBe(true);
  });

  it("rejects a row with nothing dimensional on it", () => {
    expect(specHasSize({ mark_code: "1", style: "French Door" })).toBe(false);
    expect(specHasSize({ mark_code: "1", size_code: "   " })).toBe(false);
  });
});

describe("markLabel", () => {
  it("only says door when the plans say door", () => {
    const base = {
      mark: "7",
      kind: "mark_without_spec" as DiscrepancyKind,
      units: 1,
      style: null,
      hasSize: false,
      acknowledged: false,
      note: null,
    };
    expect(markLabel({ ...base, isDoor: true })).toBe("#7 (door)");
    expect(markLabel({ ...base, isDoor: false })).toBe("#7");
  });
});

describe("what an installer is told", () => {
  it("explains the blank calmly and says the office has it", () => {
    expect(installerMissingSpecMessage("7", false)).toBe(
      "No spec sheet for mark #7 — the supplier's sheet doesn't cover this one. " +
        "The office has been told.",
    );
  });

  it("reads as actively chased once the office has labelled it", () => {
    expect(installerMissingSpecMessage("7", true)).toBe(
      "No spec sheet for mark #7 — the supplier's sheet doesn't cover this one. " +
        "The office knows and is chasing it.",
    );
  });

  it("never sounds like an error", () => {
    const text = installerMissingSpecMessage("7", false).toLowerCase();
    for (const alarming of ["error", "failed", "missing spec", "invalid", "problem"]) {
      expect(text).not.toContain(alarming);
    }
  });
});
