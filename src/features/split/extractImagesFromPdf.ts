import type { ExtractedImage } from "../../types";
import { loadPdfDocument } from "../upload/loadPdfPreview";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ProgressCallback = (value: number, label: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function cropCanvasToDataUrl(source: HTMLCanvasElement, box: Box): string {
  const crop = document.createElement("canvas");
  crop.width = box.width;
  crop.height = box.height;
  const cropCtx = crop.getContext("2d");
  if (!cropCtx) {
    throw new Error("无法创建裁剪画布。");
  }
  cropCtx.drawImage(
    source,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    box.width,
    box.height
  );
  return crop.toDataURL("image/png");
}

function detectImageRegions(canvas: HTMLCanvasElement): Box[] {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return [];
  }

  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const visited = new Uint8Array(width * height);
  const boxes: Box[] = [];
  const stride = 2;
  const minBoxWidth = Math.max(80, Math.floor(width * 0.08));
  const minBoxHeight = Math.max(80, Math.floor(height * 0.08));
  const minArea = Math.max(16000, Math.floor(width * height * 0.005));

  const isForeground = (x: number, y: number): boolean => {
    const p = (y * width + x) * 4;
    const alpha = data[p + 3];
    if (alpha < 20) {
      return false;
    }
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    return !(r > 245 && g > 245 && b > 245);
  };

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = y * width + x;
      if (visited[idx] || !isForeground(x, y)) {
        continue;
      }

      const queueX: number[] = [x];
      const queueY: number[] = [y];
      visited[idx] = 1;
      let head = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;

      while (head < queueX.length) {
        const cx = queueX[head];
        const cy = queueY[head];
        head += 1;
        count += 1;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors = [
          [cx + stride, cy],
          [cx - stride, cy],
          [cx, cy + stride],
          [cx, cy - stride],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !isForeground(nx, ny)) {
            continue;
          }
          visited[nIdx] = 1;
          queueX.push(nx);
          queueY.push(ny);
        }
      }

      const boxWidth = maxX - minX + stride;
      const boxHeight = maxY - minY + stride;
      const area = count * stride * stride;
      if (boxWidth < minBoxWidth || boxHeight < minBoxHeight || area < minArea) {
        continue;
      }

      const padding = 8;
      boxes.push({
        x: Math.max(0, minX - padding),
        y: Math.max(0, minY - padding),
        width: Math.min(width - Math.max(0, minX - padding), boxWidth + padding * 2),
        height: Math.min(height - Math.max(0, minY - padding), boxHeight + padding * 2),
      });
    }
  }

  return boxes.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 8);
}

export async function extractImagesFromPdf(
  data: Uint8Array,
  onProgress: ProgressCallback
): Promise<ExtractedImage[]> {
  let visualProgress = 0;
  let targetProgress = 8;
  let stageLabel = "读取 PDF";
  const timer = window.setInterval(() => {
    if (visualProgress < Math.min(targetProgress, 94)) {
      visualProgress += 1;
      onProgress(visualProgress, stageLabel);
    }
  }, 60);

  const setStage = (target: number, label: string) => {
    targetProgress = Math.max(targetProgress, target);
    stageLabel = label;
    onProgress(visualProgress, stageLabel);
  };

  try {
    setStage(10, "读取 PDF");
    const doc = await loadPdfDocument(data);
    const extractedImages: ExtractedImage[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      setStage(
        25 + Math.floor((pageNumber / Math.max(doc.numPages, 1)) * 55),
        `分解第 ${pageNumber} / ${doc.numPages} 页`
      );

      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        continue;
      }
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const boxes = detectImageRegions(canvas);
      if (boxes.length === 0) {
        extractedImages.push({
          id: `page-${pageNumber}-full`,
          pageNumber,
          name: `P${pageNumber}-full`,
          width: canvas.width,
          height: canvas.height,
          dataUrl: canvas.toDataURL("image/png"),
        });
      } else {
        boxes.forEach((box, index) => {
          extractedImages.push({
            id: `page-${pageNumber}-img-${index + 1}`,
            pageNumber,
            name: `P${pageNumber}-img-${index + 1}`,
            width: box.width,
            height: box.height,
            dataUrl: cropCanvasToDataUrl(canvas, box),
          });
        });
      }

      await sleep(220);
    }

    setStage(96, "完成后处理");
    while (visualProgress < 100) {
      visualProgress += 1;
      onProgress(visualProgress, "分解完成");
      await sleep(16);
    }

    return extractedImages;
  } finally {
    window.clearInterval(timer);
  }
}
