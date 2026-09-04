import { describe, expect, it } from "vitest";
import {
  buildCustomMarkRegistrationPayload,
  describeCustomMarkAdditions,
  selectNewCustomMarks,
  type CustomMarkDraft,
} from "./customMarks";

describe("selectNewCustomMarks", () => {
  it("keeps a draft with a code not already on the job", () => {
    const drafts: CustomMarkDraft[] = [{ code: "D-11", kind: "door", wMm: 900, hMm: 2100 }];
    const out = selectNewCustomMarks(drafts, ["1", "2", "3"]);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("D-11");
    expect(out[0].widthIn).toBe(35); // 900mm / 25.4, rounded
    expect(out[0].heightIn).toBe(83);
  });

  it("drops a draft whose code already exists on the job, case/space insensitive", () => {
    const drafts: CustomMarkDraft[] = [{ code: " d-11 ", kind: "door", wMm: 900, hMm: 2100 }];
    expect(selectNewCustomMarks(drafts, ["D-11"])).toHaveLength(0);
  });

  it("dedupes repeat drafts of the same code — last one wins", () => {
    const drafts: CustomMarkDraft[] = [
      { code: "W-A", kind: "window", wMm: 600, hMm: 900 },
      { code: "w-a", kind: "window", wMm: 1200, hMm: 1500 },
    ];
    const out = selectNewCustomMarks(drafts, []);
    expect(out).toHaveLength(1);
    expect(out[0].wMm).toBe(1200);
  });

  it("drops a blank code and a zero/negative size", () => {
    const drafts: CustomMarkDraft[] = [
      { code: "", kind: "window", wMm: 600, hMm: 900 },
      { code: "W-B", kind: "window", wMm: 0, hMm: 900 },
      { code: "W-C", kind: "window", wMm: 600, hMm: -1 },
    ];
    expect(selectNewCustomMarks(drafts, [])).toHaveLength(0);
  });

  it("sorts the result by code for a stable, readable order", () => {
    const drafts: CustomMarkDraft[] = [
      { code: "W-B", kind: "window", wMm: 600, hMm: 900 },
      { code: "D-1", kind: "door", wMm: 900, hMm: 2100 },
    ];
    const out = selectNewCustomMarks(drafts, []);
    expect(out.map((m) => m.code)).toEqual(["D-1", "W-B"]);
  });
});

describe("describeCustomMarkAdditions", () => {
  it("returns null with nothing new — an ordinary publish says nothing extra", () => {
    expect(describeCustomMarkAdditions([])).toBeNull();
  });

  it("singular for one mark", () => {
    const out = selectNewCustomMarks([{ code: "D-11", kind: "door", wMm: 900, hMm: 2100 }], []);
    expect(describeCustomMarkAdditions(out)).toBe("Adds 1 new mark to this job: D-11");
  });

  it("plural, comma-joined, in the sorted order", () => {
    const out = selectNewCustomMarks(
      [
        { code: "W-A", kind: "window", wMm: 600, hMm: 900 },
        { code: "D-11", kind: "door", wMm: 900, hMm: 2100 },
      ],
      [],
    );
    expect(describeCustomMarkAdditions(out)).toBe("Adds 2 new marks to this job: D-11, W-A");
  });
});

describe("buildCustomMarkRegistrationPayload", () => {
  it("builds the opening + spec payloads for a window", () => {
    const [mark] = selectNewCustomMarks(
      [{ code: "W-A", kind: "window", wMm: 610, hMm: 914 }],
      [],
    );
    const payload = buildCustomMarkRegistrationPayload("proj-1", mark);
    expect(payload.markCode).toBe("W-A");
    expect(payload.opening).toEqual({ opening_code: "W-A", confirmed: true });
    expect(payload.spec).toEqual({
      project_id: "proj-1",
      mark_code: "W-A",
      width_in: 24, // 610 / 25.4 rounded
      height_in: 36, // 914 / 25.4 rounded
      operation: "Window",
      source: "manual",
      confirmed: true,
      unit_kind: "window",
      door_kind: null,
    });
  });

  it("a door kind becomes operation 'Door'", () => {
    const [mark] = selectNewCustomMarks([{ code: "D-11", kind: "door", wMm: 900, hMm: 2100 }], []);
    const payload = buildCustomMarkRegistrationPayload("proj-1", mark);
    expect(payload.spec.operation).toBe("Door");
  });

  // A Studio unit is named, not described: there is no style line saying which
  // door it is. "other" is the honest answer, and the one the counts view has a
  // bucket for — better than filing every hand-named door as a swing.
  it("a door is stored as a door of no stated kind", () => {
    const [mark] = selectNewCustomMarks([{ code: "D-11", kind: "door", wMm: 900, hMm: 2100 }], []);
    const payload = buildCustomMarkRegistrationPayload("proj-1", mark);
    expect(payload.spec.unit_kind).toBe("door");
    expect(payload.spec.door_kind).toBe("other");
  });
});
