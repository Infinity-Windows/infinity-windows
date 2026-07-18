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
  tutorial_url: string | null;
  notes: string | null;
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
  capacity: number;
  active: boolean;
}

export interface Project {
  id: string;
  job_code: string;
  name: string;
  address: string | null;
  status: "active" | "completed" | "cancelled";
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
