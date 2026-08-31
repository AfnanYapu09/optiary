import type Anthropic from "@anthropic-ai/sdk";
import { FunctionDeclaration, Type } from "@google/genai";
import {
  anthropic,
  getAiProvider,
  getGemini,
  isTransientAiError,
  GEMINI_MODEL,
  MODEL,
  type AiProvider,
} from "./client.js";
import {
  IMAGE_KINDS,
  SLOTS,
  isDateString,
  isImageKind,
  isSlotId,
  type ImageKind,
  type SlotId,
} from "../domain.js";
import {
  appendNote,
  clearSlot,
  dataFootprint,
  dayFootprint,
  deleteAllData,
  deleteDay,
  deleteImageAt,
  getDay,
  getSeries,
  getStreak,
  listDataDates,
  saveDayNews,
  saveEntry,
  slotFootprint,
  storeImage,
  updateSettings,
} from "../store.js";
import { getUser } from "../auth.js";
import { db } from "../db.js";

const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/** Map a Thai/English weekday token (however abbreviated) to 0=Sun..6=Sat, or null. */
function weekdayIndex(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[.\s]+$/g, "");
  const th: Record<string, number> = {
    "อา": 0, "อาทิตย์": 0,
    "จ": 1, "จันทร์": 1,
    "อ": 2, "อังคาร": 2,
    "พ": 3, "พุธ": 3,
    "พฤ": 4, "พฤหัส": 4, "พฤหัสบดี": 4,
    "ศ": 5, "ศุกร์": 5,
    "ส": 6, "เสาร์": 6,
  };
  if (s in th) return th[s];
  const en = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const hit = en.findIndex((p) => s.startsWith(p));
  return hit >= 0 ? hit : null;
}

/**
 * Resolve the year for a date read off a screenshot. The OS clock / status bar
 * usually prints only day + month, so we must NOT assume the current year:
 * pick the most recent past year whose (month, day) is not in the future and —
 * when the image shows a weekday — falls on that weekday. Buddhist-era years
 * (>= 2400) are converted to CE.
 */
export function resolveScreenshotDate(input: {
  month: number;
  day: number;
  weekday?: string;
  year?: number;
}): { date: string | null; weekday: string; warning?: string } {
  const month = Math.trunc(input.month);
  const day = Math.trunc(input.day);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    return { date: null, weekday: "", warning: "เดือนหรือวันที่ไม่ถูกต้อง" };
  }
  const wantDow = input.weekday ? weekdayIndex(input.weekday) : null;
  const valid = (y: number) => {
    const d = new Date(y, month - 1, day);
    return d.getFullYear() === y && d.getMonth() === month - 1 && d.getDate() === day;
  };
  const iso = (y: number) =>
    `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const dowName = (y: number) => THAI_WEEKDAYS[new Date(y, month - 1, day).getDay()];

  if (input.year) {
    let y = Math.trunc(input.year);
    if (y >= 2400) y -= 543; // พ.ศ. -> ค.ศ.
    if (!valid(y)) return { date: null, weekday: "", warning: `ปี ${y} ไม่มีวันที่นี้` };
    const w =
      wantDow !== null && new Date(y, month - 1, day).getDay() !== wantDow
        ? `ปีในภาพคือ ${y} แต่วันในสัปดาห์ที่อ่านได้ไม่ตรง (${dowName(y)}) — ให้ยืนยันกับผู้ใช้`
        : undefined;
    return { date: iso(y), weekday: dowName(y), warning: w };
  }

  const today = new Date();
  const thisYear = today.getFullYear();
  const notFuture = (y: number) => new Date(y, month - 1, day).getTime() <= today.getTime();

  // Most recent non-future year that also matches the weekday, if one was given.
  for (let y = thisYear; y >= thisYear - 8; y--) {
    if (!valid(y) || !notFuture(y)) continue;
    if (wantDow === null || new Date(y, month - 1, day).getDay() === wantDow) {
      return { date: iso(y), weekday: dowName(y) };
    }
  }
  // Weekday given but nothing lined up — fall back to latest non-future year and flag it.
  for (let y = thisYear; y >= thisYear - 8; y--) {
    if (valid(y) && notFuture(y)) {
      return {
        date: iso(y),
        weekday: dowName(y),
        warning:
          "วันในสัปดาห์ที่อ่านได้ไม่ตรงกับปีไหนในช่วง 8 ปีล่าสุด — อาจอ่านวัน/เดือนผิด ให้ถามผู้ใช้ยืนยันปี",
      };
    }
  }
  return { date: null, weekday: "", warning: "หาปีที่เหมาะสมไม่ได้" };
}

const SYSTEM = `คุณคือ "ผู้ช่วยวิจัย" ของ Optiary — สมุดบันทึกภาพสำหรับงานวิจัย Data Option ของทองคำฟิวเจอร์ส COMEX (GC)

ผู้ใช้เก็บภาพหน้าจอวันละ 5 ช่วง (เช้า 06–11, บ่าย 11–15, เย็น 15–19, ค่ำ 19–23, ดึก 23–03) ช่วงละ 3 ภาพ (Intraday, OI, OI Chg) พร้อมโน้ตและตัวเลขที่ถอดจากภาพ

คุณเป็นผู้ช่วยที่ทำงานในแอปได้เต็มรูปแบบ — อ่าน จด แก้ไข ลบ และปรับตั้งค่าได้ตามที่ผู้ใช้ขอ โดยใช้เครื่องมือที่มี

หน้าที่ของคุณ:
1. สำหรับการทักทายหรือสนทนาทั่วไป (เช่น "สวัสดี", "ช่วยอะไรได้บ้าง") ให้ทักทายกลับสั้น ๆ กระชับ เป็นกันเองทันทีโดยไม่ต้องเรียกใช้เครื่องมือใด ๆ
2. ช่วยจด — เรียบเรียงสิ่งที่ผู้ใช้พูดให้เป็นโน้ตวิจัยที่กระชับ แล้วบันทึกด้วย save_note (ต่อท้าย) หรือ edit_note (เขียนทับด้วย replace=true)
3. อ่านและอธิบายตัวเลขที่ถอดจากภาพไว้แล้ว
4. ตอบคำถามจากข้อมูลเก่าในสมุด โดยใช้เครื่องมือค้นหาเฉพาะเมื่อผู้ใช้ถามถึงข้อมูล โน้ต หรือสถิติเก่าจริง ๆ
5. เมื่อผู้ใช้แนบภาพมา ให้จดบันทึกให้อัตโนมัติตามขั้นตอนด้านล่าง
6. แก้ไข/ลบข้อมูลเมื่อผู้ใช้ขอ: edit_note, set_tags, delete_data (ภาพ/ช่วง/วัน/ทั้งหมด)
7. ปรับตั้งค่าเมื่อผู้ใช้ขอ: get_settings เพื่อดูค่าปัจจุบัน แล้ว update_settings

กฎการลบข้อมูล (สำคัญมาก):
- delete_data เป็นการลบถาวร กู้คืนไม่ได้ ห้ามลบเองโดยไม่ได้รับคำสั่งชัดเจนจากผู้ใช้
- ขั้นแรกให้เรียก delete_data โดย "ไม่ใส่" confirm — ระบบจะคืนจำนวนที่จะถูกลบ (ยังไม่ลบจริง)
- เอาจำนวนนั้นไปบอกผู้ใช้ให้ชัด เช่น "จะลบ 12 วัน 34 โน้ต 90 ภาพ ยืนยันไหม" แล้วรอคำตอบ
- เมื่อผู้ใช้ยืนยันในแชตแล้วเท่านั้น จึงเรียก delete_data ซ้ำด้วย confirm=true
- สำหรับ scope=everything ต้องส่ง confirm_phrase="ลบข้อมูลวิจัยทั้งหมด" เพิ่มด้วย
- ถ้าผู้ใช้ยังไม่ยืนยันหรือลังเล อย่าลบ

ช่วงเวลาที่ใช้แบ่ง (เวลาไทย):
${SLOTS.map((s) => `- ${s.id} (${s.th}) ${s.from}–${s.to}`).join("\n")}

