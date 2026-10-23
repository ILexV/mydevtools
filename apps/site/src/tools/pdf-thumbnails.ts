/**
 * PDF page thumbnails for the PDF Organizer: pdf.js (`pdfjs-dist`) is imported
 * lazily on first use, renders in its own worker, and draws one page at a time
 * into a canvas as the card scrolls into view. Thumbnails are a preview only —
 * page edits run in the pdf WASM; if pdf.js cannot open the file the tool
 * still works with numbered placeholders.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
  );
  pdfjsPromise.catch(() => {
    pdfjsPromise = null;
  });
  return pdfjsPromise;
}

export interface ThumbnailSource {
  /** Draw page `index` (0-based) into `canvas`, longest side `size` CSS px. */
  render(index: number, canvas: HTMLCanvasElement, size: number): Promise<void>;
  destroy(): void;
}

/** Open `data` (copied: pdf.js takes ownership of its buffer). Rejects when pdf.js cannot read the file. */
export async function openThumbnails(data: Uint8Array): Promise<ThumbnailSource> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: data.slice(),
    enableXfa: false,
    verbosity: 0,
  });
  const doc: PDFDocumentProxy = await task.promise;
  // One render at a time: dozens of visible cards must not decode in parallel.
  let queue: Promise<unknown> = Promise.resolve();
  let destroyed = false;
  return {
    render(index, canvas, size) {
      const job = queue.then(async () => {
        if (destroyed) return;
        const page = await doc.getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (size * ratio) / Math.max(base.width, base.height) });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        page.cleanup();
      });
      queue = job.catch(() => undefined);
      return job;
    },
    destroy() {
      destroyed = true;
      void task.destroy();
    },
  };
}
