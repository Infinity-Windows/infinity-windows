import { describe, expect, it } from "vitest";
import {
  buildNoticeRows,
  noticeDateLabel,
  noticeFingerprintTokens,
  noticeHoursLabel,
  revisionById,
  type NoticeAssignment,
} from "./notices";

const STRINGS = { notSet: "not set", checkTime: "check time", noHoursSet: "Start/end not set", job: "Job", delivery: "Delivery" };

function assignment(overrides: Partial<NoticeAssignment> = {}): NoticeAssignment {
  return {
    id: "a1",
    start_date: "2026-10-01",
    end_date: "2026-10-01",
    start_time: "08:00",
    end_time: "16:00",
    kind: "install",
    project: { job_code: "J1", name: "Acme" },
    ...overrides,
  };
}

describe("noticeFingerprintTokens", () => {
  it("corrupt cached revisions cannot invent an occurrence", () => {
    for (const revision of [-1, 1.5, Infinity, NaN]) {
      expect(noticeFingerprintTokens(["a"], new Map([["a", revision]]))).toEqual(["a"]);
    }
  });
  it("keeps the exact legacy bare-id sequence, duplicates included, when every revision is 0 or missing", () => {
    const ids = ["b", "a", "a"]; // duplicate id: a leave-split segment
    const revisions = new Map([["a", 0], ["b", undefined]]);
    expect(noticeFingerprintTokens(ids, revisions)).toEqual(["b", "a", "a"]);
  });

  it("turns only the positively-revised ids into id:revision tokens", () => {
    const ids = ["a", "b", "a"];
    const revisions = new Map([["a", 3], ["b", 0]]);
    expect(noticeFingerprintTokens(ids, revisions)).toEqual(["a:3", "b", "a:3"]);
  });

  it("a distinct A->B->A occurrence (two bumps) still differs from the single-bump token", () => {
    const first = noticeFingerprintTokens(["a"], new Map([["a", 1]]));
    const second = noticeFingerprintTokens(["a"], new Map([["a", 2]]));
    expect(first).not.toEqual(second);
  });
});

describe("revisionById", () => {
  it("indexes by assignment id, preserving a missing revision as undefined", () => {
    const map = revisionById([assignment({ id: "x", notice_revision: 2 }), assignment({ id: "y" })]);
    expect(map.get("x")).toBe(2);
    expect(map.get("y")).toBeUndefined();
    expect(map.has("z")).toBe(false);
  });
});

describe("noticeDateLabel", () => {
  it("a single day shows once", () => {
    expect(noticeDateLabel({ start_date: "2026-10-01", end_date: "2026-10-01" }, "en")).toBe("Oct 1");
  });
  it("a range shows both ends", () => {
    expect(noticeDateLabel({ start_date: "2026-10-01", end_date: "2026-10-03" }, "en")).toBe("Oct 1–Oct 3");
  });
});

describe("noticeHoursLabel", () => {
  it("formats known hours in the viewer's language", () => {
    expect(noticeHoursLabel({ start_time: "08:00", end_time: "16:00" }, "en", STRINGS)).toMatch(/8:00.*4:00/);
  });
  it("is honest when neither time is set", () => {
    expect(noticeHoursLabel({ start_time: null, end_time: null }, "en", STRINGS)).toBe("Start/end not set");
  });
  it("tells a present-but-malformed time apart from genuinely not set", () => {
    expect(noticeHoursLabel({ start_time: "25:99", end_time: null }, "en", STRINGS)).toBe("check time–not set");
  });
});

describe("buildNoticeRows", () => {
  it("missing job and delivery labels use the supplied language", () => {
    const strings = { ...STRINGS, job: "Trabajo", delivery: "Entrega" };
    const { rows } = buildNoticeRows([assignment({ project: null }), assignment({ id: "d", kind: "delivery", delivery: null })], "es", strings);
    expect(rows[0].line).toContain("Trabajo");
    expect(rows[1].line).toContain("Entrega");
  });
  it("de-dupes a time-off split only when id AND dates AND hours all match, never hiding a distinct segment", () => {
    const rows = buildNoticeRows(
      [
        assignment({ id: "a1", start_date: "2026-10-01", end_date: "2026-10-01" }),
        assignment({ id: "a1", start_date: "2026-10-01", end_date: "2026-10-01" }), // exact duplicate
        assignment({ id: "a1", start_date: "2026-10-05", end_date: "2026-10-05" }), // distinct segment, same id
      ],
      "en",
      STRINGS,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].line).toMatch(/^J1 · Acme · Oct 1 · 8:00\s?AM–4:00\s?PM$/);
    expect(rows.rows[1].line).toMatch(/^J1 · Acme · Oct 5 · 8:00\s?AM–4:00\s?PM$/);
    expect(rows.omitted).toBe(0);
  });

  it("sorts by date and caps with an honest omitted count", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      assignment({ id: `a${i}`, start_date: `2026-10-0${i + 1}`, end_date: `2026-10-0${i + 1}` }),
    ).reverse();
    const { rows, omitted } = buildNoticeRows(many, "en", STRINGS, 5);
    expect(rows).toHaveLength(5);
    expect(rows[0].line).toContain("Oct 1");
    expect(omitted).toBe(2);
  });

  it("labels a delivery by its own label, not a project code", () => {
    const { rows } = buildNoticeRows(
      [assignment({ id: "d1", kind: "delivery", project: null, delivery: { label: "Truck 4" } })],
      "en",
      STRINGS,
    );
    expect(rows[0].line).toContain("Truck 4");
  });
});
