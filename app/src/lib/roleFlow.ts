// The role maps (owner ask, 2026-08-18): how each role runs a day, drawn in
// the package map's visual grammar. "It will let them know what the extent
// of what they can do is" — so the one rule this file lives by: every door a
// map names is a REAL registry route the role can open, and a test fails the
// build otherwise. A map that promises a locked door teaches people the map
// lies.
//
// Geometry is laid out, not hand-placed: rows top to bottom in day order,
// one to two boxes per row, so the no-overlap guarantee is by construction
// and still test-pinned like packageFlow's.

import { canAccess, NAV, type RoutePath } from "./nav";
import type { CrewRole } from "./install/types";

export interface DayNode {
  id: string;
  label: string;
  /** Small lines inside the box. Keep to two — a third crowds the box. */
  lines?: string[];
  /** What the app asks of you here. */
  asks: string;
  /** What goes wrong here, and why the rule is what it is. */
  wrong?: string;
  /** Real registry doors this stage opens. Empty only for narrative nodes. */
  doors: RoutePath[];
  /** Drawn quieter — a side path, not the main line of the day. */
  branch?: boolean;
}

export interface RoleFlow {
  role: CrewRole;
  title: string;
  lede: string;
  rows: DayNode[][];
}

/* ------------------------------------------------------------------ layout */

export interface PlacedNode extends DayNode {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlacedEdge {
  from: string;
  to: string;
  d: string;
  dashed?: boolean;
}

export const ROLE_FLOW_W = 720;
const NODE_H = 78;
const GAP_Y = 34;
const MARGIN = 16;
const GAP_X = 20;

/** Rows become boxes on a grid; consecutive rows join first-box to first-box,
 * and a row's extra boxes hang off its first with a dashed tie. */
export function layoutRoleFlow(flow: RoleFlow): {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  viewBox: { w: number; h: number };
} {
  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];
  let y = MARGIN;
  let prevMain: PlacedNode | null = null;

  for (const row of flow.rows) {
    const count = row.length;
    const w = (ROLE_FLOW_W - MARGIN * 2 - GAP_X * (count - 1)) / count;
    const placedRow: PlacedNode[] = row.map((n, i) => ({
      ...n,
      x: MARGIN + i * (w + GAP_X),
      y,
      w,
      h: NODE_H,
    }));
    nodes.push(...placedRow);
    const main = placedRow[0];
    for (const extra of placedRow.slice(1)) {
      edges.push({
        from: main.id,
        to: extra.id,
        d: `M ${main.x + main.w} ${main.y + NODE_H / 2} L ${extra.x} ${extra.y + NODE_H / 2}`,
        dashed: true,
      });
    }
    if (prevMain && main) {
      edges.push({
        from: prevMain.id,
        to: main.id,
        d: `M ${prevMain.x + prevMain.w / 2} ${prevMain.y + NODE_H} L ${main.x + main.w / 2} ${main.y}`,
      });
    }
    prevMain = main;
    y += NODE_H + GAP_Y;
  }

  return { nodes, edges, viewBox: { w: ROLE_FLOW_W, h: y - GAP_Y + MARGIN } };
}

/** The registry's own label for a door — the map never invents names. */
export function doorLabel(path: RoutePath): string {
  return NAV.find((d) => d.to === path)?.label ?? path;
}

/* ------------------------------------------------------------------- flows */

