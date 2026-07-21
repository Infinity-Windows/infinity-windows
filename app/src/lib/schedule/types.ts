import type { Profile } from "../install/types";
import type { Project } from "../types";

export type ScheduleStatus =
  | "draft"
  | "published"
  | "in_progress"
  | "done"
  | "canceled";

export type CrewMemberRole = "foreman" | "installer";

/** One crew member on an assignment (ad-hoc, chosen fresh per assignment). */
export interface AssignmentMember {
  profile_id: string;
  role: CrewMemberRole;
  /** Joined display fields when available. */
  display_name?: string | null;
}

/** The schedulable unit: a crew on a project for a day range. */
export interface ScheduleAssignment {
  id: string;
  project_id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  status: ScheduleStatus;
  color: string | null;
  note: string | null;
  created_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  members: AssignmentMember[];
  /** Joined project for board/agenda labels (best-effort). */
  project?: Pick<Project, "id" | "job_code" | "name" | "address"> | null;
}

export type ScheduleEventKind =
  | "created"
  | "published"
  | "moved"
  | "resized"
  | "reassigned"
  | "removed"
  | "edited";

export interface ScheduleEventInput {
  assignment_id: string | null;
  kind: ScheduleEventKind;
  payload?: Record<string, unknown> | null;
}

/** New-assignment input. Members carry their role; the store fills the rest. */
export interface NewAssignmentInput {
  project_id: string;
  start_date: string;
  end_date: string;
  start_time?: string | null;
  color?: string | null;
  note?: string | null;
  members: AssignmentMember[];
}

export interface AssignmentPatch {
  start_date?: string;
  end_date?: string;
  start_time?: string | null;
  color?: string | null;
  note?: string | null;
  status?: ScheduleStatus;
  members?: AssignmentMember[];
}

/** How far ahead the board schedules (months). */
export const SCHEDULE_HORIZON_MONTHS = 6;

/** Profiles eligible for a crew picker (active, foreman/installer floor). */
export function eligibleCrew(profiles: Profile[]): Profile[] {
  return profiles.filter((p) => p.active);
}
