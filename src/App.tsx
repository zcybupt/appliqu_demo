import { useMemo, useState } from "react";

import { diffImages } from "./features/compare/diffImages";
import { generateReportPdf } from "./features/export/generateReportPdf";
import { extractImagesFromPdf } from "./features/split/extractImagesFromPdf";
import { buildPdfPagePreviews, loadPdfDocument } from "./features/upload/loadPdfPreview";
import type { DiffResult, ExtractedImage, PdfPagePreview, SplitProgressState } from "./types";

function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("读取 PDF 失败。"));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.onerror = () => reject(new Error("读取 PDF 失败。"));
    reader.readAsArrayBuffer(file);
  });
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const safeBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([safeBuffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const EMPTY_PROGRESS: SplitProgressState = {
  value: 0,
  label: "等待开始",
  active: false,
};

export default function App() {
  const [pdfName, setPdfName] = useState<string>("");
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfPreviews, setPdfPreviews] = useState<PdfPagePreview[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [splitProgress, setSplitProgress] = useState<SplitProgressState>(EMPTY_PROGRESS);
  const [splitImages, setSplitImages] = useState<ExtractedImage[]>([]);
  const [selectedLeftId, setSelectedLeftId] = useState<string>("");
  const [selectedRightId, setSelectedRightId] = useState<string>("");
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const [selectedForDoc, setSelectedForDoc] = useState<string[]>([]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPdfUrl, setPreviewPdfUrl] = useState("");
  const [previewPdfBytes, setPreviewPdfBytes] = useState<Uint8Array | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [previewError, setPreviewError] = useState("");

  const imageMap = useMemo(
    () => new Map(splitImages.map((img) => [img.id, img])),
    [splitImages]
  );

  const selectedItemsForDoc = useMemo(
    () =>
      selectedForDoc
        .map((id) => imageMap.get(id))
        .filter((item): item is ExtractedImage => Boolean(item)),
    [imageMap, selectedForDoc]
  );

  const handleFileChange = async (file: File) => {
    setErrorMessage("");
    setDiffResult(null);
    setSplitImages([]);
    setSelectedForDoc([]);
    setDescriptions({});
    setSplitProgress(EMPTY_PROGRESS);
    if (previewPdfUrl) {
      URL.revokeObjectURL(previewPdfUrl);
    }
    setPreviewOpen(false);
    setPreviewPdfUrl("");
    setPreviewPdfBytes(null);
    setPreviewDirty(false);
    setPreviewError("");
    setLoadingPdf(true);

    try {
      const bytes = await readFileAsBytes(file);
      const doc = await loadPdfDocument(bytes);
      const previews = await buildPdfPagePreviews(doc);

      setPdfName(file.name);
      setPdfBytes(bytes);
      setPdfPreviews(previews);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载 PDF 失败。");
    } finally {
      setLoadingPdf(false);
    }
  };

  const loadSamplePdf = async () => {
    setErrorMessage("");
    setLoadingPdf(true);
    if (previewPdfUrl) {
      URL.revokeObjectURL(previewPdfUrl);
    }
    setPreviewOpen(false);
    setPreviewPdfUrl("");
    setPreviewPdfBytes(null);
    setPreviewDirty(false);
    setPreviewError("");
    try {
      const samplePath =
        "https://appliqu-1330656709.cos.ap-guangzhou.myqcloud.com/1-1%20201528-labelmap%20vietnam.pdf";
      const response = await fetch(samplePath);
      if (!response.ok) {
        throw new Error("未找到样例 PDF，请确认文件路径。");
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const doc = await loadPdfDocument(bytes);
      const previews = await buildPdfPagePreviews(doc);

      setPdfName("1-1 201528-labelmap vietnam.pdf");
      setPdfBytes(bytes);
      setPdfPreviews(previews);
      setSplitImages([]);
      setSelectedForDoc([]);
      setDescriptions({});
      setDiffResult(null);
      setSplitProgress(EMPTY_PROGRESS);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载样例 PDF 失败。");
    } finally {
      setLoadingPdf(false);
    }
  };

  const handleSplit = async () => {
    if (!pdfBytes) {
      setErrorMessage("请先上传 PDF。");
      return;
    }
    setErrorMessage("");
    setDiffResult(null);
    setSplitImages([]);
    if (previewPdfUrl) {
      URL.revokeObjectURL(previewPdfUrl);
    }
    setPreviewOpen(false);
    setPreviewPdfUrl("");
    setPreviewPdfBytes(null);
    setPreviewDirty(false);
    setPreviewError("");
    setSplitProgress({
      value: 1,
      label: "准备分解",
      active: true,
    });

    try {
      const images = await extractImagesFromPdf(pdfBytes, (value, label) => {
        setSplitProgress({
          value,
          label,
          active: value < 100,
        });
      });
      setSplitImages(images);
      setSelectedForDoc(images.map((img) => img.id));

      if (images.length >= 2) {
        setSelectedLeftId(images[0].id);
        setSelectedRightId(images[1].id);
      } else if (images.length === 1) {
        setSelectedLeftId(images[0].id);
        setSelectedRightId(images[0].id);
      } else {
        setSelectedLeftId("");
        setSelectedRightId("");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "分解失败。");
      setSplitProgress({
        value: 0,
        label: "分解失败",
        active: false,
      });
    }
  };

  const handleCompare = async () => {
    const left = imageMap.get(selectedLeftId);
    const right = imageMap.get(selectedRightId);
    if (!left || !right) {
      setErrorMessage("请先选择两张图片再进行对比。");
      return;
    }
    setErrorMessage("");
    try {
      const result = await diffImages(left.dataUrl, right.dataUrl);
      setDiffResult(result);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "图片对比失败。");
    }
  };

  const toggleDocSelection = (id: string) => {
    setSelectedForDoc((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      if (previewOpen) {
        setPreviewDirty(true);
      }
      return next;
    });
  };

  const buildReportBytes = async (): Promise<Uint8Array> => {
    return generateReportPdf(
      selectedItemsForDoc.map((image) => ({
        image,
        description: descriptions[image.id] ?? "",
      }))
    );
  };

  const refreshPreview = async (): Promise<Uint8Array | null> => {
    if (selectedItemsForDoc.length === 0) {
      setPreviewError("请选择至少一张图片生成文档。");
      return null;
    }
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const bytes = await buildReportBytes();
      const safeBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([safeBuffer], { type: "application/pdf" }));
      setPreviewPdfUrl((prev) => {
        if (prev) {
          URL.revokeObjectURL(prev);
        }
        return url;
      });
      setPreviewPdfBytes(bytes);
      setPreviewDirty(false);
      return bytes;
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "生成预览失败。");
      return null;
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (selectedItemsForDoc.length === 0) {
      setErrorMessage("请选择至少一张图片生成文档。");
      return;
    }
    setErrorMessage("");
    setPreviewOpen(true);
    setExporting(true);
    try {
      await refreshPreview();
    } finally {
      setExporting(false);
    }
  };

  const handleDownloadFromPreview = async () => {
    let bytes = previewPdfBytes;
    if (!bytes || previewDirty) {
      bytes = await refreshPreview();
    }
    if (bytes) {
      downloadBytes(bytes, "label-report.pdf");
    }
  };

  const closePreview = () => {
    if (previewPdfUrl) {
      URL.revokeObjectURL(previewPdfUrl);
    }
    setPreviewOpen(false);
    setPreviewPdfUrl("");
    setPreviewPdfBytes(null);
    setPreviewDirty(false);
    setPreviewError("");
  };

  const updateDescription = (id: string, value: string) => {
    setDescriptions((prev) => ({
      ...prev,
      [id]: value,
    }));
    if (previewOpen) {
      setPreviewDirty(true);
    }
  };

  return (
    <main className="app">
      <header className="header">
        <h1>React PDF 图像处理 Demo</h1>
        <p>上传 PDF，分解图片，对比差异，并导出图文 PDF（纯前端，无真实网络请求）。</p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>1) 上传并预览 PDF</h2>
          <div className="actions">
            <label className="btn">
              选择 PDF
              <input
                type="file"
                accept="application/pdf"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) {
                    void handleFileChange(file);
                  }
                }}
                hidden
              />
            </label>
            <button type="button" className="btn ghost" onClick={() => void loadSamplePdf()}>
              加载样例 PDF
            </button>
          </div>
        </div>
        <p className="muted">{pdfName ? `当前文件：${pdfName}` : "尚未选择 PDF 文件。"}</p>
        {loadingPdf ? <p className="muted">正在加载 PDF...</p> : null}
        <div className="preview-grid">
          {pdfPreviews.map((preview) => (
            <article key={preview.pageNumber} className="thumb-card">
              <img src={preview.dataUrl} alt={`page-${preview.pageNumber}`} />
              <span>Page {preview.pageNumber}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>2) 分解图片并平铺展示</h2>
          <button type="button" className="btn" disabled={!pdfBytes} onClick={() => void handleSplit()}>
            分解
          </button>
        </div>
        <div className="progress-wrap" aria-label="split-progress">
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${splitProgress.value}%` }} />
          </div>
          <span className="muted">
            {splitProgress.label} {splitProgress.value > 0 ? `${splitProgress.value}%` : ""}
          </span>
        </div>
        <div className="image-grid">
          {splitImages.map((img) => (
            <article key={img.id} className="image-card">
              <img src={img.dataUrl} alt={img.name} />
              <p>
                {img.name} ({img.width} x {img.height})
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>3) 选择两图自动对比</h2>
          <button type="button" className="btn" onClick={() => void handleCompare()} disabled={splitImages.length < 2}>
            对比
          </button>
        </div>
        <div className="compare-controls">
          <label>
            左图
            <select value={selectedLeftId} onChange={(e) => setSelectedLeftId(e.target.value)}>
              <option value="">请选择</option>
              {splitImages.map((img) => (
                <option value={img.id} key={`left-${img.id}`}>
                  {img.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            右图
            <select value={selectedRightId} onChange={(e) => setSelectedRightId(e.target.value)}>
              <option value="">请选择</option>
              {splitImages.map((img) => (
                <option value={img.id} key={`right-${img.id}`}>
                  {img.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {diffResult ? (
          <div className="compare-result">
            <article>
              <h3>左图差异圈选</h3>
              <img src={diffResult.leftOverlayDataUrl} alt="left-overlay" />
            </article>
            <article>
              <h3>右图差异圈选</h3>
              <img src={diffResult.rightOverlayDataUrl} alt="right-overlay" />
            </article>
            <article>
              <h3>差异掩膜</h3>
              <img src={diffResult.diffMaskDataUrl} alt="diff-mask" />
            </article>
            <p className="muted">检测到差异像素：{diffResult.diffPixels}；差异区域：{diffResult.boxes.length} 处。</p>
          </div>
        ) : (
          <p className="muted">请选择两张分解图后点击“对比”。</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>4) 生成图文 PDF 文档</h2>
          <button type="button" className="btn" onClick={() => void handleGenerate()} disabled={exporting}>
            {exporting ? "生成中..." : "预览并生成文档"}
          </button>
        </div>
        <p className="muted">可多选图片；每张图生成一页，包含对应描述。</p>
        <div className="doc-list">
          {splitImages.map((img) => (
            <article key={`doc-${img.id}`} className="doc-item">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={selectedForDoc.includes(img.id)}
                  onChange={() => toggleDocSelection(img.id)}
                />
                <span>{img.name}</span>
              </label>
              <img src={img.dataUrl} alt={`doc-${img.name}`} />
              <textarea
                placeholder="输入该图片的描述..."
                value={descriptions[img.id] ?? ""}
                onChange={(event) => updateDescription(img.id, event.target.value)}
              />
            </article>
          ))}
        </div>
      </section>

      {errorMessage ? <div className="error">{errorMessage}</div> : null}

      {previewOpen ? (
        <div className="preview-modal">
          <div className="preview-dialog">
            <div className="preview-head">
              <h3>文档预览</h3>
              <button type="button" className="btn ghost" onClick={closePreview}>
                关闭
              </button>
            </div>
            <div className="preview-body">
              <div className="preview-frame">
                {previewLoading ? (
                  <p className="muted">正在生成预览...</p>
                ) : previewPdfUrl ? (
                  <iframe title="pdf-preview" src={previewPdfUrl} />
                ) : (
                  <p className="muted">暂无预览内容。</p>
                )}
              </div>
              <div className="preview-editor">
                <p className="muted">可在此编辑文案，点击“刷新预览”查看新版排版。</p>
                <div className="preview-editor-list">
                  {selectedItemsForDoc.map((img) => (
                    <article key={`preview-editor-${img.id}`} className="preview-editor-item">
                      <p>{img.name}</p>
                      <textarea
                        value={descriptions[img.id] ?? ""}
                        onChange={(event) => updateDescription(img.id, event.target.value)}
                        placeholder="输入该图片对应描述..."
                      />
                    </article>
                  ))}
                </div>
                {previewDirty ? <p className="muted">描述已修改，请刷新预览。</p> : null}
                {previewError ? <p className="error inline-error">{previewError}</p> : null}
                <div className="actions">
                  <button type="button" className="btn ghost" onClick={() => void refreshPreview()} disabled={previewLoading}>
                    刷新预览
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleDownloadFromPreview()}
                    disabled={previewLoading}
                  >
                    下载 PDF
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
