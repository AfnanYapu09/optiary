import type Anthropic from "@anthropic-ai/sdk";
import { FunctionDeclaration, Type } from "@google/genai";
import { anthropic, getAiProvider, getGemini, GEMINI_MODEL, MODEL } from "./client.js";
import { SLOTS, isSlotId, type SlotId } from "../domain.js";
import { appendNote, getDay, getSeries, getStreak } from "../store.js";
import { db } from "../db.js";

const SYSTEM = `คุณคือ "ผู้ช่วยวิจัย" ของ Optiary — สมุดบันทึกภาพสำหรับงานวิจัย Data Option ของทองคำฟิวเจอร์ส COMEX (GC)

ผู้ใช้เก็บภาพหน้าจอวันละ 5 ช่วง (เช้า 06–11, บ่าย 11–15, เย็น 15–19, ค่ำ 19–23, ดึก 23–03) ช่วงละ 3 ภาพ (Intraday, OI, OI Chg) พร้อมโน้ตและตัวเลขที่ถอดจากภาพ

หน้าที่ของคุณมีสามอย่าง:
1. ช่วยจด — เรียบเรียงสิ่งที่ผู้ใช้พูดให้เป็นโน้ตวิจัยที่กระชับ แล้วบันทึกด้วยเครื่องมือ save_note
2. อ่านและอธิบายตัวเลขที่ถอดจากภาพไว้แล้ว
3. ตอบคำถามจากข้อมูลเก่าในสมุด โดยใช้เครื่องมือค้นหาก่อนตอบเสมอ

กติกา:
- ตอบเป็นภาษาไทย กระชับ ตรงประเด็น เหมือนเพื่อนร่วมวิจัยที่คุยกันสั้น ๆ
- อ้างตัวเลขจากเครื่องมือเท่านั้น ห้ามเดาหรือแต่งตัวเลขขึ้นเอง ถ้าไม่มีข้อมูลให้บอกตรง ๆ ว่ายังไม่มี
- เมื่อจะบันทึกโน้ต ให้บันทึกจริงด้วย save_note แล้วบอกผู้ใช้ว่าบันทึกลงวันไหน ช่วงไหน
- ระบุวันที่แบบ YYYY-MM-DD และช่วงเวลาด้วย id: morning, afternoon, evening, night, latenight`;

