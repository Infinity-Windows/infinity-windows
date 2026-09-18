import type { WorkFacts } from "../customWork/model";
export type Cause = "pending" | "manufacturer" | "customer" | "installer";
export interface ServiceDetails {
  crew_names?: string;
  truck?: string;
  truck_id?: string;
  estimated_miles?: number;
  actual_miles?: number;
  lodging?: boolean;
  travel_notes?: string;
  scheduled_date?: string;
  lodging_cost?: number;
  parts_cost?: number;
  other_cost?: number;
}
export interface ServiceVisit {
  id: string;
  project_id: string;
  created_by: string | null;
  previous_visit_id: string | null;
  status: "active" | "completed";
  details: ServiceDetails;
  revision: number;
  completed_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  allocation: {
    manufacturer: number;
    customer: number;
    installer: number;
    reason: string;
  } | null;
  lodging_message_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface ServiceUnit {
  id: string;
  visit_id: string;
  project_id: string;
  created_by: string | null;
  work_unit_id: string | null;
  opening_id: string | null;
  window_id: string | null;
  legacy_case_id: string | null;
  label: string;
  type_label: string;
  facts: WorkFacts;
  issue: string;
  fail_point: string;
  cause: Cause;
  repair: string;
  verification: string;
  prevention: string;
  next_steps: string;
  memo_text: string;
  evidence_exception: string;
  outcome: "open" | "resolved" | "temporary" | "return_needed";
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface ServiceSession {
  id: string;
  visit_id: string;
  project_id: string;
  unit_id: string | null;
  shift_id: string;
  profile_id: string;
  kind: "unit" | "idle" | "travel";
  stage: string;
  description: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  review_required: boolean;
  profiles?: { display_name: string } | null;
  time_shifts?: {
    clock_in_at: string;
    clock_out_at: string | null;
    break_seconds: number;
    status: string;
    project_id: string | null;
  } | null;
}
export interface ServiceMedia {
  id: string;
  visit_id: string;
  project_id: string;
  unit_id: string | null;
  created_by: string | null;
  kind: "before" | "after" | "photo" | "voice" | "video" | "receipt";
  storage_path: string;
  filename: string;
  content_type: string;
  bytes: number;
  caption: string;
  transcript: string;
  revision: number;
  created_at: string;
}
export interface ServiceSnapshot {
  visit: ServiceVisit;
  units: ServiceUnit[];
  sessions: ServiceSession[];
  media: ServiceMedia[];
}
export type ServiceAction =
  | "visit"
  | "unit"
  | "start"
  | "stop"
  | "finish"
  | "review"
  | "notify"
  | "supervisor"
  | "media"
  | "transcript"
  | "review_time";
export interface ServiceCommand {
  id: string;
  userId: string;
  action: ServiceAction;
  data: Record<string, unknown>;
  error?: string;
}
export const SERVICE_STAGES = [
  "Diagnosis",
  "Preparation",
  "Flashing",
  "Setting frame",
  "Glazing",
  "Hardware",
  "Repair / replacement",
  "Testing",
  "Detail work",
] as const;
export const CAUSES: Cause[] = [
  "pending",
  "manufacturer",
  "customer",
  "installer",
];
export function serviceSeconds(s: ServiceSession, now = Date.now()): number {
  const shift = s.time_shifts;
  if (shift?.status === "voided") return 0;
  const a = Math.max(
    Date.parse(s.started_at),
    shift ? Date.parse(shift.clock_in_at) : -Infinity,
  );
  const b = Math.min(
    s.ended_at ? Date.parse(s.ended_at) : now,
    shift?.clock_out_at ? Date.parse(shift.clock_out_at) : Infinity,
  );
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.max(0, b - a) / 1000
    : 0;
}
export function timeNeedsReview(s: ServiceSession): boolean {
  const sh = s.time_shifts;
  return (
    s.review_required ||
    !sh ||
    ["voided", "rejected", "needs_finish"].includes(sh.status) ||
    sh.project_id !== s.project_id ||
    Date.parse(s.started_at) < Date.parse(sh.clock_in_at) ||
    (!!s.ended_at &&
      !!sh.clock_out_at &&
      Date.parse(s.ended_at) > Date.parse(sh.clock_out_at))
  );
}
export function serviceTotals(data: ServiceSnapshot) {
  const byCause: Record<Cause, number> = {
    pending: 0,
    manufacturer: 0,
    customer: 0,
    installer: 0,
  };
  let shared = 0;
  for (const row of data.sessions) {
    const sec = serviceSeconds(row);
    const unit = data.units.find((u) => u.id === row.unit_id);
    if (unit) byCause[unit.cause] += sec;
    else shared += sec;
  }
  return {
    byCause,
    shared,
    total: Object.values(byCause).reduce((a, b) => a + b, shared),
  };
}
/** Evidence and field completion are independent from stopping a worker's paid clock. */
export function serviceReadiness(s: ServiceSnapshot): string[] {
  const gaps: string[] = [];
  if (s.visit.status !== "completed") gaps.push("visit");
  if (s.sessions.some((x) => !x.ended_at)) gaps.push("running");
  if (s.sessions.some(timeNeedsReview)) gaps.push("time");
  if (!s.units.length) gaps.push("units");
  for (const u of s.units) {
    if (
      !u.repair.trim() ||
      !u.verification.trim() ||
      !u.memo_text.trim() ||
      u.outcome === "open" ||
      u.cause === "pending" ||
      !u.fail_point.trim()
    )
      gaps.push("details");
    const kinds = new Set(
      s.media.filter((m) => m.unit_id === u.id).map((m) => m.kind),
    );
    if (
      !u.evidence_exception.trim() &&
      (!kinds.has("voice") ||
        !kinds.has("video") ||
        !kinds.has("before") ||
        !kinds.has("after"))
    )
      gaps.push("evidence");
  }
  return [...new Set(gaps)];
}
export function previewService(
  base: ServiceSnapshot | undefined,
  commands: ServiceCommand[],
): ServiceSnapshot | undefined {
  if (!base) return base;
  const data = structuredClone(base);
  for (const c of commands.filter((x) => x.data.visit_id === base.visit.id)) {
    const d = c.data;
    if (c.action === "unit") {
      const old = data.units.find((x) => x.id === d.id);
      const u = {
        ...old,
        ...d,
        project_id: data.visit.project_id,
        created_by: old?.created_by ?? c.userId,
        revision: Number(d.revision ?? 0) + 1,
      } as unknown as ServiceUnit;
      data.units = data.units.filter((x) => x.id !== u.id).concat(u);
    }
    if (c.action === "start" || c.action === "stop") {
      data.sessions = data.sessions.map((s) =>
        s.id === d.expected_session_id
          ? { ...s, ended_at: String(d.at), end_reason: "stop" }
          : s,
      );
      if (c.action === "start")
        data.sessions.push({
          ...d,
          profile_id: c.userId,
          project_id: data.visit.project_id,
          started_at: d.at,
          ended_at: null,
          review_required: false,
        } as unknown as ServiceSession);
    }
    if (c.action === "visit") data.visit.details = d.details as ServiceDetails;
    if (["unit", "start", "stop", "visit"].includes(c.action)) {
      data.visit.revision++;
      data.visit.reviewed_at = null;
    }
  }
  return data;
}

export function emptyServiceUnit(visit: string, project: string): ServiceUnit {
  return {
    id: crypto.randomUUID(),
    visit_id: visit,
    project_id: project,
    created_by: null,
    work_unit_id: null,
    opening_id: null,
    window_id: null,
    legacy_case_id: null,
    label: "",
    type_label: "",
    facts: {},
    issue: "",
    fail_point: "",
    cause: "pending",
    repair: "",
    verification: "",
    prevention: "",
    next_steps: "",
    memo_text: "",
    evidence_exception: "",
    outcome: "open",
    revision: 0,
    created_at: "",
    updated_at: "",
  };
}
