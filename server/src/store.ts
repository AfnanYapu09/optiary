import fs from "node:fs";
import path from "node:path";
import { db, nowIso, uid } from "./db.js";
import { uploadsDir } from "./config.js";
import {
  IMAGE_KINDS,
  SLOTS,
  type ImageKind,
  type Metrics,
  type SlotId,
} from "./domain.js";

export type ImageRecord = {
  id: string;
  date: string;
  slot: SlotId;
  kind: ImageKind;
  mime: string;
  bytes: number;
  createdAt: string;
  url: string;
};

export type EntryRecord = {
  date: string;
  slot: SlotId;
  note: string;
  tags: string[];
  metrics: Metrics;
  updatedAt: string | null;
  images: Partial<Record<ImageKind, ImageRecord>>;
};

export type DayRecord = {
  date: string;
  slots: EntryRecord[];
  imageCount: number;
  /** 15 = five slots × three screenshots. */
  imageTarget: number;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type ImageRow = {
  id: string;
  date: string;
  slot: string;
  kind: string;
  mime: string;
  bytes: number;
  created_at: string;
};

function toImage(row: ImageRow): ImageRecord {
  return {
    id: row.id,
    date: row.date,
    slot: row.slot as SlotId,
    kind: row.kind as ImageKind,
    mime: row.mime,
    bytes: row.bytes,
    createdAt: row.created_at,
    url: `/api/images/${row.id}/file`,
  };
}

export function getDay(userId: string, date: string): DayRecord {
  const entryRows = db
    .prepare("SELECT slot, note, tags, metrics, updated_at FROM entries WHERE user_id = ? AND date = ?")
    .all(userId, date) as Array<{
    slot: string;
    note: string;
    tags: string;
    metrics: string;
    updated_at: string;
  }>;

  const imageRows = db
    .prepare(
      "SELECT id, date, slot, kind, mime, bytes, created_at FROM images WHERE user_id = ? AND date = ?",
    )
    .all(userId, date) as ImageRow[];

  const slots: EntryRecord[] = SLOTS.map((def) => {
    const row = entryRows.find((r) => r.slot === def.id);
    const images: Partial<Record<ImageKind, ImageRecord>> = {};
    for (const img of imageRows.filter((r) => r.slot === def.id)) {
      images[img.kind as ImageKind] = toImage(img);
    }
    return {
      date,
      slot: def.id,
      note: row?.note ?? "",
      tags: row ? parseJson<string[]>(row.tags, []) : [],
      metrics: row ? parseJson<Metrics>(row.metrics, {}) : {},
      updatedAt: row?.updated_at ?? null,
      images,
    };
  });

  return {
    date,
    slots,
    imageCount: imageRows.length,
    imageTarget: SLOTS.length * IMAGE_KINDS.length,
  };
}

function ensureEntry(userId: string, date: string, slot: SlotId): void {
  db.prepare(
    `INSERT INTO entries (id, user_id, date, slot, note, tags, metrics, updated_at)
     VALUES (?, ?, ?, ?, '', '[]', '{}', ?)
     ON CONFLICT (user_id, date, slot) DO NOTHING`,
  ).run(uid(), userId, date, slot, nowIso());
}

export function saveEntry(
  userId: string,
  date: string,
  slot: SlotId,
  patch: { note?: string; tags?: string[]; metrics?: Metrics },
): EntryRecord {
  ensureEntry(userId, date, slot);
  const current = getDay(userId, date).slots.find((s) => s.slot === slot)!;
  const note = patch.note ?? current.note;
  const tags = patch.tags ?? current.tags;
  const metrics = patch.metrics ? { ...current.metrics, ...patch.metrics } : current.metrics;

  db.prepare(
    "UPDATE entries SET note = ?, tags = ?, metrics = ?, updated_at = ? WHERE user_id = ? AND date = ? AND slot = ?",
  ).run(note, JSON.stringify(tags), JSON.stringify(metrics), nowIso(), userId, date, slot);

  return getDay(userId, date).slots.find((s) => s.slot === slot)!;
}

export function appendNote(userId: string, date: string, slot: SlotId, text: string, tag?: string): EntryRecord {
  const current = getDay(userId, date).slots.find((s) => s.slot === slot)!;
  const note = current.note ? `${current.note.trimEnd()}\n${text}` : text;
  const tags = tag && !current.tags.includes(tag) ? [...current.tags, tag] : current.tags;
  return saveEntry(userId, date, slot, { note, tags });
}

export function storeImage(
  userId: string,
  date: string,
  slot: SlotId,
  kind: ImageKind,
  file: { buffer: Buffer; mimetype: string; originalname: string },
): ImageRecord {
  const existing = db
    .prepare("SELECT id, filename FROM images WHERE user_id = ? AND date = ? AND slot = ? AND kind = ?")
    .get(userId, date, slot, kind) as { id: string; filename: string } | undefined;
  if (existing) removeImageFile(existing.filename);

  const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".png";
  const filename = `${userId}_${date}_${slot}_${kind}_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);

  const id = existing?.id ?? uid();
  if (existing) {
    db.prepare("UPDATE images SET filename = ?, mime = ?, bytes = ?, created_at = ? WHERE id = ?").run(
      filename,
      file.mimetype,
      file.buffer.byteLength,
      nowIso(),
      id,
    );
  } else {
    db.prepare(
      "INSERT INTO images (id, user_id, date, slot, kind, filename, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, userId, date, slot, kind, filename, file.mimetype, file.buffer.byteLength, nowIso());
  }
  ensureEntry(userId, date, slot);

  return toImage({
    id,
    date,
    slot,
    kind,
    mime: file.mimetype,
    bytes: file.buffer.byteLength,
    created_at: nowIso(),
  });
}

function removeImageFile(filename: string): void {
  // Guard against a stored name that would escape the uploads directory.
  const target = path.resolve(uploadsDir, filename);
  if (!target.startsWith(path.resolve(uploadsDir) + path.sep)) return;
  fs.rmSync(target, { force: true });
}

export function getImageFile(
  userId: string,
  imageId: string,
): { absolutePath: string; mime: string } | null {
  const row = db
    .prepare("SELECT filename, mime FROM images WHERE id = ? AND user_id = ?")
    .get(imageId, userId) as { filename: string; mime: string } | undefined;
  if (!row) return null;
  const absolutePath = path.resolve(uploadsDir, row.filename);
  if (!absolutePath.startsWith(path.resolve(uploadsDir) + path.sep)) return null;
  if (!fs.existsSync(absolutePath)) return null;
  return { absolutePath, mime: row.mime };
}

export function readImageBase64(
  userId: string,
  date: string,
  slot: SlotId,
  kind: ImageKind,
): { data: string; mime: string } | null {
  const row = db
    .prepare(
      "SELECT filename, mime FROM images WHERE user_id = ? AND date = ? AND slot = ? AND kind = ?",
    )
    .get(userId, date, slot, kind) as { filename: string; mime: string } | undefined;
  if (!row) return null;
  const abs = path.resolve(uploadsDir, row.filename);
  if (!abs.startsWith(path.resolve(uploadsDir) + path.sep) || !fs.existsSync(abs)) return null;
  return { data: fs.readFileSync(abs).toString("base64"), mime: row.mime };
}

export function deleteImage(userId: string, imageId: string): boolean {
  const row = db
    .prepare("SELECT filename FROM images WHERE id = ? AND user_id = ?")
    .get(imageId, userId) as { filename: string } | undefined;
  if (!row) return false;
  removeImageFile(row.filename);
  db.prepare("DELETE FROM images WHERE id = ? AND user_id = ?").run(imageId, userId);
  return true;
}

export type CalendarDay = {
  date: string;
  imageCount: number;
  /** One entry per slot: how many of the three screenshots exist. */
  slotCounts: number[];
  complete: boolean;
};

export function getCalendar(userId: string, month: string): CalendarDay[] {
  const rows = db
    .prepare(
      `SELECT date, slot, COUNT(*) AS n FROM images
       WHERE user_id = ? AND date LIKE ? GROUP BY date, slot`,
    )
    .all(userId, `${month}-%`) as Array<{ date: string; slot: string; n: number }>;

  const byDate = new Map<string, number[]>();
  for (const row of rows) {
    const counts = byDate.get(row.date) ?? SLOTS.map(() => 0);
    const idx = SLOTS.findIndex((s) => s.id === row.slot);
    if (idx >= 0) counts[idx] = row.n;
    byDate.set(row.date, counts);
  }

  return [...byDate.entries()]
    .map(([date, slotCounts]) => {
      const imageCount = slotCounts.reduce((a, b) => a + b, 0);
      return { date, slotCounts, imageCount, complete: slotCounts.every((n) => n >= 3) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type LibraryItem = ImageRecord & { note: string };

export function getLibrary(userId: string, kind: ImageKind | null, limit = 60): LibraryItem[] {
  const rows = (
    kind
      ? db
          .prepare(
            `SELECT i.id, i.date, i.slot, i.kind, i.mime, i.bytes, i.created_at, COALESCE(e.note, '') AS note
             FROM images i LEFT JOIN entries e
               ON e.user_id = i.user_id AND e.date = i.date AND e.slot = i.slot
             WHERE i.user_id = ? AND i.kind = ?
             ORDER BY i.date DESC, i.slot LIMIT ?`,
          )
          .all(userId, kind, limit)
      : db
          .prepare(
            `SELECT i.id, i.date, i.slot, i.kind, i.mime, i.bytes, i.created_at, COALESCE(e.note, '') AS note
             FROM images i LEFT JOIN entries e
               ON e.user_id = i.user_id AND e.date = i.date AND e.slot = i.slot
             WHERE i.user_id = ?
             ORDER BY i.date DESC, i.slot LIMIT ?`,
          )
          .all(userId, limit)
  ) as Array<ImageRow & { note: string }>;

  return rows.map((row) => ({ ...toImage(row), note: row.note }));
}

export type SeriesPoint = {
  date: string;
  slot: SlotId;
  priceClose: number | null;
  oi: number | null;
  oiChg: number | null;
  pcRatio: number | null;
};

export function getSeries(userId: string, days: number): SeriesPoint[] {
  const rows = db
    .prepare(
      `SELECT date, slot, metrics FROM entries
       WHERE user_id = ? ORDER BY date DESC, slot LIMIT ?`,
    )
    .all(userId, days * SLOTS.length) as Array<{ date: string; slot: string; metrics: string }>;

  const order = new Map(SLOTS.map((s, i) => [s.id, i]));
  return rows
    .map((row) => {
      const m = parseJson<Metrics>(row.metrics, {});
      const call = m.callOi ?? null;
      const put = m.putOi ?? null;
      return {
        date: row.date,
        slot: row.slot as SlotId,
        priceClose: m.priceClose ?? null,
        oi: call !== null && put !== null ? call + put : null,
        oiChg: m.oiChgTotal ?? null,
        pcRatio: m.pcRatio ?? null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (order.get(a.slot)! - order.get(b.slot)!));
}

export type Streak = { current: number; totalImages: number; totalDays: number; completeDays: number };

export function getStreak(userId: string): Streak {
  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM images WHERE user_id = ?) AS images,
              (SELECT COUNT(DISTINCT date) FROM images WHERE user_id = ?) AS days`,
    )
    .get(userId, userId) as { images: number; days: number };

  const perDay = db
    .prepare(
      `SELECT date, COUNT(*) AS n FROM images WHERE user_id = ? GROUP BY date ORDER BY date DESC`,
    )
    .all(userId) as Array<{ date: string; n: number }>;

  const completeDays = perDay.filter((d) => d.n >= SLOTS.length * IMAGE_KINDS.length).length;

  let current = 0;
  let cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  const complete = new Set(
    perDay.filter((d) => d.n >= SLOTS.length * IMAGE_KINDS.length).map((d) => d.date),
  );
  // Today not yet being complete shouldn't break a streak that is still in progress.
  if (!complete.has(cursor.toISOString().slice(0, 10))) {
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  while (complete.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  return { current, totalImages: totals.images, totalDays: totals.days, completeDays };
}

export function updateSettings(userId: string, settings: unknown): void {
  db.prepare("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(settings), userId);
}