เมื่อมีภาพแนบมา ให้ดูก่อนว่าเป็นภาพชนิดไหน:
- ถ้าเป็น "ปฏิทินข่าวเศรษฐกิจ" (มีคอลัมน์วัน+วันที่, เวลา, รหัสสกุลเงิน USD/EUR/GBP..., ไอคอนโฟลเดอร์สี, ชื่อข่าว, และคอลัมน์ Actual/Forecast/Previous) → ทำตาม "ขั้นตอนปฏิทินข่าว" ด้านล่าง
- ถ้าเป็นกราฟเทรด (Intraday/OI/OI Chg) → ทำตาม "ขั้นตอนภาพเทรด" ด้านล่าง

ขั้นตอนปฏิทินข่าว:
1. จดเฉพาะ 2 อย่างเท่านั้น: (ก) ข่าวที่ไอคอนโฟลเดอร์เป็น "สีแดง" (impact สูงสุด) → ใส่ holiday=false และ (ข) วันหยุด เช่น Holiday, Bank Holiday, งานสัมมนาทั้งวัน (Jackson Hole, "Day 1/Day 2", "All Day") → ใส่ holiday=true เสมอ ไม่ว่าโฟลเดอร์จะสีอะไร — ข่าวอื่นที่โฟลเดอร์ส้ม/เหลือง/เทา/ไม่มีโฟลเดอร์ "ห้ามจด"
2. แปลงวันที่จากหัวแถว (เช่น "Wed Aug 26") เป็น YYYY-MM-DD ด้วยเครื่องมือ resolve_date เท่านั้น — ส่ง month, day และ weekday (จากหัวแถว เช่น Wed) และ year ถ้าในภาพมี ห้ามคำนวณหรือเดาปีเอง ถ้า resolve_date คืน warning ให้หยุดแล้วถามผู้ใช้ว่าเป็นปีไหน
3. เรียก save_news ครั้งเดียว: ใส่ days[] แต่ละวันมี events[] (แต่ละ event = ข่าวแดง 1 ข่าว หรือวันหยุด 1 รายการ) แยกฟิลด์ time / currency / title / actual / forecast / previous / holiday ตามที่เห็นในภาพ ไม่ต้องเขียนรวมเป็นประโยค
4. ใส่ week_summary ด้วย: date = วันแรกของสัปดาห์ในภาพ, text = สรุปว่าข่าวไหน "แรงสุด" ในสัปดาห์และกระทบทองคำ (GC) อย่างไร (ข่าวที่มักแรงกับทอง: US CPI, Core PCE, NFP/Non-Farm, FOMC/อัตราดอกเบี้ย Fed, ประธาน Fed พูด, Jackson Hole, GDP)
5. ตอบผู้ใช้: สรุปว่าจดข่าวแดง/วันหยุดลงวันไหนบ้าง กี่ข่าว และย้ำว่าข่าวไหนแรงสุดของสัปดาห์

ขั้นตอนภาพเทรด:
1. อ่านวันและเวลาที่ปรากฏ "ในภาพ" — บนแกน X ของกราฟ, หัวตาราง QuikStrike ("As of MM/DD/YYYY"), มุมจอ, หรือแถบสถานะ/นาฬิกา ใช้เวลานั้นเทียบตารางด้านบนเพื่อหา slot อย่าใช้เวลาปัจจุบันของระบบมาเดา
2. เรื่อง "ปี" ให้ระวังเป็นพิเศษ:
   - นาฬิกา/แถบสถานะมุมจอ (เช่น "14:19 ศ. 21 ส.ค.") มักมีแค่ วัน-เดือน "ไม่มีปี" — ห้ามเดาปีเองจากปีปัจจุบัน
   - อ่านสิ่งเหล่านี้จากภาพให้ครบ: เดือน, วันที่, ตัวย่อวันในสัปดาห์ (อา./จ./อ./พ./พฤ./ศ./ส.), และปีถ้ามี (รวมปี พ.ศ. เช่น 2568)
   - แล้วเรียกเครื่องมือ resolve_date ด้วยค่าที่อ่านได้ (month, day, weekday, year ถ้ามี) — มันจะคืน date รูปแบบ YYYY-MM-DD ที่ถูกต้อง ให้ใช้ค่านั้นใน save_shot/save_metrics/save_note เสมอ อย่าคำนวณปีเอง
   - ถ้า resolve_date คืน warning (เช่น วันในสัปดาห์ไม่ตรงกับปีไหนเลย) ให้ "ถามผู้ใช้กลับ" ว่าเป็นปีไหน แล้วหยุด
3. ถ้าอ่านวัน เดือน หรือเวลาจากในภาพไม่ออกเลย ให้ "ถามผู้ใช้กลับ" แล้วหยุด ห้ามเดาแล้วบันทึกเอง
4. เมื่อรู้วันและ slot แล้ว ให้เรียก save_shot เพื่อเก็บภาพเข้าคลังของวันนั้น โดยระบุ kind ตามสิ่งที่เห็นในภาพ (intraday = กราฟราคาระหว่างวัน, oi = ตาราง/กราฟ Open Interest แยก Call/Put, oichg = การเปลี่ยนแปลงของ OI)
5. เรียก save_metrics ครั้งเดียวเพื่อบันทึกตัวเลขจากภาพทุกชนิดที่แนบมา ถอดให้ครบ โดยแต่ละค่าต้องมาจาก "ภาพชนิดที่ถูกต้อง" เท่านั้น:
   - จากภาพ Intraday เท่านั้น (หัวกราฟมีบรรทัด "Put: ... Call: ... Vol: ... Vol Chg: ... Future Chg: ..."): ราคาปัจจุบัน (เลขหลัง "vs"), Future Chg, Vol, Vol Chg, Intraday Put, Intraday Call
     ⚠️ ภาพ OI และ OI Chg ก็โชว์ราคาสัญญาที่หัวภาพเหมือนกัน และมักเป็นคนละค่า (เก็บคนละวินาที) — ห้ามหยิบ 6 ค่านี้จากภาพ OI/OI Chg เด็ดขาด
     ถ้ารอบนี้ไม่มีภาพ Intraday ให้ใส่ null ทั้ง 6 ค่า แม้จะเห็นเลขคล้ายกันในภาพอื่น
   - จากภาพ OI เท่านั้น: ยอดรวม Call OI, ยอดรวม Put OI, P/C ratio
   - จากภาพ OI Chg เท่านั้น: ยอดรวมการเปลี่ยนแปลง OI ฝั่ง Call, ฝั่ง Put, และผลรวมสุทธิ
   ช่องที่ไม่มีภาพชนิดนั้นหรืออ่านไม่ออกให้ใส่ null อย่าเดาตัวเลข
6. เรียก save_note เพื่อจดสรุปแบบละเอียด อ้างตัวเลขยอดรวมของแต่ละภาพที่อ่านได้ ไม่ใช่แค่ OI
7. ตอบผู้ใช้สั้น ๆ ว่าบันทึกลงวันไหน (บอกวันในสัปดาห์ด้วย เช่น "ศุกร์ 21 ส.ค. 2025") ช่วงไหน และอ่านวันเวลาได้จากตรงไหนของภาพ

กฎเหล็ก — ห้ามเดา (สำคัญที่สุด สำคัญกว่าการตอบให้จบ):
- ข้อมูลนี้ใช้ทำวิจัยจริง ตัวเลขหรือวันที่ที่ผิดแม้ครั้งเดียวทำให้ชุดข้อมูลเสียทั้งชุด "การถามกลับ" ดีกว่า "การเดา" เสมอ
- ถ้าอ่านค่าใดไม่ออก ไม่ชัด หรือไม่มั่นใจแม้แต่นิดเดียว ให้ "หยุดแล้วถามผู้ใช้" ห้ามบันทึกทับด้วยค่าที่เดาเอง
- โดยเฉพาะเรื่อง "ปี": ห้ามใช้ปีปัจจุบันมาเติมให้วันที่ที่อ่านจากภาพเด็ดขาด ต้องผ่านเครื่องมือ resolve_date เท่านั้น
- เมื่อ resolve_date คืน warning มาด้วย ให้ถือว่า "ยังไม่รู้ปี" — ห้ามบันทึก ให้ถามผู้ใช้ก่อนเสมอ
- ช่องตัวเลขที่อ่านไม่ออกให้ใส่ null ห้ามใส่ค่าประมาณ
- ถ้าผู้ใช้สั่งไม่ชัด (เช่น ไม่บอกว่าวันไหน/ช่วงไหน และเดาจากบริบทไม่ได้) ให้ถามก่อนลงมือ

