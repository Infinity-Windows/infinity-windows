// Generates printable label PDFs (4x2 inch landscape labels, one per page,
// sized for thermal printers like the Rollo; also fine on letter sheets).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import {
  encodeContainerSerialQr,
  encodeLocationQr,
  encodeLocationSerialQr,
  encodePackageSerialQr,
  encodeWindowQr,
  encodeWindowSerialQr,
} from "./qr";

const LABEL_W = 288; // 4in * 72pt
const LABEL_H = 144; // 2in * 72pt

interface LabelLine {
  text: string;
  size: number;
  bold?: boolean;
  color?: [number, number, number];
}

interface LabelSpec {
  qrPayload: string;
  /** Big bold hero text at the top of the text column (code or id/address). */
  hero: { text: string; maxSize: number };
  /** Smaller detail lines stacked beneath the hero. */
  lines: LabelLine[];
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
    const maxWidth = LABEL_W - textX - 8;
    let cursorY = LABEL_H - 22;

    // Hero: shrink to fit the available width.
    let heroSize = label.hero.maxSize;
    while (
      heroSize > 12 &&
      bold.widthOfTextAtSize(label.hero.text, heroSize) > maxWidth
    ) {
      heroSize -= 1;
    }
    page.drawText(label.hero.text, {
      x: textX,
      y: cursorY - heroSize + 4,
      size: heroSize,
      font: bold,
      color: rgb(0, 0, 0),
    });
    cursorY -= heroSize + 8;

    for (const line of label.lines) {
      const font = line.bold ? bold : regular;
      let size = line.size;
      while (size > 7 && font.widthOfTextAtSize(line.text, size) > maxWidth) {
        size -= 1;
      }
      cursorY -= size;
      const [r, g, b] = line.color ?? [0.2, 0.2, 0.2];
      page.drawText(line.text, {
        x: textX,
        y: cursorY,
        size,
        font,
        color: rgb(r, g, b),
        maxWidth,
      });
      cursorY -= 4;
    }
  }

  return doc.save();
}

const MUTED: [number, number, number] = [0.4, 0.4, 0.4];

export async function windowLabelsPdf(
  windows: {
    window_id: string;
    typeName: string;
    short_code?: string | null;
    serial?: string | null;
    display_name?: string | null;
  }[],
): Promise<Uint8Array> {
  return buildLabelPdf(
    windows.map((w) => {
      const lines: LabelLine[] = [];
      // When a hand-writable code is the hero, the window_id becomes a line.
      if (w.short_code) lines.push({ text: w.window_id, size: 13, bold: true });
      if (w.display_name) lines.push({ text: w.display_name, size: 12 });
      if (w.serial) lines.push({ text: w.serial, size: 10, color: MUTED });
      lines.push({ text: w.typeName, size: 11, color: MUTED });
      return {
        // QR encodes the permanent serial so renames never break scans; fall
        // back to the legacy window_id payload for rows without a serial yet.
        qrPayload: w.serial
          ? encodeWindowSerialQr(w.serial)
          : encodeWindowQr(w.window_id),
        hero: w.short_code
          ? { text: w.short_code, maxSize: 40 }
          : { text: w.window_id, maxSize: 22 },
        lines,
      };
    }),
  );
}

export async function locationLabelsPdf(
  locations: {
    address: string;
    zoneName: string;
    serial?: string | null;
    display_name?: string | null;
  }[],
): Promise<Uint8Array> {
  return buildLabelPdf(
    locations.map((l) => {
      const lines: LabelLine[] = [];
      if (l.display_name) lines.push({ text: l.display_name, size: 13, bold: true });
      if (l.serial) lines.push({ text: l.serial, size: 11, color: MUTED });
      lines.push({ text: l.zoneName, size: 12, color: MUTED });
      return {
        // QR encodes the permanent serial so renaming the address never breaks
        // scans; fall back to the legacy address payload when no serial yet.
        qrPayload: l.serial
          ? encodeLocationSerialQr(l.serial)
          : encodeLocationQr(l.address),
        hero: { text: l.address, maxSize: 26 },
        lines,
      };
    }),
  );
}

/**
 * Blank license-plate stickers, one per 4×2 thermal label: QR + big serial +
 * hand-writable short code. They mean nothing until first scan binds them to
 * a package at the truck — print by the hundred and keep the roll in the cab.
 */
export async function packageLabelsPdf(
  packages: {
    serial: string;
    short_code?: string | null;
    /** "BLACK22 · Window 16 · 2 of 4" on a pre-bound label (ticket 15). A
     * blank-roll sticker has none and keeps its "scan to assign" line — the
     * words on the paper always match what the record already knows. */
    bindLine?: string | null;
  }[],
): Promise<Uint8Array> {
  return buildLabelPdf(
    packages.map((p) => ({
      qrPayload: encodePackageSerialQr(p.serial),
      hero: p.short_code
        ? { text: p.short_code, maxSize: 40 }
        : { text: p.serial, maxSize: 26 },
      lines: [
        ...(p.short_code
          ? [{ text: p.serial, size: 13, bold: true } as LabelLine]
          : []),
        p.bindLine
          ? ({ text: p.bindLine, size: 12, bold: true } as LabelLine)
          : { text: "Package — scan to assign", size: 10, color: MUTED },
      ],
    })),
  );
}

/**
 * Letter-size door poster for a conex/warehouse: one page per container,
 * giant QR + name + serial, readable from a forklift. Print, laminate, zip-tie.
 */
export async function containerPostersPdf(
  containers: { serial: string; name: string; address?: string | null }[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const W = 612; // 8.5in
  const H = 792; // 11in

  for (const c of containers) {
    const page = doc.addPage([W, H]);
    const qrDataUrl = await QRCode.toDataURL(encodeContainerSerialQr(c.serial), {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 640,
    });
    const png = await doc.embedPng(qrDataUrl);
    const qrSize = 440;
    page.drawImage(png, {
      x: (W - qrSize) / 2,
      y: H - qrSize - 120,
      width: qrSize,
      height: qrSize,
    });

    let nameSize = 54;
    while (nameSize > 18 && bold.widthOfTextAtSize(c.name, nameSize) > W - 72) {
      nameSize -= 2;
    }
    page.drawText(c.name, {
      x: (W - bold.widthOfTextAtSize(c.name, nameSize)) / 2,
      y: H - 84,
      size: nameSize,
      font: bold,
      color: rgb(0, 0, 0),
    });
    page.drawText(c.serial, {
      x: (W - bold.widthOfTextAtSize(c.serial, 30)) / 2,
      y: H - qrSize - 170,
      size: 30,
      font: bold,
      color: rgb(0, 0, 0),
    });
    if (c.address) {
      let addrSize = 18;
      while (
        addrSize > 10 &&
        regular.widthOfTextAtSize(c.address, addrSize) > W - 72
      ) {
        addrSize -= 1;
      }
      page.drawText(c.address, {
        x: (W - regular.widthOfTextAtSize(c.address, addrSize)) / 2,
        y: H - qrSize - 200,
        size: addrSize,
        font: regular,
        color: rgb(0.25, 0.25, 0.25),
      });
    }
    page.drawText("Scan to open this container in the app", {
      x: (W - regular.widthOfTextAtSize("Scan to open this container in the app", 14)) / 2,
      y: 48,
      size: 14,
      font: regular,
      color: rgb(0.4, 0.4, 0.4),
    });
  }

  return doc.save();
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
