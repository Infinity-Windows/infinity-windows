import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FieldChecklist, FieldReceiptCard } from "./FieldCards";
import { choiceFailureText, optionText, reasonText } from "./fieldCardText";
import { buildChecklist, completeAnswers } from "../../../../supabase/functions/_shared/fieldTools";
import { translate } from "../../lib/i18n/translate";
import { CATALOG } from "../../lib/i18n/catalog";
import { FIELD_CATALOG, type TKey } from "./fieldCatalog";
import type { FieldReceipt } from "../../lib/fieldAsk";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const es = ((key: TKey, vars?: Record<string, string | number>) => translate({ ...CATALOG, ...FIELD_CATALOG }, "es", key, vars)) as never;

describe("receipt cards", () => {
  it("a waiting choice says nothing has changed and offers only its options", () => {
    const r: FieldReceipt = { action_id: "a", action: "start_unit", status: "needs_choice", reason: "on_break", preview_hash: "h", options: [{ id: "end_break_and_start", label: "x" }, { id: "cancel", label: "y" }], unit: { unit_id: "u", label: "4", type: "Bifold", facts: {} } };
    const out = html(<FieldReceiptCard receipt={r} onChange={() => undefined} timingPending={async () => false} />);
    expect(out).toContain("nothing has changed yet");
    expect(out).toContain("End break and start");
    expect(out).not.toMatch(/running|started/i);
  });
  it("a stale or cancelled receipt never reads as success", () => {
    for (const status of ["stale", "cancelled"] as const) {
      const out = html(<FieldReceiptCard receipt={{ action_id: "a", action: "start_unit", status, message: "Your job clock changed." }} onChange={() => undefined} timingPending={async () => false} />);
      expect(out).toMatch(/Nothing changed/);
      expect(out).not.toMatch(/Timer running/);
    }
  });
  it("a running timer shows its start basis and that QC is separate on stop", () => {
    const run = html(<FieldReceiptCard receipt={{ action_id: "a", action: "start_unit", status: "running", outcome: "started", started_at: "2026-09-22T15:00:00Z", start_time_basis: "request_sent", unit: { unit_id: "u", label: "4", type: "Bifold", facts: {} } }} onChange={() => undefined} timingPending={async () => false} />);
    expect(run).toContain("Timer running on 4");
    expect(run).toContain("moment you sent the request");
    const stop = html(<FieldReceiptCard receipt={{ action_id: "b", action: "stop_work", status: "done", outcome: "stopped", stage_outcome: "partial" }} onChange={() => undefined} timingPending={async () => false} />);
    expect(stop).toContain("QC is not approved here");
  });
  it("differences are readable: components, sizes and lists are written out", () => {
    const r: FieldReceipt = { action_id: "a", action: "save_unit", status: "needs_choice", reason: "fact_conflict", options: [{ id: "keep_original", label: "k" }],
      unit: { unit_id: "u", label: "4", type: "Bifold", facts: {} },
      differences: {
        components: { stored: [{ label: "Door panel", quantity: 2 }], said: [{ label: "Door panel", quantity: 3 }, { label: "Frame", quantity: 1 }] },
        width_in: { stored: 72, said: 76.5 }, material: { stored: "Vinyl", said: "Aluminum" },
      } };
    const out = html(<FieldReceiptCard receipt={r} onChange={() => undefined} timingPending={async () => false} />);
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("2 × Door panel → 3 × Door panel, 1 × Frame");
    expect(out).toContain("72 in → 76.5 in");
    expect(out).toContain("Vinyl → Aluminum");
  });
  it("a plan conflict names the map unit, and a duplicate-job card shows the new job asked for", () => {
    const plan: FieldReceipt = { action_id: "a", action: "save_unit", status: "needs_choice", reason: "plan_conflict", map_code: "MAP-10", options: [], differences: { width_in: { plans: 60, said: 40 } } };
    expect(html(<FieldReceiptCard receipt={plan} onChange={() => undefined} timingPending={async () => false} />)).toContain("60 in → 40 in");
    const job: FieldReceipt = { action_id: "b", action: "create_job", status: "needs_choice", reason: "similar_job", proposed: { name: "Smith House", location: "12 Oak St" }, matches: [{ id: "j1", name: "Smith Residence", location: "12 Oak St" }], options: [] };
    const out = html(<FieldReceiptCard receipt={job} onChange={() => undefined} timingPending={async () => false} />);
    expect(out).toContain("Smith House · 12 Oak St");
    expect(out).toContain("Smith Residence · 12 Oak St");
  });
  it("choices and questions are shown in Spanish, not the server's English", () => {
    const r: FieldReceipt = { action_id: "a", action: "create_job", status: "needs_choice", reason: "similar_job", options: [{ id: "use_existing:j1", label: "Use Smith" }, { id: "create_new", label: "Create" }], matches: [{ id: "j1", name: "Smith Residence" }] };
    expect(reasonText(es, r)).toContain("obra parecida");
    expect(optionText(es, r, r.options![0])).toBe("Usar Smith Residence");
    expect(optionText(es, r, r.options![1])).toBe("Crear una obra nueva aparte");
  });
  it("a tap Forge refused for the toolbox signature says so in the reader's words; any other refusal keeps the server's sentence", () => {
    const en = ((key: TKey, vars?: Record<string, string | number>) => translate({ ...CATALOG, ...FIELD_CATALOG }, "en", key, vars)) as never;
    // Start now on a prep-time card, and Join as helper on a unit card — the two gate sentences (20261031000000).
    expect(choiceFailureText(en, { code: "P0001", message: "Sign today's toolbox talk before starting work." })).toContain("Sign it under Finish your toolbox talk on Work");
    expect(choiceFailureText(es, { code: "P0001", message: "Sign today's toolbox talk before starting work on a unit." })).toContain("charla de seguridad");
    expect(choiceFailureText(en, new Error("Your current work changed. Sync and review before retrying."))).toBe(
      "That choice was not saved. Nothing changed from it; try again. Your current work changed. Sync and review before retrying.",
    );
  });
});

