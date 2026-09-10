export const STAGES = [
  "intake",
  "drafting",
  "submitted",
  "approved",
  "scheduled",
  "in_progress",
  "complete",
  "on_hold",
  "lost",
] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  intake: "Intake",
  drafting: "Drafting",
  submitted: "Submitted",
  approved: "Approved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  complete: "Complete",
  on_hold: "On hold",
  lost: "Lost / declined",
};
export const KINDS = {
  service_call: "Service call",
  service_work: "Service work",
  installation: "New installation",
  delivery: "Delivery",
};
export type Kind = keyof typeof KINDS;
export const STATES =
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " ",
  );
export interface Job {
  id: string;
  name: string;
  contractor: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  address: string;
  city: string;
  state: string;
  kind: Kind;
  stage: Stage;
  scope: string;
  notes: string;
  project_id: string | null;
  start_precision: "unknown" | "month" | "week" | "range" | "date";
  target_start: string | null;
  target_end: string | null;
  confirmed_start: string | null;
  confirmation_note: string;
  follow_up_on: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface Bid {
  id: string;
  job_id: string;
  number: string;
  revision: number;
  contractor: string;
  amount: number;
  scope: string;
  line_items: LineItem[];
  submitted_at: string | null;
  accepted_at: string | null;
  accepted_amount: number | null;
  accepted_scope: string;
  acceptance_email: string;
  signed_document_id: string | null;
  created_at: string;
}
export interface LineItem {
  description: string;
  quantity?: number;
  unit?: string;
  rate?: number;
}
export interface JobFile {
  id: string;
  job_id: string;
  filename: string;
  storage_path: string;
  kind: string;
  bytes: number;
  ready: boolean;
  created_at: string;
}
export interface Activity {
  id: string;
  job_id: string;
  kind: string;
  detail: string;
  created_at: string;
}
export interface Rate {
  id: string;
  category: Kind;
  name: string;
  contractor: string;
  unit: string;
  amount: number | null;
  minimum: string;
  notes: string;
  effective_on: string;
  created_at: string;
}
export function localDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function daysOld(date: string, now = new Date()) {
  return Math.max(
    0,
    Math.floor(
      (Date.parse(localDay(now) + "T00:00:00Z") -
        Date.parse(date.slice(0, 10) + "T00:00:00Z")) /
        86400000,
    ),
  );
}
export function followUpDue(job: Job, now = new Date()) {
  return (
    !!job.follow_up_on &&
    job.follow_up_on <= localDay(now) &&
    !["complete", "lost", "on_hold"].includes(job.stage)
  );
}
export function money(value: number | null) {
  return value === null
    ? "Not set"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);
}
export function latestBids(bids: Bid[]) {
  const groups = new Map<string, Bid>();
  for (const bid of bids) {
    const key = JSON.stringify([bid.job_id, bid.contractor, bid.number]);
    const prev = groups.get(key);
    if (!prev || prev.revision < bid.revision) groups.set(key, bid);
  }
  return [...groups.values()];
}
export function startLabel(job: Pick<Job, "confirmed_start" | "target_start" | "target_end" | "start_precision">) {
  if (job.confirmed_start) return `Confirmed ${job.confirmed_start}`;
  if (!job.target_start || job.start_precision === "unknown")
    return "Start not set";
  if (job.start_precision === "month")
    return (
      new Date(job.target_start + "T12:00:00").toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }) + " · tentative"
    );
  if (job.start_precision === "week")
    return `Week of ${job.target_start} · tentative`;
  return `${job.target_start}${job.target_end ? " – " + job.target_end : ""} · tentative`;
}
