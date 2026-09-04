import path from "node:path";
import { BUCKET, supabase, nowIso, uid } from "./db.js";
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

/**
 * Every function here is async now: Postgres is over the network where SQLite
 * was a synchronous local file. Names, parameter order and return shapes are
 * otherwise unchanged, so callers only had to learn to `await`.
 *
 * Two return shapes did have to change, because there is no longer a file on
 * disk to point at: `getImageFile` and `getChatAttachmentFile` hand back the
 * bytes themselves instead of an `absolutePath`.
 */

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

/**
 * PostgREST caps a response at 1000 rows by default. Nothing here is expected to
 * come close, but the counts and streaks would silently go wrong if it ever did,
 * so the "read everything for this user" queries ask for a explicit ceiling.
 */
const MAX_ROWS = 10_000;

export async function getDay(userId: string, date: string): Promise<DayRecord> {
  const [{ data: entryRows }, { data: imageRows }, news] = await Promise.all([
    supabase
      .from("entries")
      .select("slot, note, tags, metrics, updated_at")
      .eq("user_id", userId)
      .eq("date", date),
    supabase
      .from("images")
      .select("id, date, slot, kind, mime, bytes, created_at")
      .eq("user_id", userId)
      .eq("date", date),
    getDayNews(userId, date),
  ]);

  const entries = (entryRows ?? []) as Array<{
    slot: string;
    note: string;
    tags: string;
    metrics: string;
    updated_at: string;
  }>;
  const images = (imageRows ?? []) as ImageRow[];

  const slots: EntryRecord[] = SLOTS.map((def) => {
    const row = entries.find((r) => r.slot === def.id);
    const slotImages: Partial<Record<ImageKind, ImageRecord>> = {};
    for (const img of images.filter((r) => r.slot === def.id)) {
      slotImages[img.kind as ImageKind] = toImage(img);
    }
    return {
      date,
      slot: def.id,
      note: row?.note ?? "",
      tags: row ? parseJson<string[]>(row.tags, []) : [],
      metrics: row ? parseJson<Metrics>(row.metrics, {}) : {},
      updatedAt: row?.updated_at ?? null,
      images: slotImages,
    };
  });

  return {
    date,
    slots,
    imageCount: images.length,
    imageTarget: SLOTS.length * IMAGE_KINDS.length,
    news,
  };
}

export async function getDayNews(userId: string, date: string): Promise<DayNews> {
  const { data } = await supabase
    .from("day_news")
    .select("events, week_summary")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();
  const row = data as { events: string; week_summary: string } | null;
  return {
    events: row ? parseJson<NewsEvent[]>(row.events, []) : [],
    weekSummary: row?.week_summary ?? "",
  };
}

/**
 * Upserts a day's news. `events` replaces the stored list; `weekSummary`, when
 * given, is stored on that same date (the model passes the week's anchor date).
 */
export async function saveDayNews(
  userId: string,
  date: string,
  patch: { events?: NewsEvent[]; weekSummary?: string },
): Promise<void> {
  const current = await getDayNews(userId, date);
  const events = patch.events ?? current.events;
  const weekSummary = patch.weekSummary ?? current.weekSummary;
  await supabase.from("day_news").upsert(
    {
      user_id: userId,
      date,
      events: JSON.stringify(events),
      week_summary: weekSummary,
      updated_at: nowIso(),
    },
    { onConflict: "user_id,date" },
  );
}

export async function deleteDayNews(userId: string, date: string): Promise<void> {
  await supabase.from("day_news").delete().eq("user_id", userId).eq("date", date);
}

/** Dates in `month` (YYYY-MM) that carry at least one news event. */
export async function newsDatesInMonth(userId: string, month: string): Promise<string[]> {
  const { data } = await supabase
    .from("day_news")
    .select("date")
    .eq("user_id", userId)
    .like("date", `${month}-%`)
    .neq("events", "[]");
  return ((data ?? []) as Array<{ date: string }>).map((r) => r.date);
}

async function ensureEntry(userId: string, date: string, slot: SlotId): Promise<void> {
  await supabase.from("entries").upsert(
    {
      id: uid(),
      user_id: userId,
      date,
      slot,
      note: "",
      tags: "[]",
      metrics: "{}",
      updated_at: nowIso(),
    },
    { onConflict: "user_id,date,slot", ignoreDuplicates: true },
  );
}

