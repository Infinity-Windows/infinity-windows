// Generates printable label PDFs (4x2 inch landscape labels, one per page,
// sized for thermal printers like the Rollo; also fine on letter sheets).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { encodeLocationQr, encodeWindowQr } from "./qr";

const LABEL_W = 288; // 4in * 72pt
const LABEL_H = 144; // 2in * 72pt

interface LabelSpec {
  qrPayload: string;
  title: string;
  subtitle: string;
  /** Hand-writable short code — drawn LARGE so a worker can copy it by hand. */
  code?: string;
}

async function buildLabelPdf(labels: LabelSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  for (const label of labels) {
    const page = doc.addPage([LABEL_W, LABEL_H]);
    const qrDataUrl = await QRCode.toDataURL(label.qrPayload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 240,
    });
    const png = await doc.embedPng(qrDataUrl);
    const qrSize = 116;
    page.drawImage(png, {
      x: 12,
      y: (LABEL_H - qrSize) / 2,
      width: qrSize,
      height: qrSize,
    });

    const textX = qrSize + 24;
    const maxTitleWidth = LABEL_W - textX - 8;

    if (label.code) {
      // Hybrid window label: the hand-writable code is the hero (big + bold),
      // the serial + type sit smaller beneath it. QR still encodes the serial.
      let codeSize = 44;
      while (
        codeSize > 16 &&
        bold.widthOfTextAtSize(label.code, codeSize) > maxTitleWidth
      ) {
        codeSize -= 1;
      }
      page.drawText(label.code, {
        x: textX,
        y: LABEL_H - 20 - codeSize,
        size: codeSize,
        font: bold,
        color: rgb(0, 0, 0),
      });
      page.drawText(label.title, {
        x: textX,
        y: 34,
        size: 13,
        font: regular,
        color: rgb(0.2, 0.2, 0.2),
        maxWidth: maxTitleWidth,
      });
      page.drawText(label.subtitle, {
        x: textX,
        y: 16,
        size: 11,
        font: regular,
        color: rgb(0.35, 0.35, 0.35),
        maxWidth: maxTitleWidth,
      });
      continue;
    }

    let titleSize = 26;
    while (
      titleSize > 10 &&
      bold.widthOfTextAtSize(label.title, titleSize) > maxTitleWidth
    ) {
      titleSize -= 1;
    }
    page.drawText(label.title, {
      x: textX,
      y: LABEL_H / 2 + 8,
      size: titleSize,
      font: bold,
      color: rgb(0, 0, 0),
    });
    page.drawText(label.subtitle, {
      x: textX,
      y: LABEL_H / 2 - 18,
      size: 12,
      font: regular,
      color: rgb(0.2, 0.2, 0.2),
      maxWidth: maxTitleWidth,
    });
  }

  return doc.save();
}

export async function windowLabelsPdf(
  windows: { window_id: string; typeName: string; short_code?: string | null }[],
): Promise<Uint8Array> {
  return buildLabelPdf(
    windows.map((w) => ({
      qrPayload: encodeWindowQr(w.window_id),
      title: w.window_id,
      subtitle: w.typeName,
      code: w.short_code ?? undefined,
    })),
  );
}

export async function locationLabelsPdf(
  locations: { address: string; zoneName: string }[],
): Promise<Uint8Array> {
  return buildLabelPdf(
    locations.map((l) => ({
      qrPayload: encodeLocationQr(l.address),
      title: l.address,
      subtitle: l.zoneName,
    })),
  );
}

export function downloadPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const ZONE_NAMES: Record<string, string> = {
  R: "Receiving",
  J: "Job staging",
  S: "Stock",
  D: "Damage / hold",
};
