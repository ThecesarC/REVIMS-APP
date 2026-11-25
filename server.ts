import express from "express";
import type { Request, Response } from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import {
  handleExtractName,
  handleExtractNamesBatch,
  handleExtractNamesSheet,
  handleExtractNamesTextBatch,
} from "./shared/geminiExtractor";

dotenv.config();

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, runtime: "express" });
  });

  app.post("/api/extract-name", async (req: Request, res: Response) => {
    const result = await handleExtractName(req.body);
    res.status(result.status).json(result.body);
  });

  app.post("/api/extract-names-sheet", async (req: Request, res: Response) => {
    const result = await handleExtractNamesSheet(req.body);
    res.status(result.status).json(result.body);
  });

  app.post("/api/extract-names-batch", async (req: Request, res: Response) => {
    const result = await handleExtractNamesBatch(req.body);
    res.status(result.status).json(result.body);
  });

  app.post("/api/extract-names-text-batch", async (req: Request, res: Response) => {
    const result = await handleExtractNamesTextBatch(req.body);
    res.status(result.status).json(result.body);
  });

  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*all", (_req: Request, res: Response) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HCESAR REVIMS "Divisor pdf" server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
