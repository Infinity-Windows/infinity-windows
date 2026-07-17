import { supabase } from "./supabase";

/** Default hourly labor rates by role (company setting; edit as needed). */
export const HOURLY_RATE: Record<string, number> = {
  installer: 35,
  lead: 50,
  foreman: 50,
  admin: 60,
  big_boss: 75,
};

export interface LaborShift {
  project_id: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  role: string;
}

/** Derived labor cost + hours per project from clocked-out shifts. */
export function computeLabor(shifts: LaborShift[]): Map<string, { hours: number; cost: number }> {
  const out = new Map<string, { hours: number; cost: number }>();
  for (const s of shifts) {
    if (!s.project_id || !s.clock_out_at) continue;
    const ms = new Date(s.clock_out_at).getTime() - new Date(s.clock_in_at).getTime();
    const hours = Math.max(0, ms / 3600000 - (s.break_seconds ?? 0) / 3600);
    const rate = HOURLY_RATE[s.role] ?? HOURLY_RATE.installer;
    const cur = out.get(s.project_id) ?? { hours: 0, cost: 0 };
    cur.hours += hours;
    cur.cost += hours * rate;
    out.set(s.project_id, cur);
  }
  return out;
}

export interface JobCost {
  id: string;
  project_id: string;
  category: string;
  label: string | null;
  amount: number;
  cost_date: string;
}

export interface ChangeOrder {
  id: string;
  project_id: string;
  label: string;
  amount: number;
}

export interface JobCosting {
  projectId: string;
  jobCode: string;
  name: string;
  bid: number;
  changeOrders: number;
  revenue: number; // bid + change orders
  manualCosts: number; // job_costs entries
  laborHours: number; // derived from time_shifts
  laborCost: number; // derived from time_shifts x rate
  costs: number; // manualCosts + laborCost
  margin: number; // revenue - costs
  marginPct: number;
  targetMarginPct: number | null;
}

export async function listJobCosts(projectId: string): Promise<JobCost[]> {
  const { data, error } = await supabase
    .from("job_costs")
    .select("*")
    .eq("project_id", projectId)
    .order("cost_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as JobCost[];
}

export async function listChangeOrders(projectId: string): Promise<ChangeOrder[]> {
  const { data, error } = await supabase
    .from("change_orders")
    .select("*")
    .eq("project_id", projectId);
  if (error) throw error;
  return (data ?? []) as ChangeOrder[];
}

export async function addJobCost(
  projectId: string,
  category: string,
  amount: number,
  label?: string,
): Promise<void> {
  const { error } = await supabase.from("job_costs").insert({
    project_id: projectId,
    category,
    amount,
    label: label ?? null,
  });
  if (error) throw error;
}

export async function addChangeOrder(
  projectId: string,
  label: string,
  amount: number,
): Promise<void> {
  const { error } = await supabase
    .from("change_orders")
    .insert({ project_id: projectId, label, amount });
  if (error) throw error;
}

export async function setBid(
  projectId: string,
  bid: number,
  targetMarginPct: number | null,
): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({ bid_amount: bid, target_margin_pct: targetMarginPct })
    .eq("id", projectId);
  if (error) throw error;
}

/** Company-wide costing rollup across active jobs. */
export async function getCompanyCosting(): Promise<JobCosting[]> {
  const [projRes, costRes, coRes, shiftRes] = await Promise.all([
    supabase.from("projects").select("id, job_code, name, bid_amount, target_margin_pct"),
    supabase.from("job_costs").select("project_id, amount"),
    supabase.from("change_orders").select("project_id, amount"),
    supabase
      .from("time_shifts")
      .select("project_id, clock_in_at, clock_out_at, break_seconds, profiles(role)"),
  ]);
  if (projRes.error) throw projRes.error;
  if (costRes.error) throw costRes.error;
  if (coRes.error) throw coRes.error;
  if (shiftRes.error) throw shiftRes.error;

  const costByProj = new Map<string, number>();
  for (const c of costRes.data ?? []) {
    costByProj.set(c.project_id, (costByProj.get(c.project_id) ?? 0) + Number(c.amount));
  }
  const coByProj = new Map<string, number>();
  for (const c of coRes.data ?? []) {
    coByProj.set(c.project_id, (coByProj.get(c.project_id) ?? 0) + Number(c.amount));
  }
  const labor = computeLabor(
    (shiftRes.data ?? []).map((s) => ({
      project_id: s.project_id,
      clock_in_at: s.clock_in_at,
      clock_out_at: s.clock_out_at,
      break_seconds: s.break_seconds ?? 0,
      role: (s.profiles as { role?: string } | null)?.role ?? "installer",
    })),
  );

  return (projRes.data ?? []).map((p) => {
    const bid = Number(p.bid_amount ?? 0);
    const changeOrders = coByProj.get(p.id) ?? 0;
    const revenue = bid + changeOrders;
    const manualCosts = costByProj.get(p.id) ?? 0;
    const lab = labor.get(p.id) ?? { hours: 0, cost: 0 };
    const costs = manualCosts + lab.cost;
    const margin = revenue - costs;
    return {
      projectId: p.id,
      jobCode: p.job_code,
      name: p.name,
      bid,
      changeOrders,
      revenue,
      manualCosts,
      laborHours: Math.round(lab.hours * 10) / 10,
      laborCost: Math.round(lab.cost),
      costs: Math.round(costs),
      margin: Math.round(margin),
      marginPct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : 0,
      targetMarginPct: p.target_margin_pct ?? null,
    };
  });
}

/** Bid calculator: given cost inputs and a target margin, the price to bid. */
export function bidForMargin(totalCost: number, targetMarginPct: number): number {
  const m = Math.min(0.99, Math.max(0, targetMarginPct / 100));
  return Math.round(totalCost / (1 - m));
}

export function toCsv(rows: JobCosting[]): string {
  const header = "job_code,name,bid,change_orders,revenue,labor_hours,labor_cost,manual_costs,costs,margin,margin_pct";
  const lines = rows.map((r) =>
    [r.jobCode, `"${r.name}"`, r.bid, r.changeOrders, r.revenue, r.laborHours, r.laborCost, r.manualCosts, r.costs, r.margin, r.marginPct].join(","),
  );
  return [header, ...lines].join("\n");
}
