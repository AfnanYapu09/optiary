import { Router } from "express";
import multer from "multer";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { supabase, nowIso, uid } from "../db.js";
import { isDateString, isSlotId } from "../domain.js";
import { streamChat, type ChatAttachment } from "../ai/chat.js";
import { describeAiError } from "../ai/client.js";
import { deleteChatAttachment, getChatAttachmentFile, storeChatAttachment } from "../store.js";

export const chatRoutes = Router();

chatRoutes.use(["/chat", "/chat/*", "/chat-image/*"], requireUser);

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Chat turns arrive as JSON when there is nothing attached and as multipart when
 * the user drops screenshots in, so the same route has to accept both shapes.
 */
const chatUpload = multer({
  storage: multer.memoryStorage(),
  // No cap on how many screenshots ride along with one turn — a research day is
  // 15 shots and the old limit of 3 forced the user to split it up. Per-file size
  // still applies; the practical ceiling is the model request, not this route.
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error("รองรับเฉพาะไฟล์ PNG, JPEG, WebP และ GIF"));
      return;
    }
    cb(null, true);
  },
});

type MessageRow = { id: string; role: string; content: string; meta: string; created_at: string };

function threadFor(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  return isDateString(value) ? value : "global";
}

// `rowid` was the tiebreaker under SQLite; Postgres has no such column, so the
// id breaks ties between two messages written in the same millisecond.
async function loadThread(userId: string, thread: string, limit = 40): Promise<MessageRow[]> {
  const { data } = await supabase
    .from("messages")
    .select("id, role, content, meta, created_at")
    .eq("user_id", userId)
    .eq("thread", thread)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  return ((data ?? []) as MessageRow[]).reverse();
}

chatRoutes.get("/chat/:thread", async (req, res) => {
  const thread = threadFor(req.params.thread);
  const messages = await loadThread(req.user!.id, thread);
  res.json({
    thread,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      meta: JSON.parse(m.meta),
      createdAt: m.created_at,
    })),
  });
});

chatRoutes.delete("/chat/:thread", async (req, res) => {
  const thread = threadFor(req.params.thread);
  const userId = req.user!.id;

  // Chat images are stored objects keyed by message, so clear them with the
  // transcript. PostgREST cannot join, so the message ids are resolved first.
  const { data: messageRows } = await supabase
    .from("messages")
    .select("id")
    .eq("user_id", userId)
    .eq("thread", thread);
  const messageIds = ((messageRows ?? []) as Array<{ id: string }>).map((m) => m.id);

  if (messageIds.length) {
    const { data: attachmentRows } = await supabase
      .from("chat_attachments")
      .select("id")
      .eq("user_id", userId)
      .in("message_id", messageIds);
    for (const { id } of (attachmentRows ?? []) as Array<{ id: string }>) {
      await deleteChatAttachment(userId, id);
    }
  }

  await supabase.from("messages").delete().eq("user_id", userId).eq("thread", thread);
  res.json({ ok: true });
});

/**
 * Deletes `messageId` and everything after it in the thread.
 *
 * Editing a question or retrying an answer rewrites the conversation from that
 * point, and the replies that followed were answering the old text — leaving
 * them would put a reply to a question that no longer exists in the transcript,
 * and the model would then be fed that contradiction as history. The images
 * those turns owned go too, so nothing is orphaned in the bucket.
 */
chatRoutes.delete("/chat/:thread/from/:messageId", async (req, res) => {
  const thread = threadFor(req.params.thread);
  const userId = req.user!.id;
  const messageId = String(req.params.messageId ?? "");

  // "After" follows the same ordering the transcript is read with, so what the
  // user sees below a message is exactly what disappears.
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("user_id", userId)
    .eq("thread", thread)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  const ordered = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  const cut = ordered.indexOf(messageId);
  if (cut === -1) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const doomed = ordered.slice(cut);

  const { data: attachmentRows } = await supabase
    .from("chat_attachments")
    .select("id")
    .eq("user_id", userId)
    .in("message_id", doomed);
  for (const { id } of (attachmentRows ?? []) as Array<{ id: string }>) {
    await deleteChatAttachment(userId, id);
  }

  await supabase.from("messages").delete().eq("user_id", userId).in("id", doomed);
  res.json({ ok: true, removed: doomed.length });
});

chatRoutes.get("/chat-image/:id/file", async (req, res) => {
  const file = await getChatAttachmentFile(req.user!.id, String(req.params.id ?? ""));
  if (!file) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(file.data);
});

