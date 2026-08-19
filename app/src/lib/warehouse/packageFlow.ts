// The package map: how a package gets tracked, as data.
//
// Grilled and settled 2026-08-17 (see CONTEXT.md "The warehouse" and
// ADR-0004). Every package lives the same six steps whatever is inside it —
// a crate is NOT a step, it is one of the places a package sits, which is why
// the containers are drawn inside `stored` rather than beside it.
//
// Geometry lives here with the copy on purpose. A diagram's coordinates ARE
// its data: keeping them here means one test can prove every node has a box,
// every edge joins two real nodes, and every "related" id resolves — none of
// which is checkable once the numbers are scattered through JSX. The component
// then does nothing but draw what this file says.
//
// Copy rule (Isaac, 2026-08-17): plain language, 12th-grade. Say what to DO,
// not what a thing is.

/** The six steps every package runs, in order. */
export type StageId =
  | "stickers"
  | "arrive"
  | "tagged"
  | "stored"
  | "out"
  | "site"
  | "installed";

/** The five ways a package stops moving. Drawn in the lane below the steps. */
export type StuckId = "nottagged" | "waiting" | "loose" | "damaged" | "wrongjob";

export type NodeId = StageId | StuckId;

export interface FlowNode {
  id: NodeId;
  /** Box geometry in viewBox units. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** Small lines inside the box. Keep to two — a third crowds the box. */
  lines?: string[];
  /** A line rendered in the code face: sticker codes, part numbers, job codes. */
  code?: string;
  /** Drawn quieter, in the lower lane. */
  stuck?: boolean;
  /** Who physically does this. "Nobody" is a real and useful answer. */
  who: string;
  /** What the app asks for at this point. */
  asks: string;
  /** What goes wrong here, and why the rule is what it is. */
  wrong: string;
  /** Nodes lit alongside this one when it is opened. */
  related: NodeId[];
  /** Edges lit when this one is opened. */
  edges: EdgeId[];
}

export type EdgeId =
  | "stickers-tagged"
  | "arrive-tagged"
  | "tagged-stored"
  | "stored-out"
  | "out-site"
  | "site-installed"
  | "out-stored"
  | "s-nottagged"
  | "s-waiting"
  | "s-loose"
  | "s-damaged"
  | "s-wrongjob";

export interface FlowEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  /** SVG path data. */
  d: string;
  /** Short verb on the arrow. An unlabelled arrow only says "related somehow". */
  label?: string;
  labelX?: number;
  labelY?: number;
  /** Dashed = went sideways, or came back. */
  dashed?: boolean;
}

/**
 * What "stored" actually means, drawn as chips inside that box.
 *
 * A shelf is NOT a container, whatever this list is called — the database
 * holds them apart on purpose: `packages_one_place_ck` says a package is in a
 * container OR at a shelf spot, never both (20260824000000). And nothing puts
 * a package on a shelf except Set aside, which always names a job
 * (`stage_packages` writes `job_staging_bay(project)`, 20260827000000). So the
 * chip says whose shelf it is. There is no general "put this anywhere" action
 * for a shelf the way there is for a conex, and the chip must not imply one.
 */
export const CONTAINERS = [
  "Conex",
  "Crate — inside a conex",
  "Shelf — a job's bay",
] as const;

/**
 * The drawn window. `minY` crops the empty band above the diagram — the topmost
 * ink is the "came back" arc label at y=140, so starting the viewBox at 0 wasted
 * a quarter of the frame's height on nothing, which is most visible on a phone
 * where the frame is already the tallest thing on the page.
 */
export const FLOW_VIEWBOX = { minY: 120, w: 1280, h: 400 } as const;

