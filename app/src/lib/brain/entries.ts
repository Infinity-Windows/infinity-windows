import { CATS, PROC, TERMS } from "../glossary";
import { CATALOG_SNAPSHOT } from "./catalogSnapshot";
import type { BrainEntry, CatalogType } from "./types";

/**
 * Everything the company already owns, turned into one flat list of searchable
 * answers: the 105 glossary terms, the 18 procedure steps, and every seeded
 * install tip and watch-out line on the real catalog — each one its own entry,
 * so a question about caulking the bottom can land on the sentence about
 * caulking the bottom rather than on a whole window type.
 */

const CAT_LABEL = new Map(CATS.map((c) => [c.id, c.label]));

/** Human category name — "single_hung" reads badly in a citation line. */
function prettyCategory(category?: string): string {
  if (!category) return "";
  return category
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function sizeLabel(t: CatalogType): string {
  return t.w != null && t.h != null ? `${t.w}×${t.h}` : "";
}

/** The card for a window type: what it is, how hard, and what we know. */
function typeEntry(t: CatalogType): BrainEntry {
  const size = sizeLabel(t);
  const lines: string[] = [];
  const facts: string[] = [];
  if (t.d != null) facts.push(`difficulty ${t.d}/5`);
  if (t.cat) facts.push(prettyCategory(t.cat).toLowerCase());
  if (size) facts.push(`${size} in`);
  if (facts.length) lines.push(facts.join(" · "));
  if (t.note) lines.push(t.note);
  if (t.t?.length) {
    lines.push("");
    lines.push("Tips:");
    for (const tip of t.t) lines.push(`• ${tip}`);
  }
  if (t.x?.length) {
    lines.push("");
    lines.push("Watch out:");
    for (const w of t.x) lines.push(`⚠ ${w}`);
  }
  if (t.hw?.length) {
    lines.push("");
    lines.push("How-to:");
    t.hw.forEach((step, i) =>
      lines.push(`${i + 1}. ${step.t}${step.d ? ` — ${step.d}` : ""}`),
    );
  }
  if (!t.t?.length && !t.x?.length && !t.hw?.length) {
    lines.push("");
    lines.push(
      "No install tips saved for this type yet — they build up as crews log installs and voice memos.",
    );
  }
  const hasKnowledge = Boolean(t.t?.length || t.x?.length);
  return {
    id: `type:${t.c}`,
    kind: "type",
    title: `${t.n}${size ? ` (${size})` : ""} — ${t.c}`,
    source: `Window type · ${t.c}`,
    body: lines.join("\n"),
    // The card is indexed on what it *is*, never on the tips it displays —
    // otherwise it outranks every individual tip and the brain can only ever
    // answer "which window type?", which is the bug this replaces.
    indexBody: [t.c, t.n, prettyCategory(t.cat), t.note ?? ""].join(" "),
    // "tips" and "difficulty" are what installers ask a type card for, and
    // neither word appears anywhere in the catalog row. A type only claims to
    // have tips when it actually has some.
    keywords: [
      t.c,
      prettyCategory(t.cat),
      "window unit type difficulty",
      hasKnowledge ? "tips advice watch out pointers" : "no tips saved yet",
    ].filter(Boolean),
  };
}

/** One seeded tip or watch-out line, on its own, cited back to its type. */
function lineEntry(t: CatalogType, text: string, index: number, watch: boolean): BrainEntry {
  const size = sizeLabel(t);
  return {
    id: `${watch ? "watch" : "tip"}:${t.c}:${index}`,
    kind: watch ? "watch-out" : "tip",
    title: `${watch ? "Watch out" : "Install tip"} — ${t.n}${size ? ` (${size})` : ""}`,
    source: `${t.c} · ${t.n}`,
    body: text,
    // Deliberately no category here: a stucco watch-out on a casement is not an
    // answer to "how long does a casement take", and weighting the category as
    // a keyword made it one. The type name in `source` still ties it back.
    keywords: [t.c, "window", watch ? "watch out mistake" : "tip advice"],
  };
}

function glossaryEntries(): BrainEntry[] {
  return TERMS.map((term) => ({
    id: `term:${term.id}`,
    kind: "glossary" as const,
    title: term.term,
    source: `Glossary · ${CAT_LABEL.get(term.cat) ?? term.cat}`,
    body: term.desc,
    keywords: term.links,
    href: "/learn",
  }));
}

function procedureEntries(): BrainEntry[] {
  const branch: Record<string, string> = {
    main: "Install procedure",
    win: "Window procedure",
    door: "Door procedure",
  };
  return PROC.map((step) => ({
    id: `step:${step.branch}:${step.step}`,
    kind: "procedure" as const,
    title: `Step ${step.step} — ${step.label}`,
    source: `${branch[step.branch] ?? "Procedure"} · step ${step.step}`,
    body: step.desc,
    keywords: ["procedure step order"],
    href: "/learn",
  }));
}

/**
 * The app tour. It is an entry like any other so it can answer "which tab do I
 * clock in on?", but `appOnly` keeps it out of every knowledge question — the
 * old code handed this paragraph to 15 of 28 install questions.
 */
export const APP_TOUR_ENTRY: BrainEntry = {
  id: "app:tour",
  kind: "app",
  title: "Getting around the app",
  source: "App guide",
  body:
    "Home is your day: clock-in, term of the day, active install, points and your projects. " +
    "Work is your assigned queue — the next ready window is up top. " +
    "Warehouse is find/scan/receive/slots and per-job pick lists. " +
    "Open a project to see its plan; tap a unit dot (blue = window, green = door) to open its sheet, then Assign to me & start. " +
    "After an install: record a voice memo, attach a video, take proof photos — points release after QC sign-off. " +
    "Learn has the glossary and daily practice; Points shows your score and tier.",
  keywords: [
    "app tab screen page button menu navigate",
    "clock in clock out timecard",
    "scan qr warehouse receive slot",
    "points tier score leaderboard",
    "sign in login pin account",
    "upload photo memo video attach",
    "use the app navigate get around guide help find where",
  ],
  appOnly: true,
};

/** Build the entry list for a catalog. Pure, so tests can pass a small one. */
export function buildEntries(catalog: CatalogType[]): BrainEntry[] {
  const entries: BrainEntry[] = [];
  for (const t of catalog) {
    entries.push(typeEntry(t));
    (t.t ?? []).forEach((tip, i) => entries.push(lineEntry(t, tip, i, false)));
    (t.x ?? []).forEach((w, i) => entries.push(lineEntry(t, w, i, true)));
  }
  entries.push(...glossaryEntries(), ...procedureEntries(), APP_TOUR_ENTRY);
  return entries;
}

/** The brain as it ships in the bundle — no network, no signal needed. */
export function bundledEntries(): BrainEntry[] {
  return buildEntries(CATALOG_SNAPSHOT);
}
