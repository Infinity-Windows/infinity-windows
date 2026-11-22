import { FloorIndex } from "../../components/install/FloorIndex";
import "../installerPilot/jobPlanner.css";
import { UnitTile } from "../../components/install/UnitTile";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Copy, Maximize2, Pencil, Plus, RotateCcw, Search, Sparkles, SquareDashed, TriangleAlert } from "lucide-react";
import { AI_POOL, aiCrop, askCadAi, runPool } from "./aiCadReview";
import { DrawingCompare, type CompareTarget } from "./DrawingCompare";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { listMarkSpecs, listOpenings } from "../../lib/install/api";
import { refreshUnitDetails, saveUnitDetails } from "../../lib/install/unitDetailsApi";
import { DimensionFields } from "../../components/install/DimensionFields";
import { formatInchesMm, MM_PER_INCH } from "../../lib/install/dimensionEntry";
import { PickOrAdd } from "../../components/install/PickOrAdd";
import { matchOption, optionsWith, UNIT_MATERIALS, unitConfigurations } from "../../lib/install/unitVocabulary";
import { formatApiError } from "../../lib/errors";
import type { ProjectOpening } from "../../lib/install/types";
import { UNIT_KINDS, unitFloor, unitKindLabel, unitSourceMark, type UnitDetailsWrite } from "../../lib/install/unitDetails";
import { indexSpecsByMark } from "../../lib/install/specs";
import { unitDefinitionDiagram } from "../../lib/install/unitDefinitionDiagram";
import { catalogByMarkFrom, resolveMarkConfig } from "../../lib/modelstudio/fromProject";
import { listStudioUnits, unitSvg } from "../../lib/modelstudio/units";
import { MarkedPlanPreview, type PlanSummary } from "./MarkedPlanPreview";
import { UnitBuilderFile } from "./UnitBuilderFile";
import { JobUnitBuilderForm } from "./JobUnitBuilderForm";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { building3CadDrafts, type CadUnitDraft } from "../../lib/install/cadUnitPreview";
import { loadPdfTask } from "../../lib/install/pdf";
import { drawSharpCrop } from "./drawingCrop";
import "./cadImportPreview.css";

async function readDrafts(pdf: PDFDocumentProxy) {
  const drafts: CadUnitDraft[] = [];
  const failed: number[] = [];
  for (let sheet = 1; sheet <= pdf.numPages; sheet++) {
    try {
      const page = await pdf.getPage(sheet);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      drafts.push(...building3CadDrafts(sheet, content.items.flatMap(item => {
        if (!("str" in item) || !item.str.trim()) return [];
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        return [{ text: item.str.trim(), x: x / viewport.width, y: y / viewport.height }];
      })));
    } catch { failed.push(sheet); }
  }
  return { drafts, failed };
}


type Stage = "cad" | "plan" | "match" | "review";

const inches = (mm: number | null) => mm ? formatInchesMm(mm) : "—";

/** `embedded`: shown as the job's Units tab, under the job's own header, so
 * it brings no page frame or job code of its own. */
