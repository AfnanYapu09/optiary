/**
 * The five daily capture windows the research workflow is built around, and the
 * three screenshots collected in each of them. Thai labels are the primary UI
 * labels; the ids are stable and never localised.
 */

export const SLOT_IDS = ["morning", "afternoon", "evening", "night", "latenight"] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const IMAGE_KINDS = ["intraday", "oi", "oichg"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export type SlotDef = {
  id: SlotId;
  th: string;
  en: string;
  from: string;
  to: string;
  remind: string;
};

export const SLOTS: SlotDef[] = [
  { id: "morning", th: "เช้า", en: "MORNING", from: "06:00", to: "11:00", remind: "06:15" },
  { id: "afternoon", th: "บ่าย", en: "AFTERNOON", from: "11:00", to: "15:00", remind: "11:15" },
  { id: "evening", th: "เย็น", en: "EVENING", from: "15:00", to: "19:00", remind: "15:15" },
  { id: "night", th: "ค่ำ", en: "NIGHT", from: "19:00", to: "23:00", remind: "19:15" },
  { id: "latenight", th: "ดึก", en: "LATE NIGHT", from: "23:00", to: "03:00", remind: "23:15" },
];

export const IMAGE_KIND_LABELS: Record<ImageKind, string> = {
  intraday: "Intraday",
  oi: "OI",
  oichg: "OI Chg",
};

export function isSlotId(v: string): v is SlotId {
  return (SLOT_IDS as readonly string[]).includes(v);
}

export function isImageKind(v: string): v is ImageKind {
  return (IMAGE_KINDS as readonly string[]).includes(v);
}

/**
 * Two screenshots that belong to the day as a whole rather than to a capture
 * window: the intraday chart as it stood just before the day's news, and the
 * reveal — how it actually resolved.
 *
 * They live in the same table as the slot shots under a reserved slot id, so
 * uploading, serving and deleting an image stays one code path. The price is
 * that anything counting a day's progress toward its 15 shots has to skip them,
 * or a day would look complete without them and incomplete with them.
 */
export const DAY_SLOT = "day";

export const DAY_IMAGE_KINDS = ["prenews", "reveal"] as const;
export type DayImageKind = (typeof DAY_IMAGE_KINDS)[number];

export const DAY_IMAGE_KIND_LABELS: Record<DayImageKind, string> = {
  prenews: "Intraday ก่อนข่าว",
  reveal: "เฉลยกราฟ",
};

export function isDayImageKind(v: string): v is DayImageKind {
  return (DAY_IMAGE_KINDS as readonly string[]).includes(v);
}

/** Whether the session behaved as short or long gamma. */
export const GAMMA_REGIMES = ["short", "long"] as const;
export type GammaRegime = (typeof GAMMA_REGIMES)[number];

export function isGammaRegime(v: string): v is GammaRegime {
  return (GAMMA_REGIMES as readonly string[]).includes(v);
}

export const GAMMA_LABELS: Record<GammaRegime, string> = {
  short: "Short gamma",
  long: "Long gamma",
};

/** Day-level judgements that sit alongside the news for a date. */
export type DayMarks = {
  gamma: GammaRegime | null;
  /**
   * `ai` while the reading is only the assistant's suggestion, `user` once a
   * person has confirmed or overridden it. The UI leans on this to show a
   * proposal differently from a decision, and the assistant will not overwrite
   * a call the user has already made.
   */
  gammaSource: "ai" | "user" | null;
  /** What the reveal chart shows — the day's lesson, in a line or two. */
  revealNote: string;
};

/** `YYYY-MM-DD`, rejecting anything that could escape a path or a query. */
export function isDateString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

export type Metrics = {
  /** From the Intraday Volume chart header (Put / Call / Vol / Vol Chg / Future Chg). */
  priceClose?: number | null;
  intradayPut?: number | null;
  intradayCall?: number | null;
  vol?: number | null;
  volChg?: number | null;
  futureChg?: number | null;
  /** From the OI table — totals across every strike. */
  callOi?: number | null;
  putOi?: number | null;
  pcRatio?: number | null;
  /** From the OI Chg table — net change totals for the session. */
  callOiChg?: number | null;
  putOiChg?: number | null;
  oiChgTotal?: number | null;
  /** Free-form observations the model pulled off the chart. */
  summary?: string | null;
  extractedAt?: string | null;
  extractedFrom?: ImageKind[];
};

/** One high-impact (red-folder) economic event, or a holiday, for a day. */
export type NewsEvent = {
  time?: string;
  currency?: string;
  title: string;
  actual?: string;
  forecast?: string;
  previous?: string;
  /** true for holidays / all-day items rather than a scheduled release. */
  holiday?: boolean;
};

export type DayNews = {
  events: NewsEvent[];
  /** "Strongest news of the week" note, stored on the week's anchor date. */
  weekSummary: string;
};

export type UserSettings = {
  slots: Record<SlotId, { from: string; to: string; remind: string; enabled: boolean }>;
  autoExtract: boolean;
  dailyDigest: boolean;
  incompleteReminder: boolean;
  contributeToModel: boolean;
  contract: string;
};

export function defaultSettings(): UserSettings {
  const slots = {} as UserSettings["slots"];
  for (const s of SLOTS) {
    slots[s.id] = { from: s.from, to: s.to, remind: s.remind, enabled: s.id !== "latenight" };
  }
  return {
    slots,
    autoExtract: true,
    dailyDigest: true,
    incompleteReminder: true,
    contributeToModel: false,
    contract: "GC DEC26",
  };
}
