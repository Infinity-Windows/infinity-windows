export type WorkFacts = Partial<
  Record<"width_in" | "height_in" | "weight_lb" | "equipment_minutes", number>
> &
  Partial<
    Record<
      | "story"
      | "location"
      | "material"
      | "electrical"
      | "complexity"
      | "access"
      | "equipment_needed"
      | "equipment"
      | "note"
      | "named_helpers"
      | "area_source"
      | "installation_complete"
      | "opening_direction"
      | "direction_viewpoint"
      | "measurement_source",
      string
    >
  > & {
    /** Pieces inside this one unit (panels, frame), from Forge AI or the editor. */
    components?: { label: string; quantity: number }[];
    /** Details the worker said they do not know — distinct from never asked. */
    unknown_fields?: string[];
  };

export const FACT_LABELS: Record<string, string> = {
  width_in: "Width (in)",
  height_in: "Height (in)",
  weight_lb: "Weight (lb)",
  story: "Story / floor",
  location: "Location",
  material: "Frame material",
  electrical: "Electrical components",
  complexity: "Complexity",
  access: "Access",
  equipment_needed: "Equipment needed",
  equipment: "Equipment",
  equipment_minutes: "Equipment minutes",
  named_helpers: "Helper names",
  area_source: "Size source",
  installation_complete: "Whole install complete",
  note: "Description",
  components: "Components",
  opening_direction: "Opening direction",
  direction_viewpoint: "Direction viewed from",
  measurement_source: "Size as spoken",
  unknown_fields: "Said unknown",
};

/** One fact as plain text. Arrays and objects (components, unknowns) are
 * written out rather than handed to React, which cannot render an object. */
