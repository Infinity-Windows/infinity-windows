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
  configFromTiers,
  MECHANISM_LABELS,
  saveStudioUnit,
  unitTiers,
  updateStudioUnit,
  unitSvg,
  unitWidthMm,
  type Mechanism,
  type StudioUnit,
  type UnitConfig,
  type UnitKind,
  type UnitPanel,
  type UnitTier,
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

/**
 * One TIER's bench state (Studio 100x #22 — "+ Tier above"). Mirrors the
 * single flat state this wizard always had (panels/heightInput/cornerAfter/
 * panelInputs/widthInput), one copy per tier, plus `story` and
 * `originalHeightMm` (the height this tier had when the wizard opened —
 * null for one added fresh this session, same "no explicit height yet"
 * meaning tier 0 always had via the `initial` prop).
 */
interface TierDraft {
  panels: UnitPanel[];
  heightInput: string;
  originalHeightMm: number | null;
  cornerAfter: number | null;
  panelInputs: Record<number, string>;
  widthInput: string;
  story: number;
}

function tierDraftFrom(tier: UnitTier): TierDraft {
  return {
    panels: tier.panels.map((p) => ({ ...p })),
    heightInput: "",
    originalHeightMm: tier.heightMm,
    cornerAfter: tier.cornerAfterPanel ?? null,
    panelInputs: {},
    widthInput: "",
    story: tier.story ?? 1,
  };
}

function blankTierDraft(kind: UnitKind, story: number): TierDraft {
  return {
    panels: [defaultPanel(kind)],
    heightInput: "",
    originalHeightMm: null,
    cornerAfter: null,
    panelInputs: {},
    widthInput: "",
    story,
  };
}

/**
 * A tier's effective height: typed draft wins, else its ORIGINAL authored
 * height when editing, else the same kind-based default tier 0 always
 * fell back to — reactive to `kind`, so switching Window/Door still
 * updates a blank height box live, exactly like before tiers existed.
 */
function tierHeightMm(draft: TierDraft, kind: UnitKind): number {
  const cm = draft.heightInput ? parseFtIn(draft.heightInput) : null;
  if (cm != null) return cm * 10;
  if (draft.originalHeightMm != null) return draft.originalHeightMm;
  return kind === "door" ? 2032 : 1524; // 6'8" / 5'
}

