export type WindowStatus =
  | "pre_issued"
  | "inbound"
  | "in_warehouse"
  | "staged"
  | "loaded"
  | "installed"
  | "damaged"
  | "on_site";

export interface WindowType {
  id: string;
  type_code: string;
  name: string;
  category: string | null;
  width_in: number | null;
  height_in: number | null;
  difficulty_rating: number | null;
  /** Badge an installer must hold before dispatch offers this type. */
  required_capability?: string | null;
  tutorial_url: string | null;
  notes: string | null;
  /** true = created ad hoc from a job spec extract, not part of the closed catalog. */
  provisional?: boolean;
  tips_json?: string[];
  watch_outs_json?: string[];
  outcome_difficulty?: number | null;
  tips_synthesized_at?: string | null;
  tips_install_count?: number;
  n_installs?: number;
  median_minutes?: number | null;
  p90_minutes?: number | null;
  avg_grade?: number | null;
  fail_rate?: number | null;
  learned_difficulty?: number | null;
  last_install_at?: string | null;
  golden_install_event_id?: string | null;
  howto_json?: HowtoStep[];
  howto_generated_at?: string | null;
}

export interface HowtoStep {
  title: string;
  detail: string;
}

export interface Location {
  id: string;
  zone: "R" | "J" | "S" | "D";
  rack: string;
  slot: string;
  address: string;
  /** Permanent auto-generated serial (e.g. SLOT-000123). Encoded by the QR. */
  serial?: string | null;
  /** Optional friendly display name, editable without breaking scans. */
  display_name?: string | null;
  capacity: number;
  active: boolean;
}

/**
 * The work modes a job can allow (standard-tracking-jobs slice 2). `data` is the
 * full per-window loop — openings, the map, Studio, flash runs, unit tracking.
 * `tracking` is a lighter job that only clocks time and logs the day. A job
 * allows one or both; see lib/jobModes.ts for what each combination shows.
 */
export type JobMode = "data" | "tracking";

export interface Project {
  id: string;
  job_code: string;
  name: string;
  address: string | null;
  status: "active" | "completed" | "cancelled";
  /** Which work modes this job allows (a non-empty subset of {data,tracking}).
   * Written only via set_project_modes() — the column is client-write-locked
   * (20260970000000_job_modes.sql). Optional like the other fields added after
   * this interface's first fixtures: a real fetch always has it (not null
   * default '{data}'), so absent/empty is read as data-only by jobModes.ts. */
  allowed_modes?: JobMode[] | null;
  /** When status last moved (set_project_status stamps it) — what lets the
   * job-history list say WHEN a job finished. Optional: rows written before
   * the lifecycle migration are null until first touched. */
  status_changed_at?: string | null;
  /** Wave D: set by trash_project(), cleared by restore_project(). Null for
   * every ordinary job. A non-owner never receives a row with this set at
   * all (RLS) — this field only ever appears for the owner's own trash
   * list. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  /** Fake data for practice or QA — never a real job. Invisible below
   * supervisor (RLS); its packages never count as real inventory (client
   * partition, lib/warehouse/testPartition.ts). Optional like the other
   * fields added after this interface's first fixtures, so existing test
   * data doesn't need to be touched; a real fetch always has it (not null
   * default false). */
  is_test?: boolean;
  customer_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  site_state?: string | null;
  unit_number?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  notes?: string | null;
  estimated_minutes?: number | null;
  estimated_crew?: number | null;
  estimated_at?: string | null;
}

export interface ProjectWindow {
  id: string;
  project_id: string;
  window_type_id: string;
  quantity: number;
  window_types?: WindowType;
}

export interface WindowUnit {
  id: string;
  window_id: string;
  /** Short, hand-writable code (no ambiguous chars) that also resolves to this unit. */
  short_code?: string | null;
  /** Permanent auto-generated serial (e.g. WIN-000123). Encoded by the QR. */
  serial?: string | null;
  /** Optional friendly display name, editable without breaking scans. */
  display_name?: string | null;
  window_type_id: string;
  status: WindowStatus;
  project_id: string | null;
  location_id: string | null;
  received_at: string;
  installed_at: string | null;
  notes: string | null;
  window_types?: WindowType;
  locations?: Location | null;
  projects?: Project | null;
}

export interface Movement {
  id: string;
  window_id: string;
  event: string;
  from_location_id: string | null;
  to_location_id: string | null;
  project_id: string | null;
  actor: string | null;
  reason: string | null;
  created_at: string;
}

export const STATUS_LABELS: Record<WindowStatus, string> = {
  pre_issued: "Pre-issued",
  inbound: "Inbound (needs putaway)",
  in_warehouse: "In warehouse",
  staged: "Staged for job",
  loaded: "Loaded on truck",
  installed: "Installed",
  damaged: "Damaged / hold",
  on_site: "On site (ready to install)",
};
