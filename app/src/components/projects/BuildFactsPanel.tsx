// The Job facts card on a job's Overview (S4, .scratch/installer-os): the
// build answers a foreman records once so nobody on the crew has to ask
// twice — the exterior situations (one line per finish on the house),
// flashing, fasteners, site rules, and one box of elevation notes.
//
// Foreman+ only here. An installer's read-only view lives on the unit sheet
// instead (S5) — this card is where the answers get WRITTEN, and writing is
// foreman+ both here and on the server (upsert_build_facts). The GC's name
// and number are written on the GC card up top (GcContactFields), not here.
//
// Every field saves on its own, on blur (text/number) or change (select),
// through the offline outbox — a foreman standing at the site fills these in
// with whatever signal the job has. The exterior situations are one list
// saved whole on every change, for the same reason (owner, 2026-09-07: a
// house is brick on the front and stucco on the sides, and the crew hits
// both). Supervisor+ additionally sees the six green-light items above the
// fields, open ones first, each naming who is expected to answer it (S4,
// warn-never-block).
//
// Degrades rather than crashes on a database ahead of the migration:
// getBuildFacts/listGreenLightItems both answer empty instead of throwing, so
// the card still renders — just with nothing recorded yet.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EMPTY_EXTERIOR_LINE,
  EXTERIOR_FINISHES,
  EXTERIOR_FINISH_KEYS,
  FASTENER_TYPES,
  FASTENER_TYPE_KEYS,
  FLASHING_SYSTEMS,
  FLASHING_SYSTEM_KEYS,
  MAX_EXTERIOR_LINES,
  SET_DEPTHS,
  SET_DEPTH_KEYS,
  WHO_KEYS,
  buildFactsKey,
  getBuildFacts,
  greenLightItemsKey,
  isBlankExteriorLine,
  listGreenLightItems,
  saveBuildFact,
  type BuildFactsField,
  type BuildFactsPatch,
  type ExteriorFinish,
  type ExteriorLine,
  type GreenLightItem,
  type SetDepth,
} from "../../lib/install/buildFacts";
import { useT } from "../../lib/i18n";
import type { TKey } from "../../lib/i18n/catalog";
import { pushToast, toastError } from "../../lib/toast";

type Translate = (key: TKey, vars?: Record<string, string | number>) => string;