export async function saveEntry(
  userId: string,
  date: string,
  slot: SlotId,
  patch: { note?: string; tags?: string[]; metrics?: Metrics },
): Promise<EntryRecord> {
  await ensureEntry(userId, date, slot);
  const current = (await getDay(userId, date)).slots.find((s) => s.slot === slot)!;
  const note = patch.note ?? current.note;
  const tags = patch.tags ?? current.tags;
  const metrics = patch.metrics ? { ...current.metrics, ...patch.metrics } : current.metrics;

  await supabase
    .from("entries")
    .update({
      note,
      tags: JSON.stringify(tags),
      metrics: JSON.stringify(metrics),
      updated_at: nowIso(),
    })
    .eq("user_id", userId)
    .eq("date", date)
    .eq("slot", slot);

  return (await getDay(userId, date)).slots.find((s) => s.slot === slot)!;
}

export async function appendNote(
  userId: string,
  date: string,
  slot: SlotId,
  text: string,
  tag?: string,
): Promise<EntryRecord> {
  const current = (await getDay(userId, date)).slots.find((s) => s.slot === slot)!;
  const note = current.note ? `${current.note.trimEnd()}\n${text}` : text;
  const tags = tag && !current.tags.includes(tag) ? [...current.tags, tag] : current.tags;
  return saveEntry(userId, date, slot, { note, tags });
}

/**
 * Appends to a whole-day note (economic-news lines, holidays) — there is no
 * per-day note row, so it lands on the first enabled slot of that day.
 */
export async function appendDayNote(
  userId: string,
  date: string,
  text: string,
  tag?: string,
): Promise<SlotId> {
  const settings = (await getUser(userId))?.settings;
  const slot = SLOT_IDS.find((id) => settings?.slots?.[id]?.enabled) ?? SLOT_IDS[0];
  await appendNote(userId, date, slot, text, tag);
  return slot;
}

export async function storeImage(
  userId: string,
  date: string,
  slot: SlotId,
  kind: ImageKind,
  file: { buffer: Buffer; mimetype: string; originalname: string },
): Promise<ImageRecord> {
  const { data: existingRow } = await supabase
    .from("images")
    .select("id, filename")
    .eq("user_id", userId)
    .eq("date", date)
    .eq("slot", slot)
    .eq("kind", kind)
    .maybeSingle();
  const existing = existingRow as { id: string; filename: string } | null;
  if (existing) await removeStoredFile(existing.filename);

  const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".png";
  const filename = `${userId}_${date}_${slot}_${kind}_${Date.now()}${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, file.buffer, { contentType: file.mimetype, upsert: true });
  if (error) throw new Error(`Could not store screenshot: ${error.message}`);

  const id = existing?.id ?? uid();
  const createdAt = nowIso();
  if (existing) {
    await supabase
      .from("images")
      .update({ filename, mime: file.mimetype, bytes: file.buffer.byteLength, created_at: createdAt })
      .eq("id", id);
  } else {
    await supabase.from("images").insert({
      id,
      user_id: userId,
      date,
      slot,
      kind,
      filename,
      mime: file.mimetype,
      bytes: file.buffer.byteLength,
      created_at: createdAt,
    });
  }
  await ensureEntry(userId, date, slot);

  return toImage({
    id,
    date,
    slot,
    kind,
    mime: file.mimetype,
    bytes: file.buffer.byteLength,
    created_at: createdAt,
  });
}

async function removeStoredFile(filename: string): Promise<void> {
  await supabase.storage.from(BUCKET).remove([filename]);
}

async function downloadStoredFile(filename: string): Promise<Buffer | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(filename);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Returns the image bytes. This used to hand back a path for `res.sendFile`;
 * with the file in object storage there is nothing on disk to point at.
 */
export async function getImageFile(
  userId: string,
  imageId: string,
): Promise<{ data: Buffer; mime: string } | null> {
  const { data: row } = await supabase
    .from("images")
    .select("filename, mime")
    .eq("id", imageId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return null;
  const { filename, mime } = row as { filename: string; mime: string };
  const data = await downloadStoredFile(filename);
  return data ? { data, mime } : null;
}

/**
 * Persists an image the user dropped into the chat so the transcript can show it
 * later. This is separate from `storeImage` (the dated library): a chat image is
 * tied to a message, not to a slot, and the model may or may not also file it.
 */
export async function storeChatAttachment(
  userId: string,
  messageId: string,
  file: { buffer: Buffer; mime: string; originalname: string },
): Promise<{ id: string; mime: string }> {
  const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".png";
  const id = uid();
  const filename = `chat_${userId}_${id}${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, file.buffer, { contentType: file.mime, upsert: true });
  if (error) throw new Error(`Could not store chat attachment: ${error.message}`);

  await supabase.from("chat_attachments").insert({
    id,
    user_id: userId,
    message_id: messageId,
    filename,
    mime: file.mime,
    bytes: file.buffer.byteLength,
    created_at: nowIso(),
  });
  return { id, mime: file.mime };
}