/**
 * Streams the assistant's reply as Server-Sent Events. The user turn is
 * persisted immediately; the assistant turn is persisted once the run finishes
 * so a dropped connection never leaves half an answer in the transcript.
 */
chatRoutes.post("/chat", chatUpload.array("files") as any, async (req, res) => {
  const attachments: ChatAttachment[] = ((req.files as Express.Multer.File[] | undefined) ?? []).map(
    (f) => ({ buffer: f.buffer, mime: f.mimetype, originalname: f.originalname }),
  );
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message && attachments.length === 0) {
    res.status(400).json({ error: "ข้อความว่าง" });
    return;
  }
  const thread = threadFor(req.body?.thread);
  const slot = typeof req.body?.slot === "string" && isSlotId(req.body.slot) ? req.body.slot : undefined;
  const userId = req.user!.id;

  // Only the text goes into `content`; the images are saved as chat attachments
  // (shown in the transcript) and never replayed into later turns, which is what
  // keeps a long conversation with screenshots from getting expensive.
  const userMessageId = uid();
  const storedContent = attachments.length
    ? message || "ช่วยอ่านภาพนี้แล้วจดให้หน่อย"
    : message;
  const storedAttachments = await Promise.all(
    attachments.map((file) => storeChatAttachment(userId, userMessageId, file)),
  );

  await supabase.from("messages").insert({
    id: userMessageId,
    user_id: userId,
    thread,
    role: "user",
    content: storedContent,
    meta: JSON.stringify({ attachments: storedAttachments }),
    created_at: nowIso(),
  });

  const history: Anthropic.MessageParam[] = (await loadThread(userId, thread)).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  let answer = "";
  let stats: unknown = null;
  let aborted = false;
  const savedNotes: Array<{ date: string; slot: string }> = [];

  // The browser only drops this connection when the user presses stop (or shuts
  // the tab). Navigating between pages deliberately keeps it open, which is what
  // lets a turn finish while the user is looking at another page.
  //
  // Listen on `res`, not `req`: a fully-consumed request stream can emit
  // "close" on its own, which would abort every turn the moment multer finished
  // reading the body. `writableEnded` distinguishes a real disconnect from this
  // response simply having finished.
  res.on("close", () => {
    if (!res.writableEnded) aborted = true;
  });

  try {
    for await (const event of streamChat(userId, history, {
      date: thread === "global" ? undefined : thread,
      slot,
      attachments,
    })) {
      if (event.type === "text") answer += event.text;
      if (event.type === "note-saved") savedNotes.push({ date: event.date, slot: event.slot });
      if (event.type === "done") {
        answer = event.text || answer;
        stats = event.stats;
      }
      send(event);
      // Breaking here returns the generator, unwinding the model loop instead of
      // running it to completion against a socket nobody is reading.
      if (aborted) break;
    }
  } catch (error) {
    const { message: description } = describeAiError(error);
    send({ type: "error", message: description });
    // Keep the failure in the transcript. Without this the turn vanished on the
    // next reload and the user could not tell whether anything had run.
    answer = answer.trim() ? `${answer}\n\n⚠️ ${description}` : `⚠️ ${description}`;
  }

  // Whatever was produced before the stop is still worth keeping — anything the
  // tools already wrote happened, so an empty transcript would misrepresent it.
  if (aborted && answer.trim()) {
    answer = `${answer}\n\n_(หยุดกลางคัน)_`;
  }

  if (answer.trim()) {
    await supabase.from("messages").insert({
      id: uid(),
      user_id: userId,
      thread,
      role: "assistant",
      content: answer,
      meta: JSON.stringify({ savedNotes, stats }),
      created_at: nowIso(),
    });
  }

  send({ type: "end" });
  res.end();
});

// Surfaces multer's own failures (file too large, wrong type) as clean JSON.
chatRoutes.use((err: Error, _req: unknown, res: any, next: (e?: unknown) => void) => {
  if (err instanceof multer.MulterError) {
    // Only per-file size is capped now, so say which limit was hit and what it
    // is — "too large" alone is not actionable when a batch has many files.
    const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
    res.status(413).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? `มีไฟล์ที่ใหญ่เกิน ${mb} MB — ย่อภาพแล้วลองใหม่`
          : `อัปโหลดไม่สำเร็จ (${err.code})`,
    });
    return;
  }
  if (err?.message?.startsWith("รองรับเฉพาะ")) {
    res.status(415).json({ error: err.message });
    return;
  }
  next(err);
});
