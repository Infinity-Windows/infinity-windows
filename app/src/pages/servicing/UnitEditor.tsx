import { useState } from "react";
import { VoiceTextarea } from "../../components/voice/VoiceTextarea";
import { useServiceText } from "../../lib/servicing/text";
import { CAUSES, type ServiceUnit } from "../../lib/servicing/model";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ProjectOpening } from "../../lib/install/types";
export function ServiceUnitEditor({
  unit,
  saved,
  openings,
  onSave,
  onCancel,
  busy,
}: {
  unit: ServiceUnit;
  saved: WorkUnit[];
  openings: ProjectOpening[];
  onSave: (u: ServiceUnit, start: boolean) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const tx = useServiceText();
  const [value, setValue] = useState(unit);
  const change = <K extends keyof ServiceUnit>(key: K, data: ServiceUnit[K]) =>
    setValue((v) => ({ ...v, [key]: data }));
  function source(id: string) {
    const work = saved.find((x) => x.id === id),
      opening = openings.find((x) => x.id === id);
    if (work)
      setValue((v) => ({
        ...v,
        work_unit_id: work.id,
        opening_id: work.opening_id,
        label: work.label,
        type_label: work.type_label,
        facts: { ...work.facts },
      }));
    else if (opening)
      setValue((v) => ({
        ...v,
        work_unit_id: null,
        opening_id: opening.id,
        label: opening.opening_code,
        type_label: opening.window_types?.name ?? "",
        facts: {
          location: opening.label ?? "",
          ...(opening.window_types?.width_in
            ? { width_in: opening.window_types.width_in }
            : {}),
          ...(opening.window_types?.height_in
            ? { height_in: opening.window_types.height_in }
            : {}),
        },
      }));
    else setValue((v) => ({ ...v, work_unit_id: null, opening_id: null }));
  }
  const input = (key: "label" | "type_label", label: string) => (
    <label>
      {label}
      <input
        value={value[key]}
        maxLength={key === "label" ? 120 : 100}
        onChange={(e) => change(key, e.target.value)}
        required
      />
    </label>
  );
  return (
    <section className="sv-card sv-editor" aria-label={tx("edit")}>
      <div className="sv-row">
        <h2>{tx(unit.revision ? "edit" : "addUnit")}</h2>
        <button onClick={onCancel}>{tx("cancel")}</button>
      </div>
      {!unit.revision && (
        <label>
          {tx("chooseUnit")}
          <select
            value={value.work_unit_id ?? value.opening_id ?? ""}
            onChange={(e) => source(e.target.value)}
          >
            <option value="">{tx("custom")}</option>
            {saved.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label} · {u.type_label}
              </option>
            ))}
            {openings
              .filter((o) => !saved.some((u) => u.opening_id === o.id))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.opening_code} · {o.window_types?.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <div className="sv-fields">
        {input("label", tx("unitLabel"))}
        {input("type_label", tx("type"))}
        <label>
          {tx("material")}
          <select
            value={value.facts.material ?? ""}
            onChange={(e) =>
              change("facts", { ...value.facts, material: e.target.value })
            }
          >
            <option value="">{tx("unknown")}</option>
            <option value="Vinyl">{tx("vinyl")}</option>
            <option value="Aluminum">{tx("aluminum")}</option>
            <option value="Other">{tx("other")}</option>
          </select>
        </label>
        {(["story", "location"] as const).map((key) => (
          <label key={key}>
            {tx(key)}
            <input
              value={value.facts[key] ?? ""}
              onChange={(e) =>
                change("facts", { ...value.facts, [key]: e.target.value })
              }
            />
          </label>
        ))}
        {(["width_in", "height_in"] as const).map((key, i) => (
          <label key={key}>
            {tx(i ? "height" : "width")}
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              step="any"
              value={value.facts[key] ?? ""}
              onChange={(e) => {
                const facts = { ...value.facts };
                if (e.target.value === "") delete facts[key];
                else facts[key] = Number(e.target.value);
                change("facts", facts);
              }}
            />
          </label>
        ))}
      </div>
      <label>
        {tx("issue")}
        <VoiceTextarea
          value={value.issue}
          onChange={(e) => change("issue", e.target.value)}
          rows={3}
          maxLength={4000}
        />
      </label>
      <details open={unit.revision > 0}>
        <summary>{tx("memo")}</summary>
        <div className="sv-fields">
          <label>
            {tx("failPoint")}
            <input
              value={value.fail_point}
              onChange={(e) => change("fail_point", e.target.value)}
              list="service-fail-points"
              maxLength={200}
            />
            <datalist id="service-fail-points">
              {[
                "Glass",
                "Frame",
                "Flashing / seal",
                "Hardware / operation",
                "Electrical",
                "Damage",
                "Other",
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </datalist>
          </label>
          <label>
            {tx("cause")}
            <select
              value={value.cause}
              onChange={(e) =>
                change("cause", e.target.value as ServiceUnit["cause"])
              }
            >
              {CAUSES.map((c) => (
                <option key={c} value={c}>
                  {tx(c)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(
          [
            "repair",
            "verification",
            "prevention",
            "next_steps",
            "memo_text",
            "evidence_exception",
          ] as const
        ).map((key) => (
          <label key={key}>
            {tx(
              (
                {
                  next_steps: "nextSteps",
                  memo_text: "transcript",
                  evidence_exception: "evidenceException",
                } as const
              )[key as "next_steps"] ?? (key as "repair"),
            )}
            <VoiceTextarea
              value={value[key]}
              onChange={(e) => change(key, e.target.value)}
              rows={key === "memo_text" ? 5 : 3}
              maxLength={
                key === "memo_text"
                  ? 20000
                  : key === "repair"
                    ? 8000
                    : key === "evidence_exception"
                      ? 2000
                      : 4000
              }
            />
          </label>
        ))}
        <label>
          {tx("outcome")}
          <select
            value={value.outcome}
            onChange={(e) =>
              change("outcome", e.target.value as ServiceUnit["outcome"])
            }
          >
            <option value="open">{tx("unresolved")}</option>
            {(["resolved", "temporary", "return_needed"] as const).map((k) => (
              <option key={k} value={k}>
                {tx(k)}
              </option>
            ))}
          </select>
        </label>
      </details>
      <div className="sv-actions">
        <button
          className="primary"
          disabled={
            busy ||
            !value.label.trim() ||
            !value.type_label.trim() ||
            !value.issue.trim()
          }
          onClick={() => onSave(value, false)}
        >
          {tx("save")}
        </button>
        {unit.revision === 0 && (
          <button
            disabled={
              busy ||
              !value.label.trim() ||
              !value.type_label.trim() ||
              !value.issue.trim()
            }
            onClick={() => onSave(value, true)}
          >
            {tx("saveStart")}
          </button>
        )}
      </div>
    </section>
  );
}
