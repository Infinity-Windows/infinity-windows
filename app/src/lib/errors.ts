// Human-readable error messages. Supabase / Postgres errors are technical and
// often leak SQL details; `formatApiError` turns the common ones into plain
// English a non-technical installer or office user can act on. Anything we
// don't recognise falls back to a friendly generic line (never a raw stack).

interface SupabaseLikeError {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  error_description?: unknown;
  status?: unknown;
}

function asRecord(err: unknown): SupabaseLikeError | null {
  return err && typeof err === "object" ? (err as SupabaseLikeError) : null;
}

/** Best-effort raw message string from an unknown thrown value. */
export function rawErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const rec = asRecord(err);
  if (rec) {
    if (typeof rec.message === "string") return rec.message;
    if (typeof rec.error_description === "string") return rec.error_description;
  }
  return "";
}

/**
 * PostgREST codes that mean the REQUEST WE WROTE is wrong — an ambiguous
 * embed, an unknown column, a stale schema cache. They are our bugs, not
 * anything the user did, and their wording is meaningless in the field.
 */
const OUR_FAULT_CODES = new Set([
  "PGRST100", // failed to parse the query
  "PGRST200", // no relationship found between two tables
  "PGRST201", // more than one relationship found — the embed is ambiguous
  "PGRST202", // function not found in the schema cache
  "PGRST203", // overloaded function is ambiguous
  "PGRST204", // column not found in the schema cache
]);

/** Same faults, matched on wording, since not every layer preserves the code. */
const OUR_FAULT_PATTERNS = [
  /could not embed/i,
  /more than one relationship was found/i,
  /could not find a relationship/i,
  /schema cache/i,
  /(column|relation|function) .* does not exist/i,
];

const OUR_FAULT_MESSAGE =
  "We couldn't load this — that's a fault on our side, not something you did.";

/** Report-once, so a failing screen doesn't flood the console as it re-renders. */
const reported = new Set<string>();

function isOurFault(code: string, raw: string): boolean {
  if (code && OUR_FAULT_CODES.has(code)) return true;
  return raw ? OUR_FAULT_PATTERNS.some((re) => re.test(raw)) : false;
}

/**
 * Translate an API/Supabase error into a short, plain-English sentence.
 * @param fallback used when we can't recognise the error at all.
 */
export function formatApiError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  const rec = asRecord(err);
  const raw = rawErrorMessage(err);
  const lower = raw.toLowerCase();
  const code = rec && typeof rec.code === "string" ? rec.code : "";

  // Our own broken query. Keep the real text for us, show a plain line to them.
  if (isOurFault(code, raw)) {
    const key = `${code}:${raw}`;
    if (!reported.has(key)) {
      reported.add(key);
      console.error("[query fault]", code || "(no code)", raw, err);
    }
    return OUR_FAULT_MESSAGE;
  }

  // Network / offline.
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    lower.includes("load failed")
  ) {
    return "You appear to be offline. Check your connection and try again.";
  }

  // Auth / session.
  if (
    lower.includes("jwt") ||
    lower.includes("invalid login") ||
    lower.includes("not authenticated") ||
    rec?.status === 401
  ) {
    return "Your session expired. Please sign in again.";
  }
  if (lower.includes("permission") || lower.includes("row-level security") || code === "42501" || rec?.status === 403) {
    return "You don't have permission to do that.";
  }

  // Common Postgres constraint violations.
  if (code === "23505" || lower.includes("duplicate key")) {
    return "That already exists.";
  }
  if (code === "23503" || lower.includes("foreign key")) {
    return "That's still linked to something else, so it can't be changed yet.";
  }
  if (code === "23502" || lower.includes("not-null")) {
    return "Something required is missing. Please fill in all fields.";
  }

  // Toolbox / clock gates surfaced from the server keep their message if short.
  if (raw && raw.length <= 140 && !lower.includes("error:") && !/[{}]/.test(raw)) {
    return raw;
  }

  return fallback;
}
