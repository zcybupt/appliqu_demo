import pixelmatch from "pixelmatch";

import type { DiffBox, DiffResult } from "../../types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败。"));
    img.src = src;
  });
}

function collectDiffBoxes(diffData: ImageData): DiffBox[] {
  const { width, height, data } = diffData;
  const visited = new Uint8Array(width * height);
  const boxes: DiffBox[] = [];
  const minArea = Math.max(60, Math.floor(width * height * 0.0002));

  const isDiff = (x: number, y: number): boolean => {
    const p = (y * width + x) * 4;
    return data[p + 3] > 0;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (visited[idx] || !isDiff(x, y)) {
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
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !isDiff(nx, ny)) {
            continue;
          }
          visited[nIdx] = 1;
          queueX.push(nx);
          queueY.push(ny);
        }
      }

      if (count < minArea) {
        continue;
      }

      const pad = 6;
      const x1 = Math.max(0, minX - pad);
      const y1 = Math.max(0, minY - pad);
      const x2 = Math.min(width, maxX + pad);
      const y2 = Math.min(height, maxY + pad);
      boxes.push({
        x: x1,
        y: y1,
        width: Math.max(1, x2 - x1),
        height: Math.max(1, y2 - y1),
      });
    }
  }

  return boxes.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 30);
}

function drawOverlay(base: HTMLCanvasElement, boxes: DiffBox[], color: string): string {
  const overlay = document.createElement("canvas");
  overlay.width = base.width;
  overlay.height = base.height;
  const ctx = overlay.getContext("2d");
  if (!ctx) {
    return base.toDataURL("image/png");
  }
  ctx.drawImage(base, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;

  boxes.forEach((box) => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rx = box.width / 2 + 8;
    const ry = box.height / 2 + 8;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  });

  return overlay.toDataURL("image/png");
}

export async function diffImages(leftSrc: string, rightSrc: string): Promise<DiffResult> {
  const [leftImg, rightImg] = await Promise.all([loadImage(leftSrc), loadImage(rightSrc)]);
  const width = Math.max(1, Math.min(leftImg.width, rightImg.width));
  const height = Math.max(1, Math.min(leftImg.height, rightImg.height));

  const leftCanvas = document.createElement("canvas");
  const rightCanvas = document.createElement("canvas");
  leftCanvas.width = width;
  leftCanvas.height = height;
  rightCanvas.width = width;
  rightCanvas.height = height;

  const leftCtx = leftCanvas.getContext("2d");
  const rightCtx = rightCanvas.getContext("2d");
  if (!leftCtx || !rightCtx) {
    throw new Error("无法创建对比画布。");
  }

  leftCtx.drawImage(leftImg, 0, 0, width, height);
  rightCtx.drawImage(rightImg, 0, 0, width, height);

  const leftData = leftCtx.getImageData(0, 0, width, height);
  const rightData = rightCtx.getImageData(0, 0, width, height);
  const diffData = leftCtx.createImageData(width, height);

  const diffPixels = pixelmatch(leftData.data, rightData.data, diffData.data, width, height, {
    threshold: 0.12,
    includeAA: false,
    alpha: 0.7,
    diffColor: [255, 0, 0],
  });

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) {
    throw new Error("无法创建差异结果画布。");
  }
  maskCtx.putImageData(diffData, 0, 0);

  const boxes = collectDiffBoxes(diffData);

  return {
    width,
    height,
    diffPixels,
    boxes,
    leftOverlayDataUrl: drawOverlay(leftCanvas, boxes, "#ff1744"),
    rightOverlayDataUrl: drawOverlay(rightCanvas, boxes, "#2962ff"),
    diffMaskDataUrl: maskCanvas.toDataURL("image/png"),
  };
}
