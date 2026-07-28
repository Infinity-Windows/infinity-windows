// Human-readable message from Supabase / thrown API errors.
//
// The one hard rule: this must never hand back "[object Object]". That string
// is what the UI showed when a caught PostgREST error was passed through
// `String(err)`, and it tells the crew nothing about what actually failed.

const GENERIC = "Something went wrong";

/** How deep we follow nested `{ error: ... }` wrappers before giving up. */
const MAX_DEPTH = 3;

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stringify(err: unknown): string | null {
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}" && json !== "null" && json !== "[]" && json !== '""') {
      return json;
    }
  } catch {
    /* circular or non-serialisable */
  }
  return null;
}

function describe(err: unknown, depth: number): string | null {
  if (err == null) return null;
  if (typeof err === "string") return err.trim() || null;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  if (err instanceof Error) return firstText(err.message) ?? stringify({ ...err });
  if (typeof err !== "object") return null;

  if (Array.isArray(err)) {
    const parts = err.map((item) => describe(item, depth + 1)).filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  }

  const o = err as Record<string, unknown>;
  const code = firstText(o.code, typeof o.status === "number" ? String(o.status) : null);
  const suffix = (base: string) => {
    const hint = typeof o.hint === "string" && o.hint.trim() ? ` (${o.hint.trim()})` : "";
    return `${base}${hint}${code ? ` [${code}]` : ""}`;
  };

  const message = firstText(o.message, o.error_description, o.msg, o.statusText);
  if (message) return suffix(message);

  // Edge functions wrap the real failure: { error: { message } } / { error: "…" }.
  if (depth < MAX_DEPTH && o.error !== err) {
    const nested = describe(o.error, depth + 1);
    if (nested) return nested;
  }

  const detail = firstText(o.details, o.hint, o.description, o.reason);
  if (detail) return `${detail}${code ? ` [${code}]` : ""}`;
  if (code) return `Request failed [${code}]`;

  return stringify(err);
}

/**
 * Turn any thrown value into something a person can read.
 * @param fallback used when the value carries no usable information at all.
 */
export function formatApiError(err: unknown, fallback = GENERIC): string {
  const text = describe(err, 0);
  if (!text || text.includes("[object Object]")) return fallback || GENERIC;
  return text;
}
