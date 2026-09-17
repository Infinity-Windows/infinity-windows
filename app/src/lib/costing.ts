import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import {
  indexPayRates,
  listPayRates,
  localDayOf,
  rateInEffect,
  type PayRate,
} from "./payRates";

/**
 * The FALLBACK hourly rates, by role. Wave Z made real per-person rates the
 * truth (pay_rates, lib/payRates.ts); these four numbers are what a person with
 * no rate on file is priced at, and Costing marks any line that used them
 * "estimated — no rate on file" rather than passing a guess off as a cost.
 */
export const HOURLY_RATE: Record<string, number> = {
  installer: 35,
  foreman: 50,
  supervisor: 60,
  owner: 75,
  // Legacy role names kept so historical shifts still price correctly.
  lead: 50,
  admin: 60,
  big_boss: 75,
};

export interface LaborShift {
  project_id: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  role: string;
  /** Wave Z: who worked it, so the shift can be priced at THEIR rate. */
  profile_id?: string | null;
  profile_name?: string | null;
  status?: string;
}

/** One person's hours and cost on one job, and whether the cost is real. */
export interface LaborPerson {
  profileId: string;
  name: string;
  hours: number;
  cost: number;
  /** True when any of these hours were priced off the role table because the
   * person had no rate on file that day. The line says so on screen. */
  estimated: boolean;
  salaryAllocated?: boolean;
}

export interface LaborTotals {
  hours: number;
  cost: number;
  people: LaborPerson[];
  /** True when ANY person on this job was priced off the role table. */
  estimated: boolean;
}

/**
 * Derived labor cost + hours per project from clocked-out shifts.
 *
 * `rates` (from indexPayRates) prices each shift at what that person earned ON
 * THE DAY THEY WORKED IT. Without it — or for a person with no rate that day —
 * the role table above stands in and the line is marked estimated. Passing no
 * rates at all is the pre-wave-Z behaviour exactly, which is what keeps this
 * usable from anywhere that has no business reading pay.
 */
