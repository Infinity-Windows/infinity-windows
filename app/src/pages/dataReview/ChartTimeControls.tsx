const weekCounts = [4, 8, 12, 16, 26, 52];
export function JobWeekControls({ axis, count, onAxis, onCount, label }: { axis: string; count: number; onAxis: (value: string) => void; onCount: (value: number) => void; label: string }) {
  return <><label>Time axis<select aria-label={`${label} time axis`} value={axis} onChange={event => onAxis(event.target.value)}><option value="calendar">Calendar weeks</option><option value="relative">Job weeks · 1, 2, 3…</option></select></label>{axis === "relative" && <label>Weeks from start<select aria-label="Relative week count" value={count} onChange={event => onCount(Number(event.target.value))}>{weekCounts.map(value => <option key={value} value={value}>First {value} weeks</option>)}</select></label>}</>;
}
export function ChartFormatToggle({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="chart-format-toggle" role="group" aria-label="Chart format">{[["hours", "Hours"], ["percent", "Percent"]].map(([format, label]) => <button type="button" key={format} aria-pressed={value === format} onClick={() => onChange(format)}>{label}</button>)}</div>;
}
