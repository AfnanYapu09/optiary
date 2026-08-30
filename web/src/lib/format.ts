const TH_MONTHS_LONG = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

const TH_MONTHS_SHORT = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

const TH_DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

const EN_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Parses `YYYY-MM-DD` as a calendar date, free of any timezone shifting. */
export function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

export function todayIso(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${TH_MONTHS_LONG[m - 1]} ${y}`;
}

/** e.g. `ศุกร์ 28 สิงหาคม 2026` */
export function fullThaiDate(date: string): string {
  const { y, m, d } = parseDate(date);
  const dow = TH_DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${d} ${TH_MONTHS_LONG[m - 1]} ${y}`;
}

/** e.g. `28 ส.ค.` */
export function shortThaiDate(date: string): string {
  const { m, d } = parseDate(date);
  return `${d} ${TH_MONTHS_SHORT[m - 1]}`;
}

/** e.g. `28 AUG 2026` */
export function stampDate(date: string): string {
  const { y, m, d } = parseDate(date);
  return `${String(d).padStart(2, "0")} ${EN_MONTHS[m - 1]} ${y}`;
}

export function clockNow(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function signed(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const body = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (value > 0) return `+${body}`;
  if (value < 0) return `−${body}`;
  return body;
}

/** Grid of 42 cells (6 weeks), Monday-first, `null` where the month hasn't started. */
export function monthGrid(month: string): Array<string | null> {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // shift Sunday-first to Monday-first
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= length; d += 1) {
    cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function isWeekend(date: string): boolean {
  const { y, m, d } = parseDate(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

export const DOW_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
