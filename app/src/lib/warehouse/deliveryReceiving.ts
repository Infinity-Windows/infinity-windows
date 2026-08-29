// The truck gets checked AGAINST the list (owner, 2026-08-25): a logged
// delivery is a standby list of EXPECTED packages. This module turns the
// delivery's packages into the rows the receiving screen shows — identical
// boxes grouped together, because clones are interchangeable and nobody at
// a tailgate cares which twin goes where.

export interface DeliveryPackageLite {
  id: string;
  status: string;
  project_id: string | null;
  pending_job_name: string | null;
  mfr_mark: string | null;
  part_index: number | null;
  part_total: number | null;
  part_type: string | null;
  piece_count: number | null;
  container_id: string | null;
}

export interface SlotRow {
  key: string;
  /** "#5050 — box 1 of 3" or "#5050 — 4 pieces of glass (crate)". */
  label: string;
  mark: string;
  isCrate: boolean;
  /** null = untyped, the "what is it?" pile — wave R's tailgate collapse
   *  groups on this alongside mark and isCrate. */
  partType: string | null;
  expected: number;
  received: number;
  stored: number;
  /** Ids still waiting on the truck, oldest first. */
  expectedIds: string[];
  /** Ids arrived but not yet put away (crate rows put away on arrival). */
  looseIds: string[];
  /** Legacy only: pool rows created before crates became sealed packages
   *  may still point at an old crate container. New pool rows never do. */
  crateContainerId: string | null;
  /** Ids whose arrival can be UNDONE: received-and-loose, plus crate
   *  pieces (their arrive tap auto-stored them into the crate). */
  undoableIds: string[];
  /** Non-crate ids currently stored — un-put-away pulls them back to
   *  loose, most recent first. */
  storedIds: string[];
  /** EVERY package id that fed this slot, whatever its state — checked-out
   *  ones included, which none of the action lists above carry. The set
   *  editor renames and deletes through this so no straggler keeps the old
   *  name. */
  allIds: string[];
}

/** One mark's whole story inside a job group — what the set editor shows. */
export interface DeliverySet {
  mark: string;
  slots: SlotRow[];
  allIds: string[];
  expected: number;
  arrived: number;
  stored: number;
}

export function setForMark(group: JobGroup, mark: string): DeliverySet {
  const slots = group.rows.filter((r) => r.mark === mark);
  return {
    mark,
    slots,
    allIds: slots.flatMap((r) => r.allIds),
    expected: slots.reduce((s, r) => s + r.expected, 0),
    arrived: slots.reduce((s, r) => s + r.received, 0),
    stored: slots.reduce((s, r) => s + r.stored, 0),
  };
}

export interface JobGroup {
  key: string;
  /** A real job's id, or null when the job isn't built yet. */
  projectId: string | null;
  /** The typed name when projectId is null. */
  pendingJobName: string | null;
  rows: SlotRow[];
  /** Every package id in the group that is still unfiled (projectId null). */
  unfiledIds: string[];
}

const slotKey = (p: DeliveryPackageLite): string =>
  [
    p.mfr_mark ?? "?",
    p.piece_count != null ? "crate" : "box",
    p.part_index ?? "",
    p.part_total ?? "",
    p.piece_count ?? "",
    p.part_type ?? "",
  ].join("|");

const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const slotLabel = (p: DeliveryPackageLite, jobTitle: string | null): string => {
  const prefix = jobTitle ? `${jobTitle} · ` : "";
  // A sealed crate: its "mark" is its name.
  if (p.part_type === "crate") {
    return `${prefix}${titleCase(p.mfr_mark ?? "Crate")} — sealed crate`;
  }
  const mark = p.mfr_mark ? `#${p.mfr_mark}` : "no mark";
  if (p.piece_count != null) {
    return `${prefix}${mark} — ${p.piece_count} piece${p.piece_count === 1 ? "" : "s"} of ${p.part_type ?? "glass"} (in the crates)`;
  }
  const slot =
    p.part_index != null && p.part_total != null
      ? ` — ${p.part_index}/${p.part_total}`
      : "";
  return `${prefix}${mark}${slot}${p.part_type ? ` · ${p.part_type}` : ""}`;
};

/** Group a delivery's packages: job entry -> identical-slot rows. Row
 *  titles carry the job (owner ask: scrolling rows must say whose they
 *  are) — real jobs resolve through jobTitle, typed names ride as-is. */
