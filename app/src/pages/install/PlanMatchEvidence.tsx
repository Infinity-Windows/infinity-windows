import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Sparkles, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";
import type { PlanDrawingLabel } from "../../lib/install/matchCadPlanOpening";
import { planCropAround, reviewOpeningWithAi, variantOf, type AiMatch } from "./aiCadReview";
import { drawSharpCrop } from "./drawingCrop";

export function PlanMatchEvidence({ opening, plan, cad, drafts, projectId, suggested, reviewed, relatedDraft, familyCount, ai, onAi, onFullScreen, onReviewed, onClose }: {
  opening: { x: number; y: number; mark: string; sheet: number; floor: string | null; labels: PlanDrawingLabel[] };
  plan: PDFDocumentProxy;
  cad?: PDFDocumentProxy;
  drafts: readonly CadUnitDraft[];
  projectId: string;
  suggested?: CadUnitDraft;
  relatedDraft?: CadUnitDraft;
  familyCount?: number;
  reviewed?: { mark: string; floor: string | null; drawing: string };
  /** An AI answer already given for this opening, by the batch or an earlier look. */
  ai?: AiMatch;
  onAi: (answer: AiMatch) => void;
  /** Open one of the two drawings full screen; the other stays a tap away. */
  onFullScreen: (draft: CadUnitDraft | undefined, focus: "plan" | "cad") => void;
  onReviewed: (review: { mark: string; floor: string | null; drawing: string }) => void;
  onClose: () => void;
}) {
  const variant = variantOf(drafts, relatedDraft);
  const [choice, setChoice] = useState(reviewed?.drawing ?? suggested?.key ?? ai?.key ?? variant?.key ?? "");
  const [mark, setMark] = useState(reviewed?.mark ?? opening.mark);
  const [floor, setFloor] = useState(reviewed?.floor ?? opening.floor ?? "");
  const [planCrop, setPlanCrop] = useState<string>();
  const [cadCrop, setCadCrop] = useState<{ key: string; image: string }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(ai?.reason ?? "");
  const candidate = drafts.find(draft => draft.key === choice);
  // The order the arrows step through: the drawings this opening most likely
  // is come first (its match, the AI's answer, its family drawing and that
  // drawing's variant), then every other definition as the shop CAD lists
  // them. Picking a variant is a matter of looking at one drawing after
  // another against the plan, which a dropdown of names does not let you do
  // (Matt, 2026-11-20: "a better way to pick through CAD variants").
  const likely = [reviewed?.drawing, suggested?.key, ai?.key, relatedDraft?.key, variant?.key]
    .filter((key, index, all): key is string => !!key && all.indexOf(key) === index && drafts.some(draft => draft.key === key));
  const order = [...likely, ...drafts.map(draft => draft.key).filter(key => !likely.includes(key))];
  const at = order.indexOf(choice);
  const turn = (by: number) => {
    if (!order.length) return;
    setChoice(order[at < 0 ? (by > 0 ? 0 : order.length - 1) : (at + by + order.length) % order.length]);
    setNote("");
  };

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
    const answer = await reviewOpeningWithAi({ projectId, opening, plan, cad, drafts, relatedDraft, familyCount, planCrop });
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
      {drafts.length > 0 && <label>Compare CAD drawing <select value={choice} onChange={event => { setChoice(event.target.value); setNote(""); }} disabled={busy}>
        <option value="">Choose a drawing</option>
        {drafts.map(draft => <option key={draft.key} value={draft.key}>{draft.label} · Sheet {draft.sheet}</option>)}
      </select></label>}
    </div>
    <div className="ub-evidence-pair">
      <figure className="cad-import-source"><figcaption><span>Plan sheet {opening.sheet}</span>
        <button type="button" className="ub-expand" data-variant="ghost" aria-label={`Open the plan around mark ${opening.mark} full screen`} title="Full screen"
          onClick={() => onFullScreen(candidate, "plan")}><Maximize2 size={16} aria-hidden="true"/></button></figcaption>
        {planCrop ? <img className="ub-zoomable" src={planCrop} alt={`Plan crop around mark ${opening.mark}`} onClick={() => onFullScreen(candidate, "plan")}/> : <p className={planCrop === "" ? "ub-note" : "ub-progress"}>{planCrop === "" ? "Crop unavailable." : "Rendering plan crop…"}</p>}
      </figure>
      <figure className="cad-import-source"><figcaption><span>{candidate ? `CAD ${candidate.label} · Sheet ${candidate.sheet}` : "CAD drawing"}
          {candidate && at < likely.length && likely.length > 0 && <span className="ub-count">Likely</span>}</span>
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
    <footer className="ub-evidence-foot">
      {!suggested && drafts.length > 0 && <div className="ub-ai">
        <button type="button" disabled={!planCrop || busy} onClick={() => void askAi()}><Sparkles size={16} aria-hidden="true"/>{busy ? "Reviewing…" : import.meta.env.DEV ? "Ask local Codex to review" : "Ask OpenAI to review"}</button>
        <p className="ub-note">Sends the opening crop and up to three nearby CAD crops for a suggested match. No job records are saved.{import.meta.env.DEV && " In development this runs through Codex on this computer."}</p>
      </div>}
      <button type="button" data-variant="primary" disabled={busy || !mark.trim()} onClick={() => {
        onReviewed({ mark: mark.trim(), floor: floor.trim() || null, drawing: candidate?.key ?? "" });
        onClose();
      }}>Confirm in preview</button>
    </footer>
  </section>;
}
