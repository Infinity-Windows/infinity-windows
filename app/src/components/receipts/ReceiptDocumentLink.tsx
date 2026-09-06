// The way back to the ORIGINAL file a PDF receipt came from.
//
// The receipt's picture is page one, rendered on the phone at capture time —
// enough to read an amount off, enough for the office to eyeball, and not the
// document a bookkeeper hands an auditor. Wherever a receipt is shown, a
// receipt that HAS an original says so and offers it.
//
// One component for both places because the fiddly half is the same: the
// bucket is private, so every open mints its own ten-minute link, and a tab
// opened AFTER an await is what Safari's popup blocker eats. The blank tab is
// opened on the tap itself and pointed at the link when it arrives.

import { useState } from "react";
import { FileText } from "lucide-react";
import { receiptDocumentSignedUrl } from "../../lib/receipts";
import { pushToast } from "../../lib/toast";
import { useT } from "../../lib/i18n";

export function ReceiptDocumentLink({
  /** The receipt this original belongs to. The signing call needs it: the
   * bucket and the path are worked out FROM the id, and the stored string has
   * to agree — see receiptDocumentSignedUrl. */
  receiptId,
  documentPath,
  /**
   * "chip" is the feed tile: 120 pixels wide, with the vendor and the amount
   * already on it and no room for a second control — so the PDF tag IS the
   * button, and its accessible name is the action ("Open original"), not the
   * word on its face. "button" is the office table, which has a row of
   * actions and the room to say it out loud.
   */
  variant,
}: {
  receiptId: string;
  documentPath: string;
  variant: "chip" | "button";
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    // Opened on the tap, before any awaiting: a tab opened after one is a
    // popup as far as the browser is concerned, and gets blocked silently.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const url = await receiptDocumentSignedUrl(receiptId, documentPath);
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch {
      tab?.close();
      pushToast(t("receipt.openOriginalFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  if (variant === "chip") {
    return (
      <button
        type="button"
        className="photo-gps-chip receipt-pdf-chip"
        aria-label={t("receipt.openOriginal")}
        title={t("receipt.openOriginal")}
        disabled={busy}
        onClick={() => void open()}
      >
        <FileText size={11} aria-hidden /> {t("receipt.pdfTag")}
      </button>
    );
  }

  return (
    <button type="button" className="button-like" disabled={busy} onClick={() => void open()}>
      <FileText size={14} aria-hidden /> {t("receipt.openOriginal")}
    </button>
  );
}
