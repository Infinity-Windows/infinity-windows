#!/usr/bin/env node
// Pure checks for the MADMOOSE spec repair. Two jobs: the numbers in the
// fixture must describe real paper (boxes on the page, one per mark, no two
// marks claiming the same drawing), and the rules must never do the thing that
// caused the incident in the first place — overwrite work a person did.
// Run: node scripts/seed-madmoose-specs-repair.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  bboxProblem,
  boxesOverlap,
  checkDrawingTable,
  checkLiveSheet,
  fillMissingExtra,
  mergeRowPatches,
  planAddFill,
  planDrawingWrites,
  planSpecRestore,
  resolveSpecPlansets,
} from "./lib/madmoose-specs-repair.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = JSON.parse(
  readFileSync(join(root, "app/src/lib/fitview/fixtures/madmoose-mm2.json"), "utf8"),
);
const sheets = fx.specPlansets;
const drawings = fx.specDrawings;
const restore = fx.specRestore.marks;
const addFill = fx.specAddFill.marks;

const CU = "planset-cu";
const ADD = "planset-add";
const MARKS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const ADDS = ["Add-1", "Add-2", "Add-3"];

// --- the paper: every box is a box, and no two marks share one -------------
assert.deepEqual(checkDrawingTable(drawings.cu, sheets.cu.pages), [],
  "the cut sheet's boxes are all on the page and none overlap");
assert.deepEqual(checkDrawingTable(drawings.addendum, sheets.addendum.pages), [],
  "the addendum's boxes are all on the page and none overlap");
assert.deepEqual(Object.keys(drawings.cu).sort(), [...MARKS].sort(),
  "every mark 1-10 has exactly one drawing on the cut sheet");
assert.deepEqual(Object.keys(drawings.addendum).sort(), [...ADDS].sort(),
  "each Add has exactly one drawing on the addendum");
for (const [mark, spot] of Object.entries({ ...drawings.cu, ...drawings.addendum })) {
  assert.equal(bboxProblem(spot.bbox), null, `mark ${mark}: usable box`);
  const [x0, y0, x1, y1] = spot.bbox;
  assert.ok(x0 < x1 && y0 < y1, `mark ${mark}: x0<x1 and y0<y1`);
  assert.ok([x0, y0, x1, y1].every((n) => n >= 0 && n <= 1), `mark ${mark}: inside [0,1]`);
}
// The checker earns its keep only if it catches the two mistakes that matter.
assert.ok(checkDrawingTable({ a: { page: 1, bbox: [0.2, 0.2, 0.1, 0.4] } })[0].includes("negative width"));
assert.ok(checkDrawingTable({ a: { page: 1, bbox: [0, 0, 0.5, 0.5] }, b: { page: 1, bbox: [0.4, 0.4, 0.9, 0.9] } })
  .some((p) => p.includes("same part of page 1")), "two marks on one drawing is caught");
assert.equal(checkDrawingTable({ a: { page: 1, bbox: [0, 0, 0.5, 0.5] }, b: { page: 2, bbox: [0.4, 0.4, 0.9, 0.9] } }).length, 0,
  "the same rectangle on two different pages is two different drawings");
assert.ok(checkDrawingTable({ a: { page: 9, bbox: [0, 0, 0.5, 0.5] } }, 4)[0].includes("past the end"));
assert.equal(boxesOverlap([0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5]), false, "touching edges is not overlapping");

// --- the numbers agree with the cut sheets and with each other -------------
assert.deepEqual(Object.keys(restore), ["1", "2", "3"], "only the three clobbered marks are restored");
for (const [mark, entry] of Object.entries(restore)) {
  const win = fx.windows.find((w) => w.id === mark);
  assert.ok(Math.abs(entry.width_in * 25.4 - win.w) < 2, `mark ${mark}: restored width matches the order size`);
  assert.ok(Math.abs(entry.height_in * 25.4 - win.h) < 2, `mark ${mark}: restored height matches the order size`);
  assert.equal(entry.extra.printed_width_in, entry.width_in, `mark ${mark}: printed inches match the column`);
  assert.equal(entry.extra.printed_height_in, entry.height_in);
  const panelSum = entry.extra.panels.reduce((a, p) => a + p.width_in, 0);
  assert.ok(Math.abs(panelSum - entry.width_in) < 0.6, `mark ${mark}: panels sum to the unit width`);
  const gridSum = fx.paneGrids[mark].columns.reduce((a, c) => a + c.width_in, 0);
  assert.ok(Math.abs(gridSum - panelSum) < 0.6, `mark ${mark}: panels agree with the pane grid that survived`);
  assert.equal(entry.source, "manual", "a hand-restored row is manual");
  assert.equal(entry.confirmed, false, "the owner confirms his own drafts");
}
const { addendumWidthIn: tell2, ...door2 } = restore["2"];
const { addendumWidthIn: tell3, ...door3 } = restore["3"];
assert.deepEqual(door3, door2, "marks 2 and 3 are the same door on the same sheet");
assert.notEqual(tell2, tell3, "but a different Add unit landed on each of them");
// The tell each row is checked against is the Add unit that landed on it.
for (const [i, mark] of ["1", "2", "3"].entries()) {
  assert.equal(restore[mark].addendumWidthIn, fx.addSpecs[i].width_in,
    `mark ${mark} was overwritten by ${fx.addSpecs[i].mark_code}`);
}
for (const [mark, entry] of Object.entries(addFill)) {
  const spec = fx.addSpecs.find((s) => s.mark_code === mark);
  assert.equal(entry.extra.printed_width_in, spec.width_in, `${mark}: printed width matches the row`);
  assert.equal(entry.extra.printed_height_in, spec.height_in);
  const panelSum = entry.extra.panels.reduce((a, p) => a + p.width_in, 0);
  assert.ok(Math.abs(panelSum - spec.width_in) < 0.6, `${mark}: panels sum to the unit width`);
  assert.equal(entry.tempered, true, `${mark}: the addendum glass is tempered`);
}

