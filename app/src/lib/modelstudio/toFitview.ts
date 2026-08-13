// Publish: the Studio model becomes the crew map's authored fitview model
// (owner's workflow, 2026-08-13 — Studio authors, the interactive map is the
// themed clickable result). Pure conversion here; the page owns saving.
//
// Geometry: blueprint walls (cm) → footprint polygons (meters) via an
// outer-boundary walk per connected component, so interior partition walls
// never leak into the silhouette. Heights: distinct wall heights become
// story bands — a 8ft wing under an 18ft middle emits story 1 (0–8ft, all
// masses) + story 2 (8–18ft, tall masses only), which is exactly the shape
// the per-story roof lids and elevation walks already consume. Windows:
// every placed item lands wall-relative ("sN" edge keys mirroring
// elevationsOf's enumeration: stories bottom-up → footprints → ring edges).

const CM_TO_M = 0.01;
const EPS_M = 0.02;

interface Pt {
  x: number;
  z: number;
}

interface StudioWallLike {
  height: number; // cm
  getStartX(): number;
  getStartY(): number;
  getEndX(): number;
  getEndY(): number;
}

interface SceneItemLike {
  position: { x: number; y: number; z: number }; // cm, y = centre height
  metadata?: {
    itemName?: string;
    unitConfig?: { heightMm?: number; panels?: { widthMm: number }[]; kind?: string };
  };
}

export interface PublishStats {
  masses: number;
  stories: number;
  windows: number;
  skippedWindows: number;
}

interface Edge {
  a: Pt;
  b: Pt;
  len: number;
  story: number; // 1-based story band
  elevM: number;
}

function key(p: Pt): string {
  return `${p.x.toFixed(3)}|${p.z.toFixed(3)}`;
}

/** Outer boundary per connected wall component, leftmost-turn walk. */
function outerPolygons(walls: StudioWallLike[]): { poly: Pt[]; heightM: number }[] {
  type Node = { p: Pt; nbrs: { to: string; heightM: number }[] };
  const nodes = new Map<string, Node>();
  const add = (p: Pt) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { p, nbrs: [] });
    return k;
  };
  for (const w of walls) {
    const a: Pt = { x: w.getStartX() * CM_TO_M, z: w.getStartY() * CM_TO_M };
    const b: Pt = { x: w.getEndX() * CM_TO_M, z: w.getEndY() * CM_TO_M };
    if (Math.hypot(a.x - b.x, a.z - b.z) < EPS_M) continue;
    const ka = add(a);
    const kb = add(b);
    const h = w.height * CM_TO_M;
    nodes.get(ka)!.nbrs.push({ to: kb, heightM: h });
    nodes.get(kb)!.nbrs.push({ to: ka, heightM: h });
  }

  // Connected components.
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const k0 of nodes.keys()) {
    if (seen.has(k0)) continue;
    const comp: string[] = [];
    const stack = [k0];
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      comp.push(k);
      for (const n of nodes.get(k)!.nbrs) stack.push(n.to);
    }
    components.push(comp);
  }

  const out: { poly: Pt[]; heightM: number }[] = [];
  for (const comp of components) {
    if (comp.length < 3) continue;
    // Start at the lowest-x (then lowest-z) node — guaranteed on the hull.
    const startK = comp.reduce((best, k) => {
      const p = nodes.get(k)!.p;
      const q = nodes.get(best)!.p;
      return p.x < q.x - 1e-9 || (Math.abs(p.x - q.x) < 1e-9 && p.z < q.z) ? k : best;
    });
    // Walk keeping the exterior on the left: at each node pick the most
    // counter-clockwise neighbour relative to where we came from.
    const poly: Pt[] = [];
    const heights: number[] = [];
    let prevK: string | null = null;
    let curK = startK;
    for (let guard = 0; guard < comp.length * 4 + 8; guard++) {
      const cur = nodes.get(curK)!;
      poly.push(cur.p);
      const backAngle = prevK
        ? Math.atan2(
            nodes.get(prevK)!.p.z - cur.p.z,
            nodes.get(prevK)!.p.x - cur.p.x,
          )
        : Math.PI / 2; // pretend we arrived from below on the first step
      let best: { to: string; heightM: number } | null = null;
      let bestTurn = Infinity;
      for (const n of cur.nbrs) {
        if (n.to === prevK && cur.nbrs.length > 1) continue;
        const p2 = nodes.get(n.to)!.p;
        const ang = Math.atan2(p2.z - cur.p.z, p2.x - cur.p.x);
        // Clockwise turn from the reversed incoming direction.
        let turn = backAngle - ang;
        while (turn <= 0) turn += Math.PI * 2;
        while (turn > Math.PI * 2) turn -= Math.PI * 2;
        if (turn < bestTurn) {
          bestTurn = turn;
          best = n;
        }
      }
      if (!best) break;
      heights.push(best.heightM);
      prevK = curK;
      curK = best.to;
      if (curK === startK) break;
    }
    if (poly.length >= 3) {
      // Median wall height represents the mass.
      const hs = [...heights].sort((a, b) => a - b);
      out.push({ poly, heightM: hs[Math.floor(hs.length / 2)] ?? 2.5 });
    }
  }
  return out;
}

