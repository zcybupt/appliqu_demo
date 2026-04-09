import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

import type { PdfPagePreview } from "../../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export async function loadPdfDocument(data: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js may transfer (detach) buffers when posting to worker.
  // Always pass a fresh copy so callers can safely reuse original bytes.
  const safeCopy = data.slice();
  return pdfjsLib.getDocument({ data: safeCopy }).promise;
}

export async function buildPdfPagePreviews(
  doc: PDFDocumentProxy,
  maxWidth = 240
): Promise<PdfPagePreview[]> {
  const previews: PdfPagePreview[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = maxWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("无法创建画布上下文。");
    }

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    previews.push({
      pageNumber,
      width: canvas.width,
      height: canvas.height,
      dataUrl: canvas.toDataURL("image/png"),
    });
  }

  return previews;
}
