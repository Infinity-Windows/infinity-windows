// The decisions the spec-kinds backfill makes, with no database in sight, so
// they can be tested (scripts/seed-spec-kinds.test.mjs) rather than trusted.
//
// The backfill exists because `project_mark_specs.unit_kind` / `.door_kind`
// (20260980000000) are STORED: the app fills them in as it writes, and every
// row written before that migration has them empty. One run puts the whole
// history right.
//
// THE CLASSIFIER IS THE SOURCE OF TRUTH. This imports the very function the app
// writes with — app/src/lib/install/specKinds.mjs, which is plain JavaScript for
// exactly this reason — so a backfilled row and a freshly extracted one can
// never disagree. Change the rules there and run this again.

import { specKindColumns } from "../../app/src/lib/install/specKinds.mjs";

/**
 * What one row should say, and whether it already says it.
 *
 * AUTHORITATIVE, not fill-missing. That is the opposite of the receipts law and
 * it is right here: nobody types these columns. There is no screen for them, so
 * a stored value can only ever be an older reading of the same two text fields
 * — and an older reading that disagrees is precisely what this is for.
 *
 * @param {{ id: string, project_id?: string, mark_code?: string, style?: string | null, operation?: string | null, unit_kind?: string | null, door_kind?: string | null }} row
 */
export function specKindWrite(row) {
  const want = specKindColumns(row);
  const same =
    (row.unit_kind ?? null) === want.unit_kind &&
    (row.door_kind ?? null) === want.door_kind;
  return {
    id: row.id,
    project_id: row.project_id ?? null,
    mark: row.mark_code ?? "?",
    from: { unit_kind: row.unit_kind ?? null, door_kind: row.door_kind ?? null },
    to: want,
    changed: !same,
  };
}

/**
 * Every row that needs writing, plus the tally worth printing. Rows already
 * correct are dropped here and not later, so a second run reports "nothing left
 * to do" instead of rewriting the same values — the idempotence every seed in
 * this repo promises.
 *
 * @param {readonly object[]} rows
 */
export function planSpecKinds(rows) {
  const writes = [];
  const tally = { rows: 0, unchanged: 0, window: 0, door: 0, unknown: 0 };
  const doors = { slider: 0, french: 0, bifold: 0, swing: 0, other: 0 };
  for (const row of rows ?? []) {
    if (!row?.id) continue;
    const w = specKindWrite(row);
    tally.rows += 1;
    if (w.to.unit_kind === "window") tally.window += 1;
    else if (w.to.unit_kind === "door") tally.door += 1;
    else tally.unknown += 1;
    if (w.to.door_kind) doors[w.to.door_kind] += 1;
    if (w.changed) writes.push(w);
    else tally.unchanged += 1;
  }
  return { writes, tally, doors };
}

/**
 * The writes grouped into as few statements as possible: one per distinct pair
 * of values, chunked so no URL grows past what PostgREST will take.
 *
 * A row at a time would be thousands of round trips for a job history this
 * size; an `in (…)` list of ids that all want the same two values is the same
 * write, done once. The ids come from a read moments earlier, so each batch
 * names exactly the rows it read — never a filter that could match something
 * new that arrived in between.
 *
 * @param {readonly ReturnType<typeof specKindWrite>[]} writes
 * @param {number} chunk
 */
export function batchSpecKindWrites(writes, chunk = 200) {
  /** @type {Map<string, { patch: object, ids: string[] }>} */
  const byTarget = new Map();
  for (const w of writes) {
    const key = `${w.to.unit_kind ?? ""}|${w.to.door_kind ?? ""}`;
    const group = byTarget.get(key) ?? { patch: { ...w.to }, ids: [] };
    group.ids.push(w.id);
    byTarget.set(key, group);
  }
  const batches = [];
  for (const { patch, ids } of byTarget.values()) {
    for (let i = 0; i < ids.length; i += chunk) {
      batches.push({ patch, ids: ids.slice(i, i + chunk) });
    }
  }
  return batches;
}

/** "3 doors (2 French, 1 slider)" — the sentence the Actions log prints. */
export function describeDoors(doors) {
  const parts = Object.entries(doors)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
