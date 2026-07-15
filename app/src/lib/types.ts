export type WindowStatus =
  | "inbound"
  | "in_warehouse"
  | "staged"
  | "loaded"
  | "installed"
  | "damaged";

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
  inbound: "Inbound (needs putaway)",
  in_warehouse: "In warehouse",
  staged: "Staged for job",
  loaded: "Loaded on truck",
  installed: "Installed",
  damaged: "Damaged / hold",
};
