import { useId, useState } from "react";
import { formatDimensionMm, inchFraction, MM_PER_INCH, readDimensionMm, type DimensionMode } from "../../lib/install/dimensionEntry";
import "./dimensionFields.css";

type Side = "width" | "height";
// Whole inches and a fraction, no feet: the shop drawings and the plans this
// is checked against are dimensioned in inches (109 1/2"), so a feet box only
// made every entry a conversion (Matt, 2026-11-20).
type Imperial = { inches: string; fraction: number };
const sides: readonly Side[] = ["width", "height"];
const whole = (text: string) => text === "" || /^\d+$/.test(text);

function splitImperial(mm: number | null | undefined): Imperial {
  if (mm == null) return { inches: "", fraction: 0 };
  const ticks = Math.round(mm / MM_PER_INCH * 16 + 1e-9);
  return { inches: String(Math.floor(ticks / 16)), fraction: ticks % 16 };
}

export function DimensionFields({ width, height, onChange, onValidChange, labels }: {
  width?: number | null;
  height?: number | null;
  onChange: (side: Side, mm: number | null) => void;
  onValidChange?: (valid: boolean) => void;
  labels?: { legend: string; width: string; height: string; fraction: string; inches?: string };
}) {
  const ids = useId();
  const [mode, setMode] = useState<DimensionMode>("imperial");
  const [metric, setMetric] = useState<Partial<Record<Side, string>>>({});
  const [imperial, setImperial] = useState<Partial<Record<Side, Imperial>>>({});
  const values = { width, height };
  const fields = (side: Side) => imperial[side] ?? splitImperial(values[side]);
  const isInvalid = (side: Side) => mode === "metric"
    ? metric[side] !== undefined && readDimensionMm(metric[side], "metric") === undefined
    : !whole(fields(side).inches);
  const anyInvalid = sides.some(isInvalid);
  const switchMode = (next: DimensionMode) => {
    if (next === mode) return;
    setMode(next);
    setMetric({});
    setImperial({});
  };
  const reportValidity = (side: Side, valid: boolean) =>
    onValidChange?.(valid && !sides.some(other => other !== side && isInvalid(other)));
  const changeImperial = (side: Side, next: Imperial) => {
    setImperial(current => ({ ...current, [side]: next }));
    const valid = whole(next.inches);
    reportValidity(side, valid);
    if (valid) {
      const inches = Number(next.inches) + next.fraction / 16;
      onChange(side, inches ? inches * MM_PER_INCH : null);
    }
  };
  const inchesLabel = labels?.inches ?? "Inches";
  const fractionLabel = labels?.fraction ?? "Fraction";
  return <div className="unit-dimension-fields" role="group" aria-label={labels?.legend ?? "Dimensions"}>
    <div className="unit-dimension-modes">
      <button type="button" aria-pressed={mode === "imperial"} disabled={anyInvalid} onClick={() => switchMode("imperial")}>in</button>
      <button type="button" aria-pressed={mode === "metric"} disabled={anyInvalid} onClick={() => switchMode("metric")}>mm</button>
    </div>
    {sides.map(side => {
      const name = labels?.[side] ?? (side === "width" ? "Width" : "Height");
      const current = fields(side);
      return <div className="unit-dimension-side" key={side} role="group" aria-label={name}>
        {mode === "metric" ? <>
          <label htmlFor={`${ids}-${side}`}>{name} (mm)</label>
          <input id={`${ids}-${side}`} inputMode="decimal" placeholder="1050" autoComplete="off"
            aria-invalid={isInvalid(side) || undefined} value={metric[side] ?? formatDimensionMm(values[side], "metric")}
            onChange={event => {
              const text = event.target.value;
              const mm = readDimensionMm(text, "metric");
              event.currentTarget.setCustomValidity(mm === undefined ? "Enter a positive dimension." : "");
              setMetric(old => ({ ...old, [side]: text }));
              reportValidity(side, mm !== undefined);
              if (mm !== undefined) onChange(side, mm);
            }}
            onBlur={() => { if (!isInvalid(side)) setMetric(old => ({ ...old, [side]: undefined })); }}/>
        </> : <>
          <strong className="unit-dimension-name">{name}</strong>
          <div className="unit-dimension-entry">
            <label><span>{inchesLabel}</span>
              <input aria-label={`${name} ${inchesLabel.toLowerCase()}`} inputMode="numeric" placeholder="0" autoComplete="off"
                aria-invalid={!whole(current.inches) || undefined} value={current.inches}
                onChange={event => {
                  const text = event.target.value;
                  event.currentTarget.setCustomValidity(whole(text) ? "" : "Enter whole inches.");
                  changeImperial(side, { ...current, inches: text });
                }}/>
            </label>
            <label><span>{fractionLabel}</span>
              <select aria-label={`${name} ${fractionLabel.toLowerCase()}`} value={current.fraction}
                onChange={event => changeImperial(side, { ...current, fraction: Number(event.target.value) })}>
                {Array.from({ length: 16 }, (_, index) => <option key={index} value={index}>{inchFraction(index) || "0"}</option>)}
              </select>
            </label>
          </div>
        </>}
      </div>;
    })}
  </div>;
}