// --- resolving the two sheets ---------------------------------------------
// Paths built the way uploadPlanset actually stores one — `<project id>/
// <timestamp>-<file name>`, keeping the extension, because the upload accepts
// nothing but pdf/dwg/dxf. The first version of this test stripped the
// extension off the two sheets under test, which is a path no upload can
// produce, and so never noticed that the matcher was an endsWith against a
// fragment: on the live job it matched nothing and the seed refused every run.
const PROJECT = "08c60cce-29f6-4b52-bd0c-2bc2c02a79a9";
const storedPath = (stamp, fileName) =>
  // Mirrors uploadPlanset: a timestamp, then the file name with runs of
  // anything but word characters, dots and dashes collapsed to underscores.
  `${PROJECT}/${stamp}-${fileName.replace(/[^\w.-]+/g, "_")}`;
const livePlansets = [
  { id: "planset-plans", storage_path: storedPath(1756000000000, "MMV2 - LOT PLANS.pdf") },
  { id: CU, storage_path: storedPath(1756000001000, "MMV2 - CUTSHEETS.pdf") },
  { id: ADD, storage_path: storedPath(1756700000000, "MMV2A - CADS.pdf") },
];
for (const p of livePlansets) {
  assert.ok(p.storage_path.endsWith(".pdf"), `${p.id}: a stored planset path keeps its extension`);
}
// The regression itself, stated plainly: neither fragment is the tail of a
// real path, so a tail match can only ever find nothing.
for (const key of ["cu", "addendum"]) {
  const fragment = sheets[key].pathFragment;
  assert.ok(
    livePlansets.every((p) => !p.storage_path.endsWith(fragment)),
    `${key}: the fragment is never the tail of a stored path — matching on endsWith finds nothing`,
  );
}
assert.deepEqual(resolveSpecPlansets(livePlansets, sheets), {
  cu: livePlansets[1], addendum: livePlansets[2],
}, "each sheet is found by a fragment of its own file name");
assert.throws(() => resolveSpecPlansets([livePlansets[0], livePlansets[2]], sheets), /No cut sheet/,
  "a missing sheet is a refusal, not a guess");
assert.throws(
  () => resolveSpecPlansets(
    [...livePlansets, { id: "dupe", storage_path: storedPath(1756800000000, "MMV2A - CADS (1).pdf") }],
    sheets,
  ),
  /2 plansets have a file name containing/,
  "two files that could both be the addendum is a refusal",
);
// The building sheet shares the job prefix and must never answer for either
// specs sheet — that is the whole reason the fragments run past "MMV2".
assert.throws(() => resolveSpecPlansets([livePlansets[0]], sheets), /No cut sheet/,
  "the plans are not a cut sheet");

// --- the live sheets are the editions these boxes were read off ------------
// checkDrawingTable can only compare the fixture's pages against the fixture's
// own count, so it passes however wrong the sheet on the job is. These are the
// checks that need a row from the database.
const liveCu = { id: CU, kind: "specs", page_count: 4, source_format: "pdf", converted_pdf_path: null };
const liveAdd = { id: ADD, kind: "specs", page_count: 1, source_format: "pdf", converted_pdf_path: null };
assert.deepEqual(checkLiveSheet("cut sheet", liveCu, sheets.cu), [],
  "the four-page cut sheet is the edition the boxes were read off");
