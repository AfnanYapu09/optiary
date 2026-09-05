import { Router } from "express";
import multer from "multer";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { isDateString, isDayImageKind, isImageKind, isSlotId } from "../domain.js";
import {
  deleteDayImage,
  deleteImage,
  getDay,
  getImageFile,
  getLibrary,
  saveEntry,
  storeDayImage,
  storeImage,
} from "../store.js";
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

// `/days/*` is guarded by dayRoutes too; repeated here so this file's routes do
// not depend on another router being mounted first for their authorization.
imageRoutes.use(
  ["/images", "/images/*", "/library", "/extract/*", "/days/*"],
  requireUser,
);

/**
 * The day's own screenshots — the intraday chart before the news, and the
 * reveal. One of each per day, so the kind is the address and there is no id to
 * pass: uploading again replaces what was there.
 */
imageRoutes.post("/days/:date/shot/:kind", upload.single("file") as any, async (req, res) => {
  const date = String(req.params.date ?? "");
  const kind = String(req.params.kind ?? "");
  if (!isDateString(date) || !isDayImageKind(kind)) {
    res.status(400).json({ error: "bad date or kind" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "ไม่พบไฟล์ภาพ" });
    return;
  }

  const image = await storeDayImage(req.user!.id, date, kind, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    originalname: req.file.originalname,
  });
  res.json({ image, day: await getDay(req.user!.id, date) });
});

imageRoutes.delete("/days/:date/shot/:kind", async (req, res) => {
  const date = String(req.params.date ?? "");
  const kind = String(req.params.kind ?? "");
  if (!isDateString(date) || !isDayImageKind(kind)) {
    res.status(400).json({ error: "bad date or kind" });
    return;
  }
  if (!(await deleteDayImage(req.user!.id, date, kind))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true, day: await getDay(req.user!.id, date) });
});

imageRoutes.get("/library", async (req, res) => {
  const kindParam = typeof req.query.kind === "string" ? req.query.kind : "";
  const kind = isImageKind(kindParam) ? kindParam : null;
  res.json({ items: await getLibrary(req.user!.id, kind) });
});

imageRoutes.get("/images/:id/file", async (req, res) => {
  const id = String(req.params.id ?? "");
  const file = await getImageFile(req.user!.id, id);
  if (!file) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(file.data);
});

imageRoutes.post("/images/:date/:slot/:kind", upload.single("file") as any, async (req, res) => {
  const date = String(req.params.date ?? "");
  const slot = String(req.params.slot ?? "");
  const kind = String(req.params.kind ?? "");
  if (!isDateString(date) || !isSlotId(slot) || !isImageKind(kind)) {
    res.status(400).json({ error: "bad date, slot or kind" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "ไม่พบไฟล์ภาพ" });
    return;
  }

  const image = await storeImage(req.user!.id, date, slot, kind, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    originalname: req.file.originalname,
  });

  // Auto-extraction is a user preference; a failure here must not fail the upload.
  let extraction: { ok: true } | { ok: false; message: string } | null = null;
  if (req.user!.settings.autoExtract) {
    try {
      const result = await extractSlotMetrics(req.user!.id, date, slot);
      await saveEntry(req.user!.id, date, slot, { metrics: result.metrics });
      extraction = { ok: true };
    } catch (error) {
      extraction = { ok: false, message: describeAiError(error).message };
    }
  }

  res.json({ image, extraction, day: await getDay(req.user!.id, date) });
});

imageRoutes.delete("/images/:id", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!(await deleteImage(req.user!.id, id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

imageRoutes.post("/extract/:date/:slot", async (req, res) => {
  const date = String(req.params.date ?? "");
  const slot = String(req.params.slot ?? "");
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
