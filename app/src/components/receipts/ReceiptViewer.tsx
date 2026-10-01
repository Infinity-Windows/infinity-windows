import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ZoomIn, ZoomOut } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useT } from "../../lib/i18n";
import { formatCents } from "../../lib/aiSpend";
import type { Receipt } from "../../lib/receipts";
import { ReceiptDocumentLink } from "./ReceiptDocumentLink";

// Both receipt lists use the same read-only viewer. A receipt is never adapted
// into a job photo: doing so could expose the photo's Remove action.
export function ReceiptViewer({ receipt, onClose }: {
  receipt: Pick<Receipt, "id" | "signedUrl" | "vendor" | "amountCents" | "documentPath">;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  useFocusTrap(ref, true, onClose);
  const title = receipt.vendor ?? t("feed.receiptAlt");

  return createPortal(
    <div className="photo-viewer-backdrop receipt-viewer-backdrop overlay-enter" onClick={onClose}>
      <div ref={ref} className="receipt-viewer" role="dialog" aria-modal="true"
        aria-label={t("receipt.viewerTitle", { vendor: title })} onClick={(e) => e.stopPropagation()}>
        <div className="receipt-viewer-toolbar">
          <div>
            <strong>{title}</strong>
            {receipt.amountCents != null && <span> · {formatCents(receipt.amountCents)}</span>}
          </div>
          <button type="button" className="action-btn" onClick={onClose}>{t("feed.close")}</button>
        </div>
        <div className="receipt-viewer-image" key={zoomed ? "zoom" : "fit"}
          role="region" tabIndex={0} aria-label={t("receipt.viewerTitle", { vendor: title })}>
          {receipt.signedUrl && !imageFailed ? (
            <div className={zoomed ? "receipt-viewer-image-size is-zoomed" : "receipt-viewer-image-size"}>
              <img src={receipt.signedUrl} alt={title} onError={() => setImageFailed(true)} />
            </div>
          ) : <p className="muted">{t("receipt.imageUnavailable")}</p>}
        </div>
        <div className="receipt-viewer-toolbar">
          <button type="button" className="button-like" disabled={!receipt.signedUrl || imageFailed}
            aria-pressed={zoomed} onClick={() => setZoomed((value) => !value)}>
            {zoomed ? <ZoomOut size={18} aria-hidden /> : <ZoomIn size={18} aria-hidden />}
            {zoomed ? t("receipt.fitScreen") : t("receipt.zoomIn")}
          </button>
          {receipt.documentPath && <ReceiptDocumentLink receiptId={receipt.id}
            documentPath={receipt.documentPath} variant="button" />}
        </div>
      </div>
    </div>, document.body,
  );
}