export function computeLabor(
  shifts: LaborShift[],
  rates?: Map<string, PayRate[]>,
): Map<string, LaborTotals> {
  const out = new Map<string, LaborTotals>();
  // Per-project, per-person accumulation, so the screen can show which line is
  // a real cost and which is a guess.
  const byPerson = new Map<string, Map<string, LaborPerson>>();

  // Split at local day boundaries, including a salary/month/rate change.
  // Break time is distributed over the shift because older punches contain
  // only a total break duration, not its exact timestamps.
  const segments: {shift:LaborShift; hours:number; day:string; rate:PayRate|null}[]=[];
  const monthHours=new Map<string,number>();
  for (const shift of shifts) {
    if (!shift.clock_out_at || shift.status === "voided") continue;
    const start=new Date(shift.clock_in_at).getTime(), end=new Date(shift.clock_out_at).getTime();
    if (!Number.isFinite(start)||!Number.isFinite(end)||end<start) continue;
    if(end===start) {
      const day=localDayOf(shift.clock_in_at);
      segments.push({shift,hours:0,day,rate:shift.profile_id?rateInEffect(rates?.get(shift.profile_id),day):null});
      continue;
    }
    const paidRatio=Math.max(0,1-Math.max(0,shift.break_seconds??0)*1000/(end-start));
    for(let cursor=start;cursor<end;) {
      const date=new Date(cursor), midnight=new Date(date.getFullYear(),date.getMonth(),date.getDate()+1).getTime();
      const until=Math.min(end,midnight), hours=(until-cursor)/3600000*paidRatio;
      const day=localDayOf(new Date(cursor).toISOString());
      const rate=shift.profile_id?rateInEffect(rates?.get(shift.profile_id),day):null;
      segments.push({shift,hours,day,rate});
      if(rate?.payBasis==="salary_monthly") {
        const key=`${shift.profile_id}:${day.slice(0,7)}`;
        monthHours.set(key,(monthHours.get(key)??0)+hours);
      }
      cursor=until;
    }
  }
  for (const {shift:s,hours,day,rate:onFile} of segments) {
    if(!s.project_id)continue;
    const salary=onFile?.payBasis==="salary_monthly";
    const denominator=monthHours.get(`${s.profile_id}:${day.slice(0,7)}`)??0;
    const cost=salary
      ? (denominator>0?(onFile.monthlyCents??0)/100*hours/denominator:0)
      : hours*(onFile?onFile.hourlyCents/100:HOURLY_RATE[s.role]??HOURLY_RATE.installer);
    const cur = out.get(s.project_id) ?? { hours: 0, cost: 0, people: [], estimated: false };
    cur.hours += hours; cur.cost += cost;
    if (!onFile) cur.estimated = true;
    out.set(s.project_id, cur);
    const who = s.profile_id ?? "unknown";
    const people = byPerson.get(s.project_id) ?? new Map<string, LaborPerson>();
    const line = people.get(who) ?? {profileId:who,name:s.profile_name??"Someone",hours:0,cost:0,estimated:false};
    line.hours += hours; line.cost += cost;
    if (!onFile) line.estimated = true;
    if (salary) line.salaryAllocated = true;
    people.set(who, line); byPerson.set(s.project_id, people);
  }

  for (const [projectId, people] of byPerson) {
    const totals = out.get(projectId);
    if (totals) {
      totals.people = [...people.values()].sort((a, b) => b.hours - a.hours);
    }
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
  /** Wave Z: passed through to the customer. Copied from the receipt that
   * posted this line and kept in step with it; null = nobody has answered. */
  billable?: boolean | null;
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
  laborCost: number; // derived from time_shifts x each person's rate that day
  costs: number; // manualCosts + laborCost
  margin: number; // revenue - costs
  marginPct: number;
  targetMarginPct: number | null;
  /** Wave Z: somebody on this job had no pay rate on file, so part of the
   * labor cost is the role table's guess rather than what they earn. */
  laborEstimated?: boolean;
  /** Per-person labor, so the screen can name who is estimated. */
  laborPeople?: LaborPerson[];
  /**
   * Wave Z: whether the person READING this could see pay rates at all.
   *
   * False and every line is estimated for one reason — RLS handed this reader
   * no `pay_rates` rows — which is a completely different sentence from "that
   * person has no rate on file". The two grants are separate on purpose (a
   * bookkeeper who books job costs has no business reading what the crew
   * earns), so "Sees costs without Sees pay" is the ordinary everyday case,
   * not a corner. Without this flag the screen tells a bookkeeper a rate is
   * missing when it is not, and quietly shows them a different margin from
   * the owner's with no explanation.
   */
  laborRatesVisible?: boolean;
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

/**
 * The bid and target margin, which live in `project_financials` since wave Z
 * (20260978000000) — they used to be two columns on `projects`, where they
 * could not be gated: a column rides its table's policy, and `projects` has to
 * stay readable by every crew login.
 *
 * One row per job, so this is an upsert on the primary key.
 */
export async function setBid(
  projectId: string,
  bid: number,
  targetMarginPct: number | null,
): Promise<void> {
  const { error } = await supabase.from("project_financials").upsert(
    {
      project_id: projectId,
      bid_amount: bid,
      target_margin_pct: targetMarginPct,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );
  if (error) throw error;
}

interface CostingShiftRow {
  id:string; project_id:string|null; profile_id:string; clock_in_at:string; clock_out_at:string|null;
  break_seconds:number; profiles:{role?:string;display_name?:string}|null;
}
async function listCostingShifts():Promise<CostingShiftRow[]> {
  const rows:CostingShiftRow[]=[];
  let expected:number|null=null;
  for(let page=0;page<1000;page++) {
    const {data,error,count}=await supabase.from("time_shifts")
      .select("id, project_id, profile_id, clock_in_at, clock_out_at, break_seconds, profiles!profile_id(role, display_name)",{count:"exact"})
      .neq("status","voided").order("id").range(rows.length,rows.length+999);
    if(error)throw error;
    if(typeof count!=="number"||(expected!==null&&count!==expected))throw new Error("Time records changed. Refresh job costing.");
    expected=count;
    if(!data?.length&&rows.length<expected)throw new Error("The cost report is incomplete. Refresh job costing.");
    rows.push(...(data??[]) as CostingShiftRow[]);
    if(rows.length>=expected) {
      if(rows.length!==expected||new Set(rows.map(row=>row.id)).size!==expected)throw new Error("Time records changed. Refresh job costing.");
      return rows;
    }
  }
  throw new Error("The cost report is too large to load completely.");
}

/**
 * Company-wide costing rollup across active jobs.
 *
 * `canSeePay` is what the CALLER knows about itself — owner, or granted "Sees
 * pay rates". It is not a second lock (RLS already refuses the rows); it is how
 * the screen tells "nobody has set this person's rate" apart from "you are not
 * allowed to read it". Both produce the same fallback to the role table and the
 * same estimate, and only one of them is the reader's problem to fix.
 */
export async function getCompanyCosting(
  opts: { canSeePay?: boolean } = {},
): Promise<JobCosting[]> {
  const [projRes, finRes, costRes, coRes, shiftRes] = await Promise.all([
    supabase.from("projects").select("id, job_code, name"),
    // Wave Z: the bid moved off `projects` into its own gated table. Degrades
    // to "no bids on file" on a database that has the app but not yet
    // 20260978000000 — the screen empties, it never white-screens.
    supabase.from("project_financials").select("project_id, bid_amount, target_margin_pct"),
    supabase.from("job_costs").select("project_id, amount"),
    supabase.from("change_orders").select("project_id, amount"),
    listCostingShifts(),
  ]);
  if (projRes.error) throw projRes.error;
  if (finRes.error && !isMissingTable(finRes.error, "project_financials")) throw finRes.error;
  if (costRes.error) throw costRes.error;
  if (coRes.error) throw coRes.error;

  const finByProj = new Map<string, { bid: number; target: number | null }>();
  for (const f of finRes.data ?? []) {
    finByProj.set(f.project_id, {
      bid: Number(f.bid_amount ?? 0),
      target: f.target_margin_pct ?? null,
    });
  }

  const costByProj = new Map<string, number>();
  for (const c of costRes.data ?? []) {
    costByProj.set(c.project_id, (costByProj.get(c.project_id) ?? 0) + Number(c.amount));
  }
  const coByProj = new Map<string, number>();
  for (const c of coRes.data ?? []) {
    coByProj.set(c.project_id, (coByProj.get(c.project_id) ?? 0) + Number(c.amount));
  }
  // Wave Z: real per-person rates where they exist. Read separately (not
  // embedded) because pay_rates has its OWN grant — an owner sees rates, a
  // "Sees costs" bookkeeper does not, and RLS simply hands the second one no
  // rows, so their Costing screen falls back to the role table and says so.
  //
  // Not asked for at all without the grant: the read would come back empty
  // anyway, and skipping it keeps the screen from implying it tried.
  const canSeePay = opts.canSeePay !== false;
  const rates = canSeePay ? indexPayRates(await listPayRates()) : undefined;

  const labor = computeLabor(
    shiftRes.map((s) => ({
      project_id: s.project_id,
      clock_in_at: s.clock_in_at,
      clock_out_at: s.clock_out_at,
      break_seconds: s.break_seconds ?? 0,
      role: (s.profiles as { role?: string } | null)?.role ?? "installer",
      profile_id: s.profile_id,
      profile_name: (s.profiles as { display_name?: string } | null)?.display_name ?? null,
    })),
    rates,
  );

  return (projRes.data ?? []).map((p) => {
    const fin = finByProj.get(p.id);
    const bid = fin?.bid ?? 0;
    const changeOrders = coByProj.get(p.id) ?? 0;
    const revenue = bid + changeOrders;
    const manualCosts = costByProj.get(p.id) ?? 0;
    const lab = labor.get(p.id) ?? { hours: 0, cost: 0, people: [], estimated: false };
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
      targetMarginPct: fin?.target ?? null,
      laborEstimated: lab.estimated,
      laborPeople: lab.people,
      laborRatesVisible: canSeePay,
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
