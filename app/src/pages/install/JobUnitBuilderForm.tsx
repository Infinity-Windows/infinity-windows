import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { SET_DEPTHS } from "../../lib/install/buildFacts";
import { refreshUnitDetails, saveUnitDetails } from "../../lib/install/unitDetailsApi";
import { isUnitKind, UNIT_KINDS, unitKindLabel, unitSourceMark, type UnitDetails, type UnitDetailsWrite } from "../../lib/install/unitDetails";
import type { ProjectOpening } from "../../lib/install/types";
import { DimensionFields } from "../../components/install/DimensionFields";
import { PickOrAdd } from "../../components/install/PickOrAdd";
import { UNIT_MATERIALS } from "../../lib/install/unitVocabulary";
import { MM_PER_INCH } from "../../lib/install/dimensionEntry";
import { unitDefinitionDiagram, unitDefinitionPresets } from "../../lib/install/unitDefinitionDiagram";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";

export function JobUnitBuilderForm({ projectId, opening, copy, cad, onDone, onCancel }: {
  projectId: string;
  opening?: ProjectOpening;
  copy?: ProjectOpening;
  cad?: CadUnitDraft;
  onDone: () => void;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const numberInput = useRef<HTMLInputElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);
  // A modal sheet rather than a block at the top of the page: Edit and Copy sit
  // on cards far down the floor list, and the form used to open out of sight.
  useEffect(() => {
    const dialog = sheet.current;
    if (dialog && !dialog.open) dialog.showModal();
    numberInput.current?.focus();
    return () => dialog?.close();
  }, []);
  const receipts = useRef(new Map<string, { id: string; editId: string }>());
  const [code, setCode] = useState(opening?.opening_code ?? "");
  const [details, setDetails] = useState<UnitDetails>(() => ({
    ...(copy?.unit_details ?? {}),
    ...(opening?.unit_details ?? {}),
    ...(cad?.kind ? { kind: cad.kind } : {}),
    ...(cad?.widthMm ? { width: cad.widthMm / MM_PER_INCH } : {}),
    ...(cad?.heightMm ? { height: cad.heightMm / MM_PER_INCH } : {}),
    ...(cad?.widthMm || cad?.heightMm ? { basis: "drawing" } : {}),
    ...(cad?.configuration ? { configuration: cad.configuration } : {}),
    ...(cad?.material ? { material: cad.material } : {}),
  }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<UnitDetails>) => setDetails(current => ({ ...current, ...patch }));
  const presets = unitDefinitionPresets(details.kind);
  const diagram = unitDefinitionDiagram(details);
  const placeholder = opening?.unit_details?.placeholder === true;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const keepPlaceholder = placeholder && submitter?.getAttribute("value") === "edit";
    if (!code.trim() || !details.kind) { setError("Enter a unit number and choose a type."); return; }
    const numbers = opening ? [code.trim()] : code.split(/[,\n]/).map(value => value.trim()).filter(Boolean);
    if (!numbers.length || new Set(numbers.map(value => value.toLowerCase())).size !== numbers.length) {
      setError("Enter a different number for each unit.");
      return;
    }
    const existing = client.getQueryData<ProjectOpening[]>(["openings", projectId]) ?? [];
    const conflict = numbers.find(number => existing.some(row => !row.removed_at && row.id !== opening?.id &&
      row.id !== receipts.current.get(number)?.id && row.opening_code.toLowerCase() === number.toLowerCase()));
    if (conflict) { setError(`Unit ${conflict} already exists. Choose a new number.`); return; }
    const nextDetails = { ...details };
    if (copy) {
      delete nextDetails.sourceMark;
      delete nextDetails.builderDeferred;
    }
    if ((nextDetails.width || nextDetails.height) && !details.basis) { setError("Choose what the dimensions measure."); return; }
    const sourceMark = opening && unitSourceMark(opening);
    if (sourceMark && opening.opening_code !== code.trim()) nextDetails.sourceMark = sourceMark;
    if (!opening || placeholder) nextDetails.placeholder = keepPlaceholder;
    if (!keepPlaceholder) delete nextDetails.builderDeferred;
    setBusy(true);
    setError("");
    const completed: string[] = [];
    try {
      for (const number of numbers) {
        const receipt = receipts.current.get(number) ?? { id: opening?.id ?? crypto.randomUUID(), editId: crypto.randomUUID() };
        receipts.current.set(number, receipt);
        const write: UnitDetailsWrite = {
          ...receipt, projectId, code: number, create: !opening, details: nextDetails,
          previousCode: opening?.opening_code ?? null, previousDetails: opening?.unit_details ?? {},
          reason: keepPlaceholder ? "Edited in Unit Builder" : cad ? `CAD sheet ${cad.sheet}: ${cad.label}`
            : placeholder ? "Defined field placeholder" : copy ? "Copied definition in Unit Builder" : "Defined in Unit Builder",
        };
        const applied = await saveUnitDetails(write);
        completed.push(number);
        await refreshUnitDetails(client, write, applied).catch(() => { void client.invalidateQueries({ queryKey: ["openings", projectId] }); });
      }
      onDone();
    } catch (error) {
      if ((error as { code?: string })?.code) receipts.current.delete(numbers[completed.length]);
      if (completed.length) setCode(numbers.slice(completed.length).join(", "));
      setError(completed.length ? `Saved ${completed.length}. ${formatApiError(error)}` : formatApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const title = placeholder ? "Define placeholder" : opening ? "Edit unit definition" : copy ? `Copy ${copy.opening_code}` : "Define new units";
  return <dialog ref={sheet} className="ub-sheet" aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form className="cad-builder-form" onSubmit={event => void save(event)}>
      <header className="ub-sheet-head">
        <div>
          <h2>{title}</h2>
          {cad && <p>Using {cad.label} · Sheet {cad.sheet}. Give this opening its own unit number.</p>}
          {placeholder && <p>This keeps the original unit and its assignments and recorded work.</p>}
          {!opening && !cad && !copy && <p>Separate several numbers with commas to create matching units at once.</p>}
        </div>
        <button type="button" data-variant="ghost" aria-label="Close" onClick={onCancel} disabled={busy}><X size={18} aria-hidden="true"/></button>
      </header>
      <fieldset className="cad-import-fields ub-sheet-body" disabled={busy}>
        <h3>Identity</h3>
        <label className={opening ? undefined : "ub-span"}>{opening ? "Unit number" : "Unit numbers"}
          <input ref={numberInput} required value={code} placeholder={opening ? undefined : "2-4, 2-5, 2-6"} autoComplete="off" onChange={event => setCode(event.target.value)}/>
        </label>
        <label>Type<select aria-label="Type" required value={details.kind ?? ""} onChange={event => {
          const kind = event.target.value;
          update({ kind: isUnitKind(kind) ? kind : null,
            ...(details.configuration && presets.includes(details.configuration) && kind !== details.kind ? { configuration: null } : {}) });
        }}><option value="">Choose type</option>{UNIT_KINDS.map(value => <option key={value} value={value}>{unitKindLabel(value)}</option>)}</select></label>
        <h3>Location</h3>
        <label>Floor<input type="number" min="-999" max="999" step="1" value={details.floor ?? ""} onChange={event => update({ floor: event.target.value || null })}/></label>
        <h3>Size</h3>
        <DimensionFields width={details.width == null ? null : details.width * MM_PER_INCH}
          height={details.height == null ? null : details.height * MM_PER_INCH}
          onChange={(side, mm) => update({ [side]: mm === null ? null : mm / MM_PER_INCH })}/>
        <label>Measurement basis<select value={details.basis ?? ""} onChange={event => {
          const basis = event.target.value;
          update({ basis: basis === "drawing" || basis === "rough" || basis === "unit" ? basis : null });
        }}><option value="">Choose basis</option><option value="unit">Outside frame</option><option value="rough">Rough opening</option><option value="drawing">Drawing size</option></select></label>
        <label>Inset/outset<select value={details.inset ?? ""} onChange={event => update({ inset: SET_DEPTHS.find(value => value === event.target.value) ?? null })}>
          <option value="">Unspecified</option><option value="inset">Inset</option><option value="outset">Outset</option><option value="unknown">Unknown</option>
        </select></label>
        <h3>Build</h3>
        <label>Material<PickOrAdd value={details.material} options={UNIT_MATERIALS} onChange={material => update({ material: material || null })}/></label>
        <label>Configuration<input value={details.configuration ?? ""} onChange={event => update({ configuration: event.target.value || null })}/></label>
        {presets.length > 0 && <div className="cad-builder-presets" role="group" aria-label="Configuration presets">
          {presets
            .map(label => <button key={label} type="button" aria-pressed={details.configuration === label}
              onClick={() => update({ configuration: label })}>{label}</button>)}
        </div>}
        {diagram && <img className="cad-builder-diagram" alt="Configuration schematic" src={`data:image/svg+xml,${encodeURIComponent(diagram)}`}/>}
      </fieldset>
      <footer className="ub-sheet-foot">
        {error && <p role="alert" className="ub-alert">{error}</p>}
        <div className="ub-actions">
          <button type="button" data-variant="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          {placeholder && !cad && <button type="submit" value="edit" disabled={busy}>Save as placeholder</button>}
          <button type="submit" data-variant="primary" disabled={busy}>{busy ? "Saving…" : placeholder ? cad ? "Absorb into placeholder" : "Confirm unit" : opening || !code.includes(",") ? "Save unit" : "Save units"}</button>
        </div>
      </footer>
    </form>
  </dialog>;
}
