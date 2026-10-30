import { useEffect, useRef } from "react";
export function TableSelection({ label, checked, mixed = false, onChange }: { label: string; checked: boolean; mixed?: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed && !checked; }, [mixed, checked]);
  return <input className="report-selection-checkbox" ref={ref} type="checkbox" aria-label={label} checked={checked} aria-checked={mixed && !checked ? "mixed" : checked} onChange={onChange} />;
}