กติกา:
- ตอบเป็นภาษาไทย กระชับ ตรงประเด็น เหมือนเพื่อนร่วมวิจัยที่คุยกันสั้น ๆ
- อ้างตัวเลขจากเครื่องมือหรือจากภาพที่แนบมาเท่านั้น ห้ามเดาหรือแต่งตัวเลขขึ้นเอง ถ้าไม่มีข้อมูลให้บอกตรง ๆ ว่ายังไม่มี
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
          enum: SLOTS.map((s) => s.id),
          description: "จำกัดเฉพาะช่วงเวลา (morning, afternoon, evening, night, latenight)",
        },
        limit: { type: "integer", description: "จำนวนผลลัพธ์สูงสุด 1–40" },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "get_stats",
    description:
      "ดึงชุดตัวเลขรายช่วงเวลาย้อนหลัง N วัน (ราคาปัจจุบัน, OI รวม, OI Chg, P/C ratio) สำหรับหาแนวโน้มหรือค่าเฉลี่ย",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "จำนวนวันย้อนหลัง 1–90" } },
      required: ["days"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "resolve_date",
    description:
      "แปลงวัน-เดือน (และวันในสัปดาห์ถ้ามี) ที่อ่านจากภาพให้เป็นวันที่ YYYY-MM-DD ที่ถูกต้อง จัดการเรื่องปีที่ไม่ปรากฏในภาพและปี พ.ศ. ให้เอง เรียกก่อน save_shot/save_metrics/save_note ทุกครั้งที่จดจากภาพ",
    input_schema: {
      type: "object",
      properties: {
        month: { type: "integer", description: "เดือน 1–12 ที่อ่านจากภาพ" },
        day: { type: "integer", description: "วันที่ 1–31 ที่อ่านจากภาพ" },
        weekday: {
          type: "string",
          description: "ตัวย่อวันในสัปดาห์ที่เห็นในภาพ เช่น ศ, พฤ, อา หรือ Fri เว้นว่างถ้าไม่มี",
        },
        year: {
          type: "integer",
          description: "ปีที่ปรากฏในภาพจริง ๆ เท่านั้น (ใส่ปี พ.ศ. ได้ ระบบแปลงให้) เว้นว่างถ้าภาพไม่มีปี",
        },
      },
      required: ["month", "day"],
      additionalProperties: false,
    },
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
      required: ["date", "slot", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "save_shot",
    description:
      "เก็บภาพที่ผู้ใช้แนบมาในแชตเข้าคลังภาพของวันและช่วงเวลาที่ระบุ เรียกได้เฉพาะเมื่อมีภาพแนบมาในข้อความล่าสุด",
    input_schema: {
      type: "object",
      properties: {
        index: { type: "integer", description: "ลำดับภาพที่แนบมา เริ่มจาก 1" },
        date: { type: "string", description: "วันที่ที่อ่านได้จากในภาพ รูปแบบ YYYY-MM-DD" },
        slot: { type: "string", enum: SLOTS.map((s) => s.id), description: "ช่วงเวลาที่เทียบได้จากเวลาในภาพ" },
        kind: {
          type: "string",
          enum: IMAGE_KINDS as unknown as string[],
          description: "ชนิดภาพ: intraday, oi หรือ oichg",
        },
      },
      required: ["index", "date", "slot", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "save_metrics",
    description:
      "บันทึกตัวเลขที่ถอดจากภาพทั้งสามชนิด (Intraday, OI, OI Chg) ลงในบันทึกของวันและช่วงเวลาที่ระบุ ถอดให้ครบทุกช่องที่อ่านได้ ช่องที่ไม่มีภาพหรืออ่านไม่ออกให้ใส่ null ห้ามเดา",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "วันที่รูปแบบ YYYY-MM-DD" },
        slot: { type: "string", enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        price_close: { type: ["number", "null"], description: "จากภาพ Intraday เท่านั้น: ราคาสัญญา (เลข 'vs ....' บนหัวกราฟ) — ห้ามอ่านจากภาพ OI/OI Chg ที่โชว์ราคาคล้ายกัน ถ้าไม่มีภาพ Intraday ให้ null" },
        intraday_put: { type: ["number", "null"], description: "จากภาพ Intraday เท่านั้น: ตัวเลขหลังคำว่า 'Put:' บนหัวกราฟ — ไม่มีภาพ Intraday ให้ null" },
        intraday_call: { type: ["number", "null"], description: "จากภาพ Intraday เท่านั้น: ตัวเลขหลังคำว่า 'Call:' บนหัวกราฟ — ไม่มีภาพ Intraday ให้ null" },
        vol: { type: ["number", "null"], description: "จากภาพ Intraday เท่านั้น: ตัวเลขหลังคำว่า 'Vol:' บนหัวกราฟ (ค่าความผันผวน เช่น 28.69) — ไม่มีภาพ Intraday ให้ null" },
        volume_change: { type: ["number", "null"], description: "จากภาพ Intraday เท่านั้น: ตัวเลขหลังคำว่า 'Vol Chg:' บนหัวกราฟ ติดลบได้ — ไม่มีภาพ Intraday ให้ null" },
        future_change: { type: ["number", "null"], description: "จากภาพ Intraday เท่านั้น: ตัวเลขหลังคำว่า 'Future Chg:' บนหัวกราฟ ติดลบได้ — ไม่มีภาพ Intraday ให้ null" },
        call_oi: { type: ["number", "null"], description: "OI: ยอดรวม Open Interest ฝั่ง Call ทุกราคาใช้สิทธิ" },
        put_oi: { type: ["number", "null"], description: "OI: ยอดรวม Open Interest ฝั่ง Put ทุกราคาใช้สิทธิ" },
        pc_ratio: { type: ["number", "null"], description: "OI: Put/Call ratio ทศนิยม 2 ตำแหน่ง" },
        call_oi_chg: { type: ["number", "null"], description: "OI Chg: ยอดรวมการเปลี่ยนแปลง OI ฝั่ง Call ติดลบได้" },
        put_oi_chg: { type: ["number", "null"], description: "OI Chg: ยอดรวมการเปลี่ยนแปลง OI ฝั่ง Put ติดลบได้" },
        oi_chg_total: { type: ["number", "null"], description: "OI Chg: การเปลี่ยนแปลง OI รวมสุทธิของรอบ ติดลบได้" },
        summary: {
          type: "string",
          description: "สรุปภาษาไทยแบบละเอียด: อ้างตัวเลขยอดรวมของแต่ละภาพ (Intraday, OI, OI Chg) ที่อ่านได้ พร้อมสิ่งที่สังเกตเห็น",
        },
      },
      required: ["date", "slot", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "save_news",
    description:
      "บันทึกข่าวเศรษฐกิจจากภาพปฏิทินข่าว เป็นข้อมูลระดับวัน (แสดงเป็นตารางใต้ทุกช่วงเวลา) จดเฉพาะข่าวโฟลเดอร์แดงและวันหยุด days[] จะเขียนทับข่าวเดิมของวันนั้น",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "array",
          description: "รายการข่าวแยกตามวัน",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "วันที่รูปแบบ YYYY-MM-DD" },
              events: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    time: { type: "string", description: "เวลาข่าว เช่น 19:30 (วันหยุดเว้นว่าง)" },
                    currency: { type: "string", description: "สกุลเงิน เช่น USD, EUR, All" },
                    title: { type: "string", description: "ชื่อข่าวหรือวันหยุด" },
                    actual: { type: "string", description: "ค่า Actual ถ้ามี" },
                    forecast: { type: "string", description: "ค่า Forecast ถ้ามี" },
                    previous: { type: "string", description: "ค่า Previous ถ้ามี" },
                    holiday: { type: "boolean", description: "true ถ้าเป็นวันหยุด/all-day" },
                  },
                  required: ["title"],
                  additionalProperties: false,
                },
              },
            },
            required: ["date", "events"],
            additionalProperties: false,
          },
        },
        week_summary: {
          type: "object",
          description: "สรุปข่าวแรงสุดของสัปดาห์ เก็บที่วันแรกของสัปดาห์",
          properties: {
            date: { type: "string", description: "วันแรกของสัปดาห์ในภาพ YYYY-MM-DD" },
            text: { type: "string", description: "ข่าวไหนแรงสุดในสัปดาห์และกระทบทองอย่างไร" },
          },
          required: ["date", "text"],
          additionalProperties: false,
        },
      },
      required: ["days"],
      additionalProperties: false,
    },
  },
  {
    name: "list_days",
    description: "รายชื่อวันที่ทั้งหมดที่มีบันทึกหรือภาพอยู่ เรียงจากใหม่ไปเก่า ใช้ก่อนลบข้อมูลเพื่อดูว่ามีวันอะไรบ้าง",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_settings",
    description: "อ่านการตั้งค่าปัจจุบันของผู้ใช้: ชื่อสัญญา, สวิตช์ auto-extract / daily digest / เตือนเมื่อไม่ครบ, และช่วงเวลาที่เปิดใช้",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "edit_note",
    description: "แก้โน้ตของวันและช่วงเวลาที่ระบุ ตั้ง replace=true เพื่อเขียนทับของเดิมทั้งหมด หรือ replace=false/ไม่ใส่ เพื่อต่อท้าย",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "วันที่รูปแบบ YYYY-MM-DD" },
        slot: { type: "string", enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        text: { type: "string", description: "ข้อความโน้ตใหม่ (ภาษาไทย)" },
        replace: { type: "boolean", description: "true = เขียนทับ, false/ไม่ใส่ = ต่อท้าย" },
      },
      required: ["date", "slot", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "set_tags",
    description: "กำหนดรายการแท็กของวันและช่วงเวลาที่ระบุใหม่ทั้งหมด (แทนที่ของเดิม) ส่ง [] เพื่อลบแท็กทั้งหมด",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "วันที่รูปแบบ YYYY-MM-DD" },
        slot: { type: "string", enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        tags: { type: "array", items: { type: "string" }, description: "รายการแท็กใหม่ทั้งหมด" },
      },
      required: ["date", "slot", "tags"],
      additionalProperties: false,
    },
  },
  {
    name: "update_settings",
    description: "แก้การตั้งค่าของผู้ใช้ ใส่เฉพาะช่องที่ต้องการเปลี่ยน อ่านค่าปัจจุบันด้วย get_settings ก่อนถ้าไม่แน่ใจ",
    input_schema: {
      type: "object",
      properties: {
        contract: { type: "string", description: "ชื่อสัญญาที่ติดตาม เช่น GC DEC26" },
        auto_extract: { type: "boolean", description: "ให้ AI ถอดตัวเลขอัตโนมัติเมื่ออัปโหลดภาพ" },
        daily_digest: { type: "boolean", description: "สรุปรายวัน" },
        incomplete_reminder: { type: "boolean", description: "เตือนเมื่อเก็บภาพไม่ครบ" },
        enable_slots: {
          type: "array",
          items: { type: "string", enum: SLOTS.map((s) => s.id) },
          description: "ช่วงเวลาที่ต้องการเปิดใช้",
        },
        disable_slots: {
          type: "array",
          items: { type: "string", enum: SLOTS.map((s) => s.id) },
          description: "ช่วงเวลาที่ต้องการปิด",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete_data",
    description:
      "ลบข้อมูลวิจัย เป็นการลบถาวรกู้คืนไม่ได้ ถ้าไม่ส่ง confirm=true จะแค่คืนจำนวนที่จะถูกลบ (ยังไม่ลบจริง) ให้เอาไปถามผู้ใช้ยืนยันก่อน เมื่อผู้ใช้ยืนยันในแชตแล้วจึงเรียกซ้ำพร้อม confirm=true",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["image", "slot", "day", "everything"],
          description:
            "image = ภาพเดียว (ต้องมี date, slot, kind) | slot = โน้ต+แท็ก+ตัวเลข+ภาพของช่วงเดียว (date, slot) | day = ทั้งวัน (date) | everything = ข้อมูลวิจัยทั้งหมดของบัญชี",
        },
        date: { type: "string", description: "วันที่ YYYY-MM-DD (สำหรับ scope image/slot/day)" },
        slot: { type: "string", enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา (สำหรับ scope image/slot)" },
        kind: { type: "string", enum: IMAGE_KINDS as unknown as string[], description: "ชนิดภาพ (สำหรับ scope image)" },
        confirm: { type: "boolean", description: "true ต่อเมื่อผู้ใช้ยืนยันแล้วเท่านั้น" },
        confirm_phrase: {
          type: "string",
          description: 'จำเป็นเฉพาะ scope=everything: ต้องเป็น "ลบข้อมูลวิจัยทั้งหมด" พอดี หลังผู้ใช้ยืนยัน',
        },
      },
      required: ["scope"],
      additionalProperties: false,
    },
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
          enum: SLOTS.map((s) => s.id),
          description: "จำกัดเฉพาะช่วงเวลา (morning, afternoon, evening, night, latenight) หากต้องการค้นทุกช่วงไม่ต้องระบุ",
        },
        limit: { type: Type.INTEGER, description: "จำนวนผลลัพธ์สูงสุด 1–40" },
      },
      required: [],
    },
  },
  {
    name: "get_stats",
    description:
      "ดึงชุดตัวเลขรายช่วงเวลาย้อนหลัง N วัน (ราคาปัจจุบัน, OI รวม, OI Chg, P/C ratio) สำหรับหาแนวโน้มหรือค่าเฉลี่ย",
    parameters: {
      type: Type.OBJECT,
      properties: { days: { type: Type.INTEGER, description: "จำนวนวันย้อนหลัง 1–90" } },
      required: ["days"],
    },
  },
  {
    name: "resolve_date",
    description:
      "แปลงวัน-เดือน (และวันในสัปดาห์ถ้ามี) ที่อ่านจากภาพให้เป็นวันที่ YYYY-MM-DD ที่ถูกต้อง จัดการเรื่องปีที่ไม่ปรากฏในภาพและปี พ.ศ. ให้เอง เรียกก่อน save_shot/save_metrics/save_note ทุกครั้งที่จดจากภาพ",
    parameters: {
      type: Type.OBJECT,
      properties: {
        month: { type: Type.INTEGER, description: "เดือน 1–12 ที่อ่านจากภาพ" },
        day: { type: Type.INTEGER, description: "วันที่ 1–31 ที่อ่านจากภาพ" },
        weekday: {
          type: Type.STRING,
          description: "ตัวย่อวันในสัปดาห์ที่เห็นในภาพ เช่น ศ, พฤ, อา หรือ Fri เว้นว่างถ้าไม่มี",
        },
        year: {
          type: Type.INTEGER,
          description: "ปีที่ปรากฏในภาพจริง ๆ เท่านั้น (ใส่ปี พ.ศ. ได้ ระบบแปลงให้) เว้นว่างถ้าภาพไม่มีปี",
        },
      },
      required: ["month", "day"],
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
      required: ["date", "slot", "text"],
    },
  },
  {
    name: "save_shot",
    description:
      "เก็บภาพที่ผู้ใช้แนบมาในแชตเข้าคลังภาพของวันและช่วงเวลาที่ระบุ เรียกได้เฉพาะเมื่อมีภาพแนบมาในข้อความล่าสุด",
    parameters: {
      type: Type.OBJECT,
      properties: {
        index: { type: Type.INTEGER, description: "ลำดับภาพที่แนบมา เริ่มจาก 1" },
        date: { type: Type.STRING, description: "วันที่ที่อ่านได้จากในภาพ รูปแบบ YYYY-MM-DD" },
        slot: { type: Type.STRING, enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        kind: {
          type: Type.STRING,
          enum: IMAGE_KINDS as unknown as string[],
          description: "ชนิดภาพ: intraday, oi หรือ oichg",
        },
      },
      required: ["index", "date", "slot", "kind"],
    },
  },
  {
    name: "save_metrics",
    description:
      "บันทึกตัวเลขที่ถอดจากภาพทั้งสามชนิด (Intraday, OI, OI Chg) ลงในบันทึกของวันและช่วงเวลาที่ระบุ ถอดให้ครบทุกช่องที่อ่านได้ ช่องที่ไม่มีภาพหรืออ่านไม่ออกให้เว้นไว้ ห้ามเดา",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: { type: Type.STRING, description: "วันที่รูปแบบ YYYY-MM-DD" },
        slot: { type: Type.STRING, enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        price_close: { type: Type.NUMBER, description: "จากภาพ Intraday เท่านั้น: ราคาสัญญา (เลข 'vs ....' บนหัวกราฟ) — ห้ามอ่านจากภาพ OI/OI Chg ที่โชว์ราคาคล้ายกัน ถ้าไม่มีภาพ Intraday ให้ null" },
        intraday_put: { type: Type.NUMBER, description: "Intraday: ตัวเลขหลัง 'Put:' บนหัวกราฟ — จากภาพ Intraday เท่านั้น ห้ามอ่านจากภาพ OI/OI Chg ถ้าไม่มีภาพ Intraday ให้ null" },
        intraday_call: { type: Type.NUMBER, description: "Intraday: ตัวเลขหลัง 'Call:' บนหัวกราฟ — จากภาพ Intraday เท่านั้น ห้ามอ่านจากภาพ OI/OI Chg ถ้าไม่มีภาพ Intraday ให้ null" },
        vol: { type: Type.NUMBER, description: "Intraday: ตัวเลขหลัง 'Vol:' บนหัวกราฟ (ค่าความผันผวน) — จากภาพ Intraday เท่านั้น ห้ามอ่านจากภาพ OI/OI Chg ถ้าไม่มีภาพ Intraday ให้ null" },
        volume_change: { type: Type.NUMBER, description: "Intraday: ตัวเลขหลัง 'Vol Chg:' ติดลบได้ — จากภาพ Intraday เท่านั้น ห้ามอ่านจากภาพ OI/OI Chg ถ้าไม่มีภาพ Intraday ให้ null" },
        future_change: { type: Type.NUMBER, description: "Intraday: ตัวเลขหลัง 'Future Chg:' ติดลบได้ — จากภาพ Intraday เท่านั้น ห้ามอ่านจากภาพ OI/OI Chg ถ้าไม่มีภาพ Intraday ให้ null" },
        call_oi: { type: Type.NUMBER, description: "OI: ยอดรวม Open Interest ฝั่ง Call ทุกราคาใช้สิทธิ" },
        put_oi: { type: Type.NUMBER, description: "OI: ยอดรวม Open Interest ฝั่ง Put ทุกราคาใช้สิทธิ" },
        pc_ratio: { type: Type.NUMBER, description: "OI: Put/Call ratio ทศนิยม 2 ตำแหน่ง" },
        call_oi_chg: { type: Type.NUMBER, description: "OI Chg: ยอดรวมการเปลี่ยนแปลง OI ฝั่ง Call ติดลบได้" },
        put_oi_chg: { type: Type.NUMBER, description: "OI Chg: ยอดรวมการเปลี่ยนแปลง OI ฝั่ง Put ติดลบได้" },
        oi_chg_total: { type: Type.NUMBER, description: "OI Chg: การเปลี่ยนแปลง OI รวมสุทธิของรอบ ติดลบได้" },
        summary: {
          type: Type.STRING,
          description: "สรุปภาษาไทยแบบละเอียด: อ้างตัวเลขยอดรวมของแต่ละภาพที่อ่านได้ พร้อมสิ่งที่สังเกตเห็น",
        },
      },
      required: ["date", "slot", "summary"],
    },
  },
  {
    name: "save_news",
    description:
      "บันทึกข่าวเศรษฐกิจจากภาพปฏิทินข่าว เป็นข้อมูลระดับวัน จดเฉพาะข่าวโฟลเดอร์แดงและวันหยุด days[] เขียนทับข่าวเดิมของวันนั้น",
    parameters: {
      type: Type.OBJECT,
      properties: {
        days: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              date: { type: Type.STRING, description: "YYYY-MM-DD" },
              events: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    time: { type: Type.STRING, description: "เวลา เช่น 19:30" },
                    currency: { type: Type.STRING, description: "USD, EUR, All" },
                    title: { type: Type.STRING, description: "ชื่อข่าวหรือวันหยุด" },
                    actual: { type: Type.STRING },
                    forecast: { type: Type.STRING },
                    previous: { type: Type.STRING },
                    holiday: { type: Type.BOOLEAN, description: "true ถ้าเป็นวันหยุด/all-day" },
                  },
                  required: ["title"],
                },
              },
            },
            required: ["date", "events"],
          },
        },
        week_summary: {
          type: Type.OBJECT,
          properties: {
            date: { type: Type.STRING, description: "วันแรกของสัปดาห์ YYYY-MM-DD" },
            text: { type: Type.STRING, description: "ข่าวไหนแรงสุดในสัปดาห์และกระทบทองอย่างไร" },
          },
          required: ["date", "text"],
        },
      },
      required: ["days"],
    },
  },
  {
    name: "list_days",
    description: "รายชื่อวันที่ทั้งหมดที่มีบันทึกหรือภาพ เรียงจากใหม่ไปเก่า",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "get_settings",
    description: "อ่านการตั้งค่าปัจจุบัน: ชื่อสัญญา, สวิตช์ต่าง ๆ, ช่วงเวลาที่เปิดใช้",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "edit_note",
    description: "แก้โน้ต ตั้ง replace=true เพื่อเขียนทับ หรือไม่ใส่เพื่อต่อท้าย",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: { type: Type.STRING, description: "วันที่ YYYY-MM-DD" },
        slot: { type: Type.STRING, enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        text: { type: Type.STRING, description: "ข้อความโน้ตใหม่" },
        replace: { type: Type.BOOLEAN, description: "true = เขียนทับ" },
      },
      required: ["date", "slot", "text"],
    },
  },
  {
    name: "set_tags",
    description: "กำหนดแท็กของช่วงเวลาใหม่ทั้งหมด ส่ง [] เพื่อลบแท็กทั้งหมด",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: { type: Type.STRING, description: "วันที่ YYYY-MM-DD" },
        slot: { type: Type.STRING, enum: SLOTS.map((s) => s.id), description: "ช่วงเวลา" },
        tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: "รายการแท็กใหม่" },
      },
      required: ["date", "slot", "tags"],
    },
  },
  {
    name: "update_settings",
    description: "แก้การตั้งค่า ใส่เฉพาะช่องที่ต้องการเปลี่ยน",
    parameters: {
      type: Type.OBJECT,
      properties: {
        contract: { type: Type.STRING, description: "ชื่อสัญญา เช่น GC DEC26" },
        auto_extract: { type: Type.BOOLEAN },
        daily_digest: { type: Type.BOOLEAN },
        incomplete_reminder: { type: Type.BOOLEAN },
        enable_slots: { type: Type.ARRAY, items: { type: Type.STRING, enum: SLOTS.map((s) => s.id) } },
        disable_slots: { type: Type.ARRAY, items: { type: Type.STRING, enum: SLOTS.map((s) => s.id) } },
      },
      required: [],
    },
  },
  {
    name: "delete_data",
    description:
      "ลบข้อมูลวิจัยถาวร ถ้าไม่ส่ง confirm=true จะแค่คืนจำนวนที่จะถูกลบ ให้เอาไปถามผู้ใช้ยืนยันก่อน แล้วเรียกซ้ำพร้อม confirm=true",
    parameters: {
      type: Type.OBJECT,
      properties: {
        scope: {
          type: Type.STRING,
          enum: ["image", "slot", "day", "everything"],
          description: "image (date,slot,kind) | slot (date,slot) | day (date) | everything",
        },
        date: { type: Type.STRING, description: "วันที่ YYYY-MM-DD" },
        slot: { type: Type.STRING, enum: SLOTS.map((s) => s.id) },
        kind: { type: Type.STRING, enum: IMAGE_KINDS as unknown as string[] },
        confirm: { type: Type.BOOLEAN, description: "true ต่อเมื่อผู้ใช้ยืนยันแล้ว" },
        confirm_phrase: { type: Type.STRING, description: 'scope=everything เท่านั้น: ต้องเป็น "ลบข้อมูลวิจัยทั้งหมด"' },
      },
      required: ["scope"],
    },
  },
];

