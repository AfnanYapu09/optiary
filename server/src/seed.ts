/**
 * Loads the QuikStrike sample screenshots shipped with the design handoff into
 * a demo account, so a fresh checkout shows the app populated the way the
 * mockups do. Safe to re-run: it replaces the demo user's data each time.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { upsertLocalUser } from "./auth.js";
import { storeImage, saveEntry } from "./store.js";
import { IMAGE_KINDS, SLOTS, type ImageKind, type Metrics, type SlotId } from "./domain.js";

const shotsDir = path.resolve(process.cwd(), "../design/project/shots");

const DEMO_EMAIL = process.env.SEED_EMAIL ?? "demo@optiary.local";
const DEMO_NAME = process.env.SEED_NAME ?? "ธนกฤต ว.";

type SlotPlan = {
  slot: SlotId;
  kinds: ImageKind[];
  /** Which capture day's screenshot to use, so consecutive slots aren't identical. */
  source: "27" | "28";
  note?: string;
  tags?: string[];
  metrics?: Metrics;
};

type DayPlan = { date: string; slots: SlotPlan[] };

function full(slot: SlotId, source: "27" | "28", extra: Partial<SlotPlan> = {}): SlotPlan {
  return { slot, kinds: [...IMAGE_KINDS], source, ...extra };
}

const PLAN: DayPlan[] = [
  {
    date: "2026-08-25",
    slots: [
      full("morning", "27", { metrics: m(3396.2, 168400, 181900, -520, 1.08) }),
      full("afternoon", "27", { metrics: m(3401.8, 170100, 183200, 640, 1.08) }),
      full("evening", "27", { metrics: m(3398.4, 171900, 184600, 810, 1.07) }),
      full("night", "27", {
        note: "ราคาแกว่งในกรอบแคบตลอดช่วง แรงซื้อฝั่ง Put ยังนำ · Call OI +680 · Put OI +920",
        tags: ["#range-bound", "#put-heavy"],
        metrics: m(3399.1, 172580, 186_400, 1600, 1.08),
      }),
      full("latenight", "27", { metrics: m(3402.5, 173100, 186900, 1020, 1.08) }),
    ],
  },
  {
    date: "2026-08-26",
    slots: [
      full("morning", "28", { metrics: m(3405.0, 174200, 186100, 410, 1.07) }),
      full("afternoon", "28", { metrics: m(3409.6, 175800, 185400, -210, 1.05) }),
      full("evening", "27", { metrics: m(3407.2, 176900, 184900, -180, 1.05) }),
      full("night", "28", {
        note: "คืนเดียวในสัปดาห์ที่ OI สวนทาง — ลดลง 410 สัญญา ขณะที่ราคายืนได้",
        tags: ["#oi-drop"],
        metrics: m(3411.4, 177600, 184200, -410, 1.04),
      }),
      // The late-night capture was missed, which is what the grid's NO DATA cell shows.
      { slot: "latenight", kinds: [], source: "28" },
    ],
  },
  {
    date: "2026-08-27",
    slots: [
      full("morning", "27", { metrics: m(3413.8, 178900, 183800, 320, 1.03) }),
      full("afternoon", "27", { metrics: m(3418.2, 180200, 182600, 740, 1.01) }),
      full("evening", "28", { metrics: m(3421.6, 181500, 181100, 960, 1.0) }),
      full("night", "27", {
        note: "โครงสร้างเริ่มพลิก Call OI ไล่ขึ้นเหนือ 3450 เป็นครั้งแรกของสัปดาห์",
        tags: ["#call-buildup"],
        metrics: m(3424.0, 182400, 179800, 1480, 0.99),
      }),
      full("latenight", "28", { metrics: m(3425.2, 182900, 178600, 620, 0.98) }),
    ],
  },
  {
    date: "2026-08-28",
    slots: [
      full("morning", "28", { metrics: m(3419.4, 182600, 178200, 380, 0.98) }),
      full("afternoon", "28", { metrics: m(3423.1, 183200, 177600, 520, 0.97) }),
      full("evening", "27", { metrics: m(3426.8, 183700, 177300, 690, 0.97) }),
      {
        slot: "night",
        // OI Chg for this slot is deliberately missing — it is the empty
        // drop-target the capture screen uses to show the "waiting" state.
        kinds: ["intraday", "oi"],
        source: "28",
        note: "ราคายืนเหนือ 3,412 ตลอดช่วง แรงขายเบาลงหลัง 20:30 · OI Call 3450 เพิ่ม +1,820 สัญญา ขณะที่ Put 3400 ลดลง −640 → โครงสร้างเอียงขึ้นอ่อน ๆ",
        tags: ["#call-buildup", "#range-bound"],
        metrics: m(3428.4, 184220, 176940, 1180, 0.96),
      },
      { slot: "latenight", kinds: ["intraday"], source: "28" },
    ],
  },
  {
    date: "2026-08-29",
    slots: [
      full("morning", "27", { metrics: m(3430.2, 184900, 176400, 340, 0.95) }),
      full("afternoon", "28", { metrics: m(3433.6, 185600, 175900, 480, 0.95) }),
      full("evening", "27", { metrics: m(3431.9, 186100, 175600, 260, 0.94) }),
      full("night", "28", { metrics: m(3435.4, 187000, 175100, 1290, 0.94) }),
      full("latenight", "27", { metrics: m(3436.8, 187400, 174800, 400, 0.93) }),
    ],
  },
  {
    date: "2026-08-30",
    slots: [
      full("morning", "28", { metrics: m(3438.1, 187900, 174500, 420, 0.93) }),
      full("afternoon", "27", { metrics: m(3441.7, 188600, 174100, 610, 0.92) }),
      full("evening", "28", {
        note: "ช่วงเย็นเงียบ ปริมาณบางกว่าปกติ · รอดูช่วงค่ำว่าจะมี Call buildup ต่อไหม",
        tags: ["#thin-volume"],
        metrics: m(3440.3, 189100, 173900, 380, 0.92),
      }),
      // Evening is the last captured slot: "ค่ำ" is the one still waiting.
      { slot: "night", kinds: [], source: "28" },
      { slot: "latenight", kinds: [], source: "28" },
    ],
  },
];

