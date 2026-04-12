import type { ExtractedImage } from "../../types";
import { loadPdfDocument } from "../upload/loadPdfPreview";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Band {
  y1: number;
  y2: number;
}

interface InfoBar extends Box {
  lineDensity: number;
}

interface Group {
  elements: Box[];
  infoBar: InfoBar;
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
  const ctx = crop.getContext("2d");
  if (!ctx) throw new Error("无法创建裁剪画布。");
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return crop.toDataURL("image/png");
}

// ── Pixel-level utilities ──

function toGrayscale(rgba: Uint8ClampedArray, len: number): Uint8Array {
  const g = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const p = i * 4;
    g[i] = Math.round(rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114);
  }
  return g;
}

function binaryThreshold(gray: Uint8Array, thresh: number): Uint8Array {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] < thresh ? 255 : 0;
  return m;
}

// ── Binary morphology via prefix sums – O(w·h) regardless of kernel size ──

function binaryErodeH(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const hw = (k >> 1);
  const pf = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    pf[0] = 0;
    for (let x = 0; x < w; x++) pf[x + 1] = pf[x] + (mask[row + x] ? 1 : 0);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - hw);
      const x1 = Math.min(w, x + hw + 1);
      out[row + x] = pf[x1] - pf[x0] === x1 - x0 ? 255 : 0;
    }
  }
  return out;
}

function binaryDilateH(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const hw = (k >> 1);
  const pf = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    pf[0] = 0;
    for (let x = 0; x < w; x++) pf[x + 1] = pf[x] + (mask[row + x] ? 1 : 0);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - hw);
      const x1 = Math.min(w, x + hw + 1);
      out[row + x] = pf[x1] - pf[x0] > 0 ? 255 : 0;
    }
  }
  return out;
}

function binaryErodeV(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const hk = (k >> 1);
  const pf = new Int32Array(h + 1);
  for (let x = 0; x < w; x++) {
    pf[0] = 0;
    for (let y = 0; y < h; y++) pf[y + 1] = pf[y] + (mask[y * w + x] ? 1 : 0);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - hk);
      const y1 = Math.min(h, y + hk + 1);
      out[y * w + x] = pf[y1] - pf[y0] === y1 - y0 ? 255 : 0;
    }
  }
  return out;
}

function binaryDilateV(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const hk = (k >> 1);
  const pf = new Int32Array(h + 1);
  for (let x = 0; x < w; x++) {
    pf[0] = 0;
    for (let y = 0; y < h; y++) pf[y + 1] = pf[y] + (mask[y * w + x] ? 1 : 0);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - hk);
      const y1 = Math.min(h, y + hk + 1);
      out[y * w + x] = pf[y1] - pf[y0] > 0 ? 255 : 0;
    }
  }
  return out;
}

function binaryOpenH(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  return binaryDilateH(binaryErodeH(mask, w, h, k), w, h, k);
}

function binaryOpenV(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  return binaryDilateV(binaryErodeV(mask, w, h, k), w, h, k);
}

function binaryDilate2D(mask: Uint8Array, w: number, h: number, kw: number, kh: number): Uint8Array {
  return binaryDilateV(binaryDilateH(mask, w, h, kw), w, h, kh);
}

// ── Connected component labelling (BFS) ──

function findComponents(mask: Uint8Array, w: number, h: number, minArea: number): Box[] {
  const visited = new Uint8Array(w * h);
  const boxes: Box[] = [];
  const maxArea = w * h * 0.35;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx] || !mask[idx]) continue;

      const q: number[] = [x, y];
      visited[idx] = 1;
      let head = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      let count = 0;

      while (head < q.length) {
        const cx = q[head++];
        const cy = q[head++];
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const nx4 = [cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1];
        for (let i = 0; i < 8; i += 2) {
          const nx = nx4[i], ny = nx4[i + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni] || !mask[ni]) continue;
          visited[ni] = 1;
          q.push(nx, ny);
        }
      }

      if (count >= minArea && count <= maxArea) {
        boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
      }
    }
  }
  return boxes;
}