export const NODES: FlowNode[] = [
  {
    id: "stickers",
    x: 24,
    y: 192,
    w: 150,
    h: 54,
    label: "Blank stickers",
    lines: ["printed in batches"],
    who: "A foreman, at the printer.",
    asks: "How many to print. That is the whole form.",
    wrong:
      "A sticker goes on one package and stays there for life. Peel one off and reuse it and every older record starts pointing at the wrong box — stickers cost pennies, a trail you can trust does not.",
    related: ["tagged"],
    edges: ["stickers-tagged"],
  },
  {
    id: "arrive",
    x: 24,
    y: 292,
    w: 150,
    h: 54,
    label: "Packages arrive",
    code: "#16 2/3",
    who: "Whoever is at the truck.",
    asks: "Nothing yet. They turn up already labelled by the manufacturer.",
    wrong:
      "If nobody tags them, they are sitting right here and findable by nobody. That is what the “Not tagged” number counts.",
    related: ["tagged", "nottagged"],
    edges: ["arrive-tagged", "s-nottagged"],
  },
  {
    id: "tagged",
    x: 230,
    y: 238,
    w: 150,
    h: 72,
    label: "Tagged",
    lines: ["one sticker, one package", "unit · part no. · job"],
    // Open to anyone signed in, and said so on purpose: `bind_package` checks
    // only that you are signed in (20260825000000), and /storage/tag has no
    // RequireRole on it. Tagging happens at the truck, by whoever is at the
    // truck — the map used to claim a foreman rule that nothing enforced.
    who: "Whoever's at the truck.",
    asks:
      "Which window (#16), which piece (2 of 3), which job, and what it is — frame, glass, hardware or threshold.",
    wrong:
      "When the manufacturer’s number does not match the mark on your plans, the app keeps both and asks. It never quietly picks one.",
    related: ["stickers", "arrive", "stored", "waiting"],
    edges: ["stickers-tagged", "arrive-tagged", "tagged-stored", "s-waiting"],
  },
  {
    id: "stored",
    x: 436,
    y: 198,
    w: 190,
    h: 152,
    label: "Stored",
    who: "Anyone putting things away.",
    asks: "Scan the conex, then tick everything going in. One scan for twenty packages.",
    wrong:
      "Move a crate and everything inside it moves with it — one action, not twenty. A package with no conex and no shelf is Loose, which is the pile nobody can find.",
    related: ["tagged", "out", "loose", "damaged"],
    edges: ["tagged-stored", "stored-out", "out-stored", "s-loose", "s-damaged"],
  },
  {
    id: "out",
    x: 682,
    y: 238,
    w: 150,
    h: 72,
    label: "Checked out",
    lines: ["installer scans it out", "reason + job required"],
    who: "The installer taking it.",
    asks: "A reason, and which job it is going to.",
    wrong:
      "Taking a package tagged for another job warns you loudly and makes you pick a reason — but never stops you. A scan that gets blocked is a scan that stops happening.",
    related: ["stored", "site", "wrongjob"],
    edges: ["stored-out", "out-site", "out-stored", "s-wrongjob"],
  },
  {
    id: "site",
    x: 888,
    y: 238,
    w: 150,
    h: 72,
    label: "On site",
    lines: ["at the job, not in yet"],
    who: "Nobody — it follows the checkout.",
    asks: "Nothing. This is where it is, not something you do.",
    wrong:
      "Brought back instead of used? Scanning it into a conex stores it again. Nothing has to be undone.",
    related: ["out", "installed"],
    edges: ["out-site", "site-installed"],
  },
  {
    id: "installed",
    x: 1094,
    y: 238,
    w: 150,
    h: 72,
    label: "Installed",
    lines: ["tracking ends here"],
    who: "The installer finishing the unit.",
    asks: "Nothing extra — finishing the unit does it.",
    wrong:
      "Tracking stops here. If that unit comes back out as a Redo, that is the unit’s story, not the package’s.",
    related: ["site"],
    edges: ["site-installed"],
  },

  // ---- the lower lane: where a package stops moving --------------------
  {
    id: "nottagged",
    x: 45,
    y: 424,
    w: 150,
    h: 56,
    stuck: true,
    label: "Not tagged",
    lines: ["here, findable by nobody"],
    who: "Nobody — that is the problem.",
    asks: "Nothing. It shows as a count on the Warehouse page that should be shrinking.",
    wrong:
      "On day one this is the whole warehouse. Tag things as you pick them up and this number turns into your progress bar.",
    related: ["arrive"],
    edges: ["s-nottagged"],
  },
  {
    id: "waiting",
    x: 235,
    y: 424,
    w: 150,
    h: 56,
    stuck: true,
    label: "Waiting on parts",
    code: "2 of 3 here",
    who: "Nobody — the app works it out.",
    asks: "Nothing. It reads the part numbers already tagged and does the subtraction.",
    wrong:
      "This is the one that stops an install. Knowing on Tuesday that the hardware never came beats finding out on the ladder on Friday.",
    related: ["tagged"],
    edges: ["s-waiting"],
  },
  {
    id: "loose",
    x: 425,
    y: 424,
    w: 150,
    h: 56,
    stuck: true,
    label: "Loose",
    lines: ["no conex, no shelf"],
    who: "Whoever set it down.",
    asks: "Nothing to do — it is tagged but has no place.",
    wrong:
      "Tagged, so the app knows it exists. No container, so it cannot tell you where. This is the genuinely-cannot-find-it pile.",
    related: ["stored"],
    edges: ["s-loose"],
  },
  {
    id: "damaged",
    x: 615,
    y: 424,
    w: 150,
    h: 56,
    stuck: true,
    label: "Damaged",
    lines: ["replacement needed"],
    who: "Whoever found it.",
    // A photo, now real (ticket 11, 20260922000000_damage_photo.sql): the
    // Damaged button opens the same stamped camera the flashing phase-proof
    // shot uses, optional, and `issues.photo_path` is where it lands. The
    // reporter is also real but never asked for: `arrive_packages` stamps
    // `created_by` from who is signed in.
    asks: "A note, and a photo if you've got one. It raises an issue, and the job sees it.",
    wrong:
      "Held back on purpose, not lost. Somebody has to order a replacement before that unit can be finished.",
    related: ["stored"],
    edges: ["s-damaged"],
  },
  {
    id: "wrongjob",
    x: 805,
    y: 424,
    w: 150,
    h: 56,
    stuck: true,
    label: "Borrowed",
    lines: ["left under another job"],
    who: "The installer who took it.",
    asks: "A loud warning, and one tap to say why.",
    wrong:
      "Borrowing between jobs is normal and often the right call. Blocking it teaches people to stop scanning; recording why turns it into a number worth reading at month end.",
    related: ["out"],
    edges: ["s-wrongjob"],
  },
];

