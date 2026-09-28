// Who a job's labor is billed to (migration 20261035000000, owner decisions
// Q1-Q4 of 2026-09-25).
//
// The Friday invoice script reads the "Job timecards" export and bills each job
// to the customer named in its "Bill To" column. That value comes from ONE
// place: the job's own bill-to below. Never from the job's customer or builder
// name — an invoice made outside Forge once guessed "Richardson Brothers" for a
// job STG pays for, which is the mistake this whole feature exists to end.
//
// Who sees it is decided in SQL (can_see_bill_to: supervisors, the owner and
// "Sees costs" holders). canSeeBillTo below only mirrors that rule so a screen
// can skip asking a question whose answer would be an empty list, and so the
// export can leave the two columns off for somebody the database would refuse.
//
// Reads degrade on a database that is behind the migration: the list answers
// `known: false` and the job's row answers null, so the field is simply not
// offered and the export keeps its old columns.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import { roleRank, type CrewRole } from "./install/types";
import type { MoneyGrants } from "./nav";

export interface BillToCustomer {
  id: string;
  name: string;
  billing_email: string | null;
  /** Bare digits, as typed; null until somebody types it. */
  quickbooks_customer_id: string | null;
  is_default: boolean;
  retired_at: string | null;
}

export interface ProjectBillTo {
  project_id: string;
  bill_to_customer_id: string;
  updated_at: string;
  customer: Pick<BillToCustomer, "id" | "name" | "quickbooks_customer_id" | "retired_at"> | null;
}

export interface BillToChange {
  id: number;
  changed_at: string;
  from_customer: { name: string } | null;
  to_customer: { name: string } | null;
  changer: { display_name: string } | null;
}

/** What the export writes for one job: the name, then the bare id or blank. */
export interface BillToCells {
  name: string;
  quickbooksId: string;
}

const CUSTOMER_COLS = "id, name, billing_email, quickbooks_customer_id, is_default, retired_at";
const PROJECT_BILL_TO_COLS =
  "project_id, bill_to_customer_id, updated_at, customer:bill_to_customers!bill_to_customer_id(id, name, quickbooks_customer_id, retired_at)";
const HISTORY_COLS =
  "id, changed_at, from_customer:bill_to_customers!from_customer_id(name), to_customer:bill_to_customers!to_customer_id(name), changer:profiles!changed_by(display_name)";
const TABLES = ["bill_to_customers", "project_bill_to", "project_bill_to_history"];

export const billToCustomersKey = ["billToCustomers"] as const;
export const projectBillToKey = (projectId: string) => ["projectBillTo", projectId] as const;
export const allProjectBillToKey = ["projectBillTo", "all"] as const;
export const projectBillToHistoryKey = (projectId: string) =>
  ["projectBillToHistory", projectId] as const;

/**
 * Mirrors can_see_bill_to(): a supervisor or the owner, or anybody granted
 * "Sees costs". Pass useEffectiveRole()'s role and grants, so an owner
 * previewing a foreman sees what a foreman sees.
 */
export function canSeeBillTo(
  role: CrewRole | string | null | undefined,
  grants: MoneyGrants,
): boolean {
  return roleRank(role) >= 2 || grants.costs === true;
}

/** Mirrors can_manage_bill_to(): supervisors and the owner, nobody else. */
export function canManageBillTo(role: CrewRole | string | null | undefined): boolean {
  return roleRank(role) >= 2;
}

/** The whole list, retired ones included (they stay on old jobs and exports). */
export async function listBillToCustomers(): Promise<{ known: boolean; rows: BillToCustomer[] }> {
  const { data, error } = await supabase
    .from("bill_to_customers")
    .select(CUSTOMER_COLS)
    .order("name");
  if (isMissingTable(error, ...TABLES)) return { known: false, rows: [] };
  if (error) throw error;
  return { known: true, rows: (data ?? []) as BillToCustomer[] };
}

/**
 * One job's bill-to. `known: false` is a database with no bill-to yet (the
 * field is not offered); `row: null` on a known database is a job somebody
 * left without one, which the field shows as "Not set" rather than hiding.
 */
export async function getProjectBillTo(
  projectId: string,
): Promise<{ known: boolean; row: ProjectBillTo | null }> {
  const { data, error } = await supabase
    .from("project_bill_to")
    .select(PROJECT_BILL_TO_COLS)
    .eq("project_id", projectId)
    .maybeSingle();
  if (isMissingTable(error, ...TABLES)) return { known: false, row: null };
  if (error) throw error;
  return { known: true, row: (data as unknown as ProjectBillTo | null) ?? null };
}

/** The newest changes first: who changed it, from what, to what, when. */
export async function listProjectBillToHistory(projectId: string): Promise<BillToChange[]> {
  const { data, error } = await supabase
    .from("project_bill_to_history")
    .select(HISTORY_COLS)
    .eq("project_id", projectId)
    .order("changed_at", { ascending: false })
    .limit(20);
  if (isMissingTable(error, ...TABLES)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as BillToChange[];
}

const PAGE = 1000;

/**
 * Every job's bill-to, keyed by job id, for the export. Null when this
 * database has no bill-to yet — the export then keeps its old columns, which
 * the invoice script already handles. Paged, because PostgREST stops at 1000
 * rows and a job missing from this map would export a blank.
 */
export async function listProjectBillToCells(): Promise<Map<string, BillToCells> | null> {
  const cells = new Map<string, BillToCells>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("project_bill_to")
      .select(PROJECT_BILL_TO_COLS)
      .order("project_id")
      .range(offset, offset + PAGE - 1);
    if (isMissingTable(error, ...TABLES)) return null;
    if (error) throw error;
    const rows = (data ?? []) as unknown as ProjectBillTo[];
    for (const row of rows) cells.set(row.project_id, billToCells(row));
    if (rows.length < PAGE) return cells;
  }
}

/** The two export cells for one job's row. */
export function billToCells(row: ProjectBillTo): BillToCells {
  return {
    name: row.customer?.name ?? "",
    quickbooksId: row.customer?.quickbooks_customer_id ?? "",
  };
}

export async function saveBillToCustomer(input: {
  id: string | null;
  name: string;
  billingEmail: string;
  quickbooksCustomerId: string;
}): Promise<BillToCustomer> {
  const { data, error } = await supabase.rpc("save_bill_to_customer", {
    p_id: input.id,
    p_name: input.name,
    p_billing_email: input.billingEmail,
    p_quickbooks_customer_id: input.quickbooksCustomerId,
  });
  if (error) throw error;
  return data as BillToCustomer;
}

export async function setBillToCustomerRetired(id: string, retired: boolean): Promise<BillToCustomer> {
  const { data, error } = await supabase.rpc("set_bill_to_customer_retired", {
    p_id: id,
    p_retired: retired,
  });
  if (error) throw error;
  return data as BillToCustomer;
}

export async function setProjectBillTo(projectId: string, customerId: string): Promise<void> {
  const { error } = await supabase.rpc("set_project_bill_to", {
    p_project_id: projectId,
    p_bill_to_customer_id: customerId,
  });
  if (error) throw error;
}
