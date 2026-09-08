import { supabase } from "../supabase";
import { isMissingFunction, isMissingTable } from "../schemaErrors";
import type { ScheduleAssignment } from "../schedule/types";
import type { Trip, Flight, Lodging, GroundTransport, Procedure, TripContact, TripAttachment } from "../travel/types";

export interface PlanDraft {
  assignments: ScheduleAssignment[];
  trips: { trip: Omit<Trip, "crew">; crew: Trip["crew"]; flights: Flight[]; lodging: Lodging[];
    ground: GroundTransport[]; procedures: Procedure[]; contacts: TripContact[]; attachments: TripAttachment[] }[];
  vehicles: { id: string; vehicle_id: string; assignment_id: string; start_date: string | null; end_date: string | null }[];
}
export interface PlanSummary { id: string; project_id: string | null; name: string; revision: number; published_revision: number | null; state: "active" | "canceled" }
export interface PlanReview extends PlanSummary {
  draft: PlanDraft; source_snapshot: PlanDraft; review_token: string; conflict_assignments: ScheduleAssignment[];
  conflicts: { kind: "crew" | "vehicle"; assignment_id: string; other_id: string; resource_id: string }[];
  notices: { state: "pending" | "sending" | "sent" | "failed"; count: number }[];
}
export interface PlanLinks { available: boolean; assignments: { plan_id: string; assignment_id: string }[]; trips: { plan_id: string; trip_id: string }[] }
export async function loadPlanLinks(): Promise<PlanLinks> {
  const [a, t] = await Promise.all([
    supabase.from("workflow_plan_assignments").select("plan_id,assignment_id"),
    supabase.from("workflow_plan_trips").select("plan_id,trip_id"),
  ]);
  for (const error of [a.error, t.error]) if (error) {
    if (isMissingTable(error)) return { available: false, assignments: [], trips: [] };
    throw error;
  }
  return { available: true, assignments: a.data ?? [], trips: t.data ?? [] };
}
export async function listPlans(): Promise<PlanSummary[]> {
  const { data, error } = await supabase.from("workflow_plans").select("id,project_id,name,revision,published_revision,state").order("updated_at", { ascending: false });
  if (error) { if (isMissingTable(error)) return []; throw error; }
  return data ?? [];
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  // Writes deliberately have NO missing-schema or offline success fallback.
  if (error) throw error;
  return data as T;
}
export const createPlan = (id: string, name: string, assignments: string[], trips: string[]) => rpc<string>("workflow_create_plan", { p_id: id, p_name: name, p_assignments: assignments, p_trips: trips });
export const reviewPlan = (id: string) => rpc<PlanReview>("workflow_review_plan", { p_plan: id });
export const savePlan = (plan: PlanReview, draft: PlanDraft) => rpc<number>("workflow_save_draft", { p_plan: plan.id, p_expected: plan.revision, p_draft: draft });
export interface PublishRequest { p_plan: string; p_expected: number; p_request: string; p_review_token: string; p_allow_crew_conflicts: boolean; p_cancel: boolean }
export const publishPlan = (request: PublishRequest) => rpc<{ plan_id: string; revision: number; state: string; notifications: string }>("workflow_publish_plan", request as unknown as Record<string, unknown>);
export const discardPlan = (plan: PlanReview) => rpc<void>("workflow_discard_plan", { p_plan: plan.id, p_expected: plan.revision });
export async function deliverPlanNotices(id: string): Promise<void> {
  const { error } = await supabase.functions.invoke("deliver-workflow-notices", { body: { planId: id } });
  if (error) throw error;
}
export interface MyTripLink { assignment_id: string; trip_id: string; name: string; start_date: string; end_date: string }
export async function myPlanTripLinks(): Promise<MyTripLink[]> {
  const { data, error } = await supabase.rpc("workflow_my_trip_links");
  if (error) { if (isMissingFunction(error)) return []; throw error; }
  return data ?? [];
}
