import React, { useEffect, useRef, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight, Crosshair, RotateCcw, ScanSearch } from "lucide-react";
import type { NormalizedRect } from "../types/pdf";
import { DEFAULT_UPPER_LEFT_RECT, RECT_PRESETS } from "../types/pdf";
import type { PdfJsDocument } from "../utils/pdfEngine";
import { renderCroppedRegionToDataUrl, renderPageToCanvas } from "../utils/pdfEngine";

interface ZoneInspectorProps {
  pdfDoc: PdfJsDocument;
  numPages: number;
  activePage: number;
  onActivePageChange: (page: number) => void;
  rect: NormalizedRect;
  onRectChange: (rect: NormalizedRect) => void;
  onDetectSinglePage: (pageNumber: number) => void;
  isProcessingPage: boolean;
}

type DragMode =
  | { type: "none" }
  | { type: "move"; startX: number; startY: number; orig: NormalizedRect }
  | { type: "draw"; startX: number; startY: number }
  | {
      type: "resize";
      corner: "nw" | "ne" | "sw" | "se";
      startX: number;
      startY: number;
      orig: NormalizedRect;
    };

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export const ZoneInspector: React.FC<ZoneInspectorProps> = ({
  pdfDoc,
  numPages,
  activePage,
  onActivePageChange,
  rect,
  onRectChange,
  onDetectSinglePage,
  isProcessingPage,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [rendering, setRendering] = useState(false);
  const [cropPreviewUrl, setCropPreviewUrl] = useState<string>("");
  const [dragMode, setDragMode] = useState<DragMode>({ type: "none" });

  useEffect(() => {
    let cancelled = false;
    let cancelTask: (() => void) | null = null;

    async function draw() {
      const canvas = canvasRef.current;
      const wrapper = containerRef.current;
      if (!canvas || !wrapper) return;

      setRendering(true);
      try {
        const availableWidth = Math.max(320, Math.min(640, wrapper.clientWidth - 24));
        const res = await renderPageToCanvas(pdfDoc, activePage, canvas, availableWidth);
        cancelTask = res.cancel;
      } catch {
        // Ignore cancelled renders on rapid page switching
      } finally {
        if (!cancelled) setRendering(false);
      }
    }

    draw();

    return () => {
      cancelled = true;
      if (cancelTask) {
        try {
          cancelTask();
        } catch {
          // ignore
        }
      }
    };
  }, [pdfDoc, activePage]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { dataUrl } = await renderCroppedRegionToDataUrl(pdfDoc, activePage, rect, {
          scale: 2.0,
        });
        if (!cancelled) {
          setCropPreviewUrl(dataUrl);
        }
      } catch {
        if (!cancelled) setCropPreviewUrl("");
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pdfDoc, activePage, rect]);

  const getNormalizedPoint = useCallback((clientX: number, clientY: number) => {
    const el = overlayRef.current;
    if (!el) return { nx: 0, ny: 0 };
    const bounds = el.getBoundingClientRect();
    const nx = clamp((clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const ny = clamp((clientY - bounds.top) / Math.max(1, bounds.height), 0, 1);
    return { nx, ny };
  }, []);

  const handleOverlayPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    const { nx, ny } = getNormalizedPoint(e.clientX, e.clientY);
    setDragMode({ type: "draw", startX: nx, startY: ny });
  };

  const handleBoxPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    overlayRef.current?.setPointerCapture(e.pointerId);
    const { nx, ny } = getNormalizedPoint(e.clientX, e.clientY);
    setDragMode({ type: "move", startX: nx, startY: ny, orig: rect });
  };

  const handleCornerPointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    corner: "nw" | "ne" | "sw" | "se"
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    overlayRef.current?.setPointerCapture(e.pointerId);
    const { nx, ny } = getNormalizedPoint(e.clientX, e.clientY);
    setDragMode({ type: "resize", corner, startX: nx, startY: ny, orig: rect });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode.type === "none") return;
    const { nx, ny } = getNormalizedPoint(e.clientX, e.clientY);
    const minSize = 0.04;

    if (dragMode.type === "draw") {
      const x = Math.min(dragMode.startX, nx);
      const y = Math.min(dragMode.startY, ny);
      const width = Math.max(minSize, Math.abs(nx - dragMode.startX));
      const height = Math.max(minSize, Math.abs(ny - dragMode.startY));
      onRectChange({
        x: clamp(x, 0, 1 - minSize),
        y: clamp(y, 0, 1 - minSize),
        width: clamp(width, minSize, 1 - x),
        height: clamp(height, minSize, 1 - y),
      });
      return;
    }

    if (dragMode.type === "move") {
      const dx = nx - dragMode.startX;
      const dy = ny - dragMode.startY;
      const nextX = clamp(dragMode.orig.x + dx, 0, 1 - dragMode.orig.width);
      const nextY = clamp(dragMode.orig.y + dy, 0, 1 - dragMode.orig.height);
      onRectChange({
        ...dragMode.orig,
        x: nextX,
        y: nextY,
      });
      return;
    }

    if (dragMode.type === "resize") {
      const { orig, corner } = dragMode;
      let left = orig.x;
      let top = orig.y;
      let right = orig.x + orig.width;
      let bottom = orig.y + orig.height;

      if (corner.includes("w")) left = clamp(nx, 0, right - minSize);
      if (corner.includes("e")) right = clamp(nx, left + minSize, 1);
      if (corner.includes("n")) top = clamp(ny, 0, bottom - minSize);
      if (corner.includes("s")) bottom = clamp(ny, top + minSize, 1);

      onRectChange({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode.type !== "none") {
      try {
        overlayRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      setDragMode({ type: "none" });
    }
  };

  const isPresetActive = (presetRect: NormalizedRect) =>
    Math.abs(rect.x - presetRect.x) < 0.01 &&
    Math.abs(rect.y - presetRect.y) < 0.01 &&
    Math.abs(rect.width - presetRect.width) < 0.01 &&
    Math.abs(rect.height - presetRect.height) < 0.01;

  return (
    <section
      id="zona-inspector"
      className="flex flex-col bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      {/* Inspector Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Área de extracción por página
          </h2>
          <p className="text-xs text-slate-500">
            Arrastra sobre la hoja para delimitar el área del nombre (aplicable a todas las hojas).
          </p>
        </div>

        {/* Page Stepper */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onActivePageChange(Math.max(1, activePage - 1))}
            disabled={activePage <= 1}
            aria-label="Página anterior"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-2 text-xs font-medium text-slate-700 tabular-nums font-mono whitespace-nowrap">
            Pág. {activePage} / {numPages}
          </span>
          <button
            type="button"
            onClick={() => onActivePageChange(Math.min(numPages, activePage + 1))}
            disabled={activePage >= numPages}
            aria-label="Página siguiente"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Presets Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <div className="flex flex-wrap items-center gap-1.5">
          {RECT_PRESETS.map((preset) => {
            const active = isPresetActive(preset.rect);
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onRectChange(preset.rect)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? "bg-blue-600 text-white"
                    : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => onRectChange(DEFAULT_UPPER_LEFT_RECT)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          title="Restablecer esquina superior izquierda"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Restablecer
        </button>
      </div>

      {/* Interactive PDF Canvas Stage */}
      <div
        ref={containerRef}
        className="relative flex flex-col items-center justify-center p-4 bg-slate-100 min-h-[420px]"
      >
        <div className="relative inline-block shadow-sm border border-slate-300 bg-white select-none">
          <canvas ref={canvasRef} className="block" />

          {/* Interactive Selection Overlay */}
          <div
            ref={overlayRef}
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="absolute inset-0 cursor-crosshair touch-none"
          >
            {/* Dimmed outer mask using CSS box-shadow on selection box */}
            <div
              onPointerDown={handleBoxPointerDown}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
                boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.14)",
              }}
              className="absolute border-2 border-blue-600 bg-blue-500/10 cursor-move"
            >
              <span className="absolute -top-6 left-0 px-1.5 py-0.5 text-[11px] font-medium bg-blue-600 text-white rounded whitespace-nowrap pointer-events-none">
                Zona de nombre
              </span>

              {/* Corner Resize Handles */}
              <button
                type="button"
                aria-label="Redimensionar esquina superior izquierda"
                onPointerDown={(e) => handleCornerPointerDown(e, "nw")}
                className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-600 rounded-xs cursor-nwse-resize"
              />
              <button
                type="button"
                aria-label="Redimensionar esquina superior derecha"
                onPointerDown={(e) => handleCornerPointerDown(e, "ne")}
                className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-600 rounded-xs cursor-nesw-resize"
              />
              <button
                type="button"
                aria-label="Redimensionar esquina inferior izquierda"
                onPointerDown={(e) => handleCornerPointerDown(e, "sw")}
                className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-600 rounded-xs cursor-nesw-resize"
              />
              <button
                type="button"
                aria-label="Redimensionar esquina inferior derecha"
                onPointerDown={(e) => handleCornerPointerDown(e, "se")}
                className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-600 rounded-xs cursor-nwse-resize"
              />
            </div>
          </div>

          {rendering && (
            <div className="absolute inset-0 bg-white/60 flex items-center justify-center text-xs font-medium text-slate-600 pointer-events-none">
              Renderizando hoja...
            </div>
          )}
        </div>
      </div>

      {/* Bottom Coordinates & Live Crop Preview */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 bg-white">
        <div className="flex items-center gap-3 min-w-0">
          {cropPreviewUrl ? (
            <div className="shrink-0 border border-slate-200 rounded bg-slate-50 p-1 max-w-[180px] max-h-[52px] overflow-hidden">
              <img
                src={cropPreviewUrl}
                alt={`Recorte de la página ${activePage}`}
                className="h-10 w-auto object-contain"
              />
            </div>
          ) : null}
          <div className="text-xs text-slate-500 font-mono tabular-nums truncate">
            <span className="inline-flex items-center gap-1 text-slate-700 font-sans font-medium mr-2">
              <Crosshair className="w-3.5 h-3.5 text-blue-600" />
              Coordenadas:
            </span>
            X {Math.round(rect.x * 100)}% · Y {Math.round(rect.y * 100)}% ·{" "}
            {Math.round(rect.width * 100)}% × {Math.round(rect.height * 100)}%
          </div>
        </div>

        <button
          type="button"
          onClick={() => onDetectSinglePage(activePage)}
          disabled={isProcessingPage}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-slate-200 text-slate-800 bg-white hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <ScanSearch className="w-3.5 h-3.5 text-blue-600" />
          {isProcessingPage ? "Analizando..." : `Probar página ${activePage}`}
        </button>
      </div>
    </section>
  );
};