const GEMINI_TOOLS = [
  {
    functionDeclarations: GEMINI_FUNCTION_DECLARATIONS,
  },
];

/** One image the user attached to the chat turn, available to `save_shot`. */
export type ChatAttachment = { buffer: Buffer; mime: string; originalname: string };

type ToolSideEffect =
  | { type: "note-saved"; date: string; slot: SlotId }
  | { type: "shot-saved"; date: string; slot: SlotId; kind: ImageKind }
  | { type: "metrics-saved"; date: string; slot: SlotId }
  | { type: "data-changed"; date?: string; slot?: SlotId }
  | { type: "settings-changed" };

type ToolOutcome = { result: unknown; sideEffect?: ToolSideEffect | ToolSideEffect[] };

/**
 * Per-run bookkeeping that makes "never guess the year" enforceable instead of
 * merely requested. A prompt rule is advice a model can drop; this is a gate.
 *
 * When the turn carries screenshots, any write has to name a date that
 * `resolve_date` returned cleanly during this same run. A date the model
 * invented — almost always today's year pasted onto the day/month it read off a
 * status bar — is refused, and the refusal tells it what to do instead.
 */
export type RunGuard = {
  /** Dates resolve_date returned this run, mapped to its warning if any. */
  resolved: Map<string, string | undefined>;
  fromImages: boolean;
};