// ── Step 1: Color band detection (HSV) ──

function detectColorBands(rgba: Uint8ClampedArray, w: number, h: number): Band[] {
  const rowColorCount = new Uint32Array(h);
  const threshold = w * 0.5;

  for (let y = 0; y < h; y++) {
    let count = 0;
    const rowStart = y * w * 4;
    for (let x = 0; x < w; x++) {
      const p = rowStart + x * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      if (delta < 40 || max < 50) continue;
      const sat = delta / max;
      if (sat < 0.18) continue;
      const hueNorm = max === 0 ? 0 : delta / max;
      if (hueNorm < 0.15) continue;

      let hue: number;
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;

      if ((hue >= 70 && hue <= 330) && sat > 0.18 && max > 50) {
        count++;
      }
    }
    rowColorCount[y] = count;
  }

  const bands: Band[] = [];
  let bandStart = -1;
  for (let y = 0; y < h; y++) {
    if (rowColorCount[y] >= threshold) {
      if (bandStart < 0) bandStart = y;
    } else if (bandStart >= 0) {
      if (y - bandStart >= 3) bands.push({ y1: bandStart, y2: y - 1 });
      bandStart = -1;
    }
  }
  if (bandStart >= 0 && h - bandStart >= 3) bands.push({ y1: bandStart, y2: h - 1 });

  return bands;
}

function eraseBandsFromGray(gray: Uint8Array, w: number, bands: Band[]): void {
  for (const b of bands) {
    for (let y = b.y1; y <= b.y2; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) gray[row + x] = 255;
    }
  }
}

// ── Step 2: Info bar detection via table lines ──

function countLines(
  lineMask: Uint8Array,
  w: number,
  box: Box,
  direction: "h" | "v",
): number {
  let count = 0;
  let inLine = false;
  if (direction === "h") {
    for (let y = box.y; y < box.y + box.height; y++) {
      let has = false;
      const row = y * w;
      for (let x = box.x; x < box.x + box.width; x++) {
        if (lineMask[row + x]) { has = true; break; }
      }
      if (has && !inLine) { count++; inLine = true; }
      else if (!has) inLine = false;
    }
  } else {
    for (let x = box.x; x < box.x + box.width; x++) {
      let has = false;
      for (let y = box.y; y < box.y + box.height; y++) {
        if (lineMask[y * w + x]) { has = true; break; }
      }
      if (has && !inLine) { count++; inLine = true; }
      else if (!has) inLine = false;
    }
  }
  return count;
}

function lineDensityInBox(
  lineMask: Uint8Array,
  w: number,
  box: Box,
): number {
  let count = 0;
  const area = box.width * box.height;
  if (area === 0) return 0;
  for (let y = box.y; y < box.y + box.height; y++) {
    const row = y * w;
    for (let x = box.x; x < box.x + box.width; x++) {
      if (lineMask[row + x]) count++;
    }
  }
  return count / area;
}

function iou(a: Box, b: Box): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

function detectInfoBars(
  binary: Uint8Array,
  hLines: Uint8Array,
  vLines: Uint8Array,
  gray: Uint8Array,
  w: number,
  h: number,
  s: number,
): InfoBar[] {
  const combined = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) combined[i] = hLines[i] || vLines[i] ? 255 : 0;

  const joinK = Math.max(3, Math.round(30 * s));
  const regions = binaryDilate2D(combined, w, h, joinK, joinK);
  const candidates = findComponents(regions, w, h, Math.round(400 * s));

  const minW = Math.round(400 * s), maxW = Math.round(2000 * s);
  const minH = Math.round(80 * s), maxH = Math.round(500 * s);

  const validated: InfoBar[] = [];
  for (const box of candidates) {
    if (box.width < minW || box.width > maxW) continue;
    if (box.height < minH || box.height > maxH) continue;

    const ar = box.width / box.height;
    if (ar < 1.5 || ar > 12) continue;

    const density = lineDensityInBox(combined, w, box);
    if (density < 0.01) continue;

    const hCount = countLines(hLines, w, box, "h");
    const vCount = countLines(vLines, w, box, "v");
    if (hCount < 3 || vCount < 3) continue;

    const leftW = Math.floor(box.width / 3);
    let darkCount = 0, totalCount = 0;
    for (let y = box.y; y < box.y + box.height; y++) {
      const row = y * w;
      for (let x = box.x; x < box.x + leftW; x++) {
        totalCount++;
        if (gray[row + x] < 100) darkCount++;
      }
    }
    if (totalCount > 0 && darkCount / totalCount < 0.15) continue;

    validated.push({ ...box, lineDensity: density });
  }

  validated.sort((a, b) => b.lineDensity - a.lineDensity);
  const kept: InfoBar[] = [];
  for (const bar of validated) {
    if (kept.every((k) => iou(k, bar) <= 0.3)) kept.push(bar);
  }
  return kept;
}

