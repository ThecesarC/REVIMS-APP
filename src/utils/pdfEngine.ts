import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { NormalizedRect } from "../types/pdf";
import { cleanExtractedPersonName } from "./naming";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export type PdfJsDocument = pdfjsLib.PDFDocumentProxy;

export async function loadPdfDocuments(buffer: ArrayBuffer): Promise<{
  pdfJsDoc: PdfJsDocument;
  pdfLibDoc: PDFDocument;
  numPages: number;
}> {
  const copyForJs = new Uint8Array(buffer.slice(0));
  const copyForLib = buffer.slice(0);

  const [pdfJsDoc, pdfLibDoc] = await Promise.all([
    pdfjsLib.getDocument({ data: copyForJs }).promise,
    PDFDocument.load(copyForLib, { ignoreEncryption: true }),
  ]);

  return {
    pdfJsDoc,
    pdfLibDoc,
    numPages: pdfJsDoc.numPages,
  };
}

export async function splitSinglePagePdf(
  srcPdfDoc: PDFDocument,
  pageIndexZeroBased: number
): Promise<Uint8Array> {
  const outDoc = await PDFDocument.create();
  const [copied] = await outDoc.copyPages(srcPdfDoc, [pageIndexZeroBased]);
  outDoc.addPage(copied);
  return await outDoc.save();
}

export async function renderPageToCanvas(
  pdfJsDoc: PdfJsDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  targetWidth = 680
): Promise<{ width: number; height: number; cancel: () => void }> {
  const page = await pdfJsDoc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.max(0.5, Math.min(3, targetWidth / baseViewport.width));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * dpr });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("No se pudo inicializar el contexto 2D del lienzo.");
  }

  const renderTask = page.render({
    canvas,
    canvasContext: ctx,
    viewport,
  });

  await renderTask.promise;

  return {
    width: Math.floor(viewport.width / dpr),
    height: Math.floor(viewport.height / dpr),
    cancel: () => renderTask.cancel(),
  };
}

interface PositionedTextChunk {
  text: string;
  x: number;
  y: number;
  height: number;
}

export async function extractTextInNormalizedRect(
  pdfJsDoc: PdfJsDocument,
  pageNumber: number,
  rect: NormalizedRect
): Promise<{ rawText: string; cleanedName: string }> {
  const page = await pdfJsDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();

  const chunks: PositionedTextChunk[] = [];
  const minX = rect.x - 0.008;
  const maxX = rect.x + rect.width + 0.008;
  const minY = rect.y - 0.008;
  const maxY = rect.y + rect.height + 0.008;

  for (const item of textContent.items) {
    if (!("str" in item) || !item.str.trim()) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const xPx = tx[4];
    const yPx = tx[5];
    const itemHeight = Math.hypot(tx[2], tx[3]) || item.height || 10;
    const itemWidth = item.width || 0;

    // Normalize center-left and approximate top-left
    const normX = (xPx + Math.min(itemWidth * 0.25, 16)) / viewport.width;
    const normY = (yPx - itemHeight * 0.4) / viewport.height;

    if (normX >= minX && normX <= maxX && normY >= minY && normY <= maxY) {
      chunks.push({
        text: item.str,
        x: xPx,
        y: yPx,
        height: itemHeight,
      });
    }
  }

  if (chunks.length === 0) {
    return { rawText: "", cleanedName: "" };
  }

  chunks.sort((a, b) => {
    const lineThreshold = Math.max(4, Math.min(a.height, b.height) * 0.55);
    if (Math.abs(a.y - b.y) <= lineThreshold) {
      return a.x - b.x;
    }
    return a.y - b.y;
  });

  const lines: string[] = [];
  let currentLine: PositionedTextChunk[] = [];

  for (const chunk of chunks) {
    if (currentLine.length === 0) {
      currentLine.push(chunk);
      continue;
    }
    const prev = currentLine[currentLine.length - 1];
    const lineThreshold = Math.max(4, Math.min(prev.height, chunk.height) * 0.6);
    if (Math.abs(chunk.y - prev.y) <= lineThreshold) {
      currentLine.push(chunk);
    } else {
      lines.push(currentLine.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim());
      currentLine = [chunk];
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim());
  }

  const rawText = lines.join("\n").trim();
  const cleanedName = cleanExtractedPersonName(rawText);
  return { rawText, cleanedName };
}

function applyOcrContrastAndPadding(source: HTMLCanvasElement): HTMLCanvasElement {
  const pad = 16;
  const out = document.createElement("canvas");
  out.width = source.width + pad * 2;
  out.height = source.height + pad * 2;
  const ctx = out.getContext("2d");
  if (!ctx) return source;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, pad, pad);

  const imgData = ctx.getImageData(0, 0, out.width, out.height);
  const data = imgData.data;
  // Gentle contrast boost + grayscale for cleaner Tesseract OCR
  const contrast = 1.45;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const adjusted = Math.max(0, Math.min(255, (lum - 128) * contrast + 128));
    data[i] = adjusted;
    data[i + 1] = adjusted;
    data[i + 2] = adjusted;
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}

