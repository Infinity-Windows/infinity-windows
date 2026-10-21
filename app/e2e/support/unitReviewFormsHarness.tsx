/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { UnitVerificationFields } from "../../src/components/work/UnitVerificationFields";
import { UnitQcReviewFields } from "../../src/components/work/UnitQcReviewFields";
import { emptyVerificationDraft, emptyQcDraft, type ReviewContext, type ReviewDelivery, type QcDefect, type QcState } from "../../src/lib/workUnitReview/form";
import { LanguageContext } from "../../src/lib/i18n/context";
import "../../src/index.css";

// Synthetic controlled-component harness: no Supabase calls, no browser storage.
const initial: ReviewContext = { actorId: "reviewer-fixture", basisStatus: "current",
  basis: { unitId: "synthetic-unit-42", unitRevision: 9, factId: "synthetic-fact-4", factRevision: 4, scopeToken: "opaque-fixture-server-token", reviewRevision: 2, submissionId: "synthetic-submission-1", generation: 1 },
  original: { observerId: "installer-fixture", widthDecimal: "6", heightDecimal: "8", unit: "ft", source: "estimated", sourceReference: "Fixture plan reference / " + "AluminumBifoldDetails".repeat(15) } };
function Harness() {
  const [lang, setLang] = useState<"en" | "es">(new URLSearchParams(location.search).get("lang") === "es" ? "es" : "en");
  const [context, setContext] = useState(initial), [delivery, setDelivery] = useState<ReviewDelivery>("idle");
  const [v, setV] = useState(() => emptyVerificationDraft(initial)), [q, setQ] = useState(() => emptyQcDraft(initial));
  const [state, setState] = useState<QcState>("awaiting_review"), [allowed, setAllowed] = useState(true);
  const [defects, setDefects] = useState<readonly QcDefect[]>([]);
  const [intents, setIntents] = useState<unknown[]>([]);
  const emit = (intent: unknown) => { setIntents(old => [...old, intent]); setDelivery("pending"); };
  const updateContext = (next: ReviewContext, reset = true) => { setContext(next); if (reset) { setV(emptyVerificationDraft(next)); setQ(emptyQcDraft(next)); } setDelivery("idle"); };
  const fixtureButton = { minHeight: 44, maxWidth: "100%", whiteSpace: "normal" as const };
  return <LanguageContext.Provider value={{ lang, t: () => "", setLang, needsChoice: false }}>
    <main style={{ maxWidth: 760, minWidth: 0, padding: 12, margin: "auto", overflowWrap: "anywhere" }}>
      <h1>Unit 42 · controlled review fixture</h1>
      <nav aria-label="Fixture controls" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <button style={fixtureButton} onClick={() => setLang(lang === "en" ? "es" : "en")}>Change language</button>
        <button style={fixtureButton} onClick={() => { updateContext({ ...initial, basis: { ...initial.basis! } }); setState("awaiting_review"); setDefects([]); }}>Reset fixture</button>
        <button style={fixtureButton} onClick={() => setDelivery("unknown")}>Unknown delivery</button>
        <button style={fixtureButton} onClick={() => setDelivery("refused")}>Refused delivery</button>
        <button style={fixtureButton} onClick={() => setDelivery("applied")}>Confirmed request</button>
        <button style={fixtureButton} onClick={() => updateContext({ ...context, basisStatus: "stale" }, false)}>Stale basis</button>
        <button style={fixtureButton} onClick={() => updateContext({ ...context, basisStatus: "unavailable" }, false)}>Unavailable source</button>
        <button style={fixtureButton} onClick={() => updateContext({ ...context, original: { ...context.original!, observerId: context.actorId } })}>Self observer</button>
        <button style={fixtureButton} onClick={() => updateContext({ ...context, original: { ...context.original!, observerId: null } })}>Unknown observer</button>
        <button style={fixtureButton} onClick={() => updateContext({ ...context, actorId: "other-fixture-reviewer" }, false)}>Change actor</button>
        <button style={fixtureButton} onClick={() => setAllowed(!allowed)}>Toggle authority</button>
        <button style={fixtureButton} onClick={() => { setState("failed"); setDefects([{ id: "fixture-defect-1", summary: "Fixture bottom seal needs correction / " + "LowerCornerCheck".repeat(12), state: "open" }, { id: "fixture-defect-2", summary: "Fixture hardware needs adjustment", state: "open" }]); setDelivery("idle"); setQ(emptyQcDraft(context)); }}>Failed state</button>
        <button style={fixtureButton} onClick={() => { setState("passed"); setDelivery("idle"); setQ(emptyQcDraft(context)); }}>Passed state</button>
        <button style={fixtureButton} onClick={() => { const next = { ...context, basis: { ...context.basis!, submissionId: null } }; updateContext(next); setState("not_submitted"); }}>Not submitted state</button>
        <button style={fixtureButton} onClick={() => updateContext({ ...initial, original: { ...initial.original!, widthDecimal: "1.00000000000000001", heightDecimal: "96", unit: "in" } })}>Precision observation</button>
        <button style={fixtureButton} onClick={() => { setDefects(old => old.map((d, i) => i === 0 ? { ...d, state: "claimed_resolved" } : d)); setState("failed"); updateContext({ ...context, basis: { ...context.basis!, reviewRevision: context.basis!.reviewRevision + 1 } }); }}>Confirmed partial claim</button>
        <button style={fixtureButton} onClick={() => { setDefects(old => old.map(d => ({ ...d, state: "claimed_resolved" }))); setState("awaiting_review"); updateContext({ ...context, basis: { ...context.basis!, reviewRevision: context.basis!.reviewRevision + 1, generation: context.basis!.generation + 1, submissionId: "synthetic-submission-2" } }); }}>Confirmed all claims</button>
        <button style={fixtureButton} onClick={() => { setDefects(old => old.map(d => ({ ...d, state: "verified_resolved" }))); setState("passed"); updateContext({ ...context, basis: { ...context.basis!, reviewRevision: context.basis!.reviewRevision + 1 } }); }}>Confirmed reviewer pass</button>
      </nav>
      <div style={{ display: "grid", gap: 16 }}>
        <UnitVerificationFields context={context} value={v} onChange={setV} delivery={delivery} allowed={allowed} onIntent={emit} observerLabel="Jordan Fixture" actorLabel="Riley Fixture" />
        <UnitQcReviewFields context={context} value={q} onChange={setQ} delivery={delivery} state={state} defects={defects}
          authority={{ submit: allowed, pass: allowed, fail: allowed, claim_resolved: allowed, reopen: allowed }} onIntent={emit} />
      </div>
      <output data-testid="intent-count">{intents.length}</output><pre data-testid="intent-json" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(intents)}</pre>
    </main>
  </LanguageContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
