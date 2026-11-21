import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";
import { renderPageCanvas } from "../../lib/install/pdf";

export async function drawDrawingCrop(pdf: PDFDocumentProxy, sheet: number, crop: CadUnitDraft["crop"], targetWidth = 2200) {
  const page = await renderPageCanvas(pdf, sheet, targetWidth);
  const canvas = document.createElement("canvas");
  const width = Math.round((crop.right - crop.left) * page.width);
  const height = Math.round((crop.bottom - crop.top) * page.height);
  canvas.width = width;
  canvas.height = height;
  try {
    canvas.getContext("2d")!.drawImage(page, crop.left * page.width, crop.top * page.height,
      width, height, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    page.width = 0;
    page.height = 0;
  }
}


/**
 * A crop sharp enough to read a dimension callout.
 *
 * drawDrawingCrop renders the WHOLE sheet first, and that render is capped at
 * four megapixels to protect phones, so a small crop of a large sheet comes out
 * a couple of hundred pixels wide. Here only the cropped region is rasterised,
 * at whatever scale fills `targetWidth`, by shifting the page under a canvas
 * the size of the crop. The pixel budget applies to the crop, not the sheet.
 */
export async function drawSharpCrop(pdf: PDFDocumentProxy, sheet: number, crop: CadUnitDraft["crop"], targetWidth = 3000) {
  const page = await pdf.getPage(sheet);
  const base = page.getViewport({ scale: 1 });
  const cropWidth = (crop.right - crop.left) * base.width;
  const cropHeight = (crop.bottom - crop.top) * base.height;
  const scale = Math.min(targetWidth / cropWidth, Math.sqrt(9_000_000 / (cropWidth * cropHeight)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(cropWidth * scale);
  canvas.height = Math.ceil(cropHeight * scale);
  try {
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas, canvasContext: context, viewport: page.getViewport({ scale }),
      transform: [1, 0, 0, 1, -crop.left * base.width * scale, -crop.top * base.height * scale],
    }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    page.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}