export async function renderCroppedRegionToCanvas(
  pdfJsDoc: PdfJsDocument,
  pageNumber: number,
  rect: NormalizedRect,
  options?: { fullPage?: boolean; scale?: number; enhanceForOcr?: boolean }
): Promise<HTMLCanvasElement> {
  const page = await pdfJsDoc.getPage(pageNumber);
  const scale = options?.scale ?? 2.4;
  const viewport = page.getViewport({ scale });

  const fullCanvas = document.createElement("canvas");
  fullCanvas.width = Math.max(1, Math.floor(viewport.width));
  fullCanvas.height = Math.max(1, Math.floor(viewport.height));
  const fullCtx = fullCanvas.getContext("2d");
  if (!fullCtx) {
    throw new Error("No se pudo crear el lienzo temporal para el recorte.");
  }

  fullCtx.fillStyle = "#ffffff";
  fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);

  await page.render({
    canvas: fullCanvas,
    canvasContext: fullCtx,
    viewport,
  }).promise;

  if (options?.fullPage) {
    return fullCanvas;
  }

  const sx = Math.max(0, Math.floor(rect.x * fullCanvas.width));
  const sy = Math.max(0, Math.floor(rect.y * fullCanvas.height));
  const sw = Math.max(
    24,
    Math.min(fullCanvas.width - sx, Math.floor(rect.width * fullCanvas.width))
  );
  const sh = Math.max(
    24,
    Math.min(fullCanvas.height - sy, Math.floor(rect.height * fullCanvas.height))
  );

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  const cropCtx = cropCanvas.getContext("2d");
  if (!cropCtx) {
    throw new Error("No se pudo crear el lienzo de recorte.");
  }

  cropCtx.fillStyle = "#ffffff";
  cropCtx.fillRect(0, 0, sw, sh);
  cropCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  return options?.enhanceForOcr ? applyOcrContrastAndPadding(cropCanvas) : cropCanvas;
}

export async function renderCroppedRegionToDataUrl(
  pdfJsDoc: PdfJsDocument,
  pageNumber: number,
  rect: NormalizedRect,
  options?: {
    fullPage?: boolean;
    scale?: number;
    enhanceForOcr?: boolean;
    mimeType?: "image/png" | "image/jpeg";
    quality?: number;
  }
): Promise<{ dataUrl: string; width: number; height: number }> {
  const canvas = await renderCroppedRegionToCanvas(pdfJsDoc, pageNumber, rect, options);
  const mime = options?.mimeType ?? "image/png";
  const quality = options?.quality ?? 0.88;
  return {
    dataUrl: canvas.toDataURL(mime, quality),
    width: canvas.width,
    height: canvas.height,
  };
}

export async function renderCompositeSheetForBatch(
  pdfJsDoc: PdfJsDocument,
  pageNumbers: number[],
  rect: NormalizedRect
): Promise<{ dataUrl: string; mimeType: "image/jpeg" }> {
  const rendered: Array<{ pageNumber: number; canvas: HTMLCanvasElement }> = [];
  for (const pageNumber of pageNumbers) {
    const c = await renderCroppedRegionToCanvas(pdfJsDoc, pageNumber, rect, {
      scale: 2.0,
      enhanceForOcr: false,
    });
    rendered.push({ pageNumber, canvas: c });
  }

  const labelWidth = 110;
  const maxCropWidth = Math.min(
    780,
    Math.max(...rendered.map((r) => r.canvas.width), 320)
  );
  const rowGap = 12;
  const rowPadding = 8;

  const scaledRows = rendered.map(({ pageNumber, canvas }) => {
    const ratio = canvas.width > maxCropWidth ? maxCropWidth / canvas.width : 1;
    const drawW = Math.max(1, Math.floor(canvas.width * ratio));
    const drawH = Math.max(44, Math.floor(canvas.height * ratio));
    return { pageNumber, canvas, drawW, drawH };
  });

  const sheetWidth = labelWidth + maxCropWidth + rowPadding * 2;
  const sheetHeight =
    scaledRows.reduce((acc, r) => acc + r.drawH + rowPadding * 2 + rowGap, rowGap);

  const sheet = document.createElement("canvas");
  sheet.width = sheetWidth;
  sheet.height = sheetHeight;
  const ctx = sheet.getContext("2d");
  if (!ctx) {
    throw new Error("No se pudo crear la hoja compuesta para el lote.");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sheetWidth, sheetHeight);

  let yCursor = rowGap;
  for (const row of scaledRows) {
    // Row border box
    const rowBoxH = row.drawH + rowPadding * 2;
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.strokeRect(rowPadding, yCursor, sheetWidth - rowPadding * 2, rowBoxH);

    // Crisp page badge label on the left
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(rowPadding, yCursor, labelWidth - 8, rowBoxH);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `PAG ${row.pageNumber}`,
      rowPadding + (labelWidth - 8) / 2,
      yCursor + rowBoxH / 2
    );

    ctx.drawImage(
      row.canvas,
      rowPadding + labelWidth,
      yCursor + rowPadding,
      row.drawW,
      row.drawH
    );

    yCursor += rowBoxH + rowGap;
  }

  return {
    dataUrl: sheet.toDataURL("image/jpeg", 0.86),
    mimeType: "image/jpeg",
  };
}

