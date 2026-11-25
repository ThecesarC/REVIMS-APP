import React, { useMemo, useState } from "react";
import {
  Archive,
  CheckSquare,
  Download,
  RefreshCw,
  Search,
  Square,
  AlertCircle,
  Check,
  Loader2,
} from "lucide-react";
import type { NameCaseMode, NamingConfig, PageRecord } from "../types/pdf";
import { buildUniqueFilenames, formatBytes } from "../utils/naming";

interface NamingAndTablePanelProps {
  pages: PageRecord[];
  activePage: number;
  originalPdfName: string;
  namingConfig: NamingConfig;
  onNamingConfigChange: (config: NamingConfig) => void;
  onSelectActivePage: (pageNumber: number) => void;
  onTogglePageSelection: (pageNumber: number) => void;
  onToggleAllVisible: (pageNumbers: number[], select: boolean) => void;
  onUpdatePageName: (pageNumber: number, newName: string) => void;
  onRedetectPage: (pageNumber: number) => void;
  onDownloadSinglePdf: (pageNumber: number) => void;
  onDownloadZip: () => void;
  isExportingZip: boolean;
  isBatchRunning: boolean;
}

type StatusFilter = "all" | "named" | "unnamed";

const TEMPLATE_TOKENS = [
  { token: "{nombre}", label: "+ {nombre}" },
  { token: "{pagina}", label: "+ {pagina}" },
  { token: "{original}", label: "+ {original}" },
  { token: "{fecha}", label: "+ {fecha}" },
];

