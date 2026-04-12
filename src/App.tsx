import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { generateReportPdf } from "./features/export/generateReportPdf";
import { ReportTemplatePage } from "./features/export/ReportTemplatePage";
import { buildPdfPagePreviews, loadPdfDocument } from "./features/upload/loadPdfPreview";
import type {
  DiffResult,
  ExtractedImage,
  PdfPagePreview,
  ReportLayout,
  ReportFormValues,
  SplitProgressState,
} from "./types";

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

const EMPTY_PROGRESS: SplitProgressState = { value: 0, label: "等待开始", active: false };

const DECAL_BASE = "https://appliqu-1330656709.cos.ap-guangzhou.myqcloud.com/decals/";
const DEFAULT_REPORT_MODEL = "88081-YGK0214";

const DIFF_BASE = "https://appliqu-1330656709.cos.ap-guangzhou.myqcloud.com/diff/";
const SAMPLE_IMAGES = [
  { id: "sample-a", name: "sample A.png", url: `${DIFF_BASE}sample%20A.png` },
  { id: "sample-b", name: "sample B.png", url: `${DIFF_BASE}sample%20B.png` },
] as const;
const DIFF_RESULT_URL = `${DIFF_BASE}result.png`;
const DEFAULT_DECAL_TYPE = "机油瓶标贴";
const DEFAULT_MATERIAL = "铜版纸覆哑膜";

function buildDecalImages(): ExtractedImage[] {
  return Array.from({ length: 18 }, (_, i) => {
    const seq = String(i + 1).padStart(3, "0");
    const name = `corp_${seq}`;
    return {
      id: name,
      pageNumber: i + 1,
      name,
      width: 0,
      height: 0,
      dataUrl: `${DECAL_BASE}${name}.png`,
    };
  });
}

function buildDefaultReportForm(image: ExtractedImage): ReportFormValues {
  return {
    model: DEFAULT_REPORT_MODEL,
    decalName: image.name,
    decalType: DEFAULT_DECAL_TYPE,
    material: DEFAULT_MATERIAL,
    technicalRequirements: "",
  };
}

function buildDefaultReportLayout(): ReportLayout {
  return {
    image: { x: 0, y: 0 },
    technical: { x: 0, y: 0 },
  };
}

