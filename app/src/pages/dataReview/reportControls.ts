export type ReportDimension = "job" | "floor" | "activity" | "scope" | "person" | "category" | "subtype" | "configuration" | "system" | "material";
export const facetColors: Record<ReportDimension, string> = { job: "#60b9d0", floor: "#b29aed", activity: "#edb953", scope: "#7ac69b", person: "#e68eae", category: "#8b949e", subtype: "#8b949e", configuration: "#8b949e", system: "#8b949e", material: "#8b949e" };
export type RangePreset = "all" | "week" | "month" | "quarter" | "year" | "custom" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth";
export function presetRange(preset: RangePreset, today: string) {
  if (preset === "all" || preset === "custom") return { from: "", until: "" };
  const end = new Date(`${today}T12:00:00Z`), start = new Date(end);
  if (preset === "thisWeek" || preset === "lastWeek") {
    start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7 - (preset === "lastWeek" ? 7 : 0));
    end.setTime(start.getTime()); end.setUTCDate(end.getUTCDate() + 6);
    return { from: start.toISOString().slice(0, 10), until: end.toISOString().slice(0, 10) };
  }
  if (preset === "thisMonth" || preset === "lastMonth") {
    start.setUTCDate(1);
    if (preset === "lastMonth") start.setUTCMonth(start.getUTCMonth() - 1);
    end.setTime(start.getTime()); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
    return { from: start.toISOString().slice(0, 10), until: end.toISOString().slice(0, 10) };
  }
  if (preset === "week") start.setUTCDate(start.getUTCDate() - 6);
  else {
    const day = start.getUTCDate(); start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - (preset === "month" ? 1 : preset === "quarter" ? 3 : 12));
    const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, last));
  }
  return { from: start.toISOString().slice(0, 10), until: today };
}
export function denverToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
