import fs from "node:fs";
import path from "node:path";
import { db, nowIso, uid } from "./db.js";
import { uploadsDir } from "./config.js";
import {
  IMAGE_KINDS,
  SLOTS,
  SLOT_IDS,
  type DayNews,
  type ImageKind,
  type Metrics,
  type NewsEvent,
  type SlotId,
} from "./domain.js";
import { getUser } from "./auth.js";

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
  /** Day-level economic news, shown under the slots regardless of which is open. */
  news: DayNews;
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
    news: getDayNews(userId, date),
  };
}

export function getDayNews(userId: string, date: string): DayNews {
  const row = db
    .prepare("SELECT events, week_summary FROM day_news WHERE user_id = ? AND date = ?")
    .get(userId, date) as { events: string; week_summary: string } | undefined;
  return {
    events: row ? parseJson<NewsEvent[]>(row.events, []) : [],
    weekSummary: row?.week_summary ?? "",
  };
}

/**
 * Upserts a day's news. `events` replaces the stored list; `weekSummary`, when
 * given, is stored on that same date (the model passes the week's anchor date).
 */
export function saveDayNews(
  userId: string,
  date: string,
  patch: { events?: NewsEvent[]; weekSummary?: string },
): void {
  const current = getDayNews(userId, date);
  const events = patch.events ?? current.events;
  const weekSummary = patch.weekSummary ?? current.weekSummary;
  db.prepare(
    `INSERT INTO day_news (user_id, date, events, week_summary, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, date) DO UPDATE SET events = excluded.events, week_summary = excluded.week_summary, updated_at = excluded.updated_at`,
  ).run(userId, date, JSON.stringify(events), weekSummary, nowIso());
}

export function deleteDayNews(userId: string, date: string): void {
  db.prepare("DELETE FROM day_news WHERE user_id = ? AND date = ?").run(userId, date);
}

