// The map is data, so the map can be proved. These tests are the reason the
// geometry lives in packageFlow.ts instead of being scattered through JSX: an
// arrow pointing at a node that isn't drawn, or a node with no box, is a bug
// you can only see by squinting at a picture — unless it's a failing test.

import { describe, expect, it } from "vitest";
import {
  CONTAINERS,
  EDGES,
  FLOW_ALT,
  FLOW_VIEWBOX,
  NODES,
  flowNode,
  type NodeId,
} from "./packageFlow";

const ids = new Set(NODES.map((n) => n.id));
const edgeIds = new Set(EDGES.map((e) => e.id));

describe("package flow nodes", () => {
  it("has no duplicate ids", () => {
    expect(ids.size).toBe(NODES.length);
  });

  it("draws every node inside the viewBox", () => {
    const bottom = FLOW_VIEWBOX.minY + FLOW_VIEWBOX.h;
    for (const n of NODES) {
      expect(n.x, `${n.id} starts left of the canvas`).toBeGreaterThanOrEqual(0);
      expect(n.y, `${n.id} is cropped off the top`).toBeGreaterThanOrEqual(FLOW_VIEWBOX.minY);
      expect(n.x + n.w, `${n.id} runs off the right edge`).toBeLessThanOrEqual(FLOW_VIEWBOX.w);
      expect(n.y + n.h, `${n.id} runs off the bottom edge`).toBeLessThanOrEqual(bottom);
    }
  });

  it("never overlaps two boxes", () => {
    for (let i = 0; i < NODES.length; i++) {
      for (let j = i + 1; j < NODES.length; j++) {
        const a = NODES[i];
        const b = NODES[j];
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    }
  });

  it("gives every node the three things a reader needs", () => {
    for (const n of NODES) {
      expect(n.label, `${n.id} has no label`).toBeTruthy();
      expect(n.who, `${n.id} does not say who does it`).toBeTruthy();
      expect(n.asks, `${n.id} does not say what the app asks for`).toBeTruthy();
      expect(n.wrong, `${n.id} does not say what goes wrong`).toBeTruthy();
    }
  });

  it("keeps boxes from being crowded — at most two small lines", () => {
    for (const n of NODES) {
      expect((n.lines ?? []).length, `${n.id} has too many lines to fit`).toBeLessThanOrEqual(2);
    }
  });
});

describe("package flow edges", () => {
  it("joins two nodes that are actually drawn", () => {
    for (const e of EDGES) {
      expect(ids.has(e.from), `edge ${e.id} starts at unknown node ${e.from}`).toBe(true);
      expect(ids.has(e.to), `edge ${e.id} ends at unknown node ${e.to}`).toBe(true);
    }
  });

  it("has no duplicate ids", () => {
    expect(edgeIds.size).toBe(EDGES.length);
  });

  it("puts a label where a label was promised", () => {
    for (const e of EDGES) {
      if (!e.label) continue;
      expect(e.labelX, `edge ${e.id} has a label with no x`).toBeTypeOf("number");
      expect(e.labelY, `edge ${e.id} has a label with no y`).toBeTypeOf("number");
    }
  });
});

describe("highlighting", () => {
  it("only ever lights up nodes that exist", () => {
    for (const n of NODES) {
      for (const r of n.related) {
        expect(ids.has(r), `${n.id} lights up unknown node ${r}`).toBe(true);
      }
    }
  });

  it("only ever lights up edges that exist", () => {
    for (const n of NODES) {
      for (const e of n.edges) {
        expect(edgeIds.has(e), `${n.id} lights up unknown edge ${e}`).toBe(true);
      }
    }
  });

  it("lights up an edge only when both its ends are lit", () => {
    // Otherwise an arrow glows into the dark, pointing at a dimmed box.
    for (const n of NODES) {
      const lit = new Set<NodeId>([n.id, ...n.related]);
      for (const id of n.edges) {
        const edge = EDGES.find((e) => e.id === id)!;
        expect(lit.has(edge.from), `${n.id} lights edge ${id} but not ${edge.from}`).toBe(true);
        expect(lit.has(edge.to), `${n.id} lights edge ${id} but not ${edge.to}`).toBe(true);
      }
    }
  });

  it("is mutual — if A lights B, B lights A", () => {
    // A one-way relationship reads as a bug to anyone hovering both ends.
    for (const n of NODES) {
      for (const r of n.related) {
        expect(
          flowNode(r)!.related.includes(n.id),
          `${n.id} lights ${r}, but ${r} does not light ${n.id}`,
        ).toBe(true);
      }
    }
  });

  it("reaches every stuck state from the step it comes from", () => {
    const stuck = NODES.filter((n) => n.stuck);
    expect(stuck.length).toBeGreaterThan(0);
    for (const s of stuck) {
      const feeders = EDGES.filter((e) => e.to === s.id);
      expect(feeders.length, `${s.id} is drawn but nothing leads to it`).toBeGreaterThan(0);
    }
  });
});

/**
 * The map is the app explaining itself, so a sentence on it that the code does
 * not back is a lie with a diagram attached. Each of these froze a claim that
 * was wrong on 2026-08-17, against the migration that settles it.
 */
describe("the map only claims what the code does", () => {
  it("promises a damage photo now that arrival capture takes one (ticket 11)", () => {
    // 20260922000000_damage_photo.sql: issues.photo_path exists and the
    // Damaged button opens PhotoCaptureSheet mode="single".
    expect(flowNode("damaged")!.asks.toLowerCase()).toContain("photo");
  });

  it("does not claim a foreman gate on tagging — bind_package has no role check", () => {
    // 20260825000000: bind_package only refuses `auth.uid() is null`, and
    // /storage/tag carries no RequireRole. Any installer can tag.
    expect(flowNode("tagged")!.who.toLowerCase()).not.toContain("foreman");
  });

  it("keeps the foreman gate on printing, which IS real", () => {
    // 20260814000000: mint_packages reads profiles.role and refuses installers.
    // Guards against fixing the tagging line by scrubbing the wrong node.
    expect(flowNode("stickers")!.who.toLowerCase()).toContain("foreman");
  });

  it("does not draw a shelf as a peer of conex and crate", () => {
    // packages_one_place_ck: a package is in a container OR at a shelf spot,
    // never both — and only stage_packages ever writes the shelf, always for
    // one named job. A bare "Shelf" chip implies a putaway that does not exist.
    const shelf = CONTAINERS.find((c) => c.toLowerCase().startsWith("shelf"));
    expect(shelf, "the stored box no longer names a shelf at all").toBeTruthy();
    expect(shelf).not.toBe("Shelf");
    expect(shelf!.toLowerCase()).toMatch(/job/);
  });

  it("says the same thing to a reader who cannot see the picture", () => {
    // The alt text listed conex, crate and shelf as three ways to store —
    // same false parity, and it is the only version a screen reader gets.
    expect(FLOW_ALT.toLowerCase()).not.toMatch(/crate or on a shelf/);
    expect(FLOW_ALT.toLowerCase()).toMatch(/set aside/);
  });
});