export default function App() {
  const [pdfName, setPdfName] = useState<string>("");
  const [pdfPreviews, setPdfPreviews] = useState<PdfPagePreview[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [splitProgress, setSplitProgress] = useState<SplitProgressState>(EMPTY_PROGRESS);
  const [splitImages, setSplitImages] = useState<ExtractedImage[]>([]);
  const [selectedLeftId, setSelectedLeftId] = useState<string>("");
  const [selectedRightId, setSelectedRightId] = useState<string>("");
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [selectedForDoc, setSelectedForDoc] = useState<string[]>([]);
  const [reportForms, setReportForms] = useState<Record<string, ReportFormValues>>({});
  const [reportLayouts, setReportLayouts] = useState<Record<string, ReportLayout>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const previewPageRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const openLightbox = useCallback((src: string, alt: string) => setLightbox({ src, alt }), []);
  const closeLightbox = useCallback(() => setLightbox(null), []);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeLightbox(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, closeLightbox]);

  useEffect(() => {
    const locked = previewOpen || lightbox !== null;
    document.body.style.overflow = locked ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [previewOpen, lightbox]);

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

  const selectedReportItems = useMemo(
    () =>
      selectedItemsForDoc.map((image) => ({
        image,
        ...buildDefaultReportForm(image),
        ...(reportForms[image.id] ?? {}),
      })),
    [reportForms, selectedItemsForDoc]
  );

  const allDocSelected = splitImages.length > 0 && selectedForDoc.length === splitImages.length;

  const handleFileChange = async (file: File) => {
    setErrorMessage("");
    setDiffResult(null);
    setSplitImages([]);
    setSelectedForDoc([]);
    setReportForms({});
    setReportLayouts({});
    setSplitProgress(EMPTY_PROGRESS);
    setPreviewOpen(false);
    setPreviewError("");
    setLoadingPdf(true);

    try {
      const bytes = await readFileAsBytes(file);
      const doc = await loadPdfDocument(bytes);
      const previews = await buildPdfPagePreviews(doc);

      setPdfName(file.name);
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
    setPreviewOpen(false);
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
      setPdfPreviews(previews);
      setSplitImages([]);
      setSelectedForDoc([]);
      setReportForms({});
      setReportLayouts({});
      setDiffResult(null);
      setSplitProgress(EMPTY_PROGRESS);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载样例 PDF 失败。");
    } finally {
      setLoadingPdf(false);
    }
  };

  const handleSplit = async () => {
    setErrorMessage("");
    setDiffResult(null);
    setSplitImages([]);
    setPreviewOpen(false);
    setPreviewError("");

    const steps = [
      { value: 10, label: "准备分解" },
      { value: 30, label: "识别图层" },
      { value: 55, label: "提取图像" },
      { value: 80, label: "处理输出" },
      { value: 100, label: "分解完成" },
    ];

    for (const step of steps) {
      setSplitProgress({ ...step, active: step.value < 100 });
      await new Promise<void>((r) => setTimeout(r, 1200));
    }

    const images = buildDecalImages();
    setSplitImages(images);
    setSelectedForDoc([]);
    setReportForms({});
    setReportLayouts({});
    setSelectedLeftId("");
    setSelectedRightId("");
  };

  const handleCompare = () => {
    if (!selectedLeftId || !selectedRightId) {
      setErrorMessage("请先选择两张图片再进行对比。");
      return;
    }
    if (selectedLeftId === selectedRightId) {
      setErrorMessage("请选择不同的两张图片进行对比。");
      return;
    }
    setErrorMessage("");
    setDiffResult({
      width: 0,
      height: 0,
      diffPixels: 0,
      boxes: [],
      leftOverlayDataUrl: "",
      rightOverlayDataUrl: "",
      diffMaskDataUrl: DIFF_RESULT_URL,
    });
  };

  const toggleDocSelection = (id: string) => {
    setSelectedForDoc((prev) => {
      return prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
    });
  };

  const toggleSelectAllForDoc = () => {
    setSelectedForDoc(allDocSelected ? [] : splitImages.map((img) => img.id));
  };

  const buildReportBytes = async (): Promise<Uint8Array> => {
    const pageElements = selectedReportItems.map((item) => previewPageRefs.current[item.image.id]);
    if (pageElements.some((element) => element == null)) {
      throw new Error("HTML 预览尚未准备完成，请稍后重试。");
    }

    return generateReportPdf(pageElements as HTMLElement[]);
  };

  const handleGenerate = async () => {
    if (selectedItemsForDoc.length === 0) {
      setErrorMessage("请选择至少一张图片生成文档。");
      return;
    }
    setErrorMessage("");
    setPreviewError("");
    setPreviewOpen(true);
  };

  const handleDownloadFromPreview = async () => {
    if (selectedReportItems.length === 0) {
      setPreviewError("请选择至少一张图片生成文档。");
      return;
    }

    setPreviewError("");
    setPreviewLoading(true);
    try {
      const bytes = await buildReportBytes();
      downloadBytes(bytes, "label-report.pdf");
    } catch (error) {
      setPreviewError(
        error instanceof Error ? error.message : "生成 PDF 失败，请确认 HTML 预览已经完整显示。"
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewOpen(false);
    setPreviewError("");
  };

  const updateReportField = <K extends keyof ReportFormValues>(
    id: string,
    field: K,
    value: ReportFormValues[K]
  ) => {
    const image = imageMap.get(id);
    if (!image) return;

    setReportForms((prev) => ({
      ...prev,
      [id]: {
        ...buildDefaultReportForm(image),
        ...(prev[id] ?? {}),
        [field]: value,
      },
    }));
  };

  const setPreviewPageRef = useCallback((id: string, node: HTMLDivElement | null) => {
    previewPageRefs.current[id] = node;
  }, []);

  const updateReportLayout = useCallback((id: string, next: ReportLayout) => {
    setReportLayouts((prev) => ({
      ...prev,
      [id]: next,
    }));
  }, []);

  const resetReportLayout = useCallback((id: string) => {
    setReportLayouts((prev) => ({
      ...prev,
      [id]: buildDefaultReportLayout(),
    }));
  }, []);

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
            <article
              key={preview.pageNumber}
              className="thumb-card clickable"
              onClick={() => openLightbox(preview.dataUrl, `Page ${preview.pageNumber}`)}
            >
              <img src={preview.dataUrl} alt={`page-${preview.pageNumber}`} />
              <span>Page {preview.pageNumber}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>2) 分解图片并平铺展示</h2>
          <button type="button" className="btn" disabled={splitProgress.active} onClick={() => void handleSplit()}>
            {splitProgress.active ? "分解中..." : "分解"}
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
            <article
              key={img.id}
              className="image-card clickable"
              onClick={() => openLightbox(img.dataUrl, img.name)}
            >
              <img src={img.dataUrl} alt={img.name} />
              <p>{img.name}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>3) 选择两图自动对比</h2>
          <button type="button" className="btn" onClick={handleCompare}>
            对比
          </button>
        </div>
        <div className="compare-controls">
          <label>
            左图
            <select value={selectedLeftId} onChange={(e) => setSelectedLeftId(e.target.value)}>
              <option value="">请选择图片</option>
              {SAMPLE_IMAGES.map((img) => (
                <option value={img.id} key={`left-${img.id}`}>
                  {img.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            右图
            <select value={selectedRightId} onChange={(e) => setSelectedRightId(e.target.value)}>
              <option value="">请选择图片</option>
              {SAMPLE_IMAGES.map((img) => (
                <option value={img.id} key={`right-${img.id}`}>
                  {img.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="compare-previews">
          {selectedLeftId || selectedRightId ? (
            SAMPLE_IMAGES.filter((img) => img.id === selectedLeftId || img.id === selectedRightId).map((img) => (
              <article key={img.id} className="image-card clickable" onClick={() => openLightbox(img.url, img.name)}>
                <img src={img.url} alt={img.name} />
                <p>{img.name}</p>
              </article>
            ))
          ) : (
            <p className="muted">请选择左图和右图后再预览。</p>
          )}
        </div>
        {diffResult ? (
          <div className="compare-result">
            <article className="compare-result-full">
              <h3>对比结果</h3>
              <img
                src={diffResult.diffMaskDataUrl}
                alt="diff-result"
                className="clickable"
                onClick={() => openLightbox(diffResult.diffMaskDataUrl, "对比结果")}
              />
            </article>
          </div>
        ) : (
          <p className="muted">请选择两张图片后点击"对比"。</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>4) 生成图文 PDF 文档</h2>
          <div className="actions">
            {splitImages.length > 0 ? (
              <button type="button" className="btn ghost" onClick={toggleSelectAllForDoc}>
                {allDocSelected ? "取消全选" : "全选"}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => void handleGenerate()}>
              HTML 预览并生成文档
            </button>
          </div>
        </div>
        <p className="muted">不默认全选。每张图可填写型号、贴花名称、贴花类型、材料和技术要求，再套用模板生成 PDF。</p>
        <div className="doc-list">
          {splitImages.map((img) => {
            const formValues = {
              ...buildDefaultReportForm(img),
              ...(reportForms[img.id] ?? {}),
            };

            return (
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
                <div className="doc-fields">
                  <label>
                    型号
                    <input
                      type="text"
                      value={formValues.model}
                      onChange={(event) => updateReportField(img.id, "model", event.target.value)}
                    />
                  </label>
                  <label>
                    贴花名称
                    <input
                      type="text"
                      value={formValues.decalName}
                      onChange={(event) => updateReportField(img.id, "decalName", event.target.value)}
                    />
                  </label>
                  <label>
                    贴花类型
                    <input
                      type="text"
                      value={formValues.decalType}
                      onChange={(event) => updateReportField(img.id, "decalType", event.target.value)}
                    />
                  </label>
                  <label>
                    材料
                    <input
                      type="text"
                      value={formValues.material}
                      onChange={(event) => updateReportField(img.id, "material", event.target.value)}
                    />
                  </label>
                </div>
                <label className="doc-textarea">
                  技术要求
                  <textarea
                    placeholder="输入该图片对应的技术要求..."
                    value={formValues.technicalRequirements}
                    onChange={(event) =>
                      updateReportField(img.id, "technicalRequirements", event.target.value)
                    }
                  />
                </label>
              </article>
            );
          })}
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
                  <p className="muted">正在根据 HTML 预览生成 PDF...</p>
                ) : selectedReportItems.length > 0 ? (
                  <div className="preview-page-stack">
                    {selectedReportItems.map((item, index) => (
                      <ReportTemplatePage
                        key={`preview-page-${item.image.id}`}
                        ref={(node) => setPreviewPageRef(item.image.id, node)}
                        item={item}
                        pageIndex={index}
                        totalPages={selectedReportItems.length}
                        layout={reportLayouts[item.image.id] ?? buildDefaultReportLayout()}
                        onLayoutChange={(next) => updateReportLayout(item.image.id, next)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="muted">暂无 HTML 预览内容。</p>
                )}
              </div>
              <div className="preview-editor">
                <p className="muted">左侧是实时 HTML 预览，下载 PDF 时会按左侧内容生成。</p>
                <div className="preview-editor-list">
                  {selectedReportItems.map((item) => (
                    <article key={`preview-editor-${item.image.id}`} className="preview-editor-item">
                      <p>{item.image.name}</p>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => resetReportLayout(item.image.id)}
                        >
                          重置图片和技术要求位置
                        </button>
                      </div>
                      <div className="preview-editor-fields">
                        <label>
                          型号
                          <input
                            type="text"
                            value={item.model}
                            onChange={(event) => updateReportField(item.image.id, "model", event.target.value)}
                          />
                        </label>
                        <label>
                          贴花名称
                          <input
                            type="text"
                            value={item.decalName}
                            onChange={(event) =>
                              updateReportField(item.image.id, "decalName", event.target.value)
                            }
                          />
                        </label>
                        <label>
                          贴花类型
                          <input
                            type="text"
                            value={item.decalType}
                            onChange={(event) =>
                              updateReportField(item.image.id, "decalType", event.target.value)
                            }
                          />
                        </label>
                        <label>
                          材料
                          <input
                            type="text"
                            value={item.material}
                            onChange={(event) => updateReportField(item.image.id, "material", event.target.value)}
                          />
                        </label>
                      </div>
                      <label className="doc-textarea">
                        技术要求
                        <textarea
                          value={item.technicalRequirements}
                          onChange={(event) =>
                            updateReportField(item.image.id, "technicalRequirements", event.target.value)
                          }
                          placeholder="输入该图片对应技术要求..."
                        />
                      </label>
                    </article>
                  ))}
                </div>
                {previewError ? <p className="error inline-error">{previewError}</p> : null}
                <div className="actions">
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
      {lightbox ? (
        <div className="lightbox-overlay" onClick={closeLightbox} role="dialog" aria-modal="true">
          <button className="lightbox-close" onClick={closeLightbox} aria-label="关闭">✕</button>
          <img
            className="lightbox-img"
            src={lightbox.src}
            alt={lightbox.alt}
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.alt ? <p className="lightbox-caption">{lightbox.alt}</p> : null}
        </div>
      ) : null}
    </main>
  );
}
