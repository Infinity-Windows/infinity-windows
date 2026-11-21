import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Columns2, Maximize2, Minus, Plus, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";
import { formatInchesMm } from "../../lib/install/dimensionEntry";
import { unitKindLabel } from "../../lib/install/unitDetails";
import { planCropAround } from "./aiCadReview";
import { drawSharpCrop } from "./drawingCrop";

export type CompareTarget = {
  title: string;
  /** The drawing that was tapped. It opens alone at full width; the other is one tap away. */
  focus?: "plan" | "cad";
  plan?: { pdf: PDFDocumentProxy; sheet: number; x: number; y: number };
  cad?: { pdf: PDFDocumentProxy; draft: CadUnitDraft };
};

const ZOOMS = [1, 1.5, 2, 3, 4, 6];

/**
 * One drawing with its own zoom. The plan and the shop drawing are at very
 * different scales, so a shared zoom was always wrong for one of them (Matt,
 * 2026-11-20: "I want to click into the planset or cads independently").
 *
 * Click zooms in on the spot clicked; drag pans; the buttons step out again.
 * A press that moves more than a few pixels is a drag, never a click, so
 * panning does not zoom.
 */
function Pane({ label, image, alt, solo, onSolo }: {
  label: string; image: string | null | undefined; alt: string;
  /** undefined when there is no second drawing to hide. */
  solo?: boolean; onSolo?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  // Where the view should sit after the next zoom: a point of the drawing
  // (0..1) and where in the pane it should stay.
  const anchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; onDrawing: boolean } | null>(null);

  const zoomTo = (next: number, at?: { clientX: number; clientY: number }) => {
    const box = scroller.current;
    const picture = box?.querySelector("img");
    if (!box || !picture || next === zoom) return;
    const frame = box.getBoundingClientRect();
    const rect = picture.getBoundingClientRect();
    const px = at ? at.clientX - frame.left : frame.width / 2;
    const py = at ? at.clientY - frame.top : frame.height / 2;
    anchor.current = { fx: (frame.left + px - rect.left) / rect.width, fy: (frame.top + py - rect.top) / rect.height, px, py };
    setZoom(next);
  };
  useLayoutEffect(() => {
    const box = scroller.current;
    const picture = box?.querySelector("img");
    const point = anchor.current;
    if (!box || !picture || !point) return;
    anchor.current = null;
    // Measured on screen, not from offsetLeft: the pane is not the drawing's
    // offset parent, so offsets are from the dialog and overshoot.
    const frame = box.getBoundingClientRect(), rect = picture.getBoundingClientRect();
    box.scrollLeft += rect.left + point.fx * rect.width - (frame.left + point.px);
    box.scrollTop += rect.top + point.fy * rect.height - (frame.top + point.py);
  }, [zoom]);

  const step = (by: number) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(zoom) + by))];
  const down = (event: PointerEvent<HTMLDivElement>) => {
    const box = scroller.current;
    if (!box || event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false,
      // Read here, not on release: once the pointer is captured the release is
      // reported on the pane, whatever was under the cursor.
      onDrawing: (event.target as Element).tagName === "IMG" };
    box.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = scroller.current, start = drag.current;
    if (!box || !start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 5) return;
    start.moved = true;
    box.scrollLeft = start.left - dx;
    box.scrollTop = start.top - dy;
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    drag.current = null;
    if (start && !start.moved && start.onDrawing) {
      // At the last step a click starts over, so one hand can cycle the zoom.
      zoomTo(zoom === ZOOMS[ZOOMS.length - 1] ? 1 : step(1), event);
    }
  };

  return <figure className="ub-viewer-pane">
    <figcaption>
      <span>{label}</span>
      <span className="ub-viewer-tools" role="group" aria-label={`Zoom ${label}`}>
        <button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => zoomTo(step(-1))}><Minus size={16} aria-hidden="true"/></button>
        <button type="button" className="ub-viewer-level" aria-label="Fit to pane" title="Fit to pane" disabled={zoom === 1} onClick={() => zoomTo(1)}>
          <output aria-live="polite">{Math.round(zoom * 100)}%</output></button>
        <button type="button" aria-label="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => zoomTo(step(1))}><Plus size={16} aria-hidden="true"/></button>
        {onSolo && <button type="button" data-variant="ghost" aria-pressed={solo} aria-label={solo ? "Show both drawings" : `Show only ${label}`}
          title={solo ? "Show both drawings" : "Show only this drawing"} onClick={onSolo}>
          {solo ? <Columns2 size={16} aria-hidden="true"/> : <Maximize2 size={16} aria-hidden="true"/>}</button>}
      </span>
    </figcaption>
    <div ref={scroller} className="ub-viewer-scroll" data-zoomed={zoom > 1 || undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; }}>
      {image ? <img src={image} alt={alt} draggable={false} style={{ width: `${zoom * 100}%` }}/>
        : <p className={image === null ? "ub-note" : "ub-progress"}>{image === null ? "This drawing could not be rendered." : "Rendering at full size…"}</p>}
    </div>
  </figure>;
}

