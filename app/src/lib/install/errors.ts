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

/**
 * Error types the JavaScript engine itself raises. These mean "this code has a
 * bug", never "here is what went wrong with your request", so their text is
 * meaningless — and alarming — to an installer holding a phone.
 */
const INTERNAL_ERROR_NAMES = new Set([
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "InternalError",
]);

/**
 * Wording only an engine produces. Checked as well as the error NAME because a
 * library often catches an internal fault and rethrows it as a plain `Error`,
 * which would otherwise sail through with its text intact.
 */
const INTERNAL_ERROR_PATTERNS = [
  /\bis not a function\b/i,
  /\bis not iterable\b/i,
  /\bis not a constructor\b/i,
  /\bcannot read propert/i,
  /\bundefined is not an object\b/i,
  /\bnull is not an object\b/i,
  /\bis not defined\b/i,
  /\bunexpected token\b/i,
  /\bmaximum call stack\b/i,
];

/** True when a thrown value is a programming fault rather than a message. */
export function isInternalJsError(err: unknown): boolean {
  if (err instanceof Error && INTERNAL_ERROR_NAMES.has(err.name)) return true;
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : null;
  return text ? INTERNAL_ERROR_PATTERNS.some((re) => re.test(text)) : false;
}

/**
 * A message safe to show a crew member on a job site.
 *
 * `formatApiError` deliberately surfaces whatever text an error carries, which
 * is right for a Supabase failure ("permission denied for table …" tells a lead
 * something) and wrong for an internal fault. An iPhone once showed installers
 * `undefined is not a function (near '...e of t...')` where the plan should
 * have been; that tells them nothing they can act on and looks like the app is
 * broken beyond use. Internal faults collapse to the caller's plain sentence
 * instead, while real API messages still come through.
 */
export function formatFieldError(err: unknown, fallback: string): string {
  const safeFallback = fallback.trim() || GENERIC;
  if (isInternalJsError(err)) return safeFallback;
  const text = formatApiError(err, safeFallback);
  return isInternalJsError(text) ? safeFallback : text;
}
