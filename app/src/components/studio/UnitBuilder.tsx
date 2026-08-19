// The unit builder (owner's spec, 2026-08-13): build a window or door the
// way you'd order it — kind, panel count, per-panel mechanism, which panels
// move and which way, exact dimensions — with a live trade-symbol elevation
// drawing at every step. Save it to the company catalog and/or insert it
// straight into the plan. Corner (two-wall) units come in the next slice.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { useUnitCohortEstimate } from "../../lib/estimate/liveEstimate";
import { fmtFtIn, fmtInchesFromMm, parseFtIn } from "../../lib/modelstudio/dims";
import {
  MECHANISM_LABELS,
  saveStudioUnit,
  updateStudioUnit,
  unitSvg,
  unitWidthMm,
  type Mechanism,
  type StudioUnit,
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
  initial,
}: {
  /** Insert the finished unit into the plan (config in cm width/height). */
  onInsert: (config: UnitConfig, name: string, widthCm: number, heightCm: number) => void;
  onClose: () => void;
  /** Editing an existing catalog unit — how a spec import ("Window 16",
   * one fixed panel: the spec row only has overall dims) gets split into
   * the drawing's real panels. Save rewrites the row instead of adding. */
  initial?: StudioUnit | null;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<UnitKind>(initial?.config.kind ?? "window");
  const [panels, setPanels] = useState<UnitPanel[]>(
    initial ? initial.config.panels.map((p) => ({ ...p })) : [defaultPanel("window")],
  );
  const [heightInput, setHeightInput] = useState("");
  const [widthInput, setWidthInput] = useState("");
  const [panelInputs, setPanelInputs] = useState<Record<number, string>>({});
  /** 0-based last panel before the 90° turn, or null for a flat unit —
   * window 16 wraps its building corner after panel 1 (index 0). */
  const [cornerAfter, setCornerAfter] = useState<number | null>(
    initial?.config.cornerAfterPanel ?? null,
  );
  const [name, setName] = useState(initial?.name ?? "");
  /** #23: null default ("not sure") — a SET value is what adds this unit
   * to the inset/outset dimension; absent/null reproduces today's
   * signature exactly (see UnitConfig.insetOutset). */
  const [insetOutset, setInsetOutset] = useState<"inset" | "outset" | null>(
    initial?.config.insetOutset ?? null,
  );
  /** #25: stored, never signed — see UnitConfig.weightLb. */
  const [weightInput, setWeightInput] = useState(
    initial?.config.weightLb != null ? String(initial.config.weightLb) : "",
  );

  const heightMm = useMemo(() => {
    const cm = heightInput ? parseFtIn(heightInput) : null;
    if (cm != null) return cm * 10;
    if (initial) return initial.config.heightMm;
    return kind === "door" ? 2032 : 1524; // 6'8" / 5'
  }, [heightInput, kind, initial]);

  const weightLb = useMemo(() => {
    const n = Number(weightInput);
    return weightInput.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
  }, [weightInput]);

  const config: UnitConfig = useMemo(
    () => ({
      kind,
      heightMm,
      panels,
      cornerAfterPanel:
        cornerAfter != null && cornerAfter < panels.length - 1 ? cornerAfter : null,
      insetOutset,
      weightLb,
    }),
    [kind, heightMm, panels, cornerAfter, insetOutset, weightLb],
  );

  // #21: the same evidence + fallback ladder the foreman's estimating
  // screen uses, for whatever's on the bench right now.
  const estimate = useUnitCohortEstimate(config);

  const setPanelCount = (n: number) => {
    setPanels((prev) => {
      const next = [...prev];
      while (next.length < n) next.push(defaultPanel(kind));
      return next.slice(0, n);
    });
    setCornerAfter((prev) => (prev != null && prev < n - 1 ? prev : null));
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
    mutationFn: () =>
      initial
        ? updateStudioUnit(initial.id, name.trim(), config)
        : saveStudioUnit(name.trim(), config),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["studioUnits"] }),
  });

  const mechanisms = kind === "door" ? DOOR_MECHANISMS : WINDOW_MECHANISMS;
  const anyMoving = panels.some((p) => p.mechanism === "slider" || p.mechanism === "bifold");
  const steps = [
    "Type",
    "Panels",
    "Mechanisms",
    anyMoving ? "Directions" : null,
    panels.length >= 2 ? "Corner" : null,
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
          <p style={{ margin: 0, fontWeight: 700 }}>
            {initial ? `Edit ${initial.name}` : "Build a unit"}
          </p>
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
        {/* #21: live cohort line — same evidence + ladder as the
            estimating screen, label always attached, "no estimate yet"
            when the data's too thin (never a computed number dressed
            as one). */}
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 11.5, textAlign: "center" }}>
          {estimate.minutes != null ? (
            <>
              <strong>{estimate.minutes}m</strong> · {estimate.label}
            </>
          ) : (
            estimate.label
          )}
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

        {stepName === "Corner" && (
          <div>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
              Does this unit turn a building corner at 90°? Window 16 does —
              its first panel wraps onto the next wall. Reading the drawing
              left to right (always the outside view), pick where it turns.
            </p>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              <button
                className={cornerAfter == null ? "button-like active-pill" : "button-like"}
                onClick={() => setCornerAfter(null)}
              >
                No corner
              </button>
              {panels.slice(0, -1).map((_, i) => (
                <button
                  key={i}
                  className={cornerAfter === i ? "button-like active-pill" : "button-like"}
                  onClick={() => setCornerAfter(i)}
                >
                  ⌐ after panel {i + 1}
                </button>
              ))}
            </div>
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
            {panels.length > 1 && (
              <>
                <label className="field-label">
                  Panel widths — type them straight off the drawing (30 1/4",
                  88 1/2"…)
                </label>
                <div className="studio-panel-grid">
                  {panels.map((p, i) => (
                    <div key={i} className="row-gap" style={{ alignItems: "center" }}>
                      <span className="tcx-label" style={{ minWidth: 54 }}>
                        Panel {i + 1}
                      </span>
                      <input
                        style={{ flex: 1, minWidth: 0 }}
                        placeholder={fmtInchesFromMm(p.widthMm)}
                        value={panelInputs[i] ?? ""}
                        onChange={(e) =>
                          setPanelInputs((prev) => ({ ...prev, [i]: e.target.value }))
                        }
                        onBlur={() => {
                          const cm = panelInputs[i] ? parseFtIn(panelInputs[i]) : null;
                          if (cm != null && cm * 10 >= 50) {
                            patchPanel(i, { widthMm: cm * 10 });
                          }
                        }}
                      />
                    </div>
                  ))}
                </div>
                <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>
                  Total {fmtInchesFromMm(unitWidthMm(config))} ·{" "}
                  {fmtFtIn(unitWidthMm(config) * MM_TO_CM)} — the total-width
                  box above rescales all panels together.
                </p>
              </>
            )}
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

            <label className="field-label">
              Inset or outset — a signature field, same as the specs
            </label>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {(
                [
                  ["inset", "Inset"],
                  ["outset", "Outset"],
                  [null, "Not sure"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={label}
                  className={insetOutset === v ? "button-like active-pill" : "button-like"}
                  onClick={() => setInsetOutset(v)}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="field-label">
              Weight (lb, from the Strata paperwork) — optional
            </label>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="e.g. 180"
              value={weightInput}
              onChange={(e) => setWeightInput(e.target.value)}
            />

            {save.isError && <p className="error">{formatApiError(save.error)}</p>}
            {save.isSuccess && <p className="ok" style={{ fontSize: 12 }}>Saved to the catalog ✓</p>}
            <div className="row-gap" style={{ marginTop: 8, flexWrap: "wrap" }}>
              <button
                className="button-like"
                disabled={!name.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending
                  ? "Saving…"
                  : initial
                    ? "Save changes"
                    : "Save to catalog"}
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
