import { GoogleGenAI, Type } from "@google/genai";

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_MODELS = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"] as const;
type AllowedModel = (typeof ALLOWED_MODELS)[number];

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY no está configurada en las variables de entorno del servidor.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

interface ParsedApiError {
  status: number;
  code: string;
  retrySeconds: number | null;
  userMessage: string;
}

function parseRetrySeconds(rawMessage: string): number | null {
  const secMatch = rawMessage.match(/retryDelay["']?\s*[:=]\s*["']?(\d+)s/i);
  if (secMatch) return Number(secMatch[1]);

  const humanMatch = rawMessage.match(/Please retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
  if (humanMatch) {
    const h = Number(humanMatch[1] ?? 0);
    const m = Number(humanMatch[2] ?? 0);
    const s = Number(humanMatch[3] ?? 0);
    return Math.ceil(h * 3600 + m * 60 + s);
  }
  return null;
}

export function parseGeminiError(error: unknown): ParsedApiError {
  const errObj = error as { status?: number; message?: string };
  let status = typeof errObj?.status === "number" ? errObj.status : 500;
  let rawMessage = typeof errObj?.message === "string" ? errObj.message : "";
  let apiStatus = "";

  if (rawMessage.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawMessage) as {
        error?: { code?: number; message?: string; status?: string };
      };
      if (parsed?.error) {
        if (typeof parsed.error.code === "number") status = parsed.error.code;
        if (typeof parsed.error.status === "string") apiStatus = parsed.error.status;
        if (typeof parsed.error.message === "string") rawMessage = parsed.error.message;
      }
    } catch {
      // keep rawMessage
    }
  }

  const retrySeconds = parseRetrySeconds(rawMessage);

  if (status === 429 || apiStatus === "RESOURCE_EXHAUSTED") {
    const waitHint =
      retrySeconds && retrySeconds > 60
        ? ` (reinicio estimado en ${Math.ceil(retrySeconds / 60)} min)`
        : retrySeconds
        ? ` (espera sugerida: ${retrySeconds}s)`
        : "";
    return {
      status: 429,
      code: "RESOURCE_EXHAUSTED",
      retrySeconds,
      userMessage: `Se alcanzó el límite diario gratuito de solicitudes en los modelos de Gemini${waitHint}. Para continuar sin límites ahora mismo puedes usar "OCR en Zona" o "Híbrido", o asignar una clave con facturación en Settings > Secrets.`,
    };
  }

  if (status === 403 || apiStatus === "PERMISSION_DENIED" || apiStatus === "API_KEY_INVALID") {
    return {
      status,
      code: apiStatus || "AUTH_ERROR",
      retrySeconds: null,
      userMessage:
        "La clave de API de Gemini es inválida o no tiene permisos. Verifica la variable GEMINI_API_KEY en el servidor.",
    };
  }

  return {
    status: status >= 400 && status < 600 ? status : 500,
    code: apiStatus || "UPSTREAM_ERROR",
    retrySeconds: null,
    userMessage: rawMessage || "No se pudo procesar la página con el servicio de IA.",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveModelOrder(preferred?: unknown): AllowedModel[] {
  if (preferred === "gemini-3.1-flash-lite") {
    return ["gemini-3.1-flash-lite", "gemini-4-hydrogen"];
  }
  return ["gemini-4-hydrogen", "gemini-3.1-flash-lite"];
}

async function generateWithSmartModelCascade<T>(
  preferredModel: unknown,
  runner: (model: AllowedModel) => Promise<T>
): Promise<{ result: T; modelUsed: AllowedModel }> {
  const models = resolveModelOrder(preferredModel);
  let lastError: unknown;

  for (const model of models) {
    try {
      const result = await runner(model);
      return { result, modelUsed: model };
    } catch (err: unknown) {
      lastError = err;
      const parsed = parseGeminiError(err);

      if (parsed.status === 429 && parsed.retrySeconds !== null && parsed.retrySeconds <= 15) {
        await sleep((parsed.retrySeconds + 1) * 1000);
        try {
          const retryResult = await runner(model);
          return { result: retryResult, modelUsed: model };
        } catch (retryErr: unknown) {
          lastError = retryErr;
        }
      }

      if (parsed.status === 429 || parsed.status === 404 || parsed.status >= 500) {
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export async function handleExtractName(rawBody: unknown): Promise<HandlerResult> {
  try {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim() : "image/png";
    const customHint =
      typeof body.customHint === "string" ? body.customHint.slice(0, 300).trim() : "";
    const pageNumber = typeof body.pageNumber === "number" ? body.pageNumber : 1;
    const isFullPage = Boolean(body.isFullPage);

    if (!imageBase64 || imageBase64.length > 10 * 1024 * 1024) {
      return {
        status: 400,
        body: { error: "Imagen inválida o demasiado grande para analizar." },
      };
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return {
        status: 400,
        body: { error: "Tipo de imagen no compatible. Usa PNG, JPEG o WEBP." },
      };
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
    const ai = getGeminiClient();

    const instruction = [
      "Eres un especialista en análisis documental y extracción precisa de nombres propios en documentos complejos.",
      isFullPage
        ? "Analiza la página completa y localiza el nombre de la persona principal (usualmente en la esquina superior izquierda o encabezado del titular/destinatario/paciente/empleado)."
        : "Analiza este recorte de página y extrae el nombre completo de la persona.",
      "Reglas estrictas:",
      "1. Devuelve únicamente el nombre de la persona (o razón social si no hay persona física) sin etiquetas previas ('Nombre:', 'Titular:', 'Paciente:', 'Sr.', 'C.', 'Folio', fechas o IDs).",
      "2. Corrige errores menores de escaneo manteniendo el nombre real exacto.",
      "3. Si no existe ningún nombre legible, devuelve una cadena vacía en fullName y confidence 'none'.",
      customHint ? `Indicación adicional del usuario: ${customHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const { result: response, modelUsed } = await generateWithSmartModelCascade(
      body.preferredModel,
      (model) =>
        ai.models.generateContent({
          model,
          contents: {
            parts: [
              { inlineData: { mimeType, data: cleanBase64 } },
              { text: `Extrae el nombre de la persona correspondiente a la página ${pageNumber}.` },
            ],
          },
          config: {
            systemInstruction: instruction,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                fullName: { type: Type.STRING },
                rawText: { type: Type.STRING },
                confidence: { type: Type.STRING },
              },
              required: ["fullName", "rawText", "confidence"],
            },
          },
        })
    );

    const rawJson = (response.text ?? "{}").trim();
    let parsed: { fullName?: string; rawText?: string; confidence?: string } = {};
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = { fullName: "", rawText: rawJson, confidence: "low" };
    }

    return {
      status: 200,
      body: {
        fullName: typeof parsed.fullName === "string" ? parsed.fullName.trim() : "",
        rawText: typeof parsed.rawText === "string" ? parsed.rawText.trim() : "",
        confidence: typeof parsed.confidence === "string" ? parsed.confidence : "medium",
        modelUsed,
      },
    };
  } catch (error: unknown) {
    const parsedErr = parseGeminiError(error);
    return {
      status: parsedErr.status,
      body: { error: parsedErr.userMessage, code: parsedErr.code },
    };
  }
}

export async function handleExtractNamesSheet(rawBody: unknown): Promise<HandlerResult> {
  try {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const sheetBase64 = typeof body.sheetBase64 === "string" ? body.sheetBase64.trim() : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim() : "image/jpeg";
    const pageNumbers = Array.isArray(body.pageNumbers)
      ? body.pageNumbers.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
      : [];
    const customHint =
      typeof body.customHint === "string" ? body.customHint.slice(0, 300).trim() : "";

    if (!sheetBase64 || sheetBase64.length > 15 * 1024 * 1024) {
      return { status: 400, body: { error: "Hoja de lote inválida o demasiado grande." } };
    }
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return { status: 400, body: { error: "Formato de imagen no compatible." } };
    }
    if (pageNumbers.length === 0 || pageNumbers.length > 20) {
      return { status: 400, body: { error: "El lote debe incluir entre 1 y 20 páginas." } };
    }

    const cleanBase64 = sheetBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
    const ai = getGeminiClient();

    const instruction = [
      "Recibirás una sola imagen compuesta verticalmente por múltiples filas etiquetadas en el borde izquierdo como 'PAG <número>'.",
      "Cada fila muestra el recorte superior izquierdo de una página diferente.",
      "Para CADA etiqueta PAG presente en la imagen, extrae el nombre completo de la persona.",
      "Reglas estrictas:",
      "1. Devuelve únicamente el nombre propio de la persona (o razón social si no hay persona) sin prefijos como 'Nombre:', 'Titular:', 'Paciente:', 'Sr.', 'C.', ni fechas o folios.",
      "2. Asocia exactamente el número entero 'pageNumber' de la etiqueta negra izquierda (ej. PAG 5 -> pageNumber: 5).",
      "3. Si una fila está en blanco o no tiene un nombre legible, devuelve fullName: '' y confidence: 'none'.",
      customHint ? `Indicación adicional del usuario: ${customHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const { result: response, modelUsed } = await generateWithSmartModelCascade(
      body.preferredModel,
      (model) =>
        ai.models.generateContent({
          model,
          contents: {
            parts: [
              { inlineData: { mimeType, data: cleanBase64 } },
              {
                text: `Extrae un objeto por cada una de estas páginas visibles en las filas: ${pageNumbers.join(", ")}.`,
              },
            ],
          },
          config: {
            systemInstruction: instruction,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                results: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      pageNumber: { type: Type.INTEGER },
                      fullName: { type: Type.STRING },
                      rawText: { type: Type.STRING },
                      confidence: { type: Type.STRING },
                    },
                    required: ["pageNumber", "fullName", "rawText", "confidence"],
                  },
                },
              },
              required: ["results"],
            },
          },
        })
    );

    const rawJson = (response.text ?? "{}").trim();
    let parsed: {
      results?: Array<{
        pageNumber?: number;
        fullName?: string;
        rawText?: string;
        confidence?: string;
      }>;
    } = {};
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = { results: [] };
    }

    return {
      status: 200,
      body: {
        results: Array.isArray(parsed.results) ? parsed.results : [],
        modelUsed,
      },
    };
  } catch (error: unknown) {
    const parsedErr = parseGeminiError(error);
    return {
      status: parsedErr.status,
      body: { error: parsedErr.userMessage, code: parsedErr.code },
    };
  }
}

export async function handleExtractNamesBatch(rawBody: unknown): Promise<HandlerResult> {
  try {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const rawPages = Array.isArray(body.pages)
      ? (body.pages as Array<Record<string, unknown>>)
      : [];
    const customHint =
      typeof body.customHint === "string" ? body.customHint.slice(0, 300).trim() : "";
    const isFullPage = Boolean(body.isFullPage);

    if (rawPages.length === 0 || rawPages.length > 10) {
      return { status: 400, body: { error: "El lote debe contener entre 1 y 10 páginas." } };
    }

    const parts: Array<
      { text: string } | { inlineData: { mimeType: string; data: string } }
    > = [];
    const pageNumbers: number[] = [];

    for (const item of rawPages) {
      const pageNumber =
        typeof item.pageNumber === "number" && Number.isInteger(item.pageNumber)
          ? item.pageNumber
          : null;
      const imageBase64 =
        typeof item.imageBase64 === "string" ? item.imageBase64.trim() : "";
      const mimeType =
        typeof item.mimeType === "string" ? item.mimeType.trim() : "image/jpeg";

      if (!pageNumber || !imageBase64 || imageBase64.length > 6 * 1024 * 1024) {
        return { status: 400, body: { error: "Datos inválidos en una de las páginas del lote." } };
      }
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        return { status: 400, body: { error: "Tipo de imagen no compatible en el lote." } };
      }

      const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
      pageNumbers.push(pageNumber);
      parts.push({ text: `--- Imagen de la Página ${pageNumber} ---` });
      parts.push({ inlineData: { mimeType, data: cleanBase64 } });
    }

    parts.push({
      text: `Devuelve un arreglo JSON con un resultado exacto por cada página enviada (${pageNumbers.join(", ")}).`,
    });

    const ai = getGeminiClient();

    const instruction = [
      "Eres un especialista en análisis documental y extracción precisa de nombres propios en documentos complejos.",
      isFullPage
        ? "Recibirás múltiples páginas completas etiquetadas por su número. Para cada página, localiza el nombre de la persona principal (usualmente en la esquina superior izquierda o encabezado)."
        : "Recibirás múltiples recortes etiquetados por número de página. Para cada imagen, extrae el nombre completo de la persona.",
      "Reglas estrictas:",
      "1. Devuelve únicamente el nombre de la persona (o razón social si no hay persona física) sin etiquetas previas ('Nombre:', 'Titular:', 'Paciente:', 'Sr.', 'C.', 'Folio', fechas o IDs).",
      "2. Mantén exactamente el número de página (pageNumber) asociado a cada imagen.",
      "3. Si una imagen no contiene ningún nombre legible, devuelve cadena vacía en fullName y confidence 'none'.",
      customHint ? `Indicación adicional del usuario: ${customHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const { result: response, modelUsed } = await generateWithSmartModelCascade(
      body.preferredModel,
      (model) =>
        ai.models.generateContent({
          model,
          contents: { parts },
          config: {
            systemInstruction: instruction,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                results: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      pageNumber: { type: Type.INTEGER },
                      fullName: { type: Type.STRING },
                      rawText: { type: Type.STRING },
                      confidence: { type: Type.STRING },
                    },
                    required: ["pageNumber", "fullName", "rawText", "confidence"],
                  },
                },
              },
              required: ["results"],
            },
          },
        })
    );

    const rawJson = (response.text ?? "{}").trim();
    let parsed: {
      results?: Array<{
        pageNumber?: number;
        fullName?: string;
        rawText?: string;
        confidence?: string;
      }>;
    } = {};
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = { results: [] };
    }

    return {
      status: 200,
      body: {
        results: Array.isArray(parsed.results) ? parsed.results : [],
        modelUsed,
      },
    };
  } catch (error: unknown) {
    const parsedErr = parseGeminiError(error);
    return {
      status: parsedErr.status,
      body: { error: parsedErr.userMessage, code: parsedErr.code },
    };
  }
}

export async function handleExtractNamesTextBatch(rawBody: unknown): Promise<HandlerResult> {
  try {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const items = Array.isArray(body.items)
      ? (body.items as Array<Record<string, unknown>>)
      : [];
    const customHint =
      typeof body.customHint === "string" ? body.customHint.slice(0, 300).trim() : "";

    if (items.length === 0 || items.length > 60) {
      return { status: 400, body: { error: "El lote de texto debe incluir entre 1 y 60 páginas." } };
    }

    const formattedLines = items
      .map((it) => {
        const pn = typeof it.pageNumber === "number" ? it.pageNumber : 0;
        const txt = typeof it.rawText === "string" ? it.rawText.slice(0, 800).trim() : "";
        return `[PAG ${pn}]: ${txt.replace(/\s+/g, " ")}`;
      })
      .join("\n");

    const ai = getGeminiClient();
    const instruction = [
      "Recibirás fragmentos de texto bruto (extraído por OCR o PDF) de múltiples páginas, uno por línea como [PAG <n>]: <texto>.",
      "Para cada página, identifica y limpia el nombre completo de la persona titular/destinataria.",
      "Elimina prefijos ('Nombre:', 'Titular:', 'Paciente:', 'Sr.'), números de folio, fechas, RFC, CURP o errores evidentes de OCR.",
      customHint ? `Indicación adicional: ${customHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const { result: response, modelUsed } = await generateWithSmartModelCascade(
      body.preferredModel,
      (model) =>
        ai.models.generateContent({
          model,
          contents: formattedLines,
          config: {
            systemInstruction: instruction,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                results: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      pageNumber: { type: Type.INTEGER },
                      fullName: { type: Type.STRING },
                      confidence: { type: Type.STRING },
                    },
                    required: ["pageNumber", "fullName", "confidence"],
                  },
                },
              },
              required: ["results"],
            },
          },
        })
    );

    const rawJson = (response.text ?? "{}").trim();
    let parsed: {
      results?: Array<{ pageNumber?: number; fullName?: string; confidence?: string }>;
    } = {};
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = { results: [] };
    }

    return {
      status: 200,
      body: {
        results: Array.isArray(parsed.results) ? parsed.results : [],
        modelUsed,
      },
    };
  } catch (error: unknown) {
    const parsedErr = parseGeminiError(error);
    return {
      status: parsedErr.status,
      body: { error: parsedErr.userMessage, code: parsedErr.code },
    };
  }
}
