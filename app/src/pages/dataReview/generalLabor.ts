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