/** Dates in `month` (YYYY-MM) that carry at least one news event. */
export function newsDatesInMonth(userId: string, month: string): string[] {
  const rows = db
    .prepare(
      "SELECT date FROM day_news WHERE user_id = ? AND date LIKE ? AND events != '[]'",
    )
    .all(userId, `${month}-%`) as Array<{ date: string }>;
  return rows.map((r) => r.date);
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

/**
 * Appends to a whole-day note (economic-news lines, holidays) — there is no
 * per-day note row, so it lands on the first enabled slot of that day.
 */
export function appendDayNote(userId: string, date: string, text: string, tag?: string): SlotId {
  const settings = getUser(userId)?.settings;
  const slot = SLOT_IDS.find((id) => settings?.slots?.[id]?.enabled) ?? SLOT_IDS[0];
  appendNote(userId, date, slot, text, tag);
  return slot;
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

/**
 * Persists an image the user dropped into the chat so the transcript can show it
 * later. This is separate from `storeImage` (the dated library): a chat image is
 * tied to a message, not to a slot, and the model may or may not also file it.
 */
export function storeChatAttachment(
  userId: string,
  messageId: string,
  file: { buffer: Buffer; mime: string; originalname: string },
): { id: string; mime: string } {
  const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".png";
  const id = uid();
  const filename = `chat_${userId}_${id}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
  db.prepare(
    "INSERT INTO chat_attachments (id, user_id, message_id, filename, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, messageId, filename, file.mime, file.buffer.byteLength, nowIso());
  return { id, mime: file.mime };
}

export function getChatAttachmentFile(
  userId: string,
  attachmentId: string,
): { absolutePath: string; mime: string } | null {
  const row = db
    .prepare("SELECT filename, mime FROM chat_attachments WHERE id = ? AND user_id = ?")
    .get(attachmentId, userId) as { filename: string; mime: string } | undefined;
  if (!row) return null;
  const absolutePath = path.resolve(uploadsDir, row.filename);
  if (!absolutePath.startsWith(path.resolve(uploadsDir) + path.sep)) return null;
  if (!fs.existsSync(absolutePath)) return null;
  return { absolutePath, mime: row.mime };
}

export function deleteChatAttachment(userId: string, attachmentId: string): void {
  const row = db
    .prepare("SELECT filename FROM chat_attachments WHERE id = ? AND user_id = ?")
    .get(attachmentId, userId) as { filename: string } | undefined;
  if (!row) return;
  removeImageFile(row.filename);
  db.prepare("DELETE FROM chat_attachments WHERE id = ? AND user_id = ?").run(attachmentId, userId);
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

/** Deletes one screenshot addressed the way the research diary thinks of it. */
export function deleteImageAt(
  userId: string,
  date: string,
  slot: SlotId,
  kind: ImageKind,
): boolean {
  const row = db
    .prepare(
      "SELECT id FROM images WHERE user_id = ? AND date = ? AND slot = ? AND kind = ?",
    )
    .get(userId, date, slot, kind) as { id: string } | undefined;
  return row ? deleteImage(userId, row.id) : false;
}

function removeImagesWhere(userId: string, clause: string, params: string[]): number {
  const rows = db
    .prepare(`SELECT id, filename FROM images WHERE user_id = ? AND ${clause}`)
    .all(userId, ...params) as Array<{ id: string; filename: string }>;
  for (const r of rows) removeImageFile(r.filename);
  db.prepare(`DELETE FROM images WHERE user_id = ? AND ${clause}`).run(userId, ...params);
  return rows.length;
}

/** What one slot currently holds — used to preview a delete before doing it. */
export function slotFootprint(
  userId: string,
  date: string,
  slot: SlotId,
): { hasNote: boolean; tags: number; hasMetrics: boolean; images: number } {
  const s = getDay(userId, date).slots.find((x) => x.slot === slot)!;
  return {
    hasNote: Boolean(s.note),
    tags: s.tags.length,
    hasMetrics: Object.keys(s.metrics).length > 0,
    images: Object.keys(s.images).length,
  };
}

/** Clears a slot's note, tags and metrics; also its screenshots when asked. */
export function clearSlot(
  userId: string,
  date: string,
  slot: SlotId,
  opts: { images?: boolean } = {},
): { images: number } {
  ensureEntry(userId, date, slot);
  db.prepare(
    "UPDATE entries SET note = '', tags = '[]', metrics = '{}', updated_at = ? WHERE user_id = ? AND date = ? AND slot = ?",
  ).run(nowIso(), userId, date, slot);
  const images = opts.images
    ? removeImagesWhere(userId, "date = ? AND slot = ?", [date, slot])
    : 0;
  return { images };
}

export function dayFootprint(
  userId: string,
  date: string,
): { slotsWithData: number; images: number; newsEvents: number } {
  const day = getDay(userId, date);
  return {
    slotsWithData: day.slots.filter(
      (s) => s.note || s.tags.length || Object.keys(s.metrics).length > 0,
    ).length,
    images: day.imageCount,
    newsEvents: day.news.events.length,
  };
}

/** Deletes every entry, screenshot and news item for one date. */
export function deleteDay(userId: string, date: string): { entries: number; images: number } {
  const images = removeImagesWhere(userId, "date = ?", [date]);
  const entries = Number(
    db.prepare("DELETE FROM entries WHERE user_id = ? AND date = ?").run(userId, date).changes,
  );
  deleteDayNews(userId, date);
  return { entries, images };
}

/** Every date the user has an entry or a screenshot on, newest first. */
export function listDataDates(userId: string): string[] {
  const rows = db
    .prepare(
      `SELECT date FROM entries WHERE user_id = ?
       UNION SELECT date FROM images WHERE user_id = ?
       ORDER BY date DESC`,
    )
    .all(userId, userId) as Array<{ date: string }>;
  return rows.map((r) => r.date);
}

/** Totals across the whole account — the preview for a full wipe. */
export function dataFootprint(userId: string): {
  days: number;
  entries: number;
  notes: number;
  images: number;
  newsDays: number;
  messages: number;
} {
  const one = (sql: string) => (db.prepare(sql).get(userId) as { n: number }).n;
  return {
    days: listDataDates(userId).length,
    entries: one("SELECT COUNT(*) n FROM entries WHERE user_id = ?"),
    notes: one("SELECT COUNT(*) n FROM entries WHERE user_id = ? AND note != ''"),
    images: one("SELECT COUNT(*) n FROM images WHERE user_id = ?"),
    newsDays: one("SELECT COUNT(*) n FROM day_news WHERE user_id = ? AND events != '[]'"),
    messages: one("SELECT COUNT(*) n FROM messages WHERE user_id = ?"),
  };
}

/** Wipes all research data for the user. Chat transcript is left intact. */
export function deleteAllData(userId: string): {
  entries: number;
  images: number;
} {
  const images = removeImagesWhere(userId, "1 = 1", []);
  const entries = Number(db.prepare("DELETE FROM entries WHERE user_id = ?").run(userId).changes);
  db.prepare("DELETE FROM day_news WHERE user_id = ?").run(userId);
  return { entries, images };
}

export type CalendarDay = {
  date: string;
  imageCount: number;
  /** One entry per slot: how many of the three screenshots exist. */
  slotCounts: number[];
  complete: boolean;
  /** High-impact (red-folder) news releases on this day. */
  newsCount: number;
  /** Holidays / all-day items on this day (shown neutrally, not as red news). */
  holidayCount: number;
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

  const newsRows = db
    .prepare("SELECT date, events FROM day_news WHERE user_id = ? AND date LIKE ?")
    .all(userId, `${month}-%`) as Array<{ date: string; events: string }>;
  const newsByDate = new Map<string, { news: number; holiday: number }>();
  for (const row of newsRows) {
    const events = parseJson<NewsEvent[]>(row.events, []);
    if (!events.length) continue;
    const holiday = events.filter((e) => e.holiday).length;
    newsByDate.set(row.date, { news: events.length - holiday, holiday });
    if (!byDate.has(row.date)) byDate.set(row.date, SLOTS.map(() => 0));
  }

  return [...byDate.entries()]
    .map(([date, slotCounts]) => {
      const imageCount = slotCounts.reduce((a, b) => a + b, 0);
      const n = newsByDate.get(date);
      return {
        date,
        slotCounts,
        imageCount,
        complete: slotCounts.every((n) => n >= 3),
        newsCount: n?.news ?? 0,
        holidayCount: n?.holiday ?? 0,
      };
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
