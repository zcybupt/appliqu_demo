import html2canvas from "html2canvas";
import { PDFDocument } from "pdf-lib";

import templateImage from "../../../files/template.png";

const PAGE_SIZE: [number, number] = [595, 842];

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const [, base64] = dataUrl.split(",");
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("图片转换失败。"));
    };
    reader.onerror = () => reject(new Error("图片转换失败。"));
    reader.readAsDataURL(blob);
  });
}

async function srcToBytes(src: string): Promise<Uint8Array> {
  if (src.startsWith("data:")) {
    return dataUrlToBytes(src);
  }

  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`资源加载失败：${src}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function inlineCloneImages(source: HTMLElement, clone: HTMLElement): Promise<void> {
  const sourceImages = Array.from(source.querySelectorAll("img"));
  const cloneImages = Array.from(clone.querySelectorAll("img"));

  await Promise.all(
    cloneImages.map(async (cloneImage, index) => {
      const sourceImage = sourceImages[index];
      const src = sourceImage?.currentSrc || sourceImage?.getAttribute("src") || cloneImage.getAttribute("src");
      if (!src || src.startsWith("data:")) {
        return;
      }

      try {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`图片加载失败: ${src}`);
        }
        const dataUrl = await blobToDataUrl(await response.blob());
        cloneImage.setAttribute("src", dataUrl);
      } catch {
        cloneImage.setAttribute("crossorigin", "anonymous");
      }
    })
  );
}

async function createExportClone(
  element: HTMLElement,
  width: number,
  height: number
): Promise<HTMLElement> {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.position = "fixed";
  clone.style.left = "-10000px";
  clone.style.top = "0";
  clone.style.margin = "0";
  clone.style.zIndex = "-1";
  clone.style.pointerEvents = "none";
  clone.style.boxShadow = "none";
  clone.style.transform = "none";
  clone.style.contentVisibility = "visible";
  // Force explicit page dimensions so the clone doesn't collapse when detached from its parent
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.overflow = "hidden";

  document.body.appendChild(clone);
  await inlineCloneImages(element, clone);
  return clone;
}


async function waitForElementAssets(element: HTMLElement): Promise<void> {
  const images = Array.from(element.querySelectorAll("img"));
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }

          const finish = () => {
            image.removeEventListener("load", finish);
            image.removeEventListener("error", finish);
            resolve();
          };

          image.addEventListener("load", finish, { once: true });
          image.addEventListener("error", finish, { once: true });
        })
    )
  );

  if ("fonts" in document) {
    await document.fonts.ready;
  }

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export async function generateReportPdf(pageElements: HTMLElement[]): Promise<Uint8Array> {
  if (pageElements.length === 0) {
    throw new Error("请先生成 HTML 预览后再导出 PDF。");
  }

  const pdfDoc = await PDFDocument.create();
  const templateBytes = await srcToBytes(templateImage);
  const templatePng = await pdfDoc.embedPng(templateBytes);

  for (const element of pageElements) {
    const overlayElement = element.querySelector("[data-report-overlay]");
    if (!(overlayElement instanceof HTMLElement)) {
      throw new Error("HTML 预览结构不完整，缺少前景层。");
    }

    const [pageW, pageH] = PAGE_SIZE;
    const exportClone = await createExportClone(overlayElement, pageW, pageH);

    try {
      await waitForElementAssets(exportClone);

      const canvas = await html2canvas(exportClone, {
        backgroundColor: null,
        useCORS: true,
        logging: false,
        scale: 3,
        width: pageW,
        height: pageH,
        windowWidth: pageW,
        windowHeight: pageH,
      });

      const pngBytes = dataUrlToBytes(canvas.toDataURL("image/png"));
      const embeddedImage = await pdfDoc.embedPng(pngBytes);
      const page = pdfDoc.addPage(PAGE_SIZE);

      page.drawImage(templatePng, {
        x: 0,
        y: 0,
        width: PAGE_SIZE[0],
        height: PAGE_SIZE[1],
      });
      page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: PAGE_SIZE[0],
        height: PAGE_SIZE[1],
      });
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("HTML 转 PDF 失败，请确认预览中的图片已加载完成。");
    } finally {
      exportClone.remove();
    }
  }

  return pdfDoc.save();
}