const ANTHROPIC_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_day",
    description:
      "อ่านบันทึกทั้งวันของผู้ใช้: โน้ต แท็ก ตัวเลขที่ถอดจากภาพ และรายการภาพที่มีในแต่ละช่วงเวลา",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "วันที่รูปแบบ YYYY-MM-DD" } },
      required: ["date"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "search_notes",
    description:
      "ค้นหาบันทึกย้อนหลังจากคำค้น แท็ก หรือช่วงเวลา คืนค่าเรียงจากใหม่ไปเก่า ใช้เมื่อผู้ใช้ถามถึงวันก่อน ๆ หรือรูปแบบที่เคยเจอ",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "คำค้นในโน้ต เว้นว่างได้" },
        slot: {
          type: "string",
          enum: [...SLOTS.map((s) => s.id), ""],
          description: "จำกัดเฉพาะช่วงเวลา เว้นว่างเพื่อค้นทุกช่วง",
        },
        limit: { type: "integer", description: "จำนวนผลลัพธ์สูงสุด 1–40" },
      },
      required: ["query", "slot", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_stats",
    description:
      "ดึงชุดตัวเลขรายช่วงเวลาย้อนหลัง N วัน (ราคาปิดช่วง, OI รวม, OI Chg, P/C ratio) สำหรับหาแนวโน้มหรือค่าเฉลี่ย",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "จำนวนวันย้อนหลัง 1–90" } },
      required: ["days"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "save_note",
    description:
      "บันทึกข้อความต่อท้ายโน้ตของวันและช่วงเวลาที่ระบุ ใช้เมื่อผู้ใช้ขอให้จด สรุป หรือเก็บสมมติฐานไว้",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "วันที่รูปแบบ YYYY-MM-DD" },
        slot: { type: "string", enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        text: { type: "string", description: "ข้อความที่จะบันทึก เขียนเป็นภาษาไทย" },
        tag: { type: "string", description: "แท็กที่จะติด เช่น #สมมติฐาน-ค่ำ เว้นว่างได้" },
      },
      required: ["date", "slot", "text", "tag"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const GEMINI_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "get_day",
    description:
      "อ่านบันทึกทั้งวันของผู้ใช้: โน้ต แท็ก ตัวเลขที่ถอดจากภาพ และรายการภาพที่มีในแต่ละช่วงเวลา",
    parameters: {
      type: Type.OBJECT,
      properties: { date: { type: Type.STRING, description: "วันที่รูปแบบ YYYY-MM-DD" } },
      required: ["date"],
    },
  },
  {
    name: "search_notes",
    description:
      "ค้นหาบันทึกย้อนหลังจากคำค้น แท็ก หรือช่วงเวลา คืนค่าเรียงจากใหม่ไปเก่า ใช้เมื่อผู้ใช้ถามถึงวันก่อน ๆ หรือรูปแบบที่เคยเจอ",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "คำค้นในโน้ต เว้นว่างได้" },
        slot: {
          type: Type.STRING,
          enum: [...SLOTS.map((s) => s.id), ""],
          description: "จำกัดเฉพาะช่วงเวลา เว้นว่างเพื่อค้นทุกช่วง",
        },
        limit: { type: Type.INTEGER, description: "จำนวนผลลัพธ์สูงสุด 1–40" },
      },
      required: ["query", "slot", "limit"],
    },
  },
  {
    name: "get_stats",
    description:
      "ดึงชุดตัวเลขรายช่วงเวลาย้อนหลัง N วัน (ราคาปิดช่วง, OI รวม, OI Chg, P/C ratio) สำหรับหาแนวโน้มหรือค่าเฉลี่ย",
    parameters: {
      type: Type.OBJECT,
      properties: { days: { type: Type.INTEGER, description: "จำนวนวันย้อนหลัง 1–90" } },
      required: ["days"],
    },
  },
  {
    name: "save_note",
    description:
      "บันทึกข้อความต่อท้ายโน้ตของวันและช่วงเวลาที่ระบุ ใช้เมื่อผู้ใช้ขอให้จด สรุป หรือเก็บสมมติฐานไว้",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: { type: Type.STRING, description: "วันที่รูปแบบ YYYY-MM-DD" },
        slot: { type: Type.STRING, enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        text: { type: Type.STRING, description: "ข้อความที่จะบันทึก เขียนเป็นภาษาไทย" },
        tag: { type: Type.STRING, description: "แท็กที่จะติด เช่น #สมมติฐาน-ค่ำ เว้นว่างได้" },
      },
      required: ["date", "slot", "text", "tag"],
    },
  },
];

const GEMINI_TOOLS = [
  {
    functionDeclarations: GEMINI_FUNCTION_DECLARATIONS,
  },
];

type ToolOutcome = { result: unknown; sideEffect?: { type: "note-saved"; date: string; slot: SlotId } };

