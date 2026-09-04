import { describe, expect, it } from "vitest";
import {
  changedPunchFields,
  editPushBody,
  joinPlainList,
} from "./timecardNotice";

const BASE = {
  clock_in_at: "2026-09-02T14:00:00.000Z",
  clock_out_at: "2026-09-02T23:00:00.000Z",
  break_seconds: 1800,
  project_id: "job-1",
  cost_code_id: "code-1",
};

describe("changedPunchFields", () => {
  it("names nothing when nothing moved", () => {
    expect(changedPunchFields(BASE, { ...BASE })).toEqual([]);
  });

  it("names each field in the order a punch reads", () => {
    expect(
      changedPunchFields(BASE, {
        ...BASE,
        clock_in_at: "2026-09-02T13:00:00.000Z",
        break_seconds: 0,
        cost_code_id: "code-2",
      }),
    ).toEqual(["start time", "break", "cost code"]);
  });

  it("treats null and undefined as the same absence", () => {
    expect(
      changedPunchFields(
        { ...BASE, clock_out_at: null },
        { ...BASE, clock_out_at: undefined },
      ),
    ).toEqual([]);
    // A missing break and a zero break are the same number of minutes.
    expect(
      changedPunchFields({ ...BASE, break_seconds: undefined }, { ...BASE, break_seconds: 0 }),
    ).toEqual([]);
  });

  it("notices a punch being closed out", () => {
    expect(
      changedPunchFields({ ...BASE, clock_out_at: null }, BASE),
    ).toEqual(["finish time"]);
  });
});

describe("joinPlainList", () => {
  it("reads like a sentence, not an array", () => {
    expect(joinPlainList([])).toBe("");
    expect(joinPlainList(["break"])).toBe("break");
    expect(joinPlainList(["start time", "break"])).toBe("start time and break");
    expect(joinPlainList(["start time", "finish time", "job"])).toBe(
      "start time, finish time and job",
    );
  });
});

describe("editPushBody", () => {
  it("says what moved", () => {
    expect(editPushBody(["start time"], "submitted", "submitted")).toBe(
      "The start time on one of your punches changed. Check My timecard.",
    );
  });

  it("never claims re-approval is needed on a punch the server kept approved", () => {
    // edit_shift re-approves in the same statement whenever the editor could
    // approve, and every role that can reach it can. This is the real case, and
    // the old copy told the worker to chase an approval nobody was waiting on.
    expect(editPushBody(["break"], "approved", "approved")).toBe(
      "The break on one of your punches changed. It's still marked approved.",
    );
  });

  it("asks for re-approval only when the punch actually lost it", () => {
    expect(editPushBody(["break"], "approved", "submitted")).toContain(
      "needs approving again",
    );
  });

  it("says nothing about approval for a punch that was never approved", () => {
    expect(editPushBody(["break"], "submitted", "submitted")).not.toContain(
      "approv",
    );
    expect(editPushBody(["break"], null, "submitted")).not.toContain("approv");
  });

  it("stays honest when it cannot name the change", () => {
    expect(editPushBody([], "open", "submitted")).toBe(
      "Something on one of your punches changed. Check My timecard.",
    );
  });
});
