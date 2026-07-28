// Pure helpers for the per-page outcome of a specs VISION extraction.
//
// `extract-specs` reads the specs planset one page at a time. Before this, a
// page whose vision call failed returned an empty list — indistinguishable from
// a page that simply has no marks on it. On the real Smith / PV Townhomes job
// that silence cost mark 18B its elevation drawing, and a re-run that returned
// nothing at all for a whole page looked like success.
//
// The function now reports `{ pageNumber, ok, attempts, markCount, error }` per
// page. Everything here is PURE: parse that untrusted payload, and turn it into
// the one sentence a foreman needs ("Page 5 failed after 3 attempts").

/** What happened on one page of the specs planset during extraction. */
export interface SpecPageStatus {
  /** 1-based page of the specs planset. */
  pageNumber: number;
  /** The last vision attempt completed. `ok` with 0 marks = a genuinely empty sheet. */
  ok: boolean;
  /** Vision calls made for this page (1–3), so we can say "after 3 attempts". */
  attempts: number;
  /** Distinct marks transcribed off this page. */
  markCount: number;
  /** Short, already-sanitized reason. Only set when `ok` is false. */
  error: string | null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce one untrusted page-status object from the edge function. Returns null
 * when there's no usable page number to attach the status to — a malformed
 * status must never break the extraction it describes.
 */
export function parseSpecPageStatus(raw: unknown): SpecPageStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const page = num(o.pageNumber ?? o.page_number ?? o.page);
  if (page == null || !Number.isInteger(page) || page < 1) return null;
  const errorRaw = o.error;
  const error =
    typeof errorRaw === "string" && errorRaw.trim() ? errorRaw.trim() : null;
  return {
    pageNumber: page,
    // Absent `ok` is treated as success: an older function version that doesn't
    // report status must not make every page look broken.
    ok: o.ok == null ? true : Boolean(o.ok),
    attempts: Math.max(0, Math.round(num(o.attempts) ?? 0)),
    markCount: Math.max(0, Math.round(num(o.markCount ?? o.mark_count) ?? 0)),
    error,
  };
}

/** Parse the whole `pages` array, dropping unusable entries, sorted by page. */
export function parseSpecPageStatuses(raw: unknown): SpecPageStatus[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseSpecPageStatus)
    .filter((s): s is SpecPageStatus => s !== null)
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

/** Pages whose vision call never completed — these are the retryable ones. */
export function failedSpecPages(pages: SpecPageStatus[]): SpecPageStatus[] {
  return pages.filter((p) => !p.ok);
}

/**
 * Pages that completed but transcribed nothing. Usually legitimate (a cover or
 * detail sheet), occasionally the model shrugging — worth showing quietly, not
 * as an error.
 */
export function emptySpecPages(pages: SpecPageStatus[]): SpecPageStatus[] {
  return pages.filter((p) => p.ok && p.markCount === 0);
}

/** "5" / "5 and 6" / "5, 6 and 9" — page numbers as a foreman would say them. */
export function formatPageList(pages: SpecPageStatus[]): string {
  const nums = pages.map((p) => String(p.pageNumber));
  if (nums.length === 0) return "";
  if (nums.length === 1) return nums[0];
  return `${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]}`;
}

/**
 * One plain-English sentence about a finished extraction, or null when every
 * page read cleanly and there's nothing worth saying. Deliberately blunt about
 * the failure ("Page 5 failed after 3 attempts") because the whole problem
 * being fixed here was silence.
 */
export function describeSpecPages(pages: SpecPageStatus[]): string | null {
  const failed = failedSpecPages(pages);
  const empty = emptySpecPages(pages);
  if (failed.length === 0 && empty.length === 0) return null;

  const parts: string[] = [];
  if (failed.length > 0) {
    const attempts = Math.max(...failed.map((p) => p.attempts));
    const label = failed.length === 1 ? "Page" : "Pages";
    const tried =
      attempts > 1 ? ` after ${attempts} attempts` : attempts === 1 ? " after 1 attempt" : "";
    parts.push(
      `${label} ${formatPageList(failed)} of the specs sheet failed to read${tried}.`,
    );
  }
  if (empty.length > 0) {
    const one = empty.length === 1;
    parts.push(
      `${one ? "Page" : "Pages"} ${formatPageList(empty)} ${
        one ? "has no marks on it" : "have no marks on them"
      }.`,
    );
  }
  return parts.join(" ");
}