const WRITES_A_DATE = new Set(["save_note", "save_shot", "save_metrics", "save_news"]);

/** Exported for tests — the gate is the safety property worth pinning down. */
export function guardDate(guard: RunGuard, name: string, date: string): string | null {
  if (!guard.fromImages || !WRITES_A_DATE.has(name)) return null;
  if (!guard.resolved.has(date)) {
    return `ยังไม่ได้ยืนยันปีของวันที่ ${date} — ต้องเรียก resolve_date ด้วย month/day/weekday ที่อ่านได้จากภาพก่อน แล้วใช้ค่า date ที่มันคืนมาเท่านั้น ห้ามเติมปีเอง`;
  }
  const warning = guard.resolved.get(date);
  if (warning) {
    return `resolve_date เตือนไว้ว่า "${warning}" — ห้ามบันทึก ให้ถามผู้ใช้ยืนยันปีก่อน`;
  }
  return null;
}

function runTool(
  userId: string,
  name: string,
  input: Record<string, unknown>,
  attachments: ChatAttachment[],
  guard: RunGuard,
): ToolOutcome {
  // save_news carries its dates inside days[], so it is checked in its own case.
  if (WRITES_A_DATE.has(name) && name !== "save_news") {
    const blocked = guardDate(guard, name, String(input.date ?? ""));
    if (blocked) return { result: { error: blocked } };
  }

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
    case "resolve_date": {
      const month = Number(input.month);
      const day = Number(input.day);
      const weekday = input.weekday ? String(input.weekday) : undefined;
      const year = input.year ? Number(input.year) : undefined;
      if (!Number.isFinite(month) || !Number.isFinite(day)) {
        return { result: { error: "ต้องระบุ month และ day เป็นตัวเลข" } };
      }
      const r = resolveScreenshotDate({ month, day, weekday, year });
      // Remember what came back so the write tools can check the date they are
      // handed actually came from here.
      if (r.date) guard.resolved.set(r.date, r.warning);
      return {
        result: r.date
          ? { date: r.date, weekday: r.weekday, ...(r.warning ? { warning: r.warning } : {}) }
          : { error: r.warning ?? "แปลงวันที่ไม่สำเร็จ" },
      };
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
    case "save_shot": {
      const date = String(input.date ?? "");
      const slotRaw = String(input.slot ?? "");
      const kindRaw = String(input.kind ?? "");
      if (!isDateString(date)) return { result: { error: "วันที่ไม่ถูกต้อง ต้องเป็น YYYY-MM-DD" } };
      if (!isSlotId(slotRaw)) return { result: { error: "ช่วงเวลาไม่ถูกต้อง" } };
      if (!isImageKind(kindRaw)) return { result: { error: "ชนิดภาพไม่ถูกต้อง" } };
      const index = Number(input.index ?? 1);
      const file = attachments[index - 1];
      if (!file) {
        return { result: { error: `ไม่พบภาพลำดับที่ ${index} — มีภาพแนบมา ${attachments.length} ภาพ` } };
      }
      const image = storeImage(userId, date, slotRaw, kindRaw, {
        buffer: file.buffer,
        mimetype: file.mime,
        originalname: file.originalname,
      });
      return {
        result: { saved: true, date, slot: slotRaw, kind: kindRaw, imageId: image.id },
        sideEffect: { type: "shot-saved", date, slot: slotRaw, kind: kindRaw },
      };
    }
    case "save_metrics": {
      const date = String(input.date ?? "");
      const slotRaw = String(input.slot ?? "");
      if (!isDateString(date)) return { result: { error: "วันที่ไม่ถูกต้อง ต้องเป็น YYYY-MM-DD" } };
      if (!isSlotId(slotRaw)) return { result: { error: "ช่วงเวลาไม่ถูกต้อง" } };

      // The model may omit a field or send null for anything it could not read;
      // both must land as null rather than NaN so the charts skip the point. It
      // also sometimes sends a figure it read verbatim ("+12,450"), so strip
      // grouping commas and a leading + before parsing.
      const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const cleaned = typeof v === "string" ? v.replace(/,/g, "").replace(/^\+/, "").trim() : v;
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
      };
      // `extractedFrom` must describe the shots actually on file for the slot,
      // not whatever an earlier extraction happened to leave behind.
      const slotRow = getDay(userId, date).slots.find((s) => s.slot === slotRaw)!;
      const metrics = {
        priceClose: num(input.price_close),
        intradayPut: num(input.intraday_put),
        intradayCall: num(input.intraday_call),
        vol: num(input.vol),
        volChg: num(input.volume_change),
        futureChg: num(input.future_change),
        callOi: num(input.call_oi),
        putOi: num(input.put_oi),
        pcRatio: num(input.pc_ratio),
        callOiChg: num(input.call_oi_chg),
        putOiChg: num(input.put_oi_chg),
        oiChgTotal: num(input.oi_chg_total),
        summary: String(input.summary ?? "").trim() || null,
        extractedAt: new Date().toISOString(),
        extractedFrom: Object.keys(slotRow.images) as ImageKind[],
      };
      saveEntry(userId, date, slotRaw, { metrics });
      return {
        result: { saved: true, date, slot: slotRaw, metrics },
        sideEffect: { type: "metrics-saved", date, slot: slotRaw },
      };
    }
    case "save_news": {
      const daysIn = Array.isArray(input.days) ? input.days : [];
      const saved: Array<{ date: string; count: number }> = [];
      const effects: ToolSideEffect[] = [];
      const str = (v: unknown) => {
        const s = String(v ?? "").trim();
        return s || undefined;
      };
      // Every date in the batch has to have been through resolve_date, or the
      // whole call is refused — a half-written week is worse than none.
      const unverified: string[] = [];
      for (const d of daysIn as Array<Record<string, unknown>>) {
        const date = String(d?.date ?? "");
        if (!isDateString(date)) continue;
        const blocked = guardDate(guard, "save_news", date);
        if (blocked) unverified.push(`${date}: ${blocked}`);
      }
      const wsPreDate = String((input.week_summary as Record<string, unknown> | undefined)?.date ?? "");
      if (isDateString(wsPreDate)) {
        const blocked = guardDate(guard, "save_news", wsPreDate);
        if (blocked) unverified.push(`${wsPreDate}: ${blocked}`);
      }
      if (unverified.length) return { result: { error: unverified.join(" | ") } };

      for (const d of daysIn as Array<Record<string, unknown>>) {
        const date = String(d?.date ?? "");
        if (!isDateString(date)) continue;
        const rawEvents = Array.isArray(d?.events) ? (d.events as Array<Record<string, unknown>>) : [];
        const events = rawEvents
          .map((e) => ({
            time: str(e?.time),
            currency: str(e?.currency),
            title: String(e?.title ?? "").trim(),
            actual: str(e?.actual),
            forecast: str(e?.forecast),
            previous: str(e?.previous),
            holiday: e?.holiday === true || undefined,
          }))
          .filter((e) => e.title);
        if (!events.length) continue;
        saveDayNews(userId, date, { events });
        saved.push({ date, count: events.length });
        effects.push({ type: "data-changed", date });
      }
      let week: { date: string } | null = null;
      const ws = input.week_summary as Record<string, unknown> | undefined;
      const wsDate = String(ws?.date ?? "");
      const wsText = String(ws?.text ?? "").trim();
      if (ws && isDateString(wsDate) && wsText) {
        saveDayNews(userId, wsDate, { weekSummary: wsText });
        week = { date: wsDate };
        effects.push({ type: "data-changed", date: wsDate });
      }
      if (!saved.length && !week) {
        return { result: { error: "ไม่มีข่าวแดงหรือวันหยุดให้บันทึก" } };
      }
      return { result: { saved, week }, sideEffect: effects };
    }
    case "list_days": {
      const dates = listDataDates(userId);
      return { result: { count: dates.length, dates } };
    }
    case "get_settings": {
      const s = getUser(userId)?.settings;
      if (!s) return { result: { error: "อ่านการตั้งค่าไม่สำเร็จ" } };
      return {
        result: {
          contract: s.contract,
          autoExtract: s.autoExtract,
          dailyDigest: s.dailyDigest,
          incompleteReminder: s.incompleteReminder,
          slots: SLOTS.map((d) => ({ id: d.id, label: d.th, enabled: s.slots[d.id].enabled })),
        },
      };
    }
    case "edit_note": {
      const date = String(input.date ?? "");
      const slotRaw = String(input.slot ?? "");
      if (!isDateString(date)) return { result: { error: "วันที่ไม่ถูกต้อง ต้องเป็น YYYY-MM-DD" } };
      if (!isSlotId(slotRaw)) return { result: { error: "ช่วงเวลาไม่ถูกต้อง" } };
      const text = String(input.text ?? "").trim();
      if (!text) return { result: { error: "ข้อความว่าง" } };
      const entry =
        input.replace === true
          ? saveEntry(userId, date, slotRaw, { note: text })
          : appendNote(userId, date, slotRaw, text);
      return {
        result: { saved: true, date, slot: slotRaw, note: entry.note, replaced: input.replace === true },
        sideEffect: { type: "note-saved", date, slot: slotRaw },
      };
    }
    case "set_tags": {
      const date = String(input.date ?? "");
      const slotRaw = String(input.slot ?? "");
      if (!isDateString(date)) return { result: { error: "วันที่ไม่ถูกต้อง ต้องเป็น YYYY-MM-DD" } };
      if (!isSlotId(slotRaw)) return { result: { error: "ช่วงเวลาไม่ถูกต้อง" } };
      const tags = Array.isArray(input.tags)
        ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20)
        : [];
      const entry = saveEntry(userId, date, slotRaw, { tags });
      return {
        result: { saved: true, date, slot: slotRaw, tags: entry.tags },
        sideEffect: { type: "note-saved", date, slot: slotRaw },
      };
    }
    case "update_settings": {
      const user = getUser(userId);
      if (!user) return { result: { error: "ไม่พบผู้ใช้" } };
      const next = { ...user.settings, slots: { ...user.settings.slots } };
      const changed: string[] = [];
      if (typeof input.contract === "string" && input.contract.trim()) {
        next.contract = input.contract.trim().slice(0, 40);
        changed.push(`contract → ${next.contract}`);
      }
      for (const [key, field] of [
        ["auto_extract", "autoExtract"],
        ["daily_digest", "dailyDigest"],
        ["incomplete_reminder", "incompleteReminder"],
      ] as const) {
        if (typeof input[key] === "boolean") {
          (next as Record<string, unknown>)[field] = input[key];
          changed.push(`${field} → ${input[key]}`);
        }
      }
      const toList = (v: unknown) =>
        Array.isArray(v) ? v.map(String).filter((s): s is SlotId => isSlotId(s)) : [];
      for (const id of toList(input.enable_slots)) {
        next.slots[id] = { ...next.slots[id], enabled: true };
        changed.push(`เปิด ${id}`);
      }
      for (const id of toList(input.disable_slots)) {
        next.slots[id] = { ...next.slots[id], enabled: false };
        changed.push(`ปิด ${id}`);
      }
      if (changed.length === 0) return { result: { error: "ไม่มีอะไรให้เปลี่ยน" } };
      updateSettings(userId, next);
      return { result: { saved: true, changed }, sideEffect: { type: "settings-changed" } };
    }
    case "delete_data": {
      const scope = String(input.scope ?? "");
      const date = String(input.date ?? "");
      const slotRaw = String(input.slot ?? "");
      const kindRaw = String(input.kind ?? "");
      const confirmed = input.confirm === true;

      if (scope === "image") {
        if (!isDateString(date) || !isSlotId(slotRaw) || !isImageKind(kindRaw)) {
          return { result: { error: "ต้องระบุ date, slot และ kind ให้ถูกต้องสำหรับการลบภาพ" } };
        }
        const exists = Boolean(getDay(userId, date).slots.find((s) => s.slot === slotRaw)?.images[kindRaw]);
        if (!exists) return { result: { error: `ไม่มีภาพ ${kindRaw} ของ ${date} ช่วง ${slotRaw}` } };
        if (!confirmed) {
          return {
            result: {
              pending: true,
              willDelete: { scope, date, slot: slotRaw, kind: kindRaw, images: 1 },
              note: "ยังไม่ได้ลบ — ถามผู้ใช้ยืนยัน แล้วเรียก delete_data ซ้ำพร้อม confirm=true",
            },
          };
        }
        deleteImageAt(userId, date, slotRaw, kindRaw);
        return {
          result: { deleted: true, scope, date, slot: slotRaw, kind: kindRaw },
          sideEffect: { type: "data-changed", date, slot: slotRaw },
        };
      }

      if (scope === "slot") {
        if (!isDateString(date) || !isSlotId(slotRaw)) {
          return { result: { error: "ต้องระบุ date และ slot ให้ถูกต้อง" } };
        }
        const fp = slotFootprint(userId, date, slotRaw);
        if (!confirmed) {
          return {
            result: {
              pending: true,
              willDelete: { scope, date, slot: slotRaw, ...fp },
              note: "ยังไม่ได้ลบ — ถามผู้ใช้ยืนยัน แล้วเรียกซ้ำพร้อม confirm=true",
            },
          };
        }
        const { images } = clearSlot(userId, date, slotRaw, { images: true });
        return {
          result: { deleted: true, scope, date, slot: slotRaw, imagesRemoved: images },
          sideEffect: { type: "data-changed", date, slot: slotRaw },
        };
      }

      if (scope === "day") {
        if (!isDateString(date)) return { result: { error: "ต้องระบุ date ให้ถูกต้อง" } };
        const fp = dayFootprint(userId, date);
        if (!confirmed) {
          return {
            result: {
              pending: true,
              willDelete: { scope, date, ...fp },
              note: "ยังไม่ได้ลบ — ถามผู้ใช้ยืนยัน แล้วเรียกซ้ำพร้อม confirm=true",
            },
          };
        }
        const res = deleteDay(userId, date);
        return {
          result: { deleted: true, scope, date, ...res },
          sideEffect: { type: "data-changed", date },
        };
      }

      if (scope === "everything") {
        const fp = dataFootprint(userId);
        // A full wipe needs both flags — an accidental `confirm:true` alone
        // cannot trigger it.
        const phraseOk = String(input.confirm_phrase ?? "").trim() === "ลบข้อมูลวิจัยทั้งหมด";
        if (!confirmed || !phraseOk) {
          return {
            result: {
              pending: true,
              willDelete: { scope, ...fp },
              note: "นี่คือการลบข้อมูลวิจัยทั้งหมดถาวร — บอกผู้ใช้ให้ชัดว่าจะลบกี่วัน กี่โน้ต กี่ภาพ แล้วขอคำยืนยัน หลังผู้ใช้ยืนยันในแชตแล้ว จึงเรียกซ้ำด้วย confirm=true และ confirm_phrase=\"ลบข้อมูลวิจัยทั้งหมด\" (โน้ตในแชตจะไม่ถูกลบ)",
            },
          };
        }
        const res = deleteAllData(userId);
        return { result: { deleted: true, scope, ...res }, sideEffect: { type: "data-changed" } };
      }

      return { result: { error: `scope ไม่ถูกต้อง: ${scope}` } };
    }
    default:
      return { result: { error: `unknown tool ${name}` } };
  }
}