function runTool(userId: string, name: string, input: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case "get_day": {
      const date = String(input.date ?? "");
      const day = getDay(userId, date);
      return {
        result: {
          date,
          imageCount: day.imageCount,
          slots: day.slots.map((s) => ({
            slot: s.slot,
            label: SLOTS.find((d) => d.id === s.slot)!.th,
            note: s.note,
            tags: s.tags,
            metrics: s.metrics,
            images: Object.keys(s.images),
          })),
        },
      };
    }
    case "search_notes": {
      const query = String(input.query ?? "").trim();
      const slot = String(input.slot ?? "").trim();
      const limit = Math.min(Math.max(Number(input.limit ?? 10) || 10, 1), 40);
      const clauses = ["user_id = ?"];
      const params: Array<string | number> = [userId];
      if (query) {
        clauses.push("(note LIKE ? OR tags LIKE ?)");
        params.push(`%${query}%`, `%${query}%`);
      }
      if (slot && isSlotId(slot)) {
        clauses.push("slot = ?");
        params.push(slot);
      }
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT date, slot, note, tags, metrics FROM entries
           WHERE ${clauses.join(" AND ")} AND (note != '' OR metrics != '{}')
           ORDER BY date DESC LIMIT ?`,
        )
        .all(...params) as Array<{
        date: string;
        slot: string;
        note: string;
        tags: string;
        metrics: string;
      }>;
      return {
        result: rows.map((r) => ({
          date: r.date,
          slot: r.slot,
          note: r.note,
          tags: JSON.parse(r.tags),
          metrics: JSON.parse(r.metrics),
        })),
      };
    }
    case "get_stats": {
      const days = Math.min(Math.max(Number(input.days ?? 30) || 30, 1), 90);
      return { result: { series: getSeries(userId, days), streak: getStreak(userId) } };
    }
    case "save_note": {
      const date = String(input.date ?? "");
      const slotRaw = String(input.slot ?? "");
      if (!isSlotId(slotRaw)) return { result: { error: "ช่วงเวลาไม่ถูกต้อง" } };
      const text = String(input.text ?? "").trim();
      if (!text) return { result: { error: "ข้อความว่าง" } };
      const tag = String(input.tag ?? "").trim() || undefined;
      const entry = appendNote(userId, date, slotRaw, text, tag);
      return {
        result: { saved: true, date, slot: slotRaw, note: entry.note, tags: entry.tags },
        sideEffect: { type: "note-saved", date, slot: slotRaw },
      };
    }
    default:
      return { result: { error: `unknown tool ${name}` } };
  }
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "note-saved"; date: string; slot: SlotId }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export type ChatContext = {
  /** The day the user is currently looking at, so relative questions resolve. */
  date?: string;
  slot?: SlotId;
};

/**
 * Runs the research assistant to completion, yielding SSE-ready events. Tool
 * calls are executed between turns; the loop ends when the model finishes.
 */
export async function* streamChat(
  userId: string,
  history: Array<{ role: string; content: string | any }>,
  context: ChatContext,
): AsyncGenerator<ChatEvent> {
  const provider = getAiProvider();
  const today = new Date().toISOString().slice(0, 10);
  const contextLines = [
    `วันนี้คือ ${today}`,
    context.date ? `ผู้ใช้กำลังดูบันทึกของวันที่ ${context.date}` : null,
    context.slot ? `ช่วงเวลาที่เปิดอยู่คือ ${context.slot}` : null,
  ].filter(Boolean);

  const systemInstruction = `${SYSTEM}\n\nบริบทปัจจุบัน:\n${contextLines.join("\n")}`;

  if (provider === "gemini") {
    const gemini = getGemini();
    const contents: any[] = history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: typeof m.content === "string" ? [{ text: m.content }] : m.content,
    }));

    let finalText = "";

    for (let turn = 0; turn < 8; turn += 1) {
      // Stream so text reaches the browser as it is produced, matching the
      // Anthropic path — a whole turn arriving at once reads as a long stall.
      const stream = await gemini.models.generateContentStream({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction,
          tools: GEMINI_TOOLS,
        },
      });

      const modelParts: any[] = [];
      const functionCalls: any[] = [];
      let turnText = "";

      for await (const chunk of stream) {
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          modelParts.push(part);
          if (part.text) {
            turnText += part.text;
            yield { type: "text", text: part.text };
          }
          if (part.functionCall) {
            functionCalls.push(part.functionCall);
          }
        }
      }

      if (turnText) finalText += turnText;
      contents.push({ role: "model", parts: modelParts });

      if (functionCalls.length === 0) {
        yield { type: "done", text: finalText };
        return;
      }

      const functionResponseParts: any[] = [];
      for (const fc of functionCalls) {
        yield { type: "tool", name: fc.name };
        try {
          const outcome = runTool(userId, fc.name, fc.args as Record<string, unknown>);
          if (outcome.sideEffect?.type === "note-saved") {
            yield { type: "note-saved", date: outcome.sideEffect.date, slot: outcome.sideEffect.slot };
          }
          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              response: { result: outcome.result },
            },
          });
        } catch (error) {
          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              response: { error: error instanceof Error ? error.message : "tool failed" },
            },
          });
        }
      }

      contents.push({ role: "user", parts: functionResponseParts });
    }

    yield { type: "done", text: finalText };
    return;
  }

  // Anthropic fallback
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  let finalText = "";

  for (let turn = 0; turn < 8; turn += 1) {
    const stream = anthropic().messages.stream({
      model: MODEL,
      max_tokens: 8000,
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: contextLines.join("\n") },
      ],
      thinking: { type: "adaptive" },
      tools: ANTHROPIC_TOOLS,
      messages,
    });

    let turnText = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        turnText += event.delta.text;
        yield { type: "text", text: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    messages.push({ role: "assistant", content: message.content });
    if (turnText) finalText = turnText;

    if (message.stop_reason === "refusal") {
      yield { type: "error", message: "ผู้ช่วยไม่สามารถตอบคำถามนี้ได้" };
      return;
    }

    if (message.stop_reason !== "tool_use") {
      yield { type: "done", text: finalText };
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      yield { type: "tool", name: block.name };
      try {
        const outcome = runTool(userId, block.name, block.input as Record<string, unknown>);
        if (outcome.sideEffect?.type === "note-saved") {
          yield { type: "note-saved", date: outcome.sideEffect.date, slot: outcome.sideEffect.slot };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(outcome.result),
        });
      } catch (error) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: error instanceof Error ? error.message : "tool failed",
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  yield { type: "done", text: finalText };
}