const INSTALLER: RoleFlow = {
  role: "installer",
  title: "How an installer runs a day",
  lede:
    "One loop, all day: clock in, take the window the app hands you, finish it, take the next. Everything else on this map serves that loop.",
  rows: [
    [
      {
        id: "clockin",
        label: "Clock in",
        lines: ["One tap. Lands on your", "recommended window."],
        asks: "Nothing else up front — the window's own gates (the talk, the before photo, flashing) live on its sheet, where they make sense.",
        wrong: "Working off the clock makes the day invisible — the estimate data, your hours, all of it. One tap is the whole ask.",
        doors: ["/clock"],
      },
    ],
    [
      {
        id: "talk",
        label: "The day's talk",
        lines: ["The toolbox talk rides", "the clock sheet."],
        asks: "Read it, tap it done. Weekends too — the rotation never skips a day you work.",
        doors: ["/toolbox-history"],
      },
    ],
    [
      {
        id: "window",
        label: "Your window",
        lines: ["Before photo, flashing check,", "the spec — then install."],
        asks: "Finish hands the clock to the next window. Block says why and moves on — blocked minutes are counted apart ON PURPOSE, so a missing part never reads as slow work.",
        wrong: "Pressing Redo is never punished here: any installer can, reason required, and the foreman is told — friction belongs on hiding problems, not admitting them.",
        doors: ["/projects", "/my-schedule"],
      },
      {
        id: "summon",
        label: "Heavy lift? Summon",
        lines: ["Call hands. Answering", "starts the helper's clock."],
        asks: "A four-man lift is real install cost — the helpers' minutes count toward the window, honestly.",
        doors: ["/projects"],
        branch: true,
      },
    ],
    [
      {
        id: "material",
        label: "Material",
        lines: ["Find anything. Tag at the truck.", "Check out with a reason."],
        asks: "Type a window number, a sticker code, a job or 'caulk' into Find and it answers. Taking a package tagged for another job warns and asks why — never blocks.",
        wrong: "A conex has no bars. Every warehouse write waits on your phone and goes up on its own — nobody walks outside to make the app happy.",
        doors: ["/warehouse", "/storage/tag", "/storage/out", "/takeoffs", "/supplies"],
      },
      {
        id: "photos",
        label: "Photos & receipts",
        lines: ["Job shots and", "fuel slips, one place."],
        asks: "The camera stamps what the office needs; receipts land on the job.",
        doors: ["/photos"],
        branch: true,
      },
    ],
    [
      {
        id: "problems",
        label: "When something's wrong",
        lines: ["Broken freight, a redo,", "a write that didn't send."],
        asks: "The arrival check raises a damage issue that names the package. Stuck writes is where a held write waits for a human — nothing is ever silently dropped.",
        doors: ["/storage/arrive", "/stuck"],
        branch: true,
      },
      {
        id: "growing",
        label: "Also yours",
        lines: ["Learn, points, safety,", "travel, Ask the AI."],
        asks: "The video library and fault-by-trade guides; points for the work you log; trips when a job travels.",
        doors: ["/learn", "/points", "/safety", "/travel", "/ask"],
        branch: true,
      },
    ],
    [
      {
        id: "clockout",
        label: "Clock out",
        lines: ["Anything unsent goes", "up on its own."],
        asks: "Your timecard shows the day punch by punch — what you see is what payroll sees.",
        doors: ["/clock", "/timecard"],
      },
    ],
  ],
};

const FOREMAN: RoleFlow = {
  role: "foreman",
  title: "How a foreman runs a day",
  lede:
    "Everything on the installer map is yours too. This map is the part only you carry: the crew, the plans, the warehouse keys, and the answers people wait on.",
  rows: [
    [
      {
        id: "crew",
        label: "The crew",
        lines: ["Who's where, the board,", "team timecards."],
        asks: "The scheduling board drafts moves before they're real; timecards approve punch by punch, where the punch happened.",
        doors: ["/team", "/crew", "/team-timecards", "/scheduling"],
      },
    ],
    [
      {
        id: "plans",
        label: "The plans",
        lines: ["Spec review confirms", "every window."],
        asks: "The schedule of windows comes from the plans at spec review — and the tag screen can add one the plans missed, because you can.",
        wrong: "A window number nobody confirmed becomes a phantom forever — that is why tagging checks the schedule.",
        doors: ["/projects"],
      },
    ],
    [
      {
        id: "truck",
        label: "Ahead of the truck",
        lines: ["Declare the count, mint the", "labels, print the batch."],
        asks: "\"Window 16 arrives as 4 packages\" — the labels exist before the truck does, and receiving becomes sticking, not typing. Burn kills a label that never lived; Reprint keeps history.",
        doors: ["/projects", "/storage", "/labels"],
      },
    ],
    [
      {
        id: "keys",
        label: "The warehouse keys",
        lines: ["Containers, home spots,", "areas, counts."],
        asks: "Point at where in the box a package sits; give supplies a home a person can find; set the window on a mistagged package; assign Boneyard stock to a job.",
        doors: ["/storage", "/supplies", "/warehouse"],
      },
      {
        id: "inbox",
        label: "The warehouse inbox",
        lines: ["Takeoff requests wait", "on your answer."],
        asks: "Answer with a rough when, mark it ready when it is — their phone hears both. Pickup logs every line against the job.",
        doors: ["/takeoffs"],
        branch: true,
      },
    ],
    [
      {
        id: "quality",
        label: "Quality & problems",
        lines: ["Issues, QC checks,", "service calls."],
        asks: "Damage reports name their package; QC and service keep the after-story on the same record as the install.",
        doors: ["/issues", "/qc", "/service"],
      },
      {
        id: "numbers",
        label: "The numbers",
        lines: ["Analytics and", "daily logs."],
        asks: "Install evidence, on-tool time and the day's logs — the comparing kind of numbers stay at your level and above.",
        doors: ["/analytics", "/daily-logs"],
        branch: true,
      },
    ],
  ],
};

