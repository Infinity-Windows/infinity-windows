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
  rotation?: { y: number };
  metadata?: {
    itemName?: string;
    unitConfig?: {
      heightMm?: number;
      panels?: { widthMm: number }[];
      kind?: string;
      cornerAfterPanel?: number | null;
    };
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

/**
 * infinity (W3, w-walls-spec.md, 2026-08-31): every wall edge outerPolygons'
 * boundary walk did NOT consume — an interior partition sharing corners with
 * the exterior loop, or a free-standing wall too small to loop at all
 * (outerPolygons drops components under 3 nodes outright, silently, by
 * design). Reruns the identical point-keying outerPolygons itself uses, so
 * "consumed" can never disagree with what actually became the silhouette —
 * outerPolygons is called here UNCHANGED, and its output isn't touched.
 */
export function interiorSegments(
  walls: StudioWallLike[],
): { a: Pt; b: Pt; heightM: number }[] {
  const consumed = new Set<string>();
  for (const { poly } of outerPolygons(walls)) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      consumed.add(`${key(a)}>${key(b)}`);
      consumed.add(`${key(b)}>${key(a)}`);
    }
  }
  const out: { a: Pt; b: Pt; heightM: number }[] = [];
  for (const w of walls) {
    const a: Pt = { x: w.getStartX() * CM_TO_M, z: w.getStartY() * CM_TO_M };
    const b: Pt = { x: w.getEndX() * CM_TO_M, z: w.getEndY() * CM_TO_M };
    if (Math.hypot(a.x - b.x, a.z - b.z) < EPS_M) continue;
    if (consumed.has(`${key(a)}>${key(b)}`) || consumed.has(`${key(b)}>${key(a)}`)) continue;
    out.push({ a, b, heightM: w.height * CM_TO_M });
  }
  return out;
}