assert.deepEqual(checkLiveSheet("addendum", liveAdd, sheets.addendum), []);
const cuPages = Object.values(drawings.cu).map((d) => d.page);
assert.ok(Math.max(...cuPages) > 1, "there really are boxes past page 1 to protect");
assert.ok(
  checkLiveSheet("cut sheet", { ...liveCu, page_count: 1 }, sheets.cu)
    .some((p) => p.includes("1 page, not the 4 pages")),
  "a revised one-page sheet re-uploaded under the same name is refused before mark 7 is sent to page 3",
);
assert.ok(
  checkLiveSheet("cut sheet", { ...liveCu, page_count: null }, sheets.cu)
    .some((p) => p.includes("no page count recorded")),
  "an uncounted sheet is refused too — nothing can be checked against it",
);
assert.ok(
  checkLiveSheet("cut sheet", { ...liveCu, kind: "building" }, sheets.cu)
    .some((p) => p.includes('filed as "building"')),
  "a sheet the app does not file under specs would never draw these coordinates",
);
// The app draws only from a specs sheet it can RENDER (`plansetIsViewable`),
// so a CAD upload with no converted PDF is refused for the same reason as a
// sheet filed under the wrong kind: the write would succeed and no phone would
// change. A converted copy is enough — that is a sheet the card can open.
assert.ok(
  checkLiveSheet("cut sheet", { ...liveCu, source_format: "dwg" }, sheets.cu)
    .some((p) => p.includes("not a PDF the app can render")),
  "a CAD sheet with no converted copy would hold these boxes where nothing draws them",
);
assert.deepEqual(
  checkLiveSheet("cut sheet", { ...liveCu, source_format: "dwg", converted_pdf_path: "x.pdf" }, sheets.cu),
  [],
  "a converted CAD sheet is one the card can open, so it passes",
);
assert.ok(
  checkLiveSheet("cut sheet", { id: CU }, sheets.cu).length === 3,
  "a row with no kind, no page count and nothing renderable fails all three ways",
);

// --- the live rows, as the incident left them -----------------------------
/** A spec row shaped like PostgREST returns it. */
const row = (mark, over = {}) => ({
  id: `row-${mark}`, mark_code: mark, planset_id: null, image_page: null,
  image_bbox: null, width_in: null, height_in: null, tempered: null,
  confirmed: false, source: "ai", extra: {}, ...over,
});
const damaged = () => [
  // 1/2/3 still carry the Adds' numbers and the addendum's drawing.
  row("1", { planset_id: ADD, image_page: 1, image_bbox: [0.08, 0.11, 0.34, 0.4], width_in: 129.5, height_in: 95.5, extra: { qty: "1", printed_width: '3288(129 1/2")', pane_grid: fx.paneGrids["1"] } }),
  row("2", { planset_id: ADD, image_page: 1, image_bbox: [0.53, 0.11, 0.79, 0.4], width_in: 175.5, height_in: 95.5, extra: { pane_grid: fx.paneGrids["2"] } }),
  row("3", { planset_id: ADD, image_page: 1, image_bbox: [0.08, 0.51, 0.34, 0.8], width_in: 134.5, height_in: 95.5, extra: { pane_grid: fx.paneGrids["3"] } }),
  // 4-10 kept their text; the retire step nulled their coordinates.
  ...["4", "5", "6", "7", "8", "9", "10"].map((m) => row(m, { planset_id: CU, width_in: 71.5 })),
  // The Adds: hand-typed, confirmed, no numbers and no drawing.
  ...ADDS.map((m, i) => row(m, {
    confirmed: true, source: "manual", width_in: fx.addSpecs[i].width_in,
    height_in: fx.addSpecs[i].height_in, extra: { qty: "1" },
  })),
];

const planAll = (rows) => ({
  restore: planSpecRestore(rows, restore),
  cuArt: planDrawingWrites(rows, drawings.cu, CU, { fixWrongSheet: true }),
  addArt: planDrawingWrites(rows, drawings.addendum, ADD),
  addNumbers: planAddFill(rows, addFill),
});

const first = planAll(damaged());
assert.deepEqual(first.restore.map((d) => d.action), ["restore", "restore", "restore"],
  "all three clobbered rows are restored");
assert.equal(first.restore[0].patch.width_in, 167.5, "mark 1 is 167 1/2 again");
assert.deepEqual(first.restore[0].patch.extra.pane_grid, fx.paneGrids["1"],
  "the pane grid that survived the incident survives the repair too");
assert.equal(first.restore[0].patch.extra.printed_width, '4254(167 1/2")',
  "the addendum's printed size is replaced, not merged");
assert.equal(first.restore[0].patch.confirmed, false, "restored rows go back as drafts");
assert.deepEqual(first.cuArt.map((d) => d.action), Array(10).fill("write"),
  "every mark 1-10 gets its cut-sheet drawing");