// ── Step 3: Element detection ──

function detectElements(
  binary: Uint8Array,
  w: number,
  h: number,
  infoBars: InfoBar[],
  bands: Band[],
  s: number,
): Box[] {
  const clean = new Uint8Array(binary);
  const padBottom = Math.round(200 * s);
  const padLeft = Math.round(160 * s);

  for (const bar of infoBars) {
    const y2 = Math.min(h, bar.y + bar.height + padBottom);
    const x1 = Math.max(0, bar.x - padLeft);
    for (let y = bar.y; y < y2; y++) {
      const row = y * w;
      for (let x = x1; x < bar.x + bar.width; x++) {
        if (x >= 0 && x < w) clean[row + x] = 0;
      }
    }
  }
  for (const b of bands) {
    for (let y = b.y1; y <= b.y2; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) clean[row + x] = 0;
    }
  }

  const elemK = Math.max(3, Math.round(9 * s));
  const dilated = binaryDilate2D(clean, w, h, elemK, elemK);
  const minArea = Math.round(3000 * s * s);
  const boxes = findComponents(dilated, w, h, minArea);

  const minDim = Math.round(60 * s);
  return boxes.filter((b) => {
    if (b.width < minDim || b.height < minDim) return false;
    if (b.width > w * 0.9) return false;
    const ar = b.width / b.height;
    if ((ar > 15 || ar < 1 / 15) && Math.min(b.width, b.height) < Math.round(80 * s)) return false;
    return true;
  });
}

// ── Step 4: Element ↔ InfoBar pairing ──

function pairElementsToInfoBars(
  elements: Box[],
  infoBars: InfoBar[],
  imgHeight: number,
): { groups: Group[]; orphanElements: Box[]; orphanInfoBars: InfoBar[] } {
  const usedInfoBars = new Set<number>();
  const groups: Group[] = [];
  const orphanElements: Box[] = [];
  const maxVDist = imgHeight * 0.25;

  for (const elem of elements) {
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let i = 0; i < infoBars.length; i++) {
      const bar = infoBars[i];
      if (bar.y < elem.y) continue;
      if (bar.y - elem.y > elem.height * 0.5 + maxVDist) continue;

      const elemCx = elem.x + elem.width / 2;
      const barCx = bar.x + bar.width / 2;
      const overlapX =
        Math.min(elem.x + elem.width, bar.x + bar.width) - Math.max(elem.x, bar.x);
      const hDist = overlapX > 0 ? 0 : Math.abs(elemCx - barCx);

      const vDist = Math.max(0, bar.y - (elem.y + elem.height));
      if (vDist > maxVDist) continue;

      const score = vDist + hDist * 0.3;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      if (usedInfoBars.has(bestIdx)) {
        const existing = groups.find((g) => g.infoBar === infoBars[bestIdx]);
        existing?.elements.push(elem);
      } else {
        usedInfoBars.add(bestIdx);
        groups.push({ elements: [elem], infoBar: infoBars[bestIdx] });
      }
    } else {
      orphanElements.push(elem);
    }
  }

  const orphanInfoBars = infoBars.filter((_, i) => !usedInfoBars.has(i));
  return { groups, orphanElements, orphanInfoBars };
}

// ── Step 5: Smart bbox expansion with neighbour fences ──