function distToSegment(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1e-9;
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx;
  const pz = a.z + t * dz;
  return { d: Math.hypot(p.x - px, p.z - pz), t };
}

export function buildFitviewModelFromStudio(
  walls: StudioWallLike[],
  items: SceneItemLike[],
  sizeByName: Map<string, { wMm: number; hMm: number; type?: string }>,
): { model: Record<string, unknown>; stats: PublishStats } | null {
  const masses = outerPolygons(walls);
  if (masses.length === 0) return null;

  // Story bands from distinct mass heights (rounded to cm so float noise
  // doesn't mint phantom stories).
  const distinct = [...new Set(masses.map((m) => Math.round(m.heightM * 100)))]
    .sort((a, b) => a - b)
    .map((v) => v / 100);
  const stories = distinct.map((top, i) => {
    const bottom = i === 0 ? 0 : distinct[i - 1];
    return {
      n: i + 1,
      elevM: bottom,
      heightM: top - bottom,
      footprints: masses
        .filter((m) => m.heightM >= top - EPS_M)
        .map((m) => m.poly.map((p) => ({ x: p.x, z: p.z }))),
    };
  });

  // Edge enumeration mirroring elevationsOf: stories bottom-up → footprints
  // → ring edges, one continuous counter.
  const edges: Edge[] = [];
  for (const st of stories) {
    for (const fp of st.footprints) {
      for (let i = 0; i < fp.length; i++) {
        const a = fp[i];
        const b = fp[(i + 1) % fp.length];
        edges.push({
          a,
          b,
          len: Math.hypot(b.x - a.x, b.z - a.z),
          story: st.n,
          elevM: st.elevM,
        });
      }
    }
  }

  const windows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const item of items) {
    const name = item.metadata?.itemName ?? "unit";
    const cfg = item.metadata?.unitConfig;
    const fromCatalog = cfg?.panels?.length
      ? {
          wMm: cfg.panels.reduce((t, p) => t + p.widthMm, 0),
          hMm: cfg.heightMm ?? 1524,
          type: cfg.kind === "door" ? "Door" : "Window",
        }
      : null;
    const size = fromCatalog ?? sizeByName.get(name) ?? { wMm: 914, hMm: 1524 };
    const p: Pt = { x: item.position.x * CM_TO_M, z: item.position.z * CM_TO_M };
    let bestIdx = -1;
    let bestD = Infinity;
    let bestT = 0;
    edges.forEach((e, i) => {
      const { d, t } = distToSegment(p, e.a, e.b);
      // Prefer the story band the item's height actually sits in.
      const centreM = item.position.y * CM_TO_M;
      const inBand = centreM >= e.elevM - EPS_M;
      const score = d + (inBand ? 0 : 100);
      if (score < bestD) {
        bestD = score;
        bestIdx = i;
        bestT = t;
      }
    });
    if (bestIdx < 0 || bestD > 1.5) {
      skipped += 1;
      continue; // not near any wall — don't invent a placement
    }
    const e = edges[bestIdx];
    const sillM = Math.max(
      0,
      item.position.y * CM_TO_M - (size.hMm / 1000) / 2 - e.elevM,
    );
    windows.push({
      id: name,
      elev: `s${bestIdx}`,
      story: e.story,
      floor: e.story === 1 ? "Ground" : `Level ${e.story}`,
      x: Math.max(0, bestT * e.len - size.wMm / 2000),
      y: sillM,
      w: size.wMm,
      h: size.hMm,
      type: size.type ?? "Window",
      status: "tofit",
    });
  }

  const all = masses.flatMap((m) => m.poly);
  const xs = all.map((p) => p.x);
  const zs = all.map((p) => p.z);
  const model = {
    building: {
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...zs) - Math.min(...zs),
      height: distinct[distinct.length - 1],
      rise: 0,
      footprints: stories[0].footprints,
      stories,
    },
    windows,
  };
  return {
    model,
    stats: {
      masses: masses.length,
      stories: stories.length,
      windows: windows.length,
      skippedWindows: skipped,
    },
  };
}