export function CadImportPreview({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"units" | "import">("units");
  const [stage, setStage] = useState<Stage>("cad");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [plan, setPlan] = useState<PlanSummary>({ loaded: false, openings: 0, attention: 0, added: 0 });
  const [file, setFile] = useState<File | null>(null);
  const [loaded, setLoaded] = useState<{ pdf: PDFDocumentProxy; drafts: CadUnitDraft[]; failed: number[]; sourceUrl: string } | null>(null);
  const [selected, setSelected] = useState("");
  const [edits, setEdits] = useState<Record<string, Partial<CadUnitDraft>>>({});
  const [invalidDimension, setInvalidDimension] = useState(false);
  const [evidence, setEvidence] = useState<{ key: string; src?: string } | null>(null);
  const [error, setError] = useState("");
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find(row => row.id === projectId);
  const openings = useQuery({ queryKey: ["openings", projectId], queryFn: () => listOpenings(projectId) });
  const [form, setForm] = useState<{ opening?: ProjectOpening; copy?: ProjectOpening; cad?: CadUnitDraft }>();
  const [target, setTarget] = useState("");
  const [resolved, setResolved] = useState<string[]>([]);
  const [deferred, setDeferred] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [batchField, setBatchField] = useState<"floor" | "material" | "inset">("floor");
  const [batchValue, setBatchValue] = useState("");
  const rows = (openings.data ?? []).filter(row => !row.removed_at);
  // Removed units count too: a removed unit keeps its number in the job's history.
  const existingCodes = useMemo(() => (openings.data ?? []).map(row => row.opening_code), [openings.data]);
  const placeholders = rows.filter(row => row.unit_details?.placeholder === true);
  const defined = rows.filter(row => row.unit_details?.placeholder !== true);
  const visible = defined.filter(row =>
    `${row.opening_code} ${row.unit_details?.kind ?? ""} ${row.unit_details?.configuration ?? ""} ${unitFloor(row) ?? ""}`
      .toLowerCase().includes(search.trim().toLowerCase()));
  const specs = useQuery({ queryKey: ["markSpecs", projectId], queryFn: () => listMarkSpecs(projectId), enabled: defined.length > 0 });
  const catalog = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits, enabled: defined.length > 0 });
  const specIndex = useMemo(() => indexSpecsByMark(specs.data ?? []), [specs.data]);
  const byMark = useMemo(() => catalogByMarkFrom(catalog.data ?? []), [catalog.data]);
  const groups = new Map<string, ProjectOpening[]>();
  for (const row of [...visible].sort((a, b) => a.opening_code.localeCompare(b.opening_code, undefined, { numeric: true }))) {
    const floor = unitFloor(row) ?? "Floor unspecified";
    const group = groups.get(floor) ?? [];
    group.push(row);
    groups.set(floor, group);
  }
  const floors = [...groups].sort(([a], [b]) => Number(a === "Floor unspecified") - Number(b === "Floor unspecified") ||
    a.localeCompare(b, undefined, { numeric: true }));
  const selectedRows = defined.filter(row => checked.includes(row.id));
  const pending = placeholders.filter(row => !row.unit_details?.builderDeferred);
  const openDrafts = loaded?.drafts.filter(row => !deferred.includes(row.key)) ?? [];
  const needsReview = (row: CadUnitDraft) => {
    const current = { ...row, ...edits[row.key] };
    return !current.kind || !current.widthMm || !current.heightMm;
  };

  // The short lists the form offers and the AI is told to expect, with whatever
  // this file's drafts and this job's units already use added after them.
  const draftsNow = (loaded?.drafts ?? []).map(row => ({ ...row, ...edits[row.key] }));
  const materialOptions = optionsWith(UNIT_MATERIALS, ...rows.map(row => row.unit_details?.material), ...draftsNow.map(row => row.material));
  const configurationOptions = (kind: CadUnitDraft["kind"]) => optionsWith(unitConfigurations(kind),
    ...draftsNow.filter(row => !kind || row.kind === kind).map(row => row.configuration));
  // What the AI can still add to a drawing: more than "needs review", which
  // is only type and size. The text reader never finds a material or a
  // quantity, so a drawing it read cleanly was skipped and came out with
  // neither (Matt, 2026-11-20: "I seem to be missing the material").
  const canReadMore = (row: CadUnitDraft) => !row.kind || !row.widthMm || !row.heightMm || !row.material || !row.configuration || row.quantity == null;

  // Ask the AI to read what is printed on a drawing the text reader could
  // not. It only fills fields that are still empty: a value the reader found,
  // or one a person typed, is never overwritten by a guess.
  //
  // Drawings are read AI_POOL at a time. Each answer takes several seconds and
  // none depends on another, so one at a time made twenty drawings a long wait.
  const [reading, setReading] = useState<{ working: string[]; queued: string[]; done: number; total: number }>();
  const [readNotes, setReadNotes] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<CompareTarget>();
  const stopReading = useRef(false);
  const readDrawings = async (targets: readonly CadUnitDraft[]) => {
    if (!loaded || reading || !targets.length) return;
    stopReading.current = false;
    setReading({ working: [], queued: targets.map(target => target.key), done: 0, total: targets.length });
    await runPool(targets, AI_POOL, async target => {
      setReading(now => now && { ...now, working: [...now.working, target.key], queued: now.queued.filter(key => key !== target.key) });
      let note: string;
      try {
        const data = await askCadAi({ task: "definition", projectId, label: target.label, sheet: target.sheet, dimensionsMm: target.dimensions,
          expected: { materials: materialOptions, configurations: configurationOptions("") },
          drawing: await aiCrop(loaded.pdf, target.sheet, target.crop, 1800) }) as (Record<string, never> & {
            error?: string; reason: string; kind: CadUnitDraft["kind"] | null; widthMm: number | null; heightMm: number | null;
            configuration: string | null; material: string | null; quantity: number | null; itemNumber: string | null }) | null;
        if (!data || data.error) note = data?.error ?? "AI reading is unavailable on this server. Fill the fields from the drawing.";
        else {
          setEdits(current => {
            const now = { ...target, ...current[target.key] };
            const patch: Partial<CadUnitDraft> = {
              ...(!now.kind && data.kind ? { kind: data.kind } : {}),
              ...(!now.widthMm && data.widthMm ? { widthMm: data.widthMm } : {}),
              ...(!now.heightMm && data.heightMm ? { heightMm: data.heightMm } : {}),
              ...(!now.configuration && data.configuration ? { configuration: matchOption(unitConfigurations(""), data.configuration) } : {}),
              ...(!now.material && data.material ? { material: matchOption(UNIT_MATERIALS, data.material) } : {}),
              ...(now.quantity == null && data.quantity ? { quantity: data.quantity } : {}),
              ...(!now.itemNumber && data.itemNumber ? { itemNumber: data.itemNumber } : {}),
            };
            return { ...current, [target.key]: { ...current[target.key], ...patch } };
          });
          note = data.reason;
        }
      } catch {
        note = "AI reading could not be completed. Fill the fields from the drawing.";
      }
      setReadNotes(current => ({ ...current, [target.key]: note }));
      setReading(now => now && { ...now, working: now.working.filter(key => key !== target.key), done: now.done + 1 });
    }, () => stopReading.current);
    setReading(undefined);
  };
  // The AI pass is part of reading the file, not a button to find (Matt,
  // 2026-11-20): as soon as the shop CAD is in, every drawing the text reader
  // left without a type, size, material, configuration or quantity is read. The ref makes it once per file, so
  // editing a field or a dev re-render never starts it again.
  const autoRead = useRef<typeof loaded>(null);
  useEffect(() => {
    if (!loaded || autoRead.current === loaded) return;
    autoRead.current = loaded;
    void readDrawings(loaded.drafts.filter(canReadMore));
    // readDrawings is recreated every render; this runs once per loaded file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const resetCad = () => {
    stopReading.current = true;
    setReadNotes({});
    setFile(null);
    setLoaded(null);
    setEvidence(null);
    setSelected("");
    setEdits({});
    setInvalidDimension(false);
    setResolved([]);
    setDeferred([]);
    setTarget("");
    setError("");
  };

  const applyBatch = async () => {
    const value = batchValue.trim();
    if (!value || !selectedRows.length || busy || form) return;
    if (batchField === "floor" && !/^-?\d{1,3}$/.test(value)) {
      setNotice("Enter a whole floor number.");
      return;
    }
    setBusy(true);
    setNotice("");
    const saved: string[] = [];
    try {
      for (const row of selectedRows) {
        const write: UnitDetailsWrite = {
          id: row.id, editId: crypto.randomUUID(), projectId, create: false, code: row.opening_code,
          details: { ...row.unit_details, [batchField]: value },
          previousCode: row.opening_code, previousDetails: row.unit_details ?? {},
          reason: "Batch edit in Unit Builder",
        };
        await refreshUnitDetails(client, write, await saveUnitDetails(write));
        saved.push(row.id);
      }
      setNotice(`Updated ${saved.length} units.`);
    } catch (error) {
      setNotice(`Updated ${saved.length} of ${selectedRows.length}. ${formatApiError(error)}`);
    } finally {
      setChecked(current => current.filter(id => !saved.includes(id)));
      setBusy(false);
    }
  };

  const deferPlaceholder = async (opening: ProjectOpening, disregard: boolean) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const write: UnitDetailsWrite = {
      id: opening.id, editId: crypto.randomUUID(), create: false, projectId, code: opening.opening_code,
      details: { ...opening.unit_details, builderDeferred: disregard },
      previousCode: opening.opening_code, previousDetails: opening.unit_details ?? {},
      reason: disregard ? "Disregarded in Unit Builder review" : "Returned to Unit Builder review",
    };
    try {
      await refreshUnitDetails(client, write, await saveUnitDetails(write));
      if (target === opening.id) setTarget("");
      if (form?.opening?.id === opening.id) setForm(undefined);
      setNotice(disregard ? "Removed from this review queue. The unit and its work are preserved." : "Returned to the review queue.");
    } catch (error) {
      setNotice(formatApiError(error));
    } finally {
      setBusy(false);
    }
  };


  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let task: ReturnType<typeof loadPdfTask> | undefined;
    let sourceUrl: string | undefined;
    void (async () => {
      try {
        const data = await file.arrayBuffer();
        if (cancelled) return;
        task = loadPdfTask(data);
        const pdf = await task.promise;
        if (cancelled) return;
        const { drafts, failed } = await readDrafts(pdf);
        if (cancelled) return;
        sourceUrl = URL.createObjectURL(file);
        setLoaded({ pdf, drafts, failed, sourceUrl });
        setSelected(drafts[0]?.key ?? "");
      } catch {
        if (!cancelled) setError("Forge couldn't read this PDF. Try selecting the original Building 3 CAD export again.");
      }
    })();
    return () => {
      cancelled = true;
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      void task?.destroy();
    };
  }, [file]);

  const original = openDrafts.find(draft => draft.key === selected);
  const draft = original && { ...original, ...edits[selected] };
  const update = (patch: Partial<CadUnitDraft>) =>
    setEdits(current => ({ ...current, [selected]: { ...current[selected], ...patch } }));

  useEffect(() => {
    if (!loaded || !original) return;
    let cancelled = false;
    const key = original.key;
    void drawSharpCrop(loaded.pdf, original.sheet, original.crop, 1800).then(
      src => { if (!cancelled) setEvidence({ key, src }); },
      () => { if (!cancelled) setEvidence({ key }); },
    );
    return () => { cancelled = true; };
  }, [loaded, original]);

  const waitingDrafts = openDrafts.filter(row => !resolved.includes(row.key));
  const draftGroups = [
    { title: "Needs review", tone: "warn", rows: waitingDrafts.filter(needsReview) },
    { title: "Ready to match", tone: "accent", rows: waitingDrafts.filter(row => !needsReview(row)) },
    { title: "Applied to a placeholder", tone: "ok", rows: openDrafts.filter(row => resolved.includes(row.key)) },
  ].filter(group => group.rows.length > 0);
  const unclearDrafts = waitingDrafts.filter(needsReview).length;
  // What each stage has established so far, said under its name in the stepper
  // so the person can tell where the import stands without opening the stage.
  const steps: { id: Stage; title: string; sub: string; done: boolean }[] = [
    { id: "cad", title: "Shop CAD", done: !!loaded && unclearDrafts === 0,
      sub: !loaded ? "What each unit is" : `${openDrafts.length} definitions${unclearDrafts ? ` · ${unclearDrafts} unclear` : ""}` },
    { id: "plan", title: "Floor plan", done: plan.loaded,
      sub: plan.loaded ? `${plan.openings} openings` : "Where each unit goes" },
    { id: "match", title: "Match", done: plan.loaded && plan.attention === 0,
      sub: !plan.loaded ? "Link openings to CAD" : plan.attention ? `${plan.attention} need attention` : "All openings resolved" },
    { id: "review", title: "Finish", done: plan.added > 0,
      sub: plan.added ? `${plan.added} units added to the job` : "Check totals, then add to the job" },
  ];
  const stageIndex = steps.findIndex(step => step.id === stage);
  const locked = busy || !!form;

  return <div className={embedded ? "cad-import" : "page cad-import"}>
    <header className="ub-head">
      <div>
        {project && !embedded && <p className="ub-eyebrow">{project.job_code}</p>}
        {embedded ? <h2>Unit Builder</h2> : <h1>Unit Builder</h1>}
        <p className="ub-lede">Establish the windows and doors on this job. Read them from the drawings, or define them by hand.</p>
      </div>
      <div className="ub-head-actions">
        <Link className="ub-btn" data-variant="ghost" to={`/projects/${projectId}/upload`}>Plansets</Link>
        <button type="button" data-variant="primary" disabled={locked} onClick={() => setForm({})}>
          <Plus size={16} aria-hidden="true"/>New unit
        </button>
      </div>
    </header>

    <div className="ub-seg ub-views" role="group" aria-label="Unit Builder view">
      <button type="button" aria-pressed={view === "units"} onClick={() => setView("units")}>
        Units on this job<span className="ub-count">{defined.length}</span>
        {pending.length > 0 && <span className="ub-count" data-tone="warn">{pending.length} to define</span>}
      </button>
      <button type="button" aria-pressed={view === "import"} onClick={() => setView("import")}>
        Import from drawings{loaded && <span className="ub-count">{waitingDrafts.length} drafts</span>}
      </button>
    </div>

    {notice && <p role="status" className="ub-notice">{notice}</p>}

    {form && <JobUnitBuilderForm key={form.opening?.id ?? form.cad?.key ?? "new"} projectId={projectId}
      opening={form.opening} copy={form.copy} cad={form.cad} onCancel={() => setForm(undefined)} onDone={() => {
        if (form.cad && !resolved.includes(form.cad.key)) setResolved(current => [...current, form.cad!.key]);
        setForm(undefined);
        setTarget("");
        setNotice("Changes saved to the job.");
      }}/>}

    {viewing && <DrawingCompare target={viewing} onClose={() => setViewing(undefined)}/>}

    <div className="ub-view" hidden={view !== "units"}>
      {openings.error && <p role="alert" className="ub-alert">{formatApiError(openings.error)}</p>}
      {placeholders.length > 0 && <section className="ub-card ub-attention" aria-label="Needs attention">
        <div className="ub-card-head">
          <TriangleAlert size={18} aria-hidden="true"/>
          <div>
            <h2>Workday placeholders <span className="ub-count" data-tone="warn">{pending.length}</span></h2>
            <p>Units the crew recorded in the field before they were defined. Defining one keeps its assignments and recorded work.</p>
          </div>
        </div>
        {!!pending.length && <ul className="ub-rows">{pending.map(row => <li key={row.id}>
          <span className="ub-row-main"><strong>{row.opening_code}</strong>
            {row.unit_details?.kind && <small>{unitKindLabel(row.unit_details.kind)}</small>}</span>
          <button type="button" disabled={locked} aria-label={`Define ${row.opening_code}`} onClick={() => setForm({ opening: row })}>Define</button>
          <button type="button" data-variant="ghost" disabled={locked} aria-label={`Disregard ${row.opening_code}`}
            onClick={() => void deferPlaceholder(row, true)}>Disregard</button>
        </li>)}</ul>}
        {placeholders.length > pending.length && <details className="ub-disclosure">
          <summary>Disregarded placeholders ({placeholders.length - pending.length})</summary>
          <ul className="ub-rows">{placeholders.filter(row => row.unit_details?.builderDeferred).map(row => <li key={row.id}>
            <span className="ub-row-main"><strong>{row.opening_code}</strong></span>
            <button type="button" data-variant="ghost" disabled={locked} aria-label={`Return ${row.opening_code} to review`}
              onClick={() => void deferPlaceholder(row, false)}>Return to review</button>
          </li>)}</ul>
        </details>}
      </section>}

      <section className="ub-card" aria-label="Job units">
        {openings.isPending ? <p role="status" className="ub-progress">Loading job units…</p>
          : !defined.length ? <div className="ub-empty">
            <SquareDashed size={28} aria-hidden="true"/>
            <h2>No units on this job yet</h2>
            <p>Start from the shop CAD and floor plan, or define the first unit by hand.</p>
            <div className="ub-actions">
              <button type="button" data-variant="primary" onClick={() => setView("import")}>Import from drawings</button>
              <button type="button" disabled={locked} onClick={() => setForm({})}>Define a unit by hand</button>
            </div>
          </div> : <>
            <div className="ub-toolbar">
              <label className="ub-search"><Search size={16} aria-hidden="true"/>
                <input type="search" aria-label="Find unit" placeholder="Find a unit, type or floor" value={search}
                  onChange={event => setSearch(event.target.value)}/>
              </label>
              <button type="button" data-variant="ghost" disabled={locked || !visible.length} onClick={() =>
                setChecked(current => [...new Set([...current, ...visible.map(row => row.id)])])}>Select visible</button>
            </div>
            {!!selectedRows.length && <div className="ub-selection" role="group" aria-label="Change selected units">
              <strong>{selectedRows.length} selected</strong>
              <label>Change <select value={batchField} disabled={locked} onChange={event => {
                const field = event.target.value;
                if (field === "floor" || field === "material" || field === "inset") setBatchField(field);
                setBatchValue("");
              }}>
                <option value="floor">Floor</option><option value="material">Material</option><option value="inset">Inset/outset</option>
              </select></label>
              {batchField === "inset" ? <label>to <select aria-label="New value" value={batchValue} disabled={locked} onChange={event => setBatchValue(event.target.value)}>
                <option value="">Choose</option><option value="inset">Inset</option><option value="outset">Outset</option><option value="unknown">Unknown</option>
              </select></label> : <label>to <input aria-label="New value" value={batchValue} disabled={locked}
                inputMode={batchField === "floor" ? "numeric" : "text"} onChange={event => setBatchValue(event.target.value)}/></label>}
              <button type="button" data-variant="primary" disabled={locked || !batchValue.trim()} onClick={() => void applyBatch()}>Apply</button>
              <button type="button" data-variant="ghost" disabled={locked} onClick={() => setChecked([])}>Clear</button>
            </div>}
            {!visible.length && <p className="ub-note">No units match “{search.trim()}”.</p>}
            {!!floors.length && <div className="job-planner cad-builder-inventory">
              <FloorIndex floors={floors.map(([floor]) => floor)}>
                {current => floors.map(([floor, units], index) => <section key={floor} className="jp-unit-stage"
                  aria-label={floor} data-current-floor={index === current}>
                  <h3>{floor} <span>{units.length}</span>
                    <button type="button" className="jp-select-floor" disabled={locked || units.every(row => checked.includes(row.id))}
                      onClick={() => setChecked(old => [...new Set([...old, ...units.map(row => row.id)])])}>Select all</button>
                  </h3>
                  <div className="jp-unit-options">{units.map(row => {
                    const details = row.unit_details;
                    const mark = unitSourceMark(row);
                    const resolved = mark ? resolveMarkConfig(mark, specIndex, byMark) : null;
                    const diagram = unitDefinitionDiagram(details, 100, 65) ?? (resolved &&
                      (!details?.kind || details.kind === resolved.kind) ? unitSvg(resolved, 100, 65) : null);
                    const recordedSize = details?.width !== undefined || details?.height !== undefined;
                    const format = (value: number | null | undefined) => value == null ? "" : formatInchesMm(value * MM_PER_INCH);
                    const width = format(recordedSize ? details?.width : row.window_types?.width_in);
                    const height = format(recordedSize ? details?.height : row.window_types?.height_in);
                    const basis = !recordedSize ? "Catalog size" : details?.basis === "drawing" ? "Drawing size"
                      : details?.basis === "rough" ? "Rough opening" : details?.basis === "unit" ? "Outside frame" : "";
                    const isChecked = checked.includes(row.id);
                    // The same tile the Plan and Workday draw, with this screen's own
                    // lines: what the unit is, and its size where the others show status.
                    return <UnitTile key={row.id} code={row.opening_code}
                      picture={diagram ? <img alt="" src={`data:image/svg+xml,${encodeURIComponent(diagram)}`}/> : <SquareDashed size={26}/>}
                      status={(width || height) ? `${width || "—"} × ${height || "—"}` : undefined} statusTitle={basis}
                      card={{ role: "article", "aria-label": `Unit ${row.opening_code}`, "data-selected-unit": isChecked }}
                      pick={{ "data-included": isChecked, "aria-pressed": isChecked, "aria-label": `Select unit ${row.opening_code}`,
                        disabled: locked, onClick: () => setChecked(old => isChecked ? old.filter(id => id !== row.id) : [...old, row.id]) }}
                      after={<div className="cad-builder-unit-actions">
                        <button type="button" disabled={locked} aria-label={`Edit ${row.opening_code}`}
                          onClick={() => setForm({ opening: row })}><Pencil size={13} aria-hidden="true"/>Edit</button>
                        <button type="button" disabled={locked} aria-label={`Copy ${row.opening_code}`}
                          onClick={() => setForm({ copy: row })}><Copy size={13} aria-hidden="true"/>Copy</button>
                      </div>}>
                      <small>{details?.configuration || row.window_types?.name || (details?.kind ? unitKindLabel(details.kind) : "Type unspecified")}</small>
                    </UnitTile>;
                  })}</div>
                </section>)}
              </FloorIndex></div>}
          </>}
      </section>
      <p className="ub-note"><Link to={`/projects/${projectId}/review`}>Opening Review and removed units</Link></p>
    </div>

    <div className="ub-view" hidden={view !== "import"}>
      <section className="ub-card ub-import" aria-label="Import from drawings">
        <div className="ub-stepper-row">
          <ol className="ub-stepper" aria-label="Import stages">
            {steps.map((step, index) => <li key={step.id} data-done={step.done} data-past={index < stageIndex}>
              <button type="button" aria-current={stage === step.id ? "step" : undefined}
                disabled={step.id === "review" && (!plan.loaded || plan.attention > 0)} onClick={() => setStage(step.id)}>
                <span className="ub-step-dot" aria-hidden="true">{step.done ? <Check size={14}/> : index + 1}</span>
                <span className="ub-step-text"><strong>{step.title}</strong><small>{step.sub}</small></span>
              </button>
            </li>)}
          </ol>
          <button type="button" data-variant="ghost" className="ub-restart" disabled={!!form || (!file && !plan.loaded)} onClick={() => {
            if (fileInput.current) fileInput.current.value = "";
            resetCad();
            setPreviewVersion(version => version + 1);
            setPlan({ loaded: false, openings: 0, attention: 0, added: 0 });
            setStage("cad");
          }}><RotateCcw size={14} aria-hidden="true"/>Start over</button>
        </div>
        <p className="ub-note">The import is a draft in this tab. Units are added to the job only when you finish the last step.</p>

        <div className="ub-step-body" hidden={stage !== "cad"}>
          <div className="ub-step-title">
            <h2>Shop CAD</h2>
            <p>The manufacturer’s drawings say what each unit is: its type, size, configuration and material.</p>
          </div>
          <UnitBuilderFile label="Shop CAD PDF" hint="Drop the shop CAD export here, or choose it." file={file} inputRef={fileInput}
            disabled={!!form}
            status={error ? "Could not be read" : !loaded ? "Reading drawing labels and dimensions…"
              : `${loaded.pdf.numPages} sheets · ${loaded.drafts.length} drawing definitions`}
            onPick={next => { if (form) return; resetCad(); setFile(next); }}
            onRemove={() => { if (fileInput.current) fileInput.current.value = ""; resetCad(); }}/>
          {error && <p role="alert" className="ub-alert">{error}</p>}
          {loaded && !loaded.drafts.length && <p role="status" className="ub-alert" data-tone="warn">
            No matching drawing definitions found. This preview reads the Building 3 CAD export labeled CADs-1 through CADs-8.</p>}
          {loaded?.failed.map(sheet => <p key={sheet} role="alert" className="ub-alert">Sheet {sheet} could not be read.{" "}
            <a href={`${loaded.sourceUrl}#page=${sheet}`} target="_blank" rel="noreferrer">Open original sheet</a></p>)}

          {loaded && loaded.drafts.length > 0 && <div className="ub-definitions">
            <nav className="ub-draft-nav" aria-label="CAD definitions">
              {reading ? <div className="ub-ai-run">
                <div><p role="status" className="ub-progress">Reading drawings… {reading.done} of {reading.total}</p>
                  {reading.total > 1 && <button type="button" data-variant="ghost" onClick={() => {
                    stopReading.current = true;
                    setReading(now => now && { ...now, queued: [] });
                  }}>Stop</button>}</div>
                <div className="ub-bar" aria-hidden="true"><span style={{ width: `${Math.max(4, reading.done / reading.total * 100)}%` }}/></div>
              </div> : unclearDrafts > 0 && ( <button type="button" disabled={!!form} onClick={() => void readDrawings(waitingDrafts.filter(needsReview))}>
                <Sparkles size={16} aria-hidden="true"/>Read {unclearDrafts} unclear with AI</button>)}
              {draftGroups.map(group => <div key={group.title}>
                <h3>{group.title} <span className="ub-count" data-tone={group.tone}>{group.rows.length}</span></h3>
                <ul>{group.rows.map(row => {
                  const current = { ...row, ...edits[row.key] };
                  return <li key={row.key}>
                    <button type="button" disabled={!!form} aria-current={selected === row.key ? "true" : undefined}
                      data-ai={reading?.working.includes(row.key) ? "working" : reading?.queued.includes(row.key) ? "queued" : undefined}
                      onClick={() => { setSelected(row.key); setTarget(""); setInvalidDimension(false); }}>
                      <strong>{current.label}</strong>
                      <small>Sheet {row.sheet} · {current.kind ? unitKindLabel(current.kind) : "Type unclear"} · {inches(current.widthMm)} × {inches(current.heightMm)}</small>
                    </button>
                  </li>;
                })}</ul>
              </div>)}
              {!openDrafts.length && <p className="ub-note">Every draft is disregarded.</p>}
              {deferred.length > 0 && <button type="button" data-variant="ghost" disabled={!!form} onClick={() => {
                if (!selected) setSelected(deferred[0]);
                setDeferred([]);
              }}>Return {deferred.length} disregarded</button>}
            </nav>
            {draft && original ? <div className="cad-import-review">
              <div className="cad-import-draft">
                <fieldset className="cad-import-fields" disabled={!!form || reading?.working.includes(draft.key)}
                  data-ai-filling={reading?.working.includes(draft.key) || undefined}>
                  <label>Drawing designation<input value={draft.label} onChange={event => update({ label: event.target.value })}/></label>
                  <label>Type<select value={draft.kind} onChange={event => update({ kind: event.target.value as CadUnitDraft["kind"] })}>
                    <option value="">Needs review</option>{UNIT_KINDS.map(value => <option key={value} value={value}>{unitKindLabel(value)}</option>)}
                  </select></label>
                  <DimensionFields key={draft.key} width={draft.widthMm} height={draft.heightMm}
                    labels={{ legend: "Drawing dimensions", width: "Drawing width", height: "Drawing height", fraction: "Fraction" }}
                    onValidChange={valid => setInvalidDimension(!valid)}
                    onChange={(side, mm) => update({ [side === "width" ? "widthMm" : "heightMm"]: mm })}/>
                  <label>Material<PickOrAdd value={draft.material} options={materialOptions} onChange={material => update({ material })}/></label>
                  <label>Quantity<input type="number" min="1" step="1" value={draft.quantity ?? ""} onChange={event => update({ quantity: event.target.value === "" ? null : event.target.valueAsNumber })}/></label>
                  <label className="ub-span">Configuration<PickOrAdd value={draft.configuration} options={configurationOptions(draft.kind)} onChange={configuration => update({ configuration })}/></label>
                </fieldset>
                {draft.itemNumber && <p className="ub-note">CAD item {draft.itemNumber}</p>}
                {readNotes[draft.key] && <p role="status" className="ub-alert" data-tone="info"><Sparkles size={16} aria-hidden="true"/>
                  <span>{readNotes[draft.key]} Check each value against the drawing.</span></p>}
                {needsReview(original) && !reading && <div className="ub-ai">
                  <button type="button" disabled={!!form} onClick={() => void readDrawings([original])}>
                    <Sparkles size={16} aria-hidden="true"/>{readNotes[draft.key] ? "Read again with AI" : "Read this drawing with AI"}</button>
                  <p className="ub-note">Sends this drawing crop to fill the empty fields. {import.meta.env.DEV ? "In development this runs through Codex on this computer." : "No job records are saved."}</p>
                </div>}
                {reading?.working.includes(draft.key) && <p role="status" className="ub-progress">Reading this drawing…</p>}
                {reading?.queued.includes(draft.key) && <p role="status" className="ub-note">Waiting its turn to be read.</p>}
                {draft.dimensions.length > 0 && <details className="ub-disclosure"><summary>Dimension callouts on drawing</summary>
                  <p>{draft.dimensions.map(mm => formatInchesMm(mm)).join(", ")}</p>
                </details>}
                {invalidDimension && <p role="alert" className="ub-alert">Enter a positive dimension in the selected units.</p>}
                <div className="ub-use">
                  {/* A definition no longer makes a new unit from here: new units come from
                      Finish. Applying one to a placeholder stays, because that unit is
                      already on the job and only gains its definition. */}
                  {pending.length > 0 ? <label>Define a field placeholder with this
                    <select value={target} disabled={!!form} onChange={event => setTarget(event.target.value)}>
                      <option value="">Choose a placeholder</option>
                      {pending.map(row => <option key={row.id} value={row.id}>Placeholder {row.opening_code}</option>)}
                    </select>
                  </label> : <span/>}
                  <div className="ub-actions">
                    <button type="button" data-variant="ghost" disabled={locked} onClick={() => {
                      setDeferred(current => [...current, draft.key]);
                      setSelected("");
                      setTarget("");
                      setInvalidDimension(false);
                    }}>Disregard draft</button>
                    {pending.length > 0 && <button type="button" disabled={locked || invalidDimension || !pending.some(row => row.id === target)}
                      onClick={() => setForm({ cad: draft, opening: pending.find(row => row.id === target) })}>
                      Preview placeholder match
                    </button>}
                  </div>
                </div>
              </div>
              <figure className="cad-import-source">
                <figcaption><span>Sheet {original.sheet} · {original.label}</span>
                  <a href={`${loaded?.sourceUrl}#page=${original.sheet}`} target="_blank" rel="noreferrer">Open original sheet</a>
                  {loaded && <button type="button" className="ub-expand" data-variant="ghost" aria-label={`View ${draft.label} full screen`} title="Full screen"
                    onClick={() => setViewing({ title: `Shop CAD ${draft.label}`, cad: { pdf: loaded.pdf, draft } })}><Maximize2 size={16} aria-hidden="true"/></button>}
                </figcaption>
                {evidence?.key !== original.key ? <p role="status" className="ub-progress">Rendering source drawing…</p> : evidence.src
                  // A click opens it full screen. It used to be a download link, so a
                  // click meant to look closer saved a file instead; right-click
                  // (long press on a phone) still saves the picture.
                  ? <img className="ub-zoomable" src={evidence.src} alt={`Shop drawing for ${original.label}`}
                    onClick={() => loaded && setViewing({ title: `Shop CAD ${draft.label}`, cad: { pdf: loaded.pdf, draft } })}/>
                  : <p>Forge couldn’t render this drawing crop. Check the original PDF.</p>}
              </figure>
            </div> : <p className="ub-note ub-pick-hint">Choose a definition to check it against its drawing.</p>}
          </div>}

          <footer className="ub-step-foot">
            <span/>
            <button type="button" data-variant={loaded ? "primary" : undefined} onClick={() => setStage("plan")}>
              {loaded ? "Continue to floor plan" : "Skip to floor plan"}<ArrowRight size={16} aria-hidden="true"/>
            </button>
          </footer>
        </div>

        <MarkedPlanPreview key={previewVersion} drafts={openDrafts.map(row => ({ ...row, ...edits[row.key] }))}
          cadSource={loaded?.sourceUrl} cadPdf={loaded?.pdf} projectId={projectId}
          existingCodes={existingCodes} cadBusy={!!file && (!loaded || !!reading)}
          step={view === "import" && stage !== "cad" ? stage : null} onStep={setStage} onSummary={setPlan}
          onFinished={count => { setNotice(`Added ${count} units to the job.`); setView("units"); }}/>
      </section>
    </div>
  </div>;
}