describe("the checklist card", () => {
  it("lists what is answered, unknown and still needed", () => {
    const c = buildChecklist({ job: { name: "Pine Hollow", location: null }, unit: completeAnswers({ label: "4", type_label: "Bifold door", unknown: ["electrical"] }) });
    const out = html(<FieldChecklist checklist={c} />);
    expect(out).toContain("Pine Hollow");
    expect(out).toContain("Said unknown");
    expect(out).toContain("Still needed");
    expect(out).toContain("needed before timing");
  });
});


describe("lazy field translations", () => {
  it("every field phrase has English, Spanish and matching placeholders", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const [key, entry] of Object.entries(FIELD_CATALOG)) {
      expect(entry.en.trim(), key).not.toBe("");
      expect(entry.es.trim(), key).not.toBe("");
      expect(placeholders(entry.es), key).toEqual(placeholders(entry.en));
    }
  });
});

describe("receipt status words (K2.5)", () => {
  const card = (r: FieldReceipt) => html(<FieldReceiptCard receipt={r} onChange={() => undefined} timingPending={async () => false} />);
  it("every card opens with the real status: Saved in Forge, Needs your choice, or Nothing changed", () => {
    expect(card({ action_id: "a", action: "save_unit", status: "done", outcome: "created_unit", unit: { unit_id: "u", label: "4", type: "Bifold", facts: {} } })).toContain("Saved in Forge");
    expect(card({ action_id: "a", action: "start_unit", status: "running", outcome: "started", started_at: "2026-09-22T15:00:00Z", unit: { unit_id: "u", label: "4", type: "Bifold", facts: {} } })).toContain("Saved in Forge");
    expect(card({ action_id: "a", action: "start_unit", status: "needs_choice", reason: "on_break", preview_hash: "h", options: [{ id: "cancel", label: "y" }], unit: { unit_id: "u", label: "4", type: "Bifold", facts: {} } })).toContain("Needs your choice");
    expect(card({ action_id: "a", action: "start_unit", status: "stale", message: "x" })).toContain("Nothing changed");
    expect(card({ action_id: "a", action: "start_unit", status: "cancelled" })).toContain("Nothing changed");
  });
  it("the checklist says it is kept for the conversation, not saved to the job", () => {
    const out = html(<FieldChecklist checklist={buildChecklist({ unit: completeAnswers({ label: "4" }) })} />);
    expect(out).toContain("nothing saved to the job yet");
  });
  it("the status words exist in Spanish", () => {
    const words = (key: TKey) => translate({ ...CATALOG, ...FIELD_CATALOG }, "es", key);
    expect(words("field.receiptStatus.saved_in_forge")).toBe("Guardado en Forge");
    expect(words("field.receiptStatus.needs_choice")).toBe("Necesita tu decisión");
    expect(words("field.nothingSaved")).toBe("Todavía no se guardó nada");
  });
});
