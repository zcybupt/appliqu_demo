export interface PdfPagePreview {
  pageNumber: number;
  width: number;
  height: number;
  dataUrl: string;
}

export interface ExtractedImage {
  id: string;
  pageNumber: number;
  name: string;
  width: number;
  height: number;
  dataUrl: string;
}

export interface SplitProgressState {
  value: number;
  label: string;
  active: boolean;
}

export interface DiffBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  width: number;
  height: number;
  diffPixels: number;
  boxes: DiffBox[];
  leftOverlayDataUrl: string;
  rightOverlayDataUrl: string;
  diffMaskDataUrl: string;
}
