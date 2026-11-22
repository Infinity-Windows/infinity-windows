import type { ReactNode, RefObject } from "react";
import { FileText, Upload } from "lucide-react";

/**
 * One source drawing in the Unit Builder: an empty drop target until a PDF is
 * chosen, then a compact row saying what was read from it. The input stays
 * mounted in both states so the caller's ref can clear it on Start over.
 */
export function UnitBuilderFile({ label, hint, file, status, disabled, inputRef, onPick, onRemove }: {
  label: string;
  hint: string;
  file: File | null;
  status?: ReactNode;
  disabled?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onPick: (file: File) => void;
  onRemove?: () => void;
}) {
  return <div className="ub-file" data-loaded={!!file}
    onDragOver={event => { if (!disabled) event.preventDefault(); }}
    onDrop={event => {
      event.preventDefault();
      const dropped = event.dataTransfer.files?.[0];
      if (dropped && !disabled && /\.pdf$/i.test(dropped.name)) onPick(dropped);
    }}>
    <span className="ub-file-icon" aria-hidden="true">{file ? <FileText size={20}/> : <Upload size={20}/>}</span>
    <div className="ub-file-text">
      <strong>{file ? file.name : label}</strong>
      <small>{file ? status : hint}</small>
    </div>
    <label className="ub-btn ub-file-pick" data-variant={file ? undefined : "primary"} aria-disabled={disabled || undefined}>
      {file ? "Replace" : "Choose PDF"}
      <input ref={inputRef} className="ub-visually-hidden" aria-label={label} type="file" disabled={disabled}
        accept="application/pdf,.pdf" onChange={event => {
          const next = event.target.files?.[0];
          if (next) onPick(next);
        }}/>
    </label>
    {file && onRemove && <button type="button" data-variant="ghost" disabled={disabled} onClick={onRemove}>Remove</button>}
  </div>;
}
