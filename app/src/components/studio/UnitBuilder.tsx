// The unit builder (owner's spec, 2026-08-13): build a window or door the
// way you'd order it — kind, panel count, per-panel mechanism, which panels
// move and which way, exact dimensions — with a live trade-symbol elevation
// drawing at every step. Save it to the company catalog and/or insert it
// straight into the plan. Corner (two-wall) units come in the next slice.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { fmtFtIn, parseFtIn } from "../../pages/install/ModelStudio";
import {
  MECHANISM_LABELS,
  saveStudioUnit,
  unitSvg,
  unitWidthMm,
  type Mechanism,
  type UnitConfig,
  type UnitKind,
  type UnitPanel,
} from "../../lib/modelstudio/units";

const MM_TO_CM = 0.1;

const WINDOW_MECHANISMS: Mechanism[] = ["fixed", "slider", "casement", "hung"];
const DOOR_MECHANISMS: Mechanism[] = ["fixed", "slider", "bifold"];

function defaultPanel(kind: UnitKind): UnitPanel {
  return {
    widthMm: kind === "door" ? 914 : 762, // 36" / 30"
    mechanism: "fixed",
  };
}

export function UnitBuilder({
  onInsert,
  onClose,
}: {
  /** Insert the finished unit into the plan (config in cm width/height). */
  onInsert: (config: UnitConfig, name: string, widthCm: number, heightCm: number) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<UnitKind>("window");
  const [panels, setPanels] = useState<UnitPanel[]>([defaultPanel("window")]);
  const [heightInput, setHeightInput] = useState("");
  const [widthInput, setWidthInput] = useState("");
  const [name, setName] = useState("");

  const heightMm = useMemo(() => {
    const cm = heightInput ? parseFtIn(heightInput) : null;
    return cm != null ? cm * 10 : kind === "door" ? 2032 : 1524; // 6'8" / 5'
  }, [heightInput, kind]);

  const config: UnitConfig = useMemo(
    () => ({ kind, heightMm, panels }),
    [kind, heightMm, panels],
  );

  const setPanelCount = (n: number) => {
    setPanels((prev) => {
      const next = [...prev];
      while (next.length < n) next.push(defaultPanel(kind));
      return next.slice(0, n);
    });
  };

  const patchPanel = (i: number, patch: Partial<UnitPanel>) => {
    setPanels((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  };

  /** Total width typed → split across panels proportionally. */
  const applyTotalWidth = () => {
    const cm = widthInput ? parseFtIn(widthInput) : null;
    if (cm == null) return;
    const targetMm = cm * 10;
    const cur = unitWidthMm(config) || 1;
    setPanels((prev) => prev.map((p) => ({ ...p, widthMm: (p.widthMm / cur) * targetMm })));
  };

  const save = useMutation({
    mutationFn: () => saveStudioUnit(name.trim(), config),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["studioUnits"] }),
  });

  const mechanisms = kind === "door" ? DOOR_MECHANISMS : WINDOW_MECHANISMS;
  const anyMoving = panels.some((p) => p.mechanism === "slider" || p.mechanism === "bifold");
  const steps = [
    "Type",
    "Panels",
    "Mechanisms",
    anyMoving ? "Directions" : null,
    "Dimensions",
    "Finish",
  ].filter(Boolean) as string[];
  const stepName = steps[Math.min(step - 1, steps.length - 1)];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal-card studio-builder"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-gap" style={{ alignItems: "baseline" }}>
          <p style={{ margin: 0, fontWeight: 700 }}>Build a unit</p>
          <span className="muted" style={{ fontSize: 11.5, marginLeft: "auto" }}>
            Step {Math.min(step, steps.length)} of {steps.length} · {stepName}
          </span>
        </div>

        {/* Live elevation drawing — updates through every step. */}
        <div
          className="studio-unit-preview"
          // The SVG is generated locally from typed config — never user HTML.
          dangerouslySetInnerHTML={{ __html: unitSvg(config, 280, 150) }}
        />
        <p className="muted" style={{ margin: "2px 0 8px", fontSize: 11.5, textAlign: "center" }}>
          {fmtFtIn(unitWidthMm(config) * MM_TO_CM)} wide × {fmtFtIn(heightMm * MM_TO_CM)} tall ·{" "}
          {panels.length} panel{panels.length === 1 ? "" : "s"}
        </p>

        {stepName === "Type" && (
          <div className="row-gap">
            {(["window", "door"] as const).map((k) => (
              <button
                key={k}
                className={kind === k ? "button-like active-pill" : "button-like"}
                style={{ flex: 1 }}
                onClick={() => {
                  setKind(k);
                  setPanels((prev) => prev.map((p) => ({ ...p, mechanism: "fixed" as Mechanism })));
                }}
              >
                {k === "window" ? "Window" : "Door"}
              </button>
            ))}
          </div>
        )}

        {stepName === "Panels" && (
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                className={panels.length === n ? "button-like active-pill" : "button-like"}
                onClick={() => setPanelCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {stepName === "Mechanisms" && (
          <div className="studio-panel-grid">
            {panels.map((p, i) => (
              <div key={i} className="studio-card" style={{ padding: "6px 8px" }}>
                <p className="tcx-label" style={{ margin: "0 0 4px" }}>Panel {i + 1}</p>
                <div className="row-gap" style={{ flexWrap: "wrap" }}>
                  {mechanisms.map((m) => (
                    <button
                      key={m}
                      className={p.mechanism === m ? "button-like active-pill studio-mini" : "button-like studio-mini"}
                      onClick={() =>
                        patchPanel(i, {
                          mechanism: m,
                          direction:
                            m === "slider" || m === "bifold" || m === "casement"
                              ? p.direction ?? "left"
                              : undefined,
                        })
                      }
                    >
                      {MECHANISM_LABELS[m]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {stepName === "Directions" && (
          <div className="studio-panel-grid">
            {panels.map((p, i) =>
              p.mechanism === "slider" || p.mechanism === "bifold" || p.mechanism === "casement" ? (
                <div key={i} className="studio-card" style={{ padding: "6px 8px" }}>
                  <p className="tcx-label" style={{ margin: "0 0 4px" }}>
                    Panel {i + 1} · {MECHANISM_LABELS[p.mechanism]}
                  </p>
                  <div className="row-gap">
                    <button
                      className={p.direction === "left" ? "button-like active-pill" : "button-like"}
                      onClick={() => patchPanel(i, { direction: "left" })}
                    >
                      ← Left
                    </button>
                    <button
                      className={p.direction === "right" ? "button-like active-pill" : "button-like"}
                      onClick={() => patchPanel(i, { direction: "right" })}
                    >
                      Right →
                    </button>
                  </div>
                </div>
              ) : null,
            )}
          </div>
        )}

        {stepName === "Dimensions" && (
          <div>
            <label className="field-label">Total width</label>
            <div className="row-gap">
              <input
                style={{ flex: 1, minWidth: 0 }}
                placeholder={fmtFtIn(unitWidthMm(config) * MM_TO_CM)}
                value={widthInput}
                onChange={(e) => setWidthInput(e.target.value)}
                onBlur={applyTotalWidth}
              />
            </div>
            <label className="field-label">Height</label>
            <input
              placeholder={fmtFtIn(heightMm * MM_TO_CM)}
              value={heightInput}
              onChange={(e) => setHeightInput(e.target.value)}
            />
            <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
              Width splits across panels proportionally — per-panel widths get
              fine-tuning in a later slice. 90° corner units are the next slice
              too.
            </p>
          </div>
        )}

        {stepName === "Finish" && (
          <div>
            <label className="field-label">Name (for the catalog)</label>
            <input
              placeholder={`${panels.length}-panel ${kind}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {save.isError && <p className="error">{formatApiError(save.error)}</p>}
            {save.isSuccess && <p className="ok" style={{ fontSize: 12 }}>Saved to the catalog ✓</p>}
            <div className="row-gap" style={{ marginTop: 8, flexWrap: "wrap" }}>
              <button
                className="button-like"
                disabled={!name.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save to catalog"}
              </button>
              <button
                className="button-like active-pill"
                onClick={() => {
                  onInsert(
                    config,
                    name.trim() || `${panels.length}-panel ${kind}`,
                    unitWidthMm(config) * MM_TO_CM,
                    heightMm * MM_TO_CM,
                  );
                  onClose();
                }}
              >
                Insert into plan
              </button>
            </div>
          </div>
        )}

        <div className="row-gap" style={{ marginTop: 12 }}>
          {step > 1 && (
            <button className="button-like" onClick={() => setStep((s) => s - 1)}>
              ‹ Back
            </button>
          )}
          {stepName !== "Finish" && (
            <button
              className="button-like active-pill"
              style={{ marginLeft: "auto" }}
              onClick={() => setStep((s) => s + 1)}
            >
              Next ›
            </button>
          )}
          <button
            className="button-like"
            style={stepName === "Finish" ? { marginLeft: "auto" } : undefined}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