const SUPERVISOR: RoleFlow = {
  role: "supervisor",
  title: "How a supervisor runs a week",
  lede:
    "Everything foremen carry is yours too. Your week is the part that happens before and after the field: the models, the data, the people, the fleet.",
  rows: [
    [
      {
        id: "studio",
        label: "The Studio",
        lines: ["Model a job before it's built.", "Shells and shelves for the map."],
        asks: "Trace the plans, place every opening, publish to the job's 3D map. Container shells and shelf layouts start here too.",
        doors: ["/studio"],
      },
    ],
    [
      {
        id: "data",
        label: "The data",
        lines: ["Signatures, cohorts,", "the evidence."],
        asks: "Every estimate is a computed signature over real installed panels — the Data tab is where you read what the field has been writing.",
        doors: ["/data"],
      },
    ],
    [
      {
        id: "jobs",
        label: "Jobs & plansets",
        lines: ["New jobs, planset uploads,", "extraction, publish."],
        asks: "Upload the plans, let the extractor read them, confirm at spec review — the schedule every warehouse count keys off starts here.",
        doors: ["/projects"],
      },
    ],
    [
      {
        id: "people",
        label: "Access & admin",
        lines: ["Approve logins,", "set roles below yours."],
        asks: "Self-signup is off — approving a request here is the ONLY way anyone gets in. The AI's knowledge base is curated here too.",
        doors: ["/access", "/admin", "/knowledge"],
      },
      {
        id: "fleet",
        label: "Fleet & travel",
        lines: ["Vehicles and", "trips."],
        asks: "Trucks link to jobs; trips carry the crew, the flights and the door codes — published when they're real.",
        doors: ["/vehicles", "/travel"],
        branch: true,
      },
    ],
    [
      {
        id: "pulse",
        label: "The pulse",
        lines: ["Heartbeat and", "cost codes."],
        asks: "The one screen that says whether the company's day is moving, and the codes the money hangs on.",
        doors: ["/heartbeat", "/cost-codes"],
      },
    ],
  ],
};

const OWNER: RoleFlow = {
  role: "owner",
  title: "What the owner alone holds",
  lede:
    "Everything supervisors carry is yours too. This last stretch is short on purpose — the app pushes decisions down, and keeps only the money at the top.",
  rows: [
    [
      {
        id: "money",
        label: "The money",
        lines: ["Job costing and", "AI spend."],
        asks: "What each job really cost against what was bid, and what the AI features are burning — the two ledgers nobody below needs.",
        doors: ["/costing", "/ai-spend"],
      },
    ],
    [
      {
        id: "outside",
        label: "Kept outside the app",
        lines: ["Deploys, backups,", "the master switches."],
        asks: "Role changes at the very top, the deploy pipeline, database backups and secrets live in GitHub and Supabase on purpose — the app never holds the keys to itself.",
        doors: [],
        branch: true,
      },
    ],
  ],
};

export const ROLE_FLOWS: RoleFlow[] = [INSTALLER, FOREMAN, SUPERVISOR, OWNER];

export function roleFlow(role: CrewRole): RoleFlow | undefined {
  return ROLE_FLOWS.find((f) => f.role === role);
}

/** Every door on a flow, deduped — what the accuracy test walks. */
export function flowDoors(flow: RoleFlow): RoutePath[] {
  const out = new Set<RoutePath>();
  for (const row of flow.rows) for (const n of row) for (const d of n.doors) out.add(d);
  return [...out];
}

// Re-exported so the test can assert with the registry's own verdict.
export { canAccess };
