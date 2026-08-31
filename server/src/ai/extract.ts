import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Type } from "@google/genai";
import { anthropic, getAiProvider, getGemini, withAiRetry, GEMINI_MODEL, MODEL } from "./client.js";
import { IMAGE_KINDS, SLOTS, type ImageKind, type Metrics, type SlotId } from "../domain.js";
import { readImageBase64 } from "../store.js";

const ExtractionSchema = z.object({
  price_close: z
    .number()
    .nullable()
    .describe("Intraday header: the contract price shown after 'vs'"),
  intraday_put: z.number().nullable().describe("Intraday header: the number after 'Put:'"),
  intraday_call: z.number().nullable().describe("Intraday header: the number after 'Call:'"),
  vol: z.number().nullable().describe("Intraday header: the number after 'Vol:' (a volatility level, e.g. 28.69)"),
  volume_change: z.number().nullable().describe("Intraday header: the number after 'Vol Chg:', can be negative"),
  future_change: z.number().nullable().describe("Intraday header: the number after 'Future Chg:', can be negative"),
  call_oi: z.number().nullable().describe("OI image: total call-side open interest across strikes"),
  put_oi: z.number().nullable().describe("OI image: total put-side open interest across strikes"),
  pc_ratio: z.number().nullable().describe("OI image: put/call open-interest ratio, two decimals"),
  call_oi_chg: z
    .number()
    .nullable()
    .describe("OI Chg image: net change in call-side open interest, negative if it fell"),
  put_oi_chg: z
    .number()
    .nullable()
    .describe("OI Chg image: net change in put-side open interest, negative if it fell"),
  oi_chg_total: z
    .number()
    .nullable()
    .describe("OI Chg image: net change in total open interest for the session, negative if it fell"),
  summary: z
    .string()
    .describe(
      "Detailed Thai summary citing the per-image totals actually read (Intraday, OI, OI Chg), plus what stands out",
    ),
  confidence: z.enum(["high", "medium", "low"]).describe("How legible the numbers were"),
});

const SYSTEM = `คุณเป็นผู้ช่วยวิจัยที่อ่านภาพหน้าจอตลาดออปชันทองคำ COMEX (GC) แล้วถอดตัวเลขออกมา

ภาพที่ได้รับมีได้ถึงสามชนิดต่อหนึ่งช่วงเวลา ถอดตัวเลขให้ครบทุกภาพที่ได้รับ:
- Intraday — กราฟ Intraday Volume หัวกราฟมีบรรทัด "Put: ... Call: ... Vol: ... Vol Chg: ... Future Chg: ..." และมีราคาสัญญาหลังคำว่า "vs" อ่านทุกตัว
- OI — ตาราง/กราฟ Open Interest แยกฝั่ง Call และ Put อ่าน: ยอดรวม Call OI, ยอดรวม Put OI, P/C ratio
- OI Chg — การเปลี่ยนแปลงของ Open Interest เทียบกับรอบก่อน อ่าน: ยอดรวมการเปลี่ยนแปลงฝั่ง Call, ฝั่ง Put, และผลรวมสุทธิ

กฎสำคัญ — ค่าที่อ่านได้จาก "ภาพ Intraday เท่านั้น":
- price_close (ราคาหลัง "vs"), future_change, vol, volume_change, intraday_put, intraday_call
- ภาพ OI และ OI Chg มักโชว์ราคาสัญญาไว้ที่หัวภาพเหมือนกัน และมักเป็นคนละค่ากับภาพ Intraday (เก็บคนละวินาที) — "ห้ามอ่านค่าเหล่านี้จากภาพ OI หรือ OI Chg เด็ดขาด"
- ถ้าไม่มีภาพ Intraday แนบมาในรอบนี้ ให้ตอบ null ทั้ง 6 ค่าข้างต้น แม้จะเห็นตัวเลขคล้ายกันในภาพอื่น

กติกา:
- อ่านเฉพาะตัวเลขที่เห็นจริงในภาพ ถ้าอ่านไม่ได้หรือไม่มีภาพชนิดนั้นให้ตอบ null อย่าเดา
- ผลรวม OI ให้รวมทุกราคาใช้สิทธิที่ปรากฏ ถ้าภาพแสดงยอดรวมอยู่แล้วให้ใช้ยอดนั้น
- P/C ratio = Put OI ÷ Call OI คำนวณจากตัวเลขที่อ่านได้ ถ้าอ่านได้ไม่ครบให้ตอบ null
- สรุป (summary) เขียนเป็นภาษาไทยแบบละเอียด อ้างตัวเลขยอดรวมของแต่ละภาพที่อ่านได้ ไม่ใช่แค่ OI`;

export type ExtractionResult = {
  metrics: Metrics;
  confidence: "high" | "medium" | "low";
};

/**
 * Fields that only ever appear on the Intraday header. The OI and OI Chg
 * screenshots print a contract price of their own, captured a moment apart, and
 * the model has been seen reading that one instead (4584.3 off the OI image vs
 * 4584.1 on Intraday). Asking it not to is not enough — if no Intraday image
 * was in the batch, these are forced to null.
 */
