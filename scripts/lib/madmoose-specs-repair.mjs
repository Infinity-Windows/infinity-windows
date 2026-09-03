// Pure helpers for scripts/seed-madmoose-specs-repair.mjs, split out (same
// reason as madmoose-seed.mjs) so the test can import them without the
// script's top-level I/O and plan-mode process.exit running as a side effect.
//
// The damage these rules undo is data, not code (Mad Moose, 2026-09-01 18:24):
// an addendum cut sheet was extracted before the mark-prefix fix landed, so
// its three "Add-1/2/3" units were read as marks "1/2/3" and UPSERTED over the
// job's real rows 1, 2 and 3 — line items, printed sizes, panels, planset and
// drawing box all replaced. The same upload's retire step then nulled
// image_page/image_bbox on marks 4-10, because those coordinates belonged to
// the ORIGINAL cut sheet and the retire step only knew about one specs sheet
// per job.
//
// Not one number lives here. Every value is in
// app/src/lib/fitview/fixtures/madmoose-mm2.json (specPlansets / specDrawings /
// specRestore / specAddFill); these functions only hold the rules for putting
// one back, so the numbers can be checked in one place by a person reading the
// sheets.

// Widths come back from PostgREST as JSON numbers off a `numeric` column, so
// compare them the way inches are actually equal rather than by identity.
const IN_TOLERANCE = 0.001;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function asObject(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function indexByMark(rows) {
  const byMark = new Map();
  for (const row of rows ?? []) {
    if (row && typeof row.mark_code === "string") byMark.set(row.mark_code, row);
  }
  return byMark;
}

/**
 * The name a stored planset was uploaded under. `uploadPlanset` stores every
 * file at `<project id>/<timestamp>-<file name>`, so the last path segment is
 * the name the person who uploaded it would recognise.
 */
function fileNameOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Resolve the two specs sheets this job carries at once, by a fragment of
 * their file name.
 *
 * Ids are deliberately NOT constants: a planset id is only right until someone
 * re-uploads the file, and a seed that writes drawing coordinates against a
 * stale id points every crop at the wrong window — the exact failure
 * `isDrawingStale` exists to prevent. Missing or ambiguous is a refusal, never
 * a guess: writing coordinates onto the wrong sheet is worse than writing
 * nothing.
 *
 * A FRAGMENT, and not the tail, because a real path never ends in one. Stored
 * names keep their extension — `uploadPlanset` refuses anything but .pdf/.dwg/
 * .dxf — while the fragments in the fixture are the opening characters of the
 * names as the planset list prints them, truncated and extensionless. Matching
 * on the tail therefore found NOTHING on the live job: the first version of
 * this seed refused to run every time, and its test hid that by handing the
 * matcher two paths with the extension stripped off. Pure; tested.
 */
export function resolveSpecPlansets(rows, plansets) {
  const pick = (label, fragment) => {
    const hits = (rows ?? []).filter(
      (r) => typeof r?.storage_path === "string" && fileNameOf(r.storage_path).includes(fragment),
    );
    if (hits.length === 0) {
      throw new Error(
        `No ${label} on this project: no file name contains "${fragment}". Nothing was written.`,
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `${hits.length} plansets have a file name containing "${fragment}" (${hits.map((h) => h.id).join(", ")}). ` +
          `Which one the drawings live on would be a guess, so nothing was written.`,
      );
    }
    return hits[0];
  };
  const cu = pick("cut sheet", plansets.cu.pathFragment);
  const addendum = pick("addendum sheet", plansets.addendum.pathFragment);
  if (cu.id === addendum.id) {
    throw new Error(
      "The cut sheet and the addendum resolved to the SAME planset row — the file paths no longer tell the two sheets apart. Nothing was written.",
    );
  }
  return { cu, addendum };
}

/**
 * What is wrong with the live planset row a fragment resolved to, as plain
 * sentences (empty means it is the sheet these boxes were read off).
 *
 * `checkDrawingTable` cannot do this job. It compares the fixture's page
 * numbers against the fixture's own page count, written two lines above them,
 * so it passes by construction. The count that decides anything is the one on
 * the row in the database: if someone has re-uploaded a revised one-page cut
 * sheet under the same name, page 3 of "the cut sheet" is now either missing or
 * a different unit, and writing `image_page: 3` onto marks 7-10 takes their
 * drawing away again — the exact damage this repair exists to undo. An unknown
 * page count is refused for the same reason: nothing can be checked, and a
 * confident picture of the wrong window is worse than no picture.
 *
 * `kind` and renderability are here because they are the app's own two tests
 * for a sheet it can draw from: `findSpecsPlansets` (app/src/lib/install/api.ts)
 * keeps a planset only when it is filed under "specs" AND
 * `plansetIsViewable` — a PDF, or something converted to one. A sheet failing
 * either is not in the set `isDrawingStale` checks against and is not what
 * `findSpecsPlansetFor` will return, so coordinates written onto it are honest
 * and permanently invisible: it reads to whoever ran this as "the log said 13
 * rows updated and nothing changed on any phone". Pure; tested.
 */
export function checkLiveSheet(label, row, expected) {
  const problems = [];
  const pageWord = (n) => `${n} page${n === 1 ? "" : "s"}`;
  const kind = row?.kind ?? "building";
  if (kind !== "specs") {
    problems.push(
      `the ${label} is filed as "${kind}", not a specs sheet — the app only ever draws from specs sheets`,
    );
  }
  if (!row?.converted_pdf_path && row?.source_format !== "pdf") {
    problems.push(
      `the ${label} is not a PDF the app can render (no converted copy, source format ` +
        `"${row?.source_format ?? "unknown"}") — the spec card would never draw these boxes`,
    );
  }
  const pages = row?.page_count;
  if (pages == null) {
    problems.push(
      `the ${label} has no page count recorded, so there is no telling whether it is still the ` +
        `${pageWord(expected.pages)} these boxes were read off`,
    );
  } else if (pages !== expected.pages) {
    problems.push(
      `the ${label} has ${pageWord(pages)}, not the ${pageWord(expected.pages)} these boxes were ` +
        `read off — it is a different edition of ${expected.label}`,
    );
  }
  return problems;
}

/**
 * Why a normalized box is unusable, or null when it is fine. Same rules the app
 * applies in `validateBbox` (four finite numbers inside the page, positive
 * width and height) minus the area limits, which are the vision pass's problem
 * and not a hand-read sheet's. Pure.
 */
export function bboxProblem(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return "is not four numbers";
  if (!bbox.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) {
    return "has a corner outside the page (0-1)";
  }
  const [x0, y0, x1, y1] = bbox;
  if (x1 <= x0) return "has zero or negative width";
  if (y1 <= y0) return "has zero or negative height";
  return null;
}

/** True when two boxes on the SAME page share any area. Pure. */
export function boxesOverlap(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/**
 * Everything wrong with a whole drawing table, as plain sentences (empty means
 * it is sound). The seed runs this before it opens a connection: a mistyped
 * corner or two marks claiming the same patch of paper means someone would be
 * handed a picture of the wrong window, and that is worth refusing over. Pure;
 * tested.
 */
export function checkDrawingTable(table, pageCount) {
  const problems = [];
  const entries = Object.entries(table ?? {});
  for (const [mark, spot] of entries) {
    const problem = bboxProblem(spot?.bbox);
    if (problem) problems.push(`mark ${mark}: box ${problem}`);
    if (!Number.isInteger(spot?.page) || spot.page < 1) {
      problems.push(`mark ${mark}: page ${spot?.page} is not a page number`);
    } else if (pageCount != null && spot.page > pageCount) {
      problems.push(`mark ${mark}: page ${spot.page} is past the end of a ${pageCount}-page sheet`);
    }
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [markA, a] = entries[i];
      const [markB, b] = entries[j];
      if (a?.page !== b?.page) continue;
      if (bboxProblem(a?.bbox) || bboxProblem(b?.bbox)) continue;
      if (boxesOverlap(a.bbox, b.bbox)) {
        problems.push(`marks ${markA} and ${markB} claim the same part of page ${a.page}`);
      }
    }
  }
  return problems;
}

/** A row has a drawing when its stored box is one a crop could actually use. */
function hasUsableBbox(row) {
  return row?.image_bbox != null && bboxProblem(row.image_bbox) == null;
}

/**
 * What to write so each mark's drawing points at the right sheet again.
 *
 * Two policies, because the two sheets got into their state two different ways:
 *   • `fixWrongSheet` (the cut sheet's marks 1-10) — the retire step nulled
 *     these, and the addendum upsert pointed 1/2/3 at the addendum. A box that
 *     names the wrong sheet is damage, so it is corrected.
 *   • without it (the Adds) — these rows were typed by hand and never had
 *     coordinates. A box already on one of them was put there by a person, and
 *     a repair script does not overrule a person; only an empty one is filled.
 * A row already pointing at this sheet with a usable box is never touched
 * either way, which is what makes a second run a no-op. Pure; tested.
 */
export function planDrawingWrites(rows, table, plansetId, options = {}) {
  const fixWrongSheet = options.fixWrongSheet === true;
  const byMark = indexByMark(rows);
  return Object.entries(table ?? {}).map(([mark, spot]) => {
    const row = byMark.get(mark);
    if (!row) return { mark, action: "missing", why: "no spec row on the project" };
    const boxed = hasUsableBbox(row);
    const onThisSheet = row.planset_id === plansetId;
    if (boxed && onThisSheet) {
      return { mark, id: row.id, action: "kept", why: "already drawn on this sheet" };
    }
    if (boxed && !fixWrongSheet) {
      return { mark, id: row.id, action: "kept", why: "someone already placed this drawing by hand" };
    }
    return {
      mark,
      id: row.id,
      action: "write",
      why: boxed ? "its drawing points at the other sheet" : "it has no drawing",
      patch: {
        planset_id: plansetId,
        image_page: spot.page,
        image_bbox: clone(spot.bbox),
      },
    };
  });
}

/**
 * Put the addendum's keys back where the cut sheet's belong, keeping whatever
 * else the row carries — above all `pane_grid`, which survived the incident
 * because the extractor fills that key only when it is missing (the wave-G
 * law) and is the one piece of these rows nobody has to re-read. Pure.
 */
export function restoredExtra(extraRaw, wanted) {
  return { ...asObject(extraRaw), ...clone(wanted) };
}

/**
 * Restore marks 1/2/3's line items — but only for a row that is still visibly
 * wrong.
 *
 * The addendum's own width is the tell, and it is a good one: nothing else on
 * this job is 129 1/2, 175 1/2 or 134 1/2 inches wide. A row that no longer
 * carries it has been put right by the owner already, and a confirmed row is
 * one a person has signed for — a repair script silently rewriting either is
 * how a data fix turns into a second incident. Pure; tested.
 */
export function planSpecRestore(rows, table) {
  const byMark = indexByMark(rows);
  return Object.entries(table ?? {}).map(([mark, entry]) => {
    const row = byMark.get(mark);
    if (!row) return { mark, action: "missing", why: "no spec row on the project" };
    if (row.confirmed) {
      return { mark, id: row.id, action: "left alone", why: "confirmed — a person signed for these numbers" };
    }
    const width = Number(row.width_in);
    if (!Number.isFinite(width) || Math.abs(width - entry.addendumWidthIn) > IN_TOLERANCE) {
      return {
        mark,
        id: row.id,
        action: "left alone",
        why: `width reads ${row.width_in ?? "blank"} in, not the addendum's ${entry.addendumWidthIn} — already put right`,
      };
    }
    const { addendumWidthIn, extra, ...columns } = entry;
    return {
      mark,
      id: row.id,
      action: "restore",
      why: `still carries the addendum's ${addendumWidthIn} in`,
      patch: { ...clone(columns), extra: restoredExtra(row.extra, extra) },
    };
  });
}

/**
 * Add the keys a row is missing and nothing else, or null when it is missing
 * none. A key that is present — even an empty string a person typed — is the
 * row's own answer and stays. Pure; tested.
 */
export function fillMissingExtra(extraRaw, fill) {
  const extra = asObject(extraRaw);
  const added = Object.keys(fill ?? {}).filter((k) => extra[k] == null);
  if (added.length === 0) return null;
  const next = { ...extra };
  for (const k of added) next[k] = clone(fill[k]);
  return { extra: next, added };
}

/**
 * The Adds' printed sizes and panel splits, fill-missing only. These three rows
 * were typed by hand while the real ones were being repaired, so they carry
 * correct text and no numbers; they are also `confirmed`, which is exactly why
 * nothing here edits their words — it only adds what a blank field would have
 * held. Pure; tested.
 */
export function planAddFill(rows, table) {
  const byMark = indexByMark(rows);
  return Object.entries(table ?? {}).map(([mark, entry]) => {
    const row = byMark.get(mark);
    if (!row) {
      return { mark, action: "missing", why: "no spec row — register the Adds first" };
    }
    const patch = {};
    const reasons = [];
    const filled = fillMissingExtra(row.extra, entry.extra);
    if (filled) {
      patch.extra = filled.extra;
      reasons.push(filled.added.join(", "));
    }
    if (entry.tempered != null && row.tempered == null) {
      patch.tempered = entry.tempered;
      reasons.push("tempered");
    }
    if (Object.keys(patch).length === 0) {
      return { mark, id: row.id, action: "kept", why: "every number is already there" };
    }
    return { mark, id: row.id, action: "fill", why: `missing ${reasons.join(", ")}`, patch };
  });
}

/**
 * One UPDATE per row, however many rules had something to say about it.
 *
 * Marks 1/2/3 need both their line items and their drawing back; writing those
 * as two statements would leave a window where the row holds the cut sheet's
 * text and the addendum's picture, which is the same confusing half-state this
 * whole repair exists to clear. `extra` is merged rather than replaced so two
 * rules can never quietly drop each other's keys. Pure; tested.
 */
export function mergeRowPatches(plans) {
  const byId = new Map();
  for (const decision of plans.flat()) {
    if (!decision?.patch || !decision.id) continue;
    const prev = byId.get(decision.id);
    if (!prev) {
      byId.set(decision.id, {
        id: decision.id,
        mark: decision.mark,
        patch: { ...decision.patch },
      });
      continue;
    }
    const extra =
      prev.patch.extra || decision.patch.extra
        ? { ...asObject(prev.patch.extra), ...asObject(decision.patch.extra) }
        : undefined;
    prev.patch = { ...prev.patch, ...decision.patch };
    if (extra) prev.patch.extra = extra;
  }
  return [...byId.values()];
}
