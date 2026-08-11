// Display formatters shared across the timecard surfaces. In their own file
// (not a component module) so fast refresh stays whole-file.

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** 6.05h → "6h 03m"; sub-hour → "45m". The row/day duration format. */
export function fmtHours(hours: number): string {
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}