export function BuildFactsPanel({
  projectId,
  isLead,
  isSupervisorPlus,
}: {
  projectId: string;
  isLead: boolean;
  isSupervisorPlus: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();

  const facts = useQuery({
    queryKey: buildFactsKey(projectId),
    queryFn: () => getBuildFacts(projectId),
  });

  const checklist = useQuery({
    queryKey: greenLightItemsKey(projectId),
    queryFn: () => listGreenLightItems(projectId),
    enabled: isSupervisorPlus,
  });

  const save = useMutation({
    mutationFn: (patch: BuildFactsPatch) => saveBuildFact(projectId, patch),
    onSuccess: () => {
      pushToast(t("buildFacts.saved"), "info");
      void queryClient.invalidateQueries({ queryKey: buildFactsKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: greenLightItemsKey(projectId) });
    },
    onError: (e) => toastError(e),
  });

  // Hooks before the early return below (rules-of-hooks).
  // Which pick-list answer is on screen for the two lists that have an
  // "Other" box. The save goes through the outbox, whose promise resolves
  // when the write is QUEUED, not when the server has it — so the refetch
  // that follows can still read the old value, and the "Which one?" box has
  // to open off what the foreman just chose, not off the row. Once the row
  // catches up the two agree.
  const [flashingChoice, setFlashingChoice] = useState<string | null>(null);
  const [fastenerChoice, setFastenerChoice] = useState<string | null>(null);

  if (!isLead) return null;

  const f = facts.data;
  const flashingShown = flashingChoice ?? f?.flashing_system ?? "";
  const fastenerShown = fastenerChoice ?? f?.fastener_type ?? "";
  // Remounts every input when the stored row actually changes (a seed from
  // the GC handshake, another tab's save) without fighting the field
  // somebody is mid-edit in — defaultValue only reads its initial value once
  // per mount, so this is the whole refresh mechanism.
  const revision = f?.updated_at ?? "new";

  const commit = (field: BuildFactsField, raw: string) => {
    const value = raw.trim();
    save.mutate({ [field]: value === "" ? null : value } as BuildFactsPatch);
  };
  const commitNumber = (field: BuildFactsField, raw: string) => {
    const value = raw.trim();
    if (value === "") {
      save.mutate({ [field]: null } as BuildFactsPatch);
      return;
    }
    const n = Number(value);
    if (Number.isFinite(n)) save.mutate({ [field]: n } as BuildFactsPatch);
  };

  return (
    <section className="detail-card build-facts-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>{t("buildFacts.title")}</h2>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        {!facts.isLoading && !f ? t("buildFacts.empty") : t("buildFacts.intro")}
      </p>

      {isSupervisorPlus && (
        <GreenLightChecklist items={checklist.data ?? []} loading={checklist.isLoading} t={t} />
      )}

      {!facts.isLoading && (
        <ExteriorLinesEditor
          serverLines={f?.exterior_lines ?? []}
          t={t}
          onSave={(lines) => save.mutate({ exterior_lines: lines })}
        />
      )}

      <div className="build-facts-grid">
        <Select
          keyBase={`flash-${revision}`}
          label={t("buildFacts.field.flashingSystem")}
          value={flashingShown}
          options={FLASHING_SYSTEMS}
          optionKeys={FLASHING_SYSTEM_KEYS}
          t={t}
          onCommit={(v) => {
            setFlashingChoice(v);
            commit("flashing_system", v);
          }}
        />
        {flashingShown === "other" && (
          <TextField
            keyBase={`flash-other-${revision}`}
            label={t("buildFacts.field.otherWhich")}
            value={f?.flashing_system_other ?? ""}
            onCommit={(v) => commit("flashing_system_other", v)}
          />
        )}
        <TextField
          keyBase={`flash-note-${revision}`}
          label={t("buildFacts.field.flashingNote")}
          value={f?.flashing_note ?? ""}
          onCommit={(v) => commit("flashing_note", v)}
        />

        <Select
          keyBase={`fast-${revision}`}
          label={t("buildFacts.field.fastenerType")}
          value={fastenerShown}
          options={FASTENER_TYPES}
          optionKeys={FASTENER_TYPE_KEYS}
          t={t}
          onCommit={(v) => {
            setFastenerChoice(v);
            commit("fastener_type", v);
          }}
        />
        {fastenerShown === "other" && (
          <TextField
            keyBase={`fast-other-${revision}`}
            label={t("buildFacts.field.otherWhich")}
            value={f?.fastener_type_other ?? ""}
            onCommit={(v) => commit("fastener_type_other", v)}
          />
        )}
        <NumberField
          keyBase={`fast-len-${revision}`}
          label={t("buildFacts.field.fastenerLength")}
          value={f?.fastener_length_in ?? null}
          onCommit={(v) => commitNumber("fastener_length_in", v)}
        />
        <NumberField
          keyBase={`fast-spc-${revision}`}
          label={t("buildFacts.field.fastenerSpacing")}
          value={f?.fastener_spacing_in ?? null}
          onCommit={(v) => commitNumber("fastener_spacing_in", v)}
        />
        <TextField
          keyBase={`fast-note-${revision}`}
          label={t("buildFacts.field.fastenerNote")}
          value={f?.fastener_note ?? ""}
          onCommit={(v) => commit("fastener_note", v)}
        />

        <TextArea
          keyBase={`rules-${revision}`}
          label={t("buildFacts.field.siteRules")}
          value={f?.site_rules ?? ""}
          onCommit={(v) => commit("site_rules", v)}
        />

        <TextArea
          keyBase={`elev-${revision}`}
          label={t("buildFacts.field.elevationNotes")}
          value={f?.elevation_notes ?? ""}
          onCommit={(v) => commit("elevation_notes", v)}
        />
      </div>
    </section>
  );
}

/**
 * The exterior situations: one line per finish on the house. Local state is
 * the draft; every committed change (a select, a blur) saves the WHOLE list.
 * Blank lines are dropped before saving so a stray "Add" never stores an
 * empty row — but they stay on screen until the foreman fills them in or
 * removes them.
 *
 * Once the foreman has touched the list on this mount, the server's copy is
 * NOT read back into it. Each save round-trips through the outbox and comes
 * back as a fresh row, and a row that arrives between two quick edits
 * (finish, then set depth) would otherwise replace the draft with a list
 * that predates the second edit — the exact race a browser test caught. The
 * server's list is adopted only while nothing has been edited here (first
 * load, another tab's save on an untouched card).
 */
type DraftRow = { id: number; line: ExteriorLine };

function ExteriorLinesEditor({
  serverLines,
  t,
  onSave,
}: {
  serverLines: ExteriorLine[];
  t: Translate;
  onSave: (lines: ExteriorLine[]) => void;
}) {
  // Each draft line carries its own id so React keys survive a removal —
  // the inputs are uncontrolled (defaultValue), and a key that shifted with
  // the index would leave the third line showing the second line's text.
  const nextIdRef = useRef(0);
  const toRows = (lines: ExteriorLine[]): DraftRow[] =>
    lines.map((line) => ({ id: nextIdRef.current++, line }));
  const [rows, setRows] = useState<DraftRow[]>(() => toRows(serverLines));
  const editedRef = useRef(false);
  const serverKey = JSON.stringify(serverLines);
  const seenRef = useRef(serverKey);

  useEffect(() => {
    if (editedRef.current || seenRef.current === serverKey) return;
    seenRef.current = serverKey;
    setRows(toRows(serverLines));
    // toRows and serverLines are both derived from serverKey; listing the
    // string is what makes this run once per distinct server list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const persist = (next: DraftRow[]) => {
    editedRef.current = true;
    setRows(next);
    onSave(next.map((r) => r.line).filter((l) => !isBlankExteriorLine(l)));
  };
  const update = (id: number, patch: Partial<ExteriorLine>) => {
    persist(rows.map((r) => (r.id === id ? { ...r, line: { ...r.line, ...patch } } : r)));
  };
  const remove = (id: number) => {
    persist(rows.filter((r) => r.id !== id));
  };
  const add = () => {
    if (rows.length >= MAX_EXTERIOR_LINES) return;
    // Adding an empty line changes nothing on the server; no save until the
    // foreman fills something in.
    editedRef.current = true;
    setRows([...rows, { id: nextIdRef.current++, line: { ...EMPTY_EXTERIOR_LINE } }]);
  };

  return (
    <div className="build-facts-lines">
      <h3 style={{ margin: "12px 0 2px" }}>{t("buildFacts.lines.title")}</h3>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        {t("buildFacts.lines.intro")}
      </p>
      {rows.length === 0 && (
        <p className="muted" style={{ margin: "0 0 8px" }}>
          {t("buildFacts.lines.empty")}
        </p>
      )}
      {rows.map(({ id, line }, i) => (
        <div className="build-facts-line" key={id}>
          <Select
            keyBase={`line-${id}-finish`}
            label={t("buildFacts.field.exteriorFinish")}
            value={line.exterior_finish ?? ""}
            options={EXTERIOR_FINISHES}
            optionKeys={EXTERIOR_FINISH_KEYS}
            t={t}
            onCommit={(v) => update(id, { exterior_finish: v === "" ? null : (v as ExteriorFinish) })}
          />
          <Select
            keyBase={`line-${id}-depth`}
            label={t("buildFacts.field.setDepth")}
            value={line.set_depth ?? ""}
            options={SET_DEPTHS}
            optionKeys={SET_DEPTH_KEYS}
            t={t}
            onCommit={(v) => update(id, { set_depth: v === "" ? null : (v as SetDepth) })}
          />
          <NumberField
            keyBase={`line-${id}-inches`}
            label={t("buildFacts.field.setDepthInches")}
            value={line.set_depth_inches}
            onCommit={(raw) => {
              const value = raw.trim();
              const n = Number(value);
              update(id, { set_depth_inches: value === "" || !Number.isFinite(n) ? null : n });
            }}
          />
          <TextField
            keyBase={`line-${id}-note`}
            label={t("buildFacts.field.exteriorNote")}
            value={line.exterior_note ?? ""}
            onCommit={(v) => update(id, { exterior_note: v.trim() === "" ? null : v.trim() })}
          />
          <button
            type="button"
            className="link build-facts-line-remove"
            onClick={() => remove(id)}
            aria-label={t("buildFacts.lines.removeLabel", { n: i + 1 })}
          >
            {t("buildFacts.lines.remove")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="action-btn build-facts-line-add"
        onClick={add}
        disabled={rows.length >= MAX_EXTERIOR_LINES}
      >
        {t("buildFacts.lines.add")}
      </button>
    </div>
  );
}

function GreenLightChecklist({
  items,
  loading,
  t,
}: {
  items: GreenLightItem[];
  loading: boolean;
  t: Translate;
}) {
  if (loading || items.length === 0) return null;
  // Open ones first — the server already returns a fixed order, so this is
  // the same sort listGreenLightItems applied, kept local in case a caller
  // ever bypasses that helper.
  const ordered = [...items].sort((a, b) => Number(a.answered) - Number(b.answered));

  return (
    <div className="green-light-checklist">
      <h3 style={{ margin: "12px 0 2px" }}>{t("buildFacts.checklist.title")}</h3>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        {t("buildFacts.checklist.intro")}
      </p>
      <ul className="green-light-list">
        {ordered.map((item) => (
          <li
            key={item.item_key}
            className={`green-light-row ${item.answered ? "is-answered" : "is-open"}`}
          >
            <span className="green-light-mark" aria-hidden="true">
              {item.answered ? "✓" : "○"}
            </span>
            <span className="green-light-text">
              <span className="green-light-label">{item.label_en}</span>
              <span className="green-light-who">
                {t("buildFacts.checklist.who", { who: t(WHO_KEYS[item.who]) })}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fieldLabelId(keyBase: string): string {
  return `build-facts-${keyBase}`;
}

function TextField({
  keyBase,
  label,
  value,
  onCommit,
}: {
  keyBase: string;
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const id = fieldLabelId(keyBase);
  return (
    <div className="build-facts-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        key={keyBase}
        type="text"
        defaultValue={value}
        onBlur={(e) => {
          if (e.target.value.trim() !== value) onCommit(e.target.value);
        }}
      />
    </div>
  );
}

function TextArea({
  keyBase,
  label,
  value,
  onCommit,
}: {
  keyBase: string;
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const id = fieldLabelId(keyBase);
  return (
    <div className="build-facts-field build-facts-field--wide">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        key={keyBase}
        rows={2}
        defaultValue={value}
        onBlur={(e) => {
          if (e.target.value.trim() !== value) onCommit(e.target.value);
        }}
      />
    </div>
  );
}

function NumberField({
  keyBase,
  label,
  value,
  onCommit,
}: {
  keyBase: string;
  label: string;
  value: number | null;
  onCommit: (v: string) => void;
}) {
  const id = fieldLabelId(keyBase);
  const startValue = value != null ? String(value) : "";
  return (
    <div className="build-facts-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        key={keyBase}
        type="number"
        inputMode="decimal"
        step="0.01"
        defaultValue={startValue}
        onBlur={(e) => {
          if (e.target.value.trim() !== startValue) onCommit(e.target.value);
        }}
      />
    </div>
  );
}

function Select<Value extends string>({
  keyBase,
  label,
  value,
  options,
  optionKeys,
  t,
  onCommit,
}: {
  keyBase: string;
  label: string;
  value: string;
  options: readonly Value[];
  optionKeys: Record<Value, TKey>;
  t: (key: TKey) => string;
  onCommit: (v: string) => void;
}) {
  const id = fieldLabelId(keyBase);
  return (
    <div className="build-facts-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        key={keyBase}
        defaultValue={value}
        onChange={(e) => onCommit(e.target.value)}
      >
        <option value="" />
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {t(optionKeys[opt])}
          </option>
        ))}
      </select>
    </div>
  );
}