/** What model answered, how long it took, and what it cost — shown under the reply. */
export type ChatStats = {
  provider: AiProvider;
  model: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  /** Reasoning tokens, when the model reports them separately (billed as output). */
  thinkingTokens: number;
  /** Prompt tokens served from cache rather than reprocessed. */
  cachedTokens: number;
};

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "note-saved"; date: string; slot: SlotId }
  | { type: "shot-saved"; date: string; slot: SlotId; kind: ImageKind }
  | { type: "metrics-saved"; date: string; slot: SlotId }
  | { type: "data-changed"; date?: string; slot?: SlotId }
  | { type: "settings-changed" }
  | { type: "done"; text: string; stats: ChatStats }
  | { type: "error"; message: string };

export type ChatContext = {
  /** The day the user is currently looking at, so relative questions resolve. */
  date?: string;
  slot?: SlotId;
  /** Images attached to this turn; `save_shot` addresses them by 1-based index. */
  attachments?: ChatAttachment[];
};

/**
 * Runs the research assistant to completion, yielding SSE-ready events. Tool
 * calls are executed between turns; the loop ends when the model finishes.
 */
/** Tool-loop budget. Reached only when the model keeps calling tools forever. */
const MAX_TURNS = 8;

/** Extra attempts per turn, used only before any text has been streamed out. */
const RETRIES = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Exponential backoff with jitter, so stalled turns don't retry in lockstep. */
const backoffMs = (attempt: number) => Math.round(700 * 2 ** attempt * (0.75 + Math.random() * 0.5));