function m(
  priceClose: number,
  callOi: number,
  putOi: number,
  oiChgTotal: number,
  pcRatio: number,
): Metrics {
  return {
    priceClose,
    callOi,
    putOi,
    oiChgTotal,
    pcRatio,
    summary: null,
    extractedAt: new Date().toISOString(),
    extractedFrom: [...IMAGE_KINDS],
  };
}

function shotFile(kind: ImageKind, source: "27" | "28"): string {
  const base = kind === "oichg" ? "oichg" : kind;
  return path.join(shotsDir, `${base}${source}-lg.png`);
}

function main(): void {
  if (!fs.existsSync(shotsDir)) {
    console.error(`sample screenshots not found at ${shotsDir}`);
    process.exit(1);
  }

  const user = upsertLocalUser(DEMO_EMAIL, DEMO_NAME);
  db.prepare("DELETE FROM images WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM entries WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM messages WHERE user_id = ?").run(user.id);

  let images = 0;
  for (const day of PLAN) {
    for (const plan of day.slots) {
      for (const kind of plan.kinds) {
        const file = shotFile(kind, plan.source);
        storeImage(user.id, day.date, plan.slot, kind, {
          buffer: fs.readFileSync(file),
          mimetype: "image/png",
          originalname: path.basename(file),
        });
        images += 1;
      }
      if (plan.note || plan.tags || plan.metrics) {
        saveEntry(user.id, day.date, plan.slot, {
          note: plan.note,
          tags: plan.tags,
          metrics: plan.metrics,
        });
      }
    }
  }

  console.log(
    `seeded ${images} images across ${PLAN.length} days for ${user.email} (${SLOTS.length} slots/day)`,
  );
}

main();
