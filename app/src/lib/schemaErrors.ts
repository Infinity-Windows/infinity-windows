/**
 * "The database doesn't have this yet" predicates.
 *
 * Every feature that shipped ahead of its migration guards its reads so the
 * screen degrades to empty instead of crashing. That guard was written by hand
 * in each api module — seventeen copies by the time they were collected here —
 * and they had already drifted apart: some accepted Postgres' own `42P01`
 * alongside PostgREST's `PGRST205`, some only the latter, so the same missing
 * table crashed one screen and quietly emptied another.
 *
 * These are deliberately about the *shape* of a PostgREST error, not its
 * wording, which is why they live apart from the formatApiError modules.
 */

type PostgrestLike = { code?: unknown; message?: unknown };

function shape(err: unknown): PostgrestLike | null {
  if (!err || typeof err !== "object") return null;
  return err as PostgrestLike;
}

function codeOf(err: PostgrestLike): string {
  return typeof err.code === "string" ? err.code : "";
}

function messageOf(err: PostgrestLike): string {
  return typeof err.message === "string" ? err.message.toLowerCase() : "";
}

/** PostgREST "table not in schema cache" and Postgres "undefined_table". */
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

/** PostgREST "column not in schema cache" and Postgres "undefined_column". */
const MISSING_COLUMN_CODES = new Set(["PGRST204", "42703"]);

/** PostgREST "function not found" and Postgres "undefined_function". */
const MISSING_FUNCTION_CODES = new Set(["PGRST202", "42883"]);

/**
 * True when the error means the table isn't there yet.
 *
 * `tables` are substrings of the table names this caller cares about. They are
 * a *widening* hint, not a filter: the error codes above identify a missing
 * relation on their own, and PostgREST doesn't always name the table in a way
 * worth parsing, so a caller naming its tables still catches the generic
 * "relation ... does not exist" wording.
 */
export function isMissingTable(err: unknown, ...tables: string[]): boolean {
  const e = shape(err);
  if (!e) return false;
  if (MISSING_TABLE_CODES.has(codeOf(e))) return true;

  const msg = messageOf(e);
  if (!msg) return false;
  if (tables.some((table) => msg.includes(table.toLowerCase()))) return true;
  return (msg.includes("relation") && msg.includes("does not exist")) || msg.includes("could not find the table");
}

/**
 * True when the table is there but the column isn't — a half-applied migration.
 *
 * Naming a `column` narrows rather than widens: a bare `PGRST204` says only
 * that *some* column is missing, and letting that stand in for a specific one
 * would hide genuine drift elsewhere in the row.
 */
export function isMissingColumn(err: unknown, column?: string): boolean {
  const e = shape(err);
  if (!e) return false;

  const msg = messageOf(e);
  if (column && msg && !msg.includes(column.toLowerCase())) return false;
  if (MISSING_COLUMN_CODES.has(codeOf(e))) return true;
  return msg.includes("column") && msg.includes("does not exist");
}

/** True when an RPC doesn't exist yet. Separate because a missing function is
 * not a missing table: only callers that fall back to a table read want both. */
export function isMissingFunction(err: unknown): boolean {
  const e = shape(err);
  if (!e) return false;
  if (MISSING_FUNCTION_CODES.has(codeOf(e))) return true;
  const msg = messageOf(e);
  return msg.includes("function") && msg.includes("does not exist");
}