function mergeBoxes(boxes: Box[]): Box {
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

interface Fences {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function computeFences(
  allRawBoxes: Box[],
  idx: number,
  bands: Band[],
  w: number,
  h: number,
): Fences {
  const box = allRawBoxes[idx];
  const fences: Fences = { top: 0, bottom: h, left: 0, right: w };

  for (let i = 0; i < allRawBoxes.length; i++) {
    if (i === idx) continue;
    const other = allRawBoxes[i];

    const hOverlap =
      Math.min(box.x + box.width, other.x + other.width) -
      Math.max(box.x, other.x);
    const hClose = hOverlap > -box.width * 0.3;

    if (hClose) {
      if (other.y + other.height <= box.y) {
        const mid = Math.floor((other.y + other.height + box.y) / 2);
        fences.top = Math.max(fences.top, mid);
      }
      if (other.y >= box.y + box.height) {
        const mid = Math.ceil((box.y + box.height + other.y) / 2);
        fences.bottom = Math.min(fences.bottom, mid);
      }
    }

    const vOverlap =
      Math.min(box.y + box.height, other.y + other.height) -
      Math.max(box.y, other.y);
    const vClose = vOverlap > -box.height * 0.3;

    if (vClose) {
      if (other.x + other.width <= box.x) {
        const mid = Math.floor((other.x + other.width + box.x) / 2);
        fences.left = Math.max(fences.left, mid);
      }
      if (other.x >= box.x + box.width) {
        const mid = Math.ceil((box.x + box.width + other.x) / 2);
        fences.right = Math.min(fences.right, mid);
      }
    }
  }

  for (const band of bands) {
    const bandMid = Math.floor((band.y1 + band.y2) / 2);
    const boxMid = box.y + box.height / 2;
    if (bandMid < boxMid && band.y2 < box.y) {
      fences.top = Math.max(fences.top, band.y2 + 1);
    }
    if (bandMid > boxMid && band.y1 > box.y + box.height) {
      fences.bottom = Math.min(fences.bottom, band.y1);
    }
  }

  return fences;
}

function smartExpand(
  gray: Uint8Array,
  w: number,
  h: number,
  box: Box,
  fences: Fences,
  s: number,
): Box {
  const maxExpand = Math.round(150 * s);
  const gapTolerance = Math.round(15 * s);
  const contentThresh = 240;
  const margin = Math.round(8 * s);

  let { x: x1, y: y1 } = box;
  let x2 = box.x + box.width;
  let y2 = box.y + box.height;

  const limitTop = Math.max(0, fences.top);
  const limitBottom = Math.min(h, fences.bottom);
  const limitLeft = Math.max(0, fences.left);
  const limitRight = Math.min(w, fences.right);

  const hasContentInRow = (row: number, xa: number, xb: number): boolean => {
    const off = row * w;
    for (let x = Math.max(0, xa); x < Math.min(w, xb); x++) {
      if (gray[off + x] < contentThresh) return true;
    }
    return false;
  };
  const hasContentInCol = (col: number, ya: number, yb: number): boolean => {
    for (let y = Math.max(0, ya); y < Math.min(h, yb); y++) {
      if (gray[y * w + col] < contentThresh) return true;
    }
    return false;
  };

  for (let d = 0, gap = 0; d < maxExpand && y1 > limitTop; d++) {
    y1--;
    if (hasContentInRow(y1, x1, x2)) { gap = 0; }
    else { gap++; if (gap > gapTolerance) { y1 += gap; break; } }
  }
  y1 = Math.max(y1, limitTop);

  for (let d = 0, gap = 0; d < maxExpand && y2 < limitBottom; d++) {
    y2++;
    if (y2 < h && hasContentInRow(y2 - 1, x1, x2)) { gap = 0; }
    else { gap++; if (gap > gapTolerance) { y2 -= gap; break; } }
  }
  y2 = Math.min(y2, limitBottom);

  for (let d = 0, gap = 0; d < maxExpand && x1 > limitLeft; d++) {
    x1--;
    if (hasContentInCol(x1, y1, y2)) { gap = 0; }
    else { gap++; if (gap > gapTolerance) { x1 += gap; break; } }
  }
  x1 = Math.max(x1, limitLeft);

  for (let d = 0, gap = 0; d < maxExpand && x2 < limitRight; d++) {
    x2++;
    if (x2 < w && hasContentInCol(x2 - 1, y1, y2)) { gap = 0; }
    else { gap++; if (gap > gapTolerance) { x2 -= gap; break; } }
  }
  x2 = Math.min(x2, limitRight);

  x1 = Math.max(limitTop > 0 ? limitLeft : 0, x1 - margin);
  y1 = Math.max(limitTop > 0 ? limitTop : 0, y1 - margin);
  x2 = Math.min(limitRight < w ? limitRight : w, x2 + margin);
  y2 = Math.min(limitBottom < h ? limitBottom : h, y2 + margin);

  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ── Fallback: simple foreground region detection (original approach) ──

function detectSimpleRegions(canvas: HTMLCanvasElement): Box[] {
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const visited = new Uint8Array(width * height);
  const boxes: Box[] = [];
  const stride = 2;
  const minBoxW = Math.max(80, Math.floor(width * 0.08));
  const minBoxH = Math.max(80, Math.floor(height * 0.08));
  const minArea = Math.max(16000, Math.floor(width * height * 0.005));

  const isFg = (x: number, y: number): boolean => {
    const p = (y * width + x) * 4;
    if (data[p + 3] < 20) return false;
    return !(data[p] > 245 && data[p + 1] > 245 && data[p + 2] > 245);
  };

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const idx = y * width + x;
      if (visited[idx] || !isFg(x, y)) continue;

      const qx: number[] = [x];
      const qy: number[] = [y];
      visited[idx] = 1;
      let head = 0, minX = x, maxX = x, minY = y, maxY = y, count = 0;

      while (head < qx.length) {
        const cx = qx[head], cy = qy[head];
        head++;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const [nx, ny] of [[cx + stride, cy], [cx - stride, cy], [cx, cy + stride], [cx, cy - stride]]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (visited[ni] || !isFg(nx, ny)) continue;
          visited[ni] = 1;
          qx.push(nx);
          qy.push(ny);
        }
      }

      const bw = maxX - minX + stride;
      const bh = maxY - minY + stride;
      if (bw < minBoxW || bh < minBoxH || count * stride * stride < minArea) continue;
      const pad = 8;
      boxes.push({
        x: Math.max(0, minX - pad),
        y: Math.max(0, minY - pad),
        width: Math.min(width - Math.max(0, minX - pad), bw + pad * 2),
        height: Math.min(height - Math.max(0, minY - pad), bh + pad * 2),
      });
    }
  }
  return boxes.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 8);
}

