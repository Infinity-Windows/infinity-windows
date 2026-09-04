import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filesOf,
  looksLikeMoneyDocument,
  pullAllowList,
} from "../../../supabase/functions/_shared/mondayFiles.ts";

/**
 * WHO DECIDES WHICH FILE THE SERVER IS ALLOWED TO FETCH.
 *
 * The pull downloads an asset out of another company's Monday account using a
 * token no browser ever sees, so the list of asset ids it will act on is the
 * whole security boundary. The first version of it read `monday_jobs.files` —
 * our own mirror of the board — and that column is writable from the browser by
 * any foreman (the "lead update" policy, 20260812000000). Three lines in a
 * console would have named any asset id, and Monday's asset ids are sequential
 * integers, so the reachable set was every document in STG's account.
 *
 * These are the two rules that replaced it, tested where a test can reach them.
 */
const BOARD = "8185408239";

const item = (over: Record<string, unknown> = {}) => ({
  id: "1",
  board: { id: BOARD },
  files: [
    { id: "3100578592", name: "HC24 - LP.pdf", file_extension: ".pdf", file_size: 17904294, created_at: "2026-07-09T19:10:07Z" },
  ],
  ...over,
});

describe("pullAllowList", () => {
  it("allows exactly what Monday says is on the item", () => {
    const got = pullAllowList(item(), BOARD);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.files.map((f) => f.asset_id)).toEqual(["3100578592"]);
    expect(got.files[0].column_id).toBe("files_1");
    // Never a link: Monday's expires in an hour and a stored one is a live
    // unauthenticated door into another company's paperwork.
    expect(JSON.stringify(got.files)).not.toContain("public_url");
  });

  it("refuses an item on a board this app does not read", () => {
    // `items(ids:)` reaches every board in STG's whole account, so without this
    // an item id typed from somewhere else would be a way in.
    const got = pullAllowList(item({ board: { id: "9999999999" } }), BOARD);
    expect(got).toEqual({ ok: false, reason: "wrong-board" });
  });

  it("refuses an item Monday would not say the board of", () => {
    expect(pullAllowList(item({ board: null }), BOARD)).toEqual({
      ok: false,
      reason: "wrong-board",
    });
    expect(pullAllowList(item({ board: undefined }), BOARD)).toEqual({
      ok: false,
      reason: "wrong-board",
    });
  });

  it("refuses an item Monday no longer has", () => {
    expect(pullAllowList(null, BOARD)).toEqual({ ok: false, reason: "gone" });
    expect(pullAllowList(undefined, BOARD)).toEqual({ ok: false, reason: "gone" });
  });

  it("refuses everything when the board id it is checked against is empty", () => {
    // A missing BOARD_ID must fail closed, not match `item.board.id ?? ""`.
    expect(pullAllowList(item(), "")).toEqual({ ok: false, reason: "wrong-board" });
  });

  it("keeps both file columns apart", () => {
    const got = filesOf({
      id: "1",
      files: [{ id: "1", name: "a.pdf" }],
      measure: [{ id: "2", name: "b.pdf" }],
    });
    expect(got.map((f) => [f.asset_id, f.column_id])).toEqual([
      ["1", "files_1"],
      ["2", "file_mm4wnjn8"],
    ]);
  });
});

describe("looksLikeMoneyDocument", () => {
  it("catches the paperwork with our number on it", () => {
    for (const name of [
      "Estates at Sand Hollow 20 - FINAL - Iron - signed.pdf",
      "SV2 quote.pdf",
      "Summit View - BID.pdf",
      "proposal-rev2.pdf",
      "HC24 invoice.pdf",
      "Tech Ridge change order 3.pdf",
      "Lot 12 - contract.pdf",
      "PO 4471.pdf",
    ]) {
      expect(looksLikeMoneyDocument(name), name).toBe(true);
    }
  });

  it("leaves the crew's own paperwork alone", () => {
    for (const name of [
      "HC24 - IRON.pdf",
      "Summit View 2 - July16_26 - IRON.pdf",
      "SV2 - LP.pdf",
      "SV2 - CU.pdf",
      "site survey.pdf",
      "Measure notes.pdf",
    ]) {
      expect(looksLikeMoneyDocument(name), name).toBe(false);
    }
  });

  it("matches whole words only", () => {
    // Real name shapes: a subdivision, a porch detail, a costume-free world.
    expect(looksLikeMoneyDocument("Quotebridge Estates.pdf")).toBe(false);
    expect(looksLikeMoneyDocument("Porch detail.pdf")).toBe(false);
    expect(looksLikeMoneyDocument("Bidwell Lane 4.pdf")).toBe(false);
    // And the extension is never read as a word.
    expect(looksLikeMoneyDocument("plans.bid")).toBe(false);
  });

  it("survives a name Monday did not give", () => {
    expect(looksLikeMoneyDocument("")).toBe(false);
    expect(looksLikeMoneyDocument(undefined as unknown as string)).toBe(false);
  });
});

/**
 * The rules above are only worth anything if the deployed function actually
 * uses them. A source-contract check, the same shape as mondayReadOnly's: what
 * it catches is somebody restoring the convenient version — reading the file
 * list back out of our own table — which would look perfectly reasonable in a
 * diff and would quietly re-open the whole hole.
 */
describe("monday-sync leans on them", () => {
  const src = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../supabase/functions/monday-sync/index.ts",
    ),
    "utf8",
  );

  it("builds the pull's allow-list from Monday, never from monday_jobs", () => {
    expect(src).toContain("pullAllowList(item, BOARD_ID)");
    // The staged row is read for the link between item and job, and for
    // nothing else — asking it for `files` is what the hole was.
    expect(src).toContain('.select("id, project_id, monday_item_id")');
    expect(src).not.toContain("staged.files");
  });

  it("asks Monday which board the item is on", () => {
    expect(src).toContain("board { id }");
  });
});
