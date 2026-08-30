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

/** `YYYY-MM-DD`, rejecting anything that could escape a path or a query. */
export function isDateString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

export type Metrics = {
  priceClose?: number | null;
  callOi?: number | null;
  putOi?: number | null;
  oiChgTotal?: number | null;
  pcRatio?: number | null;
  /** Free-form observations the model pulled off the chart. */
  summary?: string | null;
  extractedAt?: string | null;
  extractedFrom?: ImageKind[];
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