function cornerAfterPanelOf(draft: TierDraft): number | null {
  return draft.cornerAfter != null && draft.cornerAfter < draft.panels.length - 1
    ? draft.cornerAfter
    : null;
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
  /** One entry per tier, base (story 1) first — Studio 100x #22. A
   * single-tier unit (almost every unit) never grows past one entry, so
   * every step below reads/writes `tiers[activeTier]` and behaves
   * exactly as the old single-state wizard always did. */
  const [tiers, setTiers] = useState<TierDraft[]>(() =>
    initial
      ? unitTiers(initial.config).map(tierDraftFrom)
      : [blankTierDraft("window", 1)],
  );
  const [activeTier, setActiveTier] = useState(0);
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
  /** #47: absent and "white" are the same choice — see UnitConfig.frameColor. */
  const [frameColor, setFrameColor] = useState<NonNullable<UnitConfig["frameColor"]>>(
    initial?.config.frameColor ?? "white",
  );

  const activeDraft = tiers[activeTier] ?? tiers[0];
  const panels = activeDraft.panels;
  const cornerAfter = activeDraft.cornerAfter;
  const heightInput = activeDraft.heightInput;
  const widthInput = activeDraft.widthInput;
  const panelInputs = activeDraft.panelInputs;

  // Tier-scoped setters — same "value or updater" shape useState's own
  // setter has, so every existing call site below (setPanelCount,
  // patchPanel, applyTotalWidth…) needs no changes at all, only now
  // writes into the ACTIVE tier instead of one flat piece of state.
  const setPanels = (next: UnitPanel[] | ((prev: UnitPanel[]) => UnitPanel[])) => {
    setTiers((prev) =>
      prev.map((t, i) =>
        i === activeTier ? { ...t, panels: typeof next === "function" ? next(t.panels) : next } : t,
      ),
    );
  };
  const setCornerAfter = (
    next: number | null | ((prev: number | null) => number | null),
  ) => {
    setTiers((prev) =>
      prev.map((t, i) =>
        i === activeTier
          ? {
              ...t,
              cornerAfter:
                typeof next === "function"
                  ? (next as (p: number | null) => number | null)(t.cornerAfter)
                  : next,
            }
          : t,
      ),
    );
  };
  const setHeightInput = (v: string) =>
    setTiers((prev) => prev.map((t, i) => (i === activeTier ? { ...t, heightInput: v } : t)));
  const setWidthInput = (v: string) =>
    setTiers((prev) => prev.map((t, i) => (i === activeTier ? { ...t, widthInput: v } : t)));
  const setPanelInputs = (
    next: Record<number, string> | ((prev: Record<number, string>) => Record<number, string>),
  ) => {
    setTiers((prev) =>
      prev.map((t, i) =>
        i === activeTier
          ? { ...t, panelInputs: typeof next === "function" ? next(t.panelInputs) : next }
          : t,
      ),
    );
  };

  /** "+ Tier above" (Studio 100x #22) — visible always, most units never
   * touch it. Appends a fresh tier one floor above the last one and
   * switches editing to it, jumping straight to the Panels step since
   * Type doesn't apply per-tier. */
  const addTierAbove = () => {
    const story = (tiers[tiers.length - 1]?.story ?? 0) + 1;
    setTiers((prev) => [...prev, blankTierDraft(kind, story)]);
    setActiveTier(tiers.length);
    setStep(2);
  };

  /** The base tier (index 0) can't be removed — a unit always has at
   * least one tier. Falls back to editing the tier below the one removed. */
  const removeTier = (index: number) => {
    if (index === 0 || tiers.length <= 1) return;
    setTiers((prev) => prev.filter((_, i) => i !== index));
    setActiveTier((prev) => (prev === index ? index - 1 : prev > index ? prev - 1 : prev));
  };

  const heightMm = tierHeightMm(activeDraft, kind);

  const weightLb = useMemo(() => {
    const n = Number(weightInput);
    return weightInput.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
  }, [weightInput]);

  /** The WHOLE unit, every tier — what gets saved/inserted and what the
   * live cohort estimate below is computed from. */
  const config: UnitConfig = useMemo(
    () =>
      configFromTiers(
        { kind, insetOutset, weightLb, frameColor },
        tiers.map((t) => ({
          panels: t.panels,
          heightMm: tierHeightMm(t, kind),
          cornerAfterPanel: cornerAfterPanelOf(t),
          story: t.story,
        })),
      ),
    [kind, tiers, insetOutset, weightLb, frameColor],
  );

  /** Just the tier being edited right now, as a plain flat UnitConfig —
   * what the live elevation drawing and the Dimensions step's width math
   * both read, so they always show what's actually on screen instead of
   * silently describing the base tier while a different one is active. */
  const previewConfig: UnitConfig = useMemo(
    () => ({
      kind,
      heightMm,
      panels,
      cornerAfterPanel: cornerAfterPanelOf(activeDraft),
      insetOutset,
      weightLb,
      frameColor,
    }),
    [kind, heightMm, panels, activeDraft, insetOutset, weightLb, frameColor],
  );

  const totalPanels = tiers.reduce((sum, t) => sum + t.panels.length, 0);
  /** Tier 0's own height — NEVER the active tier's, and never the total
   * stacked height. Sill/height placement in the 3D scene anchors to the
   * base tier alone (unitGeometry.ts's buildTier); onInsert below must
   * match that, whichever tier happens to be active while the operator
   * hits Insert. */
  const baseHeightMm = tierHeightMm(tiers[0], kind);

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

  /** Total width typed → split across panels proportionally, for the
   * ACTIVE tier — previewConfig, never the whole multi-tier `config`. */
  const applyTotalWidth = () => {
    const cm = widthInput ? parseFtIn(widthInput) : null;
    if (cm == null) return;
    const targetMm = cm * 10;
    const cur = unitWidthMm(previewConfig) || 1;
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

        {/* "+ Tier above" (Studio 100x #22) — visible on every step, not
            its own step: most units are one tier and never touch this row
            beyond glancing past it. Editing stays scoped to whichever
            tier chip is active; the flow above is otherwise untouched. */}
        <div className="row-gap" style={{ flexWrap: "wrap", margin: "6px 0" }}>
          {tiers.map((t, i) => (
            <span key={i} className="row-gap" style={{ gap: 2 }}>
              <button
                className={i === activeTier ? "button-like active-pill studio-mini" : "button-like studio-mini"}
                onClick={() => setActiveTier(i)}
              >
                Tier {i + 1} · Story {t.story}
              </button>
              {i > 0 && (
                <button
                  className="button-like studio-mini"
                  aria-label={`Remove tier ${i + 1}`}
                  title={`Remove tier ${i + 1}`}
                  onClick={() => removeTier(i)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <button className="button-like studio-mini" onClick={addTierAbove}>
            + Tier above
          </button>
        </div>

        {/* Live elevation drawing — the tier being edited right now, not
            necessarily the whole (possibly multi-tier) unit. */}
        <div
          className="studio-unit-preview"
          // The SVG is generated locally from typed config — never user HTML.
          dangerouslySetInnerHTML={{ __html: unitSvg(previewConfig, 280, 150) }}
        />
        <p className="muted" style={{ margin: "2px 0 8px", fontSize: 11.5, textAlign: "center" }}>
          {fmtFtIn(unitWidthMm(previewConfig) * MM_TO_CM)} wide × {fmtFtIn(heightMm * MM_TO_CM)} tall ·{" "}
          {panels.length} panel{panels.length === 1 ? "" : "s"}
          {tiers.length > 1 ? ` · tier ${activeTier + 1} of ${tiers.length}` : ""}
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
                  // Kind is unit-wide — a door-only mechanism (bifold) or
                  // window-only one (hung) left on some OTHER tier would
                  // be invalid the moment kind flips, so every tier
                  // resets, not just the active one.
                  setTiers((prev) =>
                    prev.map((t) => ({
                      ...t,
                      panels: t.panels.map((p) => ({ ...p, mechanism: "fixed" as Mechanism })),
                    })),
                  );
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
                placeholder={fmtFtIn(unitWidthMm(previewConfig) * MM_TO_CM)}
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
                  Total {fmtInchesFromMm(unitWidthMm(previewConfig))} ·{" "}
                  {fmtFtIn(unitWidthMm(previewConfig) * MM_TO_CM)} — the
                  total-width box above rescales all panels together.
                </p>
              </>
            )}
          </div>
        )}

        {stepName === "Finish" && (
          <div>
            <label className="field-label">Name (for the catalog)</label>
            <input
              placeholder={`${totalPanels}-panel ${kind}`}
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

            <label className="field-label">Frame color</label>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {(
                [
                  ["white", "White"],
                  ["bronze", "Bronze"],
                  ["black", "Black"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={frameColor === v ? "button-like active-pill" : "button-like"}
                  onClick={() => setFrameColor(v)}
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
                    name.trim() || `${totalPanels}-panel ${kind}`,
                    unitWidthMm(config) * MM_TO_CM,
                    // Base tier's height, not the active tier's and not
                    // the total stacked height — see baseHeightMm above.
                    baseHeightMm * MM_TO_CM,
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
