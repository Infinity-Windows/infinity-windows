import { describe, expect, it } from "vitest";
import { snapWallAngle, WALL_ANGLE_SNAP_TOLERANCE_DEG } from "./wallAngleSnap";

const CORNER = { x: 100, y: 100 };
const REF = { x: 0, y: 100 }; // wall runs along -X from the corner

/** Candidate at `deg` measured from the reference direction, `len` away. */
function candidateAt(deg: number, len = 400): { x: number; y: number } {
  const refAngle = Math.atan2(REF.y - CORNER.y, REF.x - CORNER.x);
  const rad = refAngle + (deg * Math.PI) / 180;
  return { x: CORNER.x + Math.cos(rad) * len, y: CORNER.y + Math.sin(rad) * len };
}

describe("snapWallAngle — square/straight, 5° in/out", () => {
  it("snaps exactly at 90° (already square)", () => {
    const out = snapWallAngle(CORNER, REF, candidateAt(90));
    expect(out.x).toBeCloseTo(CORNER.x, 6);
    expect(out.y).toBeCloseTo(CORNER.y - 400, 6);
  });

  it("snaps a candidate 4° off square (within the 5° tolerance)", () => {
    const out = snapWallAngle(CORNER, REF, candidateAt(94));
    expect(out.x).toBeCloseTo(CORNER.x, 6);
    expect(out.y).toBeCloseTo(CORNER.y - 400, 6);
  });

  it("snaps a candidate 4° off straight (180°) the other direction too", () => {
    const out = snapWallAngle(CORNER, REF, candidateAt(184));
    // 180° from a reference pointing at -X is +X.
    expect(out.x).toBeCloseTo(CORNER.x + 400, 6);
    expect(out.y).toBeCloseTo(CORNER.y, 6);
  });

  it("snaps -90° (the other square turn) too", () => {
    const out = snapWallAngle(CORNER, REF, candidateAt(-88));
    expect(out.x).toBeCloseTo(CORNER.x, 6);
    expect(out.y).toBeCloseTo(CORNER.y + 400, 6);
  });

  it("does NOT snap at 6° off — outside the 5° tolerance", () => {
    const candidate = candidateAt(96);
    const out = snapWallAngle(CORNER, REF, candidate);
    expect(out).toEqual(candidate);
  });

  it("does NOT snap at exactly the boundary + epsilon", () => {
    const candidate = candidateAt(90 + WALL_ANGLE_SNAP_TOLERANCE_DEG + 0.5);
    const out = snapWallAngle(CORNER, REF, candidate);
    expect(out).toEqual(candidate);
  });

  it("preserves the dragged length exactly, only the angle moves", () => {
    const out = snapWallAngle(CORNER, REF, candidateAt(93, 733));
    expect(Math.hypot(out.x - CORNER.x, out.y - CORNER.y)).toBeCloseTo(733, 6);
  });

  it("a custom tolerance is honored", () => {
    const candidate = candidateAt(93);
    expect(snapWallAngle(CORNER, REF, candidate, 2)).toEqual(candidate);
    const snapped = snapWallAngle(CORNER, REF, candidate, 4);
    expect(snapped).not.toEqual(candidate);
  });
});

describe("snapWallAngle — first/disconnected wall snaps to global axes", () => {
  it("null reference snaps a near-horizontal candidate flat", () => {
    const candidate = { x: CORNER.x + 400, y: CORNER.y + 3 }; // ~0.4° off horizontal
    const out = snapWallAngle(CORNER, null, candidate);
    expect(out.y).toBeCloseTo(CORNER.y, 6);
  });

  it("null reference snaps a near-vertical candidate plumb", () => {
    const candidate = { x: CORNER.x + 5, y: CORNER.y + 400 }; // within 5°
    const out = snapWallAngle(CORNER, null, candidate);
    expect(out.x).toBeCloseTo(CORNER.x, 6);
  });

  it("a diagonal candidate (45°) is left alone — not near any 90° multiple", () => {
    const candidate = { x: CORNER.x + 300, y: CORNER.y + 300 };
    const out = snapWallAngle(CORNER, null, candidate);
    expect(out).toEqual(candidate);
  });
});

describe("snapWallAngle — degenerate inputs never throw or invent a point", () => {
  it("a zero-length candidate is returned as-is", () => {
    const out = snapWallAngle(CORNER, REF, { ...CORNER });
    expect(out).toEqual(CORNER);
  });

  it("a zero-length reference (corner === reference) is returned as-is", () => {
    const candidate = candidateAt(90);
    const out = snapWallAngle(CORNER, { ...CORNER }, candidate);
    expect(out).toEqual(candidate);
  });
});
