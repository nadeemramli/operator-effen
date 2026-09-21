import type { ParsedPage } from "./awb-import";

export async function readAwbPdf(
  file: File,
  fileId: string,
  progress: (page: number, total: number, ocr: boolean) => void,
  signal: AbortSignal,
  forceOcr = false,
) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  });
  const doc = await task.promise;
  let worker:
    | Awaited<ReturnType<typeof import("tesseract.js").createWorker>>
    | undefined;
  const abort = () => {
    void worker?.terminate();
    void task.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  const pages: ParsedPage[] = [];
  try {
    if (doc.numPages > 200) throw new Error("Use PDFs with up to 200 pages.");
    for (let i = 1; i <= doc.numPages; i++) {
      signal.throwIfAborted();
      progress(i, doc.numPages, false);
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const items = content.items.filter(
          (v): v is import("pdfjs-dist/types/src/display/api").TextItem =>
            "str" in v,
        );
        const grouped: { y: number; items: typeof items }[] = [];
        for (const item of items) {
          const y = item.transform[5];
          let line = grouped.find((l) => Math.abs(l.y - y) < 3);
          if (!line) {
            line = { y, items: [] };
            grouped.push(line);
          }
          line.items.push(item);
        }
        let text = grouped
          .sort((a, b) => b.y - a.y)
          .map((l) =>
            l.items
              .sort((a, b) => a.transform[4] - b.transform[4])
              .map((x) => x.str)
              .join(" "),
          )
          .join("\n");
        let method: "text" | "ocr" = "text";
        if (forceOcr || text.replace(/\s/g, "").length < 60) {
          method = "ocr";
          progress(i, doc.numPages, true);
          if (!worker) {
            const { createWorker } = await import("tesseract.js");
            worker = await createWorker("eng", 1, {
              workerPath: "/vendor/ocr/worker.min.js",
              corePath: "/vendor/ocr",
              langPath: "/vendor/ocr",
              workerBlobURL: false,
              cacheMethod: "none",
            });
          }
          signal.throwIfAborted();
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(
            2.5,
            Math.sqrt(5000000 / (base.width * base.height)),
          );
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            await page.render({ canvas, viewport }).promise;
            text = (await worker.recognize(canvas)).data.text;
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }
        pages.push({ file: fileId, page: i, text, method });
        page.cleanup();
      } catch (error) {
        signal.throwIfAborted();
        pages.push({
          file: fileId,
          page: i,
          text: "",
          method: "text",
          error: "Page could not be read; review original PDF",
        });
        if (error instanceof Error && /password/i.test(error.message))
          throw error;
      }
    }
    return { pages, pageCount: doc.numPages };
  } finally {
    signal.removeEventListener("abort", abort);
    await worker?.terminate();
    await task.destroy();
  }
}
