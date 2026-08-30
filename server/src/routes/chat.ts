import { Router } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "../auth.js";
import { db, nowIso, uid } from "../db.js";
import { isDateString, isSlotId } from "../domain.js";
import { streamChat } from "../ai/chat.js";
import { describeAiError } from "../ai/client.js";

export const chatRoutes = Router();

chatRoutes.use(["/chat", "/chat/*"], requireUser);

type MessageRow = { id: string; role: string; content: string; meta: string; created_at: string };

function threadFor(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  return isDateString(value) ? value : "global";
}

function loadThread(userId: string, thread: string, limit = 40): MessageRow[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, meta, created_at FROM messages
       WHERE user_id = ? AND thread = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, thread, limit) as MessageRow[];
  return rows.reverse();
}

chatRoutes.get("/chat/:thread", (req, res) => {
  const thread = threadFor(req.params.thread);
  res.json({
    thread,
    messages: loadThread(req.user!.id, thread).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      meta: JSON.parse(m.meta),
      createdAt: m.created_at,
    })),
  });
});

chatRoutes.delete("/chat/:thread", (req, res) => {
  const thread = threadFor(req.params.thread);
  db.prepare("DELETE FROM messages WHERE user_id = ? AND thread = ?").run(req.user!.id, thread);
  res.json({ ok: true });
});

/**
 * Streams the assistant's reply as Server-Sent Events. The user turn is
 * persisted immediately; the assistant turn is persisted once the run finishes
 * so a dropped connection never leaves half an answer in the transcript.
 */
chatRoutes.post("/chat", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "ข้อความว่าง" });
    return;
  }
  const thread = threadFor(req.body?.thread);
  const slot = typeof req.body?.slot === "string" && isSlotId(req.body.slot) ? req.body.slot : undefined;
  const userId = req.user!.id;

  db.prepare(
    "INSERT INTO messages (id, user_id, thread, role, content, meta, created_at) VALUES (?, ?, ?, 'user', ?, '{}', ?)",
  ).run(uid(), userId, thread, message, nowIso());

  const history: Anthropic.MessageParam[] = loadThread(userId, thread).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  let answer = "";
  const savedNotes: Array<{ date: string; slot: string }> = [];

  try {
    for await (const event of streamChat(userId, history, {
      date: thread === "global" ? undefined : thread,
      slot,
    })) {
      if (event.type === "text") answer += event.text;
      if (event.type === "note-saved") savedNotes.push({ date: event.date, slot: event.slot });
      if (event.type === "done") answer = event.text || answer;
      send(event);
    }
  } catch (error) {
    const { message: description } = describeAiError(error);
    send({ type: "error", message: description });
  }

  if (answer.trim()) {
    db.prepare(
      "INSERT INTO messages (id, user_id, thread, role, content, meta, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)",
    ).run(uid(), userId, thread, answer, JSON.stringify({ savedNotes }), nowIso());
  }

  send({ type: "end" });
  res.end();
});
