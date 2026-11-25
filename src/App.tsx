import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { createWorker, type Worker as TesseractWorker } from "tesseract.js";
import type { PDFDocument } from "pdf-lib";
import {
  FileUp,
  FileText,
  Sparkles,
  ScanText,
  Layers,
  Play,
  Square as StopIcon,
  AlertTriangle,
  Archive,
  X,
  MessageCircle,
  ArrowUpRight,
} from "lucide-react";
import {
  DEFAULT_UPPER_LEFT_RECT,
  type ExtractionEngine,
  type NamingConfig,
  type NormalizedRect,
  type PageRecord,
} from "./types/pdf";
import {
  extractTextInNormalizedRect,
  generateSampleMultiPagePdf,
  loadPdfDocuments,
  renderCompositeSheetForBatch,
  renderCroppedRegionToDataUrl,
  splitSinglePagePdf,
  type PdfJsDocument,
} from "./utils/pdfEngine";
import {
  buildUniqueFilenames,
  cleanExtractedPersonName,
  formatBytes,
} from "./utils/naming";
import { ZoneInspector } from "./components/ZoneInspector";
import { NamingAndTablePanel } from "./components/NamingAndTablePanel";

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ocrWorkerRef = useRef<TesseractWorker | null>(null);
  const abortBatchRef = useRef<boolean>(false);

  const [pdfJsDoc, setPdfJsDoc] = useState<PdfJsDocument | null>(null);
  const [pdfLibDoc, setPdfLibDoc] = useState<PDFDocument | null>(null);
  const [originalFileName, setOriginalFileName] = useState<string>("");
  const [originalFileSize, setOriginalFileSize] = useState<number>(0);

  const [pages, setPages] = useState<PageRecord[]>([]);
  const [activePage, setActivePage] = useState<number>(1);
  const [rect, setRect] = useState<NormalizedRect>(DEFAULT_UPPER_LEFT_RECT);

  const [engine, setEngine] = useState<ExtractionEngine>("hybrid");
  const [aiModel, setAiModel] = useState<"auto" | "gemini-4-hydrogen" | "gemini-3.1-flash-lite">("auto");
  const [aiHint, setAiHint] = useState<string>("");
  const [aiUseFullPage, setAiUseFullPage] = useState<boolean>(false);
  const [skipNamedPages, setSkipNamedPages] = useState<boolean>(false);

  const [namingConfig, setNamingConfig] = useState<NamingConfig>({
    template: "{nombre}",
    caseMode: "original",
    stripAccents: false,
    replaceSpaces: true,
    fallbackPrefix: "Pagina",
  });

  const [isLoadingFile, setIsLoadingFile] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [isBatchRunning, setIsBatchRunning] = useState<boolean>(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isQuotaError, setIsQuotaError] = useState<boolean>(false);

  useEffect(() => {
    return () => {
      if (ocrWorkerRef.current) {
        ocrWorkerRef.current.terminate().catch(() => {});
        ocrWorkerRef.current = null;
      }
    };
  }, []);

  const getOrCreateOcrWorker = useCallback(async (): Promise<TesseractWorker> => {
    if (ocrWorkerRef.current) return ocrWorkerRef.current;
    const worker = await createWorker("spa+eng");
    ocrWorkerRef.current = worker;
    return worker;
  }, []);

  const ingestPdfBuffer = useCallback(
    async (buffer: ArrayBuffer, fileName: string, fileSize: number) => {
      setErrorBanner(null);
      setIsLoadingFile(true);
      abortBatchRef.current = true;
      setIsBatchRunning(false);

      try {
        const { pdfJsDoc: jsDoc, pdfLibDoc: libDoc, numPages } =
          await loadPdfDocuments(buffer);

        const initialPages: PageRecord[] = Array.from({ length: numPages }, (_, i) => ({
          pageNumber: i + 1,
          selected: true,
          extractedName: "",
          rawText: "",
          confidence: "none",
          source: "none",
          status: "pending",
        }));

        // Split individual PDFs and run fast native text check in the default upper-left zone
        const updatedPages = [...initialPages];
        const CHUNK = 6;
        for (let start = 0; start < numPages; start += CHUNK) {
          const sliceIndices = Array.from(
            { length: Math.min(CHUNK, numPages - start) },
            (_, k) => start + k
          );

          await Promise.all(
            sliceIndices.map(async (idx) => {
              const pageNumber = idx + 1;
              const [pdfBytes, textResult] = await Promise.all([
                splitSinglePagePdf(libDoc, idx),
                extractTextInNormalizedRect(jsDoc, pageNumber, rect),
              ]);

              const hasName = textResult.cleanedName.length > 0;
              updatedPages[idx] = {
                ...updatedPages[idx],
                pdfBytes,
                sizeBytes: pdfBytes.byteLength,
                extractedName: textResult.cleanedName,
                rawText: textResult.rawText,
                source: hasName ? "pdf-text" : "none",
                confidence: hasName ? "high" : "none",
                status: hasName ? "done" : "empty",
              };
            })
          );
        }

        setPdfJsDoc(jsDoc);
        setPdfLibDoc(libDoc);
        setOriginalFileName(fileName);
        setOriginalFileSize(fileSize);
        setPages(updatedPages);
        setActivePage(1);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : "No se pudo abrir el archivo PDF. Verifica que no esté dañado o protegido.";
        setErrorBanner(msg);
      } finally {
        setIsLoadingFile(false);
      }
    },
    [rect]
  );

  const handleFileSelected = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return;
      if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
        setErrorBanner("Por favor selecciona un archivo con extensión .pdf válido.");
        return;
      }
      const buffer = await file.arrayBuffer();
      await ingestPdfBuffer(buffer, file.name, file.size);
    },
    [ingestPdfBuffer]
  );

  const handleLoadSamplePdf = useCallback(async () => {
    setErrorBanner(null);
    setIsLoadingFile(true);
    try {
      const { bytes, fileName } = await generateSampleMultiPagePdf();
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      await ingestPdfBuffer(buffer, fileName, bytes.byteLength);
    } catch {
      setErrorBanner("No se pudo generar el PDF de demostración.");
      setIsLoadingFile(false);
    }
  }, [ingestPdfBuffer]);

  const extractSinglePage = useCallback(
    async (
      jsDoc: PdfJsDocument,
      pageNumber: number,
      targetRect: NormalizedRect,
      selectedEngine: ExtractionEngine,
      hint: string,
      fullPageForAi: boolean
    ): Promise<Partial<PageRecord>> => {
      if (selectedEngine === "hybrid") {
        const native = await extractTextInNormalizedRect(jsDoc, pageNumber, targetRect);
        if (native.cleanedName.length > 0) {
          return {
            extractedName: native.cleanedName,
            rawText: native.rawText,
            source: "pdf-text",
            confidence: "high",
            status: "done",
            errorMessage: undefined,
          };
        }
      }

      if (selectedEngine === "hybrid" || selectedEngine === "ocr") {
        const { dataUrl } = await renderCroppedRegionToDataUrl(jsDoc, pageNumber, targetRect, {
          scale: 2.6,
          enhanceForOcr: true,
        });
        const worker = await getOrCreateOcrWorker();
        const ocrRes = await worker.recognize(dataUrl);
        const rawText = (ocrRes.data.text ?? "").trim();
        const cleaned = cleanExtractedPersonName(rawText);
        return {
          extractedName: cleaned,
          rawText,
          source: "ocr",
          confidence: cleaned ? "medium" : "none",
          status: cleaned ? "done" : "empty",
          errorMessage: undefined,
        };
      }

      // AI Gemini engine (server-side route)
      const { dataUrl } = await renderCroppedRegionToDataUrl(jsDoc, pageNumber, targetRect, {
        fullPage: fullPageForAi,
        scale: fullPageForAi ? 1.5 : 2.2,
        mimeType: "image/jpeg",
        quality: 0.86,
      });

      const response = await fetch("/api/extract-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: dataUrl,
          mimeType: "image/jpeg",
          customHint: hint,
          pageNumber,
          isFullPage: fullPageForAi,
          preferredModel: aiModel,
        }),
      });

      const payload = (await response.json()) as {
        fullName?: string;
        rawText?: string;
        confidence?: "high" | "medium" | "low" | "none";
        error?: string;
        code?: string;
      };

      if (!response.ok) {
        if (response.status === 429 || payload.code === "RESOURCE_EXHAUSTED") {
          setIsQuotaError(true);
        }
        throw new Error(
          payload.error || `Error ${response.status} al analizar la página con IA.`
        );
      }

      const fullName = (payload.fullName ?? "").trim();
      return {
        extractedName: fullName,
        rawText: payload.rawText ?? "",
        source: "ai",
        confidence: fullName ? payload.confidence ?? "high" : "none",
        status: fullName ? "done" : "empty",
        errorMessage: undefined,
      };
    },
    [getOrCreateOcrWorker, aiModel]
  );

  const handleDetectSinglePage = useCallback(
    async (pageNumber: number) => {
      if (!pdfJsDoc) return;
      setErrorBanner(null);
      setPages((prev) =>
        prev.map((p) =>
          p.pageNumber === pageNumber
            ? { ...p, status: "processing", errorMessage: undefined }
            : p
        )
      );

      try {
        const result = await extractSinglePage(
          pdfJsDoc,
          pageNumber,
          rect,
          engine,
          aiHint,
          aiUseFullPage
        );
        setPages((prev) =>
          prev.map((p) => (p.pageNumber === pageNumber ? { ...p, ...result } : p))
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Error al analizar la página.";
        setErrorBanner(msg);
        setPages((prev) =>
          prev.map((p) =>
            p.pageNumber === pageNumber
              ? { ...p, status: "error", errorMessage: msg }
              : p
          )
        );
      }
    },
    [pdfJsDoc, rect, engine, aiHint, aiUseFullPage, extractSinglePage]
  );

  const runDetectionForEngine = useCallback(
    async (targetEngine: ExtractionEngine, onlyUnnamed: boolean) => {
      if (!pdfJsDoc || pages.length === 0) return;

      const targetPages = onlyUnnamed
        ? pages.filter((p) => !p.extractedName.trim())
        : pages;

      if (targetPages.length === 0) {
        setErrorBanner("Todas las páginas ya tienen un nombre asignado.");
        return;
      }

      setErrorBanner(null);
      setIsQuotaError(false);
      abortBatchRef.current = false;
      setIsBatchRunning(true);
      setBatchProgress({ done: 0, total: targetPages.length });

      let completed = 0;

      try {
        if (targetEngine === "ai") {
          // Composite sheet packs up to 16 zone crops into ONE single API request
          const batchSize = aiUseFullPage ? 6 : 16;

          for (let i = 0; i < targetPages.length; i += batchSize) {
            if (abortBatchRef.current) break;

            const batchNums = targetPages
              .slice(i, i + batchSize)
              .map((p) => p.pageNumber);

            setPages((prev) =>
              prev.map((p) =>
                batchNums.includes(p.pageNumber)
                  ? { ...p, status: "processing", errorMessage: undefined }
                  : p
              )
            );

            try {
              let response: Response;
              if (!aiUseFullPage) {
                const { dataUrl, mimeType } = await renderCompositeSheetForBatch(
                  pdfJsDoc,
                  batchNums,
                  rect
                );
                if (abortBatchRef.current) break;
                response = await fetch("/api/extract-names-sheet", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    sheetBase64: dataUrl,
                    mimeType,
                    pageNumbers: batchNums,
                    customHint: aiHint,
                    preferredModel: aiModel,
                  }),
                });
              } else {
                const prepared = await Promise.all(
                  batchNums.map(async (pageNum) => {
                    const { dataUrl } = await renderCroppedRegionToDataUrl(
                      pdfJsDoc,
                      pageNum,
                      rect,
                      {
                        fullPage: true,
                        scale: 1.35,
                        mimeType: "image/jpeg",
                        quality: 0.82,
                      }
                    );
                    return {
                      pageNumber: pageNum,
                      imageBase64: dataUrl,
                      mimeType: "image/jpeg",
                    };
                  })
                );
                if (abortBatchRef.current) break;
                response = await fetch("/api/extract-names-batch", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    pages: prepared,
                    customHint: aiHint,
                    isFullPage: true,
                    preferredModel: aiModel,
                  }),
                });
              }

              const payload = (await response.json()) as {
                results?: Array<{
                  pageNumber: number;
                  fullName?: string;
                  rawText?: string;
                  confidence?: "high" | "medium" | "low" | "none";
                }>;
                error?: string;
                code?: string;
              };

              if (!response.ok) {
                const quotaHit =
                  response.status === 429 || payload.code === "RESOURCE_EXHAUSTED";
                if (quotaHit) {
                  setIsQuotaError(true);
                }
                const errMsg =
                  payload.error ||
                  `Error ${response.status} al analizar el lote con IA.`;
                setErrorBanner(errMsg);
                setPages((prev) =>
                  prev.map((p) =>
                    batchNums.includes(p.pageNumber)
                      ? { ...p, status: "error", errorMessage: errMsg }
                      : p
                  )
                );
                if (quotaHit || response.status === 403 || response.status === 401) {
                  break;
                }
              } else {
                const resultMap = new Map(
                  (payload.results ?? []).map((r) => [r.pageNumber, r])
                );
                setPages((prev) =>
                  prev.map((p) => {
                    if (!batchNums.includes(p.pageNumber)) return p;
                    const match = resultMap.get(p.pageNumber);
                    const fullName = (match?.fullName ?? "").trim();
                    return {
                      ...p,
                      extractedName: fullName,
                      rawText: match?.rawText ?? "",
                      source: "ai",
                      confidence: fullName ? match?.confidence ?? "high" : "none",
                      status: fullName ? "done" : "empty",
                      errorMessage: undefined,
                    };
                  })
                );
              }
            } catch (err: unknown) {
              const msg =
                err instanceof Error ? err.message : "Error de red al procesar con IA.";
              setErrorBanner((prevErr) => prevErr ?? msg);
              setPages((prev) =>
                prev.map((p) =>
                  batchNums.includes(p.pageNumber)
                    ? { ...p, status: "error", errorMessage: msg }
                    : p
                )
              );
            } finally {
              completed += batchNums.length;
              setBatchProgress({ done: completed, total: targetPages.length });
            }
          }
          return;
        }

        const concurrency = targetEngine === "ocr" ? 1 : 4;
        for (let i = 0; i < targetPages.length; i += concurrency) {
          if (abortBatchRef.current) break;

          const batchIndices = targetPages
            .slice(i, i + concurrency)
            .map((p) => p.pageNumber);

          setPages((prev) =>
            prev.map((p) =>
              batchIndices.includes(p.pageNumber)
                ? { ...p, status: "processing", errorMessage: undefined }
                : p
            )
          );

          await Promise.all(
            batchIndices.map(async (pageNum) => {
              if (abortBatchRef.current) return;
              try {
                const res = await extractSinglePage(
                  pdfJsDoc,
                  pageNum,
                  rect,
                  targetEngine,
                  aiHint,
                  aiUseFullPage
                );
                setPages((prev) =>
                  prev.map((p) => (p.pageNumber === pageNum ? { ...p, ...res } : p))
                );
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : "Error en extracción";
                setErrorBanner((prevErr) => prevErr ?? msg);
                setPages((prev) =>
                  prev.map((p) =>
                    p.pageNumber === pageNum
                      ? { ...p, status: "error", errorMessage: msg }
                      : p
                  )
                );
              } finally {
                completed += 1;
                setBatchProgress({ done: completed, total: targetPages.length });
              }
            })
          );
        }
      } finally {
        setIsBatchRunning(false);
      }
    },
    [pdfJsDoc, pages, rect, aiHint, aiUseFullPage, aiModel, extractSinglePage]
  );

  const handleRunBatchDetection = useCallback(() => {
    runDetectionForEngine(engine, skipNamedPages);
  }, [runDetectionForEngine, engine, skipNamedPages]);

  const handleRunLocalOcrFallback = useCallback(() => {
    setEngine("ocr");
    setErrorBanner(null);
    setIsQuotaError(false);
    runDetectionForEngine("ocr", true);
  }, [runDetectionForEngine]);

  const handleStopBatch = () => {
    abortBatchRef.current = true;
  };

  const filenameMap = useMemo(
    () => buildUniqueFilenames(pages, pages.length, originalFileName, namingConfig),
    [pages, originalFileName, namingConfig]
  );

  const handleDownloadSinglePdf = useCallback(
    async (pageNumber: number) => {
      const target = pages.find((p) => p.pageNumber === pageNumber);
      if (!target) return;

      let bytes = target.pdfBytes;
      if (!bytes && pdfLibDoc) {
        bytes = await splitSinglePagePdf(pdfLibDoc, pageNumber - 1);
      }
      if (!bytes) return;

      const outName = filenameMap.get(pageNumber) ?? `Pagina_${pageNumber}.pdf`;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      triggerBlobDownload(new Blob([copy], { type: "application/pdf" }), outName);
    },
    [pages, pdfLibDoc, filenameMap]
  );

  const handleDownloadZip = useCallback(async () => {
    const selectedPages = pages.filter((p) => p.selected);
    if (selectedPages.length === 0) return;

    setIsExportingZip(true);
    setErrorBanner(null);

    try {
      const zip = new JSZip();
      for (const page of selectedPages) {
        let bytes = page.pdfBytes;
        if (!bytes && pdfLibDoc) {
          bytes = await splitSinglePagePdf(pdfLibDoc, page.pageNumber - 1);
        }
        if (!bytes) continue;
        const filename = filenameMap.get(page.pageNumber) ?? `Pagina_${page.pageNumber}.pdf`;
        zip.file(filename, bytes);
      }

      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      const baseOriginal =
        originalFileName.replace(/\.pdf$/i, "").trim() || "documentos";
      triggerBlobDownload(zipBlob, `${baseOriginal}_dividido.zip`);
    } catch {
      setErrorBanner("Ocurrió un error al empaquetar los archivos PDF en el ZIP.");
    } finally {
      setIsExportingZip(false);
    }
  }, [pages, pdfLibDoc, filenameMap, originalFileName]);

  const handleTogglePageSelection = useCallback((pageNumber: number) => {
    setPages((prev) =>
      prev.map((p) =>
        p.pageNumber === pageNumber ? { ...p, selected: !p.selected } : p
      )
    );
  }, []);

  const handleToggleAllVisible = useCallback(
    (visibleNumbers: number[], select: boolean) => {
      const visibleSet = new Set(visibleNumbers);
      setPages((prev) =>
        prev.map((p) =>
          visibleSet.has(p.pageNumber) ? { ...p, selected: select } : p
        )
      );
    },
    []
  );

  const handleUpdatePageName = useCallback((pageNumber: number, newName: string) => {
    setPages((prev) =>
      prev.map((p) =>
        p.pageNumber === pageNumber
          ? {
              ...p,
              extractedName: newName,
              source: "manual",
              confidence: "manual",
              status: "edited",
            }
          : p
      )
    );
  }, []);

  const selectedCount = useMemo(
    () => pages.filter((p) => p.selected).length,
    [pages]
  );

  const isActivePageProcessing =
    pages.find((p) => p.pageNumber === activePage)?.status === "processing";

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          handleFileSelected(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {/* Top Navigation Bar (Strict 3-zone contract) */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
        <a
          href="https://wa.me/524434008893?text=Hola%20Cesar%2C%20necesito%20ayuda"
          target="_blank"
          rel="noopener noreferrer"
          title="Clic aquí para enviar mensaje por WhatsApp a Cesar"
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg border bg-red-50/80 hover:bg-red-100 text-base sm:text-lg font-extrabold tracking-tight font-display whitespace-nowrap shrink-0 animate-red-blink transition-transform hover:scale-[1.02] active:scale-[0.99] cursor-pointer"
        >
          <MessageCircle className="w-4 h-4 shrink-0" />
          <span>HCESAR REVIMS &ldquo;Divisor pdf&rdquo;</span>
          <ArrowUpRight className="w-4 h-4 shrink-0" />
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Subir PDF
          </button>
          <button
            type="button"
            onClick={handleLoadSamplePdf}
            className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            Cargar ejemplo
          </button>
          {pdfJsDoc && (
            <>
              <a
                href="#zona-inspector"
                className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
              >
                Área de nombre
              </a>
              <a
                href="#nomenclatura"
                className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
              >
                Nomenclatura
              </a>
              <a
                href="#tabla-paginas"
                className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
              >
                Páginas y ZIP
              </a>
            </>
          )}
        </nav>

        <div className="flex items-center shrink-0">
          {pdfJsDoc ? (
            <button
              type="button"
              onClick={handleDownloadZip}
              disabled={selectedCount === 0 || isExportingZip || isBatchRunning}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Archive className="w-3.5 h-3.5" />
              Descargar ZIP ({selectedCount})
            </button>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <FileUp className="w-3.5 h-3.5" />
              Seleccionar PDF
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main id="top" className="flex-1 w-full max-w-[1440px] mx-auto px-6 py-6 flex flex-col gap-5">
        {errorBanner && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800"
          >
            <div className="flex items-start gap-2.5 flex-1 min-w-[240px]">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span className="leading-snug">{errorBanner}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {isQuotaError && (
                <button
                  type="button"
                  onClick={handleRunLocalOcrFallback}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap"
                >
                  Completar con OCR Local (sin límite)
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setErrorBanner(null);
                  setIsQuotaError(false);
                }}
                aria-label="Cerrar aviso"
                className="p-1 text-red-600 hover:text-red-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {!pdfJsDoc ? (
          /* Empty / Upload Workbench State */
          <div className="flex flex-col gap-8 py-6">
            <div className="max-w-3xl">
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 font-display [text-wrap:balance]">
                Divide un PDF multipágina y nombra cada hoja según el titular superior izquierdo
              </h1>
              <p className="mt-3 text-base text-slate-600 leading-relaxed max-w-2xl">
                Sube tu documento con decenas o cientos de páginas, ajusta el recuadro de
                detección sobre la esquina superior izquierda, extrae los nombres con OCR o
                IA y descarga todos los PDF individuales en un solo archivo ZIP.
              </p>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragOver(false);
                handleFileSelected(e.dataTransfer.files?.[0]);
              }}
              className={`flex flex-col items-center justify-center text-center px-6 py-14 rounded-lg border-2 border-dashed transition-colors ${
                isDragOver
                  ? "border-blue-600 bg-blue-50/60"
                  : "border-slate-300 bg-white hover:border-slate-400"
              }`}
            >
              <div className="w-12 h-12 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center mb-4">
                <FileUp className="w-6 h-6 text-blue-600" />
              </div>

              <h2 className="text-base font-semibold text-slate-900">
                {isLoadingFile
                  ? "Cargando y dividiendo páginas del PDF..."
                  : "Arrastra y suelta tu archivo PDF aquí"}
              </h2>
              <p className="mt-1 text-sm text-slate-500 max-w-md">
                Procesamiento directo de páginas con conservación vectorial y exportación
                masiva en formato ZIP.
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={isLoadingFile}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
                >
                  <FileUp className="w-4 h-4" />
                  Elegir archivo PDF
                </button>
                <button
                  type="button"
                  disabled={isLoadingFile}
                  onClick={handleLoadSamplePdf}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
                >
                  <FileText className="w-4 h-4 text-slate-500" />
                  Probar con PDF de ejemplo (5 páginas)
                </button>
              </div>
            </div>

            {/* Mechanism Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
              <div className="bg-white border border-slate-200 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-slate-900">
                  01. Selección visual de zona
                </h3>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Por defecto apunta a la esquina superior izquierda de cada hoja. Puedes
                  arrastrar o redimensionar el recuadro exacto sobre la página.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-slate-900">
                  02. Texto nativo, OCR o IA
                </h3>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Combina lectura de texto digital, OCR visual para hojas escaneadas o
                  análisis con IA para documentos complejos y formularios irregulares.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-slate-900">
                  03. Nomenclatura y ZIP masivo
                </h3>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Aplica plantillas como <span className="font-mono text-xs">{"{nombre}"}</span>{" "}
                  o <span className="font-mono text-xs">{"{pagina}_{nombre}"}</span>, edita
                  casos puntuales y descarga todo comprimido en ZIP.
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* Active Document Workbench */
          <>
            {/* Workspace Control Strip */}
            <section className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                {/* Unboxed File Metadata */}
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 min-w-0">
                  <span className="text-sm font-semibold text-slate-900 truncate max-w-[260px]">
                    {originalFileName}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums font-mono">{pages.length} páginas</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums font-mono">
                    {formatBytes(originalFileSize)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-blue-600 hover:underline font-medium whitespace-nowrap"
                  >
                    Cambiar archivo
                  </button>
                </div>

                {/* Engine Segmented Selector + Primary Batch Action */}
                <div className="flex flex-wrap items-center gap-3">
                  <div
                    role="group"
                    aria-label="Motor de detección de nombres"
                    className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
                  >
                    <button
                      type="button"
                      onClick={() => setEngine("hybrid")}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        engine === "hybrid"
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      Híbrido (Texto + OCR)
                    </button>
                    <button
                      type="button"
                      onClick={() => setEngine("ocr")}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        engine === "ocr"
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <ScanText className="w-3.5 h-3.5" />
                      OCR en Zona
                    </button>
                    <button
                      type="button"
                      onClick={() => setEngine("ai")}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        engine === "ai"
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                      IA (Docs. Complejos)
                    </button>
                  </div>

                  {isBatchRunning ? (
                    <button
                      type="button"
                      onClick={handleStopBatch}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <StopIcon className="w-3.5 h-3.5" />
                      Detener ({batchProgress.done}/{batchProgress.total})
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleRunBatchDetection}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Detectar todas las páginas
                    </button>
                  )}
                </div>
              </div>

              {/* Contextual AI Options when Gemini engine is active */}
              {engine === "ai" && (
                <div className="pt-3 border-t border-slate-100 flex flex-col gap-2.5">
                  <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                    <div className="flex items-center gap-2 shrink-0">
                      <label htmlFor="ai-model-select" className="text-xs font-medium text-slate-700 whitespace-nowrap">
                        Modelo IA:
                      </label>
                      <select
                        id="ai-model-select"
                        value={aiModel}
                        onChange={(e) =>
                          setAiModel(
                            e.target.value as "auto" | "gemini-4-hydrogen" | "gemini-3.1-flash-lite"
                          )
                        }
                        className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                      >
                        <option value="auto">Automático (Hydrogen → Flash Lite)</option>
                        <option value="gemini-4-hydrogen">Gemini 4 Hydrogen</option>
                        <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                      </select>
                    </div>

                    <div className="flex-1">
                      <input
                        type="text"
                        value={aiHint}
                        onChange={(e) => setAiHint(e.target.value)}
                        placeholder="Indicación opcional para la IA (ej. 'El nombre aparece después de Titular: o en firma manuscrita')"
                        className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={skipNamedPages}
                          onChange={(e) => setSkipNamedPages(e.target.checked)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                        />
                        Omitir páginas que ya tienen nombre (ahorra cuota)
                      </label>

                      <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={aiUseFullPage}
                          onChange={(e) => setAiUseFullPage(e.target.checked)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                        />
                        Analizar hoja completa si el diseño varía
                      </label>
                    </div>

                    <span className="text-[11px] text-slate-500">
                      {aiUseFullPage
                        ? "Modo lote: 6 hojas por petición"
                        : "Modo compacto: hasta 16 zonas por cada petición"}
                    </span>
                  </div>
                </div>
              )}

              {/* Batch Progress Bar */}
              {isBatchRunning && batchProgress.total > 0 && (
                <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-blue-600 h-full transition-all duration-200"
                    style={{
                      width: `${Math.round(
                        (batchProgress.done / batchProgress.total) * 100
                      )}%`,
                    }}
                  />
                </div>
              )}
            </section>

            {/* Two-Column Workbench */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              <div className="lg:col-span-5">
                <ZoneInspector
                  pdfDoc={pdfJsDoc}
                  numPages={pages.length}
                  activePage={activePage}
                  onActivePageChange={setActivePage}
                  rect={rect}
                  onRectChange={setRect}
                  onDetectSinglePage={handleDetectSinglePage}
                  isProcessingPage={isActivePageProcessing || isBatchRunning}
                />
              </div>

              <div className="lg:col-span-7 min-w-0">
                <NamingAndTablePanel
                  pages={pages}
                  activePage={activePage}
                  originalPdfName={originalFileName}
                  namingConfig={namingConfig}
                  onNamingConfigChange={setNamingConfig}
                  onSelectActivePage={setActivePage}
                  onTogglePageSelection={handleTogglePageSelection}
                  onToggleAllVisible={handleToggleAllVisible}
                  onUpdatePageName={handleUpdatePageName}
                  onRedetectPage={handleDetectSinglePage}
                  onDownloadSinglePdf={handleDownloadSinglePdf}
                  onDownloadZip={handleDownloadZip}
                  isExportingZip={isExportingZip}
                  isBatchRunning={isBatchRunning}
                />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
