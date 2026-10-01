import type { Lang } from "../i18n/translate";
import { parseClockSeconds } from "./conflicts";

/** Clock labels use the same strict parser as detection; invalid stored times
 * must not normalize into plausible-looking hours. */
export function formatConflictClock(value: string | null | undefined, lang: Lang): string | null {
  const seconds = parseClockSeconds(value);
  if (seconds === null) return null;
  return new Intl.DateTimeFormat(lang === "es" ? "es-MX" : "en-US", {
    hour: lang === "es" ? "2-digit" : "numeric",
    minute: "2-digit",
    ...(seconds % 60 ? { second: "2-digit" as const } : {}),
    hour12: lang === "en",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, 0, 0, seconds)));
}