export async function getChatAttachmentFile(
  userId: string,
  attachmentId: string,
): Promise<{ data: Buffer; mime: string } | null> {
  const { data: row } = await supabase
    .from("chat_attachments")
    .select("filename, mime")
    .eq("id", attachmentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return null;
  const { filename, mime } = row as { filename: string; mime: string };
  const data = await downloadStoredFile(filename);
  return data ? { data, mime } : null;
}

export async function deleteChatAttachment(userId: string, attachmentId: string): Promise<void> {
  const { data: row } = await supabase
    .from("chat_attachments")
    .select("filename")
    .eq("id", attachmentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return;
  await removeStoredFile((row as { filename: string }).filename);
  await supabase.from("chat_attachments").delete().eq("id", attachmentId).eq("user_id", userId);
}

export async function readImageBase64(
  userId: string,
  date: string,
  slot: SlotId,
  kind: ImageKind,
): Promise<{ data: string; mime: string } | null> {
  const { data: row } = await supabase
    .from("images")
    .select("filename, mime")
    .eq("user_id", userId)
    .eq("date", date)
    .eq("slot", slot)
    .eq("kind", kind)
    .maybeSingle();
  if (!row) return null;
  const { filename, mime } = row as { filename: string; mime: string };
  const buffer = await downloadStoredFile(filename);
  return buffer ? { data: buffer.toString("base64"), mime } : null;
}

export async function deleteImage(userId: string, imageId: string): Promise<boolean> {
  const { data: row } = await supabase
    .from("images")
    .select("filename")
    .eq("id", imageId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return false;
  await removeStoredFile((row as { filename: string }).filename);
  await supabase.from("images").delete().eq("id", imageId).eq("user_id", userId);
  return true;
}

/** Deletes one screenshot addressed the way the research diary thinks of it. */
export async function deleteImageAt(
  userId: string,
  date: string,
  slot: SlotId,
  kind: ImageKind,
): Promise<boolean> {
  const { data: row } = await supabase
    .from("images")
    .select("id")
    .eq("user_id", userId)
    .eq("date", date)
    .eq("slot", slot)
    .eq("kind", kind)
    .maybeSingle();
  return row ? deleteImage(userId, (row as { id: string }).id) : false;
}

/**
 * Deletes the user's screenshots matching an optional date/slot filter, removing
 * the stored objects alongside the rows. Replaces a helper that took a raw SQL
 * fragment, which has no equivalent through the Supabase client.
 */
async function removeImagesWhere(
  userId: string,
  filter: { date?: string; slot?: SlotId } = {},
): Promise<number> {
  let select = supabase.from("images").select("id, filename").eq("user_id", userId);
  if (filter.date) select = select.eq("date", filter.date);
  if (filter.slot) select = select.eq("slot", filter.slot);
  const { data } = await select.limit(MAX_ROWS);

  const rows = (data ?? []) as Array<{ id: string; filename: string }>;
  if (!rows.length) return 0;

  await supabase.storage.from(BUCKET).remove(rows.map((r) => r.filename));
  await supabase
    .from("images")
    .delete()
    .in(
      "id",
      rows.map((r) => r.id),
    );
  return rows.length;
}

/** What one slot currently holds — used to preview a delete before doing it. */
export async function slotFootprint(
  userId: string,
  date: string,
  slot: SlotId,
): Promise<{ hasNote: boolean; tags: number; hasMetrics: boolean; images: number }> {
  const s = (await getDay(userId, date)).slots.find((x) => x.slot === slot)!;
  return {
    hasNote: Boolean(s.note),
    tags: s.tags.length,
    hasMetrics: Object.keys(s.metrics).length > 0,
    images: Object.keys(s.images).length,
  };
}

/** Clears a slot's note, tags and metrics; also its screenshots when asked. */
export async function clearSlot(
  userId: string,
  date: string,
  slot: SlotId,
  opts: { images?: boolean } = {},
): Promise<{ images: number }> {
  await ensureEntry(userId, date, slot);
  await supabase
    .from("entries")
    .update({ note: "", tags: "[]", metrics: "{}", updated_at: nowIso() })
    .eq("user_id", userId)
    .eq("date", date)
    .eq("slot", slot);
  const images = opts.images ? await removeImagesWhere(userId, { date, slot }) : 0;
  return { images };
}

export async function dayFootprint(
  userId: string,
  date: string,
): Promise<{ slotsWithData: number; images: number; newsEvents: number }> {
  const day = await getDay(userId, date);
  return {
    slotsWithData: day.slots.filter(
      (s) => s.note || s.tags.length || Object.keys(s.metrics).length > 0,
    ).length,
    images: day.imageCount,
    newsEvents: day.news.events.length,
  };
}

/** Deletes every entry, screenshot and news item for one date. */
export async function deleteDay(
  userId: string,
  date: string,
): Promise<{ entries: number; images: number }> {
  const images = await removeImagesWhere(userId, { date });
  const { data: deleted } = await supabase
    .from("entries")
    .delete()
    .eq("user_id", userId)
    .eq("date", date)
    .select("id");
  await deleteDayNews(userId, date);
  return { entries: (deleted ?? []).length, images };
}

/** Every date the user has an entry or a screenshot on, newest first. */
export async function listDataDates(userId: string): Promise<string[]> {
  const [{ data: entryDates }, { data: imageDates }] = await Promise.all([
    supabase.from("entries").select("date").eq("user_id", userId).limit(MAX_ROWS),
    supabase.from("images").select("date").eq("user_id", userId).limit(MAX_ROWS),
  ]);
  const dates = new Set<string>();
  for (const row of [...(entryDates ?? []), ...(imageDates ?? [])] as Array<{ date: string }>) {
    dates.add(row.date);
  }
  return [...dates].sort((a, b) => b.localeCompare(a));
}

/** Totals across the whole account — the preview for a full wipe. */
export async function dataFootprint(userId: string): Promise<{
  days: number;
  entries: number;
  notes: number;
  images: number;
  newsDays: number;
  messages: number;
}> {
  const count = async (
    table: string,
    refine?: (q: any) => any,
  ): Promise<number> => {
    let query = supabase.from(table).select("*", { count: "exact", head: true }).eq("user_id", userId);
    if (refine) query = refine(query);
    const { count: n } = await query;
    return n ?? 0;
  };

  const [days, entries, notes, images, newsDays, messages] = await Promise.all([
    listDataDates(userId).then((d) => d.length),
    count("entries"),
    count("entries", (q) => q.neq("note", "")),
    count("images"),
    count("day_news", (q) => q.neq("events", "[]")),
    count("messages"),
  ]);

  return { days, entries, notes, images, newsDays, messages };
}

/** Wipes all research data for the user. Chat transcript is left intact. */
export async function deleteAllData(userId: string): Promise<{
  entries: number;
  images: number;
}> {
  const images = await removeImagesWhere(userId);
  const { data: deleted } = await supabase
    .from("entries")
    .delete()
    .eq("user_id", userId)
    .select("id");
  await supabase.from("day_news").delete().eq("user_id", userId);
  return { entries: (deleted ?? []).length, images };
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

export async function getCalendar(userId: string, month: string): Promise<CalendarDay[]> {
  // Grouping happens here rather than in the query: PostgREST has no GROUP BY,
  // and a month of screenshots is at most a few hundred rows.
  const [{ data: imageRows }, { data: newsRows }] = await Promise.all([
    supabase
      .from("images")
      .select("date, slot")
      .eq("user_id", userId)
      .like("date", `${month}-%`)
      .limit(MAX_ROWS),
    supabase
      .from("day_news")
      .select("date, events")
      .eq("user_id", userId)
      .like("date", `${month}-%`)
      .limit(MAX_ROWS),
  ]);

  const byDate = new Map<string, number[]>();
  for (const row of (imageRows ?? []) as Array<{ date: string; slot: string }>) {
    const counts = byDate.get(row.date) ?? SLOTS.map(() => 0);
    const idx = SLOTS.findIndex((s) => s.id === row.slot);
    if (idx >= 0) counts[idx] += 1;
    byDate.set(row.date, counts);
  }

  const newsByDate = new Map<string, { news: number; holiday: number }>();
  for (const row of (newsRows ?? []) as Array<{ date: string; events: string }>) {
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
        complete: slotCounts.every((c) => c >= 3),
        newsCount: n?.news ?? 0,
        holidayCount: n?.holiday ?? 0,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type LibraryItem = ImageRecord & { note: string };

export async function getLibrary(
  userId: string,
  kind: ImageKind | null,
  limit = 60,
): Promise<LibraryItem[]> {
  let query = supabase
    .from("images")
    .select("id, date, slot, kind, mime, bytes, created_at")
    .eq("user_id", userId);
  if (kind) query = query.eq("kind", kind);
  const { data } = await query
    .order("date", { ascending: false })
    .order("slot", { ascending: true })
    .limit(limit);

  const rows = (data ?? []) as ImageRow[];
  if (!rows.length) return [];

  // The note used to arrive via a LEFT JOIN; PostgREST can only join on a
  // declared foreign key, so the matching entries are fetched and paired here.
  const { data: entryRows } = await supabase
    .from("entries")
    .select("date, slot, note")
    .eq("user_id", userId)
    .in("date", [...new Set(rows.map((r) => r.date))]);

  const notes = new Map(
    ((entryRows ?? []) as Array<{ date: string; slot: string; note: string }>).map((e) => [
      `${e.date}|${e.slot}`,
      e.note,
    ]),
  );

  return rows.map((row) => ({
    ...toImage(row),
    note: notes.get(`${row.date}|${row.slot}`) ?? "",
  }));
}

export type SeriesPoint = {
  date: string;
  slot: SlotId;
  priceClose: number | null;
  oi: number | null;
  oiChg: number | null;
  pcRatio: number | null;
};

export async function getSeries(userId: string, days: number): Promise<SeriesPoint[]> {
  const { data } = await supabase
    .from("entries")
    .select("date, slot, metrics")
    .eq("user_id", userId)
    .order("date", { ascending: false })
    .order("slot", { ascending: true })
    .limit(days * SLOTS.length);

  const order = new Map(SLOTS.map((s, i) => [s.id, i]));
  return ((data ?? []) as Array<{ date: string; slot: string; metrics: string }>)
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

export type Streak = {
  current: number;
  totalImages: number;
  totalDays: number;
  completeDays: number;
};

export async function getStreak(userId: string): Promise<Streak> {
  const { data } = await supabase
    .from("images")
    .select("date")
    .eq("user_id", userId)
    .limit(MAX_ROWS);

  const rows = (data ?? []) as Array<{ date: string }>;
  const perDay = new Map<string, number>();
  for (const row of rows) perDay.set(row.date, (perDay.get(row.date) ?? 0) + 1);

  const target = SLOTS.length * IMAGE_KINDS.length;
  const complete = new Set([...perDay.entries()].filter(([, n]) => n >= target).map(([d]) => d));

  let current = 0;
  let cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  // Today not yet being complete shouldn't break a streak that is still in progress.
  if (!complete.has(cursor.toISOString().slice(0, 10))) {
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  while (complete.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  return {
    current,
    totalImages: rows.length,
    totalDays: perDay.size,
    completeDays: complete.size,
  };
}

export async function updateSettings(userId: string, settings: unknown): Promise<void> {
  await supabase.from("users").update({ settings: JSON.stringify(settings) }).eq("id", userId);
}
