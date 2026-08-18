import { describe, expect, it } from "vitest";
import {
  canAccess,
  flowDoors,
  layoutRoleFlow,
  ROLE_FLOW_W,
  ROLE_FLOWS,
} from "./roleFlow";

describe.each(ROLE_FLOWS.map((f) => [f.title, f] as const))("%s", (_t, flow) => {
  const { nodes, edges, viewBox } = layoutRoleFlow(flow);

  it("names only doors its role can actually open — the map never lies", () => {
    // The whole point (owner, 2026-08-18): "it will let them know what the
    // extent of what they can do is". A door above the role's floor here
    // would teach people the map lies.
    for (const door of flowDoors(flow)) {
      expect(canAccess(flow.role, door), `${flow.role} cannot open ${door}`).toBe(true);
    }
  });

  it("every stage but narrative ones opens at least one real door", () => {
    for (const row of flow.rows) {
      for (const n of row) {
        if (n.id === "outside") continue; // the one honest exception
        expect(n.doors.length, `${n.id} opens nothing`).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate ids", () => {
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("draws every box inside the frame", () => {
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(ROLE_FLOW_W);
      expect(n.y + n.h).toBeLessThanOrEqual(viewBox.h);
    }
  });

  it("never overlaps two boxes", () => {
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.id === b.id) continue;
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("keeps boxes readable — at most two small lines", () => {
    for (const n of nodes) {
      expect((n.lines ?? []).length).toBeLessThanOrEqual(2);
    }
  });

  it("joins only boxes that are drawn", () => {
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});
