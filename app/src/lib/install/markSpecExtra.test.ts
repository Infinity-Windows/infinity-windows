// The contract between the two spec-review fields and the atomic merge.
//
// `extra` is one jsonb blob shared by the size-code box and the Inset/Outset
// dropdown. Before merge_mark_spec_extra, each wrote the WHOLE blob from its
// own snapshot, so whichever saved second silently erased the other's key —
// and Inset/Outset feeds the signature a unit's cohort is keyed by, which
// nothing recomputes, so a dropped pick stayed dropped.
//
// The database now merges. What still has to be right on this side is WHICH
// keys each field claims, and that clearing a field REMOVES its key rather
// than writing null — the signature builder and hasAnySpec both read a
// present key as a value, so a null would read as "there is an answer".

import { describe, expect, it } from "vitest";

/** Exactly what the component sends for an Inset/Outset change. */
function insetOutsetCall(value: string): { patch: Record<string, unknown>; drop: string[] } {
  return value
    ? { patch: { inset_outset: value }, drop: [] }
    : { patch: {}, drop: ["inset_outset"] };
}

/** Exactly what it sends after judging a size code against the drawing. */
function sizeMismatchCall(
  mismatch: unknown,
): { patch: Record<string, unknown>; drop: string[] } {
  return mismatch
    ? { patch: { size_mismatch: mismatch }, drop: [] }
    : { patch: {}, drop: ["size_mismatch"] };
}

/** What the database does: shallow merge, then delete the named keys. */
function applyMerge(
  extra: Record<string, unknown>,
  call: { patch: Record<string, unknown>; drop: string[] },
): Record<string, unknown> {
  const out = { ...extra, ...call.patch };
  for (const k of call.drop) delete out[k];
  return out;
}

describe("each field claims only its own key", () => {
  it("setting Inset/Outset leaves a size mismatch alone", () => {
    const before = { size_mismatch: { code: "3050" }, printed_w: 30 };
    expect(applyMerge(before, insetOutsetCall("inset"))).toEqual({
      size_mismatch: { code: "3050" },
      printed_w: 30,
      inset_outset: "inset",
    });
  });

  it("recording a size mismatch leaves Inset/Outset alone", () => {
    const before = { inset_outset: "outset", printed_w: 30 };
    expect(applyMerge(before, sizeMismatchCall({ code: "3050" }))).toEqual({
      inset_outset: "outset",
      printed_w: 30,
      size_mismatch: { code: "3050" },
    });
  });

  it("the interleaving that used to lose work now keeps both", () => {
    // Size code fixed, then Inset/Outset picked before the first save landed.
    // Under the old whole-blob write the second save carried a pre-fix copy
    // and wiped the mismatch back out.
    let extra: Record<string, unknown> = { printed_w: 30 };
    extra = applyMerge(extra, sizeMismatchCall({ code: "3050" }));
    extra = applyMerge(extra, insetOutsetCall("inset"));
    expect(extra).toEqual({
      printed_w: 30,
      size_mismatch: { code: "3050" },
      inset_outset: "inset",
    });
  });
});

describe("clearing removes the key, never nulls it", () => {
  it("a blank Inset/Outset drops the key", () => {
    const after = applyMerge({ inset_outset: "inset", printed_w: 30 }, insetOutsetCall(""));
    expect("inset_outset" in after).toBe(false);
    expect(after).toEqual({ printed_w: 30 });
  });

  it("a resolved size mismatch drops the key", () => {
    const after = applyMerge(
      { size_mismatch: { code: "3050" }, inset_outset: "inset" },
      sizeMismatchCall(null),
    );
    expect("size_mismatch" in after).toBe(false);
    expect(after).toEqual({ inset_outset: "inset" });
  });

  it("clearing one field does not clear the other", () => {
    const after = applyMerge(
      { inset_outset: "inset", size_mismatch: { code: "3050" } },
      insetOutsetCall(""),
    );
    expect(after).toEqual({ size_mismatch: { code: "3050" } });
  });
});