export const EDGES: FlowEdge[] = [
  { id: "stickers-tagged", from: "stickers", to: "tagged", d: "M 174 219 C 200 219, 204 250, 230 258" },
  { id: "arrive-tagged", from: "arrive", to: "tagged", d: "M 174 319 C 200 319, 204 298, 230 290" },
  { id: "tagged-stored", from: "tagged", to: "stored", d: "M 380 274 L 430 274", label: "put away", labelX: 408, labelY: 263 },
  { id: "stored-out", from: "stored", to: "out", d: "M 626 274 L 676 274", label: "take it", labelX: 654, labelY: 263 },
  { id: "out-site", from: "out", to: "site", d: "M 832 274 L 882 274", label: "haul", labelX: 860, labelY: 263 },
  { id: "site-installed", from: "site", to: "installed", d: "M 1038 274 L 1088 274", label: "fit", labelX: 1064, labelY: 263 },
  {
    id: "out-stored",
    from: "out",
    to: "stored",
    d: "M 757 238 C 748 158, 620 140, 566 196",
    label: "came back · re-stored",
    labelX: 660,
    labelY: 140,
    dashed: true,
  },
  { id: "s-nottagged", from: "arrive", to: "nottagged", d: "M 99 346 L 120 424", dashed: true },
  { id: "s-waiting", from: "tagged", to: "waiting", d: "M 305 310 L 310 424", dashed: true },
  { id: "s-loose", from: "stored", to: "loose", d: "M 512 350 L 500 424", dashed: true },
  { id: "s-damaged", from: "stored", to: "damaged", d: "M 580 350 L 686 424", dashed: true },
  { id: "s-wrongjob", from: "out", to: "wrongjob", d: "M 770 310 L 876 424", dashed: true },
];

const NODE_BY_ID = new Map(NODES.map((n) => [n.id, n]));

export function flowNode(id: NodeId): FlowNode | undefined {
  return NODE_BY_ID.get(id);
}

/**
 * One sentence describing the whole picture, for readers who cannot see it.
 * Kept beside the data so it cannot drift from what is actually drawn.
 */
export const FLOW_ALT =
  "Blank stickers and arriving packages meet at tagging. A tagged package is stored in a conex or a crate — or set aside on a job's own shelf — then checked out by an installer with a reason, hauled to site, and installed. Below the main path, five ways a package stops moving: never tagged, waiting on its other parts, loose with no home, damaged, or borrowed under another job.";
