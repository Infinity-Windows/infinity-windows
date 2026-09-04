#!/usr/bin/env node
// Pure checks for the spec-kinds backfill. It writes to every job on the
// company with the service key, so the two things worth being sure of are:
// it reads the same answer the app does, and it leaves alone every row that is
// already right. Run: node scripts/seed-spec-kinds.test.mjs
import assert from "node:assert/strict";
import {
  batchSpecKindWrites,
  describeDoors,
  planSpecKinds,
  specKindWrite,
} from "./lib/spec-kinds-seed.mjs";
import { specKindColumns } from "../app/src/lib/install/specKinds.mjs";

// Real Black Desert and Mad Moose spec text — the same strings the app's own
// classifier tests use, so a rule change breaks both at once.
const BD_FRENCH =
  'Thermal break Aluminum French Door (Low track)(1 3/8" Nail Fins) (Outside View)';
const BD_WINDOW =
  'Thermal Break Aluminum Fixed Window(1 3/8" Nail Fins)(Aluminum plate mull)';
const BD_SLIDER =
  "2 Track Thermal break Aluminum Sliding Door (2 panel Fixed)(New Track)(Outside View)";
const MM_COMMERCIAL =
  'Thermal break Aluminum Commercial style door(With threshold)(Outside View)(1 3/8" Nail Fins)';

const row = (over) => ({
  id: over.id ?? "row-1",
  project_id: "job-1",
  mark_code: "1",
  style: null,
  operation: null,
  unit_kind: null,
  door_kind: null,
  ...over,
});

// --- the backfill reads what the app reads ---------------------------------
{
  const cases = [
    { style: BD_FRENCH, operation: "French door track(Inward opening)" },
    { style: BD_WINDOW, operation: "O" },
    { style: BD_SLIDER, operation: "OXXO" },
    { style: MM_COMMERCIAL, operation: "Swing door, single leaf" },
    { style: "Thermal Break Aluminum", operation: null },
  ];
  for (const c of cases) {
    assert.deepEqual(
      specKindWrite(row(c)).to,
      specKindColumns(c),
      `backfill and app disagree on ${c.style}`,
    );
  }
}

// --- a row already right is not written again ------------------------------
{
  const done = row({ style: BD_FRENCH, unit_kind: "door", door_kind: "french" });
  assert.equal(specKindWrite(done).changed, false);
  const { writes, tally } = planSpecKinds([done]);
  assert.equal(writes.length, 0, "an already-correct row must not be rewritten");
  assert.equal(tally.unchanged, 1);
}

// --- a stale reading IS corrected ------------------------------------------
// The whole point of re-running after a rule change: an older reading of the
// same words loses to the current one.
{
  const stale = row({ style: BD_SLIDER, unit_kind: "door", door_kind: "french" });
  const w = specKindWrite(stale);
  assert.equal(w.changed, true);
  assert.deepEqual(w.to, { unit_kind: "door", door_kind: "slider" });
}

// --- a mark whose paperwork says nothing stays blank -----------------------
// Null is the honest bucket. Guessing it into the window pile is the one
// outcome that would make a job card quietly wrong.
{
  const vague = row({ style: "Thermal Break Aluminum", operation: null });
  assert.deepEqual(specKindWrite(vague).to, { unit_kind: null, door_kind: null });
  assert.equal(specKindWrite(vague).changed, false, "blank stays blank, no write");
}

// --- the tally is the sentence the Actions log prints ----------------------
{
  const { tally, doors } = planSpecKinds([
    row({ id: "a", style: BD_WINDOW }),
    row({ id: "b", style: BD_FRENCH }),
    row({ id: "c", style: BD_SLIDER }),
    row({ id: "d", style: "Thermal Break Aluminum" }),
  ]);
  assert.equal(tally.rows, 4);
  assert.equal(tally.window, 1);
  assert.equal(tally.door, 2);
  assert.equal(tally.unknown, 1);
  assert.equal(describeDoors(doors), " (1 slider, 1 french)");
}

// --- writes are batched, and every id keeps its own values -----------------
{
  const many = [];
  for (let i = 0; i < 250; i++) many.push(row({ id: `w${i}`, style: BD_WINDOW }));
  for (let i = 0; i < 3; i++) many.push(row({ id: `d${i}`, style: BD_FRENCH }));
  const { writes } = planSpecKinds(many);
  assert.equal(writes.length, 253);

  const batches = batchSpecKindWrites(writes);
  // 250 windows chunk into two statements; the three French doors are a third.
  assert.equal(batches.length, 3);
  assert.equal(batches.reduce((n, b) => n + b.ids.length, 0), 253);

  // Every id must end up under the patch its own row asked for — a batch that
  // mixed them would file windows as doors on a whole job.
  const want = new Map(writes.map((w) => [w.id, w.to]));
  for (const b of batches) {
    for (const id of b.ids) assert.deepEqual(b.patch, want.get(id), `${id} in the wrong batch`);
  }
  // And no id may appear twice.
  const seen = batches.flatMap((b) => b.ids);
  assert.equal(new Set(seen).size, seen.length);
}

// --- a row with no id is skipped rather than written blind -----------------
{
  const { writes, tally } = planSpecKinds([{ style: BD_FRENCH }, null, undefined]);
  assert.equal(writes.length, 0);
  assert.equal(tally.rows, 0);
}

console.log("seed-spec-kinds: all checks passed");
