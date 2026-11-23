// Disposable pilot choices shared by planning and Workday.
export const PILOT_ACTIVITIES = [
  { kind: "general", label: "General job work", names: ["Setup", "Loading product", "Travel", "Travel with product", "Unloading product", "Hauling", "Safety / game plan", "Consulting / planning", "Waiting / blocked", "Cleanup"] },
  { kind: "unit", label: "Unit work", names: ["Staging", "RO checked", "Flashing", "Setting frame", "Sealing", "QC / adjustments", "Repairs", "RO framing", "Problem-solving", "Cutting down / Building"] },
] as const;

const activityKeys = PILOT_ACTIVITIES.flatMap(group => group.names.map(name => group.kind + ":" + name));

export function pilotActivityColor(key: string): string {
  const index = activityKeys.indexOf(key);
  const hash = [...key].reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0);
  const hue = index < 0 ? hash % 360 : Math.round(index * 137.508) % 360;
  return `hsl(${hue} 55% 65%)`;
}
