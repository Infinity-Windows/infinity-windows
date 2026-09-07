import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { pushToast, toastError } from "../../lib/toast";
import { useT } from "../../lib/i18n";

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
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      pushToast(t("travelCopy.copiedToast", { label: label ?? t("travelCopy.copied") }), "success");
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toastError(err, t("travelCopy.couldNotCopy"));
    }
  };
  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      aria-label={t("travelCopy.copyAria", { label: label ?? value })}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span>{copied ? t("travelCopy.copied") : t("travelCopy.copy")}</span>
    </button>
  );
}
