import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { isDateString, isImageKind, isSlotId } from "../domain.js";
import { deleteImage, getDay, getImageFile, getLibrary, saveEntry, storeImage } from "../store.js";
import { extractSlotMetrics } from "../ai/extract.js";
import { describeAiError } from "../ai/client.js";

export const imageRoutes = Router();

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error("รองรับเฉพาะไฟล์ PNG, JPEG, WebP และ GIF"));
      return;
    }
    cb(null, true);
  },
});

imageRoutes.use(["/images", "/images/*", "/library", "/extract/*"], requireUser);

imageRoutes.get("/library", (req, res) => {
  const kindParam = typeof req.query.kind === "string" ? req.query.kind : "";
  const kind = isImageKind(kindParam) ? kindParam : null;
  res.json({ items: getLibrary(req.user!.id, kind) });
});

imageRoutes.get("/images/:id/file", (req, res) => {
  const file = getImageFile(req.user!.id, req.params.id);
  if (!file) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(file.absolutePath);
});

imageRoutes.post("/images/:date/:slot/:kind", upload.single("file"), async (req, res) => {
  const { date, slot, kind } = req.params;
  if (!isDateString(date) || !isSlotId(slot) || !isImageKind(kind)) {
    res.status(400).json({ error: "bad date, slot or kind" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "ไม่พบไฟล์ภาพ" });
    return;
  }

  const image = storeImage(req.user!.id, date, slot, kind, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    originalname: req.file.originalname,
  });

  // Auto-extraction is a user preference; a failure here must not fail the upload.
  let extraction: { ok: true } | { ok: false; message: string } | null = null;
  if (req.user!.settings.autoExtract) {
    try {
      const result = await extractSlotMetrics(req.user!.id, date, slot);
      saveEntry(req.user!.id, date, slot, { metrics: result.metrics });
      extraction = { ok: true };
    } catch (error) {
      extraction = { ok: false, message: describeAiError(error).message };
    }
  }

  res.json({ image, extraction, day: getDay(req.user!.id, date) });
});

imageRoutes.delete("/images/:id", (req, res) => {
  if (!deleteImage(req.user!.id, req.params.id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

imageRoutes.post("/extract/:date/:slot", async (req, res) => {
  const { date, slot } = req.params;
  if (!isDateString(date) || !isSlotId(slot)) {
    res.status(400).json({ error: "bad date or slot" });
    return;
  }
  try {
    const result = await extractSlotMetrics(req.user!.id, date, slot);
    const entry = saveEntry(req.user!.id, date, slot, { metrics: result.metrics });
    res.json({ entry, confidence: result.confidence });
  } catch (error) {
    const { status, message } = describeAiError(error);
    res.status(status).json({ error: message });
  }
});

// Surfaces multer's own failures (file too large, wrong type) as clean JSON.
imageRoutes.use((err: Error, _req: unknown, res: any, next: (e?: unknown) => void) => {
  if (err instanceof multer.MulterError) {
    res.status(413).json({ error: "ไฟล์ใหญ่เกินกำหนด" });
    return;
  }
  if (err?.message?.startsWith("รองรับเฉพาะ")) {
    res.status(415).json({ error: err.message });
    return;
  }
  next(err);
});