export function groupDelivery(
  packages: DeliveryPackageLite[],
  jobTitle?: (projectId: string) => string | null,
): JobGroup[] {
  const jobs = new Map<string, JobGroup>();
  for (const p of packages) {
    const jobKey = p.project_id ?? `pending:${p.pending_job_name ?? "?"}`;
    let job = jobs.get(jobKey);
    if (!job) {
      job = {
        key: jobKey,
        projectId: p.project_id,
        pendingJobName: p.project_id ? null : p.pending_job_name,
        rows: [],
        unfiledIds: [],
      };
      jobs.set(jobKey, job);
    }
    if (!p.project_id) job.unfiledIds.push(p.id);

    const key = slotKey(p);
    let row = job.rows.find((r) => r.key === key);
    if (!row) {
      const title = p.project_id
        ? (jobTitle?.(p.project_id) ?? null)
        : (p.pending_job_name ?? null);
      row = {
        key,
        label: slotLabel(p, title),
        mark: p.mfr_mark ?? "?",
        isCrate: p.piece_count != null,
        partType: p.part_type ?? null,
        expected: 0,
        received: 0,
        stored: 0,
        expectedIds: [],
        looseIds: [],
        crateContainerId: p.piece_count != null ? p.container_id : null,
        undoableIds: [],
        storedIds: [],
        allIds: [],
      };
      job.rows.push(row);
    }
    row.expected += 1;
    row.allIds.push(p.id);
    if (p.status === "minted") {
      row.expectedIds.push(p.id);
    } else if (p.status === "received") {
      row.received += 1;
      row.looseIds.push(p.id);
      row.undoableIds.push(p.id);
    } else if (p.status === "stored" || p.status === "checked_out") {
      row.received += 1;
      row.stored += 1;
      if (p.piece_count != null && p.status === "stored") {
        row.undoableIds.push(p.id);
      } else if (p.status === "stored") {
        row.storedIds.push(p.id);
      }
    }
  }
  for (const job of jobs.values()) {
    job.rows.sort((a, b) =>
      a.mark === b.mark
        ? a.label.localeCompare(b.label, undefined, { numeric: true })
        : a.mark.localeCompare(b.mark, undefined, { numeric: true }),
    );
  }
  return [...jobs.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** "n of these arrived" -> which ids flip. Any n will do: they're twins. */
export function pickToReceive(row: SlotRow, n: number): string[] {
  return row.expectedIds.slice(0, Math.max(0, Math.min(n, row.expectedIds.length)));
}

/** Undo the most recent arrival taps first — a thumb slip is always the
 *  last thing that happened. */
export function pickToUndo(row: SlotRow, n: number): string[] {
  const take = Math.max(0, Math.min(n, row.undoableIds.length));
  return row.undoableIds.slice(row.undoableIds.length - take);
}

/** Un-put-away the most recent stores first. */
export function pickToUnstore(row: SlotRow, n: number): string[] {
  const take = Math.max(0, Math.min(n, row.storedIds.length));
  return row.storedIds.slice(row.storedIds.length - take);
}

/** "store n into that conex" -> arrived-and-loose first. */
export function pickToStore(row: SlotRow, n: number): string[] {
  return row.looseIds.slice(0, Math.max(0, Math.min(n, row.looseIds.length)));
}

export interface DeliverySummary {
  expected: number;
  received: number;
  missing: number;
  lines: string[];
}

/** The against-the-list verdict: what never came off the truck. */
export function missingSummary(groups: JobGroup[]): DeliverySummary {
  let expected = 0;
  let received = 0;
  const lines: string[] = [];
  for (const g of groups) {
    for (const r of g.rows) {
      expected += r.expected;
      received += r.received;
      const missing = r.expected - r.received;
      if (missing > 0) {
        lines.push(`${r.label}: ${missing} of ${r.expected} still missing`);
      }
    }
  }
  return { expected, received, missing: expected - received, lines };
}

/**
 * Wave R, ticket R3 — collapse the fifteen-card wall: a mark declared as 15
 * individually numbered packages used to render as 15 separate SlotRows
 * (one per part_index), because groupDelivery's slot key includes the
 * index. This groups those rows further, by (mark, isCrate, part type) —
 * the "type" a whole line of the tailgate is checked in against.
 *
 * ONLY collapses when there are 2+ member rows: a mark with a single row
 * already has nothing to collapse, and rendering it through the same
 * summary-plus-expand chrome as a genuine wall would be a pointless extra
 * tap for the common case. Bound marks/serials never enter this at all —
 * they render as their own SlotRow already, one per package, and this
 * function only ever groups WITHIN a job's rows.
 */
export interface TypeGroup {
  key: string;
  mark: string;
  isCrate: boolean;
  partType: string | null;
  /** "#5050 — frame" — no count; the caller renders "N still coming" /
   *  "N arrived" beside it, same split JobGroup rows already use. */
  label: string;
  missing: number;
  received: number;
  /** Every expected id across every member row, lowest part_index first —
   *  "Arrive 1" takes from the front, "Arrive all" takes the lot. */
  expectedIds: string[];
  rows: SlotRow[];
}

const partIndexOf = (row: SlotRow): number => {
  const raw = row.key.split("|")[2] ?? "";
  if (raw === "") return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

/** "#5050 — frame" / "#5050 — what is it?" — the type-group's own title,
 *  stripped of any job prefix a member row's label carries (the caller
 *  already shows the job once, at the section header). */
const typeGroupLabel = (mark: string, partType: string | null): string =>
  `#${mark} — ${partType ?? "what is it?"}`;

export function groupRowsByType(rows: SlotRow[]): TypeGroup[] {
  const byKey = new Map<string, SlotRow[]>();
  for (const row of rows) {
    const key = [row.mark, row.isCrate ? "crate" : "box", row.partType ?? ""].join("|");
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  const groups: TypeGroup[] = [];
  for (const [key, members] of byKey) {
    const [mark, crateFlag, partTypeRaw] = key.split("|");
    const sorted = [...members].sort((a, b) => partIndexOf(a) - partIndexOf(b));
    groups.push({
      key,
      mark,
      isCrate: crateFlag === "crate",
      partType: partTypeRaw || null,
      label: typeGroupLabel(mark, partTypeRaw || null),
      missing: sorted.reduce((s, r) => s + (r.expected - r.received), 0),
      received: sorted.reduce((s, r) => s + r.received, 0),
      expectedIds: sorted.flatMap((r) => r.expectedIds),
      rows: sorted,
    });
  }
  return groups;
}

/** "n of these arrived" for a whole type group — the collapsed-row version
 *  of pickToReceive, taking from the lowest part_index first. */
export function pickToReceiveGroup(group: TypeGroup, n: number): string[] {
  return group.expectedIds.slice(0, Math.max(0, Math.min(n, group.expectedIds.length)));
}
