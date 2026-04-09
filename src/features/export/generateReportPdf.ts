import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from "pdf-lib";

import type { ExtractedImage } from "../../types";

interface ReportItem {
  image: ExtractedImage;
  description: string;
}

interface EmbeddedImageMeta {
  image: Awaited<ReturnType<PDFDocument["embedPng"]>>;
  width: number;
  height: number;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const [_, base64] = dataUrl.split(",");
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function embedImage(pdfDoc: PDFDocument, dataUrl: string): Promise<EmbeddedImageMeta> {
  const bytes = dataUrlToBytes(dataUrl);
  if (dataUrl.includes("image/jpeg")) {
    const image = await pdfDoc.embedJpg(bytes);
    return { image, width: image.width, height: image.height };
  }
  const image = await pdfDoc.embedPng(bytes);
  return { image, width: image.width, height: image.height };
}

function drawWrappedText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  font: PDFFont,
  size: number
): void {
  const words = text.split(/\s+/).filter(Boolean);
  let line = "";
  let cursorY = y;

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    const candidateWidth = font.widthOfTextAtSize(candidate, size);
    if (candidateWidth > maxWidth && line) {
      page.drawText(line, { x, y: cursorY, size, font, color: rgb(0.1, 0.1, 0.1) });
      line = word;
      cursorY -= lineHeight;
    } else {
      line = candidate;
    }
  }

  if (line) {
    page.drawText(line, { x, y: cursorY, size, font, color: rgb(0.1, 0.1, 0.1) });
  }
}

function fitSize(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const ratio = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: sourceWidth * ratio,
    height: sourceHeight * ratio,
  };
}

export async function generateReportPdf(items: ReportItem[]): Promise<Uint8Array> {
  if (items.length === 0) {
    throw new Error("请至少选择一张图片生成文档。");
  }

  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [595, 842];

  for (const [idx, item] of items.entries()) {
    const page = pdfDoc.addPage(pageSize);
    const [pageWidth, pageHeight] = pageSize;
    const margin = 26;

    page.drawRectangle({
      x: margin,
      y: margin,
      width: pageWidth - margin * 2,
      height: pageHeight - margin * 2,
      borderColor: rgb(0.2, 0.2, 0.2),
      borderWidth: 1,
    });

    const titleBottomY = pageHeight - 112;
    page.drawLine({
      start: { x: margin, y: titleBottomY },
      end: { x: pageWidth - margin, y: titleBottomY },
      thickness: 1,
      color: rgb(0.2, 0.2, 0.2),
    });
    page.drawLine({
      start: { x: pageWidth - 220, y: margin },
      end: { x: pageWidth - 220, y: titleBottomY },
      thickness: 1,
      color: rgb(0.2, 0.2, 0.2),
    });

    page.drawText("ENGINE OIL LABEL REPORT", {
      x: margin + 12,
      y: pageHeight - 72,
      size: 16,
      font: bold,
      color: rgb(0.08, 0.08, 0.08),
    });
    page.drawText("CHONGQING RATO POWER CO., LTD", {
      x: margin + 12,
      y: pageHeight - 94,
      size: 9,
      font: regular,
      color: rgb(0.2, 0.2, 0.2),
    });
    page.drawText(`Doc No: 88081-YGK0214`, {
      x: pageWidth - 206,
      y: pageHeight - 66,
      size: 9,
      font: regular,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(`Page: ${idx + 1}/${items.length}`, {
      x: pageWidth - 206,
      y: pageHeight - 82,
      size: 9,
      font: regular,
      color: rgb(0.1, 0.1, 0.1),
    });

    const embedded = await embedImage(pdfDoc, item.image.dataUrl);
    const imageBox = {
      x: 92,
      y: 316,
      width: pageWidth - 92 * 2,
      height: 374,
    };
    const fitted = fitSize(embedded.width, embedded.height, imageBox.width, imageBox.height);
    page.drawImage(embedded.image, {
      x: imageBox.x + (imageBox.width - fitted.width) / 2,
      y: imageBox.y + (imageBox.height - fitted.height) / 2,
      width: fitted.width,
      height: fitted.height,
    });

    page.drawRectangle({
      x: imageBox.x,
      y: imageBox.y,
      width: imageBox.width,
      height: imageBox.height,
      borderColor: rgb(0.22, 0.22, 0.22),
      borderWidth: 1,
    });

    const descTopY = 280;
    page.drawText(`Image: ${item.image.name} (Page ${item.image.pageNumber})`, {
      x: margin + 12,
      y: descTopY,
      size: 10,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText("Description", {
      x: margin + 12,
      y: descTopY - 20,
      size: 10,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
    drawWrappedText(
      page,
      item.description || "No description provided.",
      margin + 12,
      descTopY - 38,
      pageWidth - margin * 2 - 24,
      14,
      regular,
      10
    );
  }

  return pdfDoc.save();
}