assert.equal(first.cuArt.find((d) => d.mark === "4").patch.image_page, 2, "mark 4 is on page 2");
assert.deepEqual(first.cuArt.find((d) => d.mark === "4").patch.image_bbox, drawings.cu["4"].bbox);
assert.ok(first.cuArt.every((d) => d.patch.planset_id === CU), "all ten point at the cut sheet");
assert.deepEqual(first.addArt.map((d) => d.action), ["write", "write", "write"], "the Adds get their drawings");
assert.deepEqual(first.addNumbers.map((d) => d.action), ["fill", "fill", "fill"], "the Adds get their printed sizes");
assert.equal(first.addNumbers[0].patch.extra.qty, "1", "a key the row already had is left as it was");
assert.equal(first.addNumbers[0].patch.tempered, true);

// One statement per row, however many rules had something to say about it.
const writes = mergeRowPatches(Object.values(first));
assert.equal(writes.length, 13, "ten marks plus three Adds, one statement each");
assert.equal(new Set(writes.map((w) => w.id)).size, writes.length, "no row is written twice");
const mark1 = writes.find((w) => w.mark === "1");
assert.equal(mark1.patch.width_in, 167.5, "mark 1's text and its drawing land together");
assert.equal(mark1.patch.image_page, 1);
assert.equal(mark1.patch.planset_id, CU);
assert.ok(mark1.patch.extra.pane_grid, "merging the two patches keeps the grid");

// --- re-apply changes nothing ---------------------------------------------
const applied = damaged().map((r) => {
  const w = writes.find((x) => x.id === r.id);
  return w ? { ...r, ...w.patch } : r;
});
const second = planAll(applied);
assert.equal(mergeRowPatches(Object.values(second)).length, 0, "a second run writes nothing");
assert.ok(second.restore.every((d) => d.action === "left alone"), "restored rows are left alone");
assert.ok(second.cuArt.every((d) => d.action === "kept"), "drawings already on the cut sheet are kept");
assert.ok(second.addNumbers.every((d) => d.action === "kept"), "the Adds' numbers are already there");

// --- the two rules that keep a repair from becoming an incident -----------
const ownerFixed = damaged().map((r) => (r.mark_code === "1" ? { ...r, width_in: 167.5, height_in: 143.5 } : r));
const afterOwner = planSpecRestore(ownerFixed, restore);
assert.equal(afterOwner[0].action, "left alone", "a row the owner already put right is not rewritten");
assert.ok(afterOwner[0].why.includes("already put right"));
assert.equal(afterOwner[1].action, "restore", "the other two are still repaired");

const confirmedRows = damaged().map((r) => (r.mark_code === "2" ? { ...r, confirmed: true } : r));
const afterConfirm = planSpecRestore(confirmedRows, restore);
assert.equal(afterConfirm[1].action, "left alone", "a confirmed row is never text-edited");
assert.ok(afterConfirm[1].why.includes("confirmed"));
assert.equal(afterConfirm[1].patch, undefined, "and it carries no patch at all");

// A drawing a person placed on an Add by hand is theirs, wrong sheet or not;
// a mark 1-10 pointing at the wrong sheet is damage and is corrected.
const handPlaced = damaged().map((r) =>
  ADDS.includes(r.mark_code) ? { ...r, planset_id: CU, image_page: 4, image_bbox: [0.1, 0.1, 0.2, 0.2] } : r);
assert.ok(planDrawingWrites(handPlaced, drawings.addendum, ADD).every((d) => d.action === "kept"),
  "a hand-placed Add drawing is left alone");
assert.ok(planDrawingWrites(handPlaced, drawings.cu, CU, { fixWrongSheet: true }).every((d) => d.action === "write"),
  "marks 1-10 whose drawing names the wrong sheet are corrected");

// A row that isn't there yet is reported, never invented.
assert.deepEqual(planSpecRestore([], restore).map((d) => d.action), ["missing", "missing", "missing"]);
assert.deepEqual(planAddFill([], addFill).map((d) => d.action), ["missing", "missing", "missing"]);
assert.deepEqual(planDrawingWrites([], drawings.cu, CU, { fixWrongSheet: true }).map((d) => d.action),
  Array(10).fill("missing"));

// --- fill-missing means missing ------------------------------------------
assert.equal(fillMissingExtra({ printed_width: "already there" }, { printed_width: "new" }), null,
  "nothing to add is null, not an empty write");
const filled = fillMissingExtra({ qty: "2" }, { qty: "1", printed_width: "x" });
assert.deepEqual(filled.added, ["printed_width"], "only the absent key is added");
assert.equal(filled.extra.qty, "2", "the row's own answer stands");
assert.deepEqual(fillMissingExtra(null, { a: 1 }).extra, { a: 1 }, "a null extra is an empty one");

console.log("seed-madmoose-specs-repair: all assertions passed");