export function factText(key: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (key === "components" && Array.isArray(value))
    return value.map((c) => (c && typeof c === "object" ? `${(c as { quantity?: unknown }).quantity ?? "?"} × ${(c as { label?: unknown }).label ?? ""}` : String(c))).join(", ");
  if (key === "unknown_fields" && Array.isArray(value))
    return value.map((k) => FACT_LABELS[String(k)] ?? (String(k) === "type_label" ? "Type" : String(k).replaceAll("_", " "))).join(", ");
  if (Array.isArray(value)) return value.map((v) => factText("", v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
export interface WorkUnit {
  id: string;
  project_id: string | null;
  opening_id: string | null;
  created_by: string;
  label: string;
  type_label: string;
  facts: WorkFacts;
  legacy_time_present?: boolean;
  untimed_work_present?: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface WorkSession {
  id: string;
  profile_id: string;
  shift_id: string;
  project_id: string | null;
  unit_id: string | null;
  kind: "unit" | "idle";
  participation: "install" | "helper";
  stage: string;
  description: string;
  outcome: "finished" | "partial" | "blocked" | "rework" | null;
  delay_reason: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  revision: number;
  shift_status?: string;
  review_required?: boolean;
}
export interface WorkType {
  id: string;
  label: string;
  archived: boolean;
  revision: number;
}
export interface WorkHistory {
  id: number;
  project_id: string | null;
  actor_id: string;
  entity_id: string;
  action: string;
  reason: string;
  before_value: unknown;
  after_value: unknown;
  created_at: string;
}
export type WorkAction =
  "unit" | "link" | "start" | "stop" | "session" | "type" | "crew_record";
export interface WorkCommand {
  id: string;
  userId: string;
  action: WorkAction;
  data: Record<string, unknown>;
  error?: string;
  /** Client-only, never sent: this unit save is a "Unit complete" mark, so a
   * refusal because someone else changed the unit can be rebuilt from the
   * latest copy instead of stranding the completion (queue.ts). */
  intent?: "complete-unit";
  /** Set once a completion has been rebuilt, so it is rebuilt at most once. */
  rebased?: boolean;
}
/**
 * Prep time's one-tap reasons (crew redesign K1.5, 2026-09-23): job work
 * that isn't on one unit. Stored as the session's description, in English,
 * whatever language the phone speaks — reports and the AI read one word.
 * "Waiting on material / equipment / opening not ready" left this list on
 * purpose: waiting on an outside cause is a BLOCK on the unit, not prep time.
 * The stored stage identifier for these sessions is still "Idle time";
 * only what the screen calls it changed.
 */
export const PREP_REASONS = ["Gathering", "Hauling", "Setup", "Errand", "Cleanup", "Other"] as const;
export type PrepReason = (typeof PREP_REASONS)[number];
/** The classic Current Work chips read the same six, so the two screens agree. */
export const IDLE_REASONS: readonly string[] = PREP_REASONS;
export const WORK_STAGES = [
  "Installing",
  "Preparation",
  "Flashing",
  "Setting frame",
  "Glazing",
  "Hardware",
  "Detail work",
  "Rework",
];
export function areaSqf(u: WorkUnit): number | null {
  const { width_in: w, height_in: h } = u.facts;
  return w && h && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? (w * h) / 144
    : null;
}
export function seconds(s: WorkSession, now = Date.now()): number {
  return Math.max(
    0,
    ((s.ended_at ? Date.parse(s.ended_at) : now) - Date.parse(s.started_at)) /
      1000,
  );
}
export function clockText(value: number): string {
  const n = Math.max(0, Math.floor(value));
  return `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
/** A union for one worker; overlapping imported intervals never inflate labor. */
export function unionSeconds(rows: WorkSession[]): number {
  const ranges = rows
    .filter((r) => r.ended_at)
    .map((r) => [Date.parse(r.started_at), Date.parse(r.ended_at!)])
    .filter(([a, b]) => Number.isFinite(a) && b >= a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    end = -Infinity;
  for (const [a, b] of ranges) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total / 1000;
}
export function workerSeconds(rows: WorkSession[]): number {
  const workers = [...new Set(rows.map((r) => r.profile_id))];
  return workers.reduce(
    (sum, id) => sum + unionSeconds(rows.filter((r) => r.profile_id === id)),
    0,
  );
}
export function unitSummary(unit: WorkUnit, sessions: WorkSession[]) {
  const rows = sessions.filter((s) => s.unit_id === unit.id);
  const area = areaSqf(unit);
  const finished = unit.facts.installation_complete === "Yes";
  const running = rows.some((s) => !s.ended_at);
  const labor = workerSeconds(rows);
  const review = rows.some(
    (s) =>
      s.review_required ||
      s.end_reason === "needs_review" ||
      seconds(s) > 16 * 3600 ||
      !["submitted", "approved"].includes(s.shift_status ?? "open"),
  );
  const ready =
    !!unit.project_id &&
    !unit.legacy_time_present &&
    !unit.untimed_work_present &&
    !review &&
    !!area &&
    unit.type_label.trim().toLowerCase() !== "unknown" &&
    finished &&
    !running &&
    labor > 0;
  return {
    area,
    finished,
    running,
    labor,
    ready,
    review,
    hoursPerSqf: ready ? labor / 3600 / area! : null,
  };
}
/** Preview commands while disconnected; the server remains authoritative after sync. */
export function previewCommands(
  units: WorkUnit[],
  sessions: WorkSession[],
  commands: WorkCommand[],
) {
  const us = new Map(units.map((u) => [u.id, { ...u }]));
  const ss = new Map(sessions.map((s) => [s.id, { ...s }]));
  for (const c of commands) {
    const d = c.action === "crew_record" ? {
      ...c.data.unit as Record<string, unknown>,
      ...((c.data.outcome !== "assigned") ? { untimed_work_present: true } : {}),
      ...(c.data.whole_complete ? { facts: { ...(c.data.unit as WorkUnit).facts, installation_complete: "Yes" } } : {}),
    } : c.data;
    if (c.action === "unit" || c.action === "link" || c.action === "crew_record") {
      const id = String(d.id),
        old = us.get(id);
      us.set(id, {
        ...old,
        ...d,
        id,
        created_by: old?.created_by ?? c.userId,
        revision: Number(d.revision) + 1,
        created_at: old?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as WorkUnit);
      for (const [sid, s] of ss)
        if (s.unit_id === id && s.project_id !== d.project_id)
          ss.set(sid, {
            ...s,
            project_id: d.project_id as string | null,
            revision: s.revision + 1,
          });
    }
    if (c.action === "start" || c.action === "stop") {
      const active = d.expected_session_id
        ? ss.get(String(d.expected_session_id))
        : undefined;
      if (active && !active.ended_at)
        ss.set(active.id, {
          ...active,
          ended_at: String(d.at),
          end_reason: c.action,
          outcome: (d.outcome ?? null) as WorkSession["outcome"],
          description: String(d.finish_note ?? active.description),
          delay_reason: String(d.delay_reason ?? active.delay_reason),
          revision: active.revision + 1,
        });
      const unit = us.get(String(d.unit_id));
      if (c.action === "start" && unit?.facts.installation_complete === "Yes")
        us.set(unit.id, {
          ...unit,
          facts: { ...unit.facts, installation_complete: "No" },
          revision: unit.revision + 1,
        });
      if (c.action === "start")
        ss.set(String(d.id), {
          id: String(d.id),
          profile_id: c.userId,
          shift_id: String(d.shift_id),
          project_id: (d.project_id ?? null) as string | null,
          unit_id: (d.unit_id ?? null) as string | null,
          kind: d.unit_id ? "unit" : "idle",
          participation: (d.participation ??
            "install") as WorkSession["participation"],
          stage: d.unit_id ? String(d.stage ?? "Installing") : "Idle time",
          description: String(d.description ?? ""),
          outcome: null,
          delay_reason: "",
          started_at: String(d.at),
          ended_at: null,
          end_reason: null,
          revision: 1,
        });
    }
    if (c.action === "session") {
      const old = ss.get(String(d.id));
      if (old)
        ss.set(old.id, {
          ...old,
          ...d,
          revision: old.revision + 1,
        } as WorkSession);
    }
  }
  return { units: [...us.values()], sessions: [...ss.values()] };
}

/** A foreman's attribution, not measured time or QC approval. */
export interface CrewWorkRecord {
  id: string;
  project_id: string;
  unit_id: string;
  filed_by: string | null;
  work_date: string;
  stage: string;
  outcome: "assigned" | "partial" | "finished";
  description: string;
  created_at: string;
  people: { profile_id: string }[];
  whole_complete: boolean;
}
export const CREW_WORK_STAGES = ["RO checked", ...WORK_STAGES];

export interface CrewPerson {
  id: string; display_name: string; active: boolean; role: string; is_partner: boolean;
  retired_at?: string | null; access_revoked_at?: string | null;
}
/** Who can be named on a crew record: anyone with current login access in a
 * crew role. `active` is the Crew page's On site / Off today switch — someone
 * who installed yesterday can be off today — so it is not a condition here
 * (the server's record_crew_work applies the same rule). */
export function crewRecordEligible(p: CrewPerson): boolean {
  return !p.is_partner && !p.retired_at && !p.access_revoked_at && ["installer", "foreman", "supervisor", "owner"].includes(p.role ?? "");
}
export function localWorkDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