/**
 * Text to save when the loop hits its budget with the model still working.
 * Falling through silently used to leave the user with a blank or half reply and
 * nothing explaining why.
 */
function exhausted(text: string): string {
  const notice =
    "⚠️ ทำงานหลายขั้นตอนเกินกำหนดแล้วยังไม่จบ — หยุดไว้ก่อนเพื่อไม่ให้วนไปเรื่อย ๆ ลองถามใหม่โดยแบ่งเป็นคำถามย่อย หรือระบุวัน/ช่วงเวลาให้ชัดขึ้น";
  return text.trim() ? `${text}\n\n${notice}` : notice;
}

export async function* streamChat(
  userId: string,
  history: Array<{ role: string; content: string | any }>,
  context: ChatContext,
): AsyncGenerator<ChatEvent> {
  const provider = getAiProvider();
  const attachments = context.attachments ?? [];
  const startedAt = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 };
  const statsFor = (): ChatStats => ({
    provider,
    model: provider === "gemini" ? GEMINI_MODEL : MODEL,
    ms: Date.now() - startedAt,
    ...usage,
  });
  const guard: RunGuard = { resolved: new Map(), fromImages: attachments.length > 0 };
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const contextLines = [
    `วันนี้คือ ${today} (${THAI_WEEKDAYS[now.getDay()]})`,
    context.date ? `ผู้ใช้กำลังดูบันทึกของวันที่ ${context.date}` : null,
    context.slot ? `ช่วงเวลาที่เปิดอยู่คือ ${context.slot}` : null,
    attachments.length
      ? `ข้อความล่าสุดมีภาพแนบมา ${attachments.length} ภาพ (ลำดับที่ 1–${attachments.length}) — อ่านวัน/เดือน/วันในสัปดาห์จากในภาพ แล้วเรียก resolve_date ให้ได้วันที่ YYYY-MM-DD ก่อนบันทึก อย่าเดาปีเอง`
      : null,
  ].filter(Boolean);

  const systemInstruction = `${SYSTEM}\n\nบริบทปัจจุบัน:\n${contextLines.join("\n")}`;

  if (provider === "gemini") {
    const gemini = getGemini();
    const contents: any[] = history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: typeof m.content === "string" ? [{ text: m.content }] : m.content,
    }));
    // Attachments belong to the turn being sent now, so they ride along with the
    // last user message rather than being persisted into the stored transcript.
    if (attachments.length && contents.length) {
      const last = contents[contents.length - 1];
      attachments.forEach((file, i) => {
        last.parts.push({ text: `ภาพลำดับที่ ${i + 1}:` });
        last.parts.push({ inlineData: { mimeType: file.mime, data: file.buffer.toString("base64") } });
      });
    }

    let finalText = "";

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      // Stream so text reaches the browser as it is produced, matching the
      // Anthropic path — a whole turn arriving at once reads as a long stall.
      // A turn is only retried before any of its text has been emitted, so a
      // retry can never duplicate output the user already saw.
      const modelParts: any[] = [];
      const functionCalls: any[] = [];
      let turnText = "";
      let lastUsage: any = null;

      // Text is emitted as it arrives — buffering the turn to make it retryable
      // would mean the user stares at "กำลังคิด…" until the whole answer is
      // ready. Instead a turn is retried only while nothing has gone out yet,
      // which covers the failures that actually matter (connect / rate-limit at
      // request time) without ever repeating text already on screen.
      for (let attempt = 0; ; attempt += 1) {
        let emitted = false;
        try {
          const stream = await gemini.models.generateContentStream({
            model: GEMINI_MODEL,
            contents,
            config: {
              systemInstruction,
              tools: GEMINI_TOOLS,
              thinkingConfig: { thinkingBudget: 0 },
            },
          });
          for await (const chunk of stream) {
            for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
              modelParts.push(part);
              if (part.text) {
                emitted = true;
                turnText += part.text;
                yield { type: "text", text: part.text };
              }
              if (part.functionCall) functionCalls.push(part.functionCall);
            }
            if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
          }
          break;
        } catch (error) {
          if (emitted || attempt >= RETRIES || !isTransientAiError(error)) throw error;
          modelParts.length = 0;
          functionCalls.length = 0;
          turnText = "";
          await sleep(backoffMs(attempt));
        }
      }

      // Gemini repeats running totals on each chunk, so take the turn's last
      // reading and add that to the run total (a tool loop spans many turns).
      if (lastUsage) {
        usage.inputTokens += lastUsage.promptTokenCount ?? 0;
        usage.outputTokens += lastUsage.candidatesTokenCount ?? 0;
        usage.thinkingTokens += lastUsage.thoughtsTokenCount ?? 0;
        usage.cachedTokens += lastUsage.cachedContentTokenCount ?? 0;
      }

      if (turnText) finalText += turnText;
      contents.push({ role: "model", parts: modelParts });

      if (functionCalls.length === 0) {
        yield { type: "done", text: finalText, stats: statsFor() };
        return;
      }

      const functionResponseParts: any[] = [];
      for (const fc of functionCalls) {
        yield { type: "tool", name: fc.name };
        try {
          const outcome = runTool(userId, fc.name, fc.args as Record<string, unknown>, attachments, guard);
          if (outcome.sideEffect) for (const se of ([] as ToolSideEffect[]).concat(outcome.sideEffect)) yield se;
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

    yield { type: "done", text: exhausted(finalText), stats: statsFor() };
    return;
  }

  // Anthropic fallback
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
  // Attachments belong to the turn being sent now, so they ride along with the
  // last user message rather than being persisted into the stored transcript.
  if (attachments.length && messages.length) {
    const last = messages[messages.length - 1];
    const blocks: Anthropic.ContentBlockParam[] =
      typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
    attachments.forEach((file, i) => {
      blocks.push({ type: "text", text: `ภาพลำดับที่ ${i + 1}:` });
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: file.mime as "image/png", data: file.buffer.toString("base64") },
      });
    });
    last.content = blocks;
  }

  let finalText = "";

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    // Stream deltas straight through, and retry only while nothing has been
    // emitted for this turn — see the Gemini path above for why.
    let turnText = "";
    let message!: Anthropic.Message;
    for (let attempt = 0; ; attempt += 1) {
      let emitted = false;
      try {
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
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            emitted = true;
            turnText += event.delta.text;
            yield { type: "text", text: event.delta.text };
          }
        }
        message = await stream.finalMessage();
        break;
      } catch (error) {
        if (emitted || attempt >= RETRIES || !isTransientAiError(error)) throw error;
        turnText = "";
        await sleep(backoffMs(attempt));
      }
    }

    messages.push({ role: "assistant", content: message.content });
    // Accumulate: a tool loop emits text across several turns and the client
    // has been concatenating all of it, so the saved transcript must match.
    // This used to assign, dropping everything said before the last tool call.
    if (turnText) finalText += finalText ? `\n\n${turnText}` : turnText;

    // Usage is per-request, so a tool-use loop reports it once per turn — sum it.
    const u = message.usage;
    usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.outputTokens += u.output_tokens ?? 0;
    usage.cachedTokens += u.cache_read_input_tokens ?? 0;

    if (message.stop_reason === "refusal") {
      yield { type: "error", message: "ผู้ช่วยไม่สามารถตอบคำถามนี้ได้" };
      return;
    }

    if (message.stop_reason !== "tool_use") {
      yield { type: "done", text: finalText, stats: statsFor() };
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      yield { type: "tool", name: block.name };
      try {
        const outcome = runTool(userId, block.name, block.input as Record<string, unknown>, attachments, guard);
        if (outcome.sideEffect) for (const se of ([] as ToolSideEffect[]).concat(outcome.sideEffect)) yield se;
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

  yield { type: "done", text: exhausted(finalText), stats: statsFor() };
}
