import type { ActivityRow } from "./activityRows";

const zone = "America/Denver";
export function workDate(time: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function midnight(date: string) {
  const target = Date.parse(`${date}T00:00:00Z`);
  let time = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(time);
    const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    time += target - wall;
  }
  return time;
}
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const monday = (date: string) => addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
export interface GeneralSegment { activity: string; seconds: number; ids: string[] }
export interface GeneralBucket { segments: GeneralSegment[]; key: string; seconds: number; totalSeconds: number; ids: string[]; partial: boolean }
export function generalLabor(rows: ActivityRow[], activity: string | null, weekly: boolean, from = -Infinity, until = Infinity, now = Date.now(), scope: "General" | "all" = "General") {
  const general = rows.filter(row => scope === "all" || row.scope === "General");
  const buckets = new Map<string, GeneralBucket>();
  const first = Math.min(...general.map(row => Math.max(Date.parse(row.started), from)));
  const last = Math.max(...general.map(row => Math.min(Date.parse(row.ended), until, now)));
  if (weekly && first < last) {
    for (let date = monday(workDate(first)); midnight(date) < last; date = addDays(date, 7)) {
      const start = midnight(date), end = midnight(addDays(date, 7));
      buckets.set(date, { key: date, seconds: 0, totalSeconds: 0, ids: [], segments: [], partial: start < from || end > until || end > now });
    }
  }
  for (const row of general) {
    let start = Math.max(Date.parse(row.started), from);
    const end = Math.min(Date.parse(row.ended), until, now);
    while (start < end) {
      const key = weekly ? monday(workDate(start)) : row.activity;
      const stop = weekly ? Math.min(end, midnight(addDays(key, 7))) : end;
      const bucket = buckets.get(key) ?? { key, seconds: 0, totalSeconds: 0, ids: [], segments: [], partial: false };
      bucket.totalSeconds += (stop - start) / 1000;
      if (activity === null || activity === row.activity) {
        bucket.seconds += (stop - start) / 1000;
        let segment = bucket.segments.find(item => item.activity === row.activity);
        if (!segment) { segment = { activity: row.activity, seconds: 0, ids: [] }; bucket.segments.push(segment); }
        segment.seconds += (stop - start) / 1000;
        if (!segment.ids.includes(row.id)) segment.ids.push(row.id);
        if (!bucket.ids.includes(row.id)) bucket.ids.push(row.id);
      }
      buckets.set(key, bucket); start = stop;
    }
  }
  const total = [...buckets.values()].reduce((sum, bucket) => sum + bucket.totalSeconds, 0);
  return [...buckets.values()].filter(bucket => weekly || activity === null || bucket.key === activity)
    .map(bucket => ({ ...bucket, percent: (weekly ? bucket.totalSeconds : total) > 0 ? bucket.seconds / (weekly ? bucket.totalSeconds : total) * 100 : null }))
    .sort((a, b) => weekly ? a.key.localeCompare(b.key) : b.seconds - a.seconds);
}

export function weeklyScale(hours: number) {
  if (hours <= 0) return 1;
  const rough = hours / 4, power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find(value => value * power >= rough)! * power;
  return Math.ceil(hours / step) * step;
}