// ── Main entry ──

export async function extractImagesFromPdf(
  data: Uint8Array,
  onProgress: ProgressCallback,
): Promise<ExtractedImage[]> {
  let vis = 0;
  let target = 8;
  let label = "读取 PDF";
  const timer = window.setInterval(() => {
    if (vis < Math.min(target, 94)) {
      vis += 1;
      onProgress(vis, label);
    }
  }, 60);

  const setStage = (t: number, l: string) => {
    target = Math.max(target, t);
    label = l;
    onProgress(vis, label);
  };

  try {
    setStage(10, "读取 PDF");
    const doc = await loadPdfDocument(data);
    const results: ExtractedImage[] = [];
    const totalPages = doc.numPages;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pagePct = (p: number) => 10 + Math.floor(((pageNum - 1 + p) / totalPages) * 82);

      setStage(pagePct(0.05), `第 ${pageNum}/${totalPages} 页 · 渲染`);
      const page = await doc.getPage(pageNum);
      const baseVP = page.getViewport({ scale: 1 });

      const desiredScale = 3;
      const maxDim = 4000;
      const rawMax = Math.max(baseVP.width, baseVP.height) * desiredScale;
      const scale = rawMax > maxDim ? desiredScale * (maxDim / rawMax) : desiredScale;

      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const w = canvas.width;
      const h = canvas.height;
      const pdfWidthInches = baseVP.width / 72;
      const actualDPI = w / pdfWidthInches;
      const s = actualDPI / 300;

      const imageData = ctx.getImageData(0, 0, w, h);
      const grayOriginal = toGrayscale(imageData.data, w * h);
      const grayClean = new Uint8Array(grayOriginal);

      setStage(pagePct(0.15), `第 ${pageNum}/${totalPages} 页 · 检测色带`);
      const bands = detectColorBands(imageData.data, w, h);
      eraseBandsFromGray(grayClean, w, bands);

      await sleep(0);
      setStage(pagePct(0.3), `第 ${pageNum}/${totalPages} 页 · 检测表格线`);
      const binary = binaryThreshold(grayClean, 180);
      const hLineK = Math.max(5, Math.round(200 * s));
      const vLineK = Math.max(3, Math.round(40 * s));
      const hLines = binaryOpenH(binary, w, h, hLineK);

      await sleep(0);
      const vLines = binaryOpenV(binary, w, h, vLineK);

      await sleep(0);
      setStage(pagePct(0.5), `第 ${pageNum}/${totalPages} 页 · 识别信息条`);
      const infoBars = detectInfoBars(binary, hLines, vLines, grayClean, w, h, s);

      if (infoBars.length > 0) {
        setStage(pagePct(0.6), `第 ${pageNum}/${totalPages} 页 · 检测贴花元素`);
        const elements = detectElements(binary, w, h, infoBars, bands, s);

        await sleep(0);
        setStage(pagePct(0.7), `第 ${pageNum}/${totalPages} 页 · 元素配对`);
        const { groups, orphanElements, orphanInfoBars } = pairElementsToInfoBars(
          elements,
          infoBars,
          h,
        );

        setStage(pagePct(0.8), `第 ${pageNum}/${totalPages} 页 · 智能裁切`);

        const rawMerged: Box[] = [];
        for (const group of groups) {
          rawMerged.push(mergeBoxes([...group.elements, group.infoBar]));
        }
        for (const elem of orphanElements) {
          rawMerged.push(elem);
        }
        for (const bar of orphanInfoBars) {
          rawMerged.push(bar);
        }

        const allCropBoxes: { box: Box; sortKey: number }[] = [];

        for (let i = 0; i < rawMerged.length; i++) {
          const fences = computeFences(rawMerged, i, bands, w, h);
          const expanded = smartExpand(grayOriginal, w, h, rawMerged[i], fences, s);
          allCropBoxes.push({ box: expanded, sortKey: expanded.y * w + expanded.x });
        }

        allCropBoxes.sort((a, b) => a.sortKey - b.sortKey);

        for (const [idx, { box }] of allCropBoxes.entries()) {
          results.push({
            id: `page-${pageNum}-img-${idx + 1}`,
            pageNumber: pageNum,
            name: `P${pageNum}-img-${idx + 1}`,
            width: box.width,
            height: box.height,
            dataUrl: cropCanvasToDataUrl(canvas, box),
          });
        }
      } else {
        setStage(pagePct(0.6), `第 ${pageNum}/${totalPages} 页 · 区域检测（通用）`);
        const boxes = detectSimpleRegions(canvas);
        if (boxes.length === 0) {
          results.push({
            id: `page-${pageNum}-full`,
            pageNumber: pageNum,
            name: `P${pageNum}-full`,
            width: w,
            height: h,
            dataUrl: canvas.toDataURL("image/png"),
          });
        } else {
          boxes.forEach((box, idx) => {
            results.push({
              id: `page-${pageNum}-img-${idx + 1}`,
              pageNumber: pageNum,
              name: `P${pageNum}-img-${idx + 1}`,
              width: box.width,
              height: box.height,
              dataUrl: cropCanvasToDataUrl(canvas, box),
            });
          });
        }
      }

      await sleep(50);
    }

    setStage(96, "完成后处理");
    while (vis < 100) {
      vis++;
      onProgress(vis, "分解完成");
      await sleep(40);
    }
    return results;
  } finally {
    window.clearInterval(timer);
  }
}
