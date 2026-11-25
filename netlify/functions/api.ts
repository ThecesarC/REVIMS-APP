import {
  handleExtractName,
  handleExtractNamesBatch,
  handleExtractNamesSheet,
  handleExtractNamesTextBatch,
} from "../../shared/geminiExtractor";

function jsonResponse(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const route = url.pathname
    .replace(/^\/\.netlify\/functions\/api/, "")
    .replace(/^\/api/, "");

  if (req.method === "GET" && route === "/health") {
    return jsonResponse(200, { ok: true, runtime: "netlify-functions" });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Método no permitido." });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Cuerpo JSON inválido en la solicitud." });
  }

  if (route === "/extract-name") {
    const result = await handleExtractName(body);
    return jsonResponse(result.status, result.body);
  }

  if (route === "/extract-names-sheet") {
    const result = await handleExtractNamesSheet(body);
    return jsonResponse(result.status, result.body);
  }

  if (route === "/extract-names-batch") {
    const result = await handleExtractNamesBatch(body);
    return jsonResponse(result.status, result.body);
  }

  if (route === "/extract-names-text-batch") {
    const result = await handleExtractNamesTextBatch(body);
    return jsonResponse(result.status, result.body);
  }

  return jsonResponse(404, { error: `Ruta de API no encontrada: ${route}` });
}
