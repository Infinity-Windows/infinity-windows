import building3Units from "../installerPilot/building3UnitDetails.json";
import { compareCadQuantities, compareOpeningCounts, openingCountKey, overlappingOpeningIndexes, parsePreviewOpeningMarks, type ExpectedOpening } from "../../lib/install/planOpeningReview";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Download, Plus, Sparkles, X } from "lucide-react";
import { AI_POOL, reviewOpeningWithAi, runPool, type AiMatch } from "./aiCadReview";
import { DrawingCompare, type CompareTarget } from "./DrawingCompare";
import { useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { planImportUnits, type ManualImportDefinition } from "../../lib/install/unitImportFinish";
import { unitKindLabel } from "../../lib/install/unitDetails";
import { refreshUnitDetails, saveUnitDetails } from "../../lib/install/unitDetailsApi";
import { UnitBuilderFile } from "./UnitBuilderFile";
import { matchPlanOpening, type PlanDrawingLabel } from "../../lib/install/matchCadPlanOpening";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";
import { readOpeningSpans, sharesOpeningSpan } from "../../lib/install/planOpeningLinework";
import { ManualImportUnitFields, NO_CAD } from "./ManualImportUnitFields";
import { PlanMatchEvidence } from "./PlanMatchEvidence";
import { markedPlanElevation, markedPlanFloor } from "../../lib/install/markedPlanFloor";
import { splitCalloutsByFloorPlan } from "../../lib/install/planDetails";
import { extractAllText, extractPlanMarkCallouts, loadPdfTask } from "../../lib/install/pdf";

type Review = { mark: string; floor: string | null; drawing: string; manualDefinition?: ManualImportDefinition };
type ManualOpening = Review & { key: string; source?: { sheet: number; x: number; y: number } };
type Opening = { key: string; x: number; y: number; mark: string; sheet: number; floor: string | null; labels: PlanDrawingLabel[] };
type Result = { openings: Opening[]; repeats: number; source: string; pdf: PDFDocumentProxy; floorSheets: { floor: string; page: number }[]; nativeLabels: Record<number, PlanDrawingLabel[]>; building3: boolean };

const building3Counts = new Map<string, ExpectedOpening>();
for (const [id, unit] of Object.entries(building3Units)) {
  const floor = unit.location.split(" · ")[0];
  const mark = id.replace(/-\d+$/, "");
  const key = openingCountKey(mark, floor);
  const count = building3Counts.get(key)?.count ?? 0;
  building3Counts.set(key, { mark, floor, count: count + 1 });
}
const building3Reference = [...building3Counts.values()];

export type PlanStep = "plan" | "match" | "review";
export type PlanSummary = { loaded: boolean; openings: number; attention: number; added: number };

export function MarkedPlanPreview({ drafts, cadSource, cadPdf, projectId, existingCodes, cadBusy, step, onStep, onSummary, onFinished }: {
  drafts: readonly CadUnitDraft[];
  cadSource?: string;
  cadPdf?: PDFDocumentProxy;
  projectId: string;
  /** Unit numbers already on the job, so Finish never reuses one. */
  existingCodes: readonly string[];
  /** The shop CAD is still being read, by the text reader or the AI. */
  cadBusy: boolean;
  /** Which stage of the import is on screen; null while the builder shows something else. */
  step: PlanStep | "cad" | null;
  onStep: (step: PlanStep | "cad") => void;
  /** Keeps the stepper's counts in step with a review whose state lives here. */
  onSummary: (summary: PlanSummary) => void;
  onFinished: (count: number) => void;
}) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<Opening>();
  const [reviewed, setReviewed] = useState<Record<string, Review>>({});
  // Unset until the person picks: the step opens on what needs them, and on
  // everything once nothing does (Matt, 2026-11-20: "by default show only
  // needs attention").
  const [picked, setFilter] = useState<"all" | "attention">();
  const [notOnJob, setNotOnJob] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [manual, setManual] = useState<ManualOpening[]>([]);
  const [adding, setAdding] = useState<ManualOpening & { inlineFor?: string; validDimensions?: boolean }>();
  // Finish is the only place the import writes to the job. `added` remembers
  // which openings already became units so a retry after a dropped connection
  // picks up where it stopped instead of adding the first ones twice.
  const [added, setAdded] = useState<Record<string, string>>({});
  const receipts = useRef(new Map<string, { id: string; editId: string; code: string }>());
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState<{ done: number; total: number }>();
  const [finishError, setFinishError] = useState("");
  // AI answers are suggestions held beside the review, never the review
  // itself: a person still confirms each one before it counts as a match.
  const [aiAnswers, setAiAnswers] = useState<Record<string, AiMatch>>({});
  const [aiRun, setAiRun] = useState<{ working: string[]; queued: string[]; done: number; total: number }>();
  const stopAi = useRef(false);
  const [viewing, setViewing] = useState<CompareTarget>();
  const clearReview = () => {
    stopAi.current = true;
    setAiAnswers({});
    setViewing(undefined);
    setAdded({});
    receipts.current.clear();
    setConfirming(false);
    setFinishError("");
    setReviewed({});
    setExcluded([]);
    setManual([]);
    setAdding(undefined);
    setReviewing(undefined);
    setFilter(undefined);
    setNotOnJob([]);
  };

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let task: ReturnType<typeof loadPdfTask> | undefined;
    let source: string | undefined;
    void (async () => {
      try {
        const bytes = await file.arrayBuffer();
        if (cancelled) return;
        task = loadPdfTask(bytes);
        const pdf = await task.promise;
        const [pages, callouts] = await Promise.all([extractAllText(pdf), extractPlanMarkCallouts(pdf, parsePreviewOpeningMarks)]);
        if (cancelled) return;
        const { planCallouts, repeatViewCallouts } = splitCalloutsByFloorPlan(callouts, pages);
        const floors = new Map(pages.map(page => [page.pageNumber, markedPlanFloor(page.text)]));
        // Elevation sheets can mention a floor plan in their notes. The drawing
        // title takes precedence over those incidental references.
        const elevationSheets = new Set(pages.filter(page => markedPlanElevation(page.text)).map(page => page.pageNumber));
        const openings = planCallouts.filter(callout => !elevationSheets.has(callout.pageNumber));
        const spans = new Map<number, Awaited<ReturnType<typeof readOpeningSpans>>>();
        const labels = new Map<number, PlanDrawingLabel[]>();
        for (const sheet of new Set([...openings.map(callout => callout.pageNumber), ...pages.filter(page => floors.get(page.pageNumber) && !elevationSheets.has(page.pageNumber)).map(page => page.pageNumber)])) {
          const page = await pdf.getPage(sheet);
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          spans.set(sheet, await readOpeningSpans(page).catch(() => []));
          labels.set(sheet, content.items.flatMap(item => {
            if (!("str" in item)) return [];
            const [x, y] = viewport.convertToViewportPoint(item.transform[4] + item.width / 2, item.transform[5]);
            return [{ text: item.str, x: x / viewport.width, y: y / viewport.height }];
          }));
        }
        if (cancelled) return;
        source = URL.createObjectURL(file);
        setResult({
          openings: openings.map((callout, index) => ({
            key: `plan-${index}`, x: callout.x, y: callout.y, mark: callout.mark, sheet: callout.pageNumber, floor: floors.get(callout.pageNumber) ?? null,
            labels: (labels.get(callout.pageNumber) ?? [])
              .filter(label => Math.hypot(label.x - callout.x, label.y - callout.y) <= .035)
              .map(label => ({
              ...label, x: label.x - callout.x, y: label.y - callout.y,
              linework: sharesOpeningSpan(callout, label, spans.get(callout.pageNumber) ?? []),
              })),
          })),
          repeats: repeatViewCallouts.length + planCallouts.length - openings.length,
          source, pdf, nativeLabels: Object.fromEntries(labels),
          floorSheets: pages.flatMap(page => {
            const floor = floors.get(page.pageNumber);
            return floor ? [{ floor, page: page.pageNumber }] : [];
          }),
          building3: pages.some(page => /\bBUILDING\s+3\s+LEVEL\s+1\s+FLOOR\s+PLAN\b/i.test(page.text)) &&
            pages.some(page => /\bBUILDING\s+3\s+LEVEL\s+2\s+FLOOR\s+PLAN\b/i.test(page.text)),
        });
      } catch {
        if (!cancelled) setError("Forge couldn’t read this marked plan PDF.");
      }
    })();
    return () => {
      cancelled = true;
      if (source) URL.revokeObjectURL(source);
      void task?.destroy();
    };
  }, [file]);

  const openings = (result?.openings ?? []).filter(opening => !excluded.includes(opening.key));
  const countMatches = result?.building3 ? drafts.flatMap(draft => {
    if (!draft.itemNumber || !draft.quantity || drafts.filter(option => option.itemNumber === draft.itemNumber).length !== 1) return [];
    const rows = openings.filter(row => row.mark.trim().replace(/^#/, "") === draft.itemNumber);
    const hasVariant = drafts.some(option => option.label.toUpperCase().startsWith(draft.label.toUpperCase() + "-"));
    return hasVariant && rows.length === draft.quantity ? [{ draft, rows }] : [];
  }) : [];
  const countMatchByKey = new Map(countMatches.flatMap(({ draft, rows }) => rows.map(row => [row.key, draft] as const)));
  const overlaps = overlappingOpeningIndexes(openings);
  const preview = openings.map((opening, index) => {
    const review = reviewed[opening.key];
    const match = matchPlanOpening({ x: 0, y: 0 }, opening.labels, drafts, opening.mark, result?.building3);
    const drawing = review ? drafts.find(draft => draft.key === review.drawing) : match?.draft ?? countMatchByKey.get(opening.key);
    return { opening, key: opening.key, review, match, drawing, mark: review?.mark ?? opening.mark,
      floor: review ? review.floor : opening.floor, overlap: overlaps.has(index) && !review };
  });
  const manualRows = manual.map(row => ({
    ...row, drawingLabel: drafts.find(draft => draft.key === row.drawing)?.label,
    sheet: row.source?.sheet ?? result?.floorSheets.find(sheet => sheet.floor === row.floor)?.page,
  }));
  const reference = result?.building3 ? building3Reference : [];
  const discrepancies = compareOpeningCounts(
    [...preview.map(row => ({ ...row.opening, mark: row.mark, floor: row.floor })),
      ...manual.map(row => ({ ...row, sheet: 0, x: 0, y: 0 }))], reference,
  );
  const missingCandidates = (mark: string, floor: string): Opening[] =>
    result?.floorSheets.filter(sheet => sheet.floor === floor).flatMap(({ page }) =>
      (result.nativeLabels[page] ?? []).filter(label => label.text.trim().toUpperCase() === mark.toUpperCase())
        .map((label, index) => ({
          key: `candidate:${page}:${mark}:${index}`, mark, floor, sheet: page, x: label.x, y: label.y, labels: [],
        })).filter(candidate => !manual.some(row => row.source?.sheet === candidate.sheet &&
          Math.hypot(row.source.x - candidate.x, row.source.y - candidate.y) < .0025))) ?? [];
  // An opening the count expects and the plan read did not find needs a person
  // as much as one it found and could not match, so it is counted with them
  // until it is kept, added, or marked as not on this job.
  const missing = discrepancies.filter(row => row.found < row.count && !notOnJob.includes(openingCountKey(row.mark, row.floor)));
  const shortage = missing.reduce((total, row) => total + row.count - row.found, 0);
  // Every job: what each shop drawing says its quantity is, against the
  // openings matched to it. This replaced a check that only knew Building 3's
  // item numbers (Matt, 2026-11-20: work from CAD quantities on every job).
  const quantityCheck = compareCadQuantities(
    [...preview.map(row => row.drawing?.key), ...manual.map(row => row.drawing || undefined)], drafts);
  const quantitiesByKey = new Map(quantityCheck.map(({ draft, expected, found }) => [draft.key, { expected, found }]));
  const quantitiesFor = (opening: Opening) => {
    const current = preview.find(row => row.key === opening.key)?.drawing?.key;
    return Object.fromEntries([...quantitiesByKey].map(([key, quantity]) => [key, {
      ...quantity, found: quantity.found - Number(key === current),
    }]));
  };
  const quantityOff = quantityCheck.filter(row => row.found !== row.expected);
  const attention = (row: typeof preview[number]) => row.overlap || !row.floor || (!row.review?.manualDefinition && !row.drawing?.kind);
  const manualNeedsAttention = (row: typeof manualRows[number]) =>
    !row.floor || (!row.manualDefinition && !drafts.find(draft => draft.key === row.drawing)?.kind);
  const openingAttention = preview.filter(attention).length + missing.length + manualRows.filter(manualNeedsAttention).length;
  const needsAttention = openingAttention;
  const filter = picked ?? (openingAttention ? "attention" : "all");
  const floorTotals = new Map<string, number>();
  for (const row of [...preview, ...manualRows]) {
    const floor = row.floor ?? "Floor unclear";
    floorTotals.set(floor, (floorTotals.get(floor) ?? 0) + 1);
  }
  const startManual = (mark = "", floor: string | null = null, inlineFor?: string) => {
    setReviewing(undefined);
    setAdding({ key: crypto.randomUUID(), mark, floor, drawing: "", inlineFor });
  };
  const downloadReview = () => {
    const payload = {
      source: file?.name, openingCallouts: result?.openings.length ?? 0,
      elevationRepeats: result?.repeats ?? 0, reference: reference.length ? "Reviewed Building 3 reference" : undefined,
      discrepancies, quantityDifferences: quantityOff.map(row => ({ drawing: row.draft.label, expected: row.expected, matched: row.found })), ignoredCallouts: (result?.openings ?? []).filter(row => excluded.includes(row.key)).map(({ labels: _, ...row }) => row),
      openings: preview.map(row => ({
        mark: row.mark, floor: row.floor, sheet: row.opening.sheet, x: row.opening.x, y: row.opening.y,
        drawing: row.drawing?.label ?? null, manualDefinition: row.review?.manualDefinition, reviewed: !!row.review, possibleDuplicate: row.overlap,
      })),
      addedByReviewer: manualRows,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "forge-opening-review.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const visible = preview.filter(row => filter === "all" || attention(row));
  const visibleManual = manualRows.filter(row => filter === "all" || manualNeedsAttention(row));
  const matchFloors = new Set([...visible, ...visibleManual, ...missing].map(row => row.floor ?? "Floor unclear"));
  const sortedMatchFloors = [...matchFloors].sort((a, b) => Number(a === "Floor unclear") - Number(b === "Floor unclear") || a.localeCompare(b, undefined, { numeric: true }));

  // The family drawing a lettered mark belongs to ("1-A" belongs with item 1),
  // and how many plain marks of that family the plan has.
  const familyOf = (opening: Opening) => ({
    relatedDraft: /^(\d+)-[A-Z]$/i.test(opening.mark)
      ? drafts.find(draft => draft.itemNumber === opening.mark.split("-")[0]) : undefined,
    familyCount: openings.filter(row => row.mark === opening.mark.split("-")[0]).length,
  });
  const fullScreen = (opening: Opening, draft: CadUnitDraft | undefined, focus: "plan" | "cad") => result && setViewing({
    focus, title: `Mark ${opening.mark}${opening.floor ? ` · ${opening.floor}` : ""}`,
    plan: { pdf: result.pdf, sheet: opening.sheet, x: opening.x, y: opening.y },
    cad: cadPdf && draft ? { pdf: cadPdf, draft } : undefined,
  });
  const unclearForAi = preview.filter(row => !row.review && !row.drawing && !aiAnswers[row.key]);
  const askAiForUnclear = async () => {
    if (!result || aiRun || !unclearForAi.length) return;
    const rows = unclearForAi;
    stopAi.current = false;
    setAiRun({ working: [], queued: rows.map(row => row.key), done: 0, total: rows.length });
    await runPool(rows, AI_POOL, async row => {
      setAiRun(now => now && { ...now, working: [...now.working, row.key], queued: now.queued.filter(key => key !== row.key) });
      const answer = await reviewOpeningWithAi({ projectId, opening: row.opening, plan: result.pdf, cad: cadPdf, drafts, quantities: quantitiesFor(row.opening), ...familyOf(row.opening) });
      setAiAnswers(old => ({ ...old, [row.key]: answer }));
      setAiRun(now => now && { ...now, working: now.working.filter(key => key !== row.key), done: now.done + 1 });
    }, () => stopAi.current);
    setAiRun(undefined);
  };
  // The second automatic AI pass: once the floor plan is read, every opening
  // the matcher left without a drawing is compared by the AI, with the plan's
  // counts and the CAD quantities beside it. It waits for the shop CAD to
  // finish, because the definitions (and their item numbers) are what the
  // matcher works from. Once per plan; the button remains for a second look.
  const autoAsked = useRef<Result>(undefined);
  useEffect(() => {
    if (!result || cadBusy || !drafts.length || autoAsked.current === result) return;
    autoAsked.current = result;
    void askAiForUnclear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, cadBusy, drafts.length]);

  const evidence = step === "match" && result && reviewing && <PlanMatchEvidence key={reviewing.key}
        opening={reviewing} plan={result.pdf} cad={cadPdf} drafts={drafts} projectId={projectId}
        // The same drawing the row shows as "Suggested", count matches
        // included, so the evidence opens on it instead of on nothing.
        suggested={matchPlanOpening({ x: 0, y: 0 }, reviewing.labels, drafts, reviewing.mark, result.building3)?.draft ?? countMatchByKey.get(reviewing.key)}
        reviewed={reviewed[reviewing.key]}
        ai={aiAnswers[reviewing.key]} onAi={answer => setAiAnswers(old => ({ ...old, [reviewing.key]: answer }))}
        onFullScreen={(draft, focus) => fullScreen(reviewing, draft, focus)}
        quantities={quantitiesFor(reviewing)}
        {...familyOf(reviewing)}
        onReviewed={value => {
          if (reviewing.key.startsWith("candidate:")) {
            setManual(old => [...old, { ...value, key: reviewing.key, source: {
              sheet: reviewing.sheet, x: reviewing.x, y: reviewing.y,
            } }]);
          } else setReviewed(old => ({ ...old, [reviewing.key]: value }));
        }}
        onClose={() => setReviewing(undefined)} />;

  const total = preview.length + manual.length;
  const matched = preview.filter(row => row.drawing).length + manualRows.filter(row => row.drawingLabel).length;
  const loaded = !!result;
  const addedCount = Object.keys(added).length;
  useEffect(() => {
    onSummary({ loaded, openings: total, attention: needsAttention, added: addedCount });
  }, [loaded, total, needsAttention, addedCount, onSummary]);
  const toFinish = planImportUnits([
    ...preview.map(row => ({ key: row.key, mark: row.mark, floor: row.floor, sheet: row.opening.sheet, draft: row.drawing, manualDefinition: row.review?.manualDefinition })),
    ...manualRows.map(row => ({ key: row.key, mark: row.mark, floor: row.floor, sheet: row.sheet, draft: drafts.find(draft => draft.key === row.drawing), manualDefinition: row.manualDefinition })),
  ].filter(row => !added[row.key]), [...existingCodes, ...Object.values(added)]);
  const possibleDuplicates = preview.filter(row => row.overlap && !added[row.key]).length;
  const finish = async () => {
    if (finishing || needsAttention) return;
    // The numbers are fixed here, before the first write, so the list the
    // person confirmed is the list that gets added even as the job's own unit
    // list refreshes underneath.
    const units = toFinish.units;
    setConfirming(false);
    setFinishError("");
    setFinishing({ done: 0, total: units.length });
    let done = 0;
    try {
      for (const unit of units) {
        const receipt = receipts.current.get(unit.key) ?? { id: crypto.randomUUID(), editId: crypto.randomUUID(), code: unit.code };
        receipts.current.set(unit.key, receipt);
        const write = { id: receipt.id, editId: receipt.editId, projectId, create: true, code: receipt.code,
          details: unit.details, previousCode: null, previousDetails: {}, reason: unit.reason };
        const applied = await saveUnitDetails(write);
        setAdded(old => ({ ...old, [unit.key]: receipt.code }));
        setFinishing({ done: ++done, total: units.length });
        await refreshUnitDetails(client, write, applied).catch(() => { void client.invalidateQueries({ queryKey: ["openings", projectId] }); });
      }
      onFinished(done);
    } catch (error) {
      // A refusal means this number will never save; drop the receipt so the
      // next try numbers the unit afresh. A dropped connection keeps it, so
      // the retry is recognised as the same unit.
      if ((error as { code?: string })?.code && units[done]) receipts.current.delete(units[done].key);
      setFinishError(`${done ? `Added ${done} of ${units.length}. ` : ""}${formatApiError(error)}`);
    } finally {
      setFinishing(undefined);
    }
  };
  const sortedFloors = [...floorTotals].sort(([a], [b]) => Number(a === "Floor unclear") - Number(b === "Floor unclear") ||
    a.localeCompare(b, undefined, { numeric: true }));
  const nextUnclear = preview.find(row => attention(row) && row.key !== reviewing?.key);
  const openEvidence = (opening: Opening) => {
    // The evidence opens under its row, so the row has to be in the list.
    const row = preview.find(item => item.key === opening.key);
    if (row && filter === "attention" && !attention(row)) setFilter("all");
    setAdding(undefined);
    setReviewing(opening);
  };
  // Wherever it was opened from, bring the evidence into view: its row may be
  // well down a long floor, or the button may be in the count check above.
  const reviewingKey = step === "match" ? reviewing?.key : undefined;
  useEffect(() => {
    if (!reviewingKey) return;
    const frame = requestAnimationFrame(() => (document.querySelector(".cad-plan-review-item[data-open=true]") ?? document.querySelector(".cad-plan-evidence"))
      ?.scrollIntoView({ block: "start", behavior: "smooth" }));
    return () => cancelAnimationFrame(frame);
  }, [reviewingKey]);
  const needPlan = <div className="ub-empty">
    <h2>Add the floor plan first</h2>
    <p>Openings come from the marked floor plan. Once it is read, they appear here to match and verify.</p>
    <div className="ub-actions">
      <button type="button" data-variant="primary" onClick={() => onStep("plan")}>Go to floor plan</button>
    </div>
  </div>;

  const addingWithoutCad = adding?.drawing === NO_CAD;
  const addingHasDefinition = addingWithoutCad
    ? !!adding?.manualDefinition?.kind && adding.validDimensions !== false
    : !!drafts.find(draft => draft.key === adding?.drawing)?.kind;
  const manualForm = adding && <form className="cad-plan-evidence ub-inline-form" onSubmit={event => {
    event.preventDefault();
    const mark = adding.mark.trim();
    const floor = adding.floor?.trim();
    if (!mark || !floor || !addingHasDefinition) return;
    const { inlineFor: _, validDimensions: __, ...opening } = adding;
    setManual(old => [...old.filter(row => row.key !== adding.key), { ...opening, mark, floor, drawing: opening.drawing === NO_CAD ? "" : opening.drawing }]);
    setAdding(undefined);
  }}>
    <h3>Define opening</h3>
    <label>Opening mark <input required autoFocus value={adding.mark} onChange={event => setAdding({ ...adding, mark: event.target.value })}/></label>
    <label>Floor <input required value={adding.floor ?? ""} onChange={event => setAdding({ ...adding, floor: event.target.value })}/></label>
    <label>CAD drawing <select value={adding.drawing}
      onChange={event => setAdding({ ...adding, drawing: event.target.value, manualDefinition: undefined, validDimensions: true })}>
      <option value="">Choose a drawing</option><option value={NO_CAD}>No CAD</option>
      {drafts.map(draft => <option key={draft.key} value={draft.key}>{draft.label}</option>)}
    </select></label>
    {addingWithoutCad && adding.manualDefinition && <ManualImportUnitFields value={adding.manualDefinition}
      onChange={manualDefinition => setAdding(current => current && { ...current, manualDefinition })}
      onValidChange={validDimensions => setAdding(current => current && { ...current, validDimensions })}/>}
    <div className="ub-actions">
      <button type="button" data-variant="ghost" onClick={() => setAdding(undefined)}>Cancel</button>
      {addingWithoutCad && !adding.manualDefinition
        ? <button type="button" data-variant="primary" onClick={() => setAdding({ ...adding, manualDefinition: {} })}>Define Unit</button>
        : <button type="submit" data-variant="primary" disabled={!adding.mark.trim() || !adding.floor?.trim() || !addingHasDefinition}>
          {addingWithoutCad ? "Add to units" : "Link opening"}
        </button>}
    </div>
  </form>;

  return <>
    {viewing && <DrawingCompare target={viewing} onClose={() => setViewing(undefined)}/>}
    <div className="ub-step-body" hidden={step !== "plan"}>
      <div className="ub-step-title">
        <h2>Floor plan</h2>
        <p>The marked plan says where each unit goes: one opening for every mark, floor by floor.</p>
      </div>
      <UnitBuilderFile label="Marked floor plan PDF" hint="Drop the marked floor plan here, or choose it." file={file} inputRef={input}
        status={error ? "Could not be read" : !result ? "Reading plan callouts and floor titles…"
          : `${result.pdf.numPages} sheets · ${result.openings.length} opening callouts`}
        onPick={next => {
          setResult(undefined);
          clearReview();
          setError("");
          setFile(next);
        }}
        onRemove={() => {
          if (input.current) input.current.value = "";
          setFile(null);
          setResult(undefined);
          clearReview();
          setError("");
        }}/>
      {error && <p role="alert" className="ub-alert">{error}</p>}
      {result && <>
        <dl className="ub-tiles" role="status">
          <div><dt>Draft openings</dt><dd>{total}</dd>{manual.length > 0 && <small>{manual.length} added in review</small>}</div>
          <div><dt>With a floor</dt><dd>{preview.filter(row => row.floor).length}</dd></div>
          {drafts.length > 0 && <div><dt>With a CAD match</dt><dd>{preview.filter(row => row.drawing).length}</dd></div>}
          <div data-tone={needsAttention ? "warn" : "ok"}><dt>Need attention</dt><dd>{needsAttention}</dd></div>
        </dl>
        {sortedFloors.length > 0 && <ul className="cad-review-floor-totals">
          {sortedFloors.map(([floor, count]) => <li key={floor}><span>{floor}</span><strong>{count}</strong></li>)}
        </ul>}
        {result.openings.length === 0 && <p className="ub-alert" data-tone="warn">No marked openings found in this PDF.</p>}
        {result.repeats > 0 && <p className="ub-note">{result.repeats} elevation callouts excluded from the opening count.</p>}
      </>}
      <footer className="ub-step-foot">
        <button type="button" data-variant="ghost" onClick={() => onStep("cad")}><ArrowLeft size={16} aria-hidden="true"/>Shop CAD</button>
        <button type="button" data-variant={result ? "primary" : undefined} disabled={!result} onClick={() => onStep("match")}>
          Continue to match<ArrowRight size={16} aria-hidden="true"/>
        </button>
      </footer>
    </div>

    <div className="ub-step-body" hidden={step !== "match"}>
      <div className="ub-step-title">
        <h2>Match</h2>
        <p>Link each opening to its CAD definition. Clear matches are suggested for you; the unclear ones need a look at the evidence.</p>
      </div>
      {!result ? needPlan : <>
        {aiRun ? <div className="ub-ai-run">
          <div><p role="status" className="ub-progress">AI is comparing unclear openings… {aiRun.done} of {aiRun.total}</p>
            <button type="button" data-variant="ghost" onClick={() => { stopAi.current = true; setAiRun(now => now && { ...now, queued: [] }); }}>Stop</button></div>
          <div className="ub-bar" aria-hidden="true"><span style={{ width: `${Math.max(4, aiRun.done / aiRun.total * 100)}%` }}/></div>
        </div> : unclearForAi.length > 0 && drafts.length > 0 && <div className="ub-suggest">
          <div><strong>{unclearForAi.length === 1 ? "1 opening has" : `${unclearForAi.length} openings have`} no clear CAD match</strong>
            <small>AI can compare each with the drawings and suggest one. You confirm every suggestion.{import.meta.env.DEV && " In development this runs through Codex on this computer."}</small></div>
          <button type="button" onClick={() => void askAiForUnclear()}><Sparkles size={16} aria-hidden="true"/>Ask AI about {unclearForAi.length === 1 ? "it" : `all ${unclearForAi.length}`}</button>
        </div>}

        <dl className="ub-viewer-facts">
          <div><dt>Matched Opening:</dt><dd>{matched} / {total}</dd></div>
          {reference.length > 0 && <div data-tone={shortage ? "warn" : undefined}>
            <dt>Openings not found:</dt><dd>{shortage}</dd>
          </div>}
          {quantityCheck.length > 0 && <div data-tone={quantityOff.length ? "warn" : undefined}
            title={quantityOff.length ? quantityOff.map(({ draft, found, expected }) =>
              `${draft.label}: ${found} matched / ${expected} expected`).join("\n") : undefined}>
            <dt>CAD Quantities:</dt><dd>{quantityCheck.length - quantityOff.length} / {quantityCheck.length}</dd>
          </div>}
        </dl>

        <div className="ub-toolbar ub-match-tools">
          <div className="ub-seg" role="group" aria-label="Openings shown">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All openings<span className="ub-count">{total + missing.length}</span></button>
            <button type="button" aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>
              Needs attention<span className="ub-count" data-tone={openingAttention ? "warn" : "ok"}>{openingAttention}</span></button>
          </div>
          {nextUnclear && <button type="button" onClick={() => openEvidence(nextUnclear.opening)}>Review next unclear</button>}
        </div>

        {filter === "attention" && !matchFloors.size && <p className="ub-note">No openings match this view.</p>}
        {sortedMatchFloors.map(floor => {
          const rows = visible.filter(row => (row.floor ?? "Floor unclear") === floor);
          const addedRows = visibleManual.filter(row => (row.floor ?? "Floor unclear") === floor);
          const missingRows = missing.filter(row => row.floor === floor);
          const attentionCount = rows.filter(attention).length + addedRows.filter(manualNeedsAttention).length + missingRows.length;
          return <section key={floor} aria-label={floor} className="cad-builder-floor">
            <h3>{floor} <span>{rows.length + addedRows.length + missingRows.length} openings · {attentionCount} need attention</span></h3>
            <div className="cad-plan-review-list">{rows.map(row => {
              const tone = row.overlap ? "warn" : row.review ? "ok" : row.drawing ? undefined : drafts.length ? "warn" : undefined;
              const aiKey = aiAnswers[row.key]?.key;
              const quantity = aiKey ? quantitiesByKey.get(aiKey) : undefined;
              const aiDraft = !row.drawing && (!quantity || quantity.found < quantity.expected)
                ? drafts.find(draft => draft.key === aiKey) : undefined;
              return <div key={row.key} className="cad-plan-review-item" data-open={reviewing?.key === row.key}>
                <article className="cad-plan-mark" aria-label={`Plan mark ${row.mark}`}>
                  <button type="button" className="cad-plan-open" aria-label={`Review evidence for ${row.mark}`}
                    aria-expanded={reviewing?.key === row.key}
                    data-ai={aiRun?.working.includes(row.key) ? "working" : aiRun?.queued.includes(row.key) ? "queued" : undefined}
                    onClick={() => reviewing?.key === row.key ? setReviewing(undefined) : openEvidence(row.opening)}>
                    <strong>{row.mark}</strong>
                    {/* Plain text, as the Finish list reads; only an opening
                        that needs attention keeps the pill (Matt, 2026-11-22). */}
                    <span className={tone === "warn" ? "ub-count" : "cad-plan-state"} data-tone={tone}
                      title={row.match?.itemNumber ? `CAD item ${row.match.itemNumber}` : row.match?.linework && !row.review ? "Linework supported" : undefined}>
                      {row.review?.manualDefinition?.kind ? `${unitKindLabel(row.review.manualDefinition.kind)} · Defined by hand` : row.drawing ? `${row.review ? "Confirmed" : "Suggested"} · ${row.drawing.label}`
                        : aiDraft ? `AI suggests · ${aiDraft.label}` : aiAnswers[row.key] ? "AI found no match" : drafts.length ? "CAD match unclear" : "Plan opening"}</span>
                    {row.match?.itemNumber && !row.review && <small>Item {row.match.itemNumber}</small>}
                    {row.overlap && <small className="cad-plan-duplicate">Possible duplicate</small>}
                  </button>
                  <div className="cad-plan-meta">
                    <a href={`${result.source}#page=${row.opening.sheet}`} target="_blank" rel="noreferrer">Plan {row.opening.sheet}</a>
                    {row.drawing && cadSource && <a href={`${cadSource}#page=${row.drawing.sheet}`} target="_blank" rel="noreferrer">
                      CAD {row.drawing.sheet}</a>}
                    <button type="button" data-variant="ghost" aria-label={`Exclude callout ${row.mark}`} title="Exclude callout" onClick={() => {
                      if (reviewing?.key === row.key) setReviewing(undefined);
                      setExcluded(old => [...old, row.key]);
                    }}><X size={16} aria-hidden="true"/></button>
                  </div>
                </article>
                {reviewing?.key === row.key && evidence}
              </div>;
            })}
              {addedRows.map(row => <div key={row.key} className="cad-plan-review-item">
                <article className="cad-plan-mark cad-plan-exception" aria-label={`Added opening ${row.mark}`}>
                  <span className="cad-plan-exception-label"><strong>{row.mark}</strong>
                    <span title={row.drawingLabel}>{row.manualDefinition?.kind ? `${unitKindLabel(row.manualDefinition.kind)} · Defined by hand` : row.drawingLabel ?? "CAD drawing unspecified"}</span>
                  </span>
                  <div className="cad-plan-exception-actions">
                    {row.sheet && <a href={`${result.source}#page=${row.sheet}`} target="_blank" rel="noreferrer">Plan {row.sheet}</a>}
                    <button type="button" aria-label={`Edit ${row.mark}`} onClick={() => { setReviewing(undefined); setAdding({ ...row, drawing: row.manualDefinition ? NO_CAD : row.drawing, inlineFor: row.key }); }}>Edit</button>
                    <button type="button" data-variant="ghost" aria-label={`Remove ${row.mark} from preview`}
                      onClick={() => {
                      if (adding?.inlineFor === row.key) setAdding(undefined);
                      setManual(old => old.filter(item => item.key !== row.key));
                    }}><X size={16} aria-hidden="true"/></button>
                  </div>
                </article>
                {adding?.inlineFor === row.key && manualForm}
              </div>)}
              {missingRows.map(row => {
                const key = openingCountKey(row.mark, row.floor);
                const candidates = missingCandidates(row.mark, row.floor);
                const showing = candidates.some(candidate => candidate.key === reviewing?.key);
                return <div key={key} className="cad-plan-review-item" data-open={showing}>
                  <article className="cad-plan-mark cad-plan-exception" aria-label={`Missing opening ${row.mark}`}>
                    <span className="cad-plan-exception-label"><strong>{row.mark}</strong>
                      <span className="ub-count" data-tone="warn">{row.count - row.found} not found</span>
                    </span>
                    <div className="cad-plan-exception-actions">
                      {candidates.length > 0 && <select aria-label={`Plan crops for ${row.mark}`}
                        value={showing ? reviewing?.key : ""} onChange={event => {
                          setAdding(undefined);
                          setReviewing(candidates.find(candidate => candidate.key === event.target.value));
                        }}>
                        <option value="">Views</option>
                        {candidates.map((candidate, index) => <option key={candidate.key} value={candidate.key}>
                          Crop {index + 1} · Sheet {candidate.sheet}
                        </option>)}
                      </select>}
                      <button type="button" aria-label={`Add ${row.mark}`} onClick={() => startManual(row.mark, row.floor, key)}>Add</button>
                      <button type="button" data-variant="ghost" aria-label={`Mark ${row.mark} not on this job`}
                        title="Not on this job" onClick={() => {
                          if (showing) setReviewing(undefined);
                          if (adding?.inlineFor === key) setAdding(undefined);
                          setNotOnJob(old => [...old, key]);
                        }}><X size={16} aria-hidden="true"/></button>
                    </div>
                  </article>
                  {showing && evidence}
                  {adding?.inlineFor === key && manualForm}
                </div>;
              })}
            </div>
          </section>;
        })}

        <div className="ub-actions">
          <button type="button" data-variant="ghost" onClick={() => startManual()}>
            <Plus size={16} aria-hidden="true"/>Add missed openings
          </button>
        </div>

        {adding && !adding.inlineFor && manualForm}

        {discrepancies.some(row => row.found > row.count) && <section className="ub-panel" aria-label="Extra openings">
          <h3>Extra openings</h3>
          <ul className="ub-rows">{discrepancies.filter(row => row.found > row.count).map(row => {
            const key = openingCountKey(row.mark, row.floor);
            return <li key={key}>
              <span className="ub-row-main">{row.floor} · {row.mark} · {row.found} / {row.count}</span>
              <button type="button" onClick={() => {
                const first = preview.find(item => openingCountKey(item.mark, item.floor) === key);
                if (first) openEvidence(first.opening);
              }}>Review</button>
            </li>;
          })}</ul>
        </section>}

        {excluded.length > 0 && <details className="ub-disclosure"><summary>Excluded callouts ({excluded.length})</summary><ul className="ub-rows">
          {result.openings.filter(row => excluded.includes(row.key)).map(row => <li key={row.key}>
            <span className="ub-row-main"><strong>{row.mark}</strong><small>Plan sheet {row.sheet}</small></span>
            <button type="button" data-variant="ghost" onClick={() => setExcluded(old => old.filter(key => key !== row.key))}>Restore {row.mark}</button>
          </li>)}
        </ul></details>}
      </>}
      <footer className="ub-step-foot">
        <button type="button" data-variant="ghost" onClick={() => onStep("plan")}><ArrowLeft size={16} aria-hidden="true"/>Floor plan</button>
        <button type="button" data-variant={result ? "primary" : undefined} disabled={!result || needsAttention > 0} onClick={() => onStep("review")}>
          Continue to finish<ArrowRight size={16} aria-hidden="true"/>
        </button>
      </footer>
    </div>

    <div className="ub-step-body" hidden={step !== "review"}>
      <div className="ub-step-title">
        <h2>Finish</h2>
        <p>Check the totals against what you expect on the job. Finishing is what adds these units to the job; nothing has been added before this.</p>
      </div>
      {!result ? needPlan : <>
        <dl className="ub-tiles">
          <div><dt>Draft openings</dt><dd>{total}</dd></div>
          <div data-tone={needsAttention ? "warn" : "ok"}><dt>Need attention</dt><dd>{needsAttention}</dd></div>
          {reference.length > 0 && <div data-tone={shortage ? "warn" : "ok"}><dt>Not found</dt><dd>{shortage}</dd></div>}
          {quantityCheck.length > 0 && <div data-tone={quantityOff.length ? "warn" : "ok"}><dt>Quantities that differ</dt><dd>{quantityOff.length}</dd></div>}
          <div><dt>CAD definitions</dt><dd>{drafts.length}</dd></div>
        </dl>
        {needsAttention > 0 && <p className="ub-alert" data-tone="warn"><span>{needsAttention === 1 ? "1 opening still needs attention." : `${needsAttention} openings still need attention.`}</span>
          <button type="button" onClick={() => { setFilter(openingAttention ? "attention" : "all"); onStep("match"); }}>Review them</button></p>}
        <ul className="cad-review-floor-totals">
          {sortedFloors.map(([floor, count]) => <li key={floor}><span>{floor}</span><strong>{count}</strong></li>)}
        </ul>
        {possibleDuplicates > 0 && <p className="ub-alert" data-tone="warn">{possibleDuplicates} openings may be the same callout read twice. Each one becomes its own unit unless you exclude it in Match.</p>}
        {toFinish.leftOut.length > 0 && <details className="ub-disclosure" open>
          <summary>{toFinish.leftOut.length === 1 ? "1 opening will be left out" : `${toFinish.leftOut.length} openings will be left out`}</summary>
          <p>A unit needs a type. These have no CAD match, or match a definition whose type is still unclear. Match them, set the type in Shop CAD, or define them by hand afterwards.</p>
          <div className="ub-actions">
            {toFinish.leftOut.some(row => row.why === "no-definition") && <button type="button" onClick={() => { setFilter("attention"); onStep("match"); }}>Match them</button>}
            {toFinish.leftOut.some(row => row.why === "type-unclear") && <button type="button" onClick={() => onStep("cad")}>Set types in Shop CAD</button>}
          </div>
          <ul className="ub-rows">{toFinish.leftOut.map(row => <li key={row.key}>
            <span className="ub-row-main"><strong>{row.mark}</strong>
              <small>{row.floor ?? "Floor unclear"} · {row.why === "no-definition" ? "No CAD match" : "Matched, but its type is unclear"}</small></span>
          </li>)}</ul>
        </details>}
        {toFinish.units.length > 0 && <details className="ub-disclosure" open>
          <summary>{toFinish.units.length} units to add, with their numbers</summary>
          <ul className="ub-rows">{toFinish.units.map(unit => <li key={unit.key}>
            <span className="ub-row-main"><strong>{unit.code}</strong>
              <small>{unit.floor ?? "Floor unclear"} · {unit.details.kind ? unitKindLabel(unit.details.kind) : ""}{unit.details.configuration ? ` · ${unit.details.configuration}` : ""}</small></span>
          </li>)}</ul>
        </details>}
        {addedCount > 0 && <p role="status" className="ub-alert" data-tone="ok"><Check size={16} aria-hidden="true"/>
          <span>{addedCount} units from this import are on the job.</span></p>}
        {finishError && <p role="alert" className="ub-alert">{finishError}</p>}
        <div className="ub-handoff">
          {finishing ? <p role="status" className="ub-progress">Adding units to the job… {finishing.done} of {finishing.total}</p>
            : confirming ? <>
              <div><strong>Add {toFinish.units.length} units to this job?</strong>
                <small>The crew will see them in Plan and Workday. A unit can be edited or removed afterwards, one at a time.</small></div>
              <div className="ub-actions">
                <button type="button" data-variant="ghost" onClick={() => setConfirming(false)}>Not yet</button>
                <button type="button" data-variant="primary" disabled={needsAttention > 0} onClick={() => void finish()}>Add {toFinish.units.length} units</button>
              </div>
            </> : <>
              <div><strong>{toFinish.units.length ? `Finish: add ${toFinish.units.length} units to the job` : addedCount ? "This import is finished" : "Nothing to add yet"}</strong>
                <small>{toFinish.units.length ? "Units are numbered by plan mark, such as 6-1 and 6-2."
                  : addedCount ? "Every opening that could be defined is on the job." : "Match openings to CAD definitions first."}</small></div>
              <div className="ub-actions">
                <button type="button" data-variant="ghost" onClick={downloadReview}><Download size={16} aria-hidden="true"/>Download review</button>
                <button type="button" data-variant="primary" disabled={needsAttention > 0 || !toFinish.units.length} onClick={() => setConfirming(true)}>
                  {finishError ? "Try again" : "Finish"}</button>
              </div>
            </>}
        </div>
      </>}
      <footer className="ub-step-foot">
        <button type="button" data-variant="ghost" onClick={() => onStep("match")}><ArrowLeft size={16} aria-hidden="true"/>Back to match</button>
        <span/>
      </footer>
    </div>
  </>;
}