export async function generateSampleMultiPagePdf(): Promise<{
  bytes: Uint8Array;
  fileName: string;
}> {
  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

  const records = [
    {
      name: "María Fernanda López García",
      role: "Titular de Expediente · Área Operativa",
      folio: "EXP-2026-0104",
      dept: "Recursos Humanos",
      date: "14 de noviembre de 2026",
      summary:
        "Constancia individual de acreditación documental y validación de registro en plantilla oficial.",
    },
    {
      name: "Carlos Eduardo Mendoza Ruiz",
      role: "Titular de Expediente · Ingeniería",
      folio: "EXP-2026-0105",
      dept: "Infraestructura y Redes",
      date: "14 de noviembre de 2026",
      summary:
        "Certificado de cumplimiento técnico correspondiente al periodo anual de evaluación interna.",
    },
    {
      name: "Sofía Valentina Torres Navarro",
      role: "Titular de Expediente · Finanzas",
      folio: "EXP-2026-0106",
      dept: "Tesorería Central",
      date: "14 de noviembre de 2026",
      summary:
        "Comprobante de asignación presupuestaria y validación de firmas autorizadas del ejercicio.",
    },
    {
      name: "Alejandro Javier Ortega Castro",
      role: "Titular de Expediente · Logística",
      folio: "EXP-2026-0107",
      dept: "Distribución Regional",
      date: "14 de noviembre de 2026",
      summary:
        "Acta de entrega-recepción de unidades y bitácora consolidada de ruta norte.",
    },
    {
      name: "Lucía Patricia Jiménez Herrera",
      role: "Titular de Expediente · Dirección Legal",
      folio: "EXP-2026-0108",
      dept: "Cumplimiento Normativo",
      date: "14 de noviembre de 2026",
      summary:
        "Dictamen de conformidad contractual y resguardo digital de anexos firmados.",
    },
  ];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const page = doc.addPage([612, 792]);
    const { width, height } = page.getSize();

    // Subtle header border
    page.drawRectangle({
      x: 34,
      y: height - 130,
      width: width - 68,
      height: 92,
      borderColor: rgb(0.84, 0.87, 0.91),
      borderWidth: 1,
      color: rgb(0.98, 0.99, 1),
    });

    // Upper-left person name block (target zone)
    page.drawText("Nombre:", {
      x: 48,
      y: height - 62,
      size: 9,
      font: fontRegular,
      color: rgb(0.39, 0.45, 0.55),
    });

    page.drawText(rec.name, {
      x: 48,
      y: height - 82,
      size: 14,
      font: fontBold,
      color: rgb(0.06, 0.09, 0.16),
    });

    page.drawText(rec.role, {
      x: 48,
      y: height - 102,
      size: 9.5,
      font: fontRegular,
      color: rgb(0.28, 0.34, 0.42),
    });

    // Upper-right folio metadata
    page.drawText(`Folio: ${rec.folio}`, {
      x: width - 175,
      y: height - 68,
      size: 10,
      font: fontBold,
      color: rgb(0.15, 0.39, 0.92),
    });
    page.drawText(`Fecha: ${rec.date}`, {
      x: width - 175,
      y: height - 86,
      size: 9,
      font: fontRegular,
      color: rgb(0.39, 0.45, 0.55),
    });

    // Body content
    page.drawText(`Departamento: ${rec.dept}`, {
      x: 48,
      y: height - 175,
      size: 11,
      font: fontBold,
      color: rgb(0.12, 0.16, 0.23),
    });

    page.drawText(rec.summary, {
      x: 48,
      y: height - 205,
      size: 10.5,
      font: fontRegular,
      color: rgb(0.2, 0.25, 0.33),
      maxWidth: width - 96,
      lineHeight: 16,
    });

    page.drawLine({
      start: { x: 48, y: 80 },
      end: { x: width - 48, y: 80 },
      thickness: 0.75,
      color: rgb(0.86, 0.89, 0.93),
    });

    page.drawText(`Página ${i + 1} de ${records.length} · Documento de ejemplo HCESAR REVIMS "Divisor pdf"`, {
      x: 48,
      y: 60,
      size: 8.5,
      font: fontRegular,
      color: rgb(0.45, 0.51, 0.6),
    });
  }

  const bytes = await doc.save();
  return { bytes, fileName: "Expedientes_Ejemplo_5_Hojas.pdf" };
}
