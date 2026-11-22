import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Sparkles, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";
import type { PlanDrawingLabel } from "../../lib/install/matchCadPlanOpening";
import { cadIsFull, planCropAround, reviewOpeningWithAi, variantOf, type AiMatch, type CadQuantities } from "./aiCadReview";
import type { ManualImportDefinition } from "../../lib/install/unitImportFinish";
import { ManualImportUnitFields, NO_CAD } from "./ManualImportUnitFields";
import { drawSharpCrop } from "./drawingCrop";

export function PlanMatchEvidence({ opening, plan, cad, drafts, projectId, suggested, reviewed, relatedDraft, familyCount, quantities, ai, onAi, onFullScreen, onReviewed, onClose }: {
  opening: { x: number; y: number; mark: string; sheet: number; floor: string | null; labels: PlanDrawingLabel[] };
  plan: PDFDocumentProxy;
  cad?: PDFDocumentProxy;
  drafts: readonly CadUnitDraft[];
  projectId: string;
  suggested?: CadUnitDraft;
  relatedDraft?: CadUnitDraft;
  familyCount?: number;
  quantities: CadQuantities;
  reviewed?: { mark: string; floor: string | null; drawing: string; manualDefinition?: ManualImportDefinition };
  /** An AI answer already given for this opening, by the batch or an earlier look. */
  ai?: AiMatch;
  onAi: (answer: AiMatch) => void;
  /** Open one of the two drawings full screen; the other stays a tap away. */
  onFullScreen: (draft: CadUnitDraft | undefined, focus: "plan" | "cad") => void;
  onReviewed: (review: { mark: string; floor: string | null; drawing: string; manualDefinition?: ManualImportDefinition }) => void;
  onClose: () => void;
}) {
  const variant = variantOf(drafts, relatedDraft, opening.mark);
  const aiKey = ai?.key && !cadIsFull(quantities, ai.key) ? ai.key : undefined;
  const [choice, setChoice] = useState(reviewed?.manualDefinition ? NO_CAD : reviewed?.drawing ?? suggested?.key ?? aiKey ?? (variant && !cadIsFull(quantities, variant.key) ? variant.key : undefined) ?? "");
  const [manualDefinition, setManualDefinition] = useState(reviewed?.manualDefinition);
  const [validDimensions, setValidDimensions] = useState(true);
  const [mark, setMark] = useState(reviewed?.mark ?? opening.mark);
  const [floor, setFloor] = useState(reviewed?.floor ?? opening.floor ?? "");
  const [planCrop, setPlanCrop] = useState<string>();
  const [cadCrop, setCadCrop] = useState<{ key: string; image: string }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(ai?.key && !aiKey ? "" : ai?.reason ?? "");
  const byKey = new Map(drafts.map(draft => [draft.key, draft]));
  const candidate = byKey.get(choice);
  const quantity = candidate ? quantities[candidate.key] : undefined;
  // Keep the drawing picker and carousel in the same order.
  const likelyKeys = new Set([reviewed?.drawing, suggested?.key, aiKey, variant?.key, relatedDraft?.key]);
  const likelyDrawings = [...likelyKeys].flatMap(key => {
    const draft = typeof key === "string" ? byKey.get(key) : undefined;
    return draft ? [draft] : [];
  });
  const otherDrawings = drafts.filter(draft => !likelyKeys.has(draft.key));
  const order = [...likelyDrawings, ...otherDrawings].map(draft => draft.key);
  const at = order.indexOf(choice);
  const turn = (by: number) => {
    if (!order.length) return;
    setValidDimensions(true);
    setChoice(order[at < 0 ? (by > 0 ? 0 : order.length - 1) : (at + by + order.length) % order.length]);
    setNote("");
  };

  const drawingOption = (draft: CadUnitDraft) => <option key={draft.key} value={draft.key}>{draft.label} · Sheet {draft.sheet}</option>;

  useEffect(() => {
    let active = true;
    const { x, y, sheet } = opening;
    void drawSharpCrop(plan, sheet, planCropAround(x, y), 1400).then(image => { if (active) setPlanCrop(image); }, () => { if (active) setPlanCrop(""); });
    return () => { active = false; };
  }, [opening, plan]);

  useEffect(() => {
    if (!cad || !candidate) return;
    let active = true;
    void drawSharpCrop(cad, candidate.sheet, candidate.crop, 1500).then(image => {
      if (active) setCadCrop({ key: candidate.key, image });
    }, () => { if (active) setCadCrop({ key: candidate.key, image: "" }); });
    return () => { active = false; };
  }, [cad, candidate]);

  const askAi = async () => {
    if (!planCrop || suggested || busy) return;
    setBusy(true);
    setNote("");
    const answer = await reviewOpeningWithAi({ projectId, opening, plan, cad, drafts, relatedDraft, familyCount, quantities, planCrop });
    if (answer.key) setChoice(answer.key);
    setNote(answer.reason);
    onAi(answer);
    setBusy(false);
  };

  return <section className="cad-plan-evidence" aria-label={`Evidence for mark ${opening.mark}`}>
    <header className="ub-evidence-head">
      <h3>Mark {opening.mark} <span>{opening.floor ?? "Floor unclear"}</span></h3>
      <button type="button" data-variant="ghost" aria-label="Close evidence" onClick={onClose}><X size={16} aria-hidden="true"/></button>
    </header>
    {variant && !reviewed && <p className="ub-alert" data-tone="info">Compare {variant.label} with {relatedDraft?.label}. The suffix suggests a variant, but the opening still needs confirmation.</p>}
    <div className="ub-evidence-fields">
      <label>Opening mark <input value={mark} onChange={event => setMark(event.target.value)}/></label>
      <label>Floor <input value={floor} onChange={event => setFloor(event.target.value)}/></label>
      <label>Compare CAD drawing <select value={choice} onChange={event => { setChoice(event.target.value); setValidDimensions(true); setNote(""); }} disabled={busy}>
        <option value="">Choose a drawing</option>
        <option value={NO_CAD}>No CAD</option>
        {likelyDrawings.length > 0 && <optgroup label="Likely drawings">{likelyDrawings.map(drawingOption)}</optgroup>}
        {likelyDrawings.length > 0 && otherDrawings.length > 0
          ? <optgroup label="Other drawings">{otherDrawings.map(drawingOption)}</optgroup>
          : otherDrawings.map(drawingOption)}
      </select></label>
    </div>
    {quantity && quantity.found >= quantity.expected && <p className="ub-alert" data-tone="warn">
      Linking this opening to {candidate?.label} would bring it to {quantity.found + 1} / {quantity.expected}.
    </p>}
    <div className="ub-evidence-pair">
      <figure className="cad-import-source"><figcaption><span>Plan sheet {opening.sheet}</span>
        <button type="button" className="ub-expand" data-variant="ghost" aria-label={`Open the plan around mark ${opening.mark} full screen`} title="Full screen"
          onClick={() => onFullScreen(candidate, "plan")}><Maximize2 size={16} aria-hidden="true"/></button></figcaption>
        {planCrop ? <img className="ub-zoomable" src={planCrop} alt={`Plan crop around mark ${opening.mark}`} onClick={() => onFullScreen(candidate, "plan")}/> : <p className={planCrop === "" ? "ub-note" : "ub-progress"}>{planCrop === "" ? "Crop unavailable." : "Rendering plan crop…"}</p>}
      </figure>
      <figure className="cad-import-source"><figcaption><span>{candidate ? `CAD ${candidate.label} · Sheet ${candidate.sheet}` : "CAD drawing"}
          {candidate && at >= 0 && at < likelyDrawings.length && <span className="ub-count">Likely</span>}</span>
        {order.length > 1 && <span className="ub-carousel" role="group" aria-label="Step through CAD drawings">
          <button type="button" data-variant="ghost" disabled={busy} aria-label="Previous CAD drawing" onClick={() => turn(-1)}><ChevronLeft size={16} aria-hidden="true"/></button>
          <output aria-live="polite">{at < 0 ? "–" : at + 1} / {order.length}</output>
          <button type="button" data-variant="ghost" disabled={busy} aria-label="Next CAD drawing" onClick={() => turn(1)}><ChevronRight size={16} aria-hidden="true"/></button>
        </span>}
        {candidate && cad && <button type="button" className="ub-expand" data-variant="ghost" aria-label={`Open CAD ${candidate.label} full screen`} title="Full screen"
          onClick={() => onFullScreen(candidate, "cad")}><Maximize2 size={16} aria-hidden="true"/></button>}</figcaption>
        {candidate && cadCrop?.key === candidate.key && cadCrop.image ? <img className="ub-zoomable" src={cadCrop.image} alt={`CAD crop for ${candidate.label}`} onClick={() => onFullScreen(candidate, "cad")}/>
          : <p className={candidate && cad && cadCrop?.key !== candidate.key ? "ub-progress" : "ub-note"}>{candidate && cad ? cadCrop?.key === candidate.key ? "Crop unavailable." : "Rendering CAD crop…" : "Choose a CAD drawing to compare."}</p>}
      </figure>
    </div>
    {busy && <p role="status" className="ub-progress">Comparing the opening with the CAD drawings…</p>}
    {note && !busy && <p role="status" className="ub-alert" data-tone="info"><Sparkles size={16} aria-hidden="true"/><span>{note}</span></p>}
    {choice === NO_CAD && manualDefinition && <ManualImportUnitFields value={manualDefinition}
      onChange={setManualDefinition} onValidChange={setValidDimensions}/>}
    <footer className="ub-evidence-foot">
      {choice !== NO_CAD && !suggested && drafts.length > 0 && <div className="ub-ai">
        <button type="button" disabled={!planCrop || busy} onClick={() => void askAi()}><Sparkles size={16} aria-hidden="true"/>{busy ? "Reviewing…" : import.meta.env.DEV ? "Ask local Codex to review" : "Ask OpenAI to review"}</button>
        <p className="ub-note">Sends the opening crop and up to three nearby CAD crops for a suggested match. No job records are saved.{import.meta.env.DEV && " In development this runs through Codex on this computer."}</p>
      </div>}
      {choice === NO_CAD && !manualDefinition
        ? <button type="button" data-variant="primary" disabled={busy} onClick={() => setManualDefinition({})}>Define Unit</button>
        : <button type="button" data-variant="primary"
          disabled={busy || !mark.trim() || !floor.trim() || (choice === NO_CAD ? !manualDefinition?.kind || !validDimensions : !candidate?.kind)}
          onClick={() => {
            onReviewed({ mark: mark.trim(), floor: floor.trim(), drawing: candidate?.key ?? "",
              manualDefinition: choice === NO_CAD ? manualDefinition : undefined });
            onClose();
          }}>{choice === NO_CAD ? "Add to units" : "Link opening"}</button>}
    </footer>
  </section>;
}
