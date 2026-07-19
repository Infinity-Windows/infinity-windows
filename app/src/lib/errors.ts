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
 * Translate an API/Supabase error into a short, plain-English sentence.
 * @param fallback used when we can't recognise the error at all.
 */
export function formatApiError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  const rec = asRecord(err);
  const raw = rawErrorMessage(err);
  const lower = raw.toLowerCase();
  const code = rec && typeof rec.code === "string" ? rec.code : "";

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