export const NamingAndTablePanel: React.FC<NamingAndTablePanelProps> = ({
  pages,
  activePage,
  originalPdfName,
  namingConfig,
  onNamingConfigChange,
  onSelectActivePage,
  onTogglePageSelection,
  onToggleAllVisible,
  onUpdatePageName,
  onRedetectPage,
  onDownloadSinglePdf,
  onDownloadZip,
  isExportingZip,
  isBatchRunning,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const filenameMap = useMemo(
    () => buildUniqueFilenames(pages, pages.length, originalPdfName, namingConfig),
    [pages, originalPdfName, namingConfig]
  );

  const filteredPages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return pages.filter((p) => {
      if (filter === "named" && !p.extractedName.trim()) return false;
      if (filter === "unnamed" && p.extractedName.trim()) return false;
      if (!q) return true;
      const outName = (filenameMap.get(p.pageNumber) ?? "").toLowerCase();
      return (
        String(p.pageNumber).includes(q) ||
        p.extractedName.toLowerCase().includes(q) ||
        outName.includes(q)
      );
    });
  }, [pages, filter, searchQuery, filenameMap]);

  const selectedCount = useMemo(
    () => pages.filter((p) => p.selected).length,
    [pages]
  );
  const namedCount = useMemo(
    () => pages.filter((p) => p.extractedName.trim().length > 0).length,
    [pages]
  );
  const totalSelectedBytes = useMemo(
    () => pages.reduce((acc, p) => (p.selected ? acc + (p.sizeBytes ?? 0) : acc), 0),
    [pages]
  );

  const allVisibleSelected =
    filteredPages.length > 0 && filteredPages.every((p) => p.selected);

  const activePreviewFilename =
    filenameMap.get(activePage) ?? `Pagina_${String(activePage).padStart(2, "0")}.pdf`;

  const appendToken = (token: string) => {
    const current = namingConfig.template;
    const separator = current && !current.endsWith("_") && !current.endsWith("-") && !current.endsWith(" ") ? "_" : "";
    onNamingConfigChange({
      ...namingConfig,
      template: `${current}${separator}${token}`,
    });
  };

  const getSourceLabel = (page: PageRecord) => {
    if (page.status === "processing") return "Procesando";
    if (page.status === "error") return "Error";
    if (page.source === "ai") return "IA";
    if (page.source === "ocr") return "OCR";
    if (page.source === "pdf-text") return "Texto PDF";
    if (page.source === "manual") return "Manual";
    return "Sin detectar";
  };

  return (
    <div className="flex flex-col gap-4 min-w-0">
      {/* Naming Configuration Block */}
      <section
        id="nomenclatura"
        className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Nomenclatura de archivos individuales
            </h2>
            <p className="text-xs text-slate-500">
              Personaliza cómo se nombrará cada PDF dividido a partir del nombre detectado.
            </p>
          </div>
          <span className="text-xs text-slate-500 font-mono truncate max-w-[260px]">
            Vista previa: <strong className="text-slate-900">{activePreviewFilename}</strong>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-7 flex flex-col gap-1.5">
            <label htmlFor="naming-template" className="text-xs font-medium text-slate-700">
              Plantilla de nombre
            </label>
            <input
              id="naming-template"
              type="text"
              value={namingConfig.template}
              onChange={(e) =>
                onNamingConfigChange({ ...namingConfig, template: e.target.value })
              }
              placeholder="{nombre}"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {TEMPLATE_TOKENS.map((item) => (
                <button
                  key={item.token}
                  type="button"
                  onClick={() => appendToken(item.token)}
                  className="px-2 py-0.5 text-[11px] font-mono font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sm:col-span-5 flex flex-col gap-2">
            <label htmlFor="case-mode" className="text-xs font-medium text-slate-700">
              Formato de texto
            </label>
            <select
              id="case-mode"
              value={namingConfig.caseMode}
              onChange={(e) =>
                onNamingConfigChange({
                  ...namingConfig,
                  caseMode: e.target.value as NameCaseMode,
                })
              }
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            >
              <option value="original">Tal como aparece</option>
              <option value="title">Título Capitalizado</option>
              <option value="upper">MAYÚSCULAS</option>
              <option value="slug">minúsculas_sin_espacios</option>
            </select>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={namingConfig.stripAccents}
                  onChange={(e) =>
                    onNamingConfigChange({
                      ...namingConfig,
                      stripAccents: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                />
                Quitar acentos
              </label>

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={namingConfig.replaceSpaces}
                  onChange={(e) =>
                    onNamingConfigChange({
                      ...namingConfig,
                      replaceSpaces: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                />
                Espacios con _
              </label>
            </div>
          </div>
        </div>
      </section>

      {/* Pages Data Grid & Bulk ZIP Export */}
      <section
        id="tabla-paginas"
        className="flex flex-col bg-white border border-slate-200 rounded-lg overflow-hidden"
      >
        {/* Filter & Search Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar por nombre o número de página..."
              className="w-full pl-9 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filter === "all"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Todas ({pages.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter("named")}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filter === "named"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Con nombre ({namedCount})
            </button>
            <button
              type="button"
              onClick={() => setFilter("unnamed")}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filter === "unnamed"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Sin detectar ({pages.length - namedCount})
            </button>
          </div>
        </div>

        {/* High-Density Table */}
        <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
              <tr>
                <th className="py-2.5 pl-4 pr-2 w-10">
                  <button
                    type="button"
                    onClick={() =>
                      onToggleAllVisible(
                        filteredPages.map((p) => p.pageNumber),
                        !allVisibleSelected
                      )
                    }
                    aria-label="Seleccionar todas las páginas visibles"
                    className="inline-flex items-center justify-center text-slate-600 hover:text-slate-900"
                  >
                    {allVisibleSelected ? (
                      <CheckSquare className="w-4 h-4 text-blue-600" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                <th className="py-2.5 px-2 w-14 text-right">Pág.</th>
                <th className="py-2.5 px-3 min-w-[200px]">Nombre detectado</th>
                <th className="py-2.5 px-3 min-w-[180px]">Archivo final (.pdf)</th>
                <th className="py-2.5 pl-2 pr-4 w-24 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredPages.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 px-4 text-center text-sm text-slate-500">
                    No hay páginas que coincidan con tu búsqueda o filtro actual.
                  </td>
                </tr>
              ) : (
                filteredPages.map((page) => {
                  const isActive = page.pageNumber === activePage;
                  const finalFile = filenameMap.get(page.pageNumber) ?? "";
                  const sourceText = getSourceLabel(page);

                  return (
                    <tr
                      key={page.pageNumber}
                      onClick={() => onSelectActivePage(page.pageNumber)}
                      className={`h-12 transition-colors cursor-pointer ${
                        isActive ? "bg-blue-50/60" : "hover:bg-slate-50"
                      }`}
                    >
                      <td
                        className="py-2 pl-4 pr-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTogglePageSelection(page.pageNumber);
                        }}
                      >
                        <button
                          type="button"
                          aria-label={`Incluir página ${page.pageNumber}`}
                          className="inline-flex items-center justify-center text-slate-600 hover:text-slate-900"
                        >
                          {page.selected ? (
                            <CheckSquare className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-400" />
                          )}
                        </button>
                      </td>

                      <td className="py-2 px-2 text-right font-mono tabular-nums text-xs font-semibold text-slate-700">
                        {page.pageNumber}
                      </td>

                      <td
                        className="py-1.5 px-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={page.extractedName}
                            onFocus={() => onSelectActivePage(page.pageNumber)}
                            onChange={(e) =>
                              onUpdatePageName(page.pageNumber, e.target.value)
                            }
                            placeholder="Sin nombre — editar manualmente"
                            className="w-full min-w-[140px] px-2 py-1 text-sm text-slate-900 bg-transparent border border-transparent hover:border-slate-200 focus:bg-white focus:border-blue-600 rounded focus:outline-none"
                          />
                          <span
                            className={`text-[11px] whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
                              page.status === "error"
                                ? "text-red-600"
                                : page.status === "processing"
                                ? "text-blue-600"
                                : page.extractedName
                                ? "text-emerald-700"
                                : "text-slate-400"
                            }`}
                            title={page.errorMessage}
                          >
                            {page.status === "processing" && (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            )}
                            {page.status === "error" && (
                              <AlertCircle className="w-3 h-3" />
                            )}
                            {(page.status === "done" || page.status === "edited") &&
                              page.extractedName && <Check className="w-3 h-3" />}
                            {sourceText}
                          </span>
                        </div>
                      </td>

                      <td className="py-2 px-3">
                        <div
                          className="font-mono text-xs text-slate-600 truncate max-w-[220px]"
                          title={finalFile}
                        >
                          {finalFile}
                        </div>
                      </td>

                      <td
                        className="py-2 pl-2 pr-4 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => onRedetectPage(page.pageNumber)}
                            disabled={isBatchRunning || page.status === "processing"}
                            title={`Re-detectar página ${page.pageNumber}`}
                            aria-label={`Re-detectar página ${page.pageNumber}`}
                            className="p-1.5 rounded text-slate-500 hover:text-blue-600 hover:bg-blue-50 disabled:opacity-40 transition-colors"
                          >
                            <RefreshCw
                              className={`w-3.5 h-3.5 ${
                                page.status === "processing" ? "animate-spin" : ""
                              }`}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDownloadSinglePdf(page.pageNumber)}
                            title={`Descargar PDF página ${page.pageNumber}`}
                            aria-label={`Descargar PDF página ${page.pageNumber}`}
                            className="p-1.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Export Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2 text-xs text-slate-600 tabular-nums">
            <span>
              <strong className="text-slate-900">{selectedCount}</strong> de{" "}
              {pages.length} hojas seleccionadas
            </span>
            <span aria-hidden="true">·</span>
            <span>{namedCount} con nombre detectado</span>
            {totalSelectedBytes > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{formatBytes(totalSelectedBytes)}</span>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={onDownloadZip}
            disabled={selectedCount === 0 || isExportingZip || isBatchRunning}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            {isExportingZip ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Archive className="w-4 h-4" />
            )}
            {isExportingZip
              ? "Empaquetando ZIP..."
              : `Descargar ZIP (${selectedCount} PDFs)`}
          </button>
        </div>
      </section>
    </div>
  );
};
