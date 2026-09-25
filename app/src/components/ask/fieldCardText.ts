// Words for Forge AI field cards: the reader's language, readable values.
// Kept out of FieldCards.tsx so that file exports only components.
import type { TFn, TKey } from "./fieldCatalog";
import type { FieldReceipt } from "../../lib/fieldAsk";
import { FACT_LABELS, factText } from "../../lib/customWork/model";
import { formatApiError } from "../../lib/errors";
import { isToolboxGateError } from "../../lib/install/installTimer";

/** Why a tapped choice was not applied, in the reader's language. Forge's own
 * refusal for an unsigned toolbox talk — a unit or prep-time start on the
 * clock (20261031000000) — is said in words that point at the talk; any other
 * refusal keeps the server's sentence after the generic line. */
export function choiceFailureText(t: TFn, e: unknown): string {
  if (isToolboxGateError(e)) return t("field.toolboxRefused");
  return `${t("field.choiceFailed")} ${formatApiError(e)}`;
}

const KEYED = new Set(["label", "type_label", "components", "material", "width_in", "height_in", "area_source", "story", "opening_direction", "electrical", "access", "complexity", "equipment_needed"]);
const REASONS = ["similar_job", "fact_conflict", "plan_conflict", "identity", "claimed", "needs_clock", "wrong_job", "on_break", "confirm_time"];
const OPTIONS = ["create_new", "keep_original", "correct_record", "send_for_review", "use_plans", "use_said", "join_helper", "start_now", "end_break_and_start", "cancel"];

/** A saved or spoken value in words: components, lists and sizes are written
 * out, never shown as "[object Object]". */
export function differenceText(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const text = factText(key, value);
  return (key === "width_in" || key === "height_in") && typeof value === "number" ? `${text} in` : text;
}
export function differenceLabel(t: TFn, key: string): string {
  return KEYED.has(key) ? t(`field.key.${key}` as TKey) : (FACT_LABELS[key] ?? key.replaceAll("_", " "));
}

/** The question in the reader's language; the server's English wording is the fallback. */
export function reasonText(t: TFn, r: FieldReceipt): string {
  if (!r.reason || !REASONS.includes(r.reason)) return r.message ?? "";
  // A plan conflict is about a map unit with no record yet: name it by its map code.
  return t(`field.reason.${r.reason}` as TKey, { label: r.unit?.label ?? String(r.map_code ?? ""), job: String(r.current_job ?? "") });
}
export function optionText(t: TFn, r: FieldReceipt, o: { id: string; label: string }): string {
  if (o.id.startsWith("use_existing:")) return t("field.option.use_existing", { name: r.matches?.find((m) => `use_existing:${m.id}` === o.id)?.name ?? o.label });
  return OPTIONS.includes(o.id) ? t(`field.option.${o.id}` as TKey) : o.label;
}
