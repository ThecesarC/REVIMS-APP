export interface NormalizedRect {
  x: number; // 0..1 from left
  y: number; // 0..1 from top
  width: number; // 0..1
  height: number; // 0..1
}

export type ExtractionEngine = "hybrid" | "ocr" | "ai";

export type NameCaseMode = "original" | "title" | "upper" | "slug";

export interface NamingConfig {
  template: string;
  caseMode: NameCaseMode;
  stripAccents: boolean;
  replaceSpaces: boolean;
  fallbackPrefix: string;
}

export type PageExtractionStatus =
  | "pending"
  | "processing"
  | "done"
  | "empty"
  | "error"
  | "edited";

export type ExtractionSource = "pdf-text" | "ocr" | "ai" | "manual" | "none";

export interface PageRecord {
  pageNumber: number;
  selected: boolean;
  extractedName: string;
  rawText: string;
  confidence: "high" | "medium" | "low" | "none" | "manual";
  source: ExtractionSource;
  status: PageExtractionStatus;
  errorMessage?: string;
  pdfBytes?: Uint8Array;
  sizeBytes?: number;
}

export const DEFAULT_UPPER_LEFT_RECT: NormalizedRect = {
  x: 0.04,
  y: 0.04,
  width: 0.48,
  height: 0.16,
};

export const RECT_PRESETS: Array<{ id: string; label: string; rect: NormalizedRect }> = [
  {
    id: "top-left",
    label: "Sup. Izquierda",
    rect: { x: 0.04, y: 0.04, width: 0.48, height: 0.16 },
  },
  {
    id: "top-wide",
    label: "Encabezado Completo",
    rect: { x: 0.04, y: 0.03, width: 0.92, height: 0.18 },
  },
  {
    id: "top-left-tall",
    label: "Bloque Izq. Amplio",
    rect: { x: 0.04, y: 0.04, width: 0.52, height: 0.28 },
  },
  {
    id: "full-page",
    label: "Página Completa",
    rect: { x: 0.02, y: 0.02, width: 0.96, height: 0.96 },
  },
];
