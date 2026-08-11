import { describe, expect, it } from "vitest";
import { submitBlockers, submitBlockersLine } from "./submitGate";

describe("submitGate", () => {
  it("blocks until both the after photo and the grade are present", () => {
    expect(submitBlockers({ grade: null, hasAfterPhoto: false })).toEqual([
      "an after photo",
      "a quality grade",
    ]);
    expect(submitBlockers({ grade: 4, hasAfterPhoto: false })).toEqual([
      "an after photo",
    ]);
    expect(submitBlockers({ grade: null, hasAfterPhoto: true })).toEqual([
      "a quality grade",
    ]);
    expect(submitBlockers({ grade: 3, hasAfterPhoto: true })).toEqual([]);
  });

  it("phrases the disabled state as one sentence, silent when clear", () => {
    expect(submitBlockersLine({ grade: null, hasAfterPhoto: false })).toBe(
      "To submit, add an after photo and a quality grade.",
    );
    expect(submitBlockersLine({ grade: 1, hasAfterPhoto: true })).toBeNull();
  });

  it("grade 0 would be a lie, not a rating - undefined and null both block", () => {
    expect(submitBlockers({ grade: undefined as unknown as null, hasAfterPhoto: true }))
      .toEqual(["a quality grade"]);
  });
});
