// Pure service-reminder math. Given a vehicle's next-service date and/or a
// mileage target, decide whether service is overdue, due soon, or fine. Kept
// free of React/Supabase so the badge logic is directly unit-testable.

export type ServiceLevel = "overdue" | "due_soon" | "ok" | "none";

/** Whole days from `todayISO` to `dateISO` (negative = in the past). */
export function daysUntil(todayISO: string, dateISO: string): number {
  const day = 24 * 60 * 60 * 1000;
  const a = Date.parse(`${todayISO}T00:00:00Z`);
  const b = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / day);
}

export interface ServiceInput {
  todayISO: string;
  nextServiceDate?: string | null;
  /** Current odometer (miles) for a mileage-based reminder. */
  odometer?: number | null;
  /** Odometer target at which the next service is due. */
  nextServiceOdometer?: number | null;
  /** How many days ahead counts as "due soon" (default 14). */
  soonDays?: number;
  /** How many miles ahead counts as "due soon" (default 500). */
  soonMiles?: number;
}

const SEVERITY: Record<ServiceLevel, number> = {
  overdue: 3,
  due_soon: 2,
  ok: 1,
  none: 0,
};

/** Most-severe of the date- and mileage-based signals. */
export function serviceLevel(input: ServiceInput): ServiceLevel {
  const soonDays = input.soonDays ?? 14;
  const soonMiles = input.soonMiles ?? 500;
  let level: ServiceLevel = "none";

  const bump = (next: ServiceLevel) => {
    if (SEVERITY[next] > SEVERITY[level]) level = next;
  };

  if (input.nextServiceDate) {
    const d = daysUntil(input.todayISO, input.nextServiceDate);
    if (!Number.isNaN(d)) {
      if (d < 0) bump("overdue");
      else if (d <= soonDays) bump("due_soon");
      else bump("ok");
    }
  }

  if (
    input.odometer != null &&
    input.nextServiceOdometer != null &&
    Number.isFinite(input.odometer) &&
    Number.isFinite(input.nextServiceOdometer)
  ) {
    const remaining = input.nextServiceOdometer - input.odometer;
    if (remaining <= 0) bump("overdue");
    else if (remaining <= soonMiles) bump("due_soon");
    else bump("ok");
  }

  return level;
}

export interface ServiceBadge {
  label: string;
  /** Maps to a CSS tone class: red for overdue, amber for due soon. */
  tone: "overdue" | "due_soon";
}

/** Badge for a level, or null when nothing needs surfacing (ok / none). */
export function serviceBadge(input: ServiceInput): ServiceBadge | null {
  const level = serviceLevel(input);
  if (level === "overdue") return { label: "Service overdue", tone: "overdue" };
  if (level === "due_soon") {
    if (input.nextServiceDate) {
      const d = daysUntil(input.todayISO, input.nextServiceDate);
      if (!Number.isNaN(d) && d >= 0) {
        return { label: d === 0 ? "Service due today" : `Service in ${d}d`, tone: "due_soon" };
      }
    }
    return { label: "Service due soon", tone: "due_soon" };
  }
  return null;
}
