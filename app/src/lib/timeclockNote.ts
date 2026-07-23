// Pure helpers for the optional clock-in note. Kept free of the Supabase client
// so they stay unit-testable without pulling in the realtime/WebSocket runtime.

/** Trim a worker note down to a clean value, or null when it's blank/empty. */
export function normalizeNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A clock_in error meaning the note-aware overload isn't in the database yet
 * (migration 20260723060000 not applied). We detect it to fall back to a plain
 * punch, rather than treating it as a real failure — clock-in must never break
 * before the migration lands.
 */
export function isMissingClockInOverload(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "PGRST202") return true;
  const raw =
    err instanceof Error
      ? err.message
      : String((err as { message?: unknown })?.message ?? "");
  const msg = raw.toLowerCase();
  return (
    msg.includes("could not find the function") ||
    (msg.includes("does not exist") && msg.includes("function")) ||
    msg.includes("no function matches")
  );
}
