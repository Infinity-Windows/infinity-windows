import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { pushToast, toastError } from "../../lib/toast";

/**
 * One-tap copy chip for wifi passwords, door/lockbox codes, confirmation codes.
 * Shows the value exactly as typed and confirms with a check + toast.
 */
export function CopyButton({
  value,
  label,
  className = "travel-copy",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      pushToast(`${label ?? "Copied"} copied`, "success");
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toastError(err, "Could not copy");
    }
  };
  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      aria-label={`Copy ${label ?? value}`}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
