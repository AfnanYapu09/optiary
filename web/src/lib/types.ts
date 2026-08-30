export const SLOT_IDS = ["morning", "afternoon", "evening", "night", "latenight"] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const IMAGE_KINDS = ["intraday", "oi", "oichg"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const KIND_LABELS: Record<ImageKind, string> = {
  intraday: "Intraday",
  oi: "OI",
  oichg: "OI Chg",
};

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

export function slotDef(id: SlotId): SlotDef {
  return SLOTS.find((s) => s.id === id)!;
}

export type Metrics = {
  priceClose?: number | null;
  callOi?: number | null;
  putOi?: number | null;
  oiChgTotal?: number | null;
  pcRatio?: number | null;
  summary?: string | null;
  extractedAt?: string | null;
  extractedFrom?: ImageKind[];
};

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
  imageTarget: number;
};

export type CalendarDay = {
  date: string;
  imageCount: number;
  slotCounts: number[];
  complete: boolean;
};

export type Streak = {
  current: number;
  totalImages: number;
  totalDays: number;
  completeDays: number;
};

export type UserSettings = {
  slots: Record<SlotId, { from: string; to: string; remind: string; enabled: boolean }>;
  autoExtract: boolean;
  dailyDigest: boolean;
  incompleteReminder: boolean;
  contributeToModel: boolean;
  contract: string;
};

export type User = {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  /** How this account signed in. */
  provider: "google" | "local";
  settings: UserSettings;
};

export type SeriesPoint = {
  date: string;
  slot: SlotId;
  priceClose: number | null;
  oi: number | null;
  oiChg: number | null;
  pcRatio: number | null;
};

export type Stats = {
  days: number;
  series: SeriesPoint[];
  bySlot: Array<{
    slot: SlotId;
    label: string;
    avgOiChg: number | null;
    up: number;
    down: number;
    samples: number;
  }>;
  streak: Streak;
  correlation: number | null;
  latestPcRatio: number | null;
  avgOiChg: number | null;
};

export type LibraryItem = ImageRecord & { note: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta: { savedNotes?: Array<{ date: string; slot: SlotId }> };
  createdAt: string;
};

export type CompareResult = {
  left: EntryRecord;
  right: EntryRecord;
  deltas: Record<"priceClose" | "callOi" | "putOi" | "oiChgTotal" | "pcRatio", number | null>;
};

/** Which sign-in routes and AI features the server can actually complete. */
export type AuthConfig = {
  /** Any Google sign-in route is available. */
  google: boolean;
  /** Server-side OAuth code flow is configured. */
  googleOauth: boolean;
  /** Browser-side Firebase popup sign-in is configured. */
  firebase: boolean;
  devLogin: boolean;
  /** AI features can actually reach a provider. */
  ai: boolean;
  /** Which provider and model are serving them, or null when unavailable. */
  aiModel: { provider: "gemini" | "anthropic"; model: string } | null;
};
