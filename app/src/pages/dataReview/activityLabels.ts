// Reporting-only aliases. Keep source records unchanged; add reviewed equivalents
// here instead of stemming or guessing at unrelated activities/cost codes.
const aliases: Readonly<Record<string, string>> = { install: "Install", installing: "Install" };
export function reportingActivity(label: string) {
  return aliases[label.trim().toLowerCase()] ?? label;
}
