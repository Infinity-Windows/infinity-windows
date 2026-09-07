// The Job facts card on a job's Overview (S4, .scratch/installer-os): the
// build answers a foreman records once so nobody on the crew has to ask
// twice — exterior finish, set depth, flashing, fasteners, sill pan, site
// rules, the GC's contact, and a note per elevation.
//
// Foreman+ only here. An installer's read-only view lives on the unit sheet
// instead (S5) — this card is where the answers get WRITTEN, and writing is
// foreman+ both here and on the server (upsert_build_facts).
//
// Every field saves on its own, on blur (text/number) or change (select),
// through the offline outbox — a foreman standing at the site fills these in
// with whatever signal the job has. Supervisor+ additionally sees the six
// green-light items above the fields, open ones first, each naming who is
// expected to answer it (S4, warn-never-block).
//
// Degrades rather than crashes on a database ahead of the migration:
// getBuildFacts/listGreenLightItems both answer empty instead of throwing, so
// the card still renders — just with nothing recorded yet.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EXTERIOR_FINISHES,
  EXTERIOR_FINISH_KEYS,
  FASTENER_TYPES,
  FASTENER_TYPE_KEYS,
  FLASHING_SYSTEMS,
  FLASHING_SYSTEM_KEYS,
  SET_DEPTHS,
  SET_DEPTH_KEYS,
  SILL_PAN_REQUIREMENTS,
  SILL_PAN_KEYS,
  SILL_PAN_TYPES,
  SILL_PAN_TYPE_KEYS,
  WHO_KEYS,
  buildFactsKey,
  getBuildFacts,
  greenLightItemsKey,
  listGreenLightItems,
  saveBuildFact,
  type BuildFactsField,
  type BuildFactsPatch,
  type GreenLightItem,
} from "../../lib/install/buildFacts";
import { useT } from "../../lib/i18n";
import type { TKey } from "../../lib/i18n/catalog";
import { pushToast, toastError } from "../../lib/toast";

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

  if (!isLead) return null;

  const f = facts.data;
  // Remounts every text input when the stored row actually changes (a seed
  // from the GC handshake, another tab's save) without fighting the field
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
        {t("buildFacts.intro")}
      </p>

      {isSupervisorPlus && (
        <GreenLightChecklist items={checklist.data ?? []} loading={checklist.isLoading} t={t} />
      )}

      <div className="build-facts-grid">
        <Select
          keyBase={`ext-${revision}`}
          label={t("buildFacts.field.exteriorFinish")}
          value={f?.exterior_finish ?? ""}
          options={EXTERIOR_FINISHES}
          optionKeys={EXTERIOR_FINISH_KEYS}
          t={t}
          onCommit={(v) => commit("exterior_finish", v)}
        />
        <TextField
          keyBase={`ext-note-${revision}`}
          label={t("buildFacts.field.exteriorNote")}
          value={f?.exterior_note ?? ""}
          onCommit={(v) => commit("exterior_note", v)}
        />

        <Select
          keyBase={`depth-${revision}`}
          label={t("buildFacts.field.setDepth")}
          value={f?.set_depth ?? ""}
          options={SET_DEPTHS}
          optionKeys={SET_DEPTH_KEYS}
          t={t}
          onCommit={(v) => commit("set_depth", v)}
        />
        <NumberField
          keyBase={`depth-in-${revision}`}
          label={t("buildFacts.field.setDepthInches")}
          value={f?.set_depth_inches ?? null}
          onCommit={(v) => commitNumber("set_depth_inches", v)}
        />

        <Select
          keyBase={`flash-${revision}`}
          label={t("buildFacts.field.flashingSystem")}
          value={f?.flashing_system ?? ""}
          options={FLASHING_SYSTEMS}
          optionKeys={FLASHING_SYSTEM_KEYS}
          t={t}
          onCommit={(v) => commit("flashing_system", v)}
        />
        <TextField
          keyBase={`flash-note-${revision}`}
          label={t("buildFacts.field.flashingNote")}
          value={f?.flashing_note ?? ""}
          onCommit={(v) => commit("flashing_note", v)}
        />

        <Select
          keyBase={`fast-${revision}`}
          label={t("buildFacts.field.fastenerType")}
          value={f?.fastener_type ?? ""}
          options={FASTENER_TYPES}
          optionKeys={FASTENER_TYPE_KEYS}
          t={t}
          onCommit={(v) => commit("fastener_type", v)}
        />
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

        <Select
          keyBase={`sill-${revision}`}
          label={t("buildFacts.field.sillPan")}
          value={f?.sill_pan ?? ""}
          options={SILL_PAN_REQUIREMENTS}
          optionKeys={SILL_PAN_KEYS}
          t={t}
          onCommit={(v) => commit("sill_pan", v)}
        />
        <Select
          keyBase={`sill-type-${revision}`}
          label={t("buildFacts.field.sillPanType")}
          value={f?.sill_pan_type ?? ""}
          options={SILL_PAN_TYPES}
          optionKeys={SILL_PAN_TYPE_KEYS}
          t={t}
          onCommit={(v) => commit("sill_pan_type", v)}
        />

        <TextField
          keyBase={`gc-name-${revision}`}
          label={t("buildFacts.field.gcContactName")}
          value={f?.gc_contact_name ?? ""}
          onCommit={(v) => commit("gc_contact_name", v)}
        />
        <TextField
          keyBase={`gc-phone-${revision}`}
          label={t("buildFacts.field.gcContactPhone")}
          value={f?.gc_contact_phone ?? ""}
          onCommit={(v) => commit("gc_contact_phone", v)}
        />

        <TextArea
          keyBase={`rules-${revision}`}
          label={t("buildFacts.field.siteRules")}
          value={f?.site_rules ?? ""}
          onCommit={(v) => commit("site_rules", v)}
        />

        <TextArea
          keyBase={`n-${revision}`}
          label={t("buildFacts.field.noteNorth")}
          value={f?.note_north ?? ""}
          onCommit={(v) => commit("note_north", v)}
        />
        <TextArea
          keyBase={`s-${revision}`}
          label={t("buildFacts.field.noteSouth")}
          value={f?.note_south ?? ""}
          onCommit={(v) => commit("note_south", v)}
        />
        <TextArea
          keyBase={`e-${revision}`}
          label={t("buildFacts.field.noteEast")}
          value={f?.note_east ?? ""}
          onCommit={(v) => commit("note_east", v)}
        />
        <TextArea
          keyBase={`w-${revision}`}
          label={t("buildFacts.field.noteWest")}
          value={f?.note_west ?? ""}
          onCommit={(v) => commit("note_west", v)}
        />
      </div>
    </section>
  );
}

function GreenLightChecklist({
  items,
  loading,
  t,
}: {
  items: GreenLightItem[];
  loading: boolean;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
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
