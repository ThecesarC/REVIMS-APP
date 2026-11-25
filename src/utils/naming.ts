import type { NamingConfig, PageRecord } from "../types/pdf";

const LABEL_PREFIX_REGEX =
  /^(?:nombre(?:\s+completo)?(?:\s+del\s+(?:titular|paciente|cliente|alumno|empleado|beneficiario))?|titular|paciente|cliente|alumno|estudiante|empleado|trabajador|colaborador|beneficiario|destinatario|interesado|solicitante|raz[oó]n\s+social|contribuyente|asegurado|suscriptor|atn\.?|para|de|sr\.?|sra\.?|srta\.?|dr\.?|dra\.?|lic\.?|ing\.?|c\.?)\s*[:.\-]?\s+/i;

const NOISE_LINE_REGEX =
  /^(?:p[aá]g(?:ina)?\.?\s*\d+|folio\s*[:#]?\s*[\w-]+|fecha\s*:|rfc\s*:|curp\s*:|nss\s*:|id\s*:|no\.?\s*:|tel[eé]fono|correo|email|direcci[oó]n|domicilio|calle\b|av\.?\b|col\.?\b|c\.?p\.?\s*\d+|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[\w.-]+@[\w.-]+\.\w+)$/i;

export function cleanExtractedPersonName(raw: string): string {
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  const candidates: Array<{ text: string; score: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const hadNameLabel =
      /^(?:nombre|titular|paciente|cliente|alumno|empleado|beneficiario|destinatario|asegurado)/i.test(
        rawLine
      );

    let cleaned = rawLine.replace(LABEL_PREFIX_REGEX, "").trim();
    cleaned = cleaned.replace(LABEL_PREFIX_REGEX, "").trim();
    cleaned = cleaned.replace(/^[•\-–—|:,;.\[\]()]+/, "").trim();
    cleaned = cleaned.replace(/[|]+$/g, "").trim();

    if (!cleaned || NOISE_LINE_REGEX.test(cleaned)) continue;
    if (/^[\d\s\-./#:]+$/.test(cleaned)) continue;

    // Strip trailing folio/date/ID fragments on the same line
    cleaned = cleaned
      .replace(/\s+(?:folio|fecha|rfc|curp|id|no\.?)\s*[:#]?.*$/i, "")
      .trim();

    if (!cleaned || cleaned.length < 3) continue;

    const words = cleaned.split(/\s+/).filter(Boolean);
    const alphaWords = words.filter((w) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'-]+$/.test(w));

    let score = 0;
    if (hadNameLabel) score += 5;
    if (alphaWords.length >= 2 && alphaWords.length <= 5) score += 4;
    if (alphaWords.length === words.length) score += 2;
    if (i === 0) score += 1;

    candidates.push({ text: cleaned, score });
  }

  if (candidates.length === 0) {
    return lines[0].replace(/\s+/g, " ").trim().slice(0, 120);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function removeSpanishAccents(input: string): string {
  return input
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function sanitizeFileSegment(input: string): string {
  return input
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\.+$/g, "")
    .trim();
}

function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
    .join(" ");
}

export function formatPageBaseName(
  page: PageRecord,
  totalPages: number,
  originalPdfName: string,
  config: NamingConfig
): string {
  const padLen = Math.max(2, String(totalPages).length);
  const pageStr = String(page.pageNumber).padStart(padLen, "0");
  const originalBase = originalPdfName.replace(/\.pdf$/i, "") || "documento";
  const today = new Date().toISOString().slice(0, 10);

  const rawName = page.extractedName.trim();
  const fallbackName = `${config.fallbackPrefix || "Pagina"}_${pageStr}`;
  const effectiveName = rawName || fallbackName;

  let template = (config.template || "{nombre}").trim();
  if (!template) template = "{nombre}";

  let result = template
    .replace(/\{nombre\}/gi, effectiveName)
    .replace(/\{pagina\}/gi, pageStr)
    .replace(/\{original\}/gi, originalBase)
    .replace(/\{fecha\}/gi, today);

  if (config.stripAccents || config.caseMode === "slug") {
    result = removeSpanishAccents(result);
  }

  switch (config.caseMode) {
    case "title":
      result = toTitleCase(result);
      break;
    case "upper":
      result = result.toUpperCase();
      break;
    case "slug":
      result = result
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      break;
    case "original":
    default:
      break;
  }

  if (config.replaceSpaces && config.caseMode !== "slug") {
    result = result.replace(/\s+/g, "_");
  }

  result = sanitizeFileSegment(result);
  if (!result) {
    result = fallbackName;
  }
  return result.slice(0, 140);
}

export function buildUniqueFilenames(
  pages: PageRecord[],
  totalPages: number,
  originalPdfName: string,
  config: NamingConfig
): Map<number, string> {
  const counts = new Map<string, number>();
  const result = new Map<number, string>();

  for (const page of pages) {
    const base = formatPageBaseName(page, totalPages, originalPdfName, config);
    const key = base.toLowerCase();
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);

    const uniqueBase = seen === 0 ? base : `${base}_${seen + 1}`;
    result.set(page.pageNumber, `${uniqueBase}.pdf`);
  }

  return result;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
