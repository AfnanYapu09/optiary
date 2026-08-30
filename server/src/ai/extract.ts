import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Type } from "@google/genai";
import { anthropic, getAiProvider, getGemini, GEMINI_MODEL, MODEL } from "./client.js";
import { IMAGE_KINDS, SLOTS, type ImageKind, type Metrics, type SlotId } from "../domain.js";
import { readImageBase64 } from "../store.js";

const ExtractionSchema = z.object({
  price_close: z
    .number()
    .nullable()
    .describe("Last traded / closing price of the contract visible in the intraday chart"),
  call_oi: z.number().nullable().describe("Total call-side open interest across strikes"),
  put_oi: z.number().nullable().describe("Total put-side open interest across strikes"),
  oi_chg_total: z
    .number()
    .nullable()
    .describe("Net change in total open interest for the session, negative if it fell"),
  pc_ratio: z.number().nullable().describe("Put/call open-interest ratio, rounded to two decimals"),
  summary: z
    .string()
    .describe("Two or three sentences in Thai describing what the screenshots show"),
  confidence: z.enum(["high", "medium", "low"]).describe("How legible the numbers were"),
});

const SYSTEM = `คุณเป็นผู้ช่วยวิจัยที่อ่านภาพหน้าจอตลาดออปชันทองคำ COMEX (GC) แล้วถอดตัวเลขออกมา

ภาพที่ได้รับมีได้ถึงสามชนิดต่อหนึ่งช่วงเวลา:
- Intraday — กราฟราคาระหว่างวันของสัญญาฟิวเจอร์ส
- OI — ตาราง/กราฟ Open Interest แยกฝั่ง Call และ Put ตามราคาใช้สิทธิ
- OI Chg — การเปลี่ยนแปลงของ Open Interest เทียบกับรอบก่อน

กติกา:
- อ่านเฉพาะตัวเลขที่เห็นจริงในภาพ ถ้าอ่านไม่ได้หรือไม่มีภาพชนิดนั้นให้ตอบ null อย่าเดา
- ผลรวม OI ให้รวมทุกราคาใช้สิทธิที่ปรากฏ ถ้าภาพแสดงยอดรวมอยู่แล้วให้ใช้ยอดนั้น
- P/C ratio = Put OI ÷ Call OI คำนวณจากตัวเลขที่อ่านได้ ถ้าอ่านได้ไม่ครบให้ตอบ null
- สรุป (summary) เขียนเป็นภาษาไทย กระชับ อ้างอิงเฉพาะสิ่งที่เห็นในภาพ`;

export type ExtractionResult = {
  metrics: Metrics;
  confidence: "high" | "medium" | "low";
};

/**
 * Reads every screenshot stored for one slot and pulls the research numbers out
 * of them in a single vision call.
 */
export async function extractSlotMetrics(
  userId: string,
  date: string,
  slot: SlotId,
): Promise<ExtractionResult> {
  const present: ImageKind[] = [];
  const imagesData: Array<{ kind: ImageKind; data: string; mime: string }> = [];

  for (const kind of IMAGE_KINDS) {
    const image = readImageBase64(userId, date, slot, kind);
    if (!image) continue;
    present.push(kind);
    imagesData.push({ kind, data: image.data, mime: image.mime });
  }

  if (present.length === 0) {
    throw new Error("ยังไม่มีภาพในช่วงเวลานี้");
  }

  const slotDef = SLOTS.find((s) => s.id === slot)!;
  const promptText = `วันที่ ${date} ช่วง "${slotDef.th}" (${slotDef.from}–${slotDef.to}) ถอดตัวเลขจากภาพข้างต้น`;

  const provider = getAiProvider();

  if (provider === "gemini") {
    const gemini = getGemini();
    const contents: Array<string | { text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    for (const img of imagesData) {
      contents.push({ text: `ภาพชนิด ${img.kind.toUpperCase()}:` });
      contents.push({
        inlineData: {
          mimeType: img.mime,
          data: img.data,
        },
      });
    }
    contents.push({ text: promptText });

    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM,
        thinkingConfig: {
          thinkingBudget: 0,
        },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            price_close: {
              type: Type.NUMBER,
              description: "Last traded / closing price of the contract visible in the intraday chart",
              nullable: true,
            },
            call_oi: {
              type: Type.NUMBER,
              description: "Total call-side open interest across strikes",
              nullable: true,
            },
            put_oi: {
              type: Type.NUMBER,
              description: "Total put-side open interest across strikes",
              nullable: true,
            },
            oi_chg_total: {
              type: Type.NUMBER,
              description: "Net change in total open interest for the session, negative if it fell",
              nullable: true,
            },
            pc_ratio: {
              type: Type.NUMBER,
              description: "Put/call open-interest ratio, rounded to two decimals",
              nullable: true,
            },
            summary: {
              type: Type.STRING,
              description: "Two or three sentences in Thai describing what the screenshots show",
            },
            confidence: {
              type: Type.STRING,
              enum: ["high", "medium", "low"],
              description: "How legible the numbers were",
            },
          },
          required: ["summary", "confidence"],
        },
      },
    });

    const parsed = JSON.parse(response.text || "{}") as z.infer<typeof ExtractionSchema>;
    return {
      metrics: {
        priceClose: parsed.price_close ?? null,
        callOi: parsed.call_oi ?? null,
        putOi: parsed.put_oi ?? null,
        oiChgTotal: parsed.oi_chg_total ?? null,
        pcRatio: parsed.pc_ratio ?? null,
        summary: parsed.summary ?? "",
        extractedAt: new Date().toISOString(),
        extractedFrom: present,
      },
      confidence: parsed.confidence ?? "medium",
    };
  }

  // Anthropic fallback
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
  > = [];

  for (const img of imagesData) {
    blocks.push({ type: "text", text: `ภาพชนิด ${img.kind.toUpperCase()}:` });
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mime as "image/png",
        data: img.data,
      },
    });
  }
  blocks.push({ type: "text", text: promptText });

  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: blocks }],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("อ่านค่าจากภาพไม่สำเร็จ");

  return {
    metrics: {
      priceClose: parsed.price_close,
      callOi: parsed.call_oi,
      putOi: parsed.put_oi,
      oiChgTotal: parsed.oi_chg_total,
      pcRatio: parsed.pc_ratio,
      summary: parsed.summary,
      extractedAt: new Date().toISOString(),
      extractedFrom: present,
    },
    confidence: parsed.confidence,
  };
}