const INTRADAY_ONLY = [
  "priceClose",
  "futureChg",
  "vol",
  "volChg",
  "intradayPut",
  "intradayCall",
] as const;

/** Exported for tests — this is the guarantee the user asked for. */
export function dropNonIntraday(metrics: Metrics, present: ImageKind[]): Metrics {
  if (present.includes("intraday")) return metrics;
  const cleaned = { ...metrics };
  for (const key of INTRADAY_ONLY) cleaned[key] = null;
  return cleaned;
}

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
  const promptText = `วันที่ ${date} ช่วง "${slotDef.th}" (${slotDef.from}–${slotDef.to}) ถอดตัวเลขจากภาพข้างต้น${
    present.includes("intraday")
      ? ""
      : "\n\nรอบนี้ไม่มีภาพ Intraday แนบมา — price_close, future_change, vol, volume_change, intraday_put, intraday_call ต้องเป็น null ทั้งหมด"
  }`;

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

    const response = await withAiRetry(() => gemini.models.generateContent({
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
            price_close: { type: Type.NUMBER, description: "Intraday header: price after 'vs'", nullable: true },
            intraday_put: { type: Type.NUMBER, description: "Intraday header: number after 'Put:'", nullable: true },
            intraday_call: { type: Type.NUMBER, description: "Intraday header: number after 'Call:'", nullable: true },
            vol: { type: Type.NUMBER, description: "Intraday header: number after 'Vol:'", nullable: true },
            volume_change: { type: Type.NUMBER, description: "Intraday header: number after 'Vol Chg:'", nullable: true },
            future_change: { type: Type.NUMBER, description: "Intraday header: number after 'Future Chg:'", nullable: true },
            call_oi: { type: Type.NUMBER, description: "OI: total call-side OI across strikes", nullable: true },
            put_oi: { type: Type.NUMBER, description: "OI: total put-side OI across strikes", nullable: true },
            pc_ratio: { type: Type.NUMBER, description: "OI: put/call ratio, two decimals", nullable: true },
            call_oi_chg: { type: Type.NUMBER, description: "OI Chg: net call-side OI change", nullable: true },
            put_oi_chg: { type: Type.NUMBER, description: "OI Chg: net put-side OI change", nullable: true },
            oi_chg_total: { type: Type.NUMBER, description: "OI Chg: net total OI change", nullable: true },
            summary: {
              type: Type.STRING,
              description: "Detailed Thai summary citing the per-image totals actually read",
            },
            confidence: {
              type: Type.STRING,
              enum: ["high", "medium", "low"],
              description: "How legible the numbers were",
            },
          },
          // Every field is required so the model has to state a value for each
          // one — `nullable` still lets it answer null honestly. With only
          // summary/confidence required it would quietly omit numbers it had
          // actually read (Vol / Vol Chg came back null while being quoted in
          // the summary text), and an omitted field is indistinguishable from
          // an unreadable one.
          required: [
            "price_close",
            "intraday_put",
            "intraday_call",
            "vol",
            "volume_change",
            "future_change",
            "call_oi",
            "put_oi",
            "pc_ratio",
            "call_oi_chg",
            "put_oi_chg",
            "oi_chg_total",
            "summary",
            "confidence",
          ],
        },
      },
    }));

    const parsed = JSON.parse(response.text || "{}") as z.infer<typeof ExtractionSchema>;
    return {
      metrics: dropNonIntraday(
        {
          priceClose: parsed.price_close ?? null,
          intradayPut: parsed.intraday_put ?? null,
          intradayCall: parsed.intraday_call ?? null,
          vol: parsed.vol ?? null,
          volChg: parsed.volume_change ?? null,
          futureChg: parsed.future_change ?? null,
          callOi: parsed.call_oi ?? null,
          putOi: parsed.put_oi ?? null,
          pcRatio: parsed.pc_ratio ?? null,
          callOiChg: parsed.call_oi_chg ?? null,
          putOiChg: parsed.put_oi_chg ?? null,
          oiChgTotal: parsed.oi_chg_total ?? null,
          summary: parsed.summary ?? "",
          extractedAt: new Date().toISOString(),
          extractedFrom: present,
        },
        present,
      ),
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

  const response = await withAiRetry(() => anthropic().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: blocks }],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  }));

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("อ่านค่าจากภาพไม่สำเร็จ");

  return {
    metrics: dropNonIntraday(
      {
        priceClose: parsed.price_close,
        intradayPut: parsed.intraday_put,
        intradayCall: parsed.intraday_call,
        vol: parsed.vol,
        volChg: parsed.volume_change,
        futureChg: parsed.future_change,
        callOi: parsed.call_oi,
        putOi: parsed.put_oi,
        pcRatio: parsed.pc_ratio,
        callOiChg: parsed.call_oi_chg,
        putOiChg: parsed.put_oi_chg,
        oiChgTotal: parsed.oi_chg_total,
        summary: parsed.summary,
        extractedAt: new Date().toISOString(),
        extractedFrom: present,
      },
      present,
    ),
    confidence: parsed.confidence,
  };
}
