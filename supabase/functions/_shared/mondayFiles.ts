// What Monday says is attached to an item, and who is allowed to have it.
//
// Shared rather than inlined in monday-sync because two of the three decisions
// here are SECURITY decisions, and a security decision that lives inside an
// edge function is a decision no test can reach. `npm test` runs in the app;
// Deno functions are only ever deployed. Everything in this file is pure, has
// no Deno API in it, and is imported by both sides — the same shape
// _shared/estimate.ts and _shared/spendGuard.ts already use.
//
// THE BOARD BELONGS TO STG WINDOWS. Nothing here writes anything anywhere.

/**
 * The board's two file columns, verified against the live board on 2026-09-04.
 *
 * "Files" (files_1) is where the office puts a job's paperwork and carries 1-4
 * PDFs on every sampled row; "Measure files" (file_mm4wnjn8) is empty today but
 * is the column a site survey would land in, so it is read from the start
 * rather than discovered missing later.
 */
export const FILES_COLUMN_ID = "files_1";
export const MEASURE_COLUMN_ID = "file_mm4wnjn8";

/** One asset as Monday describes it. No download link — see `StagedFile`. */
export interface MondayAsset {
  id: string;
  name?: string | null;
  file_extension?: string | null;
  file_size?: number | null;
  created_at?: string | null;
}

/**
 * The part of a Monday item this file cares about.
 *
 * `board` is optional because only `items(ids:)` is asked for it — a read of
 * `boards(ids:)` is already scoped to one board and has nothing to prove.
 */
export interface MondayFileItem {
  id: string;
  board?: { id: string } | null;
  /** Aliased `assets(column_ids: ["files_1"])`. */
  files?: MondayAsset[] | null;
  /** Aliased `assets(column_ids: ["file_mm4wnjn8"])`. */
  measure?: MondayAsset[] | null;
}

/** One entry in monday_jobs.files — see the migration for why no public_url. */
export interface StagedFile {
  asset_id: string;
  name: string;
  ext: string | null;
  size: number | null;
  column_id: string;
  uploaded_at: string | null;
}

/** Everything Monday says is attached to an item, in board order per column. */
export function filesOf(item: MondayFileItem): StagedFile[] {
  const out: StagedFile[] = [];
  const take = (assets: MondayAsset[] | null | undefined, columnId: string) => {
    for (const a of assets ?? []) {
      if (!a?.id) continue;
      out.push({
        asset_id: String(a.id),
        name: a.name ?? "",
        ext: a.file_extension ?? null,
        size: typeof a.file_size === "number" ? a.file_size : null,
        column_id: columnId,
        uploaded_at: a.created_at ?? null,
      });
    }
  };
  take(item.files, FILES_COLUMN_ID);
  take(item.measure, MEASURE_COLUMN_ID);
  return out;
}

/** Why a pull was refused before a single byte moved. */
export type PullRefusal = "gone" | "wrong-board";

/**
 * The only asset ids a pull may fetch, straight from Monday's own answer.
 *
 * THIS IS THE WHOLE OF THE ALLOW-LIST, and it deliberately does not read one
 * field out of our own database. `monday_jobs.files` is a mirror of somebody
 * else's board and the table's "lead update" policy lets any foreman rewrite
 * the row from a browser console; a list of asset ids the caller can write is
 * not an allow-list, and `assets(ids:)` on Monday is account-wide with
 * sequential integer ids behind it. Sourced from the board, the worst a foreman
 * can do is ask for a file that really is on the job's own Monday item.
 *
 * The board check is the second half and matters just as much: the pull finds
 * its item with `items(ids:)`, which reaches every board in STG's account, so
 * an item id from some other client's board would otherwise be a way in.
 */
export function pullAllowList(
  item: MondayFileItem | null | undefined,
  boardId: string,
): { ok: true; files: StagedFile[] } | { ok: false; reason: PullRefusal } {
  if (!item) return { ok: false, reason: "gone" };
  if (!boardId || String(item.board?.id ?? "") !== boardId) {
    return { ok: false, reason: "wrong-board" };
  }
  return { ok: true, files: filesOf(item) };
}

/**
 * Does this file's name read like a price?
 *
 * The money wall (CONTEXT.md, wave Z) is the settled rule that a price, a
 * margin or a cost is not something the whole crew sees — it moved off the rank
 * ladder onto an explicit grant, `can_see_costs`, precisely because "every crew
 * phone could read the company's bids". A job document pulled from Monday can
 * be exactly that: "Estates at Sand Hollow 20 - FINAL - Iron - signed.pdf" is a
 * signed quote with our number on it, while "HC24 - IRON.pdf" beside it is the
 * ironwork order a foreman needs on the site.
 *
 * So the pull sorts them, and gets to be WRONG SAFELY in one direction only: a
 * word that might mean money makes the document office-only, and the crew's
 * ordinary paperwork is everything left over. Being wrong here costs a foreman
 * a phone call; being wrong the other way puts the company's bid on every phone
 * on the site.
 *
 * Whole words, so "quote" is not found inside a subdivision called "Quotebridge"
 * and "PO" is not found inside "Porch". The extension is stripped first so
 * ".inv" can never read as the word "inv".
 */
export function looksLikeMoneyDocument(name: string): boolean {
  const base = String(name ?? "").replace(/\.[^.]*$/, "");
  return /\b(quote|quotes|quoted|bid|bids|proposal|proposals|estimate|estimates|invoice|invoices|invoiced|signed|contract|contracts|agreement|pricing|price|prices|priced|cost|costs|payment|payments|deposit|invoicing|po|change\s*order)\b/i
    .test(base);
}