/**
 * The drawings at full screen, so a dimension on the plan can be read against
 * the one on the shop drawing. The side panels are too small for that: a
 * callout is a few pixels tall at their size.
 *
 * Both crops are rendered again here at a higher resolution than the panels
 * use, and the plan crop reaches further around the opening so the dimension
 * strings either side of it are in view.
 */
export function DrawingCompare({ target, onClose }: { target: CompareTarget; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [solo, setSolo] = useState<"plan" | "cad" | undefined>(
    target.focus === "cad" ? (target.cad ? "cad" : undefined) : target.focus === "plan" && target.cad ? "plan" : undefined);
  const [planImage, setPlanImage] = useState<string | null>();
  const [cadImage, setCadImage] = useState<string | null>();
  const { plan, cad } = target;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (!plan) return;
    let active = true;
    void drawSharpCrop(plan.pdf, plan.sheet, planCropAround(plan.x, plan.y, 2.2), 3200)
      .then(image => { if (active) setPlanImage(image); }, () => { if (active) setPlanImage(null); });
    return () => { active = false; };
  }, [plan]);

  useEffect(() => {
    if (!cad) return;
    let active = true;
    void drawSharpCrop(cad.pdf, cad.draft.sheet, cad.draft.crop, 3200)
      .then(image => { if (active) setCadImage(image); }, () => { if (active) setCadImage(null); });
    return () => { active = false; };
  }, [cad]);

  const draft = cad?.draft;
  const both = !!plan && !!cad;
  const size = (mm: number | null) => mm ? `${formatInchesMm(mm)} (${Math.round(mm)} mm)` : "—";

  return <dialog ref={dialog} className="ub-viewer" aria-label={target.title}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="ub-viewer-head">
      <div>
        <h2>{target.title}</h2>
        {draft && <dl className="ub-viewer-facts">
          <div><dt>CAD</dt><dd>{draft.label}{draft.kind ? ` · ${unitKindLabel(draft.kind)}` : ""}</dd></div>
          <div><dt>Width</dt><dd>{size(draft.widthMm)}</dd></div>
          <div><dt>Height</dt><dd>{size(draft.heightMm)}</dd></div>
          {draft.configuration && <div><dt>Configuration</dt><dd>{draft.configuration}</dd></div>}
          {draft.material && <div><dt>Material</dt><dd>{draft.material}</dd></div>}
          {draft.quantity != null && <div><dt>Quantity</dt><dd>{draft.quantity}</dd></div>}
        </dl>}
        <p className="ub-note">Click a drawing to zoom in on that spot. Drag to move around.</p>
      </div>
      <button type="button" data-variant="ghost" className="ub-viewer-close" aria-label="Close full screen" onClick={onClose}><X size={18} aria-hidden="true"/></button>
    </header>
    <div className="ub-viewer-body" data-panes={both && !solo ? 2 : 1}>
      {plan && solo !== "cad" && <Pane label={`Plan sheet ${plan.sheet}`} image={planImage} alt={`Plan around ${target.title}`}
        solo={both ? solo === "plan" : undefined} onSolo={both ? () => setSolo(solo === "plan" ? undefined : "plan") : undefined}/>}
      {cad && solo !== "plan" && <Pane label={`Shop CAD ${cad.draft.label} · Sheet ${cad.draft.sheet}`} image={cadImage} alt={`Shop drawing ${cad.draft.label}`}
        solo={both ? solo === "cad" : undefined} onSolo={both ? () => setSolo(solo === "cad" ? undefined : "cad") : undefined}/>}
      {plan && !cad && <p className="ub-note ub-viewer-missing">No CAD drawing is matched to this opening yet.</p>}
    </div>
  </dialog>;
}