/** Outer boundary per connected wall component, leftmost-turn walk. */
export function outerPolygons(walls: StudioWallLike[]): { poly: Pt[]; heightM: number }[] {
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

/** One floor's live or parsed content, ground floor first. */
export interface PublishFloor {
  walls: StudioWallLike[];
  items: SceneItemLike[];
}

/**
 * infinity (Studio 100x #49): PublishFloor deliberately carries no roof
 * flag. The Studio building-wide Roof toggle (floors.ts's RoofStyle,
 * rendered by roofShell.ts) is a Studio/viewer-only decoration — the
 * interactive map draws its own roofs (fitviewRenderer.ts's "flatroof"),
 * so a Publish here is expected to leave the map's roof exactly as it was,
 * not import the Studio's choice.
 */
export function buildFitviewModelFromStudio(
  floors: PublishFloor[],
  sizeByName: Map<string, { wMm: number; hMm: number; type?: string }>,
): { model: Record<string, unknown>; stats: PublishStats } | null {
  // Every floor stacks on the tallest walls of the floors below it; an
  // empty floor still lifts the ones above by a default storey.
  const DEFAULT_FLOOR_M = 2.5;

  interface Story {
    n: number;
    elevM: number;
    heightM: number;
    footprints: { x: number; z: number }[][];
  }
  const stories: Story[] = [];
  const edges: (Edge & { floor: number })[] = [];
  // infinity (W3, w-walls-spec.md, 2026-08-31): interior partitions and
  // free-standing walls, carried as additional labeled wall strips rather
  // than dropped. Populated per floor below, appended to `windows`' sibling
  // array on the finished model AFTER the exterior loop is fully built —
  // never mixed into `edges`, so the exterior silhouette/story computation
  // above is completely untouched by their presence.
  const interiorWalls: Record<string, unknown>[] = [];
  // infinity (W3): same order as `interiorWalls` above — kept as real Edge
  // shapes purely so a placed unit can be matched onto an interior wall too
  // ("carries units", the acceptance bar). Spliced onto the end of `edges`
  // AFTER the floor loop finishes, once `edges.length` is final — mirroring
  // exactly how elevationsOf (fitviewRenderer.ts) will independently walk
  // stories→footprints first and only then building.interiorWalls, so the
  // "sN" key a window stores here can never disagree with the key the
  // renderer assigns that same wall.
  const interiorEdges: (Edge & { floor: number })[] = [];
  let interiorCount = 0;
  let elevAcc = 0;
  let anyMass = false;

  floors.forEach((floor, fi) => {
    const masses = outerPolygons(floor.walls);
    const floorElev = elevAcc;
    const maxWall = floor.walls.reduce(
      (h, w) => Math.max(h, w.height * CM_TO_M),
      0,
    );
    elevAcc += maxWall || DEFAULT_FLOOR_M;
    if (masses.length === 0) return;
    anyMass = true;

    // Story bands from distinct mass heights WITHIN the floor (rounded to
    // cm so float noise doesn't mint phantom stories), lifted to the
    // floor's own elevation.
    const distinct = [...new Set(masses.map((m) => Math.round(m.heightM * 100)))]
      .sort((a, b) => a - b)
      .map((v) => v / 100);
    // infinity (W3): the story an interior wall on this floor reports as —
    // its own base story, since a partition runs floor-to-ceiling for ITS
    // floor rather than stacking with a wing's own taller band the way the
    // exterior masses do.
    const floorBaseStoryN = stories.length + 1;
    for (let i = 0; i < distinct.length; i++) {
      const top = distinct[i];
      const bottom = i === 0 ? 0 : distinct[i - 1];
      const st: Story = {
        n: stories.length + 1,
        elevM: floorElev + bottom,
        heightM: top - bottom,
        footprints: masses
          .filter((m) => m.heightM >= top - EPS_M)
          .map((m) => m.poly.map((p) => ({ x: p.x, z: p.z }))),
      };
      stories.push(st);
      // Edge enumeration mirroring elevationsOf: stories bottom-up →
      // footprints → ring edges, one continuous counter.
      for (const fp of st.footprints) {
        for (let j = 0; j < fp.length; j++) {
          const a = fp[j];
          const b = fp[(j + 1) % fp.length];
          edges.push({
            a,
            b,
            len: Math.hypot(b.x - a.x, b.z - a.z),
            story: st.n,
            elevM: st.elevM,
            floor: fi,
          });
        }
      }
    }

    // infinity (W3): interior partitions and free-standing walls on this
    // floor, published as their own labeled wall strips — the crew map's
    // acceptance bar is "just another wall." Both faces of an interior wall
    // are physically real, but this publishes ONE strip per interior wall
    // (units on either face render on that strip) — the simplest honest
    // model, called out in the PR body. A floor with no exterior mass at
    // all (the `masses.length === 0` return above) has no story to anchor
    // these to, so it carries none — an edge case, not a regression.
    for (const seg of interiorSegments(floor.walls)) {
      interiorCount += 1;
      interiorWalls.push({
        x1: seg.a.x,
        z1: seg.a.z,
        x2: seg.b.x,
        z2: seg.b.z,
        heightM: seg.heightM,
        elevM: floorElev,
        story: floorBaseStoryN,
        name: `Interior ${interiorCount}`,
        interior: true,
      });
      interiorEdges.push({
        a: seg.a,
        b: seg.b,
        len: Math.hypot(seg.b.x - seg.a.x, seg.b.z - seg.a.z),
        story: floorBaseStoryN,
        elevM: floorElev,
        floor: fi,
      });
    }
  });
  if (!anyMass) return null;

  // infinity (W3): interior walls are candidates for window-matching too,
  // positioned after every exterior edge — see interiorEdges' comment above.
  const matchEdges = [...edges, ...interiorEdges];

  const floorElevs: number[] = [];
  {
    let acc = 0;
    for (const floor of floors) {
      floorElevs.push(acc);
      const maxWall = floor.walls.reduce(
        (h, w) => Math.max(h, w.height * CM_TO_M),
        0,
      );
      acc += maxWall || DEFAULT_FLOOR_M;
    }
  }

  const windows: Record<string, unknown>[] = [];
  let skipped = 0;
  const matchItems = (items: SceneItemLike[], fi: number) => {
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
    // Items are edited floor-relative (each floor sits at y=0 in the
    // vendor); the floor's elevation makes their height absolute, and only
    // the item's own floor's edges are candidates.
    const centreM = item.position.y * CM_TO_M + floorElevs[fi];
    let bestIdx = -1;
    let bestD = Infinity;
    let bestT = 0;
    // infinity (W3): matchEdges = exterior edges + interior walls, in that
    // order — see matchEdges' own comment. A unit placed near an interior
    // partition now finds it exactly like any exterior wall.
    matchEdges.forEach((e, i) => {
      if (e.floor !== fi) return;
      const { d, t } = distToSegment(p, e.a, e.b);
      // Prefer the story band the item's height actually sits in.
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
    const e = matchEdges[bestIdx];
    const sillM = Math.max(0, centreM - (size.hMm / 1000) / 2 - e.elevM);
    // A 90° corner unit publishes the legs + wrap the map renderer already
    // walks wall-to-wall (leg 0 on the anchored wall). The longer leg is
    // the anchored one — mirror of cornerGeometryInfo in the Studio.
    const k = cfg?.cornerAfterPanel;
    let legFields: Record<string, unknown> = {};
    if (
      cfg?.panels?.length &&
      k != null &&
      k >= 0 &&
      k < cfg.panels.length - 1
    ) {
      const leftMm = cfg.panels.slice(0, k + 1).reduce((t, p) => t + p.widthMm, 0);
      const rightMm = cfg.panels.slice(k + 1).reduce((t, p) => t + p.widthMm, 0);
      const mainMm = Math.max(leftMm, rightMm);
      const wrapMm = Math.min(leftMm, rightMm);
      // Which end of the edge the wrap turns at: project the wrap-side tip
      // of the main leg onto the edge and see which half it lands in.
      const sideSign = leftMm <= rightMm ? 1 : -1; // wrap at outside-left = local +x
      const ry = item.rotation?.y ?? 0;
      const tipX =
        item.position.x * CM_TO_M +
        sideSign * (mainMm / 2000) * Math.cos(ry);
      const tipZ =
        item.position.z * CM_TO_M +
        sideSign * (mainMm / 2000) * -Math.sin(ry);
      const tip = distToSegment({ x: tipX, z: tipZ }, e.a, e.b);
      legFields = {
        legs: [mainMm, wrapMm],
        wrap: tip.t > 0.5 ? "end" : "start",
      };
    }
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
      ...legFields,
    });
    }
  };
  floors.forEach((floor, fi) => matchItems(floor.items, fi));

  const all = stories.flatMap((st) => st.footprints.flat());
  const xs = all.map((p) => p.x);
  const zs = all.map((p) => p.z);
  const topM = stories.reduce((t, st) => Math.max(t, st.elevM + st.heightM), 0);
  const model = {
    building: {
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...zs) - Math.min(...zs),
      height: topM,
      rise: 0,
      footprints: stories[0].footprints,
      stories,
      // infinity (W3): additive-only — absent or empty on a building with no
      // interior/free-standing walls, which is exactly today's shape. See
      // interiorWalls' own comment above for what each entry carries.
      interiorWalls,
    },
    windows,
  };
  return {
    model,
    stats: {
      masses: stories[0].footprints.length,
      stories: stories.length,
      windows: windows.length,
      skippedWindows: skipped,
    },
  };
}
