/** Human-readable message from Supabase / thrown API errors. */
export function formatApiError(err: unknown, fallback = "Something went wrong"): string {
  if (err == null) return fallback;
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object") {
    const o = err as {
      message?: unknown;
      error_description?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    const message =
      typeof o.message === "string"
        ? o.message
        : typeof o.error_description === "string"
          ? o.error_description
          : null;
    if (message) {
      const hint = typeof o.hint === "string" && o.hint ? ` (${o.hint})` : "";
      const code = typeof o.code === "string" && o.code ? ` [${o.code}]` : "";
      return `${message}${hint}${code}`;
    }
  }
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}" && json !== "null") return json;
  } catch {
    /* ignore */
  }
  return fallback;
}
