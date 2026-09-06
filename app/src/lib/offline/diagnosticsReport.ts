// The text a person copies out of /diagnostics and pastes into a message.
// Pure, so the wording is tested and the screen only collects the facts.

import type { SavedJobRecord } from "./jobPack";
import { summarizeOfflineEvents, type OfflineEvent } from "./telemetry";

export interface DiagnosticsFacts {
  buildId: string;
  builtAt: string;
  supabaseHost: string;
  online: boolean;
  weak: boolean;
  lastOkAt: number | null;
  queues: { label: string; pending: number; failed: number }[];
  savedJobs: { name: string; record: SavedJobRecord }[];
  events: readonly OfflineEvent[];
  now: number;
}

function ago(at: number | null, now: number): string {
  if (!at) return "never";
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

/** Plain text, one fact per line, newest event first. PURE. */
export function buildDiagnosticsReport(f: DiagnosticsFacts): string {
  const s = summarizeOfflineEvents(f.events);
  const lines: string[] = [
    `Forge diagnostics ${stamp(f.now)}`,
    `Build ${f.buildId || "unknown"}${f.builtAt ? ` built ${f.builtAt}` : ""}`,
    `Database ${f.supabaseHost || "unknown"}`,
    `Connection: ${f.online ? (f.weak ? "weak signal" : "online") : "offline"}; last good request ${ago(f.lastOkAt, f.now)}`,
    "",
    "Waiting to send:",
    ...f.queues.map((q) => `  ${q.label}: ${q.pending} pending${q.failed ? `, ${q.failed} need attention` : ""}`),
    "",
    `Jobs saved on this phone: ${f.savedJobs.length}`,
    ...f.savedJobs.map(
      (j) =>
        `  ${j.name}: ${ago(j.record.at, f.now)} (${j.record.specs} specs, ${j.record.plansets} sheets, ${j.record.drawings} pictures${j.record.failed ? `, ${j.record.failed} missing` : ""})`,
    ),
    "",
    `This session: ${s.timeouts} timeouts, ${s.savedCopies} saved-copy screens, ${s.flushes} flushes sent ${s.sent}, ${s.savedJobs} jobs saved, ${s.reloads} reloads`,
    "Recent events (newest first):",
    ...f.events.slice(0, 60).map(
      (e) => `  ${stamp(e.at)} ${e.type}${e.scope ? ` ${e.scope}` : ""}${e.count != null ? ` ×${e.count}` : ""}${e.message ? ` — ${e.message}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
