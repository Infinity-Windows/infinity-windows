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
  expected: number;
  received: number;
  stored: number;
  /** Ids still waiting on the truck, oldest first. */
  expectedIds: string[];
  /** Ids arrived but not yet put away (crate rows put away on arrival). */
  looseIds: string[];
  /** For crate rows: the crate the pieces ride in — receiving stores them
   *  straight into it. */
  crateContainerId: string | null;
  /** Ids whose arrival can be UNDONE: received-and-loose, plus crate
   *  pieces (their arrive tap auto-stored them into the crate). A real
   *  put-away in a conex is not undoable from here. */
  undoableIds: string[];
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

const slotLabel = (p: DeliveryPackageLite): string => {
  const mark = p.mfr_mark ? `#${p.mfr_mark}` : "no mark";
  if (p.piece_count != null) {
    return `${mark} — ${p.piece_count} piece${p.piece_count === 1 ? "" : "s"} of ${p.part_type ?? "glass"} (crate)`;
  }
  const slot =
    p.part_index != null && p.part_total != null
      ? `piece ${p.part_index} of ${p.part_total}`
      : "piece";
  return `${mark} — ${slot}${p.part_type ? ` · ${p.part_type}` : ""}`;
};

/** Group a delivery's packages: job entry -> identical-slot rows. */
export function groupDelivery(packages: DeliveryPackageLite[]): JobGroup[] {
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
      row = {
        key,
        label: slotLabel(p),
        mark: p.mfr_mark ?? "?",
        isCrate: p.piece_count != null,
        expected: 0,
        received: 0,
        stored: 0,
        expectedIds: [],
        looseIds: [],
        crateContainerId: p.piece_count != null ? p.container_id : null,
        undoableIds: [],
      };
      job.rows.push(row);
    }
    row.expected += 1;
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
