import type { Project, WindowType, WindowUnit } from "../types";

export type PlansetFormat = "pdf" | "dwg" | "dxf";
export type PlansetStatus =
  | "uploaded"
  | "converting"
  | "extracting"
  | "ready"
  | "failed";

export interface Planset {
  id: string;
  project_id: string;
  storage_path: string;
  source_format: PlansetFormat;
  converted_pdf_path: string | null;
  page_count: number | null;
  status: PlansetStatus;
  created_at: string;
}

export type OpeningStatus = "planned" | "assigned" | "installed";

export interface ProjectOpening {
  id: string;
  project_id: string;
  planset_id: string | null;
  opening_code: string;
  window_type_id: string | null;
  label: string | null;
  page_number: number;
  pin_x: number | null;
  pin_y: number | null;
  assigned_window_id: string | null;
  status: OpeningStatus;
  confirmed: boolean;
  created_at: string;
  window_types?: WindowType | null;
  windows?: WindowUnit | null;
  projects?: Project | null;
}

/** Topic fields match vault/_schemas/install-memo-topics.md, in order. */
export interface MemoTopics {
  difficulty: string | null;
  went_well: string | null;
  went_poorly: string | null;
  obstacles: string | null;
  tools_helped: string | null;
  time_vs_estimate: string | null;
  safety_notes: string | null;
  do_again: string | null;
}

export interface InstallEvent extends MemoTopics {
  id: string;
  project_opening_id: string;
  window_id: string | null;
  window_type_id: string | null;
  installer: string | null;
  started_at: string | null;
  minutes: number | null;
  quality_grade: number | null;
  transcript_raw: string | null;
  created_at: string;
}

export const MEMO_TOPICS: { key: keyof MemoTopics; prompt: string }[] = [
  { key: "difficulty", prompt: "Difficulty / how it felt" },
  { key: "went_well", prompt: "What went well" },
  { key: "went_poorly", prompt: "What didn't go well" },
  { key: "obstacles", prompt: "Obstacles" },
  { key: "tools_helped", prompt: "Tools / materials that helped" },
  { key: "time_vs_estimate", prompt: "Time estimate vs actual" },
  { key: "safety_notes", prompt: "Safety notes" },
  { key: "do_again", prompt: "What we'd do again next time" },
];

export const OPENING_STATUS_COLORS: Record<OpeningStatus, string> = {
  planned: "#fbbf24",
  assigned: "#3b82f6",
  installed: "#34d399",
};
